//! Model registry — file-path management for Phase 4a.
//!
//! Phase 4a scope: produces the on-disk path where TS-side downloader will
//! place the model. sha256 verification + download orchestration live in
//! TypeScript (`src/engine/vision-gpu/model-registry.ts`).
//!
//! Phase 4b scope: Rust will read the resolved path here and create
//! `ort::Session` from it.

use std::path::PathBuf;

/// Cache root: `%USERPROFILE%\.desktop-touch-mcp\models` (Windows) or
/// `~/.desktop-touch-mcp/models` elsewhere.
///
/// Kept consistent with the launcher's `~/.desktop-touch-mcp` install dir
/// (see CLAUDE.md "プロジェクト概要").
pub fn model_cache_root() -> PathBuf {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
    } else {
        std::env::var("HOME")
    }
    .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".desktop-touch-mcp").join("models")
}

/// Resolve a model variant to its on-disk path.
/// Does NOT verify existence or checksum — callers must check before use.
pub fn model_path(name: &str, variant: &str) -> PathBuf {
    model_cache_root().join(name).join(format!("{variant}.onnx"))
}

#[derive(Debug, Clone)]
pub struct ModelRegistry {
    root: PathBuf,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self { root: model_cache_root() }
    }
    pub fn path_for(&self, name: &str, variant: &str) -> PathBuf {
        self.root.join(name).join(format!("{variant}.onnx"))
    }
}

impl Default for ModelRegistry {
    fn default() -> Self { Self::new() }
}
