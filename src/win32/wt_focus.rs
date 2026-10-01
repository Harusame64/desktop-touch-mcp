//! internal #230 — put Windows Terminal's keyboard focus on its terminal pane before the paste.
//!
//! The paste and Enter go to whatever control has keyboard focus inside WT. With its find box open
//! the text lands there, and with focus left on a tab item (a UIA `Select()` of the tab already
//! selected) Ctrl+V — a WT-wide binding — reaches the terminal but Enter does not, so the line sits
//! at the prompt and runs with the next Enter; the flash reported success both times (win2,
//! 2026-10-01, i230 spike). A UIA `SetFocus` on the `TermControl` moved focus there in about 100 ms
//! and the line ran (F9b). Done while WT is already in front — `SetFocus` activates the window, which
//! is harmless only there.
//!
//! Which control has focus can be read only while WT is in front (from behind, no element reports
//! keyboard focus once the window has been in front), so this runs inside the flash, after the
//! window is activated and before Ctrl+V.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{TreeScope_Descendants, UIA_ClassNamePropertyId};
use windows::core::BSTR;

use crate::uia::thread::{self, UiaContext};

const TERMINAL_PANE_CLASS_NAME: &str = "TermControl";
const POLL_INTERVAL_MS: u64 = 10;
const UIA_THREAD_BUFFER_MS: u32 = 200;

/// Focus the one terminal pane of `target_hwnd_raw` and wait until UIA reports it as the focused
/// element, up to `timeout_ms`. `false` when there is not exactly one pane, the UIA thread is
/// unavailable, or focus did not arrive: the caller must not paste then.
pub fn focus_terminal_pane(target_hwnd_raw: isize, timeout_ms: u32) -> bool {
    thread::execute_with_timeout(
        move |ctx: &UiaContext| -> napi::Result<bool> { Ok(focus_inner(ctx, target_hwnd_raw, timeout_ms)) },
        timeout_ms + UIA_THREAD_BUFFER_MS,
    )
    .unwrap_or(false)
}

fn focus_inner(ctx: &UiaContext, target_hwnd_raw: isize, timeout_ms: u32) -> bool {
    let target = HWND(target_hwnd_raw as *mut std::ffi::c_void);
    unsafe {
        let Ok(root) = ctx.automation.ElementFromHandle(target) else { return false };
        let variant: VARIANT = BSTR::from(TERMINAL_PANE_CLASS_NAME).into();
        let Ok(condition) = ctx.automation.CreatePropertyCondition(UIA_ClassNamePropertyId, &variant) else {
            return false;
        };
        let Ok(panes) = root.FindAll(TreeScope_Descendants, &condition) else { return false };
        // Exactly one: a split tab is refused before asking, and which of two panes takes the
        // paste is not this function's to choose.
        if panes.Length().unwrap_or(0) != 1 {
            return false;
        }
        let Ok(pane) = panes.GetElement(0) else { return false };
        if pane.SetFocus().is_err() {
            return false;
        }
        // SetFocus returning is not focus arriving: wait for UIA to report this pane focused.
        let start = Instant::now();
        loop {
            if let Ok(focused) = ctx.automation.GetFocusedElement() {
                if ctx.automation.CompareElements(&focused, &pane).map(|b| b.as_bool()).unwrap_or(false) {
                    return true;
                }
            }
            if start.elapsed() >= Duration::from_millis(timeout_ms as u64) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    }
}
