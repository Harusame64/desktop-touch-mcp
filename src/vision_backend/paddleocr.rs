//! PaddleOCR-v4 Stage 3 (text recognition) inference module.
//!
//! PaddleOCR-v4 server recognition is a CRNN/SVTR-based sequence model that
//! takes a cropped text-region image (fixed H=48, variable W) and outputs
//! CTC logits over a character dictionary (~6625 classes for PP-OCRv4 multilingual).
//!
//! Phase 4b-5c scope (this file):
//!   - `PaddleOcrDict`: dict loader (ppocr_keys convention, one char per line)
//!   - `preprocess_image`: RGBA bytes → f32 NCHW [1, 3, 48, W] with
//!     aspect-preserving resize (W clamped to [32, 640]) and PaddleOCR
//!     normalization: (px/255 - 0.5) / 0.5 = px/127.5 - 1.
//!   - `paddleocr_stage3_recognise`: single-pass forward + CTC greedy decode
//!     → RawCandidate[] class="text" for each input ROI.
//!   - `ctc_greedy_decode`: argmax collapse → lookup → String
//!
//! Note: all vision-gpu items are gated on `#[cfg(feature = "vision-gpu")]`.

#[cfg(feature = "vision-gpu")]
use ndarray::{Array3, Array4, ArrayView3};

use std::path::Path;

use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::types::{RawCandidate, Rect, RecognizeRequest};
use crate::vision_backend::session::VisionSession;

/// PaddleOCR-v4 server input height (fixed). Width is dynamic, aspect-preserving.
pub const PADDLEOCR_INPUT_HEIGHT: u32 = 48;

/// Minimum input width after resize (ensures CTC has enough frames).
pub const PADDLEOCR_MIN_WIDTH: u32 = 32;

/// Maximum input width after resize (clips very-wide bboxes for memory).
pub const PADDLEOCR_MAX_WIDTH: u32 = 640;

/// Normalization: PaddleOCR uses ImageNet-style but with different scale
/// ([0.5, 0.5, 0.5] mean, [0.5, 0.5, 0.5] std — effectively (px/255 - 0.5) / 0.5 = px/127.5 - 1).
const PADDLEOCR_MEAN: [f32; 3] = [0.5, 0.5, 0.5];
const PADDLEOCR_STD: [f32; 3] = [0.5, 0.5, 0.5];

/// CTC blank token index (conventionally 0 in PaddleOCR dict).
pub const PADDLEOCR_CTC_BLANK: usize = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Internal crop descriptor (private, same pattern as omniparser.rs)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "vision-gpu")]
struct Crop {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Dict loading
// ─────────────────────────────────────────────────────────────────────────────

/// PaddleOCR dictionary wrapper.
pub struct PaddleOcrDict {
    /// Characters indexed by class id (index 0 is CTC blank, indices 1.. are real chars).
    chars: Vec<String>,
}

impl PaddleOcrDict {
    /// Load dict from a text file (one character per line).
    /// Dict format follows PaddleOCR `ppocr_keys_v1.txt` convention.
    pub fn from_file(path: &Path) -> Result<Self, VisionBackendError> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            VisionBackendError::Other(format!("paddleocr dict load {}: {e}", path.display()))
        })?;
        let mut chars = vec!["".into()]; // index 0 = CTC blank
        for line in content.lines() {
            chars.push(line.to_string());
        }
        Ok(Self { chars })
    }

    pub fn num_classes(&self) -> usize {
        self.chars.len()
    }

    /// Look up character by class id. Returns empty string for blank or OOB.
    pub fn lookup(&self, class_id: usize) -> &str {
        self.chars.get(class_id).map(|s| s.as_str()).unwrap_or("")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Image preprocess helpers (private, duplicate from omniparser.rs per §7)
// clip_roi / extract_crop_rgb / resize_bilinear_rgb are intentionally kept
// as private copies here — future ADR-007 will extract a common image_utils.
// ─────────────────────────────────────────────────────────────────────────────

/// Clip a screen-absolute Rect to the frame bounds. Returns Err if the
/// resulting area is empty. Empty roi (w<=0 || h<=0) yields full frame.
#[cfg(feature = "vision-gpu")]
fn clip_roi(roi: &Rect, width: u32, height: u32) -> Result<Crop, VisionBackendError> {
    if roi.width <= 0 || roi.height <= 0 {
        return Ok(Crop { x: 0, y: 0, w: width, h: height });
    }
    let x0 = roi.x.max(0).min(width as i32) as u32;
    let y0 = roi.y.max(0).min(height as i32) as u32;
    let x1 = (roi.x + roi.width).max(0).min(width as i32) as u32;
    let y1 = (roi.y + roi.height).max(0).min(height as i32) as u32;
    if x1 <= x0 || y1 <= y0 {
        return Err(VisionBackendError::Other(format!(
            "roi {:?} clipped to empty region against frame {}x{}",
            roi, width, height,
        )));
    }
    Ok(Crop { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// Copy the crop region from an RGBA buffer into a packed RGB Array3 (H, W, 3).
#[cfg(feature = "vision-gpu")]
fn extract_crop_rgb(buffer: &[u8], frame_w: u32, crop: &Crop) -> Array3<u8> {
    let mut out = Array3::<u8>::zeros((crop.h as usize, crop.w as usize, 3));
    for (out_y, y) in (crop.y..crop.y + crop.h).enumerate() {
        for (out_x, x) in (crop.x..crop.x + crop.w).enumerate() {
            let src_idx = ((y * frame_w + x) * 4) as usize;
            out[[out_y, out_x, 0]] = buffer[src_idx];     // R
            out[[out_y, out_x, 1]] = buffer[src_idx + 1]; // G
            out[[out_y, out_x, 2]] = buffer[src_idx + 2]; // B
            // Alpha (buffer[src_idx + 3]) intentionally dropped.
        }
    }
    out
}

/// Bilinear resize using the `image` crate. Input / output are packed RGB u8.
#[cfg(feature = "vision-gpu")]
fn resize_bilinear_rgb(
    src: &Array3<u8>,
    dst_w: u32,
    dst_h: u32,
) -> Result<Array3<u8>, VisionBackendError> {
    use image::{imageops::FilterType, ImageBuffer, Rgb};
    let (h, w, _) = src.dim();
    let flat = src
        .as_slice()
        .ok_or_else(|| VisionBackendError::Other("Array3<u8> not contiguous".into()))?
        .to_vec();
    let src_img: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_raw(w as u32, h as u32, flat)
            .ok_or_else(|| VisionBackendError::Other("ImageBuffer::from_raw shape mismatch".into()))?;
    let resized = image::imageops::resize(&src_img, dst_w, dst_h, FilterType::Triangle);
    let raw = resized.into_raw();
    ndarray::Array3::from_shape_vec((dst_h as usize, dst_w as usize, 3), raw)
        .map_err(|e| VisionBackendError::Other(format!("resized Array3 shape mismatch: {e}")))
}

// ─────────────────────────────────────────────────────────────────────────────
// Image preprocess (public API, §3.2)
// ─────────────────────────────────────────────────────────────────────────────

/// Preprocess a bbox crop for PaddleOCR recognition.
///
/// PaddleOCR expects: fixed height 48, aspect-preserving width clipped to [32, 640].
/// Normalization: `(px/255 - 0.5) / 0.5 = px/127.5 - 1` per channel.
#[cfg(feature = "vision-gpu")]
pub fn preprocess_image(
    buffer: &[u8],
    frame_width: u32,
    frame_height: u32,
    roi: &Rect,
) -> Result<Array4<f32>, VisionBackendError> {
    let expected_len = (frame_width as usize) * (frame_height as usize) * 4;
    if buffer.len() != expected_len {
        return Err(VisionBackendError::Other(format!(
            "frame_buffer length {} != expected {}",
            buffer.len(), expected_len,
        )));
    }
    if frame_width == 0 || frame_height == 0 {
        return Err(VisionBackendError::Other("dimensions must be non-zero".into()));
    }

    let crop = clip_roi(roi, frame_width, frame_height)?;
    let crop_rgb = extract_crop_rgb(buffer, frame_width, &crop);

    // Compute aspect-preserving dst width.
    let ratio = crop.w as f32 / crop.h as f32;
    let raw_dst_w = (PADDLEOCR_INPUT_HEIGHT as f32 * ratio).round() as u32;
    let dst_w = raw_dst_w.clamp(PADDLEOCR_MIN_WIDTH, PADDLEOCR_MAX_WIDTH);

    let resized = resize_bilinear_rgb(&crop_rgb, dst_w, PADDLEOCR_INPUT_HEIGHT)?;
    Ok(normalize_paddleocr(&resized))
}

#[cfg(feature = "vision-gpu")]
fn normalize_paddleocr(src: &Array3<u8>) -> Array4<f32> {
    let (h, w, _) = src.dim();
    let mut out = Array4::<f32>::zeros((1, 3, h, w));
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let px = src[[y, x, c]] as f32 / 255.0;
                out[[0, c, y, x]] = (px - PADDLEOCR_MEAN[c]) / PADDLEOCR_STD[c];
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-pass forward + CTC greedy decode (§3.3)
// ─────────────────────────────────────────────────────────────────────────────

/// Run PaddleOCR-v4 server recognition on all ROIs and return RawCandidates
/// with label = recognized text, class = "text".
pub fn paddleocr_stage3_recognise(
    req: &RecognizeRequest,
    sess: &VisionSession,
) -> Result<Vec<RawCandidate>, VisionBackendError> {
    if req.frame_buffer.is_empty() {
        return Err(VisionBackendError::Other("frame_buffer is empty".into()));
    }

    // Load dict from <model_path parent>/paddleocr_keys.txt convention.
    let dict_path = dict_path_for_session(sess)
        .ok_or_else(|| VisionBackendError::Other("model_path has no parent".into()))?;
    if !dict_path.exists() {
        return Err(VisionBackendError::Other(format!(
            "paddleocr dict not found at {}",
            dict_path.display(),
        )));
    }
    let dict = PaddleOcrDict::from_file(&dict_path)?;

    let mut out = Vec::with_capacity(req.rois.len());
    for roi in req.rois.iter() {
        // Per-ROI preprocess + forward + decode
        #[cfg(feature = "vision-gpu")]
        {
            let pixel_values = preprocess_image(
                &req.frame_buffer,
                req.frame_width,
                req.frame_height,
                &roi.rect,
            )?;
            let logits = run_rec(sess, pixel_values)?;
            let text = ctc_greedy_decode(logits.view(), &dict);

            out.push(RawCandidate {
                track_id: roi.track_id.clone(),
                rect: roi.rect.clone(),
                label: text,
                class: "text".into(),
                confidence: 0.8, // CTC confidence aggregation defer to bench batch
                provisional: true,
            });
        }
        #[cfg(not(feature = "vision-gpu"))]
        {
            // Non-GPU build: emit empty text candidate (framework wiring only).
            out.push(RawCandidate {
                track_id: roi.track_id.clone(),
                rect: roi.rect.clone(),
                label: String::new(),
                class: "text".into(),
                confidence: 0.0,
                provisional: true,
            });
        }
    }
    Ok(out)
}

pub fn dict_path_for_session(sess: &VisionSession) -> Option<std::path::PathBuf> {
    Path::new(&sess.model_path)
        .parent()
        .map(|p| p.join("paddleocr_keys.txt"))
}

#[cfg(feature = "vision-gpu")]
fn run_rec(
    sess: &VisionSession,
    pixel_values: Array4<f32>,
) -> Result<ndarray::Array3<f32>, VisionBackendError> {
    use ort::value::Tensor;
    let input_tensor = Tensor::from_array(pixel_values)
        .map_err(|e| VisionBackendError::Other(format!("input tensor: {e}")))?;
    let mut session = sess.lock();
    // PaddleOCR rec ONNX input name is "x" (PaddlePaddle convention).
    let outputs = session
        .run(ort::inputs![ "x" => input_tensor ])
        .map_err(|e| VisionBackendError::Other(format!("paddleocr rec run: {e}")))?;
    let (_, output_tensor) = outputs
        .iter()
        .next()
        .ok_or_else(|| VisionBackendError::Other("paddleocr rec no outputs".into()))?;
    let view = output_tensor
        .try_extract_array::<f32>()
        .map_err(|e| VisionBackendError::Other(format!("output extract: {e}")))?;
    // Output shape: [1, seq_len, num_classes] (CTC logits after softmax)
    view.into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| VisionBackendError::Other(format!("output dim: {e}")))
        .map(|a| a.to_owned())
}

/// CTC greedy decode: at each time step take argmax, collapse runs, drop blank.
pub fn ctc_greedy_decode(logits: ArrayView3<f32>, dict: &PaddleOcrDict) -> String {
    let shape = logits.shape();
    if shape[0] != 1 || shape.len() != 3 {
        return String::new();
    }
    let seq_len = shape[1];
    let num_classes = shape[2];
    if num_classes != dict.num_classes() {
        // Dict mismatch — log + return empty. Dogfood verify to catch config issues.
        tracing::warn!(
            target: "paddleocr",
            "dict num_classes ({}) != model output dim ({}), returning empty",
            dict.num_classes(), num_classes,
        );
        return String::new();
    }

    let mut prev_idx: Option<usize> = None;
    let mut text = String::new();
    for t in 0..seq_len {
        // Argmax over class dim
        let mut best_idx = 0usize;
        let mut best_val = f32::NEG_INFINITY;
        for c in 0..num_classes {
            let v = logits[[0, t, c]];
            if v > best_val {
                best_val = v;
                best_idx = c;
            }
        }
        // CTC collapse: skip if same as previous, skip if blank
        if best_idx == PADDLEOCR_CTC_BLANK {
            prev_idx = None;
            continue;
        }
        if Some(best_idx) == prev_idx {
            continue;
        }
        text.push_str(dict.lookup(best_idx));
        prev_idx = Some(best_idx);
    }
    text
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests (§5.1, 10+ cases)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(all(test, feature = "vision-gpu"))]
mod tests {
    use super::*;
    use ndarray::Array3;
    use std::io::Write;

    fn synth_rgba(w: u32, h: u32, fill: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            v.extend_from_slice(&fill);
        }
        v
    }

    fn write_tmp_dict(lines: &[&str]) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "paddleocr-test-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos(),
        ));
        let mut f = std::fs::File::create(&tmp).expect("create dict");
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        tmp
    }

    #[test]
    fn dict_from_file_loads_chars_with_blank_prepended() {
        let path = write_tmp_dict(&["a", "b", "c"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        assert_eq!(dict.num_classes(), 4); // blank + 3
        assert_eq!(dict.lookup(0), ""); // blank
        assert_eq!(dict.lookup(1), "a");
        assert_eq!(dict.lookup(2), "b");
        assert_eq!(dict.lookup(3), "c");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn dict_lookup_oob_returns_empty() {
        let path = write_tmp_dict(&["a"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        assert_eq!(dict.lookup(100), "");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn dict_from_file_missing_path_returns_err() {
        let result = PaddleOcrDict::from_file(Path::new("/no/such/file/paddleocr_keys.txt"));
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(msg.contains("paddleocr dict load"), "error: {msg}");
    }

    #[test]
    fn preprocess_dynamic_width_preserves_aspect() {
        // 100x50 crop → aspect 2.0 → dst_w = 48*2 = 96 (within [32, 640])
        let buf = synth_rgba(100, 50, [128, 128, 128, 255]);
        let roi = Rect { x: 0, y: 0, width: 100, height: 50 };
        let out = preprocess_image(&buf, 100, 50, &roi).unwrap();
        assert_eq!(out.shape()[2], 48); // height
        assert_eq!(out.shape()[3], 96); // width
    }

    #[test]
    fn preprocess_clamps_to_min_width() {
        // 10x50 crop → aspect 0.2 → dst_w = 48*0.2 = 10 → clamp to 32
        let buf = synth_rgba(10, 50, [128, 128, 128, 255]);
        let roi = Rect { x: 0, y: 0, width: 10, height: 50 };
        let out = preprocess_image(&buf, 10, 50, &roi).unwrap();
        assert_eq!(out.shape()[3], 32);
    }

    #[test]
    fn preprocess_clamps_to_max_width() {
        // 2000x50 crop → aspect 40 → dst_w = 48*40 = 1920 → clamp to 640
        let buf = synth_rgba(2000, 50, [128, 128, 128, 255]);
        let roi = Rect { x: 0, y: 0, width: 2000, height: 50 };
        let out = preprocess_image(&buf, 2000, 50, &roi).unwrap();
        assert_eq!(out.shape()[3], 640);
    }

    #[test]
    fn preprocess_normalize_zero_centered() {
        // 128/255 = 0.502、(0.502 - 0.5) / 0.5 = 0.004
        let buf = synth_rgba(48, 48, [128, 128, 128, 255]);
        let roi = Rect { x: 0, y: 0, width: 48, height: 48 };
        let out = preprocess_image(&buf, 48, 48, &roi).unwrap();
        let center = out[[0, 0, 24, 24]];
        assert!((center - 0.004).abs() < 0.01, "expected ~0.004, got {center}");
    }

    #[test]
    fn preprocess_output_shape_nchw() {
        // Verify the output tensor is [1, 3, 48, W]
        let buf = synth_rgba(64, 48, [200, 100, 50, 255]);
        let roi = Rect { x: 0, y: 0, width: 64, height: 48 };
        let out = preprocess_image(&buf, 64, 48, &roi).unwrap();
        assert_eq!(out.shape()[0], 1);  // batch
        assert_eq!(out.shape()[1], 3);  // channels
        assert_eq!(out.shape()[2], 48); // height
    }

    #[test]
    fn preprocess_buffer_length_mismatch_returns_err() {
        let bad_buf = vec![0u8; 10]; // wrong length
        let roi = Rect { x: 0, y: 0, width: 10, height: 10 };
        let result = preprocess_image(&bad_buf, 10, 10, &roi);
        assert!(result.is_err());
    }

    #[test]
    fn preprocess_zero_dimensions_returns_err() {
        let buf = vec![0u8; 0];
        let roi = Rect { x: 0, y: 0, width: 0, height: 0 };
        let result = preprocess_image(&buf, 0, 0, &roi);
        assert!(result.is_err());
    }

    #[test]
    fn ctc_greedy_decode_simple_abc() {
        let path = write_tmp_dict(&["a", "b", "c"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        // 3 time steps, argmax = [1, 2, 3] → "abc"
        let mut logits = Array3::<f32>::zeros((1, 3, 4));
        logits[[0, 0, 1]] = 1.0;
        logits[[0, 1, 2]] = 1.0;
        logits[[0, 2, 3]] = 1.0;
        let text = ctc_greedy_decode(logits.view(), &dict);
        assert_eq!(text, "abc");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn ctc_greedy_decode_collapses_runs() {
        let path = write_tmp_dict(&["a"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        // 3 time steps all argmax=1 → should collapse to single "a"
        let mut logits = Array3::<f32>::zeros((1, 3, 2));
        logits[[0, 0, 1]] = 1.0;
        logits[[0, 1, 1]] = 1.0;
        logits[[0, 2, 1]] = 1.0;
        let text = ctc_greedy_decode(logits.view(), &dict);
        assert_eq!(text, "a");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn ctc_greedy_decode_skips_blank() {
        let path = write_tmp_dict(&["a", "b"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        // sequence: a, blank, b → "ab"
        let mut logits = Array3::<f32>::zeros((1, 3, 3));
        logits[[0, 0, 1]] = 1.0; // a
        logits[[0, 1, 0]] = 1.0; // blank
        logits[[0, 2, 2]] = 1.0; // b
        let text = ctc_greedy_decode(logits.view(), &dict);
        assert_eq!(text, "ab");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn ctc_greedy_decode_empty_on_dict_mismatch() {
        let path = write_tmp_dict(&["a"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        // dict has 2 classes (blank + a), logits have 10 classes → mismatch
        let logits = Array3::<f32>::zeros((1, 3, 10));
        let text = ctc_greedy_decode(logits.view(), &dict);
        assert_eq!(text, "");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn ctc_greedy_decode_empty_on_wrong_shape() {
        let path = write_tmp_dict(&["a"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        let bad = Array3::<f32>::zeros((2, 3, 2));
        let text = ctc_greedy_decode(bad.view(), &dict);
        assert_eq!(text, "");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn ctc_greedy_decode_all_blank_returns_empty() {
        let path = write_tmp_dict(&["a", "b"]);
        let dict = PaddleOcrDict::from_file(&path).unwrap();
        // All time steps point to blank (class 0)
        let mut logits = Array3::<f32>::zeros((1, 4, 3));
        for t in 0..4 {
            logits[[0, t, 0]] = 1.0; // blank
        }
        let text = ctc_greedy_decode(logits.view(), &dict);
        assert_eq!(text, "");
        std::fs::remove_file(path).ok();
    }
}
