//! Error type for the visual GPU backend.
//!
//! Converted to napi::Error at the FFI boundary so Node sees a normal
//! Promise rejection. A backend error never crashes the MCP server (L5).

use napi::Error as NapiError;
use napi::Status;

#[derive(Debug)]
pub enum VisionBackendError {
    /// `ort` feature was disabled at build time (`--no-default-features`).
    BackendDisabled,
    /// EP requested but not compiled in (e.g. `vision-gpu-cuda` not enabled).
    EpUnavailable(&'static str),
    /// Model registry lookup miss / sha256 mismatch / IO error.
    ModelNotFound(String),
    /// ORT session create / run failure.
    SessionFailed(String),
    /// `catch_unwind` caught a panic inside inference. Message preserved.
    InferencePanic(String),
    /// Generic.
    Other(String),
}

impl std::fmt::Display for VisionBackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BackendDisabled => write!(f, "vision-gpu backend disabled at build time"),
            Self::EpUnavailable(ep) => write!(f, "execution provider {ep} not built in"),
            Self::ModelNotFound(name) => write!(f, "model not found in registry: {name}"),
            Self::SessionFailed(msg) => write!(f, "ort session failure: {msg}"),
            Self::InferencePanic(msg) => write!(f, "inference panic (caught): {msg}"),
            Self::Other(msg) => write!(f, "vision backend error: {msg}"),
        }
    }
}

impl std::error::Error for VisionBackendError {}

impl From<VisionBackendError> for NapiError {
    fn from(e: VisionBackendError) -> Self {
        NapiError::new(Status::GenericFailure, e.to_string())
    }
}
