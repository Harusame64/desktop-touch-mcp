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
//! Phase 4b-5a-3 scope (this batch):
//!   - `Florence2Stage1Sessions`: bundle of 4 ONNX sessions for Stage 1
//!   - `EncoderOutputs`: result of encoder forward pass
//!   - `encoder_forward`: vision_encoder → embed_tokens → encoder_model pipeline
//!   - `expect()` → `Result` upgrade for `resize_bilinear_rgb` (4b-5a-1 R1)
//!
//! Phase 4b-5a-4 scope (future):
//!   - Decoder + KV cache + autoregressive loop
//!
//! Phase 4b-5a-5 scope (future):
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
    let resized: ndarray::Array3<u8> = resize_bilinear_rgb(&crop_rgb, FLORENCE2_INPUT_SIDE, FLORENCE2_INPUT_SIDE)?;

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
/// Phase 4b-5a-3 R1: upgraded from expect() to Result to improve L5 panic safety.
#[cfg(feature = "vision-gpu")]
fn resize_bilinear_rgb(src: &ndarray::Array3<u8>, dst_w: u32, dst_h: u32) -> Result<ndarray::Array3<u8>, VisionBackendError> {
    use image::{imageops::FilterType, ImageBuffer, Rgb};
    let (h, w, _) = src.dim();
    let flat = src.as_slice()
        .ok_or_else(|| VisionBackendError::Other("Array3<u8> not contiguous".into()))?
        .to_vec();
    let src_img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(w as u32, h as u32, flat)
        .ok_or_else(|| VisionBackendError::Other("ImageBuffer::from_raw shape mismatch".into()))?;
    let resized = image::imageops::resize(&src_img, dst_w, dst_h, FilterType::Triangle);
    let raw = resized.into_raw();
    ndarray::Array3::from_shape_vec((dst_h as usize, dst_w as usize, 3), raw)
        .map_err(|e| VisionBackendError::Other(format!("resized Array3 shape mismatch: {e}")))
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
// Phase 4b-5a-3: Florence-2 Stage 1 multi-session + encoder forward
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "vision-gpu")]
use std::sync::Arc;

/// Bundle of 4 ONNX sessions composing Florence-2 Stage 1.
///
/// Phase 4b-5a-3 scope: vision_encoder / embed_tokens / encoder_model are
/// fully wired through `encoder_forward`. `decoder_model_merged` is loaded
/// (pool-resident) but not invoked here — Phase 4b-5a-4 connects it.
///
/// All four sessions live under composite keys in the global pool:
///   - `<base_key>::vision_encoder`
///   - `<base_key>::embed_tokens`
///   - `<base_key>::encoder_model`
///   - `<base_key>::decoder_model_merged`
/// where `<base_key>` is the session_key passed to `init_session_blocking`
/// (e.g. `"florence-2-base:dml-fp16"`).
#[cfg(feature = "vision-gpu")]
#[derive(Clone)]
pub struct Florence2Stage1Sessions {
    pub vision_encoder: Arc<crate::vision_backend::session::VisionSession>,
    pub embed_tokens: Arc<crate::vision_backend::session::VisionSession>,
    pub encoder_model: Arc<crate::vision_backend::session::VisionSession>,
    pub decoder_model_merged: Arc<crate::vision_backend::session::VisionSession>,
}

/// Output of `encoder_forward`. Both arrays are kept for use by
/// 4b-5a-4 decoder loop (`encoder_hidden_states` is the cross-attention
/// source, `encoder_attention_mask` is the mask for cross-attn).
#[cfg(feature = "vision-gpu")]
#[derive(Debug)]
pub struct EncoderOutputs {
    /// `[batch=1, total_seq, hidden_dim]` — concatenated vision + text
    /// embeddings after BART encoder. Total seq length = N_image_tokens + N_text_tokens.
    pub encoder_hidden_states: ndarray::Array3<f32>,
    /// `[batch=1, total_seq]` — 1s for valid positions. Image positions are
    /// always 1; text positions follow `prompt_tokens.attention_mask`.
    pub encoder_attention_mask: ndarray::Array2<i64>,
}

#[cfg(feature = "vision-gpu")]
impl Florence2Stage1Sessions {
    /// Try to acquire all 4 sub-sessions from the global pool by composite keys.
    /// Returns `None` if any one is missing — caller falls back to dummy stub.
    pub fn from_pool(base_key: &str) -> Option<Self> {
        let pool = crate::vision_backend::session_pool::global_pool();
        Some(Self {
            vision_encoder: pool.get(&format!("{base_key}::vision_encoder"))?,
            embed_tokens: pool.get(&format!("{base_key}::embed_tokens"))?,
            encoder_model: pool.get(&format!("{base_key}::encoder_model"))?,
            decoder_model_merged: pool.get(&format!("{base_key}::decoder_model_merged"))?,
        })
    }

    /// Run vision_encoder → embed_tokens → encoder_model in sequence and
    /// return concatenated encoder_hidden_states + the corresponding
    /// attention_mask suitable for the 4b-5a-4 decoder loop.
    ///
    /// Input shapes:
    ///   - `pixel_values`: `[1, 3, 768, 768]` (from `preprocess_image`)
    ///   - `prompt_tokens.input_ids`: `Vec<i64>` length = text seq len
    ///   - `prompt_tokens.attention_mask`: `Vec<i64>` length = same
    ///
    /// Output shapes (assuming Florence-2-base):
    ///   - encoder_hidden_states: `[1, 577 + text_seq, 768]`
    ///   - encoder_attention_mask: `[1, 577 + text_seq]`
    /// (577 image tokens is the DaViT output for 768x768 input — verified
    /// at runtime via shape inspection, not hardcoded as a constraint.)
    pub fn encoder_forward(
        &self,
        pixel_values: ndarray::Array4<f32>,
        prompt_tokens: &PromptTokens,
    ) -> Result<EncoderOutputs, VisionBackendError> {
        // Step 1: vision_encoder.run(pixel_values) → image_features [1, N_img, hidden]
        let image_features = run_vision_encoder(&self.vision_encoder, pixel_values)?;

        // Step 2: embed_tokens.run(input_ids) → text_embeds [1, N_text, hidden]
        let input_ids_array = ndarray::Array2::from_shape_vec(
            (1, prompt_tokens.input_ids.len()),
            prompt_tokens.input_ids.clone(),
        )
        .map_err(|e| VisionBackendError::Other(format!("input_ids reshape: {e}")))?;
        let text_embeds = run_embed_tokens(&self.embed_tokens, input_ids_array)?;

        // Step 3: concatenate along sequence dim (axis 1)
        if image_features.shape()[2] != text_embeds.shape()[2] {
            return Err(VisionBackendError::Other(format!(
                "hidden dim mismatch: vision_encoder={} vs embed_tokens={}",
                image_features.shape()[2],
                text_embeds.shape()[2],
            )));
        }
        let combined = ndarray::concatenate(
            ndarray::Axis(1),
            &[image_features.view(), text_embeds.view()],
        )
        .map_err(|e| VisionBackendError::Other(format!("concat: {e}")))?;

        // Step 4: build encoder_attention_mask = [1; N_img] ++ prompt_tokens.attention_mask
        let n_img = image_features.shape()[1];
        let n_text = text_embeds.shape()[1];
        let mut mask_vec: Vec<i64> = Vec::with_capacity(n_img + n_text);
        mask_vec.extend(std::iter::repeat(1i64).take(n_img));
        mask_vec.extend(prompt_tokens.attention_mask.iter().copied());
        let attention_mask = ndarray::Array2::from_shape_vec((1, n_img + n_text), mask_vec)
            .map_err(|e| VisionBackendError::Other(format!("mask reshape: {e}")))?;

        // Step 5: encoder_model.run(combined, attention_mask) → encoder_hidden_states
        let encoder_hidden_states = run_encoder_model(
            &self.encoder_model,
            combined,
            attention_mask.clone(),
        )?;

        Ok(EncoderOutputs {
            encoder_hidden_states,
            encoder_attention_mask: attention_mask,
        })
    }
}

/// Run vision_encoder.onnx with a single input tensor `pixel_values`.
/// Output: `image_features` of shape `[1, N_img, hidden_dim]`.
#[cfg(feature = "vision-gpu")]
fn run_vision_encoder(
    sess: &crate::vision_backend::session::VisionSession,
    pixel_values: ndarray::Array4<f32>,
) -> Result<ndarray::Array3<f32>, VisionBackendError> {
    use ort::value::Tensor;
    let pixel_tensor = Tensor::from_array(pixel_values)
        .map_err(|e| VisionBackendError::Other(format!("pixel_values tensor: {e}")))?;

    let mut session = sess.lock();
    let outputs = session
        .run(ort::inputs![ "pixel_values" => pixel_tensor ])
        .map_err(|e| VisionBackendError::Other(format!("vision_encoder run: {e}")))?;
    let (_, output_tensor) = outputs
        .iter()
        .next()
        .ok_or_else(|| VisionBackendError::Other("vision_encoder returned no outputs".into()))?;
    let view = output_tensor
        .try_extract_array::<f32>()
        .map_err(|e| VisionBackendError::Other(format!("vision_encoder output extract: {e}")))?;
    let array3 = view
        .into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| VisionBackendError::Other(format!("vision_encoder output dim: {e}")))?
        .to_owned();
    Ok(array3)
}

/// Run embed_tokens.onnx with `input_ids: [1, N_text]` (i64).
/// Output: `inputs_embeds` of shape `[1, N_text, hidden_dim]`.
#[cfg(feature = "vision-gpu")]
fn run_embed_tokens(
    sess: &crate::vision_backend::session::VisionSession,
    input_ids: ndarray::Array2<i64>,
) -> Result<ndarray::Array3<f32>, VisionBackendError> {
    use ort::value::Tensor;
    let input_tensor = Tensor::from_array(input_ids)
        .map_err(|e| VisionBackendError::Other(format!("input_ids tensor: {e}")))?;

    let mut session = sess.lock();
    let outputs = session
        .run(ort::inputs![ "input_ids" => input_tensor ])
        .map_err(|e| VisionBackendError::Other(format!("embed_tokens run: {e}")))?;
    let (_, output_tensor) = outputs
        .iter()
        .next()
        .ok_or_else(|| VisionBackendError::Other("embed_tokens returned no outputs".into()))?;
    let view = output_tensor
        .try_extract_array::<f32>()
        .map_err(|e| VisionBackendError::Other(format!("embed_tokens output extract: {e}")))?;
    let array3 = view
        .into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| VisionBackendError::Other(format!("embed_tokens output dim: {e}")))?
        .to_owned();
    Ok(array3)
}

/// Run encoder_model.onnx with combined inputs_embeds + attention_mask.
/// Output: `encoder_hidden_states` of shape `[1, total_seq, hidden_dim]`.
///
/// Note on input names: Florence-2 BART encoder ONNX export uses
/// `inputs_embeds` (not `input_ids`) when given pre-computed embeddings.
#[cfg(feature = "vision-gpu")]
fn run_encoder_model(
    sess: &crate::vision_backend::session::VisionSession,
    inputs_embeds: ndarray::Array3<f32>,
    attention_mask: ndarray::Array2<i64>,
) -> Result<ndarray::Array3<f32>, VisionBackendError> {
    use ort::value::Tensor;
    let embeds_tensor = Tensor::from_array(inputs_embeds)
        .map_err(|e| VisionBackendError::Other(format!("inputs_embeds tensor: {e}")))?;
    let mask_tensor = Tensor::from_array(attention_mask)
        .map_err(|e| VisionBackendError::Other(format!("attention_mask tensor: {e}")))?;

    let mut session = sess.lock();
    let outputs = session
        .run(ort::inputs![
            "inputs_embeds" => embeds_tensor,
            "attention_mask" => mask_tensor,
        ])
        .map_err(|e| VisionBackendError::Other(format!("encoder_model run: {e}")))?;
    let (_, output_tensor) = outputs
        .iter()
        .next()
        .ok_or_else(|| VisionBackendError::Other("encoder_model returned no outputs".into()))?;
    let view = output_tensor
        .try_extract_array::<f32>()
        .map_err(|e| VisionBackendError::Other(format!("encoder_model output extract: {e}")))?;
    let array3 = view
        .into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| VisionBackendError::Other(format!("encoder_model output dim: {e}")))?
        .to_owned();
    Ok(array3)
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

#[cfg(all(test, feature = "vision-gpu"))]
mod encoder_tests {
    use super::*;
    use ndarray::{Array2, Array3};
    use crate::vision_backend::types::Rect;

    #[test]
    fn florence2_stage1_sessions_from_pool_returns_none_when_keys_absent() {
        // Empty pool (or keys absent) → from_pool returns None.
        let result = Florence2Stage1Sessions::from_pool("nonexistent:variant");
        assert!(result.is_none());
    }

    #[test]
    fn encoder_outputs_struct_fields_accessible() {
        let outputs = EncoderOutputs {
            encoder_hidden_states: Array3::<f32>::zeros((1, 580, 768)),
            encoder_attention_mask: Array2::<i64>::ones((1, 580)),
        };
        assert_eq!(outputs.encoder_hidden_states.shape(), &[1, 580, 768]);
        assert_eq!(outputs.encoder_attention_mask.shape(), &[1, 580]);
        assert!(outputs.encoder_attention_mask.iter().all(|&v| v == 1));
    }

    #[test]
    fn encoder_outputs_hidden_dim_matches_mask_len() {
        // Verify that shape[1] of encoder_hidden_states == shape[1] of mask
        // (the invariant asserted in stub_recognise_with_session).
        let n = 583usize; // 577 image tokens + 3 text tokens + BOS/EOS variation
        let outputs = EncoderOutputs {
            encoder_hidden_states: Array3::<f32>::zeros((1, n, 768)),
            encoder_attention_mask: Array2::<i64>::ones((1, n)),
        };
        assert_eq!(
            outputs.encoder_hidden_states.shape()[1],
            outputs.encoder_attention_mask.shape()[1],
        );
        assert_eq!(outputs.encoder_hidden_states.shape()[0], 1);
        assert_eq!(outputs.encoder_attention_mask.shape()[0], 1);
    }

    #[test]
    fn preprocess_image_is_still_panic_safe_after_result_refactor() {
        // 4b-5a-1 R1 fix: previously expect() panicked on edge cases,
        // now returns Result. Verify a 0-sized buffer produces Err not panic.
        let buf = vec![];
        let roi = Rect { x: 0, y: 0, width: 0, height: 0 };
        let result = preprocess_image(&buf, 0, 0, &roi);
        assert!(result.is_err());
    }

    #[test]
    fn encoder_outputs_debug_impl_works() {
        // Verify #[derive(Debug)] on EncoderOutputs compiles and formats without panic.
        let outputs = EncoderOutputs {
            encoder_hidden_states: Array3::<f32>::zeros((1, 2, 4)),
            encoder_attention_mask: Array2::<i64>::ones((1, 2)),
        };
        let s = format!("{outputs:?}");
        assert!(s.contains("encoder_hidden_states"));
        assert!(s.contains("encoder_attention_mask"));
    }

    // Note: Full encoder_forward() integration test requires real ort::Session
    // instances (not constructible without ONNX files). Manually verified at
    // dogfood with real Florence-2-base artifact (handbook §6.4 cargo test
    // 制約受容、4b-5a-1 post-review addendum 通り).
}
