//! IME (Input Method Editor) state query and control (issue #245 系統②).
//!
//! Wraps `ImmGetDefaultIMEWnd` (Imm32.dll) and the legacy IME control message
//! (`WM_IME_CONTROL` with `IMC_GETOPENSTATUS` / `IMC_SETOPENSTATUS`). The
//! "default IME window" is per-thread: for a foreground HWND owned by another
//! thread we still query *its* default IME window because the IME's
//! composition state is bound to the *target* window's input context, not to
//! ours. ImmGetDefaultIMEWnd returns NULL when the target thread has no IME
//! (e.g. an ASCII-only keyboard layout). We treat that as "IME off" rather
//! than an error so callers get a clean boolean signal.
//!
//! Used by:
//!   - `desktop_state` → `hints.imeOpen` (read-only, every call cheap)
//!   - `keyboard(action='type', forceImeOff:true)` → temporarily flip OFF
//!     before injection, restore afterwards.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
use windows::Win32::UI::WindowsAndMessaging::{SMTO_ABORTIFHUNG, SendMessageTimeoutW, SendMessageW};

use super::safety::napi_safe_call;

// Constants are not re-exported by windows-rs under the `Win32_UI_Input_Ime`
// feature in 0.62 (they live in the C headers as `#define` macros); define
// the message + sub-commands here. See MSDN: WM_IME_CONTROL.
const WM_IME_CONTROL: u32 = 0x0283;
const IMC_GETOPENSTATUS: usize = 0x0005;

/// How long the read waits for the target thread. It runs on Node's main thread, and since internal
/// #225 before every clipboard paste: a plain `SendMessageW` to a thread that has stopped pumping
/// blocked the whole server (gate 2 on #760). A hung window answers at once under `SMTO_ABORTIFHUNG`.
const IME_READ_TIMEOUT_MS: u32 = 200;
const IMC_SETOPENSTATUS: usize = 0x0006;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Query whether the target window's IME is currently open (composition ON).
///
/// Returns `false` when the window has no associated IME (NULL default-IME
/// window — typically an ASCII layout or a non-IME thread), and when its thread
/// does not answer within `IME_READ_TIMEOUT_MS` or is hung.
#[napi]
pub fn win32_get_ime_open_status(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_get_ime_open_status", || {
        let target = hwnd_from_bigint(hwnd);
        let ime_wnd = unsafe { ImmGetDefaultIMEWnd(target) };
        if ime_wnd.0.is_null() {
            return Ok(false);
        }
        let mut result: usize = 0;
        let answered = unsafe {
            SendMessageTimeoutW(
                ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETOPENSTATUS),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                IME_READ_TIMEOUT_MS,
                Some(&mut result),
            )
        };
        Ok(answered.0 != 0 && result != 0)
    })
}

/// Set the target window's IME open status (composition ON/OFF).
///
/// Returns `true` when the message was dispatched (i.e. the window has an
/// associated default-IME window). Returns `false` (no-op) when the target
/// has no IME, mirroring the read path's treatment of that case as "off".
#[napi]
pub fn win32_set_ime_open_status(hwnd: BigInt, open: bool) -> napi::Result<bool> {
    napi_safe_call("win32_set_ime_open_status", || {
        let target = hwnd_from_bigint(hwnd);
        let ime_wnd = unsafe { ImmGetDefaultIMEWnd(target) };
        if ime_wnd.0.is_null() {
            return Ok(false);
        }
        let lparam_val: isize = if open { 1 } else { 0 };
        unsafe {
            SendMessageW(
                ime_wnd,
                WM_IME_CONTROL,
                Some(WPARAM(IMC_SETOPENSTATUS)),
                Some(LPARAM(lparam_val)),
            );
        }
        Ok(true)
    })
}
