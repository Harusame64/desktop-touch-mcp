//! internal #238 step 2 — write a WinForms editable combo box the way the application sees it.
//!
//! UI Automation's `SetValue` changes the combo's text without WinForms raising TextChanged, so a bound
//! model stays old (win2, FX238, 3/3; `winforms-combo.ts`). Characters typed into the combo's inner Edit
//! do raise it. MEASURED win2 2026-10-15 (internal `dev/k238s2-measure`, `r238s2.md` and `r238s2-S.md`,
//! a harness doing exactly the steps below): the Edit focused by `win32_focus`, all of its text selected
//! with `EM_SETSEL(0, -1)`, then one posted `WM_CHAR` per UTF-16 unit — the text and the model were the
//! asked text after the focus left (a product click on Save), in front 3/3 and behind 3/3, for
//! "a b 日本 😀" and over a longer old text; with the window behind, the window in front kept the
//! foreground 3/3 when it had come forward by a real click (internal #300). An AutoComplete that
//! appends turned "ap" into "apple" 3/3, so the text is read back for the caller to compare — after a
//! marker posted behind the characters says they were processed, and once it stops changing.
//!
//! No UI Automation here: every step is a window message to the Edit's thread, each bounded.

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GA_ROOT, GetAncestor, IsWindow, PostMessageW, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_CHAR, WM_GETTEXT,
    WM_GETTEXTLENGTH,
};
use windows::core::w;

use super::focus_first::{BY_WIN32, answers, win32_focus};
use super::types::ComboWriteResult;

/// `EM_SETSEL` — in windows-rs's `Win32_UI_Controls`, which this crate does not enable.
const EM_SETSEL: u32 = 0x00B1;
/// Backspace as a character: with all the text selected, it deletes it (an empty write).
const BACKSPACE: u16 = 0x08;
/// The Edit's modify flag: the marker that says the posted characters before it were processed.
const EM_GETMODIFY: u32 = 0x00B8;
const EM_SETMODIFY: u32 = 0x00B9;
/// How long one sent message may wait for the Edit's thread.
const SEND_MS: u32 = 300;
/// How long the posted characters are given to be processed. A sent message (a read) is handled before
/// posted ones, so a read alone cannot tell queued characters from processed ones (gate 1 on #824): the
/// marker posted after them can.
const PROCESSED_MS: u64 = 2_000;
/// After the marker, the text must read the same for this long: an AutoComplete may change it after the
/// characters that set it off.
const STABLE_MS: u64 = 200;
const SETTLE_MAX_MS: u64 = 1_000;
const POLL_MS: u64 = 30;

fn failed(code: &str, error: &str, focused_by: Option<&str>) -> ComboWriteResult {
    ComboWriteResult {
        ok: false,
        focused_by: focused_by.map(str::to_string),
        posted: 0,
        total: 0,
        text: None,
        error: Some(error.to_string()),
        code: Some(code.to_string()),
    }
}

/// The combo's own Edit: its child window of class `Edit` (win2 #238 M4: a WinForms editable combo's
/// inner box is class "Edit", FrameworkId "Win32"). `None` for a combo without one (a DropDownList).
/// Not `GetComboBoxInfo`, which needs a windows-rs feature this crate does not enable for one call.
unsafe fn edit_of(combo: HWND) -> Option<HWND> {
    unsafe { FindWindowExW(Some(combo), None, w!("Edit"), None) }.ok().filter(|h| !h.0.is_null())
}

unsafe fn send(hwnd: HWND, msg: u32, w: usize, l: isize) -> Option<usize> {
    let mut result: usize = 0;
    let r = unsafe { SendMessageTimeoutW(hwnd, msg, WPARAM(w), LPARAM(l), SMTO_ABORTIFHUNG, SEND_MS, Some(&mut result)) };
    (r.0 != 0).then_some(result)
}

/// The Edit's text, through its own messages, bounded.
unsafe fn text_of(edit: HWND) -> Option<String> {
    let len = unsafe { send(edit, WM_GETTEXTLENGTH, 0, 0) }?;
    let mut buf = vec![0u16; len + 1];
    let copied = unsafe { send(edit, WM_GETTEXT, buf.len(), buf.as_mut_ptr() as isize) }?;
    Some(String::from_utf16_lossy(&buf[..copied.min(len)]))
}

/// The Edit's text once the posted characters were processed and it stopped changing. `None` when the
/// marker was not reached in time, or the text kept changing: what the box will hold cannot be said.
unsafe fn settled_text(edit: HWND) -> Option<String> {
    let pause = || std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    let started = std::time::Instant::now();
    while unsafe { send(edit, EM_GETMODIFY, 0, 0) }? != 0 {
        if started.elapsed() >= std::time::Duration::from_millis(PROCESSED_MS) {
            return None;
        }
        pause();
    }
    let settling = std::time::Instant::now();
    let mut last = unsafe { text_of(edit) }?;
    let mut since = std::time::Instant::now();
    while since.elapsed() < std::time::Duration::from_millis(STABLE_MS) {
        if settling.elapsed() >= std::time::Duration::from_millis(SETTLE_MAX_MS) {
            return None;
        }
        pause();
        let now = unsafe { text_of(edit) }?;
        if now != last {
            last = now;
            since = std::time::Instant::now();
        }
    }
    Some(last)
}

/// Focus the combo's Edit, select all its text, post `value` as characters, and read the text back.
///
/// `root`, when given, is the top-level window the combo was read in: a handle recreated since then can
/// name a control in another window, so a combo whose root is not that window is not written (gate 1 on
/// #824). Not a check against a sibling in the same window taking the handle.
pub fn write_combo(combo: u64, value: &str, root: Option<u64>) -> ComboWriteResult {
    let combo = HWND(combo as isize as *mut std::ffi::c_void);
    unsafe {
        if !IsWindow(Some(combo)).as_bool() {
            return failed("Gone", "The combo box's window no longer exists", None);
        }
        // In the low 32 bits, as every handle comparison here: one side can arrive sign-extended.
        if let Some(root) = root
            && (GetAncestor(combo, GA_ROOT).0 as usize as u64) as u32 != root as u32
        {
            return failed("Gone", "The combo box's handle now belongs to another window", None);
        }
        let Some(edit) = edit_of(combo) else {
            return failed("NoEdit", "The combo box has no text box of its own", None);
        };
        if !answers(edit) {
            return failed("NotAnswering", super::NOT_ANSWERING, None);
        }
        let by = win32_focus(edit, BY_WIN32);
        // A thread that stopped answering between the two asks is still "not answering" (gate 2).
        if by == super::focus_first::NOT_ANSWERING {
            return failed("NotAnswering", super::NOT_ANSWERING, Some(by));
        }
        if by != BY_WIN32 {
            return failed("FocusFailed", "The keyboard focus could not be moved into the combo box", Some(by));
        }
        if send(edit, EM_SETSEL, 0, -1).is_none() {
            return failed("SelectFailed", "The combo box's text could not be selected", Some(by));
        }
        // The marker: set the modify flag now, and post its reset after the characters. The posted queue is
        // processed in order, so when the flag reads clear again, every character before it was processed.
        // A WinForms ComboBox does not read its Edit's modify flag. Not settable: no marker, no confirmation.
        let marked = send(edit, EM_SETMODIFY, 1, 0).is_some();
        let units: Vec<u16> = if value.is_empty() { vec![BACKSPACE] } else { value.encode_utf16().collect() };
        let total = value.encode_utf16().count() as u32;
        let mut posted = 0u32;
        for u in &units {
            if PostMessageW(Some(edit), WM_CHAR, WPARAM(*u as usize), LPARAM(0)).is_err() {
                let mut r = failed("PostFailed", "Not every character could be posted to the combo box", Some(by));
                r.posted = posted;
                r.total = total;
                r.text = text_of(edit);
                return r;
            }
            if !value.is_empty() {
                posted += 1;
            }
        }
        let text = if marked && PostMessageW(Some(edit), EM_SETMODIFY, WPARAM(0), LPARAM(0)).is_ok() {
            settled_text(edit)
        } else {
            None
        };
        ComboWriteResult { ok: true, focused_by: Some(by.to_string()), posted, total, text, error: None, code: None }
    }
}
