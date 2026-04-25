# Phase 4b-5a-3 設計書 — Florence-2 Stage 1 multi-session loading + encoder forward

- Status: Implemented (2026-04-25、commits 91a18d9〜1851e71)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D1' (Rust backend) / D5' Stage 1 (Florence-2-base region proposer)
- 対応 ADR-005 §5 batch: 4b-5a-3 (Florence-2 Stage 1 の sub-sub-batch 3/5、当初 4/4 から再分割)
- 前提 commits: `c4a9a7f`〜`951d6ed` (Phase 4a + 4b-1 + 4b-3 + 4b-4 + 4b-5 + 4b-5a-1 + 4b-5a-2 完了)
- 期待工数: **3-4 日 (Sonnet 実装、Rust 中心)**

---

## 1. Goal

Florence-2 Stage 1 の **encoder side のみ** を実装する: `vision_encoder.onnx` →
`embed_tokens.onnx` → `encoder_model.onnx` を直列で動かし、
`encoder_hidden_states` Array3<f32> を取得できる状態にする。
Decoder + KV cache + autoregressive loop は **4b-5a-4 に分離** (scope 過大のため、
ユーザー承認済の再分割)。`<loc_X>` parse → RawCandidate は **4b-5a-5** (旧 4b-5a-4)。

同時に 4b-5a-2 review の **RECOMMEND R1** (`tokenizers` / `image` / `ndarray` を
`optional = true` + `vision-gpu` feature gate に refactor) を本 batch でまとめて対応。

単一目標:

> `Florence2Stage1Sessions::from_root_path(<model_root>, profile)` が 4 つの ONNX
> session (vision_encoder / embed_tokens / encoder_model / decoder_model_merged) を
> ロードして pool に登録し、`encoder_forward(pixel_values, &prompt_tokens)` が
> `EncoderOutputs { encoder_hidden_states, encoder_attention_mask }` を返す。
> `stub_recognise_with_session` で florence-2-base session_key + frame_buffer + tokenizer
> 揃うとき preprocess + tokenize + encoder_forward の **3 ステップ** を実行し、
> shape を log/debug_assert で確認する。Decoder 接続無し、stub fall through で
> 既存 dummy candidates を返す。

### 明示的に本 batch の scope 外

- Decoder forward + KV cache + autoregressive loop — **4b-5a-4**
- `<loc_X>` token sequence parse → bbox 変換 — **4b-5a-5** (旧 4b-5a-4)
- OmniParser-v2 (Stage 2) / PaddleOCR-v4 (Stage 3) — **4b-5b / 4b-5c**
- DXGI zero-copy 統合 — Phase 4c
- Real Florence-2 ONNX artifact ダウンロード自動化

---

## 2. Files to touch

### 新規作成

(なし — 全て既存ファイルへの追加 + Cargo.toml refactor)

### 変更

| Path:行 | 変更内容 |
|---|---|
| `Cargo.toml [dependencies]` | `image` / `ndarray` / `tokenizers` を `optional = true` に変更、`[features] vision-gpu` の依存に追加 (R1 refactor) |
| `src/vision_backend/florence2.rs` | `Florence2Stage1Sessions` struct、`EncoderOutputs` struct、`from_root_path` / `encoder_forward` method、ndarray ↔ ort::Tensor 変換 utility 関数追加 |
| `src/vision_backend/mod.rs::init_session_blocking` | `init.session_key.starts_with("florence-2-base:")` 分岐で `init_florence2_stage1_blocking` を呼ぶ helper 追加。multi-file ロード後に pool に 4 entry insert |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | florence-2-base session_key + frame_buffer + tokenizer 揃うとき pool から 4 sub-session を取得、`encoder_forward` を呼んで shape 確認、既存 dummy 返却 |
| `src/vision_backend/florence2.rs::preprocess_image` 等の `expect()` 4 箇所 | `Result` 経路に格上げ (4b-5a-1 RECOMMEND R1) |
| `docs/visual-gpu-backend-adr-v2.md §5` | 4b-5a sub-batch 構成を `4b-5a-1〜4` から `4b-5a-1〜5` に再番号付け (旧 4b-5a-4 を 4b-5a-5 に rename)、4b-5a-3 `[x]` flip + summary |

### 削除禁止

- Phase 4a/4b-1/4b-3/4b-4/4b-5/4b-5a-1/4b-5a-2 skeleton 全て (handbook §4.3)
- `Florence2Tokenizer` / `PromptTokens` / `REGION_PROPOSAL_PROMPT` (4b-5a-2 成果物)
- `preprocess_image` / `expected_shape` / `FLORENCE2_INPUT_SIDE` (4b-5a-1 成果物、`expect()` の Result 化は signature 不変、内部 logic のみ修正)
- `catch_unwind` barrier (inference.rs / session.rs) (L5)
- Phase 4b-5 post-review の legacy path / typeof guard (4b-5c 完了時まで維持)

### Forbidden な依存追加

- 新 npm package 禁止
- 新 Rust crate 追加禁止 (本 batch は **既存 dep の optional 化のみ**、新 crate は追加しない)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

---

## 3. API design

### 3.1 Cargo.toml — optional dep refactor (R1)

```toml
[dependencies]
napi = { version = "2", default-features = false, features = ["napi8"] }
napi-derive = "2"
crossbeam-channel = "0.5"

# Visual GPU Phase 4 (ADR-005) ─────────────────────────────────
ort = { version = "=2.0.0-rc.12", default-features = false, features = [
    "std", "ndarray", "tracing", "load-dynamic", "tls-rustls",
    "directml", "api-22",
], optional = true }

# Phase 4b-5a-1: image preprocessing — gated under vision-gpu
image = { version = "0.25", default-features = false, features = ["png"], optional = true }

# Phase 4b-5a-1: ndarray (transitive of ort, explicit for direct use) — gated
ndarray = { version = "0.17", optional = true }

# Phase 4b-5a-2: Florence-2 BART tokenizer — gated
tokenizers = { version = "0.21", default-features = false, features = ["onig"], optional = true }

[features]
default = ["vision-gpu"]
# vision-gpu pulls in ort + image + ndarray + tokenizers in lockstep.
vision-gpu = ["dep:ort", "dep:image", "dep:ndarray", "dep:tokenizers"]
# Opt-in EPs (ADR-005 D2' Layer 2 cascade) — unchanged
vision-gpu-cuda     = ["vision-gpu", "ort/cuda"]
vision-gpu-tensorrt = ["vision-gpu", "ort/tensorrt"]
vision-gpu-rocm     = ["vision-gpu", "ort/rocm"]
vision-gpu-migraphx = ["vision-gpu", "ort/migraphx"]
vision-gpu-coreml   = ["vision-gpu", "ort/coreml"]
vision-gpu-openvino = ["vision-gpu", "ort/openvino"]
vision-gpu-webgpu   = ["vision-gpu", "ort/webgpu"]
vision-gpu-winml    = ["vision-gpu"]
```

**効果**: `cargo build --no-default-features` で `image` / `ndarray` / `tokenizers` /
`ort` は **完全に dep として解決されない** (linker dead-strip ではなく compile 時に未参照)。
バイナリサイズ ~10MB 削減見込み。Phase 1-3 のみ build に有効。

### 3.2 Rust: `Florence2Stage1Sessions` struct (florence2.rs 追加)

```rust
use std::path::Path;
use std::sync::Arc;

use ndarray::{Array2, Array3, Array4, Axis};

use crate::vision_backend::capability::CapabilityProfile;
use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::session::VisionSession;
use crate::vision_backend::session_pool::global_pool;

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
#[derive(Clone)]
pub struct Florence2Stage1Sessions {
    pub vision_encoder: Arc<VisionSession>,
    pub embed_tokens: Arc<VisionSession>,
    pub encoder_model: Arc<VisionSession>,
    pub decoder_model_merged: Arc<VisionSession>,
}

/// Output of `encoder_forward`. Both arrays are kept for use by
/// 4b-5a-4 decoder loop (`encoder_hidden_states` is the cross-attention
/// source, `encoder_attention_mask` is the mask for cross-attn).
#[derive(Debug)]
pub struct EncoderOutputs {
    /// `[batch=1, total_seq, hidden_dim]` — concatenated vision + text
    /// embeddings after BART encoder. Total seq length = N_image_tokens + N_text_tokens.
    pub encoder_hidden_states: Array3<f32>,
    /// `[batch=1, total_seq]` — 1s for valid positions. Image positions are
    /// always 1; text positions follow `prompt_tokens.attention_mask`.
    pub encoder_attention_mask: Array2<i64>,
}

impl Florence2Stage1Sessions {
    /// Try to acquire all 4 sub-sessions from the global pool by composite keys.
    /// Returns `None` if any one is missing — caller falls back to dummy stub.
    pub fn from_pool(base_key: &str) -> Option<Self> {
        let pool = global_pool();
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
        pixel_values: Array4<f32>,
        prompt_tokens: &PromptTokens,
    ) -> Result<EncoderOutputs, VisionBackendError> {
        // Step 1: vision_encoder.run(pixel_values) → image_features [1, N_img, hidden]
        let image_features = run_vision_encoder(&self.vision_encoder, pixel_values)?;

        // Step 2: embed_tokens.run(input_ids) → text_embeds [1, N_text, hidden]
        let input_ids_array = Array2::from_shape_vec(
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
            Axis(1),
            &[image_features.view(), text_embeds.view()],
        )
        .map_err(|e| VisionBackendError::Other(format!("concat: {e}")))?;

        // Step 4: build encoder_attention_mask = [1; N_img] ++ prompt_tokens.attention_mask
        let n_img = image_features.shape()[1];
        let n_text = text_embeds.shape()[1];
        let mut mask_vec: Vec<i64> = Vec::with_capacity(n_img + n_text);
        mask_vec.extend(std::iter::repeat(1i64).take(n_img));
        mask_vec.extend(prompt_tokens.attention_mask.iter().copied());
        let attention_mask = Array2::from_shape_vec((1, n_img + n_text), mask_vec)
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
fn run_vision_encoder(
    sess: &VisionSession,
    pixel_values: Array4<f32>,
) -> Result<Array3<f32>, VisionBackendError> {
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
fn run_embed_tokens(
    sess: &VisionSession,
    input_ids: Array2<i64>,
) -> Result<Array3<f32>, VisionBackendError> {
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
fn run_encoder_model(
    sess: &VisionSession,
    inputs_embeds: Array3<f32>,
    attention_mask: Array2<i64>,
) -> Result<Array3<f32>, VisionBackendError> {
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
```

### 3.3 Rust: `init_florence2_stage1_blocking` (mod.rs 内)

```rust
// mod.rs に追加
pub fn init_session_blocking(init: NativeSessionInit) -> NativeSessionResult {
    if let Err(e) = dylib::ensure_ort_initialized() {
        return NativeSessionResult { /* error */ };
    }

    // Phase 4b-5a-3: florence-2-base needs 4 sibling ONNX files.
    if init.session_key.starts_with("florence-2-base:") {
        return init_florence2_stage1_blocking(init);
    }

    // Single-file path (existing behaviour for non-Florence-2 stages)
    let path = std::path::Path::new(&init.model_path);
    match session::VisionSession::create(path, &init.profile, init.session_key.clone()) {
        Ok(sess) => {
            let label = sess.selected_ep_label();
            crate::vision_backend::session_pool::global_pool()
                .insert(init.session_key.clone(), std::sync::Arc::new(sess));
            NativeSessionResult { ok: true, selected_ep: label, error: None, session_key: init.session_key }
        }
        Err(e) => NativeSessionResult { /* error */ },
    }
}

/// Multi-file Florence-2 Stage 1 loader. Looks for 4 sibling ONNX files
/// in the parent directory of `model_path` and loads each into the pool
/// under composite keys `<base_key>::<file_stem>`.
fn init_florence2_stage1_blocking(init: NativeSessionInit) -> NativeSessionResult {
    let model_path = std::path::Path::new(&init.model_path);
    let root = match model_path.parent() {
        Some(p) => p,
        None => return NativeSessionResult {
            ok: false,
            selected_ep: String::new(),
            error: Some(format!("model_path has no parent: {}", init.model_path)),
            session_key: init.session_key,
        },
    };

    const FILES: &[&str] = &[
        "vision_encoder.onnx",
        "embed_tokens.onnx",
        "encoder_model.onnx",
        "decoder_model_merged.onnx",
    ];
    let mut sessions: Vec<(String, std::sync::Arc<session::VisionSession>)> = Vec::with_capacity(4);
    let mut last_label = String::new();
    for &fname in FILES {
        let path = root.join(fname);
        let stem = fname.trim_end_matches(".onnx");
        let sub_key = format!("{}::{stem}", init.session_key);
        match session::VisionSession::create(&path, &init.profile, sub_key.clone()) {
            Ok(sess) => {
                last_label = sess.selected_ep_label();
                sessions.push((sub_key, std::sync::Arc::new(sess)));
            }
            Err(e) => {
                return NativeSessionResult {
                    ok: false,
                    selected_ep: String::new(),
                    error: Some(format!("florence-2-base sub-session {fname}: {e}")),
                    session_key: init.session_key,
                };
            }
        }
    }
    let pool = crate::vision_backend::session_pool::global_pool();
    for (key, sess) in sessions {
        pool.insert(key, sess);
    }
    NativeSessionResult {
        ok: true,
        selected_ep: last_label,
        error: None,
        session_key: init.session_key,
    }
}
```

### 3.4 Rust: `stub_recognise_with_session` の encoder forward 追加

```rust
fn stub_recognise_with_session(
    req: RecognizeRequest,
    sess: std::sync::Arc<crate::vision_backend::session::VisionSession>,
) -> Vec<RawCandidate> {
    if sess.session_key.starts_with("florence-2-base:") && !req.frame_buffer.is_empty() {
        // Phase 4b-5a-3: try full encoder pipeline if all sub-sessions and tokenizer are present.
        if let Some(stage1) = crate::vision_backend::florence2::Florence2Stage1Sessions::from_pool(&sess.session_key) {
            // Step 1: preprocess (4b-5a-1)
            let pixel_values = match crate::vision_backend::florence2::preprocess_image(
                &req.frame_buffer,
                req.frame_width,
                req.frame_height,
                req.rois.first().map(|r| &r.rect).unwrap_or(&Rect {
                    x: 0, y: 0,
                    width: req.frame_width as i32,
                    height: req.frame_height as i32,
                }),
            ) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[florence2] preprocess failed: {e}");
                    return dummy_recognise(req);
                }
            };

            // Step 2: tokenize (4b-5a-2)
            if let Some(tokenizer_path) = tokenizer_path_for_session(&sess) {
                if tokenizer_path.exists() {
                    match crate::vision_backend::florence2::Florence2Tokenizer::from_file(&tokenizer_path) {
                        Ok(tok) => match tok.tokenize_region_proposal() {
                            Ok(prompt_tokens) => {
                                // Step 3 (Phase 4b-5a-3): encoder forward
                                match stage1.encoder_forward(pixel_values, &prompt_tokens) {
                                    Ok(enc) => {
                                        debug_assert_eq!(enc.encoder_hidden_states.shape()[0], 1);
                                        debug_assert_eq!(enc.encoder_attention_mask.shape()[0], 1);
                                        debug_assert_eq!(
                                            enc.encoder_hidden_states.shape()[1],
                                            enc.encoder_attention_mask.shape()[1],
                                        );
                                        // Phase 4b-5a-4 will pass `enc` to the decoder loop here.
                                    }
                                    Err(e) => eprintln!("[florence2] encoder_forward failed: {e}"),
                                }
                            }
                            Err(e) => eprintln!("[florence2] tokenize failed: {e}"),
                        },
                        Err(e) => eprintln!("[florence2] tokenizer load failed: {e}"),
                    }
                }
            }
        }
    }
    dummy_recognise(req)
}
```

### 3.5 `expect()` の Result 化 (4b-5a-1 RECOMMEND R1)

`florence2.rs::preprocess_image` 内の 4 箇所:

```rust
// Before
let flat = src.as_slice().expect("Array3<u8> must be contiguous").to_vec();
let src_img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(w as u32, h as u32, flat)
    .expect("ImageBuffer::from_raw with correct size");
ndarray::Array3::from_shape_vec((dst_h as usize, dst_w as usize, 3), raw)
    .expect("resized Array3 shape must match")

// After (Result-based)
let flat = src.as_slice()
    .ok_or_else(|| VisionBackendError::Other("Array3<u8> not contiguous".into()))?
    .to_vec();
let src_img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(w as u32, h as u32, flat)
    .ok_or_else(|| VisionBackendError::Other("ImageBuffer::from_raw shape mismatch".into()))?;
ndarray::Array3::from_shape_vec((dst_h as usize, dst_w as usize, 3), raw)
    .map_err(|e| VisionBackendError::Other(format!("resized Array3 shape mismatch: {e}")))?
```

`resize_bilinear_rgb` / `extract_crop_rgb` / `normalize_and_transpose` を
`Result<Array3<u8>, VisionBackendError>` 等に return 型を変更。
ただし**呼び出し元 `preprocess_image` の signature は不変** (handbook §9.1 維持)。

---

## 4. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0 — **重要**: image/ndarray/tokenizers が解決されないことを確認
- [ ] `tsc --noEmit` exit 0
- [ ] `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 既存全パス
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 既存全パス
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` regression 0
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` regression 0
- [ ] 最終 `npm run test:capture -- --force` regression 0
- [ ] ADR-005 §5 4b-5a sub-batch 構成を `1〜5` に再番号付け (旧 4b-5a-4 → 4b-5a-5)、4b-5a-3 `[x]` flip + summary
- [ ] 本設計書 Status を `Implemented (2026-04-??、commit hash)` に
- [ ] Opus self-review BLOCKING 0
- [ ] Rust 4-6 ケース新規 encoder test を `florence2.rs::encoder_tests` に追加 (mock 不可な箇所はコード読解 + cargo check で代替、handbook §6.4 前例)

---

## 5. Test cases

### 5.1 Rust unit tests (`florence2.rs::encoder_tests`)

実 ort::Session を構築できないので、本 batch のテストは **API contract** に集中:

```rust
#[cfg(all(test, feature = "vision-gpu"))]
mod encoder_tests {
    use super::*;

    #[test]
    fn florence2_stage1_sessions_from_pool_returns_none_when_keys_absent() {
        // Empty pool → from_pool returns None
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
    fn florence2_stage1_sessions_is_clone() {
        // Compile-time check: Florence2Stage1Sessions: Clone
        // (we can't construct one without sessions, but we can verify Arc fields)
    }

    // Note: Full encoder_forward() integration test requires real ort::Session
    // instances (not constructible without ONNX files). Manually verified at
    // dogfood with real Florence-2-base artifact (handbook §6.4 cargo test
    // 制約受容、4b-5a-1 post-review addendum 通り).

    #[test]
    fn preprocess_image_is_still_panic_safe_after_result_refactor() {
        // 4b-5a-1 R1 fix: previously expect() panicked on edge cases,
        // now returns Result. Verify a 0-sized buffer produces Err not panic.
        let buf = vec![];
        let roi = Rect { x: 0, y: 0, width: 0, height: 0 };
        let result = preprocess_image(&buf, 0, 0, &roi);
        assert!(result.is_err());
    }
}
```

### 5.2 既存テストの維持

- `tokenizer_tests` (4b-5a-2) 6 ケース: 全パス維持
- `tests` (4b-5a-1) 7 ケース: `expect()` を `Result` に変えても挙動同じ、全パス維持
- TS 側: 本 batch で touch 無し、regression 0

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| `ort::inputs!` macro の input name 文字列指定で typo | コメント明記、real artifact で manual verify (4b-5a-3 dogfood) |
| `Tensor::from_array` が Owned ndarray のみ受付 | `Array4<f32>` は所有権持って受け取る、move OK |
| `Session::run` が `&mut self` 要求 → `MutexGuard<ort::Session>` で OK | 既設の `VisionSession::lock()` MutexGuard 経由 |
| 同時に 4 session を pool に insert する atomic 性 | Mutex<HashMap> なので 4 回 insert は逐次。1 つ目成功 / 4 つ目失敗 で部分挿入される可能性あり。本 batch は **失敗時に既挿入分を rollback しない** (途中失敗時は NativeSessionResult で `ok: false`、TS 側 ensureWarm が evicted へ遷移、process 再起動で pool clear)。許容 |
| Florence-2 ONNX export の入力名が `inputs_embeds` ではなく `input_ids` だった場合 | 設計書 §3.2 のコメント明記、実 artifact で confirm が必要。runtime error なら入力名 retry list で対応 (4b-5a-3 dogfood verify で確定) |
| vision_encoder の出力 shape が想定 `[1, 577, 768]` と異なる | 入力サイズ依存、ndarray::Ix3 への dimensionality 変換が失敗時 Err、stub fall through |
| `ndarray::concatenate` が hidden_dim 不一致で失敗 | 明示 check (`shape()[2] != shape()[2]` 比較) で先に Err |
| BART encoder が `attention_mask` を `i64` ではなく `u8` 期待 | HF ONNX export では i64 が標準。failure 時は `Array2<i64>` → `Array2<u8>` 変換を Sonnet 判断 (§8) |
| past_key_values が encoder_model から output される (init 値) | 4b-5a-3 では encoder_model output の最初の output (encoder_hidden_states) のみ取得、past_key_values は無視 (4b-5a-4 で decoder 用に取得) |
| `into_dimensionality::<Ix3>` が失敗するケース (例: encoder が batch dim を squeeze) | error 経路で `eprintln!` + fall through。次 batch で実 model 確認 |
| Cargo.toml refactor で既存 cfg(feature) gating が漏れる | `florence2.rs` 全体 + `inference.rs::stub_recognise_with_session` の florence2 関連 block を `#[cfg(feature = "vision-gpu")]` で確実に gate |
| `--no-default-features` build で `vision_backend::florence2` に未使用警告 | `pub mod florence2;` 自体を `#[cfg(feature = "vision-gpu")]` で gate |

---

## 7. Acceptable Sonnet judgment scope

- ort 2.0.0-rc.12 の `inputs!` macro 構文と `Session::run` 戻り値の正確な扱い (docs.rs/ort 確認)
- input/output name の HF Florence-2 export 規約確認 (`pixel_values` / `input_ids` / `inputs_embeds` / `attention_mask` / `last_hidden_state` / `encoder_hidden_states` の正確な名前)
- ndarray 0.17 の `concatenate` API 変更時の adjustment
- 4b-5a-1 RECOMMEND R1 の Result 格上げにおける error message wording
- `encoder_tests` mod 内の追加テスト判断 (§5.1 4 ケースを超える +α は OK)
- commit 分割 (3-4 commit 推奨: Cargo refactor / florence2 encoder / inference wire / docs)
- `florence-2-base:` prefix 判定の正確な match (`starts_with` で十分か、`split_once(':')` で先頭チェックすべきか — 現状 `starts_with` で OK、Sonnet 判断)
- `init_florence2_stage1_blocking` 内 sessions Vec の領域確保 (`Vec::with_capacity(4)` 等)

---

## 8. Forbidden Sonnet judgments

### 8.1 API surface 変更
- `VisualBackend` interface 不変
- `ModelRegistry` / `ModelManifest` 不変
- `RecognizeRequest` / `NativeRecognizeRequest` 不変 (本 batch は Rust-only)
- `VisionSession::create` signature 不変
- `Florence2Tokenizer` / `PromptTokens` / `preprocess_image` 等の 4b-5a-1/2 成果物 signature 不変 (`expect()` を Result に変えるのは内部のみ、public signature 維持)
- `SelectedEp` / `EpName` / `RawCandidate` / `UiEntityCandidate` 不変
- `VisionSessionPool::insert/get/remove` signature 不変

### 8.2 Scope 変更
- Decoder forward / KV cache / autoregressive loop 実装禁止 (4b-5a-4)
- `<loc_X>` parse 実装禁止 (4b-5a-5)
- OmniParser-v2 / PaddleOCR-v4 実装禁止
- DXGI zero-copy 実装禁止
- HF Hub network 連携禁止
- `assets/models.json` schema 変更禁止 (multi-file 解決は convention で対応)
- Phase 4a/4b-1/4b-3/4b-4/4b-5/4b-5a-1/4b-5a-2 成果物変更禁止 (`expect()` の Result 化のみ例外、handbook §9.1 signature 不変条件下)

### 8.3 依存追加禁止
- 新 npm package 禁止
- 新 Rust crate 追加禁止
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止
- 既存 dep の version up は scope 外 (Cargo.toml 触れるが optional 化のみ、version は据え置き)

### 8.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)
- 4b-5a-1 `tests` 内 `expect_err` パターンが Result 化で `assert!(result.is_err())` に変わる場合は **API 変更に伴う accuracy 追従** として許容 (logic 不変)
- 新規 test は `florence2.rs` 内 `mod encoder_tests` 追加のみ

### 8.5 絶対不変
- `catch_unwind` barrier 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止
- Phase 4b-5 post-review legacy path / typeof guard (4b-5c 完了時まで維持)
- 4b-5a-1 post-review addendum「cargo test 実行不可受容」基準継承

### 8.6 ドキュメント更新義務
- ADR-005 §5 の 4b-5a sub-batch を `1〜5` に再番号付け (旧 4b-5a-4 を 4b-5a-5 に rename、新 4b-5a-3 / 4b-5a-4 を挿入)
- 4b-5a-3 `[x]` flip + summary
- 本設計書 Status を `Implemented (2026-04-??、commit hash)` に

---

## 9. Future work / 次 batch への hand-off

### 9.1 Phase 4b-5a-4 (decoder + KV cache + loop)

- `Florence2Stage1Sessions::decoder_forward` method 追加
- 24+ KV cache tensor の動的管理 (BART 6 layers × 4 tensor each)
- Autoregressive loop with greedy decode (max_length=1024、EOS で break)
- `decoder_model_merged.onnx` を `use_cache_branch` input で initial / cached 両対応
- 出力: `Vec<i64>` token IDs

### 9.2 Phase 4b-5a-5 (parse + RawCandidate)

- `tokenizers::Tokenizer::decode(token_ids)` で text 復元
- `<loc_X>` (X=0..999) special token を quantized coordinate として parse
- Rect 復元 + class label assignment (region/form/panel/toolbar 等)
- `stub_recognise_with_session` から `florence2_stage1_recognise` への分離 (florence-2-base session_key 分岐内、本格 inference 経路完成)
- 4b-5a-2 RECOMMEND R3 (`eprintln!` → `tracing::warn!`) を一括対応

### 9.3 4b-5b (OmniParser-v2)

- Stage 2 の単純 detection モデル (single-pass YOLO-like)
- 本 batch で確立した tensor I/O / multi-session pattern を活用

---

## 10. 実装順序 (Sonnet 手順)

### Cargo.toml refactor (R1)

1. `Cargo.toml [dependencies]` で `image` / `ndarray` / `tokenizers` に `optional = true` 追加
2. `[features] vision-gpu = ["dep:ort", "dep:image", "dep:ndarray", "dep:tokenizers"]` 修正
3. `cargo check --release --no-default-features` で image/ndarray/tokenizers が解決されないこと確認

### Rust 側 — encoder side

4. `src/vision_backend/florence2.rs` に §3.2 の `Florence2Stage1Sessions` / `EncoderOutputs` / `from_pool` / `encoder_forward` / 3 helper 関数 (`run_vision_encoder` / `run_embed_tokens` / `run_encoder_model`) 追加
5. `src/vision_backend/mod.rs` に §3.3 の `init_florence2_stage1_blocking` 追加、`init_session_blocking` に prefix 分岐挿入
6. `src/vision_backend/inference.rs::stub_recognise_with_session` を §3.4 通り改修 (preprocess + tokenize + encoder_forward の 3 段階を実行)
7. `src/vision_backend/florence2.rs` の `expect()` 4 箇所を Result 経路に格上げ (§3.5、4b-5a-1 RECOMMEND R1)
8. `cargo check --release --features vision-gpu` exit 0
9. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
10. `cargo check --release --no-default-features` exit 0
11. `florence2.rs::encoder_tests` mod 追加 (§5.1 4-6 ケース)

### TS 側

12. TS は本 batch で touch しない
13. `tsc --noEmit` exit 0
14. vitest 4 test file regression 0 確認 (ピンポイント実行)

### 最終確認

15. `npm run test:capture -- --force` 最終 1 回 (regression 0)
16. ADR-005 §5 を `4b-5a-1〜5` 構成に再番号付け、4b-5a-3 `[x]` flip + summary
17. 本設計書 Status → Implemented + commit hash
18. commit 分割 (推奨 4 commit):
    - commit A: `refactor(vision-gpu): Phase 4b-5a-3 — make image/ndarray/tokenizers optional under vision-gpu feature`
    - commit B: `feat(vision-gpu): Phase 4b-5a-3 — Florence2Stage1Sessions + encoder_forward`
    - commit C: `feat(vision-gpu): Phase 4b-5a-3 — multi-session loading + stub wire-up + expect→Result`
    - commit D: `docs(vision-gpu): Phase 4b-5a-3 — ADR §5 sub-batch renumber + design Status`
19. push origin desktop-touch-mcp-fukuwaraiv2
20. Opus self-review は本人 (Opus session) が別途実施
21. `mcp__desktop-touch__notification_show` で通知 + handbook §6.1 報告

---

END OF DESIGN DOC.
