//! ONNX Runtime dylib resolution and one-shot init (ADR-005 D1').
//!
//! `ensure_ort_initialized()` resolves the DLL path and calls `ort::init()`
//! exactly once per process. Subsequent calls return the cached result.
//!
//! Lookup order:
//!   1. ORT_DYLIB_PATH env var (verbatim, file must exist)
//!   2. %USERPROFILE%/.desktop-touch-mcp/runtime/onnxruntime.dll (Windows)
//!   3. ~/.desktop-touch-mcp/runtime/libonnxruntime.so (Linux)
//!   4. ~/.desktop-touch-mcp/runtime/libonnxruntime.dylib (macOS)
//!
//! Returns Err(Other) if no DLL is found or ort::init() fails.
//! The result is cached in a OnceLock — re-init is not possible without
//! restarting the process.

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::vision_backend::error::VisionBackendError;

static ORT_INITIALIZED: OnceLock<Result<(), VisionBackendError>> = OnceLock::new();

/// Resolve the ONNX Runtime DLL path and call `ort::init()` exactly once
/// per process. Subsequent calls return the cached result.
///
/// Returns Err if no DLL is found or ort::init() fails.
pub fn ensure_ort_initialized() -> Result<(), VisionBackendError> {
    ORT_INITIALIZED
        .get_or_init(do_init)
        .clone()
}

fn do_init() -> Result<(), VisionBackendError> {
    let dylib = resolve_dylib_path().ok_or_else(|| {
        VisionBackendError::Other(
            "onnxruntime dylib not found (set ORT_DYLIB_PATH env var or place \
             onnxruntime.dll under ~/.desktop-touch-mcp/runtime/)"
                .into(),
        )
    })?;
    // `ort::init_from` is the load-dynamic entry point (feature = "load-dynamic").
    // It loads the DLL and returns an EnvironmentBuilder. `commit()` returns bool
    // (true if the environment was freshly created) — no error path.
    let builder = ort::init_from(&dylib)
        .map_err(|e| VisionBackendError::Other(format!("ort::init_from failed: {e}")))?;
    builder.commit();
    Ok(())
}

fn resolve_dylib_path() -> Option<PathBuf> {
    // 1. ORT_DYLIB_PATH env var (verbatim)
    if let Ok(p) = std::env::var("ORT_DYLIB_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }

    // 2. Default cache location under user home dir
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
    } else {
        std::env::var("HOME")
    }
    .ok()?;

    let runtime_dir = PathBuf::from(home)
        .join(".desktop-touch-mcp")
        .join("runtime");

    let candidate = if cfg!(target_os = "windows") {
        runtime_dir.join("onnxruntime.dll")
    } else if cfg!(target_os = "macos") {
        runtime_dir.join("libonnxruntime.dylib")
    } else {
        runtime_dir.join("libonnxruntime.so")
    };

    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}
