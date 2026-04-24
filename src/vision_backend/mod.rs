//! Visual GPU Phase 4 backend (ADR-005).
//!
//! Architecture (ADR-005 §4):
//!   DXGI dirty rects → DirtyRectRouter → recognize_rois (this module)
//!     → ort::Session (EP cascade: WinML → DirectML → ROCm → Vulkan(ncnn) → CPU)
//!     → Vec<RawCandidate> → napi AsyncTask resolve → TS OnnxBackend
//!     → CandidateProducer.ingest → pushDirtySignal → visual-provider
//!
//! Phase 4a scope (this commit):
//!   - Module skeleton + dummy `recognize_rois` (pixel mean → text class)
//!   - Capability detection (DXGI / WinML / ROCm / NVIDIA / CPUID)
//!   - panic isolation via std::panic::catch_unwind
//!   - Real ort::Session lifecycle is wired but with no model loaded yet
//!     (that comes in Phase 4b when the model registry has actual weights)
//!
//! Phase 4b scope (later commit):
//!   - Real model load from registry (WinML/DirectML/Vulkan/CPU variant by capability)
//!   - Multi-stage detector (Florence-2 → OmniParser-v2 → PaddleOCR-v4)
//!   - Cross-engine voting (D3' cross-check)
//!
//! ## Why a Rust-internal backend (D1')
//! - Reuses existing napi-rs AsyncTask pattern (`src/lib.rs::UiaGetElementsTask` etc.)
//! - GPU resources released via Drop, no GC leak
//! - Inference panics caught here, MCP server stays alive (L5)
//! - Zero-copy buffer sharing with DXGI capture (future Phase 4b)

pub mod capability;
pub mod dylib;
pub mod ep_select;
pub mod error;
pub mod inference;
pub mod registry;
pub mod session;
pub mod types;
// Phase 4b-2 WinML 統合は ADR-006 に移管 (2026-04-24、windows-app crate yanked +
// repo archived)。`winml.rs` / `winml_fallback.rs` は削除済、ADR-006 採用 option
// 決定後に再作成する。現状 `ep_select::winml_attempt` は Phase 4b-1 時点の stub
// (常に Err、cascade は DirectML に fall through) を維持。

pub use capability::{detect_capability, CapabilityProfile};
pub use error::VisionBackendError;
pub use inference::{recognize_rois_blocking, VisionSessionPool};
pub use registry::ModelRegistry;
pub use types::{
    NativeSessionInit, NativeSessionResult, RawCandidate, RecognizeRequest, Rect, RoiInput,
    SelectedEp,
};

/// Initialize an ORT session using the EP cascade determined by `profile`.
///
/// This function is the synchronous body called from `VisionInitSessionTask::compute`
/// on a libuv worker thread. It never panics — all errors are returned via
/// `NativeSessionResult::ok == false`.
///
/// Phase 4b-1: creates and immediately drops the session (no pool yet).
/// Phase 4b-4 will introduce a global `VisionSessionPool` and store it here.
pub fn init_session_blocking(init: NativeSessionInit) -> NativeSessionResult {
    // Ensure ORT is initialized exactly once
    if let Err(e) = dylib::ensure_ort_initialized() {
        return NativeSessionResult {
            ok: false,
            selected_ep: String::new(),
            error: Some(e.to_string()),
            session_key: init.session_key,
        };
    }

    // Phase 4b-2 WinAppSDK bootstrap は ADR-006 移管のため一旦削除。
    // ADR-006 採用 option 決定後、同じ位置に再追加する。

    let path = std::path::Path::new(&init.model_path);
    match session::VisionSession::create(path, &init.profile, init.session_key.clone()) {
        Ok(sess) => {
            // Phase 4b-1: session created successfully but not stored in a pool yet.
            // Phase 4b-4 will introduce VisionSessionPool and insert here.
            NativeSessionResult {
                ok: true,
                selected_ep: sess.selected_ep_label(),
                error: None,
                session_key: init.session_key,
            }
        }
        Err(e) => NativeSessionResult {
            ok: false,
            selected_ep: String::new(),
            error: Some(e.to_string()),
            session_key: init.session_key,
        },
    }
}
