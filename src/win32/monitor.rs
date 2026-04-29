//! Monitor enumeration (ADR-007 P2).
//!
//! Replaces the koffi-based `enumMonitors` flow that registered a JS
//! callback into `EnumDisplayMonitors` and called `GetMonitorInfoW` +
//! `GetDpiForMonitor` from JS per monitor. The Rust callback runs entirely
//! in-process and is panic-isolated against the Windows ABI boundary.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};

// Win32 stable value (winuser.h). windows-rs 0.62 does not re-export it as a
// named constant; we hard-code rather than introduce a feature dependency.
const MONITORINFOF_PRIMARY: u32 = 0x0000_0001;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use super::safety::{napi_safe_call, PANIC_COUNTER};
use super::types::NativeMonitorInfo;

fn build_monitor_info(hmon: HMONITOR) -> Option<NativeMonitorInfo> {
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT::default(),
        rcWork: RECT::default(),
        dwFlags: 0,
    };
    let ok = unsafe { GetMonitorInfoW(hmon, &mut mi) };
    if !ok.as_bool() {
        return None;
    }
    let mut dpi_x: u32 = 96;
    let mut dpi_y: u32 = 96;
    let _ = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    if dpi_x == 0 {
        dpi_x = 96;
    }
    Some(NativeMonitorInfo {
        handle: BigInt::from(hmon.0 as usize as u64),
        primary: (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
        bounds_left: mi.rcMonitor.left,
        bounds_top: mi.rcMonitor.top,
        bounds_right: mi.rcMonitor.right,
        bounds_bottom: mi.rcMonitor.bottom,
        work_left: mi.rcWork.left,
        work_top: mi.rcWork.top,
        work_right: mi.rcWork.right,
        work_bottom: mi.rcWork.bottom,
        dpi: dpi_x,
    })
}

/// Append one monitor to the `Vec<NativeMonitorInfo>` whose pointer is
/// passed via `lparam`. Wrapped in `catch_unwind` so a Rust panic never
/// unwinds across the Windows ABI boundary (UB) — matches the
/// `enum_windows_collect` pattern in `window.rs`.
unsafe extern "system" fn enum_monitor_collect(
    hmon: HMONITOR,
    _hdc: HDC,
    _lprc: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let result = catch_unwind(AssertUnwindSafe(|| {
        // Safety: lparam is a valid `*mut Vec<NativeMonitorInfo>` for the
        // lifetime of the `EnumDisplayMonitors` call below.
        let vec = unsafe { &mut *(lparam.0 as *mut Vec<NativeMonitorInfo>) };
        if let Some(info) = build_monitor_info(hmon) {
            vec.push(info);
        }
    }));
    if result.is_err() {
        PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
        BOOL(0) // stop enumeration
    } else {
        BOOL(1) // continue
    }
}

/// Enumerate every connected monitor. Returns one `NativeMonitorInfo` per
/// monitor (geometry + DPI). The TS wrapper rebuilds the `MonitorInfo`
/// shape (`bounds`/`workArea` nested objects + `id` index + `scale`
/// percentage) that callers expect.
#[napi]
pub fn win32_enum_monitors() -> napi::Result<Vec<NativeMonitorInfo>> {
    napi_safe_call("win32_enum_monitors", || {
        let mut monitors: Vec<NativeMonitorInfo> = Vec::with_capacity(4);
        let lparam = LPARAM(&mut monitors as *mut Vec<NativeMonitorInfo> as isize);
        let ok = unsafe {
            EnumDisplayMonitors(None, None, Some(enum_monitor_collect), lparam)
        };
        if !ok.as_bool() {
            return Err(napi::Error::from_reason(
                "EnumDisplayMonitors returned FALSE",
            ));
        }
        Ok(monitors)
    })
}

