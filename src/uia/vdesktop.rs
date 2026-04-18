//! Virtual desktop detection via `IVirtualDesktopManager`.
//!
//! Mirrors `getVirtualDesktopStatus` from `uia-bridge.ts`.

use std::collections::HashMap;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

use super::thread;

const DEFAULT_TIMEOUT_MS: u32 = 5_000;

/// Query which HWNDs are on the current virtual desktop.
///
/// Returns `hwnd_string → on_current_desktop`. On any COM failure, falls back
/// to `true` for every HWND (matching the TS graceful-degradation behaviour).
pub fn get_virtual_desktop_status(
    hwnd_integers: Vec<String>,
) -> napi::Result<HashMap<String, bool>> {
    if hwnd_integers.is_empty() {
        return Ok(HashMap::new());
    }

    thread::execute_with_timeout(
        move |_ctx| get_vdesktop_impl(&hwnd_integers),
        DEFAULT_TIMEOUT_MS,
    )
}

fn get_vdesktop_impl(hwnd_integers: &[String]) -> napi::Result<HashMap<String, bool>> {
    // CoCreateInstance runs on the UIA COM thread (already CoInitialized MTA).
    let vdm: IVirtualDesktopManager = unsafe {
        match CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER) {
            Ok(v) => v,
            Err(_) => {
                // VDM not available — assume all windows are on the current desktop.
                return Ok(hwnd_integers.iter().map(|h| (h.clone(), true)).collect());
            }
        }
    };

    let mut result = HashMap::with_capacity(hwnd_integers.len());

    for h in hwnd_integers {
        let on_current = match h.parse::<isize>() {
            Ok(val) => {
                let hwnd = HWND(val as *mut _);
                unsafe {
                    vdm.IsWindowOnCurrentVirtualDesktop(hwnd)
                        .map(|b| b == true)
                        .unwrap_or(true) // fallback: assume on current desktop
                }
            }
            Err(_) => true, // invalid HWND string — assume on current desktop
        };
        result.insert(h.clone(), on_current);
    }

    Ok(result)
}
