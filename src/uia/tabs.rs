//! internal #227 — which Windows Terminal tab is selected.
//!
//! `desktop_act` asks the user before pasting into Windows Terminal, and the paste goes to whichever
//! tab is active when it happens. All of a WT window's tabs share its process, and same-titled tabs
//! share its title, so neither tells the tab the user agreed to from one they switched to meanwhile
//! (PR codex on #764). The selected `TabItem` does: win2 measured (2026-09-30) exactly one tab with
//! `SelectionItem.IsSelected` true at every read, following `Select()` and a real Ctrl+Tab, and a
//! `RuntimeId` per tab that a closed tab's successor did not reuse. The read took 18–44 ms.

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Variant::{VARIANT, VariantClear};
use windows::Win32::UI::Accessibility::*;

use super::thread::{self, UiaContext, win_err};
use super::tree::runtime_id_from_variant;
use super::types::SelectedTab;

const TIMEOUT_MS: u32 = 2_000;

/// The selected tab of the window `hwnd` (a decimal handle), or `None` when it has no selected
/// `TabItem` (a window without tabs, or one UIA does not show them for). A read that fails is an
/// error, never `None`.
pub fn get_selected_tab(hwnd: String) -> napi::Result<Option<SelectedTab>> {
    thread::execute_with_timeout(move |ctx| selected_tab_impl(ctx, &hwnd), TIMEOUT_MS)
}

fn selected_tab_impl(ctx: &UiaContext, hwnd: &str) -> napi::Result<Option<SelectedTab>> {
    let raw: i64 = hwnd
        .parse()
        .map_err(|e| napi::Error::from_reason(format!("uia_get_selected_tab: hwnd parse error: {e}")))?;
    let root = unsafe { ctx.automation.ElementFromHandle(HWND(raw as *mut std::ffi::c_void)) }.map_err(win_err)?;
    let condition = unsafe {
        let is_tab = ctx
            .automation
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0))
            .map_err(win_err)?;
        let is_selected = ctx
            .automation
            .CreatePropertyCondition(UIA_SelectionItemIsSelectedPropertyId, &VARIANT::from(true))
            .map_err(win_err)?;
        ctx.automation.CreateAndCondition(&is_tab, &is_selected).map_err(win_err)?
    };
    // No match comes back as a null element, which windows-rs reports as an EMPTY error (code 0):
    // that is the answer "no selected tab". Any other error is a failed read, and is raised: the
    // caller holds a user's answer to this, and a failed read must not look like a window without
    // tabs, whose check would then pass (win2's Opus review on #764).
    let tab = match unsafe { root.FindFirst(TreeScope_Descendants, &condition) } {
        Ok(tab) => tab,
        Err(e) if e.code().is_ok() => return Ok(None),
        Err(e) => return Err(win_err(e)),
    };
    let name = unsafe { tab.CurrentName() }.map(|b| b.to_string()).unwrap_or_default();
    let runtime_id = unsafe {
        let mut v = tab.GetCurrentPropertyValue(UIA_RuntimeIdPropertyId).map_err(win_err)?;
        let read = runtime_id_from_variant(&v);
        let _ = VariantClear(&mut v);
        read
    };
    // A selected tab whose RuntimeId cannot be read cannot be compared: a failure, not "no tab".
    let runtime_id = runtime_id
        .ok_or_else(|| napi::Error::from_reason("uia_get_selected_tab: the selected tab's RuntimeId could not be read"))?;
    Ok(Some(SelectedTab { name, runtime_id }))
}
