//! Rust-native UIA (UI Automation) engine.
//!
//! This module replaces the PowerShell-based `uia-bridge.ts` with direct
//! COM calls through `windows-rs`, eliminating process-spawn overhead.
//!
//! ## Architecture
//! * A dedicated COM thread (`thread.rs`) owns `IUIAutomation` and processes
//!   tasks sent via `crossbeam-channel`.
//! * napi-rs `AsyncTask` bridges libuv ↔ COM thread.
//! * All JS-facing structs live in `types.rs` with `#[napi(object)]`.

pub(crate) mod actions;
pub(crate) mod event_handlers;
pub(crate) mod focus;
pub(crate) mod focus_first;
pub(crate) mod scroll;
pub(crate) mod tabs;
pub(crate) mod text;
pub(crate) mod thread;
pub(crate) mod tree;
pub(crate) mod types;
pub(crate) mod vdesktop;

use windows::Win32::UI::Accessibility::*;

/// internal #216 — what every road answers when UI Automation gave up waiting for the window's
/// provider (`UIA_E_TIMEOUT`), in words this crate owns so the TS side matches them whole
/// (`uia-route-failure.ts`). MEASURED win2 2026-10-03 (R18b, R21b): on the act client, a window
/// whose UI thread is stuck longer than its `ConnectionTimeout` failed there, and the answer reached
/// the caller as "the focus is on a different control" (the value road fell to the keyboard rung)
/// — a wrong reason. A handle road must not call it a window that went away either.
pub(crate) const NOT_ANSWERING: &str = "Window is not answering";

/// The same timeout on the press or the write itself, after the element was found (gate 2 on
/// `fb2db897`): the request may already be with the window, and run when it answers, so the caller
/// must not be told nothing was done.
pub(crate) const STOPPED_ANSWERING: &str = "Window stopped answering during the act";

/// internal #232 — any other failure of the press call itself, after the element was found and the
/// focus moved to it. The call was made, so the press may have happened (a dialog that closed itself
/// during the call, an RPC disconnect); the caller must not be told nothing was done, and the act must
/// not press again by coordinates. The backend's own text goes to stderr only: it is matched by no one.
pub(crate) const PRESS_OUTCOME_UNKNOWN: &str = "The press call failed after it was made; it may have taken effect";

/// Whether a UI Automation call failed because the provider did not answer in time.
pub(crate) fn is_timeout(e: &windows::core::Error) -> bool {
    e.code().0 as u32 == UIA_E_TIMEOUT
}

/// internal #216 — the control type this engine reports for an element: the type UI Automation
/// answers, except that a `Document` that is a window of its own and takes a value is reported as
/// `Edit`.
///
/// The engine's clients are `CUIAutomation8` so that `AutoSetFocus` can be off (`thread.rs`), and that
/// class reads some Win32 text controls differently from the older `CUIAutomation`. MEASURED win2 2026-10-03 (internal
/// `dev/v210-dogfood`, `RESULTS-R18b.md`, plain UIA with both classes side by side): Notepad's text
/// area and a WinForms RichTextBox are `Edit` to the old class and `Document` to the new one — each a
/// window of its own, with `ValuePattern` and `IsReadOnly` false. Everything in the server that tells a
/// text field from a page reads `Edit` (discover's role and actions, the keyboard rung, the click
/// road's type filter), so Notepad stopped being offered `type`. The Store Notepad's text area
/// (`RichEditD2DPT`) is `Document` to both classes and was offered no `type` by 2.0.0 either (win2
/// R23c); it is a window of its own that takes a value, so it is reported as `Edit` too. Unchanged between the
/// classes and kept as `Document`: a WinForms multi-line TextBox (`Edit` both), Chrome's page
/// (`Document` both, no window of its own, a read-only value) and Word's `_WwG` (`Document` both, a
/// window of its own but no `ValuePattern`).
///
/// "Takes a value" is a `ValuePattern` that is not read-only (gate 2 on `fb2db897`): a read-only
/// windowed document — a page in a hosted browser control, a log view — is not a field to type in.
pub(crate) fn reported_control_type(
    id: UIA_CONTROLTYPE_ID,
    own_window: bool,
    takes_value: bool,
) -> UIA_CONTROLTYPE_ID {
    if id == UIA_DocumentControlTypeId && own_window && takes_value {
        UIA_EditControlTypeId
    } else {
        id
    }
}

/// [`reported_control_type`] from the element's cache: the type, the handle and the value pattern
/// are all in both cache requests (`thread.rs::configure_cache_properties`).
pub(crate) unsafe fn cached_control_type(
    elem: &IUIAutomationElement,
) -> windows::core::Result<UIA_CONTROLTYPE_ID> {
    unsafe {
        let id = elem.CachedControlType()?;
        if id != UIA_DocumentControlTypeId {
            return Ok(id);
        }
        let own = elem.CachedNativeWindowHandle().is_ok_and(|h| !h.0.is_null());
        let value = elem
            .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_ok_and(|p| p.CachedIsReadOnly().is_ok_and(|r| r == false));
        Ok(reported_control_type(id, own, value))
    }
}

/// [`reported_control_type`] read live, for the roads that hold an element with no cache.
pub(crate) unsafe fn current_control_type(
    elem: &IUIAutomationElement,
) -> windows::core::Result<UIA_CONTROLTYPE_ID> {
    unsafe {
        let id = elem.CurrentControlType()?;
        if id != UIA_DocumentControlTypeId {
            return Ok(id);
        }
        let own = elem.CurrentNativeWindowHandle().is_ok_and(|h| !h.0.is_null());
        let value = elem
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_ok_and(|p| p.CurrentIsReadOnly().is_ok_and(|r| r == false));
        Ok(reported_control_type(id, own, value))
    }
}

/// Map `UIA_*_CONTROL_TYPE_ID` to the human-readable name
/// (matching PowerShell/TS conventions).
#[allow(non_upper_case_globals)]
pub(crate) fn control_type_name(id: UIA_CONTROLTYPE_ID) -> &'static str {
    match id {
        UIA_ButtonControlTypeId => "Button",
        UIA_CalendarControlTypeId => "Calendar",
        UIA_CheckBoxControlTypeId => "CheckBox",
        UIA_ComboBoxControlTypeId => "ComboBox",
        UIA_EditControlTypeId => "Edit",
        UIA_HyperlinkControlTypeId => "Hyperlink",
        UIA_ImageControlTypeId => "Image",
        UIA_ListItemControlTypeId => "ListItem",
        UIA_ListControlTypeId => "List",
        UIA_MenuControlTypeId => "Menu",
        UIA_MenuBarControlTypeId => "MenuBar",
        UIA_MenuItemControlTypeId => "MenuItem",
        UIA_ProgressBarControlTypeId => "ProgressBar",
        UIA_RadioButtonControlTypeId => "RadioButton",
        UIA_ScrollBarControlTypeId => "ScrollBar",
        UIA_SliderControlTypeId => "Slider",
        UIA_SpinnerControlTypeId => "Spinner",
        UIA_StatusBarControlTypeId => "StatusBar",
        UIA_TabControlTypeId => "Tab",
        UIA_TabItemControlTypeId => "TabItem",
        UIA_TextControlTypeId => "Text",
        UIA_ToolBarControlTypeId => "ToolBar",
        UIA_ToolTipControlTypeId => "ToolTip",
        UIA_TreeControlTypeId => "Tree",
        UIA_TreeItemControlTypeId => "TreeItem",
        UIA_CustomControlTypeId => "Custom",
        UIA_GroupControlTypeId => "Group",
        UIA_ThumbControlTypeId => "Thumb",
        UIA_DataGridControlTypeId => "DataGrid",
        UIA_DataItemControlTypeId => "DataItem",
        UIA_DocumentControlTypeId => "Document",
        UIA_SplitButtonControlTypeId => "SplitButton",
        UIA_WindowControlTypeId => "Window",
        UIA_PaneControlTypeId => "Pane",
        UIA_HeaderControlTypeId => "Header",
        UIA_HeaderItemControlTypeId => "HeaderItem",
        UIA_TableControlTypeId => "Table",
        UIA_TitleBarControlTypeId => "TitleBar",
        UIA_SeparatorControlTypeId => "Separator",
        UIA_SemanticZoomControlTypeId => "SemanticZoom",
        UIA_AppBarControlTypeId => "AppBar",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::reported_control_type;
    use windows::Win32::UI::Accessibility::*;

    #[test]
    fn a_windowed_document_that_takes_a_value_is_the_edit_it_was() {
        // Notepad's text area, a WinForms RichTextBox (win2, R18b).
        assert_eq!(reported_control_type(UIA_DocumentControlTypeId, true, true), UIA_EditControlTypeId);
    }

    #[test]
    fn a_page_and_words_body_stay_documents() {
        // Chrome's page: no window of its own.
        assert_eq!(reported_control_type(UIA_DocumentControlTypeId, false, true), UIA_DocumentControlTypeId);
        // Word's `_WwG`: a window of its own, no value pattern.
        assert_eq!(reported_control_type(UIA_DocumentControlTypeId, true, false), UIA_DocumentControlTypeId);
    }

    #[test]
    fn other_types_are_untouched() {
        assert_eq!(reported_control_type(UIA_EditControlTypeId, true, true), UIA_EditControlTypeId);
        assert_eq!(reported_control_type(UIA_PaneControlTypeId, true, true), UIA_PaneControlTypeId);
    }
}
