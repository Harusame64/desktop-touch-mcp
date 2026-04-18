//! Scroll operations: ScrollItemPattern / ScrollPattern interaction.
//!
//! Mirrors `scrollElementIntoView`, `getScrollAncestors`, and `scrollByPercent`
//! from `uia-bridge.ts`.

use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext, win_err};
use super::tree::find_window;
use super::types::*;
use super::control_type_name;

const DEFAULT_TIMEOUT_MS: u32 = 8_000;
const MAX_SEARCH_DEPTH: u32 = 14;

// ─── Options from JS ─────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollIntoViewOptions {
    pub window_title: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollAncestorsOptions {
    pub window_title: String,
    pub element_name: String,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollByPercentOptions {
    pub window_title: String,
    pub element_name: String,
    pub vertical_percent: f64,
    pub horizontal_percent: f64,
}

// ─── Public API ──────────────────────────────────────────────────────────────

pub fn scroll_into_view(opts: ScrollIntoViewOptions) -> napi::Result<ScrollResult> {
    thread::execute_with_timeout(
        move |ctx| scroll_into_view_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn get_scroll_ancestors(opts: ScrollAncestorsOptions) -> napi::Result<Vec<ScrollAncestor>> {
    thread::execute_with_timeout(
        move |ctx| get_scroll_ancestors_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn scroll_by_percent(opts: ScrollByPercentOptions) -> napi::Result<ScrollResult> {
    thread::execute_with_timeout(
        move |ctx| scroll_by_percent_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

// ─── Implementation ──────────────────────────────────────────────────────────

fn scroll_into_view_impl(
    ctx: &UiaContext,
    opts: &ScrollIntoViewOptions,
) -> napi::Result<ScrollResult> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    let elem = match find_element(ctx, &window, opts.name.as_deref(), opts.automation_id.as_deref())
    {
        Ok(e) => e,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    // Try to invoke ScrollItemPattern::ScrollIntoView.
    unsafe {
        if let Ok(pat) = elem.GetCurrentPattern(UIA_ScrollItemPatternId)
            && let Ok(sip) = pat.cast::<IUIAutomationScrollItemPattern>()
        {
            match sip.ScrollIntoView() {
                Ok(()) => {
                    return Ok(ScrollResult {
                        ok: true,
                        scrolled: true,
                        error: None,
                    });
                }
                Err(e) => {
                    return Ok(ScrollResult {
                        ok: true,
                        scrolled: false,
                        error: Some(format!("{e}")),
                    });
                }
            }
        }
        Ok(ScrollResult {
            ok: true,
            scrolled: false,
            error: Some("ScrollItemPattern not available".into()),
        })
    }
}

fn get_scroll_ancestors_impl(
    ctx: &UiaContext,
    opts: &ScrollAncestorsOptions,
) -> napi::Result<Vec<ScrollAncestor>> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(_) => return Ok(Vec::new()),
    };

    let elem = match find_element(ctx, &window, Some(&opts.element_name), None) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    walk_scroll_ancestors(ctx, &elem)
}

fn scroll_by_percent_impl(
    ctx: &UiaContext,
    opts: &ScrollByPercentOptions,
) -> napi::Result<ScrollResult> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    let elem = match find_element(ctx, &window, Some(&opts.element_name), None) {
        Ok(e) => e,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    // Clamp values: < 0 means "no scroll" (UIA_ScrollPatternNoScroll = -1).
    let vp = if opts.vertical_percent < 0.0 {
        -1.0
    } else {
        opts.vertical_percent.clamp(0.0, 100.0).round()
    };
    let hp = if opts.horizontal_percent < 0.0 {
        -1.0
    } else {
        opts.horizontal_percent.clamp(0.0, 100.0).round()
    };

    // Walk parents to find the nearest ScrollPattern ancestor.
    let root: IUIAutomationElement =
        unsafe { ctx.automation.GetRootElement().map_err(win_err)? };
    let mut current: Option<IUIAutomationElement> =
        unsafe { ctx.walker.GetParentElement(&elem).ok() };

    while let Some(parent) = current {
        let is_root = unsafe {
            ctx.automation
                .CompareElements(&parent, &root)
                .unwrap_or_default()
        };
        if is_root == true {
            break;
        }

        unsafe {
            if let Ok(pat) = parent.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                // UIA convention: horizontal first, vertical second.
                return match scroll.SetScrollPercent(hp, vp) {
                    Ok(()) => Ok(ScrollResult {
                        ok: true,
                        scrolled: true,
                        error: None,
                    }),
                    Err(e) => Ok(ScrollResult {
                        ok: false,
                        scrolled: false,
                        error: Some(format!("{e}")),
                    }),
                };
            }
        }

        current = unsafe { ctx.walker.GetParentElement(&parent).ok() };
    }

    Ok(ScrollResult {
        ok: false,
        scrolled: false,
        error: Some("No ScrollPattern ancestor found".into()),
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// DFS search for an element by name (case-insensitive substring) and/or
/// automationId (exact match). Uses CacheRequest to batch property fetches.
pub(crate) fn find_element(
    ctx: &UiaContext,
    window: &IUIAutomationElement,
    name: Option<&str>,
    automation_id: Option<&str>,
) -> napi::Result<IUIAutomationElement> {
    let name_lower = name.map(|n| n.to_lowercase());

    // Check the window element itself.
    if matches_element(window, &name_lower, automation_id) {
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
        // Push sibling before match check so siblings are always visited.
        if let Ok(sib) = unsafe {
            ctx.walker
                .GetNextSiblingElementBuildCache(&elem, &ctx.cache_request)
        } {
            stack.push((sib, depth));
        }

        if matches_element(&elem, &name_lower, automation_id) {
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

/// Check if an element matches by name (case-insensitive substring)
/// and/or automationId (exact). Both must pass when specified.
fn matches_element(
    elem: &IUIAutomationElement,
    name_lower: &Option<String>,
    automation_id: Option<&str>,
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

    name_ok && id_ok
}

/// Walk from element upward, collecting ancestors that expose ScrollPattern.
/// Returns outer→inner order (reversed from walk order, matching TS behaviour).
fn walk_scroll_ancestors(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
) -> napi::Result<Vec<ScrollAncestor>> {
    let mut ancestors = Vec::new();
    let root: IUIAutomationElement =
        unsafe { ctx.automation.GetRootElement().map_err(win_err)? };

    let mut current: Option<IUIAutomationElement> =
        unsafe { ctx.walker.GetParentElement(elem).ok() };

    while let Some(parent) = current {
        let is_root = unsafe {
            ctx.automation
                .CompareElements(&parent, &root)
                .unwrap_or_default()
        };
        if is_root == true {
            break;
        }

        // Parent wasn't fetched with cache — use Current* accessors (live RPC).
        unsafe {
            if let Ok(pat) = parent.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                let name = parent
                    .CurrentName()
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let aid = parent
                    .CurrentAutomationId()
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let ct_id = parent
                    .CurrentControlType()
                    .unwrap_or(UIA_CustomControlTypeId);
                let ct = control_type_name(ct_id).to_string();

                let vp = scroll.CurrentVerticalScrollPercent().unwrap_or(-1.0);
                let hp = scroll.CurrentHorizontalScrollPercent().unwrap_or(-1.0);
                let vs = scroll
                    .CurrentVerticallyScrollable()
                    .map(|b| b == true)
                    .unwrap_or(false);
                let hs = scroll
                    .CurrentHorizontallyScrollable()
                    .map(|b| b == true)
                    .unwrap_or(false);

                ancestors.push(ScrollAncestor {
                    name,
                    automation_id: aid,
                    control_type: ct,
                    vertical_percent: vp,
                    horizontal_percent: hp,
                    vertically_scrollable: vs,
                    horizontally_scrollable: hs,
                });
            }
        }

        current = unsafe { ctx.walker.GetParentElement(&parent).ok() };
    }

    // Reverse to outer→inner (matching TS `[array]::Reverse($ancestors)`).
    ancestors.reverse();
    Ok(ancestors)
}
