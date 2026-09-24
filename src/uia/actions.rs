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
    thread::execute_with_timeout(
        move |ctx| click_element_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn set_value(opts: SetValueOptions) -> napi::Result<ActionResult> {
    thread::execute_with_timeout(
        move |ctx| set_value_impl(ctx, &opts),
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
    if hwnd.is_none() || reason.starts_with(CACHE_BUILD_FAILED_PREFIX) {
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
        });
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
                });
            }
        };

        match invoke.Invoke() {
            Ok(()) => {
                let name = elem
                    .CurrentName()
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                Ok(ActionResult {
                    ok: true,
                    element: Some(name),
                    error: None,
                    code: None,
                })
            }
            Err(e) => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(format!("{e}")),
                code: None,
            }),
        }
    }
}

fn set_value_impl(ctx: &UiaContext, opts: &SetValueOptions) -> napi::Result<ActionResult> {
    let window = match resolve_root(ctx, opts.hwnd.as_deref(), &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            let code = root_failure_code(opts.hwnd.as_deref(), &e.reason);
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code,
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
        });
    }

    unsafe {
        let pat = match elem.GetCurrentPattern(UIA_ValuePatternId) {
            Ok(p) => p,
            Err(_) => {
                return Ok(ActionResult {
                    ok: false,
                    element: None,
                    error: Some("ValuePattern not supported by this element".into()),
                    code: Some("PatternNotSupported".into()),
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
                });
            }
        };

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
        // Only for a text field (Edit, Document), the kind measured. A combo box that says read-only
        // may still take SetValue (an editable WPF ComboBox with IsReadOnly set, from its peer's
        // source — not measured); refusing it here would send it to the keyboard rung, where WM_CHAR
        // on a drop-down selects by first letter (gate 2 on #729). Other types answer as before.
        let is_text_field = elem
            .CurrentControlType()
            .map(|t| t.0 == UIA_EditControlTypeId.0 || t.0 == UIA_DocumentControlTypeId.0)
            .unwrap_or(false);
        if is_text_field && vp.CurrentIsReadOnly().map(|b| b == true).unwrap_or(false) {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some("Value is read-only".into()),
                code: Some("ElementReadOnly".into()),
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
                    });
                }
                Ok(ActionResult {
                    ok: true,
                    element: None,
                    error: None,
                    code: None,
                })
            }
            Err(e) => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(format!("{e}")),
                code: None,
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
                })
            }
            Err(_) => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some("TextPattern2 not supported by this element".into()),
                code: Some("TextPattern2NotSupported".into()),
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

    if let Ok(child) = unsafe {
        ctx.walker
            .GetFirstChildElementBuildCache(window, &ctx.cache_request)
    } {
        stack.push((child, 1));
    }

    while let Some((elem, depth)) = stack.pop() {
        if let Ok(sib) = unsafe {
            ctx.walker
                .GetNextSiblingElementBuildCache(&elem, &ctx.cache_request)
        } {
            stack.push((sib, depth));
        }

        if matches_with_ct(&elem, &name_lower, automation_id, &ct_lower) {
            return Ok(elem);
        }

        if depth < MAX_SEARCH_DEPTH
            && let Ok(child) = unsafe {
                ctx.walker
                    .GetFirstChildElementBuildCache(&elem, &ctx.cache_request)
            }
        {
            stack.push((child, depth + 1));
        }
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
            elem.CachedControlType()
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
