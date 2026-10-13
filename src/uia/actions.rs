//! Action functions: click (InvokePattern), set value (ValuePattern),
//! insert text (TextPattern2).
//!
//! All functions return `ActionResult` — never panic or reject the Promise.
//! Disabled elements and unsupported patterns are reported via `ok: false`.

use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext};
use super::tree::{resolve_root, CACHE_BUILD_FAILED_PREFIX};
use super::types::*;

const DEFAULT_TIMEOUT_MS: u32 = 8_000;
/// Time kept free before the act's limit for a deferred focus move (`set_value_impl`).
const DEFERRED_FOCUS_ROOM_MS: u32 = 2_000;
const MAX_SEARCH_DEPTH: u32 = 14;

// ─── Options from JS ─────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ClickElementOptions {
    pub window_title: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    /// ADR-036 — act on THIS window, rather than the first one whose name contains `window_title`.
    /// A decimal handle as a string; see `GetElementsOptions::hwnd`.
    pub hwnd: Option<String>,
    /// internal #216 — act through the older client 2.0 used (`thread.rs::execute_classic_with_timeout`).
    pub classic: Option<bool>,
    /// internal #233 — select the item (`SelectionItemPattern.Select`) instead of invoking it. UI
    /// Automation's Invoke on a list item acts as a double-click (win2 2026-10-13), so a click on a
    /// collection item comes here; `action:"invoke"` keeps Invoke.
    pub select: Option<bool>,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct SetValueOptions {
    pub window_title: String,
    pub value: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    /// ADR-036 — act on THIS window, rather than the first one whose name contains `window_title`.
    /// A decimal handle as a string; see `GetElementsOptions::hwnd`.
    pub hwnd: Option<String>,
    /// internal #216 — as on `ClickElementOptions`.
    pub classic: Option<bool>,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct InsertTextOptions {
    pub window_title: String,
    pub value: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    /// ADR-036 — act on THIS window, rather than the first one whose name contains `window_title`.
    /// A decimal handle as a string; see `GetElementsOptions::hwnd`.
    pub hwnd: Option<String>,
}

// ─── Public API ──────────────────────────────────────────────────────────────

pub fn click_element(opts: ClickElementOptions) -> napi::Result<ActionResult> {
    if opts.classic == Some(true) {
        return thread::execute_classic_with_timeout(move |ctx| click_element_impl(ctx, &opts), DEFAULT_TIMEOUT_MS);
    }
    thread::execute_act_with_timeout(
        move |ctx| click_element_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn set_value(opts: SetValueOptions) -> napi::Result<ActionResult> {
    // The caller's clock: the timeout below starts when the task is queued, not when it runs.
    let submitted = std::time::Instant::now();
    if opts.classic == Some(true) {
        return thread::execute_classic_with_timeout(
            move |ctx| set_value_impl(ctx, &opts, submitted),
            DEFAULT_TIMEOUT_MS,
        );
    }
    thread::execute_act_with_timeout(
        move |ctx| set_value_impl(ctx, &opts, submitted),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn insert_text(opts: InsertTextOptions) -> napi::Result<ActionResult> {
    thread::execute_with_timeout(
        move |ctx| insert_text_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

// ─── Implementation ──────────────────────────────────────────────────────────

/// ADR-036 — a handle that no longer names a usable window is not "the route failed".
///
/// `resolve_root` fails on the handle road when the number does not parse, is not a window, or
/// `ElementFromHandle` refuses it — all of which mean the window the caller named is gone. The
/// PowerShell by-handle scripts have always said so with `code: "aim_window_gone"`, and the
/// executor weighs that code to refuse without pressing the remembered rect. The native road
/// answered with a sentence and no code, so once the engine started taking handles, a pinned act
/// on a closed window came back as `aim_route_failed` and lost that advice (gate 2 on this branch).
/// The title road keeps `None`: a title that matches nothing is not a window that went away.
///
/// And a failure raised after the window WAS found keeps `None` too: `BuildUpdatedCache` can fault
/// on a live window (a provider hiccup, an RPC fault), and calling that "gone" would send the caller
/// to re-discover a window that is still there (PR 側 codex, P2 on #631). `tree.rs` marks that case,
/// because only this crate produces and reads the mark.
fn root_failure_code(hwnd: Option<&str>, reason: &str) -> Option<String> {
    // internal #216 — nor is a window that did not answer in time (`mod.rs::NOT_ANSWERING`).
    if hwnd.is_none() || reason.starts_with(CACHE_BUILD_FAILED_PREFIX) || reason == super::NOT_ANSWERING {
        return None;
    }
    Some("aim_window_gone".to_string())
}

fn click_element_impl(ctx: &UiaContext, opts: &ClickElementOptions) -> napi::Result<ActionResult> {
    let window = match resolve_root(ctx, opts.hwnd.as_deref(), &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            // The code is read from the reason before `error` takes ownership of it.
            let code = root_failure_code(opts.hwnd.as_deref(), &e.reason);
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code,
                focused_by: None,
                selected: None,
                notified: None,
            });
        }
    };

    let elem = match find_element_in_window(
        ctx,
        &window,
        opts.name.as_deref(),
        opts.automation_id.as_deref(),
        opts.control_type.as_deref(),
    ) {
        Ok(e) => e,
        Err(e) => {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code: None,
                focused_by: None,
                selected: None,
                notified: None,
            });
        }
    };

    // Check IsEnabled (live, not cached)
    let is_enabled = unsafe {
        elem.CurrentIsEnabled()
            .map(|b| b == true)
            .unwrap_or(true)
    };
    if !is_enabled {
        return Ok(ActionResult {
            ok: false,
            element: None,
            error: Some("Element is disabled".into()),
            code: Some("ElementDisabled".into()),
            focused_by: None,
            selected: None,
            notified: None,
        });
    }

    // internal #233 — Chromium's content keeps the Invoke below, as before: there Invoke on a list
    // option SELECTS it (`change`, no dblclick; win2 2026-10-13, a `<select size=5>`), and a plain `<li>`
    // with Invoke and no SelectionItem would otherwise be left with no road. The framework is read here
    // because the server's entities do not carry it.
    if opts.select == Some(true) {
        let framework = unsafe { elem.CurrentFrameworkId() }.map(|b| b.to_string()).unwrap_or_default();
        if framework != "Chrome" {
            return Ok(select_item(ctx, &elem));
        }
    }

    // Try InvokePattern
    unsafe {
        let pat = match elem.GetCurrentPattern(UIA_InvokePatternId) {
            Ok(p) => p,
            Err(_) => {
                return Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some("InvokePattern not supported by this element".into()),
                    code: Some("PatternNotSupported".into()),
                    focused_by: None,
                    selected: None,
                    notified: None,
                });
            }
        };
        let invoke: IUIAutomationInvokePattern = match pat.cast() {
            Ok(i) => i,
            Err(_) => {
                return Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some("InvokePattern cast failed".into()),
                    code: Some("PatternNotSupported".into()),
                    focused_by: None,
                    selected: None,
                    notified: None,
                });
            }
        };

        // Read before the press: a Close or an OK that destroys itself answers nothing afterwards.
        let name = elem.CurrentName().map(|b| b.to_string()).unwrap_or_default();

        // Internal #216 — the client does not move the focus any more (`thread.rs`); a press is where
        // the field the caller wrote before gives up the focus, which is when an application commits
        // it, so the focus moves to what is pressed first (`focus_first.rs`).
        let focused_by = super::focus_first::move_focus_first(ctx, &elem);

        match invoke.Invoke() {
            Ok(()) => Ok(ActionResult {
                ok: true,
                element: Some(name),
                error: None,
                code: None,
                focused_by: Some(focused_by.into()),
                selected: None,
                notified: None,
            }),
            Err(e) => {
                // internal #232 — the call was made, so most failures may still follow a press that happened
                // (`mod.rs::PRESS_OUTCOME_UNKNOWN`). Three answers say the provider refused BEFORE acting
                // (READ in the InvokePattern docs, not measured here): not enabled, and not supported / not
                // implemented by a proxy that exposes the pattern anyway. Those keep their nothing-done words,
                // so the title road's downgrade for a control with no working Invoke still runs.
                let hr = e.code().0 as u32;
                let (error, code) = if super::is_timeout(&e) {
                    (super::STOPPED_ANSWERING, None)
                } else if hr == UIA_E_ELEMENTNOTENABLED {
                    ("Element is disabled", Some("ElementDisabled"))
                } else if hr == UIA_E_NOTSUPPORTED || hr == windows::Win32::Foundation::E_NOTIMPL.0 as u32 {
                    ("InvokePattern not supported by this element", Some("PatternNotSupported"))
                } else {
                    eprintln!("[uia] Invoke failed after the call was made: {e}");
                    (super::PRESS_OUTCOME_UNKNOWN, None)
                };
                Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some(error.into()),
                    code: code.map(Into::into),
                    focused_by: Some(focused_by.into()),
                    selected: None,
                    notified: None,
                })
            }
        }
    }
}

/// internal #233 — select a collection item instead of invoking it (`ClickElementOptions::select`).
///
/// MEASURED win2 2026-10-13 (internal #233 comments): UI Automation's Invoke on a list item acts as a
/// double-click — Explorer opens the file, a SysListView32 sends NM_DBLCLK, a Win32 LISTBOX sends
/// LBN_DBLCLK, a WinForms ListBox fires DoubleClick — and a WinForms ListView's Invoke does nothing yet
/// reports ok. `SelectionItemPattern.Select` selected on every provider, with no DBLCLK in any case.
/// But on a raw Win32 LISTBOX it sends no LBN_SELCHANGE, and on a WinForms ListBox the application sees
/// nothing (SelectedItem and SelectedIndices stay stale, ClearSelected is a no-op). Select followed by
/// the LBN_SELCHANGE the list's parent would get from a real click (`notify_list_box_selchange`) gave
/// exactly one SELCHANGE / SelectedIndexChanged and left WinForms' record as a real click leaves it.
///
/// A tree item is not selected this way (`MOUSE_CLICK_NEEDED`): MEASURED win2 2026-10-13 on raw
/// SysTreeView32, WinForms 4.8 and .NET 10, Select on a tree with nothing selected focuses the tree
/// first, the tree selects its first node, and the application gets TWO selection changes; a real
/// single click gives one, to the target, 3/3. Nothing is done here, and the server clicks it.
fn select_item(ctx: &UiaContext, elem: &IUIAutomationElement) -> ActionResult {
    unsafe {
        let is_tree_item = elem.CurrentControlType().map(|t| t.0 == UIA_TreeItemControlTypeId.0).unwrap_or(false);
        if is_tree_item {
            return ActionResult {
                ok: false,
                element: None,
                error: Some("This item is selected with a single mouse click".into()),
                code: Some(MOUSE_CLICK_NEEDED.into()),
                focused_by: None,
                selected: None,
                notified: None,
            };
        }
        let sel: IUIAutomationSelectionItemPattern =
            match elem.GetCurrentPatternAs(UIA_SelectionItemPatternId) {
                Ok(p) => p,
                Err(e) => {
                    // Only an ABSENT pattern is `PatternNotSupported`, which the executor turns into a single
                    // mouse click at the item's rectangle. A lookup that failed for another reason — the row
                    // gone (UIA_E_ELEMENTNOTAVAILABLE), the provider timing out — must not become a click at
                    // a rectangle something else may now occupy (PR #819 codex P1). windows-rs reports a null
                    // pattern as an error whose code is S_OK or E_POINTER; providers also answer
                    // E_NOINTERFACE, UIA_E_NOTSUPPORTED or E_NOTIMPL for "not here" (READ, not measured).
                    let hr = e.code().0 as u32;
                    let absent = hr == 0
                        || hr == windows::Win32::Foundation::E_POINTER.0 as u32
                        || hr == windows::Win32::Foundation::E_NOINTERFACE.0 as u32
                        || hr == UIA_E_NOTSUPPORTED
                        || hr == windows::Win32::Foundation::E_NOTIMPL.0 as u32;
                    if absent {
                        return ActionResult {
                            ok: false,
                            element: None,
                            error: Some("SelectionItemPattern not supported by this element".into()),
                            code: Some("PatternNotSupported".into()),
                            focused_by: None,
                            selected: None,
                            notified: None,
                        };
                    }
                    let (error, code): (String, Option<String>) = if super::is_timeout(&e) {
                        (super::STOPPED_ANSWERING.to_string(), None)
                    } else {
                        (format!("Select failed: the SelectionItemPattern lookup failed: {e}"), None)
                    };
                    return ActionResult {
                        ok: false,
                        element: None,
                        error: Some(error),
                        code,
                        focused_by: None,
                        selected: None,
                        notified: None,
                    };
                }
            };

        let name = elem.CurrentName().map(|b| b.to_string()).unwrap_or_default();
        // As on the Invoke road: the focus moves to what is clicked first (`focus_first.rs`).
        let focused_by = super::focus_first::move_focus_first(ctx, elem);

        if let Err(e) = sel.Select() {
            // Select is not a press that can open or run the item, so a failure after the call is not
            // `PRESS_OUTCOME_UNKNOWN`; a timeout still is "may run when the window answers".
            let error = if super::is_timeout(&e) {
                super::STOPPED_ANSWERING.to_string()
            } else {
                format!("Select failed: {e}")
            };
            return ActionResult {
                ok: false,
                element: None,
                error: Some(error),
                code: None,
                focused_by: Some(focused_by.into()),
                selected: None,
                notified: None,
            };
        }

        // A read that FAILS is not a read of false: Select has already returned, and the item may be
        // selected (PR #819 codex P2). Only a successful read of false is `SelectNotApplied`.
        let is_selected = match sel.CurrentIsSelected() {
            Ok(b) => b == true,
            Err(e) => {
                let (error, code) = if super::is_timeout(&e) {
                    (super::STOPPED_ANSWERING.to_string(), None)
                } else {
                    (format!("The select was sent, and whether the item is selected could not be read: {e}"), Some("SelectOutcomeUnknown".to_string()))
                };
                return ActionResult {
                    ok: false,
                    element: None,
                    error: Some(error),
                    code,
                    focused_by: Some(focused_by.into()),
                    selected: None,
                    notified: None,
                };
            }
        };
        if !is_selected {
            return ActionResult {
                ok: false,
                element: None,
                error: Some("The item was not selected".into()),
                code: Some("SelectNotApplied".into()),
                focused_by: Some(focused_by.into()),
                selected: None,
                notified: None,
            };
        }

        // Only once the select has taken: a list told "the selection changed" when it did not would act
        // on a selection the user never made.
        let notified = super::focus_first::list_window_of_item(ctx, elem).and_then(|list| notify_list_box_selchange(list));

        ActionResult {
            ok: true,
            element: Some(name),
            error: None,
            code: None,
            focused_by: Some(focused_by.into()),
            selected: Some(true),
            notified,
        }
    }
}

/// The code `select_item` answers for an item the server clicks with a single mouse click instead.
const MOUSE_CLICK_NEEDED: &str = "MouseClickNeeded";

/// `LBS_NOTIFY`: the list box tells its parent about selection changes (WinUser.h).
const LBS_NOTIFY: u32 = 0x0001;
/// `LBN_SELCHANGE` (WinUser.h).
const LBN_SELCHANGE: u32 = 1;
/// How long the list's parent is given to take the notification. The Select before it already went to
/// the same thread; this keeps a thread that stopped pumping from holding the act's worker with no limit.
const NOTIFY_MS: u32 = 2_000;

/// internal #233 — send a list box's parent the `WM_COMMAND(LBN_SELCHANGE)` a real click sends, which
/// `Select` does not (win2 2026-10-13, measured on a raw Win32 LISTBOX and a WinForms ListBox, class
/// `WindowsForms10.LISTBOX.*`). Only those two classes — `ListBox`, or the `WindowsForms10.LISTBOX.`
/// prefix, either case — and only with `LBS_NOTIFY`: a list that does not notify sends nothing on a
/// real click either. `None` when no notification was due, `Some(false)` when it could not be delivered.
unsafe fn notify_list_box_selchange(list: windows::Win32::Foundation::HWND) -> Option<bool> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_STYLE, GetClassNameW, GetDlgCtrlID, GetParent, GetWindowLongW, SMTO_ABORTIFHUNG,
        SendMessageTimeoutW, WM_COMMAND,
    };
    unsafe {
        let mut buf = [0u16; 256];
        let len = GetClassNameW(list, &mut buf);
        if len <= 0 {
            return None;
        }
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        if !is_list_box_class(&class) {
            return None;
        }
        let style = GetWindowLongW(list, GWL_STYLE) as u32;
        if style & LBS_NOTIFY == 0 {
            return None;
        }
        let parent = match GetParent(list) {
            Ok(p) if !p.0.is_null() => p,
            _ => {
                eprintln!("[uia] LBN_SELCHANGE not sent: the list box has no parent");
                return Some(false);
            }
        };
        let id = GetDlgCtrlID(list) as u32 & 0xFFFF;
        let wparam = (id | (LBN_SELCHANGE << 16)) as usize;
        let mut result: usize = 0;
        let sent = SendMessageTimeoutW(
            parent,
            WM_COMMAND,
            WPARAM(wparam),
            LPARAM(list.0 as isize),
            SMTO_ABORTIFHUNG,
            NOTIFY_MS,
            Some(&mut result),
        );
        if sent.0 == 0 {
            eprintln!("[uia] LBN_SELCHANGE to the list box's parent failed or timed out");
            return Some(false);
        }
        Some(true)
    }
}

/// A raw Win32 list box (`ListBox`) or a WinForms one (`WindowsForms10.LISTBOX.app…`), in either case.
fn is_list_box_class(class: &str) -> bool {
    class.eq_ignore_ascii_case("ListBox")
        || class.get(..23).is_some_and(|p| p.eq_ignore_ascii_case("WindowsForms10.LISTBOX."))
}

/// A pattern call's failure in words: the backend's own, except a timeout, which is this crate's
/// (`mod.rs::STOPPED_ANSWERING`: the press or write may still run when the window answers).
fn failure_text(e: &windows::core::Error) -> String {
    if super::is_timeout(e) { super::STOPPED_ANSWERING.to_string() } else { format!("{e}") }
}

fn set_value_impl(
    ctx: &UiaContext,
    opts: &SetValueOptions,
    submitted: std::time::Instant,
) -> napi::Result<ActionResult> {
    let window = match resolve_root(ctx, opts.hwnd.as_deref(), &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            let code = root_failure_code(opts.hwnd.as_deref(), &e.reason);
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code,
                focused_by: None,
                selected: None,
                notified: None,
            });
        }
    };

    let elem = match find_element_in_window(
        ctx,
        &window,
        opts.name.as_deref(),
        opts.automation_id.as_deref(),
        None,
    ) {
        Ok(e) => e,
        Err(e) => {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code: None,
                focused_by: None,
                selected: None,
                notified: None,
            });
        }
    };

    unsafe {
        let pat = match elem.GetCurrentPattern(UIA_ValuePatternId) {
            Ok(p) => p,
            Err(_) => {
                return Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some("ValuePattern not supported by this element".into()),
                    code: Some("PatternNotSupported".into()),
                    focused_by: None,
                    selected: None,
                    notified: None,
                });
            }
        };
        let vp: IUIAutomationValuePattern = match pat.cast() {
            Ok(v) => v,
            Err(_) => {
                return Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some("ValuePattern cast failed".into()),
                    code: Some("PatternNotSupported".into()),
                    focused_by: None,
                    selected: None,
                    notified: None,
                });
            }
        };

        // Internal #190 (gate 2) — IsEnabled is read AFTER the ValuePattern, as the managed client does:
        // the element here is the first descendant whose name contains the entity's, and a disabled
        // button or label found that way used to answer "disabled" for an enabled text field. Since the
        // keyboard rung believes a windowless field's "disabled" on UI Automation's word alone, a
        // control that takes no value must answer "no pattern" instead.
        let is_enabled = elem.CurrentIsEnabled().map(|b| b == true).unwrap_or(true);
        if !is_enabled {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some("Element is disabled".into()),
                code: Some("ElementDisabled".into()),
                focused_by: None,
                selected: None,
                notified: None,
            });
        }

        // Internal #188 — a read-only field is named by the pattern's own property, not by
        // SetValue's error. That error arrives in the OS language ("SetValue は、読み取り専用の値に
        // 対して呼び出せません (0x80131509)" on a Japanese Windows), and its HRESULT is .NET's generic
        // InvalidOperationException, so the route classifier never recognised it on this road and the
        // keyboard rung's read-only ground (#722) was never raised: a read-only WPF TextBox answered a
        // marked `ok:true` with nothing written (win2, AB arm C-4). `IsReadOnly` was true on exactly
        // the three read-only fields measured and false on every writable one (win2 `ca06123b`).
        // The message is this writer's own, in the words `uia-route-failure.ts` matches whole. A
        // property that cannot be read decides nothing: SetValue runs as before.
        //
        // Refused before writing only for a text field (Edit, Document), the kind measured. A combo box
        // that says read-only might still take SetValue (gate 2 on #729), so it is written, and only
        // a write that then FAILS on an element that said read-only is named read-only (below). win2
        // measured the case gate 2 named — a WPF ComboBox, IsEditable and IsReadOnly — and its SetValue
        // failed with the localized error, leaving a marked `ok:true` with nothing selected
        // (`18facd3a`, KILO).
        let is_text_field = elem
            .CurrentControlType()
            .map(|t| t.0 == UIA_EditControlTypeId.0 || t.0 == UIA_DocumentControlTypeId.0)
            .unwrap_or(false);
        let said_read_only = vp.CurrentIsReadOnly().map(|b| b == true).unwrap_or(false);
        if is_text_field && said_read_only {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some("Value is read-only".into()),
                code: Some("ElementReadOnly".into()),
                focused_by: None,
                selected: None,
                notified: None,
            });
        }

        // Internal #182 — a provider can accept SetValue and change nothing: a WinForms
        // NumericUpDown, read by this client as a ComboBox, answered S_OK while its value stayed
        // put (win2, 3 of 3). So the value is read before and after, on this element and this
        // pattern, and the write is believed not to have taken only when the value did not move
        // AND differs from what was written. Not an equality test: a field that reformats what it
        // is given moved, and was written.
        //
        // Not every element is asked. Chromium (Edge, WebView2) answers SetValue on a text field at
        // once and applies it a moment later, so the read right after it sees the old value: win2
        // measured 7 of 8 overwrites refused that had landed, the new value readable ~120 ms later
        // (internal `11fe8dc1`). The user's decision (2026-09-24) is both halves: Edit and Document
        // are not checked at all, and every other type is read again for up to
        // `NOT_APPLIED_SETTLE_MS` before the write is called not applied. A password field, a type
        // or a value that cannot be read decides nothing — each answers as it did before the check.
        let checked = !elem.CurrentIsPassword().map(|b| b == true).unwrap_or(true)
            && elem
                .CurrentControlType()
                .map(|t| write_is_checked(t.0))
                .unwrap_or(false);
        // Internal #216 — into the field before writing, as a person would, by a road that does not
        // raise the fall (`focus_first.rs`); the press that follows takes it away again, which is
        // when the application commits the value. Before `before` is read: a field that reformats
        // its text on taking the focus would otherwise read as moved by a write that took nothing
        // (gate 2 on `0eccd63c`).
        //
        // Not for an element that says read-only (a combo box can still say so and take the write):
        // its write usually fails, and the move would leave the focus on a control the act then
        // refused. win2 measured that on a WPF read-only ComboBox (2.1.0 dogfood, §9 r1b, 3/3: the
        // focus left DELTA for the combo and stayed; the build before the move left it alone). Such
        // an element is written first, and the focus moves only after a write not read back as refused
        // (where the value cannot be read back, nothing refuses it).
        // The classic client moves the focus by itself on the write, so it is not deferred there.
        let move_first = !said_read_only || ctx.classic;
        let mut focused_by = if move_first {
            super::focus_first::move_focus_first(ctx, &elem)
        } else {
            super::focus_first::NOT_MOVED_READ_ONLY
        };
        let before = if checked {
            vp.CurrentValue().ok().map(|b| b.to_string())
        } else {
            None
        };
        let bstr = windows::core::BSTR::from(&*opts.value);
        match vp.SetValue(&bstr) {
            Ok(()) => {
                let read = || vp.CurrentValue().ok().map(|b| b.to_string());
                let mut after = before.as_ref().and_then(|_| read());
                let started = std::time::Instant::now();
                while value_not_applied(before.as_deref(), after.as_deref(), &opts.value)
                    && started.elapsed() < std::time::Duration::from_millis(NOT_APPLIED_SETTLE_MS)
                {
                    std::thread::sleep(std::time::Duration::from_millis(NOT_APPLIED_POLL_MS));
                    after = read();
                }
                if value_not_applied(before.as_deref(), after.as_deref(), &opts.value) {
                    return Ok(ActionResult {
                        ok: false,
                        element: None,
                        error: Some(format!(
                            "SetValue returned success, but the element's value read back unchanged for {NOT_APPLIED_SETTLE_MS} ms after it"
                        )),
                        code: Some("ValueNotApplied".into()),
                        focused_by: Some(focused_by.into()),
                        selected: None,
                        notified: None,
                    });
                }
                // After the read-back, not before it: a focus move that reformats the text would
                // otherwise read as the write having taken (gate 1 on `f2e3b75f`). And not when the
                // write itself took long: the caller may already have been told the window stopped
                // answering, and a focus move landing later would surprise it (gate 2 on `f2e3b75f`).
                // Measured on the caller's clock, from when the task was queued (gate 1 on
                // `f4f1af62`), with room left for the move itself. Not bounded: a move into a window that
                // hangs right then can still land past the limit (UIA connection timeout, 7 s).
                if !move_first
                    && submitted.elapsed()
                        < std::time::Duration::from_millis(u64::from(
                            DEFAULT_TIMEOUT_MS - DEFERRED_FOCUS_ROOM_MS,
                        ))
                {
                    focused_by = super::focus_first::move_focus_first(ctx, &elem);
                }
                Ok(ActionResult {
                    ok: true,
                    element: None,
                    error: None,
                    code: None,
                    focused_by: Some(focused_by.into()),
                    selected: None,
                    notified: None,
                })
            }
            // A write that failed on an element that said read-only is named read-only, in words
            // the classifier matches in any OS language (see the note above `is_text_field`).
            Err(_) if said_read_only => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some("Value is read-only".into()),
                code: Some("ElementReadOnly".into()),
                focused_by: Some(focused_by.into()),
                selected: None,
                notified: None,
            }),
            Err(e) => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(failure_text(&e)),
                code: None,
                focused_by: Some(focused_by.into()),
                selected: None,
                notified: None,
            }),
        }
    }
}

/// How long a write that reads back unchanged is read again before it is called not applied
/// (internal #182). win2 saw Chromium's value ~120 ms after SetValue returned; this is that, with room.
const NOT_APPLIED_SETTLE_MS: u64 = 300;
const NOT_APPLIED_POLL_MS: u64 = 30;

/// Internal #182 — which control types the not-applied check asks. Edit and Document are not: the
/// providers measured to apply a text write late (Chromium's inputs, in Edge and in WebView2) are
/// Edit, and a check there refused writes that had landed. The one type measured to accept a write and
/// ignore it (a WinForms NumericUpDown's outer element) is ComboBox. The user's decision, 2026-09-24.
fn write_is_checked(control_type: i32) -> bool {
    control_type != UIA_EditControlTypeId.0 && control_type != UIA_DocumentControlTypeId.0
}

/// Internal #182 — whether a SetValue that answered S_OK is believed not to have taken: the value read
/// back after it is the value read before it, and not what was written. `None` on either side
/// (a password field, or a read that failed) decides nothing. Not an equality test against `written`:
/// a field that reformats what it is given has moved, and was written.
///
/// What this cannot see, said so a reader does not price it wrong: a provider that applies the write
/// after SetValue returns reads back unchanged here; a clear (`""`) on a control whose value always
/// reads `""` equals what was written; and a field already holding the normalised form of what is
/// written reads back unchanged and different.
fn value_not_applied(before: Option<&str>, after: Option<&str>, written: &str) -> bool {
    match (before, after) {
        (Some(before), Some(after)) => after == before && after != written,
        _ => false,
    }
}

fn insert_text_impl(ctx: &UiaContext, opts: &InsertTextOptions) -> napi::Result<ActionResult> {
    let window = match resolve_root(ctx, opts.hwnd.as_deref(), &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            let code = root_failure_code(opts.hwnd.as_deref(), &e.reason);
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code,
                focused_by: None,
                selected: None,
                notified: None,
            });
        }
    };

    let elem = match find_element_in_window(
        ctx,
        &window,
        opts.name.as_deref(),
        opts.automation_id.as_deref(),
        None,
    ) {
        Ok(e) => e,
        Err(e) => {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code: None,
                focused_by: None,
                selected: None,
                notified: None,
            });
        }
    };

    let is_enabled = unsafe { elem.CurrentIsEnabled().map(|b| b == true).unwrap_or(true) };
    if !is_enabled {
        return Ok(ActionResult {
            ok: false,
            element: None,
            error: Some("Element is disabled".into()),
            code: Some("ElementDisabled".into()),
            focused_by: None,
            selected: None,
            notified: None,
        });
    }

    // Check TextPattern2 availability. The COM client API
    // (IUIAutomationTextPattern2) does not expose InsertTextAtSelection —
    // that requires the .NET TextPattern2 provider wrapper.
    // We validate the element and pattern availability natively (fast),
    // then delegate actual insertion to the PowerShell/.NET fallback.
    unsafe {
        match elem.GetCurrentPattern(UIA_TextPattern2Id) {
            Ok(pat) => {
                // TextPattern2 IS supported but COM client can't insert.
                // Return Err to trigger PS fallback in the TS catch block.
                if pat.cast::<IUIAutomationTextPattern2>().is_ok() {
                    return Err(napi::Error::from_reason(
                        "TextPattern2 insert requires .NET provider access",
                    ));
                }
                Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some("TextPattern2 cast failed".into()),
                    code: Some("TextPattern2NotSupported".into()),
                    focused_by: None,
                    selected: None,
                    notified: None,
                })
            }
            Err(_) => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some("TextPattern2 not supported by this element".into()),
                code: Some("TextPattern2NotSupported".into()),
                focused_by: None,
                selected: None,
                notified: None,
            }),
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Find the element a call names inside `window`: the first DESCENDANT, depth-first, parent before
/// child, that matches every criterion given (`matches_with_ct`). Every road uses this one — the
/// three acts (click, value, insert), the two reads in `tree.rs`, and the three scroll roads.
///
/// **Never the window itself** (internal #133 for the acts, #134 for the reads). This used to test the window before its children,
/// by the same case-insensitive name substring — and a window whose title contains the name of one
/// of its own elements is ordinary ("Save" in "Save As"). MEASURED 2026-09-19 win2 (internal
/// `c0f9364`): a WPF window titled `RCX-title-BTNW-…` holding a Button `BTNW`; a name-only click
/// matched the window, which has no Invoke, so the title road downgraded to a coordinate press and
/// the handle road refused. Taking `BTNW` out of the title, the same click invoked the Button.
///
/// The window is addressed before this search runs — by title, or by the handle the caller gave —
/// and the name is for something inside it. **That the handle is a top-level window is a convention,
/// not a check** (gate 2): `resolveWindowTarget` takes any handle with a title or a rect and
/// `element_from_handle` does not re-root it, and this server publishes a control's own handle in
/// `get_ui_elements`. A caller that passed a CONTROL's handle and that control's own name was
/// answered by the control before this change and gets "not found" after it. Nothing in this repo
/// makes that call — the published handle is consumed by the keyboard receiver and the modal
/// guard — and an act that means "this control" names it inside its window. The PowerShell twins of
/// these three callers
/// (`uia-bridge.ts` — the click and value scripts, by title and by handle, and the insert fallback)
/// search `TreeScope.Descendants` and never test the window, and on the same window they invoked the
/// Button (win2, same round); this makes the two clients give one answer.
///
/// **The reads and the scroll roads moved here too** (internal #134). They tested the window first,
/// as their PowerShell twins did (`FindElement $target 0`), so the two clients agreed and neither
/// half could move alone — both moved in the same change. MEASURED 2026-09-20 win2 (internal
/// `bdef099`, 27 arms): with a name only the TITLE carried, `wait_until` `element_appears` answered
/// `ok:true` at once with the window's own rect, the `mouse_click` tier-3 re-query aimed at the
/// window's centre `(1080,660)` where the button's was `(1080,621)`, and `scope_element`'s remaining
/// code returned the window and a screenshot of all of it (44,220 bytes against a control's 1,548).
/// Worse, two entries hid it: `value_changes` and `scroll(action='to_element')` answered
/// byte-for-byte what they answer when nothing matched at all, so no caller could tell a wrong
/// target from no target.
///
/// What each read gives up by it, checked caller by caller (gate 2): `wait_until` keeps polling and
/// times out, which is what it should have done, and it has `window_appears` when a window IS the
/// subject; the mouse re-query falls back to the plain offset correction instead of aiming at the
/// window's centre; `scope_element` — the one caller whose window-match produced a usable answer,
/// a picture of the whole window — now says "Element not found", and `get_ui_elements` is the road
/// for a window-wide tree; `scroll_into_view` answers `ok:false, "Element not found"` where it said
/// `ok:true, scrolled:false, "ScrollItemPattern not available"`, which is the honest half of a
/// distinction it could not make before; and a window matched by `get_scroll_ancestors` walked up to
/// the root and yielded an empty list anyway.
///
/// **A call that names nothing finds nothing.** An empty criterion is not one (`given`), and with
/// none left the window used to answer — and it cannot be invoked; the walk alone would answer with
/// the first element in the tree, and invoke it. So that call is "not found" here, while the
/// PowerShell twins would take their first descendant (their filters become `$true`).
///
/// **One entry could send an empty one, and no longer can** (gate 2): every other caller refuses it
/// — discover drops nameless elements (`uia-provider.ts`), and the V1 tools ask for a name or an
/// AutomationId — but `scroll`'s `target` was `z.string()` with no minimum, so
/// `scroll(action='smart', target:'')` reached `get_scroll_ancestors`, where the two clients would
/// now answer differently: nothing here, the window's first child there. `target` is `.min(1)` now,
/// in both schemas that carry it, so the divergence is refused at the door rather than described in
/// a comment.
pub(crate) fn find_element_in_window(
    ctx: &UiaContext,
    window: &IUIAutomationElement,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> napi::Result<IUIAutomationElement> {
    let (name, automation_id, control_type) = given(name, automation_id, control_type);
    if name.is_none() && automation_id.is_none() && control_type.is_none() {
        return Err(napi::Error::from_reason("Element not found"));
    }
    find_among_descendants(ctx, window, name, automation_id, control_type)
}

/// Which criteria the call actually gave: an empty string is not one.
///
/// It read as two different things ten lines apart, and gate 2 on this change named it. An empty
/// `name` matches every element (`contains("")`), an empty `automation_id` matched NO element that
/// has one (`id == target`, an exact compare) — so `automationId: ""` was a filter nobody asked for,
/// while the same value alone meant "nothing was named". The PowerShell twins of the three acts and
/// of the two reads drop an empty filter (`name ? … : "$true"`), so this is also what makes those
/// roads read a caller the same way. #134 brought the scroll roads here too, and with them the last
/// copy of the other reading — `scroll.rs` had its own `matches_element` with the exact compare.
fn given<'a>(
    name: Option<&'a str>,
    automation_id: Option<&'a str>,
    control_type: Option<&'a str>,
) -> (Option<&'a str>, Option<&'a str>, Option<&'a str>) {
    let some = |c: Option<&'a str>| c.filter(|s| !s.is_empty());
    (some(name), some(automation_id), some(control_type))
}

/// The walk both searches share: `window`'s descendants in the control view, depth-first, parent
/// before child, to `MAX_SEARCH_DEPTH`; the first that matches every criterion given.
fn find_among_descendants(
    ctx: &UiaContext,
    window: &IUIAutomationElement,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> napi::Result<IUIAutomationElement> {
    let name_lower = name.map(|n| n.to_lowercase());
    let ct_lower = control_type.map(|c| c.to_lowercase());

    let mut stack: Vec<(IUIAutomationElement, u32)> = Vec::with_capacity(64);
    // internal #216 — a step that timed out is not "no such element": without this, a window too busy
    // to answer was reported as one that no longer holds the element.
    let timed_out = std::cell::Cell::new(false);
    let step = |r: windows::core::Result<IUIAutomationElement>| match r {
        Ok(e) => Some(e),
        Err(e) => {
            if super::is_timeout(&e) {
                timed_out.set(true);
            }
            None
        }
    };

    if let Some(child) = step(unsafe {
        ctx.walker
            .GetFirstChildElementBuildCache(window, &ctx.cache_request)
    }) {
        stack.push((child, 1));
    }

    while let Some((elem, depth)) = stack.pop() {
        // A provider that did not answer once will cost the same wait on every further step: stop.
        if timed_out.get() {
            break;
        }
        if let Some(sib) = step(unsafe {
            ctx.walker
                .GetNextSiblingElementBuildCache(&elem, &ctx.cache_request)
        }) {
            stack.push((sib, depth));
        }

        if matches_with_ct(&elem, &name_lower, automation_id, &ct_lower) {
            return Ok(elem);
        }

        if depth < MAX_SEARCH_DEPTH
            && let Some(child) = step(unsafe {
                ctx.walker
                    .GetFirstChildElementBuildCache(&elem, &ctx.cache_request)
            })
        {
            stack.push((child, depth + 1));
        }
    }

    if timed_out.get() {
        return Err(napi::Error::from_reason(super::NOT_ANSWERING));
    }
    Err(napi::Error::from_reason("Element not found"))
}

/// Match element by name (case-insensitive substring), automationId (exact),
/// and controlType (case-insensitive substring). All specified criteria must match.
fn matches_with_ct(
    elem: &IUIAutomationElement,
    name_lower: &Option<String>,
    automation_id: Option<&str>,
    ct_lower: &Option<String>,
) -> bool {
    let name_ok = match name_lower {
        Some(target) => unsafe {
            elem.CachedName()
                .map(|n| n.to_string().to_lowercase().contains(target.as_str()))
                .unwrap_or(false)
        },
        None => true,
    };

    let id_ok = match automation_id {
        Some(target) => unsafe {
            elem.CachedAutomationId()
                .is_ok_and(|id| id == target)
        },
        None => true,
    };

    let ct_ok = match ct_lower {
        Some(target) => unsafe {
            // internal #216 — the type the reads report (`mod.rs::reported_control_type`), so a filter
            // taken from a read finds the same element.
            super::cached_control_type(elem)
                .map(|id| {
                    super::control_type_name(id)
                        .to_lowercase()
                        .contains(target.as_str())
                })
                .unwrap_or(false)
        },
        None => true,
    };

    name_ok && id_ok && ct_ok
}

#[cfg(test)]
mod tests {
    use super::value_not_applied;
    use windows::Win32::UI::Accessibility::*;

    #[test]
    fn the_numeric_up_down_that_took_nothing_is_not_applied() {
        // win2 d58b673d: the outer GOLF read "" before and after a write of "4242".
        assert!(value_not_applied(Some(""), Some(""), "4242"));
        assert!(value_not_applied(Some("0"), Some("0"), "4242"));
    }

    #[test]
    fn a_value_that_moved_was_written_even_if_reformatted() {
        assert!(!value_not_applied(Some("0"), Some("4343"), "4343"));
        assert!(!value_not_applied(Some("0"), Some("4343"), "04343"));
    }

    #[test]
    fn writing_what_is_already_there_is_not_refused() {
        assert!(!value_not_applied(Some("abc"), Some("abc"), "abc"));
        assert!(!value_not_applied(Some(""), Some(""), ""));
    }

    #[test]
    fn text_fields_are_not_asked_and_a_combo_box_is() {
        assert!(!super::write_is_checked(UIA_EditControlTypeId.0));
        assert!(!super::write_is_checked(UIA_DocumentControlTypeId.0));
        assert!(super::write_is_checked(UIA_ComboBoxControlTypeId.0));
        assert!(super::write_is_checked(UIA_SpinnerControlTypeId.0));
    }

    #[test]
    fn a_value_that_could_not_be_read_decides_nothing() {
        assert!(!value_not_applied(None, Some(""), "4242"));
        assert!(!value_not_applied(Some(""), None, "4242"));
        assert!(!value_not_applied(None, None, "4242"));
    }
}
