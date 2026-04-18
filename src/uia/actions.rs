//! Action functions: click (InvokePattern), set value (ValuePattern),
//! insert text (TextPattern2).
//!
//! All functions return `ActionResult` — never panic or reject the Promise.
//! Disabled elements and unsupported patterns are reported via `ok: false`.

use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::scroll::find_element;
use super::thread::{self, UiaContext};
use super::tree::find_window;
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
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct SetValueOptions {
    pub window_title: String,
    pub value: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct InsertTextOptions {
    pub window_title: String,
    pub value: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
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

fn click_element_impl(ctx: &UiaContext, opts: &ClickElementOptions) -> napi::Result<ActionResult> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code: None,
            });
        }
    };

    let elem = match find_element_for_action(
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
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code: None,
            });
        }
    };

    let elem = match find_element_for_action(
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
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ActionResult {
                ok: false,
                element: None,
                error: Some(e.reason),
                code: None,
            });
        }
    };

    let elem = match find_element_for_action(
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

/// Find an element for action operations. Uses the same DFS search as scroll
/// but adds `control_type` matching support.
pub(crate) fn find_element_for_action(
    ctx: &UiaContext,
    window: &IUIAutomationElement,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> napi::Result<IUIAutomationElement> {
    if control_type.is_none() {
        // Delegate to existing find_element in scroll.rs
        return find_element(ctx, window, name, automation_id);
    }

    let name_lower = name.map(|n| n.to_lowercase());
    let ct_lower = control_type.map(|c| c.to_lowercase());

    // Check window element itself
    if matches_with_ct(window, &name_lower, automation_id, &ct_lower) {
        return Ok(window.clone());
    }

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
