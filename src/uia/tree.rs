//! Tree-walk implementation: enumerate UI elements of a window.
//!
//! Mirrors the PowerShell `getUiElements`, `getElementChildren`, and
//! `getElementBounds` functions in `uia-bridge.ts`.
//!
//! **Algorithm**: Batch BFS using `FindAllBuildCache(TreeScope_Children)`.
//! Each RPC fetches all ControlView children of one parent at once.
//! Early exit on `maxElements` / `maxDepth` prevents Explorer.exe from
//! performing unnecessary full-tree enumeration.

use std::collections::VecDeque;
use std::time::Instant;

use windows::Win32::Foundation::RECT;
use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext, win_err};
use super::types::*;
use super::control_type_name;

// ─── Configuration defaults ──────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH: u32 = 30;
const DEFAULT_MAX_ELEMENTS: u32 = 500;
const DEFAULT_TIMEOUT_MS: u32 = 8_000;

// ─── Options from JS ────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct GetElementsOptions {
    pub window_title: String,
    pub max_depth: Option<u32>,
    pub max_elements: Option<u32>,
    pub fetch_values: Option<bool>,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Exposed to JS as `uiaGetElements`.
pub fn get_elements(opts: GetElementsOptions) -> napi::Result<UiElementsResult> {
    thread::execute_with_timeout(
        move |ctx| get_elements_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

// ─── Implementation ──────────────────────────────────────────────────────────

fn get_elements_impl(ctx: &UiaContext, opts: &GetElementsOptions) -> napi::Result<UiElementsResult> {
    let max_depth = opts.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    let max_elements = opts.max_elements.unwrap_or(DEFAULT_MAX_ELEMENTS);
    let fetch_values = opts.fetch_values.unwrap_or(false);

    let root = find_window(ctx, &opts.window_title)?;

    // Extract window metadata from element-scoped cache.
    let window_title = unsafe { root.CachedName().map_err(win_err)?.to_string() };
    let window_class_name = unsafe { root.CachedClassName().ok().map(|b| b.to_string()) };
    let window_rect = cached_bounding_rect(&root).ok();

    // ★ Batch BFS: FindAllBuildCache(TreeScope_Children) per parent.
    // Each RPC fetches all ControlView children of one parent at once.
    // maxElements / maxDepth triggers early exit — no unnecessary RPCs.
    let mut elements: Vec<UiElement> = Vec::with_capacity(max_elements as usize);
    let mut queue: VecDeque<(IUIAutomationElement, u32)> = VecDeque::with_capacity(64);
    // Queue entries: (parent, depth_of_its_children).
    // Root's children are at depth 1.
    queue.push_back((root, 1));

    'bfs: while let Some((parent, child_depth)) = queue.pop_front() {
        if child_depth > max_depth {
            continue;
        }

        // One RPC: fetch ALL ControlView children of this parent.
        let children = unsafe {
            parent.FindAllBuildCache(
                TreeScope_Children,
                &ctx.control_view_condition,
                &ctx.cache_request,
            )
        };
        let arr = match children {
            Ok(a) => a,
            Err(_) => continue,
        };
        let count = unsafe { arr.Length() }.unwrap_or(0);

        for i in 0..count {
            let child = match unsafe { arr.GetElement(i) } {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Skip offscreen elements (prune subtree — don't enqueue).
            let is_offscreen = unsafe { child.CachedIsOffscreen() }
                .map(|b| b == true)
                .unwrap_or(true);
            if is_offscreen {
                continue;
            }

            if let Ok(ui_elem) = extract_element(&child, child_depth, fetch_values) {
                elements.push(ui_elem);
            }

            if elements.len() >= max_elements as usize {
                break 'bfs;
            }

            // Enqueue for next-level exploration.
            if child_depth < max_depth {
                queue.push_back((child, child_depth + 1));
            }
        }
    }

    Ok(UiElementsResult {
        window_title,
        window_class_name,
        window_rect,
        element_count: elements.len() as u32,
        elements,
    })
}

// ─── Window finding ──────────────────────────────────────────────────────────

/// Find a top-level window whose name contains `title` (case-insensitive substring match).
pub(crate) fn find_window(ctx: &UiaContext, title: &str) -> napi::Result<IUIAutomationElement> {
    unsafe {
        let root = ctx.automation.GetRootElement().map_err(win_err)?;
        let condition = ctx.automation.CreateTrueCondition().map_err(win_err)?;
        let children = root.FindAll(TreeScope_Children, &condition).map_err(win_err)?;
        let count = children.Length().map_err(win_err)?;
        let title_lower = title.to_lowercase();

        for i in 0..count {
            let elem = children.GetElement(i).map_err(win_err)?;
            if let Ok(name) = elem.CurrentName()
                && name.to_string().to_lowercase().contains(&title_lower)
            {
                // Rebuild element with cache populated.
                let cached = elem.BuildUpdatedCache(&ctx.cache_request).map_err(win_err)?;
                return Ok(cached);
            }
        }
    }

    Err(napi::Error::from_reason(format!(
        "Window not found: \"{title}\""
    )))
}

// ─── Element extraction ──────────────────────────────────────────────────────

fn extract_element(
    elem: &IUIAutomationElement,
    depth: u32,
    fetch_values: bool,
) -> windows::core::Result<UiElement> {
    unsafe {
        let name = elem.CachedName().map(|b| b.to_string()).unwrap_or_default();
        let control_type_id = elem.CachedControlType()?;
        let control_type = control_type_name(control_type_id).to_string();
        let automation_id = elem
            .CachedAutomationId()
            .map(|b| b.to_string())
            .unwrap_or_default();
        let class_name = elem.CachedClassName().ok().map(|b| b.to_string());
        let is_enabled = elem.CachedIsEnabled().map(|b| b == true).unwrap_or(true);
        let bounding_rect = cached_bounding_rect(elem).ok();

        let mut patterns = Vec::with_capacity(6);
        if elem.GetCachedPattern(UIA_InvokePatternId).is_ok() {
            patterns.push("Invoke".to_string());
        }
        if elem.GetCachedPattern(UIA_ValuePatternId).is_ok() {
            patterns.push("Value".to_string());
        }
        if elem.GetCachedPattern(UIA_ExpandCollapsePatternId).is_ok() {
            patterns.push("ExpandCollapse".to_string());
        }
        if elem.GetCachedPattern(UIA_SelectionItemPatternId).is_ok() {
            patterns.push("SelectionItem".to_string());
        }
        if elem.GetCachedPattern(UIA_TogglePatternId).is_ok() {
            patterns.push("Toggle".to_string());
        }
        if elem.GetCachedPattern(UIA_ScrollPatternId).is_ok() {
            patterns.push("Scroll".to_string());
        }

        // Optional: fetch live Value from ValuePattern.
        let value = if fetch_values {
            fetch_value_pattern(elem)
        } else {
            None
        };

        Ok(UiElement {
            name,
            control_type,
            automation_id,
            class_name,
            is_enabled,
            bounding_rect,
            patterns,
            depth,
            value,
        })
    }
}

/// Read `IUIAutomationValuePattern::CachedValue` (from cache, no RPC).
fn fetch_value_pattern(elem: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let pat = elem.GetCachedPattern(UIA_ValuePatternId).ok()?;
        let val: IUIAutomationValuePattern = pat.cast().ok()?;
        val.CachedValue().ok().map(|b| b.to_string())
    }
}

/// Extract RECT from cache and convert to `BoundingRect`.
fn cached_bounding_rect(elem: &IUIAutomationElement) -> windows::core::Result<BoundingRect> {
    unsafe {
        let rect: RECT = elem.CachedBoundingRectangle()?;
        let br = BoundingRect {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        };
        // Discard zero-area rects (invisible elements).
        if br.width == 0 && br.height == 0 {
            return Err(windows::core::Error::empty());
        }
        Ok(br)
    }
}

// ─── getElementBounds ────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct GetElementBoundsOptions {
    pub window_title: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
}

pub fn get_element_bounds(opts: GetElementBoundsOptions) -> napi::Result<Option<ElementBounds>> {
    thread::execute_with_timeout(
        move |ctx| get_element_bounds_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

fn get_element_bounds_impl(
    ctx: &UiaContext,
    opts: &GetElementBoundsOptions,
) -> napi::Result<Option<ElementBounds>> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(_) => return Ok(None),
    };

    let elem = match super::actions::find_element_for_action(
        ctx,
        &window,
        opts.name.as_deref(),
        opts.automation_id.as_deref(),
        opts.control_type.as_deref(),
    ) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    // Read live properties (not cached — the element came from find_element which
    // may have been fetched with cache but we need current state for bounds).
    unsafe {
        let name = elem
            .CurrentName()
            .map(|b| b.to_string())
            .unwrap_or_default();
        let ct_id = elem
            .CurrentControlType()
            .unwrap_or(UIA_CustomControlTypeId);
        let control_type = control_type_name(ct_id).to_string();
        let automation_id = elem
            .CurrentAutomationId()
            .map(|b| b.to_string())
            .unwrap_or_default();

        let bounding_rect = elem.CurrentBoundingRectangle().ok().and_then(|rect| {
            let br = BoundingRect {
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            };
            if br.width == 0 && br.height == 0 {
                None
            } else {
                Some(br)
            }
        });

        // Try to read ValuePattern value
        let value = elem
            .GetCurrentPattern(UIA_ValuePatternId)
            .ok()
            .and_then(|p| p.cast::<IUIAutomationValuePattern>().ok())
            .and_then(|vp| vp.CurrentValue().ok())
            .map(|b| b.to_string());

        Ok(Some(ElementBounds {
            name,
            control_type,
            automation_id,
            bounding_rect,
            value,
        }))
    }
}

// ─── getElementChildren ──────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct GetElementChildrenOptions {
    pub window_title: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub max_depth: u32,
    pub max_elements: u32,
    pub timeout_ms: u32,
}

pub fn get_element_children(opts: GetElementChildrenOptions) -> napi::Result<Vec<UiElement>> {
    let timeout = opts.timeout_ms.max(1_000);
    thread::execute_with_timeout(
        move |ctx| get_element_children_impl(ctx, &opts),
        timeout,
    )
}

fn get_element_children_impl(
    ctx: &UiaContext,
    opts: &GetElementChildrenOptions,
) -> napi::Result<Vec<UiElement>> {
    let window = find_window(ctx, &opts.window_title)?;

    let target = super::actions::find_element_for_action(
        ctx,
        &window,
        opts.name.as_deref(),
        opts.automation_id.as_deref(),
        opts.control_type.as_deref(),
    )?;

    // BFS: FindAllBuildCache(TreeScope_Children) per parent.
    // Queue entries: (parent, depth_of_its_children).
    // Target's direct children are at depth 0 (matching original behavior).
    let mut elements: Vec<UiElement> = Vec::with_capacity(opts.max_elements as usize);
    let mut queue: VecDeque<(IUIAutomationElement, u32)> = VecDeque::with_capacity(64);
    queue.push_back((target, 0));

    let deadline = Instant::now() + std::time::Duration::from_millis(opts.timeout_ms as u64);

    'bfs: while let Some((parent, child_depth)) = queue.pop_front() {
        if Instant::now() >= deadline || child_depth > opts.max_depth {
            continue;
        }

        let children = unsafe {
            parent.FindAllBuildCache(
                TreeScope_Children,
                &ctx.control_view_condition,
                &ctx.cache_request,
            )
        };
        let arr = match children {
            Ok(a) => a,
            Err(_) => continue,
        };
        let count = unsafe { arr.Length() }.unwrap_or(0);

        for i in 0..count {
            let child = match unsafe { arr.GetElement(i) } {
                Ok(c) => c,
                Err(_) => continue,
            };

            // getElementChildren includes all elements (no offscreen skip).
            if let Ok(ui_elem) = extract_element(&child, child_depth, false) {
                elements.push(ui_elem);
            }

            if elements.len() >= opts.max_elements as usize {
                break 'bfs;
            }

            if child_depth < opts.max_depth {
                queue.push_back((child, child_depth + 1));
            }
        }
    }

    Ok(elements)
}
