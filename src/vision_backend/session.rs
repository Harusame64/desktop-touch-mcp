//! VisionSession — one loaded ONNX session bound to a specific EP.
//!
//! `VisionSession::create` attempts EPs in cascade order (from `ep_select`)
//! and returns the first session that loads successfully. If every EP fails,
//! it returns `VisionBackendError::SessionFailed`.
//!
//! Each `try_one_ep` call is wrapped in `std::panic::catch_unwind` so a panic
//! inside ort (e.g. from a driver crash during session init) is converted to
//! `VisionBackendError::InferencePanic` rather than aborting the process (L5).

use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::vision_backend::capability::CapabilityProfile;
use crate::vision_backend::ep_select::{build_cascade, EpAttempt};
use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::types::SelectedEp;

/// One loaded ONNX session bound to a specific EP. Held by VisionSessionPool.
pub struct VisionSession {
    /// Boxed inside Arc<Mutex<>> so we can hand out clones without unsafe.
    /// ort::Session is Send + Sync per the 2.x API, but we wrap in Mutex
    /// because ort::Value passing is &mut at run time.
    inner: Arc<Mutex<ort::session::Session>>,
    pub selected_ep: SelectedEp,
    pub model_path: String,
    pub session_key: String,
}

impl VisionSession {
    /// Try EPs in cascade order and return the first session that loads.
    /// Returns Err(SessionFailed) only when EVERY EP attempt failed.
    pub fn create(
        model_path: &Path,
        profile: &CapabilityProfile,
        session_key: String,
    ) -> Result<Self, VisionBackendError> {
        let attempts = build_cascade(profile);
        let mut errors: Vec<String> = Vec::new();
        for attempt in attempts {
            match try_one_ep(model_path, &attempt) {
                Ok(sess) => {
                    return Ok(Self {
                        inner: Arc::new(Mutex::new(sess)),
                        selected_ep: attempt.kind,
                        model_path: model_path.to_string_lossy().into_owned(),
                        session_key,
                    });
                }
                Err(e) => errors.push(format!("{}: {}", attempt.kind.as_label(), e)),
            }
        }
        Err(VisionBackendError::SessionFailed(format!(
            "all EPs failed: [{}]",
            errors.join(" | ")
        )))
    }

    pub fn selected_ep_label(&self) -> String {
        self.selected_ep.as_label()
    }

    /// Provide access to the inner session for inference (Phase 4b-4+).
    /// Returns a guard that holds the Mutex lock.
    pub fn lock(&self) -> std::sync::MutexGuard<'_, ort::session::Session> {
        self.inner.lock().expect("VisionSession mutex poisoned")
    }
}

/// Run a single EP attempt. Wrapped in catch_unwind so a panic inside ort
/// (rare, but possible during session init on driver issues) never aborts
/// the host process — L5.
fn try_one_ep(
    model_path: &Path,
    attempt: &EpAttempt,
) -> Result<ort::session::Session, VisionBackendError> {
    use std::panic::AssertUnwindSafe;
    let model_path = model_path.to_path_buf();
    let attempt_clone = attempt.clone();
    let result = std::panic::catch_unwind(AssertUnwindSafe(move || {
        let builder = ort::session::Session::builder()
            .map_err(|e| VisionBackendError::SessionFailed(format!("builder: {e}")))?;
        let mut builder = (attempt_clone.apply)(builder).map_err(|e| {
            VisionBackendError::SessionFailed(format!(
                "ep {}: {e}",
                attempt_clone.kind.as_label()
            ))
        })?;
        builder
            .commit_from_file(&model_path)
            .map_err(|e| VisionBackendError::SessionFailed(format!("commit: {e}")))
    }));
    match result {
        Ok(Ok(sess)) => Ok(sess),
        Ok(Err(e)) => Err(e),
        Err(payload) => {
            let msg =
                crate::vision_backend::inference::panic_payload_to_string_pub(payload);
            Err(VisionBackendError::InferencePanic(msg))
        }
    }
}
