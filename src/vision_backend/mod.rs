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
pub mod error;
pub mod inference;
pub mod registry;
pub mod types;

pub use capability::{detect_capability, CapabilityProfile};
pub use error::VisionBackendError;
pub use inference::{recognize_rois_blocking, VisionSessionPool};
pub use registry::ModelRegistry;
pub use types::{RawCandidate, RecognizeRequest, Rect, RoiInput};
