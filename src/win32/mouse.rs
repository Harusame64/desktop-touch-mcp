//! Multi-monitor cursor movement (ADR-029 Phase 2a).
//!
//! The nut.js / libnut prebuilt normalises absolute mouse coordinates against
//! `SM_CXSCREEN` / `SM_CYSCREEN` — the **primary monitor** — and sends
//! `MOUSEEVENTF_ABSOLUTE` without `MOUSEEVENTF_VIRTUALDESK`, so any point on
//! another monitor is silently pulled into the primary one. A click aimed at a
//! second monitor therefore lands on whatever sits at the pulled-in position
//! and still reports success. This module is the replacement path.
//!
//! **`SetCursorPos` first, `SendInput` as correction.** A click is delivered by
//! hit-testing wherever the cursor currently is, so the only thing that matters
//! is landing on the exact pixel: `SetCursorPos` takes physical coordinates
//! directly and needs no normalisation, while the `SendInput` absolute form
//! quantises to a 0..65535 grid and can round by a pixel at monitor edges. The
//! `SendInput` path is kept as the correction step because it reaches cases
//! `SetCursorPos` alone does not (and it is what libnut used, so no input
//! semantics are lost).
//!
//! **Every move is verified.** `GetCursorPos` reads the position back; a
//! mismatch is reported (`ok: false`) rather than swallowed. That is what turns
//! "the cursor could not be placed" — another app holding the cursor with
//! `ClipCursor`, a non-interactive session, a monitor unplugged mid-move — from
//! a silent wrong click into a typed error on the TS side.

use napi_derive::napi;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::safety::napi_safe_call;
use super::types::{NativeCursorMoveResult, NativeCursorPoint};

/// How far the read-back position may sit from the requested one and still
/// count as landed.
///
/// A successful `SetCursorPos` is expected to be exact, so this is not a
/// correctness knob — it absorbs the one-pixel rounding the `SendInput`
/// correction path can introduce through its 0..65535 quantisation (and the
/// same rounding on mixed-DPI desktops). Widening it would start hiding real
/// placement failures, which is the opposite of why the verification exists.
const READBACK_TOLERANCE_PX: i32 = 1;

/// Map a physical virtual-screen coordinate onto the 0..65535 grid
/// `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` expects.
///
/// `origin` / `extent` are `SM_XVIRTUALSCREEN` / `SM_CXVIRTUALSCREEN` (or the
/// Y pair). Kept as a free function with no Win32 calls so the arithmetic —
/// including the negative-origin case that ADR-029 exists for — is unit
/// testable without a desktop.
fn to_absolute_virtual(v: i32, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        // A degenerate virtual screen (single column/row, or metrics that came
        // back as 0) has no grid to map onto; anything maps to the origin.
        return 0;
    }
    let offset = i64::from(v) - i64::from(origin);
    let span = i64::from(extent) - 1;
    // Round to nearest rather than truncating: the half-pixel bias of a
    // truncating divide is visible at monitor edges.
    let scaled = (offset * 65535 + span / 2) / span;
    scaled.clamp(0, 65535) as i32
}

/// `SM_XVIRTUALSCREEN` / `SM_YVIRTUALSCREEN` / `SM_CXVIRTUALSCREEN` /
/// `SM_CYVIRTUALSCREEN`, read fresh on every call — a monitor can be plugged,
/// unplugged or rearranged between two moves, and a cached origin would send
/// the cursor to the wrong place afterwards.
fn virtual_screen_metrics() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn read_cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    let ok = unsafe { GetCursorPos(&mut p) };
    ok.is_ok().then_some((p.x, p.y))
}

fn landed(actual: (i32, i32), target_x: i32, target_y: i32) -> bool {
    (actual.0 - target_x).abs() <= READBACK_TOLERANCE_PX
        && (actual.1 - target_y).abs() <= READBACK_TOLERANCE_PX
}

/// Absolute move through `SendInput` with `MOUSEEVENTF_VIRTUALDESK` — the flag
/// libnut omits, and the reason a second monitor is reachable at all here.
/// Returns false when the injection itself was refused (Win11 input
/// restrictions surface this way, same as `foreground_flash::send_keys`).
fn send_input_absolute(x: i32, y: i32) -> bool {
    let (vx, vy, vcx, vcy) = virtual_screen_metrics();
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: to_absolute_virtual(x, vx, vcx),
                dy: to_absolute_virtual(y, vy, vcy),
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    sent as usize == 1
}

/// Place the cursor and confirm it arrived: `SetCursorPos` → read back → on a
/// miss, `SendInput` correction → read back again.
///
/// An unreadable position is a FAILURE, never a pass. `GetCursorPos` fails
/// precisely when the calling thread has no input desktop — a disconnected or
/// locked session, one of the cases this error exists to report — so assuming
/// the cursor reached the target there would recreate the silent wrong click
/// the whole ADR is about.
fn place_and_verify(x: i32, y: i32) -> NativeCursorMoveResult {
    let _ = unsafe { SetCursorPos(x, y) };
    if let Some(pos) = read_cursor_pos() {
        if landed(pos, x, y) {
            return NativeCursorMoveResult {
                ok: true,
                method: "set_cursor_pos".to_string(),
                final_x: pos.0,
                final_y: pos.1,
            };
        }
    }

    let injected = send_input_absolute(x, y);
    match read_cursor_pos() {
        Some(pos) if landed(pos, x, y) => NativeCursorMoveResult {
            ok: true,
            method: "send_input".to_string(),
            final_x: pos.0,
            final_y: pos.1,
        },
        Some(pos) => NativeCursorMoveResult {
            ok: false,
            // Distinguish "the injection itself was refused" (Win11 input
            // restrictions, same shape as `foreground_flash::send_keys`) from
            // "it was accepted and the cursor still is not there" (something is
            // holding it) — the caller cannot tell them apart from the position.
            method: if injected { "failed" } else { "send_input_refused" }.to_string(),
            final_x: pos.0,
            final_y: pos.1,
        },
        None => NativeCursorMoveResult {
            ok: false,
            method: "readback_failed".to_string(),
            // No position to report: the desktop could not be read at all.
            final_x: x,
            final_y: y,
        },
    }
}

/// Move the cursor to a physical virtual-screen coordinate and verify it
/// landed. Negative coordinates are normal — they address a monitor placed
/// left of or above the primary one.
///
/// Never throws for a move that did not land; see `NativeCursorMoveResult`.
#[napi]
pub fn win32_move_cursor_absolute(x: i32, y: i32) -> napi::Result<NativeCursorMoveResult> {
    napi_safe_call("win32_move_cursor_absolute", || Ok(place_and_verify(x, y)))
}

/// Walk the cursor through `points` in one call, verifying only the last one.
///
/// This exists for animated movement. The interpolation itself lives in TS
/// (`src/engine/cursor.ts`) so the sleeps between ticks do not block the libuv
/// thread, but issuing one napi call per interpolated pixel would mean
/// thousands of round-trips — each with its own read-back — to cross a screen.
/// One call per tick carries that tick's points instead, and only the final
/// position is verified: an intermediate pixel that the OS nudges is not worth
/// a correction round-trip, whereas the destination is exactly what the caller
/// is about to click on.
///
/// `verify_last: false` is for a segment that is not the end of the gesture.
#[napi]
pub fn win32_move_cursor_path(
    points: Vec<NativeCursorPoint>,
    verify_last: bool,
) -> napi::Result<NativeCursorMoveResult> {
    napi_safe_call("win32_move_cursor_path", || {
        let Some((last, lead)) = points.split_last() else {
            return Err(napi::Error::from_reason(
                "win32_move_cursor_path: points must not be empty",
            ));
        };
        for p in lead {
            let _ = unsafe { SetCursorPos(p.x, p.y) };
        }
        if verify_last {
            return Ok(place_and_verify(last.x, last.y));
        }
        let _ = unsafe { SetCursorPos(last.x, last.y) };
        // Unverified by request (this segment is not the end of the gesture), so
        // `ok` says nothing about where the cursor is — hence `method` reports
        // whether the position could even be read, rather than implying a check
        // that did not happen.
        match read_cursor_pos() {
            Some(pos) => Ok(NativeCursorMoveResult {
                ok: true,
                method: "set_cursor_pos".to_string(),
                final_x: pos.0,
                final_y: pos.1,
            }),
            None => Ok(NativeCursorMoveResult {
                ok: true,
                method: "readback_failed".to_string(),
                final_x: last.x,
                final_y: last.y,
            }),
        }
    })
}

/// Current cursor position in physical virtual-screen coordinates.
///
/// The TS interpolator needs a start point, and reading it through libnut
/// would reintroduce the dependency this phase is removing — libnut's
/// behaviour at negative coordinates is exactly what is in question.
#[napi]
pub fn win32_get_cursor_pos() -> napi::Result<NativeCursorPoint> {
    napi_safe_call("win32_get_cursor_pos", || {
        let (x, y) = read_cursor_pos()
            .ok_or_else(|| napi::Error::from_reason("GetCursorPos failed"))?;
        Ok(NativeCursorPoint { x, y })
    })
}

#[cfg(test)]
mod tests {
    use super::to_absolute_virtual;

    // A monitor to the LEFT of the primary one: the virtual screen starts at a
    // negative x, which is the configuration ADR-029 was opened for.
    const LEFT_ORIGIN: i32 = -1920;
    const DUAL_EXTENT: i32 = 3840;

    #[test]
    fn maps_the_negative_edge_to_zero_and_the_far_edge_to_full_scale() {
        assert_eq!(to_absolute_virtual(LEFT_ORIGIN, LEFT_ORIGIN, DUAL_EXTENT), 0);
        assert_eq!(
            to_absolute_virtual(LEFT_ORIGIN + DUAL_EXTENT - 1, LEFT_ORIGIN, DUAL_EXTENT),
            65535
        );
    }

    #[test]
    fn maps_the_primary_origin_of_a_left_extended_desktop_just_past_half_scale() {
        // x = 0 is the primary monitor's left edge. It is NOT the exact centre
        // of the grid: the virtual screen spans -1920..1919, so the mapped
        // range is 3839 wide and its centre falls at x = -0.5. x = 0 therefore
        // sits one pixel to the right of centre:
        //   (0 - (-1920)) * 65535 / 3839 = 32776
        assert_eq!(to_absolute_virtual(0, LEFT_ORIGIN, DUAL_EXTENT), 32776);
    }

    #[test]
    fn single_monitor_maps_both_ends() {
        assert_eq!(to_absolute_virtual(0, 0, 1920), 0);
        assert_eq!(to_absolute_virtual(1919, 0, 1920), 65535);
    }

    #[test]
    fn rounds_to_nearest_rather_than_truncating() {
        // Half a grid step below an exact multiple must round up, not down.
        let extent = 3; // span = 2 → grid steps of 32767.5
        assert_eq!(to_absolute_virtual(1, 0, extent), 32768);
    }

    #[test]
    fn clamps_a_point_outside_the_virtual_screen() {
        assert_eq!(to_absolute_virtual(-5000, LEFT_ORIGIN, DUAL_EXTENT), 0);
        assert_eq!(to_absolute_virtual(9000, LEFT_ORIGIN, DUAL_EXTENT), 65535);
    }

    #[test]
    fn degenerate_extent_does_not_divide_by_zero() {
        assert_eq!(to_absolute_virtual(10, 0, 1), 0);
        assert_eq!(to_absolute_virtual(10, 0, 0), 0);
    }
}
