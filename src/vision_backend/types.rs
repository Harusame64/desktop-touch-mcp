//! Shared types for the visual GPU backend (Rust ↔ Node FFI surface).
//!
//! All structs marked `#[napi(object)]` are exposed to TypeScript directly.
//! See `src/engine/vision-gpu/types.ts` for the corresponding TS types — the
//! shape of these structs determines what TypeScript sees.

use napi_derive::napi;

/// Screen-absolute rectangle in physical pixels.
///
/// Same shape as `src/duplication/types.rs::DirtyRect` and TS `Rect`
/// (`src/engine/vision-gpu/types.ts:1`). Re-declared here rather than imported
/// because napi-rs requires `#[napi(object)]` on the same crate boundary.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// One ROI handed to the backend by the DirtyRectRouter.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RoiInput {
    /// Stable track id from TrackStore — used as `RawCandidate.track_id`.
    pub track_id: String,
    /// Screen-absolute rect in physical pixels.
    pub rect: Rect,
    /// Optional class hint from upstream (e.g. UIA "Button"). Backend may
    /// override based on visual evidence.
    pub class_hint: Option<String>,
}

/// Request payload for `recognize_rois`.
///
/// In Phase 4a the `frame_buffer` is not yet used (dummy implementation).
/// In Phase 4b it will hold the captured DXGI frame as RGBA bytes (zero-copy
/// from the napi `Buffer`).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RecognizeRequest {
    /// Stable target key (`window:{hwnd}` / `tab:{tabId}` / `title:{title}`).
    pub target_key: String,
    /// Session key from `init_session_blocking`. Empty string → legacy dummy path
    /// (kept for Phase 4a backward-compat with tests / PocVisualBackend migration).
    pub session_key: String,
    /// ROIs to recognize.
    pub rois: Vec<RoiInput>,
    /// Captured frame width in pixels (for ROI clipping). 0 in Phase 4a.
    pub frame_width: u32,
    /// Captured frame height in pixels. 0 in Phase 4a.
    pub frame_height: u32,
    /// Frame timestamp (ms since epoch).
    pub now_ms: f64,
}

/// One recognized candidate emitted by the backend.
///
/// Maps 1-to-1 to `UiEntityCandidate` on the TS side
/// (`src/engine/vision-gpu/types.ts:42`). The TS `OnnxBackend` wraps these
/// into `UiEntityCandidate` and feeds `CandidateProducer.ingest`.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RawCandidate {
    /// Stable trackId echoed back from `RoiInput.track_id`.
    pub track_id: String,
    /// Screen-absolute rect (may shrink relative to the input ROI if the
    /// detector tightens the box).
    pub rect: Rect,
    /// Recognized text label. Empty string when class is "icon" or detection
    /// found a UI element without text content.
    pub label: String,
    /// Visual class assigned by the detector: "text" | "icon" | "mixed" |
    /// "button" | "checkbox" | "radio" | "dropdown" | "slider" | "tab" |
    /// "label" | "image" | "title" | "other"
    /// (matches D6' DSL short codes and resolver normalisation rules)
    pub class: String,
    /// Aggregated confidence 0.0..1.0.
    pub confidence: f64,
    /// True while the detector is still accumulating evidence (TemporalFusion
    /// hasn't committed). Resolver must not issue a lease for provisional.
    pub provisional: bool,
}

// ── Phase 4b-1: EP cascade types ─────────────────────────────────────────────

/// Final EP that the cascade settled on. Echoed back to TS for diagnostics.
/// String form (used in NativeSessionResult): "WinML" | "DirectML(0)" |
/// "ROCm(0)" | "CUDA(0)" | "WebGPU" | "WebGPU(adapter)" | "CPU" |
/// "Fallback(reason)"
#[derive(Debug, Clone)]
pub enum SelectedEp {
    WinML,
    DirectML { device_id: u32 },
    Rocm { device_id: u32 },
    Cuda { device_id: u32 },
    /// Phase 4b-3: ort WebGPU EP (wgpu backed — Vulkan / DX12 / Metal). Vendor-neutral Layer 3 lane.
    /// `adapter` is wgpu's physical adapter name when known, empty string otherwise.
    WebGPU { adapter: String },
    Cpu,
    /// All preferred EPs failed; reason is the concatenated error chain.
    Fallback(String),
}

impl SelectedEp {
    pub fn as_label(&self) -> String {
        match self {
            Self::WinML => "WinML".into(),
            Self::DirectML { device_id } => format!("DirectML({device_id})"),
            Self::Rocm { device_id } => format!("ROCm({device_id})"),
            Self::Cuda { device_id } => format!("CUDA({device_id})"),
            Self::WebGPU { adapter } if adapter.is_empty() => "WebGPU".into(),
            Self::WebGPU { adapter } => format!("WebGPU({adapter})"),
            Self::Cpu => "CPU".into(),
            Self::Fallback(r) => format!("Fallback({r})"),
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSessionInit {
    /// Absolute path to the .onnx file to load.
    pub model_path: String,
    /// CapabilityProfile produced by detect_capability().
    pub profile: crate::vision_backend::capability::CapabilityProfile,
    /// Optional: stable session key used to look up the session later
    /// (e.g. "ui_detector:dml-fp16"). Empty string for ad-hoc sessions.
    pub session_key: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSessionResult {
    pub ok: bool,
    /// Set when `ok == true`. SelectedEp.as_label() format.
    pub selected_ep: String,
    /// Set when `ok == false`. Concatenated cascade attempt errors.
    pub error: Option<String>,
    /// Set when `ok == true`. Echoed `session_key` (caller can use it as
    /// the lookup key for subsequent recognize_rois calls in 4b-4+).
    pub session_key: String,
}
