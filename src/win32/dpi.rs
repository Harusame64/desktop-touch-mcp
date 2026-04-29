//! DPI helpers (ADR-007 P2).
//!
//! `win32_set_process_dpi_awareness` is called once at process startup; the
//! TS module init used to wrap `SetProcessDpiAwareness(2)` in try/catch and
//! swallow every error. Win32 returns `E_ACCESSDENIED` when the awareness
//! has already been set by another API (very common when the app is
//! launched under tooling that pre-sets it), and the legacy code treated
//! that as success — we preserve that semantics by returning `Ok(true)`
//! for both `S_OK` and `E_ACCESSDENIED`.
//!
//! `win32_get_window_dpi` folds `MonitorFromWindow` + `GetDpiForMonitor`
//! into a single sync call because they're always paired in the existing
//! TS code (`getWindowDpi`).

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::{E_ACCESSDENIED, HWND};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwareness, MDT_EFFECTIVE_DPI, PROCESS_DPI_AWARENESS,
};

use super::safety::napi_safe_call;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Effective DPI of the monitor containing `hwnd`. Returns 96 (= 100%
/// baseline) on any failure to match the legacy `getWindowDpi` behavior.
#[napi]
pub fn win32_get_window_dpi(hwnd: BigInt) -> napi::Result<u32> {
    napi_safe_call("win32_get_window_dpi", || {
        let h = hwnd_from_bigint(hwnd);
        // MonitorFromWindow always returns a valid HMONITOR for any non-null
        // window (including DEFAULTTONEAREST fallback). For null/dead hwnd
        // it returns NULL; treat as 96.
        let hmon = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
        if hmon.0.is_null() {
            return Ok(96);
        }
        let mut dpi_x: u32 = 0;
        let mut dpi_y: u32 = 0;
        let result = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
        if result.is_err() || dpi_x == 0 {
            return Ok(96);
        }
        Ok(dpi_x)
    })
}

/// `SetProcessDpiAwareness(level)`. `level=2` is `PROCESS_PER_MONITOR_DPI_AWARE`.
/// `E_ACCESSDENIED` ("already set by another API") is treated as success
/// — matches the legacy try/catch-swallow behavior.
#[napi]
pub fn win32_set_process_dpi_awareness(level: i32) -> napi::Result<bool> {
    napi_safe_call("win32_set_process_dpi_awareness", || {
        let result = unsafe { SetProcessDpiAwareness(PROCESS_DPI_AWARENESS(level)) };
        match result {
            Ok(()) => Ok(true),
            Err(e) if e.code() == E_ACCESSDENIED => Ok(true),
            Err(_) => Ok(false),
        }
    })
}
