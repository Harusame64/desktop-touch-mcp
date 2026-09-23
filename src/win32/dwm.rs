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
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetLastActivePopup, GetWindow, IsHungAppWindow, IsWindow, SendMessageTimeoutW,
    GET_ANCESTOR_FLAGS, GET_WINDOW_CMD, SMTO_ABORTIFHUNG, WM_NULL,
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

/// Internal #144 — does the window's thread answer a message within `timeout_ms`?
///
/// `SendMessageTimeoutW(WM_NULL, SMTO_ABORTIFHUNG)`:
/// - `Some(true)` — the thread processed it;
/// - `Some(false)` — **only** when the send failed **and** the OS itself counts the window as hung
///   (`IsHungAppWindow`, about 5 s without pumping messages). A thread that is merely slow — still
///   serving a long UIA walk — is not "does not answer" (gate 2 on public #724);
/// - `None` — could not be asked, or the answer is not that: no such window, the window went away
///   between the check and the send, or a failed send on a window the OS does not count as hung.
///   `None` is never read as hung.
///
/// **`GetLastError` is NOT consulted**, and must not be: measured by win2 (internal `5445a40`), once
/// the OS counts a window as hung, `SMTO_ABORTIFHUNG` returns at once with last error **0**, not
/// `ERROR_TIMEOUT` (1460 appears only while the window is not yet counted as hung). The first
/// version required `ERROR_TIMEOUT && IsHungAppWindow`, a conjunction that is never true, and the
/// hung target fell back exactly as before (4 of 4). A slow-but-live window stayed
/// `IsHungAppWindow == false` throughout (12 samples), so the OS's own verdict is the whole ground.
///
/// Measured by win2 (internal `f3e6585` / `225b842`): when a native UIA read times out (8 s), the
/// send fails for a hung target and succeeds for a healthy target slowed by ANOTHER hung window,
/// 16 of 16; `IsHungAppWindow` is true for the hung target by then (false at issue time).
#[napi]
pub fn win32_window_answers(hwnd: BigInt, timeout_ms: u32) -> napi::Result<Option<bool>> {
    napi_safe_call("win32_window_answers", || {
        let h = hwnd_from_bigint(hwnd);
        if !unsafe { IsWindow(Some(h)) }.as_bool() {
            return Ok(None);
        }
        let mut result: usize = 0;
        let r = unsafe {
            SendMessageTimeoutW(
                h,
                WM_NULL,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                timeout_ms,
                Some(&mut result),
            )
        };
        if r.0 != 0 {
            return Ok(Some(true));
        }
        if unsafe { IsHungAppWindow(h) }.as_bool() {
            return Ok(Some(false));
        }
        Ok(None)
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
