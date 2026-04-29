//! Focused element and element-at-point queries.
//!
//! Mirrors `getFocusedAndPointInfo` and `getFocusedElement` in `uia-bridge.ts`.

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext};
use super::types::*;
use super::control_type_name;

// Re-export the cache-only helper so other modules in `uia/` (notably
// the P5c-1 event handler module to be added) can build the L1 emit
// payload without re-implementing the cached property read.
pub(crate) use cached_focus_info::cached_element_to_focus_info;

// ─── Timeout defaults (per design doc §2.4) ─────────────────────────────────

const FOCUS_AND_POINT_TIMEOUT_MS: u32 = 2_000;
const FOCUSED_ELEMENT_TIMEOUT_MS: u32 = 500;

// ─── Options from JS ────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct GetFocusAndPointOptions {
    pub cursor_x: i32,
    pub cursor_y: i32,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Exposed as `uiaGetFocusedAndPoint`.
pub fn get_focused_and_point(opts: GetFocusAndPointOptions) -> napi::Result<FocusAndPointResult> {
    thread::execute_with_timeout(
        move |ctx| get_focused_and_point_impl(ctx, opts.cursor_x, opts.cursor_y),
        FOCUS_AND_POINT_TIMEOUT_MS,
    )
}

/// Exposed as `uiaGetFocusedElement`.
pub fn get_focused_element() -> napi::Result<Option<UiaFocusInfo>> {
    thread::execute_with_timeout(
        |ctx| Ok(focused_element_info(ctx)),
        FOCUSED_ELEMENT_TIMEOUT_MS,
    )
}

// ─── Implementation ──────────────────────────────────────────────────────────

fn get_focused_and_point_impl(
    ctx: &UiaContext,
    cursor_x: i32,
    cursor_y: i32,
) -> napi::Result<FocusAndPointResult> {
    let focused = focused_element_info(ctx);
    let at_point = element_at_point(ctx, cursor_x, cursor_y);

    Ok(FocusAndPointResult { focused, at_point })
}

/// Get info about the currently focused element.
fn focused_element_info(ctx: &UiaContext) -> Option<UiaFocusInfo> {
    let elem = unsafe { ctx.automation.GetFocusedElement().ok()? };
    // Normalise into control-view (skip raw internal elements).
    let normalised = unsafe {
        ctx.walker
            .NormalizeElementBuildCache(&elem, &ctx.cache_request)
            .ok()?
    };
    element_to_focus_info(&normalised)
}

/// Get info about the element under the cursor.
fn element_at_point(ctx: &UiaContext, x: i32, y: i32) -> Option<UiaFocusInfo> {
    let pt = POINT { x, y };
    let elem = unsafe { ctx.automation.ElementFromPoint(pt).ok()? };
    let normalised = unsafe {
        ctx.walker
            .NormalizeElementBuildCache(&elem, &ctx.cache_request)
            .ok()?
    };
    element_to_focus_info(&normalised)
}

/// Extract `UiaFocusInfo` from a cached element.
fn element_to_focus_info(elem: &IUIAutomationElement) -> Option<UiaFocusInfo> {
    unsafe {
        let name = elem.CachedName().ok()?.to_string();
        let ct = elem.CachedControlType().ok()?;
        let control_type = control_type_name(ct).to_string();
        let automation_id = elem.CachedAutomationId().ok().map(|b| b.to_string());

        // Attempt to read value via ValuePattern (live call).
        let value = {
            let pat = elem.GetCurrentPattern(UIA_ValuePatternId).ok();
            pat.and_then(|p| {
                let vp: IUIAutomationValuePattern = p.cast().ok()?;
                vp.CurrentValue().ok().map(|b| b.to_string())
            })
        };

        Some(UiaFocusInfo {
            name,
            control_type,
            automation_id,
            value,
        })
    }
}

// ─── Cache-only helper (ADR-007 P5c-0b) ──────────────────────────────────────
//
// Used by the P5c-1 UIA Focus Changed event handler to build the L1 emit
// payload from inside the UIA delivery thread. Distinct from
// `element_to_focus_info` above because:
//   - This helper must never invoke a live UIA call (the delivery thread
//     has a tight latency budget and a slow path crashes the
//     UiaCacheRequest hit-rate acceptance in P5c plan §11.3 / R5).
//   - The L1 payload uses raw `u32` `UIA_CONTROLTYPE_ID`, not the string
//     mapping that `UiaFocusInfo` exposes via napi.
//   - The cached `NativeWindowHandle` is required so the bridge in
//     `src/l3_bridge/` can populate `FocusEvent.hwnd` for the
//     `current_focused_element` view.
mod cached_focus_info {
    use super::*;
    use windows::Win32::UI::Accessibility::IUIAutomationElement;

    /// Build a [`UiaFocusInfoExt`] from cached properties only.
    ///
    /// Requires the cache request used to fetch `elem` to include
    /// `UIA_NativeWindowHandlePropertyId` (added to
    /// `configure_cache_properties` in P5c-0b). Returns `None` only when
    /// the element has no cached `Name` (rare; transient internal element).
    /// `hwnd == 0` is a valid result — caller must handle the unresolved
    /// case (P5c plan §4 P5c-0b).
    #[allow(dead_code)] // first caller is the P5c-1 UIA Focus Changed handler
    pub(crate) fn cached_element_to_focus_info(
        elem: &IUIAutomationElement,
    ) -> Option<UiaFocusInfoExt> {
        unsafe {
            let name = elem.CachedName().ok()?.to_string();
            let control_type = elem.CachedControlType().ok()?.0 as u32;
            let automation_id = elem
                .CachedAutomationId()
                .ok()
                .map(|b| b.to_string())
                .filter(|s| !s.is_empty());
            // `CachedNativeWindowHandle` returns the element's host HWND or
            // NULL for non-window elements. We don't walk to a parent here:
            // that would cost another UIA call (even cached traversal can
            // fault to live when the cache root doesn't cover the parent).
            // The bridge handles `hwnd == 0` explicitly.
            let hwnd = elem
                .CachedNativeWindowHandle()
                .ok()
                .map(|h| h.0 as u64)
                .unwrap_or(0);

            Some(UiaFocusInfoExt {
                hwnd,
                name,
                control_type,
                automation_id,
            })
        }
    }
}
