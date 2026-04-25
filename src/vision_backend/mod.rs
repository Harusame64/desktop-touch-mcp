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
pub mod florence2;
pub mod inference;
pub mod omniparser;
pub mod registry;
pub mod session;
pub mod session_pool;
pub mod types;
// Phase 4b-2 WinML 統合は ADR-006 に移管 (2026-04-24、windows-app crate yanked +
// repo archived)。`winml.rs` / `winml_fallback.rs` は削除済、ADR-006 採用 option
// 決定後に再作成する。現状 `ep_select::winml_attempt` は Phase 4b-1 時点の stub
// (常に Err、cascade は DirectML に fall through) を維持。

pub use capability::{detect_capability, CapabilityProfile};
pub use error::VisionBackendError;
pub use inference::recognize_rois_blocking;
pub use registry::ModelRegistry;
pub use session_pool::VisionSessionPool;
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
/// Phase 4b-5a-3: florence-2-base session_key triggers multi-file loading
/// via `init_florence2_stage1_blocking`. All other keys use single-file path.
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

    // Phase 4b-5a-3: florence-2-base needs 4 sibling ONNX files.
    if init.session_key.starts_with("florence-2-base:") {
        return init_florence2_stage1_blocking(init);
    }

    // Single-file path (existing behaviour for non-Florence-2 stages)
    let path = std::path::Path::new(&init.model_path);
    match session::VisionSession::create(path, &init.profile, init.session_key.clone()) {
        Ok(sess) => {
            let label = sess.selected_ep_label();
            // Phase 4b-5: insert into pool so subsequent recognize_rois_blocking
            // calls can look it up by session_key. If session_key is empty, we
            // still insert under "" — but the pool treats "" as a legitimate key
            // (caller decides not to send session_key in recognize_rois for
            // the legacy path, so "" entries are harmless).
            crate::vision_backend::session_pool::global_pool()
                .insert(init.session_key.clone(), std::sync::Arc::new(sess));
            NativeSessionResult {
                ok: true,
                selected_ep: label,
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

/// Multi-file Florence-2 Stage 1 loader. Looks for 4 sibling ONNX files
/// in the parent directory of `model_path` and loads each into the pool
/// under composite keys `<base_key>::<file_stem>`.
///
/// Called when `session_key.starts_with("florence-2-base:")`.
fn init_florence2_stage1_blocking(init: NativeSessionInit) -> NativeSessionResult {
    let model_path = std::path::Path::new(&init.model_path);
    let root = match model_path.parent() {
        Some(p) => p,
        None => return NativeSessionResult {
            ok: false,
            selected_ep: String::new(),
            error: Some(format!("model_path has no parent: {}", init.model_path)),
            session_key: init.session_key,
        },
    };

    const FILES: &[&str] = &[
        "vision_encoder.onnx",
        "embed_tokens.onnx",
        "encoder_model.onnx",
        "decoder_model_merged.onnx",
    ];
    let mut sessions: Vec<(String, std::sync::Arc<session::VisionSession>)> = Vec::with_capacity(4);
    let mut last_label = String::new();
    for &fname in FILES {
        let path = root.join(fname);
        let stem = fname.trim_end_matches(".onnx");
        let sub_key = format!("{}::{stem}", init.session_key);
        match session::VisionSession::create(&path, &init.profile, sub_key.clone()) {
            Ok(sess) => {
                last_label = sess.selected_ep_label();
                sessions.push((sub_key, std::sync::Arc::new(sess)));
            }
            Err(e) => {
                return NativeSessionResult {
                    ok: false,
                    selected_ep: String::new(),
                    error: Some(format!("florence-2-base sub-session {fname}: {e}")),
                    session_key: init.session_key,
                };
            }
        }
    }
    let pool = crate::vision_backend::session_pool::global_pool();
    for (key, sess) in sessions {
        pool.insert(key, sess);
    }
    NativeSessionResult {
        ok: true,
        selected_ep: last_label,
        error: None,
        session_key: init.session_key,
    }
}
