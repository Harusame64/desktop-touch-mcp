//! Florence-2 Stage 1 (region proposer) inference module.
//!
//! This module handles image preprocessing and (in future sub-batches)
//! encoder + decoder dispatch for Microsoft's Florence-2-base VLM, used as
//! the Stage 1 region proposer in ADR-005 D5'.
//!
//! Phase 4b-5a-1 scope (this file):
//!   - `preprocess_image`: RGBA bytes → f32 ndarray `[1, 3, 768, 768]` with
//!     ImageNet normalization and HWC→CHW layout conversion
//!   - `FLORENCE2_INPUT_SIDE` constant (768)
//!   - Unit tests for preprocess correctness
//!
//! Phase 4b-5a-2 additions (this batch):
//!   - `Florence2Tokenizer`: thin wrapper over `tokenizers::Tokenizer` for
//!     loading Florence-2's BART tokenizer.json
//!   - `PromptTokens`: result struct (input_ids + attention_mask as Vec<i64>)
//!   - `tokenize_region_proposal()`: encode the canonical `<REGION_PROPOSAL>`
//!     task prompt that Stage 1 uses
//!   - `tokenize_with_prompt(&str)`: encode arbitrary prompt (used by tests
//!     and any future task variant)
//!
//! Phase 4b-5a-3 scope (future):
//!   - Encoder + decoder ort::Session::run with KV-cache autoregressive loop
//!
//! Phase 4b-5a-4 scope (future):
//!   - `<loc_X>` token sequence → bbox RawCandidate[] parser
//!
//! Note: ndarray is a transitive dependency of ort, available under the
//! `vision-gpu` feature only. All items in this module are gated on that feature.

#[cfg(feature = "vision-gpu")]
use ndarray::Array4;

use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::types::Rect;

/// Florence-2-base expects 768x768 RGB images (per Microsoft's HF model card).
pub const FLORENCE2_INPUT_SIDE: u32 = 768;

/// ImageNet mean (RGB order, per-channel), applied after /255 normalization.
#[cfg(feature = "vision-gpu")]
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet std (RGB order, per-channel).
#[cfg(feature = "vision-gpu")]
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Preprocess a raw RGBA frame crop into the fp32 tensor Florence-2 expects.
///
/// Input contract:
///   - `buffer`: RGBA bytes, length == `width * height * 4`
///   - `width` / `height`: frame dimensions in pixels
///   - `roi`: region of interest in screen-absolute pixels (clipped to frame
///     bounds internally). If `roi.width == 0 || roi.height == 0`, the
///     entire frame is used.
///
/// Output contract:
///   - `Ok(Array4<f32>)` of shape `[1, 3, 768, 768]`, layout NCHW (channel
///     order = RGB, alpha discarded)
///   - Values are `(u8_channel / 255 - mean) / std` (ImageNet normalize)
///   - Bilinear resize from ROI crop size → 768x768
///
/// Error cases (all return `VisionBackendError::Other(...)`):
///   - buffer length mismatch (`!= width * height * 4`)
///   - width or height == 0
///   - `roi` fully outside frame bounds after clipping
///
/// This function is only available when built with the `vision-gpu` feature.
#[cfg(feature = "vision-gpu")]
pub fn preprocess_image(
    buffer: &[u8],
    width: u32,
    height: u32,
    roi: &Rect,
) -> Result<Array4<f32>, VisionBackendError> {
    // Validate input buffer size.
    let expected_len = (width as usize) * (height as usize) * 4;
    if buffer.len() != expected_len {
        return Err(VisionBackendError::Other(format!(
            "frame_buffer length {} does not match width*height*4 = {}",
            buffer.len(), expected_len,
        )));
    }
    if width == 0 || height == 0 {
        return Err(VisionBackendError::Other("frame dimensions must be non-zero".into()));
    }

    // Resolve the crop region. Empty roi → entire frame.
    let crop = clip_roi(roi, width, height)?;

    // Extract the crop into an Array3<u8> (H, W, RGB). Alpha channel is dropped.
    let crop_rgb: ndarray::Array3<u8> = extract_crop_rgb(buffer, width, &crop);

    // Bilinear-resize the crop to (FLORENCE2_INPUT_SIDE, FLORENCE2_INPUT_SIDE).
    // The `image` crate handles RGB u8 resize efficiently.
    let resized: ndarray::Array3<u8> = resize_bilinear_rgb(&crop_rgb, FLORENCE2_INPUT_SIDE, FLORENCE2_INPUT_SIDE);

    // Convert to f32 NCHW and apply ImageNet normalization.
    Ok(normalize_and_transpose(&resized))
}

/// Clip a screen-absolute Rect to the frame bounds. Returns Err if the
/// resulting area is empty. Empty roi (w==0 || h==0) yields full frame.
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

#[cfg(feature = "vision-gpu")]
struct Crop { x: u32, y: u32, w: u32, h: u32 }

/// Copy the crop region from an RGBA buffer into a packed RGB Array3 (H, W, 3).
#[cfg(feature = "vision-gpu")]
fn extract_crop_rgb(buffer: &[u8], frame_w: u32, crop: &Crop) -> ndarray::Array3<u8> {
    let mut out = ndarray::Array3::<u8>::zeros((crop.h as usize, crop.w as usize, 3));
    for (out_y, y) in (crop.y..crop.y + crop.h).enumerate() {
        for (out_x, x) in (crop.x..crop.x + crop.w).enumerate() {
            let src_idx = ((y * frame_w + x) * 4) as usize;
            out[[out_y, out_x, 0]] = buffer[src_idx];     // R
            out[[out_y, out_x, 1]] = buffer[src_idx + 1]; // G
            out[[out_y, out_x, 2]] = buffer[src_idx + 2]; // B
            // Alpha (buffer[src_idx + 3]) is intentionally dropped.
        }
    }
    out
}

/// Bilinear resize using the `image` crate. Input / output are packed RGB u8.
#[cfg(feature = "vision-gpu")]
fn resize_bilinear_rgb(src: &ndarray::Array3<u8>, dst_w: u32, dst_h: u32) -> ndarray::Array3<u8> {
    use image::{imageops::FilterType, ImageBuffer, Rgb};
    let (h, w, _) = src.dim();
    let flat = src.as_slice().expect("Array3<u8> must be contiguous").to_vec();
    let src_img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(w as u32, h as u32, flat)
        .expect("ImageBuffer::from_raw with correct size");
    let resized = image::imageops::resize(&src_img, dst_w, dst_h, FilterType::Triangle);
    let raw = resized.into_raw();
    ndarray::Array3::from_shape_vec((dst_h as usize, dst_w as usize, 3), raw)
        .expect("resized Array3 shape must match")
}

/// Convert packed RGB u8 Array3 (H, W, 3) → f32 NCHW Array4 (1, 3, H, W) with
/// ImageNet normalization: `(px / 255 - mean) / std`.
#[cfg(feature = "vision-gpu")]
fn normalize_and_transpose(src: &ndarray::Array3<u8>) -> Array4<f32> {
    let (h, w, _) = src.dim();
    let mut out = Array4::<f32>::zeros((1, 3, h, w));
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let px = src[[y, x, c]] as f32 / 255.0;
                out[[0, c, y, x]] = (px - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
            }
        }
    }
    out
}

/// Debug utility: returns the expected output shape tuple `(1, 3, 768, 768)`.
/// Used in assertions / integration tests.
#[cfg(feature = "vision-gpu")]
pub fn expected_shape() -> (usize, usize, usize, usize) {
    (1, 3, FLORENCE2_INPUT_SIDE as usize, FLORENCE2_INPUT_SIDE as usize)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4b-5a-2: Florence-2 BART tokenizer
// ─────────────────────────────────────────────────────────────────────────────

/// Canonical Florence-2 task prompt for Stage 1 region proposal.
/// (See Microsoft Florence-2 model card task table.)
pub const REGION_PROPOSAL_PROMPT: &str = "<REGION_PROPOSAL>";

/// Result of tokenization. Both vectors have the same length (sequence length
/// after BART encoding, including BOS/EOS special tokens).
///
/// `input_ids` and `attention_mask` are `i64` because that is the dtype
/// Florence-2 ONNX models expect for these inputs (per HF model card).
#[derive(Debug, Clone)]
pub struct PromptTokens {
    pub input_ids: Vec<i64>,
    pub attention_mask: Vec<i64>,
}

impl PromptTokens {
    pub fn len(&self) -> usize {
        self.input_ids.len()
    }
    pub fn is_empty(&self) -> bool {
        self.input_ids.is_empty()
    }
}

/// Florence-2 BART tokenizer wrapper. Holds a loaded `tokenizers::Tokenizer`.
///
/// Loading is from a `tokenizer.json` file produced by HuggingFace tokenizers
/// (the format Microsoft ships at `microsoft/Florence-2-base/tokenizer.json`).
/// Network-based `from_pretrained` is intentionally NOT exposed.
pub struct Florence2Tokenizer {
    inner: tokenizers::Tokenizer,
}

impl Florence2Tokenizer {
    /// Load a Florence-2 tokenizer from a `tokenizer.json` file on disk.
    ///
    /// Errors:
    ///   - file not found / unreadable
    ///   - JSON parse / schema mismatch
    pub fn from_file(path: &std::path::Path) -> Result<Self, VisionBackendError> {
        let inner = tokenizers::Tokenizer::from_file(path)
            .map_err(|e| VisionBackendError::Other(format!(
                "Florence-2 tokenizer load failed for {}: {e}",
                path.display(),
            )))?;
        Ok(Self { inner })
    }

    /// Construct directly from an in-memory `tokenizers::Tokenizer`. Used in
    /// unit tests where we build a synthetic tokenizer programmatically.
    pub fn from_tokenizer(inner: tokenizers::Tokenizer) -> Self {
        Self { inner }
    }

    /// Encode the canonical `<REGION_PROPOSAL>` Stage 1 prompt.
    ///
    /// Equivalent to `tokenize_with_prompt(REGION_PROPOSAL_PROMPT)`.
    /// For Florence-2 BART, the typical output is `[BOS, <REGION_PROPOSAL>, EOS]`
    /// (sequence length 3) — but exact ids and length depend on the loaded
    /// tokenizer.json.
    pub fn tokenize_region_proposal(&self) -> Result<PromptTokens, VisionBackendError> {
        self.tokenize_with_prompt(REGION_PROPOSAL_PROMPT)
    }

    /// Encode an arbitrary prompt. `add_special_tokens = true` so BOS/EOS are
    /// added (BART convention).
    pub fn tokenize_with_prompt(&self, prompt: &str) -> Result<PromptTokens, VisionBackendError> {
        let encoding = self.inner.encode(prompt, true).map_err(|e| {
            VisionBackendError::Other(format!("Florence-2 tokenizer encode failed: {e}"))
        })?;
        let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        let attention_mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&m| m as i64)
            .collect();
        Ok(PromptTokens { input_ids, attention_mask })
    }
}

#[cfg(all(test, feature = "vision-gpu"))]
mod tokenizer_tests {
    use super::*;
    use tokenizers::{
        models::wordlevel::WordLevelBuilder,
        Tokenizer,
    };
    use std::collections::HashMap;

    /// Build a synthetic Florence-2-like tokenizer programmatically:
    /// vocab = {"<s>": 0, "<pad>": 1, "</s>": 2, "<unk>": 3, "<REGION_PROPOSAL>": 50267}
    /// uses WordLevel model (simple whole-word lookup, sufficient for special-token tests).
    /// Special tokens BOS=0, EOS=2 are added so encode("<REGION_PROPOSAL>") yields [0, 50267, 2].
    fn build_synthetic_tokenizer() -> Tokenizer {
        let mut vocab: HashMap<String, u32> = HashMap::new();
        vocab.insert("<s>".to_string(), 0);
        vocab.insert("<pad>".to_string(), 1);
        vocab.insert("</s>".to_string(), 2);
        vocab.insert("<unk>".to_string(), 3);
        vocab.insert("<REGION_PROPOSAL>".to_string(), 50267);
        let model = WordLevelBuilder::default()
            .vocab(vocab)
            .unk_token("<unk>".into())
            .build()
            .expect("WordLevel build");
        let mut tok = Tokenizer::new(model);
        // BART-style: BOS at start, EOS at end, controlled by post-processor.
        // For test simplicity we use TemplateProcessing.
        tok.with_post_processor(
            tokenizers::processors::template::TemplateProcessing::builder()
                .try_single("<s> $A </s>").unwrap()
                .special_tokens(vec![("<s>".into(), 0), ("</s>".into(), 2)])
                .build()
                .unwrap(),
        );
        tok.add_special_tokens(&[
            tokenizers::AddedToken::from("<s>", true),
            tokenizers::AddedToken::from("</s>", true),
            tokenizers::AddedToken::from("<REGION_PROPOSAL>", true),
        ]);
        tok
    }

    #[test]
    fn tokenize_region_proposal_returns_3_tokens_with_synthetic_tokenizer() {
        let tok = Florence2Tokenizer::from_tokenizer(build_synthetic_tokenizer());
        let prompts = tok.tokenize_region_proposal().unwrap();
        assert_eq!(prompts.input_ids.len(), 3);
        assert_eq!(prompts.attention_mask.len(), 3);
        assert_eq!(prompts.input_ids[0], 0);     // BOS
        assert_eq!(prompts.input_ids[1], 50267); // <REGION_PROPOSAL>
        assert_eq!(prompts.input_ids[2], 2);     // EOS
        assert!(prompts.attention_mask.iter().all(|&m| m == 1));
    }

    #[test]
    fn tokenize_arbitrary_prompt_works() {
        let tok = Florence2Tokenizer::from_tokenizer(build_synthetic_tokenizer());
        let res = tok.tokenize_with_prompt("<REGION_PROPOSAL>").unwrap();
        assert!(!res.is_empty());
        assert!(res.input_ids.iter().any(|&id| id == 50267));
    }

    #[test]
    fn prompt_tokens_len_matches_attention_mask() {
        let tok = Florence2Tokenizer::from_tokenizer(build_synthetic_tokenizer());
        let res = tok.tokenize_region_proposal().unwrap();
        assert_eq!(res.input_ids.len(), res.attention_mask.len());
        assert_eq!(res.len(), res.input_ids.len());
        assert!(!res.is_empty());
    }

    #[test]
    fn from_file_errors_when_path_missing() {
        let nonexistent = std::path::PathBuf::from("/nonexistent/tokenizer.json");
        let err = Florence2Tokenizer::from_file(&nonexistent).unwrap_err();
        assert!(format!("{err:?}").contains("tokenizer load failed"));
    }

    #[test]
    fn region_proposal_constant_matches_expected_value() {
        assert_eq!(REGION_PROPOSAL_PROMPT, "<REGION_PROPOSAL>");
    }

    #[test]
    fn prompt_tokens_i64_dtype_for_ort_compat() {
        // Verifies the return type is Vec<i64> (compile-time check via assignment).
        let tok = Florence2Tokenizer::from_tokenizer(build_synthetic_tokenizer());
        let res = tok.tokenize_region_proposal().unwrap();
        let _input_ids: &Vec<i64> = &res.input_ids;
        let _attn: &Vec<i64> = &res.attention_mask;
    }
}

#[cfg(all(test, feature = "vision-gpu"))]
mod tests {
    use super::*;
    use crate::vision_backend::types::Rect;

    fn synth_rgba(w: u32, h: u32, fill: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) { v.extend_from_slice(&fill); }
        v
    }

    #[test]
    fn preprocess_output_shape_is_1_3_768_768() {
        let buf = synth_rgba(100, 100, [128, 128, 128, 255]);
        let full = Rect { x: 0, y: 0, width: 100, height: 100 };
        let out = preprocess_image(&buf, 100, 100, &full).unwrap();
        assert_eq!(out.dim(), (1, 3, 768, 768));
    }

    #[test]
    fn preprocess_gray_image_gives_expected_normalized_values() {
        // 128/255 = 0.502
        // (0.502 - 0.485) / 0.229 ≈ 0.074 (R channel)
        // (0.502 - 0.456) / 0.224 ≈ 0.205 (G channel)
        // (0.502 - 0.406) / 0.225 ≈ 0.425 (B channel)
        let buf = synth_rgba(64, 64, [128, 128, 128, 255]);
        let full = Rect { x: 0, y: 0, width: 64, height: 64 };
        let out = preprocess_image(&buf, 64, 64, &full).unwrap();
        // Bilinear resize of uniform grey → all values stay near 128.
        // Check center pixel approximately matches per-channel expected.
        let r = out[[0, 0, 400, 400]];
        let g = out[[0, 1, 400, 400]];
        let b = out[[0, 2, 400, 400]];
        assert!((r - 0.074).abs() < 0.01, "R {r} not near 0.074");
        assert!((g - 0.205).abs() < 0.01, "G {g} not near 0.205");
        assert!((b - 0.425).abs() < 0.01, "B {b} not near 0.425");
    }

    #[test]
    fn preprocess_rejects_buffer_size_mismatch() {
        let buf = vec![0u8; 100]; // way too small
        let full = Rect { x: 0, y: 0, width: 100, height: 100 };
        let err = preprocess_image(&buf, 100, 100, &full).unwrap_err();
        assert!(format!("{err:?}").contains("length"));
    }

    #[test]
    fn preprocess_rejects_zero_dimensions() {
        let buf = vec![];
        let full = Rect { x: 0, y: 0, width: 0, height: 0 };
        let err = preprocess_image(&buf, 0, 0, &full).unwrap_err();
        assert!(format!("{err:?}").contains("non-zero"));
    }

    #[test]
    fn preprocess_empty_roi_falls_back_to_full_frame() {
        let buf = synth_rgba(10, 10, [200, 100, 50, 255]);
        // roi with zero width/height triggers full-frame fallback
        let roi = Rect { x: 0, y: 0, width: 0, height: 0 };
        let out = preprocess_image(&buf, 10, 10, &roi).unwrap();
        assert_eq!(out.dim(), (1, 3, 768, 768));
    }

    #[test]
    fn preprocess_out_of_bounds_roi_errs() {
        let buf = synth_rgba(10, 10, [0, 0, 0, 255]);
        let roi = Rect { x: 100, y: 100, width: 50, height: 50 };
        let err = preprocess_image(&buf, 10, 10, &roi).unwrap_err();
        assert!(format!("{err:?}").contains("empty"));
    }

    #[test]
    fn expected_shape_constant_matches_preprocess() {
        let buf = synth_rgba(50, 50, [0, 0, 0, 255]);
        let full = Rect { x: 0, y: 0, width: 50, height: 50 };
        let out = preprocess_image(&buf, 50, 50, &full).unwrap();
        assert_eq!(out.dim(), expected_shape());
    }
}
