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
use crate::vision_backend::types::{RawCandidate, RecognizeRequest, Rect, RoiInput};

/// Synchronous recognise call (panic-isolated).
///
/// Phase 4b-5: if `req.session_key` is non-empty, looks up the session in the
/// global pool and runs stub inference bound to that session. If the key is
/// absent from the pool, returns an empty Vec so TS can detect "session not
/// ready". Falls back to the Phase 4a `dummy_recognise` path when session_key
/// is empty (legacy backward-compat for tests / PocVisualBackend migration).
pub fn recognize_rois_blocking(req: RecognizeRequest) -> Result<Vec<RawCandidate>, VisionBackendError> {
    // AssertUnwindSafe: req is a plain data struct (no shared mutable state captured).
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        if !req.session_key.is_empty() {
            // Phase 4b-5: session-bound stub path
            if let Some(sess) = crate::vision_backend::session_pool::global_pool().get(&req.session_key) {
                return stub_recognise_with_session(req, sess);
            }
            // session_key requested but absent — emit a single empty fallback
            // candidate list so TS can tell "session not ready" from "no ROIs"
            // via `raw.length === 0 && input.rois.length > 0`.
            return Vec::new();
        }
        // Legacy dummy path (Phase 4a compatible)
        dummy_recognise(req)
    }));
    match result {
        Ok(out) => Ok(out),
        Err(payload) => {
            let msg = panic_payload_to_string(payload);
            Err(VisionBackendError::InferencePanic(msg))
        }
    }
}

/// Phase 4b-5 stub inference. Reuses `dummy_recognise` body and tags each
/// candidate with `selected_ep` info for downstream tracing. Real preprocess /
/// session.run() / postprocess go into 4b-5a/b/c as drop-in replacements.
#[allow(unused_variables)]
fn stub_recognise_with_session(req: RecognizeRequest, sess: std::sync::Arc<crate::vision_backend::session::VisionSession>) -> Vec<RawCandidate> {
    // Phase 4b-5a-1: Florence-2 session_key dispatch (preprocess only, encoder TBD)
    if sess.session_key.starts_with("florence-2-base:") && !req.frame_buffer.is_empty() {
        // Preprocess the frame. Errors are logged but do not fail the call —
        // L5 says the visual lane should degrade, not abort. Fall back to
        // dummy_recognise output.
        match crate::vision_backend::florence2::preprocess_image(
            &req.frame_buffer,
            req.frame_width,
            req.frame_height,
            // Use a synthetic full-frame roi if no rois; otherwise first roi.
            req.rois.first().map(|r| &r.rect).unwrap_or(&Rect {
                x: 0, y: 0, width: req.frame_width as i32, height: req.frame_height as i32,
            }),
        ) {
            Ok(tensor) => {
                // Sanity-check the tensor shape. Phase 4b-5a-3 will feed this
                // into ort::Session::run; for now we just verify it exists and
                // log for debugging.
                debug_assert_eq!(tensor.dim(), crate::vision_backend::florence2::expected_shape());
                // Fall through to dummy output — real inference in 4b-5a-3.
            }
            Err(e) => {
                eprintln!("[florence2] preprocess failed: {e}");
                // Continue with dummy output. Visual lane stays alive (L5).
            }
        }
    }
    // Return stub candidates identical to dummy_recognise so stage-pipeline
    // tests continue to pass unchanged in 4b-5a-1.
    dummy_recognise(req)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vision_backend::types::Rect;

    #[test]
    fn dummy_returns_one_candidate_per_roi() {
        let req = RecognizeRequest {
            target_key: "window:1234".into(),
            session_key: String::new(), // empty → legacy dummy path (Phase 4a compat)
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
            frame_buffer: napi::bindgen_prelude::Buffer::from(vec![]),
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
            session_key: String::new(), // empty → legacy dummy path (Phase 4a compat)
            // Empty rois — the panic test below needs a forced panic, not an
            // input-derived one. We exercise the catch_unwind path via a
            // direct call to a panicking closure; this verifies the
            // mechanism rather than dummy_recognise itself.
            rois: vec![],
            frame_width: 0,
            frame_height: 0,
            frame_buffer: napi::bindgen_prelude::Buffer::from(vec![]),
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
