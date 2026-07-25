//! Multi-monitor cursor movement (ADR-029 Phase 2a).
//!
//! The nut.js / libnut prebuilt normalises absolute mouse coordinates against
//! `SM_CXSCREEN` / `SM_CYSCREEN` — the **primary monitor** — and sends
//! `MOUSEEVENTF_ABSOLUTE` without `MOUSEEVENTF_VIRTUALDESK`, so any point on
//! another monitor is silently pulled into the primary one. A click aimed at a
//! second monitor therefore lands on whatever sits at the pulled-in position
//! and still reports success. This module is the replacement path.
//!
//! **`SetCursorPos`, and nothing else.** It takes a physical virtual-desktop
//! coordinate directly — negatives included — so there is no normalisation to
//! get wrong, which is the whole of libnut's bug. An earlier revision added a
//! `SendInput(MOUSEEVENTF_VIRTUALDESK)` correction behind it; that was removed
//! after checking the documentation, because it cannot help:
//!
//! - `SetCursorPos` clamps into the `ClipCursor` rectangle when one is set, and
//!   injected mouse input is subject to the same clip when the Raw Input Thread
//!   processes it — `SendInput` cannot escape a confinement either.
//! - Both require the calling thread's desktop to be the input desktop, and
//!   `SendInput` is additionally documented as subject to UIPI, which
//!   `SetCursorPos` is not. It is the *more* restricted call, not a fallback.
//! - `SendInput` only queues the packet; the position updates when the Raw
//!   Input Thread gets to it, so reading it back immediately is a race. A
//!   verification step built on it verifies nothing.
//!
//! `SetCursorPos` still produces `WM_MOUSEMOVE`, so drag thresholds and
//! `dragover` behave normally. Two limits are worth stating plainly, because
//! neither is specific to this module but both apply to it:
//!
//! - Windows does not queue mouse moves. The message is generated from the
//!   current cursor position when the application pumps its loop, so an
//!   application observes the pointer at its own polling rate — intermediate
//!   positions are never guaranteed to be seen, whoever sends them.
//! - Raw input (`WM_INPUT`) and low-level mouse hooks (`WH_MOUSE_LL`) are fed
//!   by the input stream that `SendInput` writes to; `SetCursorPos` sets the
//!   position instead, so anything watching through those does not see this
//!   motion at all. Raw-input consumers are mainly full-screen games, which
//!   confine the cursor anyway — and a confined cursor is reported here as a
//!   placement failure rather than a wrong click. (This server's own failsafe
//!   polls `GetCursorPos` rather than hooking, so it is unaffected.)
//! - `SetCursorPos` does not reset the user-input idle timer the way
//!   `SendInput` does, so a long run of moves with no clicks or typing will not
//!   by itself hold off a screensaver or a lock. Clicks and keystrokes still go
//!   through `SendInput`, so any real interaction does. If the session does
//!   lock, `SetCursorPos` starts failing and the caller gets a typed error
//!   rather than a wrong click.
//!
//! **Every move is verified.** `GetCursorPos` reads the position back and it
//! must match exactly; near-enough is not enough, because one pixel can be a
//! different control. A mismatch is reported (`ok: false`) rather than
//! swallowed, which is what turns "the cursor could not be placed" — another
//! app holding it with `ClipCursor`, a non-interactive session, a monitor
//! unplugged mid-move — from a silent wrong click into a typed error.

use napi_derive::napi;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

use super::safety::napi_safe_call;
use super::types::{NativeCursorMoveResult, NativeCursorPoint};

fn read_cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    let ok = unsafe { GetCursorPos(&mut p) };
    ok.is_ok().then_some((p.x, p.y))
}

/// Place the cursor and confirm it arrived.
///
/// A miss is retried once: `SetCursorPos` is synchronous, so a position that
/// still disagrees a moment later means something moved the cursor back rather
/// than that the call had not taken effect yet, and one retry separates a
/// transient collision from an application actively holding the pointer.
///
/// An unreadable position is a FAILURE, never a pass. `GetCursorPos` fails
/// precisely when the calling thread has no input desktop — a disconnected or
/// locked session, one of the cases this error exists to report — so assuming
/// the cursor reached the target there would recreate the silent wrong click
/// the whole ADR is about.
fn place_and_verify(x: i32, y: i32) -> NativeCursorMoveResult {
    let first = unsafe { SetCursorPos(x, y) };
    match read_cursor_pos() {
        Some(pos) if pos == (x, y) => {
            return NativeCursorMoveResult {
                ok: true,
                method: "set_cursor_pos".to_string(),
                final_x: pos.0,
                final_y: pos.1,
            };
        }
        None => {
            return NativeCursorMoveResult {
                ok: false,
                method: "readback_failed".to_string(),
                // No position to report: the desktop could not be read at all.
                // Callers must not present these as where the cursor is.
                final_x: x,
                final_y: y,
            };
        }
        Some(_) => {}
    }

    let retried = unsafe { SetCursorPos(x, y) };
    match read_cursor_pos() {
        Some(pos) if pos == (x, y) => NativeCursorMoveResult {
            ok: true,
            method: "set_cursor_pos_retry".to_string(),
            final_x: pos.0,
            final_y: pos.1,
        },
        Some(pos) => NativeCursorMoveResult {
            ok: false,
            // A refused call and an accepted-but-overridden one need different
            // words: the first means the session or the window station said no,
            // the second that something is actively holding the pointer.
            method: if first.is_err() || retried.is_err() {
                "set_cursor_pos_refused"
            } else {
                "failed"
            }
            .to_string(),
            final_x: pos.0,
            final_y: pos.1,
        },
        None => NativeCursorMoveResult {
            ok: false,
            method: "readback_failed".to_string(),
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
