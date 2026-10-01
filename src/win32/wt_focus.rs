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
use windows::Win32::System::Variant::VariantClear;
use windows::Win32::UI::Accessibility::{
    IUIAutomationElement, TreeScope_Descendants, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_RuntimeIdPropertyId, UIA_SelectionItemIsSelectedPropertyId, UIA_TabItemControlTypeId,
};
use windows::core::BSTR;

use crate::uia::thread::{self, UiaContext};
use crate::uia::tree::runtime_id_from_variant;

const TERMINAL_PANE_CLASS_NAME: &str = "TermControl";
const POLL_INTERVAL_MS: u64 = 10;
const UIA_THREAD_BUFFER_MS: u32 = 200;

/// Why the pane was not focused; the caller must not paste in either case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusOutcome {
    Focused,
    /// The selected tab is not the one the caller names (`expected_tab`): the user switched tabs.
    TabChanged,
    /// Not exactly one pane, the UIA thread unavailable or past the deadline, or focus not arriving.
    NotFocused,
}

/// Focus the one terminal pane of `target_hwnd_raw` and wait until UIA reports it as the focused
/// element, up to `timeout_ms`. With `expected_tab`, the selected tab's RuntimeId must still be that
/// one: only the selected tab's panes are in the tree, so a tab switched after the caller's last check
/// would otherwise have its pane focused and pasted into (PR codex on #765).
pub fn focus_terminal_pane(target_hwnd_raw: isize, timeout_ms: u32, expected_tab: Option<String>) -> FocusOutcome {
    // The deadline is fixed here, not when the UIA thread picks the task up. The wait below gives up
    // after it, but the task stays queued; a busy UIA thread could run it later, after the flash has
    // put the foreground back, and SetFocus activates WT — it would take the user's next keys
    // (gate 2 on #765). So the task does nothing once its deadline has passed.
    let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
    thread::execute_with_timeout(
        move |ctx: &UiaContext| -> napi::Result<FocusOutcome> {
            Ok(focus_inner(ctx, target_hwnd_raw, deadline, expected_tab.as_deref()))
        },
        timeout_ms + UIA_THREAD_BUFFER_MS,
    )
    .unwrap_or(FocusOutcome::NotFocused)
}

/// The RuntimeId of the window's selected `TabItem`, as `uia_get_selected_tab` spells it.
unsafe fn selected_tab_runtime_id(ctx: &UiaContext, root: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let is_tab = ctx
            .automation
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0))
            .ok()?;
        let is_selected =
            ctx.automation.CreatePropertyCondition(UIA_SelectionItemIsSelectedPropertyId, &VARIANT::from(true)).ok()?;
        let condition = ctx.automation.CreateAndCondition(&is_tab, &is_selected).ok()?;
        let tab = root.FindFirst(TreeScope_Descendants, &condition).ok()?;
        let mut v = tab.GetCurrentPropertyValue(UIA_RuntimeIdPropertyId).ok()?;
        let id = runtime_id_from_variant(&v);
        let _ = VariantClear(&mut v);
        id
    }
}

fn focus_inner(ctx: &UiaContext, target_hwnd_raw: isize, deadline: Instant, expected_tab: Option<&str>) -> FocusOutcome {
    use FocusOutcome::*;
    let target = HWND(target_hwnd_raw as *mut std::ffi::c_void);
    if Instant::now() >= deadline {
        return NotFocused;
    }
    unsafe {
        let Ok(root) = ctx.automation.ElementFromHandle(target) else { return NotFocused };
        if let Some(expected) = expected_tab {
            // Unreadable counts as changed: the paste must land in the tab the user agreed to.
            if selected_tab_runtime_id(ctx, &root).as_deref() != Some(expected) {
                return TabChanged;
            }
        }
        let variant: VARIANT = BSTR::from(TERMINAL_PANE_CLASS_NAME).into();
        let Ok(condition) = ctx.automation.CreatePropertyCondition(UIA_ClassNamePropertyId, &variant) else {
            return NotFocused;
        };
        let Ok(panes) = root.FindAll(TreeScope_Descendants, &condition) else { return NotFocused };
        // Exactly one: a split tab is refused before asking, and which of two panes takes the
        // paste is not this function's to choose.
        if panes.Length().unwrap_or(0) != 1 {
            return NotFocused;
        }
        let Ok(pane) = panes.GetElement(0) else { return NotFocused };
        // Checked again right before the call with the side effect: the tree reads above take time.
        if Instant::now() >= deadline || pane.SetFocus().is_err() {
            return NotFocused;
        }
        // And once more after the focus arrives (below), right before the caller pastes.
        // SetFocus returning is not focus arriving: wait for UIA to report this pane focused.
        loop {
            if let Ok(focused) = ctx.automation.GetFocusedElement() {
                if ctx.automation.CompareElements(&focused, &pane).map(|b| b.as_bool()).unwrap_or(false) {
                    if let Some(expected) = expected_tab {
                        if selected_tab_runtime_id(ctx, &root).as_deref() != Some(expected) {
                            return TabChanged;
                        }
                    }
                    return Focused;
                }
            }
            if Instant::now() >= deadline {
                return NotFocused;
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    }
}
