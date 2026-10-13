//! internal #216 — move the keyboard focus to the element ourselves, before a pattern method acts.
//!
//! The client is created with `AutoSetFocus` off (`thread.rs`), so `Invoke` and `SetValue` no longer
//! move the focus. That is what stops the fall onto GameInputSvc's window, and it is also what an
//! application reads to commit a value: with nothing moving the focus, "write a field, press Save"
//! saved the OLD value (win2, VF V1: WinForms binding OnValidation 3/3, WPF binding LostFocus 3/3).
//! So the focus is moved here, by a road that does not raise the fall.
//!
//! MEASURED win2 2026-10-03 (internal `dev/v210-dogfood`, `dev/gis216-spike/fable-c2/RESULTS-R17*.md`,
//! a plain UIA client with `AutoSetFocus` off, 111 cells), the roads below and what they did:
//! - **The element has a window of its own** (WinForms TextBox, NumericUpDown's inner edit,
//!   ComboBox, CheckBox, ListBox, Button; a Win32 dialog's Edit): `AttachThreadInput` to its thread,
//!   then Win32 `SetFocus` on that window. Closing afterwards fell 0/18 (the default client: 18/18);
//!   with the window behind, the foreground stayed on the user's window at every step (60/60) and the
//!   keys the user's window was receiving all arrived (200/200 in 15/15 cells); the value reached the
//!   application's model when the focus left the field (the step that focuses the button).
//! - **A list item, inside a list that has a window of its own**: the same, on the list's window;
//!   then the item is invoked. 0/3 falls (the default client 3/3).
//! - **WPF and Chromium** (no window of their own): UI Automation's own `SetFocus`. No fall and the
//!   value committed, but with the window behind it takes the foreground, and most keys typed
//!   meanwhile go to that window (153–183 of 200) — as the default client does there.
//! - **Except Chromium behind another window** (`"kept_behind"`): its focus is not moved. MEASURED win2
//!   2026-10-03 (`RESULTS-R22b.md`, plain UIA, a key-counting window in front receiving 200 keys):
//!   moving it took the foreground 3/3 and the front window received 23–26 keys; not moving it kept
//!   the foreground 3/3, all 200 arrived, and the page still committed (its `input` and `change`
//!   fire on the write itself, model new 3/3). WPF lost its commit the same way (a LostFocus binding
//!   saved the old value 3/3), so WPF is taken another way, below. The user's decision (2026-10-03).
//! - **WPF behind another window** (`"legacy_takefocus"`): `LegacyIAccessible.Select(SELFLAG_TAKEFOCUS)`
//!   instead of UI Automation's `SetFocus`. MEASURED win2 2026-10-03 (`RESULTS-R23b.md`, plain UIA,
//!   the same key-counting window in front): taking the focus this way into the field, writing, then
//!   taking it into Save and pressing kept the foreground, all 200 keys arrived and the LostFocus
//!   binding saved the new value, 3/3; UI Automation's `SetFocus` took the foreground (33–35 keys)
//!   and, there, still saved the old one. Taking it into Save alone did not commit — the field never
//!   had the focus — which is why the write takes it into the field first. In front, WPF keeps UI
//!   Automation's `SetFocus` (measured, R17a-2); this road was measured behind only. When the
//!   pattern is missing or refuses, a WPF element behind is left where it is (`"kept_behind"`).
//! - **Anything else is left where it is** (`"skipped"`): a Win32 or WinForms element with no window
//!   of its own (a toolbar or ToolStrip button, a tree item, a tab, a grid cell, a menu item), and
//!   every framework not measured. UI Automation's `SetFocus` is the very call that raised the fall
//!   (`thread.rs`: `SetFocus` alone, 3/3), and on those elements it would aim at the container's
//!   window, a child — the shape that falls. Leaving it is what the client did with `AutoSetFocus`
//!   off and nothing else (no fall); a value a field holds is then committed only if the press itself
//!   commits it, as for a person clicking a ToolStrip button (gate 2 on `0eccd63c`).
//! - A window that is a top-level or a popup (a dialog's own root, a combo box's drop-down list) is
//!   not given Win32 `SetFocus`, which would activate it — R17 measured child controls only.
//!
//! What this does not cover (same rounds): a Win32 menu item with a submenu still falls (menu mode,
//! not focus); and a ListBox item written with `Select` or a ComboBox written with `SetValue` never
//! reaches a WinForms bound model whichever way the focus moves (internal #238).

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    GA_ROOT, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, IsHungAppWindow,
    SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_NULL,
};

use super::thread::UiaContext;

/// How long the window's thread is given to answer before the focus is left where it is.
///
/// MEASURED win2 (R17c): Win32 `SetFocus` on a window whose thread was in `Sleep` did not return
/// until the sleep ended (2,446 and 2,462 ms after the call), with no limit of its own. The pattern
/// call that follows would wait on the same thread anyway, under the action's own timeout; this only
/// keeps the focus step from adding a second unbounded wait in front of it.
const ANSWER_MS: u32 = 300;

/// Which road moved the focus, as `ActionResult::focused_by` reports it.
pub(crate) const BY_WIN32: &str = "win32";
pub(crate) const BY_LIST_WINDOW: &str = "win32_list";
pub(crate) const BY_UIA: &str = "uia";
pub(crate) const ALREADY: &str = "already";
pub(crate) const NOT_ANSWERING: &str = "not_answering";
pub(crate) const SKIPPED: &str = "skipped";
pub(crate) const KEPT_BEHIND: &str = "kept_behind";
pub(crate) const BY_LEGACY_TAKEFOCUS: &str = "legacy_takefocus";
pub(crate) const BY_CLASSIC: &str = "classic";
/// The focus was not moved for an element that says read-only: its write was refused, or the write
/// took too long to move it after (`actions.rs`).
pub(crate) const NOT_MOVED_READ_ONLY: &str = "not_moved_read_only";
pub(crate) const ATTACH_FAILED: &str = "attach_failed";
pub(crate) const FAILED: &str = "failed";

/// The frameworks whose windowless elements R17 measured with UI Automation's own `SetFocus`
/// (`UIA_FrameworkIdPropertyId`: WPF's controls, Chromium's page in Chrome and Edge).
const UIA_FOCUS_MEASURED: [&str; 2] = ["WPF", "Chrome"];

/// Move the keyboard focus to `elem` (or to the list that holds it), and say how.
///
/// Never fails the action: a focus that could not be moved leaves the press or the write to run as
/// it would have, and the answer says which.
pub(crate) fn move_focus_first(ctx: &UiaContext, elem: &IUIAutomationElement) -> &'static str {
    // The classic client moves the focus itself, as 2.0 did (`thread.rs::execute_classic_with_timeout`).
    if ctx.classic {
        return BY_CLASSIC;
    }
    unsafe {
        if elem.CurrentHasKeyboardFocus().map(|b| b == true).unwrap_or(false) {
            return ALREADY;
        }
        if let Some(own) = own_window(elem).filter(|h| is_child(*h)) {
            return win32_focus(own, BY_WIN32);
        }
        if let Some(list) = list_window_of_item(ctx, elem).filter(|h| is_child(*h)) {
            return win32_focus(list, BY_LIST_WINDOW);
        }
        let framework = elem.CurrentFrameworkId().map(|b| b.to_string()).unwrap_or_default();
        if !UIA_FOCUS_MEASURED.contains(&framework.as_str()) {
            return SKIPPED;
        }
        // A window that cannot be shown to be in front counts as behind: on Chromium the cost of not
        // moving is nothing measured, the cost of moving is the user's foreground and keys.
        if framework == "Chrome" && !window_is_in_front(ctx, elem) {
            return KEPT_BEHIND;
        }
        if framework == "WPF" && !window_is_in_front(ctx, elem) {
            return legacy_take_focus(elem);
        }
        match elem.SetFocus() {
            Ok(()) => BY_UIA,
            Err(_) => FAILED,
        }
    }
}

/// `LegacyIAccessible.Select(SELFLAG_TAKEFOCUS)`: the provider moves its own focus, and the foreground
/// is not asked for (R23b). Without the pattern, or when it refuses, nothing is moved.
unsafe fn legacy_take_focus(elem: &IUIAutomationElement) -> &'static str {
    unsafe {
        match elem.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            Ok(legacy) if legacy.Select(SELFLAG_TAKEFOCUS as i32).is_ok() => BY_LEGACY_TAKEFOCUS,
            _ => KEPT_BEHIND,
        }
    }
}

/// Whether the top-level window `elem` is drawn in is the foreground window: the nearest window found
/// walking up from the element (Chromium's page sits in a child window of its own), then its root.
unsafe fn window_is_in_front(ctx: &UiaContext, elem: &IUIAutomationElement) -> bool {
    unsafe {
        let mut current = Some(elem.clone());
        for _ in 0..WINDOW_SEARCH_DEPTH {
            let Some(e) = current else { return false };
            if let Some(h) = own_window(&e) {
                return GetAncestor(h, GA_ROOT).0 == GetForegroundWindow().0;
            }
            current = ctx.walker.GetParentElement(&e).ok();
        }
        false
    }
}

/// How far up `window_is_in_front` looks for a window. A page's elements can sit deep in its tree.
const WINDOW_SEARCH_DEPTH: usize = 64;

/// The element's own window, when it has one. Zero is "none": UIA answers it for an element drawn
/// inside another window.
unsafe fn own_window(elem: &IUIAutomationElement) -> Option<HWND> {
    let h = unsafe { elem.CurrentNativeWindowHandle() }.ok()?;
    (!h.0.is_null()).then_some(HWND(h.0))
}

/// A window inside another — not a top-level and not a popup, whose `GA_ROOT` is itself.
unsafe fn is_child(hwnd: HWND) -> bool {
    unsafe { GetAncestor(hwnd, GA_ROOT) }.0 != hwnd.0
}

/// A list item's list, when the list has a window of its own — the shape R17c measured (a WinForms
/// ListBox). Only ListItem: other items inside a windowed container (tree, grid) were not measured,
/// and they take UI Automation's own `SetFocus`.
pub(crate) unsafe fn list_window_of_item(ctx: &UiaContext, elem: &IUIAutomationElement) -> Option<HWND> {
    let is_item = unsafe { elem.CurrentControlType() }
        .map(|t| t.0 == UIA_ListItemControlTypeId.0)
        .unwrap_or(false);
    if !is_item {
        return None;
    }
    let parent = unsafe { ctx.walker.GetParentElement(elem) }.ok()?;
    let is_list = unsafe { parent.CurrentControlType() }
        .map(|t| t.0 == UIA_ListControlTypeId.0)
        .unwrap_or(false);
    if !is_list {
        return None;
    }
    unsafe { own_window(&parent) }
}

/// `AttachThreadInput` to the window's thread, Win32 `SetFocus`, detach — after the thread has
/// answered once. Not `SetForegroundWindow`: the foreground is not asked for, and a window behind
/// stays behind (R17b).
unsafe fn win32_focus(hwnd: HWND, by: &'static str) -> &'static str {
    unsafe {
        if !answers(hwnd) {
            return NOT_ANSWERING;
        }
        let theirs = GetWindowThreadProcessId(hwnd, None);
        let mine = GetCurrentThreadId();
        if theirs == 0 {
            return FAILED;
        }
        let attached = theirs == mine || AttachThreadInput(mine, theirs, true).as_bool();
        if !attached {
            return ATTACH_FAILED;
        }
        // Judged by where the focus is afterwards, read while the queues are still shared — not by
        // `SetFocus`'s return. That returns the window that HAD the focus, and windows-rs turns a
        // null into `Err`: a window behind usually had none, so a move that worked read as failed
        // (gate 2 on `0eccd63c`).
        let _ = SetFocus(Some(hwnd));
        let focused = GetFocus().0 == hwnd.0;
        if theirs != mine {
            let _ = AttachThreadInput(mine, theirs, false);
        }
        if focused { by } else { FAILED }
    }
}

/// Whether the window's thread processes a message within `ANSWER_MS`. The same question as
/// `win32_window_answers` (`win32/dwm.rs`), except that a failed send counts as "no" here whether
/// or not the OS calls the window hung yet: the cost of a wrong "no" is a focus not moved, the cost
/// of a wrong "yes" is a wait with no limit.
unsafe fn answers(hwnd: HWND) -> bool {
    let mut result: usize = 0;
    let r = unsafe {
        SendMessageTimeoutW(hwnd, WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, ANSWER_MS, Some(&mut result))
    };
    r.0 != 0 && !unsafe { IsHungAppWindow(hwnd) }.as_bool()
}
