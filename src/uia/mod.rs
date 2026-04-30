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
pub(crate) mod scroll;
pub(crate) mod text;
pub(crate) mod thread;
pub(crate) mod tree;
pub(crate) mod types;
pub(crate) mod vdesktop;

use windows::Win32::UI::Accessibility::*;

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
