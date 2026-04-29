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
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
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
#[napi]
pub fn win32_set_window_bounds(
    hwnd: BigInt,
    x: i32,
    y: i32,
    cx: i32,
    cy: i32,
) -> napi::Result<bool> {
    napi_safe_call("win32_set_window_bounds", || {
        let result = unsafe {
            SetWindowPos(
                hwnd_from_bigint(hwnd),
                None, // SWP_NOZORDER => hwndInsertAfter ignored
                x, y, cx, cy,
                SWP_NOZORDER,
            )
        };
        Ok(result.is_ok())
    })
}
