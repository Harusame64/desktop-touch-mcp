//! Input + focus helpers (ADR-007 P3).
//!
//! `force_set_foreground_window` and `get_focused_child_hwnd` both pair
//! `AttachThreadInput(true)` / `AttachThreadInput(false)` calls; an
//! `AttachGuard` RAII wrapper guarantees the detach happens even when the
//! Win32 sub-calls fail or panic. `attached: false` paths Drop into a no-op
//! (Opus pre-impl review §13.1).

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetFocus, MapVirtualKeyW, MAP_VIRTUAL_KEY_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, PostMessageW,
    SetForegroundWindow,
};

use super::safety::napi_safe_call;
use super::types::NativeForceFocusResult;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

fn hwnd_to_bigint(h: HWND) -> BigInt {
    BigInt::from(h.0 as usize as u64)
}

// ── AttachThreadInput RAII ───────────────────────────────────────────────────

/// Detaches the input queues on Drop iff `attached == true`. The detach
/// itself is best-effort (Win32 returns false when the threads already
/// detached), matching the legacy try/catch behavior.
struct AttachGuard {
    my_thread: u32,
    target_thread: u32,
    attached: bool,
}
impl Drop for AttachGuard {
    fn drop(&mut self) {
        if self.attached {
            unsafe {
                let _ = AttachThreadInput(self.my_thread, self.target_thread, false);
            }
        }
    }
}

// ── win32_force_set_foreground_window ────────────────────────────────────────

#[napi]
pub fn win32_force_set_foreground_window(
    hwnd: BigInt,
) -> napi::Result<NativeForceFocusResult> {
    napi_safe_call("win32_force_set_foreground_window", || {
        let target = hwnd_from_bigint(hwnd);

        let fg_before = unsafe { GetForegroundWindow() };
        // Already in the foreground? Skip the attach dance.
        if fg_before.0 == target.0 {
            return Ok(NativeForceFocusResult {
                ok: true,
                attached: false,
                fg_before: hwnd_to_bigint(fg_before),
                fg_after: hwnd_to_bigint(fg_before),
            });
        }

        let fg_thread =
            unsafe { GetWindowThreadProcessId(fg_before, None) };
        let my_thread = unsafe { GetCurrentThreadId() };

        // attempt to attach only when threads differ; same-thread paths
        // skip AttachThreadInput entirely (it's a no-op-with-error there).
        let mut guard = AttachGuard {
            my_thread,
            target_thread: fg_thread,
            attached: false,
        };
        if fg_thread != 0 && fg_thread != my_thread {
            guard.attached =
                unsafe { AttachThreadInput(my_thread, fg_thread, true) }.as_bool();
        }

        // Always issue both — BringWindowToTop is a secondary hint that
        // helps even when AttachThreadInput failed.
        unsafe {
            let _ = SetForegroundWindow(target);
            let _ = BringWindowToTop(target);
        }
        // guard drops here, detaching if attached.
        drop(guard);

        let fg_after = unsafe { GetForegroundWindow() };
        Ok(NativeForceFocusResult {
            ok: fg_after.0 == target.0,
            attached: fg_thread != 0 && fg_thread != my_thread, // matches legacy reporting
            fg_before: hwnd_to_bigint(fg_before),
            fg_after: hwnd_to_bigint(fg_after),
        })
    })
}

// ── win32_get_focused_child_hwnd ─────────────────────────────────────────────

#[napi]
pub fn win32_get_focused_child_hwnd(
    target_hwnd: BigInt,
) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_focused_child_hwnd", || {
        let target = hwnd_from_bigint(target_hwnd);
        let target_thread = unsafe { GetWindowThreadProcessId(target, None) };
        if target_thread == 0 {
            return Ok(None);
        }
        let my_thread = unsafe { GetCurrentThreadId() };
        if target_thread == my_thread {
            let f = unsafe { GetFocus() };
            return Ok(if f.0.is_null() {
                None
            } else {
                Some(hwnd_to_bigint(f))
            });
        }
        let mut guard = AttachGuard {
            my_thread,
            target_thread,
            attached: false,
        };
        guard.attached =
            unsafe { AttachThreadInput(my_thread, target_thread, true) }.as_bool();
        if !guard.attached {
            return Ok(None);
        }
        let focused = unsafe { GetFocus() };
        // guard's Drop will detach.
        Ok(if focused.0.is_null() {
            None
        } else {
            Some(hwnd_to_bigint(focused))
        })
    })
}

// ── primitives ──────────────────────────────────────────────────────────────

#[napi]
pub fn win32_post_message(
    hwnd: BigInt,
    msg: u32,
    w_param: BigInt,
    l_param: BigInt,
) -> napi::Result<bool> {
    napi_safe_call("win32_post_message", || {
        let h = hwnd_from_bigint(hwnd);
        let (_w_sign, w_val, _w_lossless) = w_param.get_u64();
        let (_l_sign, l_val, _l_lossless) = l_param.get_u64();
        let result = unsafe {
            PostMessageW(
                Some(h),
                msg,
                WPARAM(w_val as usize),
                LPARAM(l_val as isize),
            )
        };
        Ok(result.is_ok())
    })
}

/// Foreground-thread `GetFocus()`. Returns `None` when no window has the
/// focus on the calling thread; cross-thread queries should use
/// `win32_get_focused_child_hwnd` instead.
#[napi]
pub fn win32_get_focus() -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_focus", || {
        let f = unsafe { GetFocus() };
        Ok(if f.0.is_null() {
            None
        } else {
            Some(hwnd_to_bigint(f))
        })
    })
}

/// `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC=0)` — translate a virtual-key code
/// to its scan code. Returns 0 for unrecognised codes (legacy contract).
#[napi]
pub fn win32_vk_to_scan_code(vk: u32) -> napi::Result<u32> {
    napi_safe_call("win32_vk_to_scan_code", || {
        // MAPVK_VK_TO_VSC = 0
        Ok(unsafe { MapVirtualKeyW(vk, MAP_VIRTUAL_KEY_TYPE(0)) })
    })
}
