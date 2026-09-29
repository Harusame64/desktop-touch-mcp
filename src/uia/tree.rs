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

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::Variant::{VARENUM, VARIANT, VT_ARRAY, VT_I4, VariantClear};
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
    /// ADR-036 — read THIS window, rather than the first one whose name contains `window_title`.
    ///
    /// A decimal handle as a string, the shape `ScrollByWheelAtHwndOptions` already uses. When
    /// present the title is not searched at all, so a second window answering to the same title
    /// cannot be read instead — and the caller does not have to leave this engine to get that,
    /// which is what it had to do before: the TS bridge fell back to a PowerShell script for
    /// every pinned read, at 184 ms against 517 ms on the same window, and that road cannot see
    /// a window's frame without registering MSAA clientside providers, which gives the frame
    /// English names this one does not use.
    pub hwnd: Option<String>,
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

    let root = resolve_root(ctx, opts.hwnd.as_deref(), &opts.window_title)?;

    // Extract window metadata from element-scoped cache.
    let window_title = unsafe { root.CachedName().map_err(win_err)?.to_string() };
    let window_class_name = unsafe { root.CachedClassName().ok().map(|b| b.to_string()) };
    let window_rect = cached_bounding_rect(&root).ok();
    // ADR-036 item 15 — WHICH window this is, not just what it looks like. Read here, before `root`
    // is moved into the walk's queue, and from the cache: `UIA_NativeWindowHandlePropertyId` has
    // been in the standard cache request since ADR-007 P5c-0b, so this costs no extra RPC.
    //
    // Zero is filtered rather than reported: `CachedNativeWindowHandle` answers NULL for an element
    // with no host window, and "no window" and "the window numbered 0" must not arrive as the same
    // value — the consumer treats this as the handle to run the coordinate ladder against.
    //
    // **`as u32`, not `as isize`.** The UIA property is a VT_I4, so a handle with the high bit set
    // comes back sign-extended and `isize` renders it as a NEGATIVE decimal string;
    // `parseWindowHandle` rejects non-positive handles, so exactly those windows would record none
    // and keep the behaviour this item exists to end — invisibly, since a missing handle is
    // indistinguishable from a build that cannot report one (PR 側 codex on #619, P2; my own claim
    // that this road "was already right" was wrong).
    //
    // The low 32 bits are the whole handle — USER handles are 32-bit values sign-extended for
    // interop — so the truncation loses nothing, and it makes the two roads agree: the same window
    // read through Rust and through PowerShell now yields the same string, which two different
    // representations would have quietly broken for merged entities.
    let window_hwnd = unsafe { root.CachedNativeWindowHandle().ok() }
        // `as usize as u32`: HWND is a raw pointer in windows 0.62, so the address is taken first
        // and then truncated to the 32 bits that are the handle.
        .map(|h| h.0 as usize as u32)
        .filter(|h| *h != 0)
        .map(|h| h.to_string());

    // ★ Batch BFS: FindAllBuildCache(TreeScope_Children) per parent.
    // Each RPC fetches all ControlView children of one parent at once.
    // maxElements / maxDepth triggers early exit — no unnecessary RPCs.
    let mut elements: Vec<UiElement> = Vec::with_capacity(max_elements as usize);
    let mut queue: VecDeque<(IUIAutomationElement, u32, Option<String>)> = VecDeque::with_capacity(64);
    // Queue entries: (parent, depth_of_its_children, parent's path).
    // Root's children are at depth 1; the root's own path is empty. A parent whose path could not
    // be written gives its children none, rather than paths that restart at the root (gate 2).
    queue.push_back((root, 1, Some(String::new())));

    'bfs: while let Some((parent, child_depth, parent_path)) = queue.pop_front() {
        if child_depth > max_depth {
            continue;
        }

        // One RPC: fetch ALL ControlView children of this parent.
        let children = unsafe {
            parent.FindAllBuildCache(
                TreeScope_Children,
                &ctx.control_view_condition,
                &ctx.tree_cache_request,
            )
        };
        let arr = match children {
            Ok(a) => a,
            Err(_) => continue,
        };
        let kids: Vec<(IUIAutomationElement, i32)> = if elements.len() < max_elements as usize && is_word_document(&parent) {
            // internal #217 — this Document does not answer `FindAll` with its pages. (A read already
            // at its cap takes one child more at most, so it is not navigated for; gate 2.)
            word_document_children(ctx, &parent)
        } else {
            let count = unsafe { arr.Length() }.unwrap_or(0);
            (0..count).filter_map(|i| unsafe { arr.GetElement(i) }.ok().map(|c| (c, i))).collect()
        };

        for (child, i) in kids {
            // Skip offscreen elements (prune subtree — don't enqueue).
            let is_offscreen = unsafe { child.CachedIsOffscreen() }
                .map(|b| b == true)
                .unwrap_or(true);
            if is_offscreen {
                continue;
            }

            // internal #211 (B) — the index among ALL the parent's ControlView children, offscreen
            // ones included, so a sibling scrolling out of view does not renumber the rest.
            let path = match (&parent_path, unsafe { child.CachedControlType() }) {
                (Some(p), Ok(t)) => Some(format!("{p}/{}[{i}]", control_type_name(t))),
                _ => None,
            };

            if let Ok(mut ui_elem) = extract_element(&child, child_depth, fetch_values) {
                ui_elem.runtime_id = cached_runtime_id(&child);
                ui_elem.path = path.clone();
                elements.push(ui_elem);
            }

            if elements.len() >= max_elements as usize {
                break 'bfs;
            }

            // Enqueue for next-level exploration.
            if child_depth < max_depth {
                queue.push_back((child, child_depth + 1, path));
            }
        }
    }

    Ok(UiElementsResult {
        window_title,
        window_class_name,
        window_hwnd,
        window_rect,
        element_count: elements.len() as u32,
        elements,
    })
}

/// How many children of Word's Document are navigated, whatever is found: one per page, plus a few.
const MAX_WORD_DOCUMENT_CHILDREN: i32 = 2048;

/// Word's document area: a `Document` of class `_WwG`.
fn is_word_document(elem: &IUIAutomationElement) -> bool {
    unsafe {
        elem.CachedControlType().ok() == Some(UIA_DocumentControlTypeId)
            && elem.CachedClassName().ok().is_some_and(|c| c.to_string() == "_WwG")
    }
}

/// internal #217 — the children of Word's Document, by navigation instead of `FindAll`.
///
/// MEASURED win2 (2026-09-30): Word's `_WwG` Document answers `FindAll(Children)` with a 68x68 Pane
/// alone, while `ControlViewWalker` navigation returns the Pane and one `Custom` per page, under
/// which `FindAll` works again (the page's `Edit` body). Across Notepad, Explorer, Calculator,
/// Chrome, an Edge PDF, VS Code, Excel and PowerPoint no parent disagreed. So only this Document is
/// navigated, and its children come from navigation alone: one list, one index space (an earlier
/// version merged the two lists for every Document, and each gate round found another way for the
/// merge to double or misnumber a child).
///
/// A long document has one `Custom` per page, all but the visible ones offscreen and pruned by the
/// walk: navigating every page cost 3–4x the read on 34 pages. So once a page has been onscreen, the
/// next offscreen page ends the list. Only pages count: the Pane that comes first is onscreen (gate 2).
/// An `IsOffscreen` that cannot be read neither starts nor stops anything. Pages scrolled past above
/// the visible one are navigated, one RPC each, up to `MAX_WORD_DOCUMENT_CHILDREN` children.
///
/// Not applied in `get_element_children`, nor on the PowerShell road, which reads to depth 4 and never
/// reaches a page body (depth 5).
fn word_document_children(ctx: &UiaContext, parent: &IUIAutomationElement) -> Vec<(IUIAutomationElement, i32)> {
    let mut kids = Vec::new();
    let mut next = unsafe { ctx.walker.GetFirstChildElementBuildCache(parent, &ctx.tree_cache_request) }.ok();
    let mut index: i32 = 0;
    let mut page_seen_on_screen = false;
    while let Some(child) = next {
        if index >= MAX_WORD_DOCUMENT_CHILDREN {
            break;
        }
        if unsafe { child.CachedControlType() }.ok() == Some(UIA_CustomControlTypeId) {
            match unsafe { child.CachedIsOffscreen() }.ok().map(|b| b == true) {
                Some(true) if page_seen_on_screen => break,
                Some(false) => page_seen_on_screen = true,
                _ => {}
            }
        }
        next = unsafe { ctx.walker.GetNextSiblingElementBuildCache(&child, &ctx.tree_cache_request) }.ok();
        kids.push((child, index));
        index += 1;
    }
    kids
}

// ─── Window finding ──────────────────────────────────────────────────────────

/// ADR-036 — the window this call is about: the handle when the caller named one, otherwise the
/// first top-level window whose name contains the title.
///
/// Both roads return an element with the cache already populated, because everything downstream
/// reads `Cached*`; an element straight from `ElementFromHandle` has an empty cache and would
/// answer `CachedName()` with an error rather than a name.
pub(crate) fn resolve_root(
    ctx: &UiaContext,
    hwnd: Option<&str>,
    title: &str,
) -> napi::Result<IUIAutomationElement> {
    match hwnd {
        Some(h) => element_from_handle(ctx, h),
        None => find_window(ctx, title),
    }
}

/// Resolve a decimal window handle to its element, with the cache built.
///
/// The handle is a string on the wire for the same reason `ScrollByWheelAtHwndOptions.hwnd` is:
/// a Win32 handle does not fit a JS number, and napi's BigInt crossing is more ceremony than a
/// decimal string that both sides already agree on.
pub(crate) fn element_from_handle(
    ctx: &UiaContext,
    hwnd: &str,
) -> napi::Result<IUIAutomationElement> {
    let raw: i64 = hwnd
        .parse()
        .map_err(|e| napi::Error::from_reason(format!("hwnd parse error: {e}")))?;
    if raw <= 0 {
        // Zero is not a window and -1 is INVALID_HANDLE_VALUE; the TS side rejects both before
        // it gets here (`parseTargetHwnd`), and this is the same answer from the other end.
        return Err(napi::Error::from_reason(format!(
            "Window not found by hwnd: {hwnd}"
        )));
    }
    let handle = HWND(raw as *mut std::ffi::c_void);
    unsafe {
        let elem = ctx
            .automation
            .ElementFromHandle(handle)
            .map_err(|_| napi::Error::from_reason(format!("Window not found by hwnd: {hwnd}")))?;
        // ADR-036 — the cache build is a SEPARATE failure, and it must not be called a window that
        // went away. `ElementFromHandle` refusing the handle means the window is not there; a
        // provider or RPC fault inside `BuildUpdatedCache` happens to a window that is perfectly
        // alive, and telling the caller it vanished sends it to re-discover instead of to retry
        // (PR 側 codex, P2 on #631). The `CACHE_BUILD_FAILED_PREFIX` is how the two arrive apart;
        // it is produced and consumed in this crate only, so no caller parses a backend's words.
        elem.BuildUpdatedCache(&ctx.cache_request)
            .map_err(|e| napi::Error::from_reason(format!("{CACHE_BUILD_FAILED_PREFIX}{e}")))
    }
}

/// Marks a `resolve_root` failure that happened AFTER the window was found — see
/// [`element_from_handle`]. `actions.rs` reads it to decide whether the answer may carry
/// `aim_window_gone`.
pub(crate) const CACHE_BUILD_FAILED_PREFIX: &str = "UIA cache build failed: ";

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
        // ADR-036 family 2 — the element's own window, when it is one. Same reading and same width as
        // the window's handle in `get_elements` (`as usize as u32`, zero dropped), so the two roads
        // and the keyboard rung's receiver compare as the same string. The property is in the cache
        // request already, so this costs no RPC.
        // ADR-036 `internal#118` — the three cases are kept apart HERE, where they happen. `.ok()`
        // folded a failed read and `filter(!= 0)` folded a zero into one `None`, and the rule that
        // refuses `other_control` is decided from that `None` alone.
        let raw_native_window_handle = elem.CachedNativeWindowHandle().ok().map(|h| h.0 as usize as u32);
        let native_window_handle_read = match raw_native_window_handle {
            None => "failed",
            Some(0) => "zero",
            Some(_) => "value",
        }
        .to_string();
        let native_window_handle = raw_native_window_handle
            .filter(|h| *h != 0)
            .map(|h| h.to_string());

        // internal #211 (C) — asked of a `Window` only: win2 measured `true` on the four real modals
        // (a Win32 save dialog, a MessageBox, WinForms and WPF `ShowDialog`) and `false` on a
        // modeless Find/Replace and on ordinary windows (S6, 2026-09-29). Anything that does not
        // answer stays `None`. Read live, one call per `Window`, and NOT through the shared cache
        // request: that request also serves every element of every walk and the focus-event
        // delivery thread's slow-path budget, which would each pay for a pattern almost none of
        // them have (gate 2).
        let is_modal = if control_type_id == UIA_WindowControlTypeId {
            elem.GetCurrentPattern(UIA_WindowPatternId)
                .ok()
                .and_then(|p| p.cast::<IUIAutomationWindowPattern>().ok())
                .and_then(|w| w.CurrentIsModal().ok())
                .map(|b| b.as_bool())
        } else {
            None
        };

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
            native_window_handle,
            native_window_handle_read,
            is_modal,
            runtime_id: None,
            path: None,
        })
    }
}

/// internal #211 (B) — the element's cached `RuntimeId` as `a.b.c`. Only the element read's tree walk
/// caches it (`tree_cache_request`); elsewhere the property is not cached and this answers `None`.
fn cached_runtime_id(elem: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let mut v = elem.GetCachedPropertyValue(UIA_RuntimeIdPropertyId).ok()?;
        let read = runtime_id_from_variant(&v);
        // The Win32 VARIANT has no Drop; the array it holds is freed here.
        let _ = VariantClear(&mut v);
        read
    }
}

/// A `VT_ARRAY | VT_I4` VARIANT's integers joined by `.`; `None` for anything else.
///
/// # Safety
/// `v` must be a VARIANT UIA returned, not yet cleared.
unsafe fn runtime_id_from_variant(v: &VARIANT) -> Option<String> {
    unsafe {
        let inner = &v.Anonymous.Anonymous;
        if inner.vt != VARENUM(VT_ARRAY.0 | VT_I4.0) {
            return None;
        }
        let psa = inner.Anonymous.parray;
        if psa.is_null() {
            return None;
        }
        let sa = &*psa;
        let n = sa.rgsabound[0].cElements as usize;
        if sa.cDims != 1 || n == 0 || sa.pvData.is_null() {
            return None;
        }
        let ids = std::slice::from_raw_parts(sa.pvData as *const i32, n);
        Some(ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join("."))
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

    let elem = match super::actions::find_element_in_window(
        ctx,
        &window,
        opts.name.as_deref(),
        opts.automation_id.as_deref(),
        opts.control_type.as_deref(),
    ) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    // Read live properties (not cached — the element came from `find_element_in_window`, which may
    // have fetched it with cache, but we need current state for bounds).
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

    let target = super::actions::find_element_in_window(
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
