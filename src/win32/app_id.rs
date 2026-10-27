//! Internal #250 — the AppUserModelID that leads from a packaged app's frame window to its content.
//!
//! A packaged app shows in an `ApplicationFrameWindow` owned by ApplicationFrameHost, which is never
//! frozen; the app's own `Windows.UI.Core.CoreWindow` is in the app's process, which is. MEASURED by
//! win2 (2026-10-27, read-only, Settings / Xbox hidden and Calculator shown): while shown the content
//! is a child of the frame, while hidden and frozen it is top-level with no parent, owner or child
//! link to it, and the one link that holds both ways is the frame's window AUMID
//! (`PKEY_AppUserModel_ID`) equal to the content process's AUMID (`GetApplicationUserModelId`). The
//! content window's own property is empty, and ApplicationFrameHost has no AUMID of its own.
//!
//! Both reads answer `None` when there is nothing to read (no property, a process that is not
//! packaged, a value that names no window, a process that cannot be opened). The caller reads `None`
//! as "cannot tell", never as "not frozen".

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::core::PWSTR;
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, PROPERTYKEY, RPC_E_CHANGED_MODE};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};

use super::handle::{hwnd_from_bigint, refused_or_null};
use super::process::ProcessHandleGuard;
use super::safety::napi_safe_call;

/// `PKEY_AppUserModel_ID` ({9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5), written out so the crate does
/// not need `Win32_Storage_EnhancedStorage` for one constant.
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

/// An AUMID is at most `APPLICATION_USER_MODEL_ID_MAX_LENGTH` (130) characters with its terminator;
/// the first try uses that and a longer answer is asked for once.
const AUMID_FIRST_BUFFER: u32 = 130;

/// COM for one call on whatever thread napi runs it on: initialised here when the thread had none
/// and left as it was found. A thread already in the other apartment (`RPC_E_CHANGED_MODE`) can still
/// make the call, so that is not a failure.
struct ComForCall(bool);
impl ComForCall {
    fn enter() -> Option<Self> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        if hr.is_ok() {
            Some(ComForCall(true))
        } else if hr == RPC_E_CHANGED_MODE {
            Some(ComForCall(false))
        } else {
            None
        }
    }
}
impl Drop for ComForCall {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// The window's AppUserModelID property (`PKEY_AppUserModel_ID`), as a packaged app's frame window
/// carries it. `None` when the window has none or the value names no window.
#[napi]
pub fn win32_get_window_app_user_model_id(hwnd: BigInt) -> napi::Result<Option<String>> {
    napi_safe_call("win32_get_window_app_user_model_id", || {
        let h = hwnd_from_bigint(hwnd);
        // NULL would ask for no window's store; the property is per window, so there is nothing to read.
        if refused_or_null(h) {
            return Ok(None);
        }
        let Some(_com) = ComForCall::enter() else {
            return Ok(None);
        };
        let store: IPropertyStore = match unsafe { SHGetPropertyStoreForWindow(h) } {
            Ok(s) => s,
            Err(_) => return Ok(None),
        };
        let mut value = match unsafe { store.GetValue(&PKEY_APP_USER_MODEL_ID) } {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        // An empty PROPVARIANT (no property) fails to convert or converts to "".
        let text = unsafe { PropVariantToStringAlloc(&value) };
        let _ = unsafe { PropVariantClear(&mut value) };
        let Ok(pwstr) = text else {
            return Ok(None);
        };
        let read = unsafe { pwstr.to_string() };
        unsafe { CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void)) };
        Ok(read.ok().filter(|s| !s.is_empty()))
    })
}

/// The process's AppUserModelID (`GetApplicationUserModelId`). `None` for a process that is not a
/// packaged app (`APPMODEL_ERROR_NO_APPLICATION`, ApplicationFrameHost among them), pid 0, or one
/// that cannot be opened.
#[napi]
pub fn win32_get_process_app_user_model_id(pid: u32) -> napi::Result<Option<String>> {
    napi_safe_call("win32_get_process_app_user_model_id", || {
        if pid == 0 {
            return Ok(None);
        }
        let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(h) if !h.is_invalid() => h,
            _ => return Ok(None),
        };
        let _handle_guard = ProcessHandleGuard(handle);
        let mut len = AUMID_FIRST_BUFFER;
        for _ in 0..2 {
            let mut buf = vec![0u16; len as usize];
            let rc = unsafe { GetApplicationUserModelId(handle, &mut len, Some(PWSTR(buf.as_mut_ptr()))) };
            if rc == ERROR_SUCCESS {
                // `len` counts the terminator.
                let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                let read = String::from_utf16_lossy(&buf[..end]);
                return Ok(Some(read).filter(|s| !s.is_empty()));
            }
            if rc != ERROR_INSUFFICIENT_BUFFER {
                return Ok(None);
            }
        }
        Ok(None)
    })
}
