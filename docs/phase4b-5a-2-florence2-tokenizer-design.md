# Phase 4b-5a-2 設計書 — Florence-2 BART tokenizer integration

- Status: Implemented (2026-04-25、commits a56d990, 53907ac)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D1' (Rust backend) / D5' Stage 1 (Florence-2-base region proposer)
- 対応 ADR-005 §5 batch: 4b-5a-2 (Florence-2 Stage 1 の sub-sub-batch 2/4)
- 前提 commits: `c4a9a7f`〜`23b2a11` (Phase 4a + 4b-1 + 4b-3 + 4b-4 + 4b-5 + 4b-5a-1 完了)
- 期待工数: **2-3 日 (Sonnet 実装、Rust 中心)**

---

## 1. Goal

Florence-2 (BART-based) tokenizer を Rust 側で統合し、`<REGION_PROPOSAL>` task prompt を
`input_ids: Vec<i64>` + `attention_mask: Vec<i64>` に変換できる状態にする。
これは 4b-5a-3 の encoder forward (`pixel_values` + `input_ids` + `attention_mask` →
encoder_hidden_states) の前段。

単一目標:

> Rust 側で `Florence2Tokenizer::from_file(<model_root>/tokenizer.json)` が成功し、
> `tokenize_region_proposal()` が `PromptTokens { input_ids, attention_mask }` を返す。
> `stub_recognise_with_session` が `florence-2-base:*` session_key で frame_buffer + tokenizer
> file が揃っているとき preprocess + tokenize の **両方** を呼び、shape を log で確認する。
> 実 Florence-2 ONNX session は呼ばない (encoder/decoder forward は 4b-5a-3)。

### 明示的に本 batch の scope 外

- Florence-2 encoder + decoder ort::Session::run + KV cache autoregressive loop — **4b-5a-3**
- `<loc_X>` token sequence parse → bbox 変換 — **4b-5a-4**
- OmniParser-v2 (Stage 2) / PaddleOCR-v4 (Stage 3) — **4b-5b / 4b-5c**
- Real Florence-2 tokenizer.json artifact のダウンロード自動化 — scope 外 (user 手動 download or 4b-5a-3 で session init 確認時に同梱検討)
- `tokenizers` crate の HF Hub 連携 (`from_pretrained`) — disable (network 依存禁止、file-only load のみ)

---

## 2. Files to touch

### 新規作成

(なし — 全て既存ファイルへの追加)

### 変更

| Path:行 | 変更内容 |
|---|---|
| `Cargo.toml [dependencies]` | `tokenizers = { version = "0.21", default-features = false, features = ["onig"] }` 追加 (BART tokenizer 用、HF 公式 pure Rust crate、network feature `http` は明示 disable) |
| `src/vision_backend/florence2.rs` | `Florence2Tokenizer` struct + `from_file` / `tokenize_region_proposal` / `tokenize_with_prompt` method + `PromptTokens` struct + 関連テスト 6 件追加 |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | session_key が `florence-2-base:*` で frame_buffer 非空のとき、`<model_path の親 dir>/tokenizer.json` の存在を確認し `Florence2Tokenizer::from_file` を試行。成功なら `tokenize_region_proposal` 実行、log で shape 確認、fall through で既存 stub 返却 |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5a-2 checklist` | `[x]` flip + summary |

### 削除禁止

- Phase 4a/4b-1/4b-3/4b-4/4b-5/4b-5a-1 skeleton 全て (handbook §4.3)
- `florence2::preprocess_image` 関連 (4b-5a-1 成果物)
- `image` crate / `ndarray` crate 既設 (4b-5a-1 成果物、本 batch も継続使用)
- `catch_unwind` barrier (inference.rs / session.rs) (L5)
- Phase 4b-5 post-review の legacy path / typeof guard (4b-5c 完了時まで維持)

### Forbidden な依存追加

- 新 npm package 禁止
- `tokenizers` crate 以外の新 Rust crate 追加禁止 (candle / fast_image_resize / anyhow 等は後続 batch)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

**注**: `tokenizers` crate の追加は本設計書で明示許可 (4b-5a-1 の `image` crate と同じ位置づけ、§9.3 の一般禁止 rule の例外)。

---

## 3. API design

### 3.1 Rust: `florence2.rs` 追加部分

```rust
//! Florence-2 Stage 1 (region proposer) inference module.
//!
//! Phase 4b-5a-2 additions (this batch):
//!   - `Florence2Tokenizer`: thin wrapper over `tokenizers::Tokenizer` for
//!     loading Florence-2's BART tokenizer.json
//!   - `PromptTokens`: result struct (input_ids + attention_mask as Vec<i64>)
//!   - `tokenize_region_proposal()`: encode the canonical `<REGION_PROPOSAL>`
//!     task prompt that Stage 1 uses
//!   - `tokenize_with_prompt(&str)`: encode arbitrary prompt (used by tests
//!     and any future task variant)

use std::path::Path;

use crate::vision_backend::error::VisionBackendError;

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
    pub fn from_file(path: &Path) -> Result<Self, VisionBackendError> {
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
```

### 3.2 Rust: `inference.rs::stub_recognise_with_session` 拡張

```rust
fn stub_recognise_with_session(
    req: RecognizeRequest,
    sess: std::sync::Arc<crate::vision_backend::session::VisionSession>,
) -> Vec<RawCandidate> {
    if sess.session_key.starts_with("florence-2-base:") && !req.frame_buffer.is_empty() {
        // 4b-5a-1: image preprocess
        let preprocess_ok = match crate::vision_backend::florence2::preprocess_image(
            &req.frame_buffer,
            req.frame_width,
            req.frame_height,
            req.rois.first().map(|r| &r.rect).unwrap_or(&Rect {
                x: 0, y: 0,
                width: req.frame_width as i32,
                height: req.frame_height as i32,
            }),
        ) {
            Ok(tensor) => {
                debug_assert_eq!(tensor.dim(), crate::vision_backend::florence2::expected_shape());
                true
            }
            Err(e) => {
                eprintln!("[florence2] preprocess failed: {e}");
                false
            }
        };

        // 4b-5a-2: tokenizer. Try loading tokenizer.json adjacent to the model file
        // (convention: <model_root>/tokenizer.json, where model_root is the parent
        // directory of the .onnx file). If the file is absent, log and continue —
        // 4b-5a-3 will require it for real inference, but Stage 1 stub paths must
        // not panic on missing artifact (L5).
        if preprocess_ok {
            if let Some(tokenizer_path) = tokenizer_path_for_session(&sess) {
                if tokenizer_path.exists() {
                    match crate::vision_backend::florence2::Florence2Tokenizer::from_file(&tokenizer_path) {
                        Ok(tok) => match tok.tokenize_region_proposal() {
                            Ok(prompt_tokens) => {
                                debug_assert!(!prompt_tokens.is_empty());
                                debug_assert_eq!(
                                    prompt_tokens.input_ids.len(),
                                    prompt_tokens.attention_mask.len(),
                                );
                                // Sanity-check: BART encoding of any non-empty prompt yields ≥ 2 tokens
                                // (BOS + EOS at minimum). Real Florence-2 tokenization of
                                // <REGION_PROPOSAL> is typically 3 tokens.
                                debug_assert!(prompt_tokens.len() >= 2);
                            }
                            Err(e) => eprintln!("[florence2] tokenize failed: {e}"),
                        },
                        Err(e) => eprintln!("[florence2] tokenizer load failed: {e}"),
                    }
                }
                // tokenizer_path absent is normal in 4b-5a-2 (no real artifact yet); silent.
            }
        }
    }
    dummy_recognise(req)
}

/// Resolve the tokenizer.json path adjacent to the session's model file.
/// Returns None if the model_path has no parent directory (defensive).
fn tokenizer_path_for_session(
    sess: &crate::vision_backend::session::VisionSession,
) -> Option<std::path::PathBuf> {
    std::path::Path::new(&sess.model_path)
        .parent()
        .map(|p| p.join("tokenizer.json"))
}
```

### 3.3 `Cargo.toml` の `tokenizers` 追加

```toml
[dependencies]
# ... existing ...
# Phase 4b-5a-2: Florence-2 BART tokenizer (HuggingFace official pure-Rust crate)
# default-features=false to disable: progressbar (cli only), http (network from_pretrained),
# unstable_wasm. Keep `onig` for the ByteLevel BPE regex backend that Florence-2 uses.
tokenizers = { version = "0.21", default-features = false, features = ["onig"] }
```

**選定根拠**:
- HuggingFace 公式、pure Rust、Florence-2/BART/GPT 系で実績多数
- バイナリサイズ: `default-features = false` で ~3MB (default の半分以下、network/progressbar 抜き)
- 代替の `tiktoken-rs` は GPT 系 BPE のみ、Florence-2 BART 非対応
- `from_pretrained` (HF Hub network 取得) は本 batch では使わない、`from_file` のみ

### 3.4 ModelRegistry / ModelManifest への変更 (なし)

本 batch では ModelManifest schema を **触らない**。tokenizer.json の場所は
「model_path の親 dir」という convention で解決する (Florence-2 と同じ HF pattern)。

将来 4b-5a-3 以降で `tokenizer_files: string[]` のような field 追加を検討するかは
別 batch で判断 (本設計書 §10.4)。

### 3.5 napi surface 変更 (なし)

本 batch は Rust-internal の追加のみ。TS 側 `NativeRecognizeRequest` /
`OnnxBackend` / `stage-pipeline.ts` は **変更不要**。frame_buffer plumbing
(4b-5a-1 完了済) を再利用。

---

## 4. Tokenizer artifact 配置 convention

```text
<cache_root>/                                  # 既定 ~/.desktop-touch-mcp/models
  florence-2-base/
    winml-fp16.onnx                            # 既存 (variant ごと)
    dml-fp16.onnx                              # 既存
    cuda-fp16.onnx                             # 既存
    cpu-int8.onnx                              # 既存
    tokenizer.json                             # ← 新規 (variant 共通、model 直下)
    [preprocessor_config.json は 4b-5a-1 で hardcode 済、artifact 不要]
```

VisionSession.model_path = `<cache>/florence-2-base/dml-fp16.onnx` の場合、
tokenizer_path = `<cache>/florence-2-base/tokenizer.json` (parent dir 直下)。

**user 操作 (4b-5a-2 dogfood verify)**:
- Microsoft 公式 HF Hub (`microsoft/Florence-2-base/tokenizer.json`) から download
- `~/.desktop-touch-mcp/models/florence-2-base/tokenizer.json` に配置
- (tokenizer.json なしでも本 batch の test と build は通る、stub_recognise_with_session が silent skip)

---

## 5. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0
- [ ] `tsc --noEmit` exit 0
- [ ] `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 既存全パス (regression 0、本 batch 触らず)
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 既存全パス
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` regression 0
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` regression 0
- [ ] 最終 `npm run test:capture -- --force` **1 回のみ**: regression 0 (pre-existing e2e 2 件のみ)
- [ ] ADR-005 §5 4b-5a-2 checklist `[x]` flip + summary
- [ ] 本設計書 Status を `Implemented (2026-04-??、commit hash)` に更新
- [ ] Opus self-review BLOCKING 0
- [ ] Rust 6 ケース新規 tokenizer test を `florence2.rs::tests` に追加 (`#[cfg(test)]`、handbook §6.4 前例に従い cargo test 実行不可は受容)
- [ ] handbook §4.6: trial & error 2 連続発生で Opus 委譲

---

## 6. Test cases

### 6.1 Rust unit tests (`florence2.rs::tests` 追加分)

最低 6 ケース:

```rust
#[cfg(all(test, feature = "vision-gpu"))]
mod tokenizer_tests {
    use super::*;
    use tokenizers::{
        models::wordlevel::{WordLevel, WordLevelBuilder},
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
        let model = WordLevelBuilder::new()
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
```

### 6.2 TS tests

本 batch では TS 側 API は **不変** (frame_buffer plumbing は 4b-5a-1 で完成済)、
TS test の追加は不要。既存 stage-pipeline / onnx-backend / model-registry / session test
の regression 0 を確認するのみ。

### 6.3 既存テストの挙動

`stub_recognise_with_session` の追加 logic は `florence-2-base:` prefix + 非空 frame_buffer
でのみ走る。既存 test は session_key prefix が異なる (e.g., test mock の "k" 等) ので
影響なし。tokenizer artifact 不在の場合も silent skip → 既存 stub 出力に fall through。

---

## 7. Known traps

### Phase 4b-5a-1 で観測した罠 (再発させない)

| 罠 | 本 batch での回避 |
|---|---|
| napi-rs cdylib + -lnode 制約で cargo test 実行不可 | post-review addendum で受容済、本 batch も `cargo check + #[cfg(test)] body 存在 + logic 読解` で代替 |
| napi Buffer の Debug 未実装 | `RecognizeRequest::frame_buffer` の手動 Debug impl 既設、本 batch で再出現せず |
| ndarray transitive dep 解決 | 4b-5a-1 で explicit 化済、本 batch では使い回し |
| `image` crate feature flag | 4b-5a-1 で `["png"]` 確定、影響なし |

### 4b-5a-2 で予想される罠

| 罠 | 対策 |
|---|---|
| `tokenizers` crate の `default-features = false` で `onig` 必須 | `["onig"]` 明示、足りなければ `["unstable_wasm"]` の代わりに pure regex backend を試す (Sonnet §8 判断) |
| `tokenizers::Tokenizer::from_file` の戻り値型 (Result with own error) | `.map_err(|e| VisionBackendError::Other(...))` で吸収、format!("{e}") |
| `tokenizers::Encoding::get_ids` が `&[u32]` 返却 → i64 変換コスト | iter().map(\|&id\| id as i64).collect() で軽量、prompt 長 ~3-10 token なので無視可 |
| WordLevel モデルでの test が現実 BART tokenizer の挙動と乖離 | 本 batch の test は wrapper logic (encode/decode 形式、shape contract) のみ検証、実 BART vocab の正確性検証は 4b-5a-3 で実 tokenizer.json 読み込み時 |
| BART の post-processor TemplateProcessing build エラー | tokenizers 0.21 API では `try_single` が `Result` を返すパターンに変更済。Sonnet 側で API 確認 (handbook §5 stop condition: 1 回 trial で解決しなければ Opus 委譲) |
| compile time 増 (tokenizers crate 追加) | clean rebuild ~30-60s 増 (許容)、incremental は影響小 |
| `tokenizers` crate の native-tls / openssl 依存 | `default-features = false` で `http` feature を切るので tls 関連は引かれない (純 file/regex のみ) |
| Florence-2 tokenizer.json が Microsoft HF Hub から消える | 本 batch では runtime artifact 不在を silent skip、L5 維持。長期的には GH Releases に同梱 |
| tokenizer.json size (~5MB) が npm tarball を肥大化 | npm tarball には含めない、ユーザーが ~/.desktop-touch-mcp/models/<model>/tokenizer.json に手動配置 (ADR §358 download 経路で将来自動化) |
| `tokenizers::Tokenizer` の Send/Sync 性 | 0.21 で Send + Sync (Mutex 不要)、`Florence2Tokenizer` を `Arc<>` で持って大丈夫 (ただし本 batch では Arc 化しない、`stub_recognise_with_session` の都度 load OK) |
| stub の eprintln! が連発 (artifact 不在で毎 frame 警告) | tokenizer_path 不在は silent (条件分岐で抑制)、load/encode 失敗のみ eprintln! (異常時のみ) |

---

## 8. Acceptable Sonnet judgment scope

Sonnet が設計書内で独自判断して良い範囲:

- `tokenizers` crate のバージョン微調整 (`0.21.x` → `0.22.x` が安定 release ならそちら)
- feature 選定 (`["onig"]` で build 通らなければ `["unstable_wasm", "esaxx_fast"]` 等の代替試行)
- test の synthetic tokenizer 構築方法 (WordLevel / BPE どちらでも、§6.1 の本質「encode 結果の shape 検証」が達成できれば可)
- `from_tokenizer` constructor の名前 (e.g., `from_inner`, `wrap`) — but doc 整合性維持
- `tokenize_region_proposal` 内部の `tokenize_with_prompt` 呼び出し vs 直接実装の選択
- eprintln! を tracing::warn! に統一する判断 (既存 code style 確認)
- commit 分割 (2-3 commit 推奨、§11 参照)
- `tokenizer_path_for_session` の path 解決 logic 微調整 (parent dir or `Path::with_file_name`)
- `from_file` 内のエラーメッセージ wording

---

## 9. Forbidden Sonnet judgments

### 9.1 API surface 変更
- `VisualBackend` interface 不変 (4b-5a-1 の optional `frameBuffer?: Buffer` 追加で確定)
- `ModelRegistry` / `ModelManifest` / `ModelVariant` 不変 (tokenizer.json は schema 外、convention で解決)
- `RecognizeRequest` / `NativeRecognizeRequest` 不変 (本 batch は Rust-only 追加、TS surface 変更なし)
- `VisionSession::create` signature 不変
- 既存 `florence2::preprocess_image` / `expected_shape` / `FLORENCE2_INPUT_SIDE` / 関連 const 不変
- `SelectedEp` / `EpName` / `RawCandidate` / `UiEntityCandidate` 不変

### 9.2 Scope 変更
- Florence-2 encoder + decoder ort::Session::run 実装禁止 (4b-5a-3)
- KV cache / past_key_values 管理禁止 (4b-5a-3)
- `<loc_X>` token parse 禁止 (4b-5a-4)
- OmniParser-v2 / PaddleOCR-v4 実装禁止 (4b-5b/c)
- DXGI zero-copy 統合禁止 (Phase 4c)
- HF Hub network 連携 (`from_pretrained`) 禁止 (file-only load)
- Tokenizer artifact 自動ダウンロード禁止 (将来 4b-5a-3 以降か別 batch)
- ModelManifest schema 変更禁止 (`tokenizer_files` field 追加等は将来別 ADR)
- Phase 4a/4b-1/4b-3/4b-4/4b-5/4b-5a-1 成果物変更禁止

### 9.3 依存追加禁止
- 新 npm package 禁止
- `tokenizers` crate 以外の Rust crate 追加禁止 (candle / fast_image_resize / anyhow / thiserror 等)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 9.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)
- 新規テストは `florence2.rs` 内 `#[cfg(test)] mod tokenizer_tests` 追加のみ
- TS 側 test ファイル変更禁止 (本 batch 不要)

### 9.5 絶対不変
- `catch_unwind` barrier (inference.rs / session.rs) 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` opt-in flag 維持
- `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` kill-switch 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止
- Phase 4b-5 post-review legacy path / typeof guard (4b-5c 完了時まで維持)
- Phase 4b-5a-1 post-review addendum で確立した「cargo test 実行不可受容」基準を継承

### 9.6 ドキュメント更新義務
- ADR-005 §5 4b-5a-2 checklist `[x]` flip + summary
- 本設計書 Status を `Implemented (2026-04-??、commit hash)` に

---

## 10. Future work / 次 batch への hand-off

### 10.1 Phase 4b-5a-3 (次の着手)

- `florence2::Florence2Stage1Recogniser` (or similar) 構造体に preprocess + tokenizer + ort::Session 統合
- `pixel_values` (Array4<f32>) + `input_ids` (Array2<i64>) + `attention_mask` (Array2<i64>) を ort::Value に変換、`session.run([...])` 呼び出し
- encoder_hidden_states 取得
- decoder autoregressive loop with KV cache (past_key_values 30+ tensors の動的管理)
- greedy decode で出力 token 列取得
- `stub_recognise_with_session` から `florence2_stage1_recognise` への置換 (florence-2-base session_key 分岐内)
- 4b-5a-1 RECOMMEND の `expect()` 4 箇所を `Result` 経路に格上げ

### 10.2 Phase 4b-5a-4

- 出力 token 列 → text decode (`tokenizers::Tokenizer::decode`)
- `<loc_X>` X=0..999 special token parse → quantized 座標 → ピクセル bbox
- bbox + class label ("region" / "form" / "panel" / "toolbar" 等) → RawCandidate
- 4b-5a-1 RECOMMEND の `tracing::warn!` 統一を本 batch でまとめて実施

### 10.3 ModelManifest schema 拡張検討

- 4b-5a-3 完了後、`ModelManifest::ModelVariant` に `auxiliary_files: { name, url, sha256 }[]` 追加を検討 (tokenizer.json / preprocessor_config.json / vocab.txt 等)
- 現状の convention `<model_root>/tokenizer.json` は OK だが、複数言語 OCR モデル (PaddleOCR の multi-lang dict) で破綻する可能性
- 別 ADR 化 (ADR-007 候補)

### 10.4 4b-5a-1 RECOMMEND 残課題のキャリーオーバー

- (R1) `expect()` 4 箇所 → `Result` 経路: 4b-5a-3 で実 session.run 接続時に一括対応
- (R2) `extract_crop_rgb` SIMD 化: scope 外、4b-7 bench 後に検討
- (R3) `eprintln!` → `tracing::warn!`: 4b-5a-4 でまとめて統一

---

## 11. 実装順序 (Sonnet 手順)

### Cargo.toml + Rust 側

1. `Cargo.toml [dependencies]` に `tokenizers = { version = "0.21", default-features = false, features = ["onig"] }` 追加
2. `src/vision_backend/florence2.rs` に §3.1 の `Florence2Tokenizer` / `PromptTokens` / `REGION_PROPOSAL_PROMPT` / 関連 method 追加
3. `src/vision_backend/inference.rs::stub_recognise_with_session` を §3.2 通り改修 (preprocess の後に tokenizer load + tokenize 試行ブロック追加、`tokenizer_path_for_session` private helper 追加)
4. `cargo check --release --features vision-gpu` exit 0
5. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
6. `cargo check --release --no-default-features` exit 0 (`tokenizers` も `vision-gpu` feature gate 内で usage 限定するか optional にするか — Sonnet 判断、§8 範囲)
7. Rust unit tests (§6.1) 6 ケース追加 — `florence2.rs::tests` 末尾に `mod tokenizer_tests`
8. (cargo test 実行は 4b-5a-1 の post-review addendum 通り「不可」、cargo check + body 存在 + logic 読解で代替)

### TS 側 (変更なし、確認のみ)

9. TS 側は本 batch で touch しない。`tsc --noEmit` exit 0 (依存変化なし)
10. `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 全緑 (regression 0)
11. `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 全緑 (regression 0)
12. `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` regression 0
13. `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` regression 0

### 最終確認

14. `npm run test:capture -- --force` で full suite 最終 1 回 (regression 0)
15. `docs/visual-gpu-backend-adr-v2.md §5` の 4b-5a-2 entry を `[x]` flip + summary
16. 本設計書 Status を `Implemented (2026-04-??、commit hash)` に
17. commit 分割 (推奨 2-3 commit):
    - commit A: `feat(vision-gpu): Phase 4b-5a-2 — Florence-2 BART tokenizer (Rust)`
    - commit B: `feat(vision-gpu): Phase 4b-5a-2 — wire tokenizer into stub_recognise_with_session`
    - commit C: `docs(vision-gpu): Phase 4b-5a-2 — ADR §5 + design Status`
18. push origin desktop-touch-mcp-fukuwaraiv2
19. Opus self-review は本人 (Opus session) が別途実施、Sonnet は要請のみ
20. `mcp__desktop-touch__notification_show` で Windows 通知 + handbook §6.1 報告

---

END OF DESIGN DOC.
