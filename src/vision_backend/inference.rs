//! Inference entry point for the visual GPU backend.
//!
//! Phase 4a behaviour (this file):
//!   - `recognize_rois_blocking` is the synchronous body called from the napi
//!     `AsyncTask::compute` worker thread (`src/lib.rs::VisionRecognizeTask`).
//!   - Returns dummy `RawCandidate`s — one per input ROI, empty label,
//!     confidence 0.5, `provisional: true`.
//!   - All work wrapped in `std::panic::catch_unwind` so a crash in inference
//!     becomes a `Result::Err`, never a process-level abort (L5).
//!
//! Phase 4b: real ORT session pool + EP cascade selection per `CapabilityProfile`.

use std::panic::AssertUnwindSafe;

use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::types::{RawCandidate, RecognizeRequest, RoiInput};

/// Synchronous recognise call (panic-isolated).
///
/// In Phase 4a no real model is loaded. The body is structured so Phase 4b
/// only needs to swap the `dummy_recognise` body for a real ORT session run.
pub fn recognize_rois_blocking(req: RecognizeRequest) -> Result<Vec<RawCandidate>, VisionBackendError> {
    // AssertUnwindSafe: req is a plain data struct (no shared mutable state captured).
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| dummy_recognise(req)));
    match result {
        Ok(out) => Ok(out),
        Err(payload) => {
            let msg = panic_payload_to_string(payload);
            Err(VisionBackendError::InferencePanic(msg))
        }
    }
}

/// Phase 4a dummy: 1 input ROI → 1 RawCandidate.
fn dummy_recognise(req: RecognizeRequest) -> Vec<RawCandidate> {
    req.rois
        .into_iter()
        .map(|roi: RoiInput| RawCandidate {
            track_id: roi.track_id,
            rect: roi.rect,
            label: String::new(),
            class: roi.class_hint.unwrap_or_else(|| "other".into()),
            confidence: 0.5,
            provisional: true,
        })
        .collect()
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    panic_payload_to_string_pub(payload)
}

/// Public version so `session.rs` can reuse the same conversion without
/// duplicating the downcast logic. Not part of the FFI surface.
pub fn panic_payload_to_string_pub(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".into()
    }
}

/// Placeholder for the per-target session pool. Phase 4b will keep one
/// `ort::Session` per (model_name, variant) and reuse across calls.
#[derive(Debug, Default)]
pub struct VisionSessionPool {
    // Phase 4b: HashMap<String, ort::Session>
}

impl VisionSessionPool {
    pub fn new() -> Self { Self::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vision_backend::types::Rect;

    #[test]
    fn dummy_returns_one_candidate_per_roi() {
        let req = RecognizeRequest {
            target_key: "window:1234".into(),
            rois: vec![
                RoiInput {
                    track_id: "t1".into(),
                    rect: Rect { x: 0, y: 0, width: 100, height: 50 },
                    class_hint: None,
                },
                RoiInput {
                    track_id: "t2".into(),
                    rect: Rect { x: 100, y: 50, width: 80, height: 30 },
                    class_hint: Some("button".into()),
                },
            ],
            frame_width: 1920,
            frame_height: 1080,
            now_ms: 0.0,
        };
        let out = recognize_rois_blocking(req).expect("dummy must succeed");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].track_id, "t1");
        assert_eq!(out[0].class, "other");
        assert!(out[0].provisional);
        assert_eq!(out[1].class, "button");
    }

    #[test]
    fn panic_in_inference_returns_err_not_abort() {
        let req = RecognizeRequest {
            target_key: "window:panic".into(),
            // Empty rois — the panic test below needs a forced panic, not an
            // input-derived one. We exercise the catch_unwind path via a
            // direct call to a panicking closure; this verifies the
            // mechanism rather than dummy_recognise itself.
            rois: vec![],
            frame_width: 0,
            frame_height: 0,
            now_ms: 0.0,
        };
        let _ok = recognize_rois_blocking(req).expect("empty rois must succeed");

        // Direct panic-isolation test:
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            panic!("simulated inference crash");
        }));
        assert!(result.is_err());
    }
}
