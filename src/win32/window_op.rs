//! Window-state operations (ADR-007 P3): ShowWindow, SetForegroundWindow, and
//! the two specialized SetWindowPos variants (`set_window_topmost` /
//! `clear_window_topmost`) plus `set_window_bounds`.
//!
//! Specialized API design (Opus pre-impl review §12.1): SetWindowPos is
//! split into `Set*` / `Clear*` / `Bounds` variants because the legacy
//! koffi binding accepted `intptr hwndInsertAfter` and silently ate the
//! HWND_TOPMOST = -1 / HWND_NOTOPMOST = -2 sentinels. Hiding those values
//! inside the Rust binding eliminates a sign-bug class entirely.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SetForegroundWindow, SetWindowPos, ShowWindow, SET_WINDOW_POS_FLAGS, SHOW_WINDOW_CMD,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
};

use super::safety::napi_safe_call;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Sentinel HWND values for `SetWindowPos`'s `hwndInsertAfter`. Defined
/// inline because windows-rs 0.62 does not export them as named constants
/// in `Win32_UI_WindowsAndMessaging`.
fn hwnd_topmost() -> HWND {
    HWND(-1isize as *mut std::ffi::c_void)
}
fn hwnd_notopmost() -> HWND {
    HWND(-2isize as *mut std::ffi::c_void)
}

/// `ShowWindow(hwnd, n_cmd_show)`. Returns the previous visibility state
/// (true if the window was previously visible, matching Win32 contract).
#[napi]
pub fn win32_show_window(hwnd: BigInt, n_cmd_show: i32) -> napi::Result<bool> {
    napi_safe_call("win32_show_window", || {
        Ok(unsafe { ShowWindow(hwnd_from_bigint(hwnd), SHOW_WINDOW_CMD(n_cmd_show)) }.as_bool())
    })
}

/// `SetForegroundWindow(hwnd)`. Returns false when Windows refuses the
/// foreground change (foreground-stealing protection); callers should fall
/// back to `win32_force_set_foreground_window` when they need to bypass it.
#[napi]
pub fn win32_set_foreground_window(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_set_foreground_window", || {
        Ok(unsafe { SetForegroundWindow(hwnd_from_bigint(hwnd)) }.as_bool())
    })
}

/// Mark a window as always-on-top (`HWND_TOPMOST`).
#[napi]
pub fn win32_set_window_topmost(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_set_window_topmost", || {
        let result = unsafe {
            SetWindowPos(
                hwnd_from_bigint(hwnd),
                Some(hwnd_topmost()),
                0, 0, 0, 0,
                SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0),
            )
        };
        Ok(result.is_ok())
    })
}

/// Remove always-on-top from a window (`HWND_NOTOPMOST`).
#[napi]
pub fn win32_clear_window_topmost(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_clear_window_topmost", || {
        let result = unsafe {
            SetWindowPos(
                hwnd_from_bigint(hwnd),
                Some(hwnd_notopmost()),
                0, 0, 0, 0,
                SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0),
            )
        };
        Ok(result.is_ok())
    })
}

/// Move and resize a window without changing Z-order (`SWP_NOZORDER`).
///
/// `no_activate` is an OPTIONAL trailing argument and defaults to the previous
/// behaviour when omitted (`None`) or false: flags stay exactly `SWP_NOZORDER`,
/// so every pre-existing caller is bit-for-bit unchanged.
///
/// Pass `true` to add `SWP_NOACTIVATE`. Without that flag SetWindowPos may
/// activate the window it moves — Windows only leaves the foreground alone when
/// the caller says so — which is wrong for any caller that repositions a window
/// it does not want to bring forward (e.g. relocating a test window off the
/// user's screen must not steal the focus that user is typing into).
///
/// Measured on Windows 11 (PR #558): moving a background window with
/// `SWP_NOZORDER` alone did NOT change the foreground, with or without this
/// flag — activation appears tied to the Z-order move that `SWP_NOZORDER`
/// suppresses. So this is a contract guarantee, not a fix for an observed
/// focus steal; do not weaken it on the strength of that measurement, which
/// covers one OS build.
#[napi]
pub fn win32_set_window_bounds(
    hwnd: BigInt,
    x: i32,
    y: i32,
    cx: i32,
    cy: i32,
    no_activate: Option<bool>,
) -> napi::Result<bool> {
    napi_safe_call("win32_set_window_bounds", || {
        let mut flags = SWP_NOZORDER.0;
        if no_activate == Some(true) {
            flags |= SWP_NOACTIVATE.0;
        }
        let result = unsafe {
            SetWindowPos(
                hwnd_from_bigint(hwnd),
                None, // SWP_NOZORDER => hwndInsertAfter ignored
                x, y, cx, cy,
                SET_WINDOW_POS_FLAGS(flags),
            )
        };
        Ok(result.is_ok())
    })
}
