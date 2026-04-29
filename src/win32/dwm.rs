//! Owner-chain / ancestor / enabled / DWM-cloaked utility primitives
//! (ADR-007 P4 — final koffi removal).
//!
//! These were the last five koffi.func bindings in src/engine/win32.ts;
//! migrating them retires `user32` and `dwmapi` koffi loads, the `koffi`
//! npm package itself, and unlocks ADR-007 §6 P4's
//! `git grep "koffi\\." == 0` acceptance criterion.
//!
//! All five exports are plain primitives — they hold no Win32 handles, do
//! no orchestration, and complete in a single FFI hop. The hybrid + RAII
//! patterns from P3 (`AttachGuard` / `ProcessHandleGuard` /
//! `SnapshotHandleGuard`) intentionally do not apply here.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetLastActivePopup, GetWindow, GET_ANCESTOR_FLAGS, GET_WINDOW_CMD,
};

use super::safety::napi_safe_call;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

fn hwnd_to_bigint(h: HWND) -> BigInt {
    BigInt::from(h.0 as usize as u64)
}

/// `GetWindow(hwnd, uCmd)` — owner / next / previous / first child / etc.
/// Win32 returns `Result<HWND>`; both `Err` and a NULL `Ok` are normalised
/// to `None` so the TS wrapper never has to re-check (Opus pre-impl review
/// §11.4 #1).
#[napi]
pub fn win32_get_window(hwnd: BigInt, u_cmd: u32) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_window", || {
        let h = hwnd_from_bigint(hwnd);
        let result = unsafe { GetWindow(h, GET_WINDOW_CMD(u_cmd)) };
        Ok(match result {
            Ok(other) if !other.0.is_null() => Some(hwnd_to_bigint(other)),
            _ => None,
        })
    })
}

/// `GetAncestor(hwnd, gaFlags)` — root / parent / root-owner traversal.
/// Win32 returns the HWND directly (no `Result`); a NULL return signals
/// failure and is normalised to `None`.
#[napi]
pub fn win32_get_ancestor(hwnd: BigInt, ga_flags: u32) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_ancestor", || {
        let h = hwnd_from_bigint(hwnd);
        let ancestor = unsafe { GetAncestor(h, GET_ANCESTOR_FLAGS(ga_flags)) };
        Ok(if ancestor.0.is_null() {
            None
        } else {
            Some(hwnd_to_bigint(ancestor))
        })
    })
}

/// `IsWindowEnabled(hwnd)` — false when the window cannot accept input
/// (typically because a modal dialog is blocking it).
#[napi]
pub fn win32_is_window_enabled(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_enabled", || {
        Ok(unsafe { IsWindowEnabled(hwnd_from_bigint(hwnd)) }.as_bool())
    })
}

/// `GetLastActivePopup(hwnd)` — returns the last popup owned by `hwnd`.
/// Win32 returns `hwnd` itself when no owned popup exists; we normalise
/// both that case and the NULL fallback to `None` (Opus pre-impl review
/// §11.4 #1) so the TS wrapper does not have to re-check the legacy
/// `result === hwnd → null` translation.
#[napi]
pub fn win32_get_last_active_popup(hwnd: BigInt) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_last_active_popup", || {
        let h = hwnd_from_bigint(hwnd);
        let popup = unsafe { GetLastActivePopup(h) };
        Ok(if popup.0.is_null() || popup.0 == h.0 {
            None
        } else {
            Some(hwnd_to_bigint(popup))
        })
    })
}

/// Specialized `DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ...)`. Returns
/// true when the window is cloaked by DWM (e.g. UWP background windows on
/// another virtual desktop pass `IsWindowVisible` but are not actually
/// drawn). Returns false on any failure including DWM-disabled OS — this
/// matches the legacy `try { DwmGetWindowAttribute } catch { isCloaked = false }`
/// fallback contract in `src/engine/win32.ts`.
#[napi]
pub fn win32_is_window_cloaked(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_cloaked", || {
        let h = hwnd_from_bigint(hwnd);
        let mut value: u32 = 0;
        let result = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED,
                &mut value as *mut u32 as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        Ok(result.is_ok() && value != 0)
    })
}
