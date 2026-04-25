# Phase 4b-5a-4 設計書 — Florence-2 Stage 1 decoder + KV cache + autoregressive loop

- Status: Implemented (2026-04-25) — commits `38b94f5`, `f0c8fb1`, `9c763e4` + post-review fix

**Post-review addendum (Opus review 2026-04-25、BLOCKING 0)**:
- Sonnet 追加判断 5 件 (`Tensor::into_dyn` / `Vec<(String, DynValue)>` / bool tensor / decoder_tests +2 / commit 4→3 統合) 全て §7 範囲内認定
- **RECOMMEND R2 (本 batch で対応)**: `tokens.last().expect()` を `tokens.last().copied().unwrap_or(FLORENCE2_EOS_TOKEN)` に置換 (defensive fallback、L5 panic-free 原則維持)
- RECOMMEND R1 (4b-5a-5 検証時): Florence-2 ONNX export の decoder_input_ids 初回 shape (prefill 1 token vs prompt prefix) を dogfood 1 回目で `decoder run` error 経由で確認するチェックリストに追加
- NIT N1: `generate_tokens` doc-comment に「BOS を含めて max_length+1 が上限」明記推奨 (本 batch 対応せず)
- NIT N2: commit 4→3 統合は §7 commit 分割 acceptable scope 内 — 問題なし
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D1' (Rust backend) / D5' Stage 1 (Florence-2-base region proposer)
- 対応 ADR-005 §5 batch: 4b-5a-4 (Florence-2 Stage 1 の sub-sub-batch 4/5)
- 前提 commits: `c4a9a7f`〜`8939831` (4a + 4b-1 + 4b-3 + 4b-4 + 4b-5 + 4b-5a-1 + 4b-5a-2 + 4b-5a-3 完了)
- 期待工数: **4-5 日 (Sonnet 実装、Rust 中心、KV cache 管理が最重)**

---

## 1. Goal

Florence-2 Stage 1 の **decoder + autoregressive loop** を実装する:
`decoder_model_merged.onnx` を `use_cache_branch` input で initial / cached 両対応させ、
KV cache (BART 6 layers × 4 tensor = 24 + use_cache の 28+ inputs) を動的管理しながら
greedy decode で `<REGION_PROPOSAL>` task の出力 token 列を取得する。

同時に 4b-5a-3 review の **RECOMMEND R1 / N1** (lite path 削除 / Debug test fragile 修正) +
4b-5a-1 RECOMMEND の残務 (`extract_crop_rgb` SIMD は scope 外、`tracing::warn!` 統一は 4b-5a-5 に持ち越し) を一部対応。

単一目標:

> `Florence2Stage1Sessions::generate_tokens(encoder_outputs, max_length)` が
> autoregressive greedy decode を完了し `Vec<i64>` token IDs を返す。
> `stub_recognise_with_session` で florence-2-base + frame_buffer + tokenizer +
> 4 sub-session 全て揃うとき encoder_forward → generate_tokens の **完全 pipeline** を
> 実行し、debug_assert で「BOS で始まり EOS or max_length で終わる」不変条件を確認、
> stub fall through で既存 dummy candidates を返す。

### 明示的に本 batch の scope 外

- `<loc_X>` token sequence parse → bbox 変換 — **4b-5a-5 (次 batch)**
- RawCandidate 化 → 実 region proposal 出力 — **4b-5a-5**
- OmniParser-v2 (Stage 2) / PaddleOCR-v4 (Stage 3) — **4b-5b / 4b-5c**
- Beam search (greedy のみ実装、beam search は将来 ADR)
- Top-k / temperature sampling (greedy のみ)
- DXGI zero-copy 統合 — Phase 4c
- Real Florence-2 ONNX artifact ダウンロード自動化

---

## 2. Files to touch

### 新規作成

(なし — 全て既存 `florence2.rs` への追加 + inference.rs 改修)

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/vision_backend/florence2.rs` | `BartConfig` const struct (num_layers=6 / num_heads=12 / head_dim=64 / vocab_size=51289 / decoder_start_token_id=2 / eos_token_id=2)、`KvCache` struct (24 tensors の Owned)、`decoder_forward` method (1 step 実行)、`generate_tokens` method (autoregressive loop, greedy)、`init_empty_kv_cache` helper |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | 4b-5a-3 の lite path else 分岐を **削除** (4b-5a-3 RECOMMEND R1)、encoder_forward 後に generate_tokens を呼んで token 列取得、debug_assert で BOS/EOS 不変条件確認、stub fall through 維持 |
| `src/vision_backend/florence2.rs::encoder_tests` 既存 1 テスト | 4b-5a-3 NIT N1 修正: `s.contains("encoder_hidden_states")` → `let _ = format!("{outputs:?}");` (compile 確認のみ) |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5a-4 checklist` | `[x]` flip + summary |

### 削除禁止

- Phase 4a〜4b-5a-3 skeleton 全て (handbook §4.3)
- `Florence2Stage1Sessions` / `EncoderOutputs` / `encoder_forward` / 3 helper functions (`run_vision_encoder` / `run_embed_tokens` / `run_encoder_model`) — 4b-5a-3 成果物
- `Florence2Tokenizer` / `PromptTokens` / `REGION_PROPOSAL_PROMPT` / `preprocess_image` 等
- `catch_unwind` barrier (L5)
- Phase 4b-5 post-review legacy path / typeof guard

### Forbidden な依存追加

- 新 npm package 禁止
- 新 Rust crate 追加禁止 (KV cache は ndarray + ort 既存 dep のみで実装)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

---

## 3. API design

### 3.1 BART config 定数 + KV cache struct

```rust
//! Florence-2 BART decoder configuration constants.
//! Values verified against `microsoft/Florence-2-base/config.json`.

/// Number of transformer decoder layers.
pub const FLORENCE2_NUM_LAYERS: usize = 6;
/// Number of attention heads per layer.
pub const FLORENCE2_NUM_HEADS: usize = 12;
/// Hidden size per head (= hidden_dim / num_heads = 768 / 12).
pub const FLORENCE2_HEAD_DIM: usize = 64;
/// BART vocabulary size for Florence-2.
pub const FLORENCE2_VOCAB_SIZE: usize = 51289;
/// Decoder start token id (Florence-2 / BART convention: </s> = 2 acts as BOS).
pub const FLORENCE2_DECODER_START_TOKEN: i64 = 2;
/// End-of-sequence token id.
pub const FLORENCE2_EOS_TOKEN: i64 = 2;
/// Default max generation length for `<REGION_PROPOSAL>` task.
/// Real-world output is typically 50-200 tokens; 1024 is a safety cap.
pub const FLORENCE2_DEFAULT_MAX_LENGTH: usize = 1024;

/// Past-key-values cache for one layer (4 tensors per layer in BART decoder).
#[derive(Clone, Debug)]
pub struct LayerKvCache {
    /// `[1, num_heads, kv_seq_len, head_dim]` — decoder self-attention key.
    pub decoder_key: Array4<f32>,
    /// `[1, num_heads, kv_seq_len, head_dim]` — decoder self-attention value.
    pub decoder_value: Array4<f32>,
    /// `[1, num_heads, encoder_seq_len, head_dim]` — cross-attention key (fixed once computed).
    pub encoder_key: Array4<f32>,
    /// `[1, num_heads, encoder_seq_len, head_dim]` — cross-attention value (fixed once computed).
    pub encoder_value: Array4<f32>,
}

/// Full KV cache across all decoder layers.
#[derive(Clone, Debug)]
pub struct KvCache {
    pub layers: Vec<LayerKvCache>,
}

impl KvCache {
    /// Initialise an empty cache for the first decoder pass.
    /// All tensors have kv_seq_len = 0; encoder_seq_len is also 0 because
    /// use_cache_branch=false on the first call ignores past_key_values.
    pub fn empty(num_layers: usize, num_heads: usize, head_dim: usize) -> Self {
        let zero_dec = Array4::<f32>::zeros((1, num_heads, 0, head_dim));
        let zero_enc = Array4::<f32>::zeros((1, num_heads, 0, head_dim));
        let layer = LayerKvCache {
            decoder_key: zero_dec.clone(),
            decoder_value: zero_dec.clone(),
            encoder_key: zero_enc.clone(),
            encoder_value: zero_enc.clone(),
        };
        Self { layers: vec![layer; num_layers] }
    }

    pub fn num_layers(&self) -> usize { self.layers.len() }

    /// Total tensor count = num_layers × 4 (decoder.key/value + encoder.key/value).
    pub fn tensor_count(&self) -> usize { self.layers.len() * 4 }
}
```

### 3.2 `decoder_forward` (1 step 実行)

```rust
/// Output of one decoder step.
#[derive(Debug)]
pub struct DecoderStepOutput {
    /// `[1, dec_seq, vocab_size]` — logits for each position.
    pub logits: Array3<f32>,
    /// New `past_key_values` to feed into the next step.
    pub new_kv_cache: KvCache,
}

impl Florence2Stage1Sessions {
    /// Run one decoder step. Returns logits + updated KV cache.
    ///
    /// Inputs to `decoder_model_merged.onnx`:
    ///   - `encoder_hidden_states`: from `encoder_forward` (constant across loop)
    ///   - `encoder_attention_mask`: from `encoder_forward` (constant)
    ///   - `decoder_input_ids`: `[1, dec_seq]` — full history on first call,
    ///     `[1, 1]` (only the new token) on subsequent calls
    ///   - `past_key_values.{layer}.{decoder|encoder}.{key|value}`: 24 tensors total
    ///   - `use_cache_branch`: `[1]` bool tensor (false initially, true after)
    ///
    /// Outputs:
    ///   - `logits`: `[1, dec_seq, vocab_size]`
    ///   - `present.{layer}.{decoder|encoder}.{key|value}`: 24 tensors (new cache)
    pub fn decoder_forward(
        &self,
        encoder_hidden_states: ArrayView3<f32>,
        encoder_attention_mask: ArrayView2<i64>,
        decoder_input_ids: Array2<i64>,
        past_kv: &KvCache,
        use_cache_branch: bool,
    ) -> Result<DecoderStepOutput, VisionBackendError> {
        use ort::value::Tensor;
        use ndarray::Array1;

        // Build all input tensors. ort::inputs! macro supports multiple named inputs.
        let enc_hidden_tensor = Tensor::from_array(encoder_hidden_states.to_owned())
            .map_err(|e| VisionBackendError::Other(format!("enc_hidden tensor: {e}")))?;
        let enc_mask_tensor = Tensor::from_array(encoder_attention_mask.to_owned())
            .map_err(|e| VisionBackendError::Other(format!("enc_mask tensor: {e}")))?;
        let dec_input_tensor = Tensor::from_array(decoder_input_ids)
            .map_err(|e| VisionBackendError::Other(format!("dec_input tensor: {e}")))?;
        let use_cache_arr = Array1::from_vec(vec![use_cache_branch]);
        let use_cache_tensor = Tensor::from_array(use_cache_arr)
            .map_err(|e| VisionBackendError::Other(format!("use_cache tensor: {e}")))?;

        // Build past_key_values.* tensors — 24 entries for BART base.
        // We use a Vec<(String, Value)> approach via SessionInputs::from_iter,
        // since ort::inputs! macro requires compile-time known input count.
        let mut named_inputs: Vec<(String, ort::value::DynValue)> = Vec::with_capacity(28);
        named_inputs.push(("encoder_hidden_states".into(), enc_hidden_tensor.into_dyn()));
        named_inputs.push(("encoder_attention_mask".into(), enc_mask_tensor.into_dyn()));
        named_inputs.push(("decoder_input_ids".into(), dec_input_tensor.into_dyn()));
        named_inputs.push(("use_cache_branch".into(), use_cache_tensor.into_dyn()));

        for (i, layer) in past_kv.layers.iter().enumerate() {
            named_inputs.push((
                format!("past_key_values.{i}.decoder.key"),
                Tensor::from_array(layer.decoder_key.clone())
                    .map_err(|e| VisionBackendError::Other(format!("past dec key {i}: {e}")))?
                    .into_dyn(),
            ));
            named_inputs.push((
                format!("past_key_values.{i}.decoder.value"),
                Tensor::from_array(layer.decoder_value.clone())
                    .map_err(|e| VisionBackendError::Other(format!("past dec val {i}: {e}")))?
                    .into_dyn(),
            ));
            named_inputs.push((
                format!("past_key_values.{i}.encoder.key"),
                Tensor::from_array(layer.encoder_key.clone())
                    .map_err(|e| VisionBackendError::Other(format!("past enc key {i}: {e}")))?
                    .into_dyn(),
            ));
            named_inputs.push((
                format!("past_key_values.{i}.encoder.value"),
                Tensor::from_array(layer.encoder_value.clone())
                    .map_err(|e| VisionBackendError::Other(format!("past enc val {i}: {e}")))?
                    .into_dyn(),
            ));
        }

        let mut session = self.decoder_model_merged.lock();
        let outputs = session
            .run(named_inputs)
            .map_err(|e| VisionBackendError::Other(format!("decoder run: {e}")))?;

        // Extract logits.
        let logits_view = outputs
            .get("logits")
            .ok_or_else(|| VisionBackendError::Other("decoder missing logits output".into()))?
            .try_extract_array::<f32>()
            .map_err(|e| VisionBackendError::Other(format!("logits extract: {e}")))?;
        let logits = logits_view
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| VisionBackendError::Other(format!("logits dim: {e}")))?
            .to_owned();

        // Extract present.* outputs into a new KvCache.
        let mut new_layers: Vec<LayerKvCache> = Vec::with_capacity(past_kv.num_layers());
        for i in 0..past_kv.num_layers() {
            let dec_key = extract_kv_output(&outputs, &format!("present.{i}.decoder.key"))?;
            let dec_val = extract_kv_output(&outputs, &format!("present.{i}.decoder.value"))?;
            let enc_key = extract_kv_output(&outputs, &format!("present.{i}.encoder.key"))?;
            let enc_val = extract_kv_output(&outputs, &format!("present.{i}.encoder.value"))?;
            new_layers.push(LayerKvCache {
                decoder_key: dec_key,
                decoder_value: dec_val,
                encoder_key: enc_key,
                encoder_value: enc_val,
            });
        }

        Ok(DecoderStepOutput {
            logits,
            new_kv_cache: KvCache { layers: new_layers },
        })
    }
}

fn extract_kv_output(
    outputs: &ort::session::SessionOutputs,
    name: &str,
) -> Result<Array4<f32>, VisionBackendError> {
    let view = outputs
        .get(name)
        .ok_or_else(|| VisionBackendError::Other(format!("decoder missing output: {name}")))?
        .try_extract_array::<f32>()
        .map_err(|e| VisionBackendError::Other(format!("{name} extract: {e}")))?;
    view.into_dimensionality::<ndarray::Ix4>()
        .map_err(|e| VisionBackendError::Other(format!("{name} dim: {e}")))
        .map(|a| a.to_owned())
}
```

### 3.3 `generate_tokens` (autoregressive greedy decode loop)

```rust
impl Florence2Stage1Sessions {
    /// Run autoregressive greedy decode over the encoder outputs.
    ///
    /// - Starts with `decoder_input_ids = [DECODER_START_TOKEN]`
    /// - Each step: run decoder, take argmax over last-position logits, append token
    /// - Stops at EOS or `max_length`
    ///
    /// Returns the full token sequence including the start token (caller
    /// strips BOS and EOS as needed in 4b-5a-5 parse).
    pub fn generate_tokens(
        &self,
        encoder_outputs: &EncoderOutputs,
        max_length: usize,
    ) -> Result<Vec<i64>, VisionBackendError> {
        let mut tokens: Vec<i64> = vec![FLORENCE2_DECODER_START_TOKEN];
        let mut kv_cache = KvCache::empty(
            FLORENCE2_NUM_LAYERS,
            FLORENCE2_NUM_HEADS,
            FLORENCE2_HEAD_DIM,
        );
        let mut use_cache_branch = false;

        for _step in 0..max_length {
            // Build decoder_input_ids:
            //   - First call (use_cache_branch=false): full history [BOS]
            //   - Subsequent calls (use_cache_branch=true): only the latest token
            let dec_input_vec: Vec<i64> = if use_cache_branch {
                vec![*tokens.last().expect("tokens never empty")]
            } else {
                tokens.clone()
            };
            let dec_input = Array2::from_shape_vec((1, dec_input_vec.len()), dec_input_vec)
                .map_err(|e| VisionBackendError::Other(format!("dec_input reshape: {e}")))?;

            let step_out = self.decoder_forward(
                encoder_outputs.encoder_hidden_states.view(),
                encoder_outputs.encoder_attention_mask.view(),
                dec_input,
                &kv_cache,
                use_cache_branch,
            )?;

            // Greedy: take argmax over last position's logits.
            let logits = &step_out.logits;
            let last_pos = logits.shape()[1] - 1;
            let next_token = greedy_argmax(logits.slice(ndarray::s![0, last_pos, ..]));

            tokens.push(next_token);
            kv_cache = step_out.new_kv_cache;
            use_cache_branch = true;

            if next_token == FLORENCE2_EOS_TOKEN {
                break;
            }
        }

        Ok(tokens)
    }
}

/// Argmax over a 1-D logits vector. Returns the index as i64.
fn greedy_argmax(logits: ndarray::ArrayView1<f32>) -> i64 {
    let mut best_idx = 0usize;
    let mut best_val = f32::NEG_INFINITY;
    for (i, &v) in logits.iter().enumerate() {
        if v > best_val {
            best_val = v;
            best_idx = i;
        }
    }
    best_idx as i64
}
```

### 3.4 `stub_recognise_with_session` の generate_tokens 接続

```rust
fn stub_recognise_with_session(
    req: RecognizeRequest,
    sess: std::sync::Arc<crate::vision_backend::session::VisionSession>,
) -> Vec<RawCandidate> {
    if sess.session_key.starts_with("florence-2-base:") && !req.frame_buffer.is_empty() {
        // 4b-5a-3 RECOMMEND R1: lite path 削除済 (sub-sessions 不在時は直接 dummy へ)
        let stage1 = match crate::vision_backend::florence2::Florence2Stage1Sessions::from_pool(&sess.session_key) {
            Some(s) => s,
            None => return dummy_recognise(req),
        };

        // Step 1: preprocess (4b-5a-1)
        let pixel_values = match crate::vision_backend::florence2::preprocess_image(/* ... */) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[florence2] preprocess failed: {e}");
                return dummy_recognise(req);
            }
        };

        // Step 2: tokenize (4b-5a-2)
        let tokenizer_path = match tokenizer_path_for_session(&sess) {
            Some(p) if p.exists() => p,
            _ => return dummy_recognise(req),
        };
        let tokenizer = match crate::vision_backend::florence2::Florence2Tokenizer::from_file(&tokenizer_path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[florence2] tokenizer load failed: {e}");
                return dummy_recognise(req);
            }
        };
        let prompt_tokens = match tokenizer.tokenize_region_proposal() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[florence2] tokenize failed: {e}");
                return dummy_recognise(req);
            }
        };

        // Step 3: encoder forward (4b-5a-3)
        let encoder_outputs = match stage1.encoder_forward(pixel_values, &prompt_tokens) {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[florence2] encoder_forward failed: {e}");
                return dummy_recognise(req);
            }
        };

        // Step 4: autoregressive decoder loop (4b-5a-4 NEW)
        match stage1.generate_tokens(
            &encoder_outputs,
            crate::vision_backend::florence2::FLORENCE2_DEFAULT_MAX_LENGTH,
        ) {
            Ok(tokens) => {
                debug_assert_eq!(tokens[0], crate::vision_backend::florence2::FLORENCE2_DECODER_START_TOKEN);
                debug_assert!(
                    tokens.len() <= crate::vision_backend::florence2::FLORENCE2_DEFAULT_MAX_LENGTH + 1,
                );
                // Phase 4b-5a-5 will pass `tokens` to the parser here.
            }
            Err(e) => eprintln!("[florence2] generate_tokens failed: {e}"),
        }
    }
    dummy_recognise(req)
}
```

### 3.5 4b-5a-3 RECOMMEND N1 修正 — Debug test fragility

```rust
// florence2.rs::encoder_tests
// Before
assert!(s.contains("encoder_hidden_states"));

// After
let _ = format!("{outputs:?}");  // compile-time Debug impl確認のみ
```

---

## 4. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0
- [ ] `tsc --noEmit` exit 0
- [ ] vitest 4 test file regression 0 (本 batch は TS touch なし)
- [ ] 最終 full suite で regression 0
- [ ] ADR-005 §5 4b-5a-4 `[x]` flip + summary
- [ ] 設計書 Status → Implemented (commit hash)
- [ ] Opus self-review BLOCKING 0
- [ ] Rust 6-8 ケース新規 decoder test を `florence2.rs::decoder_tests` に追加
- [ ] 4b-5a-3 lite path 削除確認 (`stub_recognise_with_session` の `else` 分岐除去)
- [ ] 4b-5a-3 NIT N1 fix (`format!("{outputs:?}")` パターン)

---

## 5. Test cases

### 5.1 Rust unit tests (`florence2.rs::decoder_tests`)

```rust
#[cfg(all(test, feature = "vision-gpu"))]
mod decoder_tests {
    use super::*;

    #[test]
    fn kv_cache_empty_has_zero_kv_seq_len() {
        let cache = KvCache::empty(FLORENCE2_NUM_LAYERS, FLORENCE2_NUM_HEADS, FLORENCE2_HEAD_DIM);
        assert_eq!(cache.num_layers(), 6);
        assert_eq!(cache.tensor_count(), 24);
        for layer in &cache.layers {
            assert_eq!(layer.decoder_key.shape(), &[1, 12, 0, 64]);
            assert_eq!(layer.decoder_value.shape(), &[1, 12, 0, 64]);
            assert_eq!(layer.encoder_key.shape(), &[1, 12, 0, 64]);
            assert_eq!(layer.encoder_value.shape(), &[1, 12, 0, 64]);
        }
    }

    #[test]
    fn kv_cache_is_clone_and_debug() {
        let cache = KvCache::empty(2, 4, 16);
        let _cloned = cache.clone();
        let _ = format!("{cache:?}");
    }

    #[test]
    fn greedy_argmax_picks_max() {
        let logits = ndarray::array![0.1, 0.5, 0.3, 0.9, 0.2];
        let idx = greedy_argmax(logits.view());
        assert_eq!(idx, 3);
    }

    #[test]
    fn greedy_argmax_first_index_on_ties() {
        let logits = ndarray::array![0.5, 0.5, 0.5];
        let idx = greedy_argmax(logits.view());
        assert_eq!(idx, 0);
    }

    #[test]
    fn florence2_constants_are_consistent() {
        assert_eq!(FLORENCE2_NUM_LAYERS, 6);
        assert_eq!(FLORENCE2_NUM_HEADS, 12);
        assert_eq!(FLORENCE2_HEAD_DIM, 64);
        assert_eq!(FLORENCE2_HEAD_DIM * FLORENCE2_NUM_HEADS, 768); // hidden_dim
        assert_eq!(FLORENCE2_DECODER_START_TOKEN, 2);
        assert_eq!(FLORENCE2_EOS_TOKEN, 2);
        assert!(FLORENCE2_DEFAULT_MAX_LENGTH >= 100);
    }

    #[test]
    fn decoder_step_output_struct_accessible() {
        let logits = Array3::<f32>::zeros((1, 5, FLORENCE2_VOCAB_SIZE));
        let kv_cache = KvCache::empty(2, 4, 16);
        let step = DecoderStepOutput { logits, new_kv_cache: kv_cache };
        assert_eq!(step.logits.shape(), &[1, 5, FLORENCE2_VOCAB_SIZE]);
        assert_eq!(step.new_kv_cache.num_layers(), 2);
    }

    // Note: full generate_tokens / decoder_forward integration tests require
    // real ort::Session instances (not constructible without ONNX files).
    // Per 4b-5a-1 post-review addendum, manual verify at dogfood with real
    // Florence-2-base artifact.
}
```

### 5.2 既存テストの維持

- `tests` (4b-5a-1 7 ケース): 変更なし、全パス
- `tokenizer_tests` (4b-5a-2 6 ケース): 変更なし
- `encoder_tests` (4b-5a-3 5 ケース): N1 fix で 1 行修正、全パス維持

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| 28+ named inputs を ort::inputs! macro で渡せない (compile-time const N) | `Vec<(String, DynValue)>` に切替、`session.run(vec.into_iter())` で動的入力 |
| `Tensor::into_dyn()` の呼び出し方 | ort 2.0.0-rc.12 の正しい method 名は Sonnet が docs.rs で確認 (`upcast` / `into_dyn` / `as_dyn` のいずれか) |
| past_key_values shape: encoder.key の seq_len は use_cache_branch=false 時 0、true 時 encoder_seq_len 維持 | 設計書 §3.1 `KvCache::empty` で全部 0、初回 use_cache=false で全 0 input が ONNX 内部で無視される (decoder_model_merged の use_cache_branch 動作) |
| `outputs.get(name)` が None | output 名の HF Florence-2 export 規約 (`logits` / `present.{i}.{decoder/encoder}.{key/value}`) を Sonnet が verify、不一致なら eprintln + Err |
| use_cache_branch tensor の dtype (bool vs i64 vs u8) | HF ONNX export では bool ([1] shape)、ort 2.0 で `Tensor::from_array(Array1<bool>)` がサポートされるか要確認 — されない場合 i64 [0/1] に fallback |
| max_length 1024 が過大 → memory blow up | KvCache が 6 layers × 4 tensor × growing 768-dim でも 1024 token なら ~144MB、許容 (BART base) |
| EOS が初手で出る (broken model) → token 列が [BOS, EOS] | break 後 tokens.len()==2 で帰る、4b-5a-5 の parser がこのケースを「region proposal なし」として扱う |
| 4b-5a-3 lite path 削除で既存 4b-5a-1/2 test が落ちる | 削除前に対応 test を確認、test が「lite path で eprintln が出ない」依存なら test 側更新 (handbook §4.1 logic 不変、API 適合) |
| greedy_argmax の `f32::NEG_INFINITY` 初期値で全 NaN logits の場合 | 全 NaN は ONNX が壊れたケース、index 0 を返す現実装は許容 (発生したら eprintln + 異常 token として処理) |
| logits[:, -1, :] の slice indexing が空 logits で panic | logits.shape()[1] == 0 を guard で先に check、Err 返却 |
| 4 sub-session 全てが同じ EP に固定されない場合 (DirectML / CPU 混在) | 設計書 §6 NIT N2 (4b-5a-3 review)、本 batch では last_label の方針継続、4b-5a-5 で multi-EP ロギング検討 |

---

## 7. Acceptable Sonnet judgment scope

- ort 2.0.0-rc.12 の `Tensor::into_dyn` / `upcast` / `as_dyn` 正確な method 名選択
- `session.run` への動的入力渡し方法 (`Vec<(String, DynValue)>` / `HashMap<String, DynValue>` / `iter()` etc.)
- HF Florence-2 ONNX の正確な input/output 名 (`past_key_values.{i}.{...}` vs `past_key_values.{i}.{...}.key` 等の表記揺れ)
- `use_cache_branch` の dtype 確定 (bool / i64) と Tensor 構築方法
- decoder_tests +α ケース追加 (§5.1 6 ケースを超える +α は OK)
- commit 分割 (3-4 commit 推奨: BartConfig+KvCache / decoder_forward / generate_tokens+wire / docs)
- 4b-5a-3 RECOMMEND R1 lite path 削除の正確な範囲 (`else` 分岐の preprocess+tokenize 部分のみ削除、`if-let-Some` chain は維持)

---

## 8. Forbidden Sonnet judgments

### 8.1 API surface 変更
- `VisualBackend` interface 不変
- `ModelRegistry` / `ModelManifest` 不変
- `RecognizeRequest` / `NativeRecognizeRequest` 不変
- `VisionSession::create` signature 不変
- `Florence2Stage1Sessions::encoder_forward` / `EncoderOutputs` / `from_pool` の 4b-5a-3 signature 不変
- `Florence2Tokenizer` / `PromptTokens` / `preprocess_image` 等 4b-5a-1/2 signature 不変
- `SelectedEp` / `EpName` / `RawCandidate` / `UiEntityCandidate` 不変

### 8.2 Scope 変更
- `<loc_X>` parse / RawCandidate 化 実装禁止 (4b-5a-5)
- OmniParser-v2 / PaddleOCR-v4 実装禁止
- Beam search / top-k sampling 禁止 (greedy のみ)
- DXGI zero-copy 禁止
- Phase 4a〜4b-5a-3 成果物変更禁止 (4b-5a-3 lite path 削除のみ例外、handbook §4.1 範囲)
- HF Hub network 連携禁止
- ModelManifest schema 変更禁止

### 8.3 依存追加禁止
- 新 npm package / 新 Rust crate 追加禁止
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 8.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)
- 4b-5a-3 NIT N1 fix (`s.contains` → `format!`) は API 変更ではなく test 自体の堅牢化、Sonnet 判断で acceptable
- 4b-5a-3 lite path 削除に伴う既存 4b-5a-1/2 test 影響時は **実装側で挙動維持** (handbook §4.1)

### 8.5 絶対不変
- `catch_unwind` barrier 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止
- Phase 4b-5 post-review legacy path / typeof guard 維持 (4b-5c まで)
- 4b-5a-1 post-review addendum「cargo test 実行不可受容」基準継承

### 8.6 ドキュメント更新義務
- ADR-005 §5 4b-5a-4 `[x]` flip + summary
- 本設計書 Status → Implemented (commit hash)

---

## 9. Future work / 次 batch (4b-5a-5)

- `<loc_X>` token sequence parse → quantized coordinate → Rect
- `tokenizers::Tokenizer::decode(token_ids)` で text 復元
- class label assignment (region/form/panel/toolbar 等)
- `stub_recognise_with_session` から `florence2_stage1_recognise` への分離 — Stage 1 完結
- 4b-5a-2 RECOMMEND R3 (`eprintln!` → `tracing::warn!`) 一括対応
- 4b-5a-3 RECOMMEND R2 (Known traps 注釈更新) を ADR や handbook に反映

---

## 10. 実装順序 (Sonnet 手順)

### Rust 側 — KV cache + decoder_forward

1. `florence2.rs` に §3.1 の constants + `LayerKvCache` / `KvCache` struct + `empty` / `num_layers` / `tensor_count` method
2. §3.2 の `DecoderStepOutput` struct + `decoder_forward` method + `extract_kv_output` helper
3. `cargo check --release --features vision-gpu` exit 0

### Rust 側 — generate_tokens loop

4. §3.3 の `generate_tokens` method + `greedy_argmax` helper
5. `cargo check --release --features vision-gpu` exit 0

### inference.rs 改修 + lite path 削除 + N1 fix

6. §3.4 通り `stub_recognise_with_session` を改修 (lite path 削除 + generate_tokens 追加)
7. 4b-5a-3 NIT N1 fix (`encoder_tests` の Debug 文字列 contains → format!)
8. `cargo check --release --features vision-gpu` exit 0
9. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
10. `cargo check --release --no-default-features` exit 0

### Tests

11. `florence2.rs::decoder_tests` mod 追加 (§5.1 6 ケース)
12. 既存 test (`tests` / `tokenizer_tests` / `encoder_tests`) regression 確認 (cargo check + body 読解)

### TS 側 (touch なし)

13. `tsc --noEmit` exit 0
14. vitest 4 test file regression 0

### 最終確認

15. `npm run test:capture -- --force` 最終 1 回
16. ADR-005 §5 4b-5a-4 `[x]` flip + summary
17. 設計書 Status → Implemented + commit hash
18. commit 分割 (推奨 4 commit):
    - A: `feat(vision-gpu): Phase 4b-5a-4 — KvCache + BART config constants`
    - B: `feat(vision-gpu): Phase 4b-5a-4 — decoder_forward + generate_tokens (greedy)`
    - C: `feat(vision-gpu): Phase 4b-5a-4 — wire generate_tokens into stub + lite path removal + N1 fix`
    - D: `docs(vision-gpu): Phase 4b-5a-4 — ADR §5 + design Status`
19. push origin desktop-touch-mcp-fukuwaraiv2
20. Opus self-review (本人 Opus session 別途実施)
21. notification + handbook §6.1 報告

---

END OF DESIGN DOC.
