//! Focused element and element-at-point queries.
//!
//! Mirrors `getFocusedAndPointInfo` and `getFocusedElement` in `uia-bridge.ts`.

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext};
use super::types::*;
use super::control_type_name;

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
