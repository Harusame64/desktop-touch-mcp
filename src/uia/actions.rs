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

        let bstr = windows::core::BSTR::from(&*opts.value);
        match vp.SetValue(&bstr) {
            Ok(()) => Ok(ActionResult {
                ok: true,
                element: None,
                error: None,
                code: None,
            }),
            Err(e) => Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(format!("{e}")),
                code: None,
            }),
        }
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
/// **A call that names nothing finds nothing.** An empty criterion is not one (`given`), and with
/// none left the window used to answer — and it cannot be invoked; the walk alone would answer with
/// the first element in the tree, and invoke it. So that call is "not found" here. The PowerShell
/// twins still take their first descendant (their filters become `$true`); no shipped call reaches
/// either: discover drops nameless elements (`uia-provider.ts`), and the V1 tools refuse a call with
/// neither a name nor an AutomationId.
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

/// **The reads moved here too** (internal #134). They tested the window first, as their PowerShell
/// twins did (`FindElement $target 0`), so the two clients agreed and neither half could move
/// alone — both moved in the same change. MEASURED 2026-09-20 win2 (internal `bdef099`, 27 arms):
/// with a name only the TITLE carried, `wait_until` `element_appears` answered `ok:true` at once
/// with the window's own rect, the `mouse_click` tier-3 re-query aimed at the window's centre
/// `(1080,660)` where the button's was `(1080,621)`, and `scope_element`'s remaining code returned
/// the window and a screenshot of all of it (44,220 bytes against a control's 1,548). Worse, two
/// entries hid it: `value_changes` and `scroll(action='to_element')` answered byte-for-byte what
/// they answer when nothing matched at all, so no caller could tell a wrong target from no target.
///
/// None of the reads' callers can mean the window: `wait_until` has `window_appears` for a window,
/// the mouse re-query is about a control's rect, and a window matched by `get_scroll_ancestors`
/// walks up to the root and yields an empty list anyway.
///
/// Which criteria the call actually gave: an empty string is not one.
///
/// It read as two different things ten lines apart, and gate 2 on this change named it. An empty
/// `name` matches every element (`contains("")`), an empty `automation_id` matched NO element that
/// has one (`id == target`, an exact compare) — so `automationId: ""` was a filter nobody asked for,
/// while the same value alone meant "nothing was named". The PowerShell twins of the three acts and
/// of the two reads drop an empty filter (`name ? … : "$true"`), so this is also what makes those
/// five roads read a caller the same way. **Not the scroll road**: `find_element` in `scroll.rs`
/// still hands an empty id to an exact compare while its own twin drops it — one more reason that
/// road is a change of its own (no caller reaches it: both pass a name only).
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
