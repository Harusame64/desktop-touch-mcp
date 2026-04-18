//! Shared type definitions for UIA ↔ JS interop.
//!
//! All structs use `#[napi(object)]` so napi-rs maps them directly to V8
//! objects — no JSON intermediate representation.

use napi_derive::napi;

// ─── Element tree ────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BoundingRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct UiElement {
    pub name: String,
    pub control_type: String,
    pub automation_id: String,
    pub class_name: Option<String>,
    pub is_enabled: bool,
    pub bounding_rect: Option<BoundingRect>,
    pub patterns: Vec<String>,
    pub depth: u32,
    pub value: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct UiElementsResult {
    pub window_title: String,
    pub window_class_name: Option<String>,
    pub window_rect: Option<BoundingRect>,
    pub element_count: u32,
    pub elements: Vec<UiElement>,
}

// ─── Scroll ─────────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollResult {
    pub ok: bool,
    pub scrolled: bool,
    pub error: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollAncestor {
    pub name: String,
    pub automation_id: String,
    pub control_type: String,
    pub vertical_percent: f64,
    pub horizontal_percent: f64,
    pub vertically_scrollable: bool,
    pub horizontally_scrollable: bool,
}

// ─── Focus / point ───────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct UiaFocusInfo {
    pub name: String,
    pub control_type: String,
    pub automation_id: Option<String>,
    pub value: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FocusAndPointResult {
    pub focused: Option<UiaFocusInfo>,
    pub at_point: Option<UiaFocusInfo>,
}

// ─── Actions ─────────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ActionResult {
    pub ok: bool,
    pub element: Option<String>,
    pub error: Option<String>,
    pub code: Option<String>,
}

// ─── Element bounds ──────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ElementBounds {
    pub name: String,
    pub control_type: String,
    pub automation_id: String,
    pub bounding_rect: Option<BoundingRect>,
    pub value: Option<String>,
}
