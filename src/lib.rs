#![deny(clippy::all)]

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;

mod pixel_diff;
mod dhash;
mod image_processing;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
pub mod duplication;

// Visual GPU Phase 4 backend (ADR-005). The module always compiles so that
// `detect_capability()` can report `backend_built=false` cleanly when the
// `vision-gpu` cargo feature is disabled. The actual ort-backed inference
// path inside this module is feature-gated where it touches `ort` symbols.
#[cfg(feature = "vision-gpu")]
pub mod vision_backend;

/// Block-based pixel comparison.
/// Returns the fraction of changed blocks (0.0–1.0).
///
/// Mirrors the TypeScript `computeChangeFraction` in layer-buffer.ts:
///   - Divides the image into 8×8 blocks
///   - Averages the per-channel absolute difference in each block
///   - Counts blocks where the average exceeds the noise threshold (16)
#[napi]
pub fn compute_change_fraction(
    prev: Buffer,
    curr: Buffer,
    width: u32,
    height: u32,
    channels: u32,
) -> Result<f64> {
    pixel_diff::compute_change_fraction(&prev, &curr, width, height, channels)
}

/// Compute a 64-bit difference hash (dHash) from raw RGB/RGBA pixels.
///
/// 1. Convert to grayscale via BT.601 luminance
/// 2. Resize to 9×8 using bilinear interpolation
/// 3. Row-major horizontal comparison → 64-bit hash
///
/// Returns a BigInt (u64 serialised).
#[napi]
pub fn dhash_from_raw(
    raw: Buffer,
    width: u32,
    height: u32,
    channels: u32,
) -> Result<BigInt> {
    let hash = dhash::dhash_from_raw(&raw, width, height, channels)?;
    Ok(BigInt::from(hash))
}

/// Hamming distance between two 64-bit dHash values.
///
/// `BigInt::get_u128()` returns `(sign_bit, value, lossless)`. dHash values are
/// produced by `dhash_from_raw` as non-negative u64, so both the sign bit and
/// the lossless flag are intentionally discarded — we only need the low 64 bits.
#[napi]
pub fn hamming_distance(a: BigInt, b: BigInt) -> Result<u32> {
    let (_sign, a_val, _lossless) = a.get_u128();
    let (_sign, b_val, _lossless) = b.get_u128();
    let a64 = a_val as u64;
    let b64 = b_val as u64;
    Ok((a64 ^ b64).count_ones())
}

// ─── UIA (Windows-only) ─────────────────────────────────────────────────────

// AsyncTask wrappers: compute() runs on a libuv worker thread (safe to block),
// resolve() runs on V8 main thread (just passes through the result).

#[cfg(windows)]
pub struct UiaGetElementsTask(uia::tree::GetElementsOptions);

#[cfg(windows)]
impl Task for UiaGetElementsTask {
    type Output = uia::types::UiElementsResult;
    type JsValue = uia::types::UiElementsResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::tree::get_elements(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetFocusedAndPointTask(uia::focus::GetFocusAndPointOptions);

#[cfg(windows)]
impl Task for UiaGetFocusedAndPointTask {
    type Output = uia::types::FocusAndPointResult;
    type JsValue = uia::types::FocusAndPointResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::focus::get_focused_and_point(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetFocusedElementTask;

#[cfg(windows)]
impl Task for UiaGetFocusedElementTask {
    type Output = Option<uia::types::UiaFocusInfo>;
    type JsValue = Option<uia::types::UiaFocusInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::focus::get_focused_element()
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Enumerate UI elements of a window by title (substring match).
/// Returns a Promise — compute runs on a libuv worker thread.
#[cfg(windows)]
#[napi]
pub fn uia_get_elements(opts: uia::tree::GetElementsOptions) -> AsyncTask<UiaGetElementsTask> {
    AsyncTask::new(UiaGetElementsTask(opts))
}

/// Get focused element info + element under cursor.
#[cfg(windows)]
#[napi]
pub fn uia_get_focused_and_point(
    opts: uia::focus::GetFocusAndPointOptions,
) -> AsyncTask<UiaGetFocusedAndPointTask> {
    AsyncTask::new(UiaGetFocusedAndPointTask(opts))
}

/// Get currently focused element info.
#[cfg(windows)]
#[napi]
pub fn uia_get_focused_element() -> AsyncTask<UiaGetFocusedElementTask> {
    AsyncTask::new(UiaGetFocusedElementTask)
}

// ─── Scroll ─────────────────────────────────────────────────────────────────

#[cfg(windows)]
pub struct UiaScrollIntoViewTask(uia::scroll::ScrollIntoViewOptions);

#[cfg(windows)]
impl Task for UiaScrollIntoViewTask {
    type Output = uia::types::ScrollResult;
    type JsValue = uia::types::ScrollResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::scroll::scroll_into_view(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetScrollAncestorsTask(uia::scroll::ScrollAncestorsOptions);

#[cfg(windows)]
impl Task for UiaGetScrollAncestorsTask {
    type Output = Vec<uia::types::ScrollAncestor>;
    type JsValue = Vec<uia::types::ScrollAncestor>;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::scroll::get_scroll_ancestors(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaScrollByPercentTask(uia::scroll::ScrollByPercentOptions);

#[cfg(windows)]
impl Task for UiaScrollByPercentTask {
    type Output = uia::types::ScrollResult;
    type JsValue = uia::types::ScrollResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::scroll::scroll_by_percent(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetVirtualDesktopStatusTask(Vec<String>);

#[cfg(windows)]
impl Task for UiaGetVirtualDesktopStatusTask {
    type Output = HashMap<String, bool>;
    type JsValue = HashMap<String, bool>;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::vdesktop::get_virtual_desktop_status(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Scroll an element into view via ScrollItemPattern.
#[cfg(windows)]
#[napi]
pub fn uia_scroll_into_view(
    opts: uia::scroll::ScrollIntoViewOptions,
) -> AsyncTask<UiaScrollIntoViewTask> {
    AsyncTask::new(UiaScrollIntoViewTask(opts))
}

/// Walk the UIA tree upward from an element, collecting ScrollPattern ancestors.
#[cfg(windows)]
#[napi]
pub fn uia_get_scroll_ancestors(
    opts: uia::scroll::ScrollAncestorsOptions,
) -> AsyncTask<UiaGetScrollAncestorsTask> {
    AsyncTask::new(UiaGetScrollAncestorsTask(opts))
}

/// Set scroll position of the nearest ScrollPattern ancestor.
#[cfg(windows)]
#[napi]
pub fn uia_scroll_by_percent(
    opts: uia::scroll::ScrollByPercentOptions,
) -> AsyncTask<UiaScrollByPercentTask> {
    AsyncTask::new(UiaScrollByPercentTask(opts))
}

/// Query which HWNDs are on the current virtual desktop.
#[cfg(windows)]
#[napi]
pub fn uia_get_virtual_desktop_status(
    hwnd_integers: Vec<String>,
) -> AsyncTask<UiaGetVirtualDesktopStatusTask> {
    AsyncTask::new(UiaGetVirtualDesktopStatusTask(hwnd_integers))
}

// ─── Phase C: Actions ───────────────────────────────────────────────────────

#[cfg(windows)]
pub struct UiaClickElementTask(uia::actions::ClickElementOptions);

#[cfg(windows)]
impl Task for UiaClickElementTask {
    type Output = uia::types::ActionResult;
    type JsValue = uia::types::ActionResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::actions::click_element(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaSetValueTask(uia::actions::SetValueOptions);

#[cfg(windows)]
impl Task for UiaSetValueTask {
    type Output = uia::types::ActionResult;
    type JsValue = uia::types::ActionResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::actions::set_value(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaInsertTextTask(uia::actions::InsertTextOptions);

#[cfg(windows)]
impl Task for UiaInsertTextTask {
    type Output = uia::types::ActionResult;
    type JsValue = uia::types::ActionResult;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::actions::insert_text(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetElementBoundsTask(uia::tree::GetElementBoundsOptions);

#[cfg(windows)]
impl Task for UiaGetElementBoundsTask {
    type Output = Option<uia::types::ElementBounds>;
    type JsValue = Option<uia::types::ElementBounds>;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::tree::get_element_bounds(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetElementChildrenTask(uia::tree::GetElementChildrenOptions);

#[cfg(windows)]
impl Task for UiaGetElementChildrenTask {
    type Output = Vec<uia::types::UiElement>;
    type JsValue = Vec<uia::types::UiElement>;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::tree::get_element_children(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(windows)]
pub struct UiaGetTextViaTextPatternTask(uia::text::GetTextOptions);

#[cfg(windows)]
impl Task for UiaGetTextViaTextPatternTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> Result<Self::Output> {
        uia::text::get_text_via_text_pattern(self.0.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Invoke a UI element via InvokePattern.
#[cfg(windows)]
#[napi]
pub fn uia_click_element(
    opts: uia::actions::ClickElementOptions,
) -> AsyncTask<UiaClickElementTask> {
    AsyncTask::new(UiaClickElementTask(opts))
}

/// Set a UI element's value via ValuePattern.
#[cfg(windows)]
#[napi]
pub fn uia_set_value(
    opts: uia::actions::SetValueOptions,
) -> AsyncTask<UiaSetValueTask> {
    AsyncTask::new(UiaSetValueTask(opts))
}

/// Insert text via TextPattern2.
#[cfg(windows)]
#[napi]
pub fn uia_insert_text(
    opts: uia::actions::InsertTextOptions,
) -> AsyncTask<UiaInsertTextTask> {
    AsyncTask::new(UiaInsertTextTask(opts))
}

/// Find an element and return its bounding rectangle + properties.
#[cfg(windows)]
#[napi]
pub fn uia_get_element_bounds(
    opts: uia::tree::GetElementBoundsOptions,
) -> AsyncTask<UiaGetElementBoundsTask> {
    AsyncTask::new(UiaGetElementBoundsTask(opts))
}

/// Get children of a specific element (subtree walk).
#[cfg(windows)]
#[napi]
pub fn uia_get_element_children(
    opts: uia::tree::GetElementChildrenOptions,
) -> AsyncTask<UiaGetElementChildrenTask> {
    AsyncTask::new(UiaGetElementChildrenTask(opts))
}

/// Extract text from the best TextPattern element in a window.
#[cfg(windows)]
#[napi]
pub fn uia_get_text_via_text_pattern(
    opts: uia::text::GetTextOptions,
) -> AsyncTask<UiaGetTextViaTextPatternTask> {
    AsyncTask::new(UiaGetTextViaTextPatternTask(opts))
}

// ─── Image pre-processing (Hybrid Non-CDP pipeline — Step 2) ────────────────

pub struct PreprocessImageTask(image_processing::PreprocessOptions);

impl Task for PreprocessImageTask {
    type Output = image_processing::ImageProcessingResult;
    type JsValue = image_processing::ImageProcessingResult;

    fn compute(&mut self) -> Result<Self::Output> {
        // PreprocessOptions contains a Buffer; we need to take it out of &mut self.
        // Swap with a dummy to avoid partial-move issues in the compute() signature.
        let dummy = image_processing::PreprocessOptions {
            data: Buffer::from(vec![]),
            width: 0,
            height: 0,
            channels: 3,
            scale: 2,
            adaptive: None,
        };
        let opts = std::mem::replace(&mut self.0, dummy);
        image_processing::upscale_grayscale_contrast(opts)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Preprocess a raw RGB/RGBA screenshot buffer for OCR:
/// upscale (2× or 3×), convert to grayscale, and apply contrast enhancement.
///
/// Returns a Promise resolving to `{ data: Buffer, width, height, channels: 1 }`.
/// Runs on a libuv worker thread — does not block the event loop.
#[napi]
pub fn preprocess_image(
    opts: image_processing::PreprocessOptions,
) -> AsyncTask<PreprocessImageTask> {
    AsyncTask::new(PreprocessImageTask(opts))
}

// ─── Set-of-Mark label rendering (Hybrid Non-CDP pipeline — Step 4) ─────────

pub struct DrawSomLabelsTask(image_processing::DrawSomLabelsOptions);

impl Task for DrawSomLabelsTask {
    type Output = image_processing::DrawSomLabelsResult;
    type JsValue = image_processing::DrawSomLabelsResult;

    fn compute(&mut self) -> Result<Self::Output> {
        // `DrawSomLabelsOptions` contains a Buffer and a Vec — swap to move out.
        let dummy = image_processing::DrawSomLabelsOptions {
            data: Buffer::from(vec![]),
            width: 0,
            height: 0,
            channels: 3,
            labels: vec![],
        };
        let opts = std::mem::replace(&mut self.0, dummy);
        image_processing::draw_som_labels_impl(opts)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Render Set-of-Mark bounding boxes and ID badges onto a raw RGB/RGBA buffer.
///
/// For each label `{ id, x, y, width, height }`, draws a 2px red rectangle
/// outline and a white badge with a black digit ID at the top-left corner.
/// Uses a hardcoded 5×7 bitmap font — no external image crates required.
///
/// Returns a Promise resolving to `{ data: Buffer, width, height, channels }`.
/// Runs on a libuv worker thread — does not block the event loop.
#[napi]
pub fn draw_som_labels(
    opts: image_processing::DrawSomLabelsOptions,
) -> AsyncTask<DrawSomLabelsTask> {
    AsyncTask::new(DrawSomLabelsTask(opts))
}

// ─── Visual GPU backend (ADR-005 Phase 4a) ─────────────────────────────────
//
// `recognize_rois` runs the ROI → candidate inference path in a libuv worker
// thread. Phase 4a delivers the wiring with a dummy detector; Phase 4b will
// swap in real ort::Session calls without touching the FFI surface.
//
// `detect_capability` is exported via `vision_backend::capability` itself.

#[cfg(feature = "vision-gpu")]
pub struct VisionRecognizeTask(vision_backend::RecognizeRequest);

#[cfg(feature = "vision-gpu")]
impl Task for VisionRecognizeTask {
    type Output = Vec<vision_backend::RawCandidate>;
    type JsValue = Vec<vision_backend::RawCandidate>;

    fn compute(&mut self) -> Result<Self::Output> {
        // Move req out of self to call the blocking entry point. Use a
        // sentinel placeholder (mirrors PreprocessImageTask in this file).
        let placeholder = vision_backend::RecognizeRequest {
            target_key: String::new(),
            rois: Vec::new(),
            frame_width: 0,
            frame_height: 0,
            now_ms: 0.0,
        };
        let req = std::mem::replace(&mut self.0, placeholder);
        vision_backend::recognize_rois_blocking(req).map_err(Into::into)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Recognise UI elements inside the given ROIs. Returns a Promise resolving
/// to `RawCandidate[]`. Panics inside inference are caught and surfaced as a
/// rejected Promise — the MCP server never crashes (L5).
///
/// Phase 4a: dummy implementation, one RawCandidate per input ROI with
/// `provisional: true` and empty label.
#[cfg(feature = "vision-gpu")]
#[napi]
pub fn vision_recognize_rois(
    req: vision_backend::RecognizeRequest,
) -> AsyncTask<VisionRecognizeTask> {
    AsyncTask::new(VisionRecognizeTask(req))
}

/// Stub for builds without the `vision-gpu` feature: surfaces a profile
/// where `backendBuilt: false` so TS callers can short-circuit.
#[cfg(not(feature = "vision-gpu"))]
#[napi(object)]
pub struct CapabilityProfile {
    pub backend_built: bool,
}

#[cfg(not(feature = "vision-gpu"))]
#[napi]
pub fn detect_capability() -> CapabilityProfile {
    CapabilityProfile { backend_built: false }
}
