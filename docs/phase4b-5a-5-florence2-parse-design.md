# Phase 4b-5a-5 設計書 — Florence-2 Stage 1 token parse → RawCandidate

- Status: Implemented (2026-04-25) — commits `d7cb24a` (R3 tracing), `ac8c3b8` (decode + parse + florence2_stage1_recognise + stub simplify)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D5' Stage 1 (Florence-2-base region proposer 完結)
- 対応 ADR-005 §5 batch: 4b-5a-5 (Florence-2 Stage 1 の **最終** sub-sub-batch 5/5)
- 前提 commits: `c4a9a7f`〜`f2d7f94` (4a〜4b-5a-4 + R2 fix 完了)
- 期待工数: **2-3 日 (Sonnet 実装、Rust 中心)**

---

## 1. Goal

Florence-2 Stage 1 の **token 列 → RawCandidate** 変換を実装し、Stage 1 を完結させる。
具体的には:

- `Florence2Tokenizer::decode(token_ids)` で token 列 → text 復元
- text 内の `<loc_X>` token (X=0..999、quantized coordinate) を regex で抽出、
  4-tuple `(x1, y1, x2, y2)` に group して bbox 座標復元
- 各 bbox を `RawCandidate` (class="region"、label=""、provisional=true) に変換
- `stub_recognise_with_session` から **`florence2_stage1_recognise`** 関数を分離、
  正式な Stage 1 inference 経路完成

同時に 4b-5a-2 RECOMMEND R3 (`eprintln!` → `tracing::warn!` 統一) を対応。

単一目標:

> dogfood (RX 9070 XT + Florence-2-base ONNX artifact + tokenizer.json) で
> `OnnxBackend.recognizeRois(targetKey, rois, w, h, frameBuffer)` が
> Stage 1 で `class="region"` の bbox 候補を返す。Stage 2/3 (4b-5b/c) の入力として使える。

### 明示的に本 batch の scope 外

- OmniParser-v2 (Stage 2) — **4b-5b**
- PaddleOCR-v4 (Stage 3) — **4b-5c**
- Cross-check (multi-engine voting) — 4b-6
- DXGI zero-copy 統合 — Phase 4c
- Real Florence-2 ONNX artifact のダウンロード自動化 (user 手動配置)

---

## 2. Files to touch

### 新規作成

(なし — 既存 florence2.rs / inference.rs への追加)

### 変更

| Path:行 | 変更内容 |
|---|---|
| `Cargo.toml` | `tracing = { version = "0.1", optional = true }` 追加、`vision-gpu` feature に `dep:tracing` 追加 (R3 対応) |
| `src/vision_backend/florence2.rs` | `Florence2Tokenizer::decode(token_ids)` method 追加、`parse_region_proposal_output(text, image_w, image_h)` → `Vec<RawCandidate>` 関数追加、`florence2_stage1_recognise` 関数追加 (本格 inference 経路)、parse 関連テスト追加 |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | `florence-2-base:` prefix で **`florence2::florence2_stage1_recognise(req, sess)` を呼ぶ** ように再構成。preprocess+tokenize+encoder+decoder+parse 全 5 stage を florence2.rs 側に集約。stub の責務は session_key 分岐のみに縮小 |
| `src/vision_backend/inference.rs` 内 `eprintln!` 全箇所 | `tracing::warn!` に置換 (R3) |
| `src/vision_backend/florence2.rs` 内 `eprintln!` 全箇所 (もしあれば) | 同上 |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5a-5 checklist` | `[x]` flip + summary、Stage 1 完結を明記 |

### 削除禁止

- Phase 4a〜4b-5a-4 skeleton 全て (handbook §4.3)
- `Florence2Stage1Sessions` / `EncoderOutputs` / `KvCache` / `DecoderStepOutput` / `encoder_forward` / `decoder_forward` / `generate_tokens` / `greedy_argmax` / 全 helper functions — 4b-5a-3/4 成果物
- `Florence2Tokenizer::tokenize_region_proposal` / `tokenize_with_prompt` / `from_file` / `from_tokenizer` / `PromptTokens` — 4b-5a-2 成果物
- `preprocess_image` / `expected_shape` 等 — 4b-5a-1 成果物
- `catch_unwind` barrier (L5)
- Phase 4b-5 post-review legacy path / typeof guard (4b-5c で削除予定、本 batch では維持)

### Forbidden な依存追加

- 新 npm package 禁止
- `tracing` 以外の Rust crate 追加禁止 (regex 含む — `<loc_X>` の parse は手書きで十分、依存最小化)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

**注**: `tracing` crate 追加は本設計書で明示許可 (R3 対応に必要、ort 内部でも使用される軽量 crate)。

---

## 3. API design

### 3.1 `Florence2Tokenizer::decode` method

```rust
impl Florence2Tokenizer {
    /// Decode a token id sequence back to text using the loaded tokenizer.
    /// `skip_special_tokens = false` because `<loc_X>` and `<region_proposal>`
    /// are part of Florence-2's task output and must be preserved for parsing.
    pub fn decode(&self, token_ids: &[i64]) -> Result<String, VisionBackendError> {
        let ids: Vec<u32> = token_ids.iter().map(|&id| id as u32).collect();
        self.inner.decode(&ids, false).map_err(|e| {
            VisionBackendError::Other(format!("Florence-2 tokenizer decode failed: {e}"))
        })
    }
}
```

### 3.2 `parse_region_proposal_output` 関数

```rust
use crate::vision_backend::types::{RawCandidate, Rect};

/// Parse Florence-2 `<REGION_PROPOSAL>` task output text into bbox candidates.
///
/// Florence-2 emits region proposals as runs of 4 location tokens:
///   `<loc_x1><loc_y1><loc_x2><loc_y2><loc_x1><loc_y1>...`
/// Each `<loc_N>` is a quantized coordinate where N ∈ [0, 999] maps linearly
/// onto the image dimension (0 → 0, 999 → image_w-1 or image_h-1).
/// Bboxes always come in 4-tuples; partial trailing tuples (text length not
/// divisible by 4) are discarded.
///
/// Inputs:
///   - `text`: decoded token sequence (e.g. `"<loc_120><loc_50><loc_400><loc_300>"`)
///   - `image_w` / `image_h`: original image dimensions in pixels (the ROI passed
///     to `preprocess_image`, after which Florence-2 scales coordinates relative to)
///
/// Output: `Vec<RawCandidate>` with class="region", label="", provisional=true,
///   confidence=0.5 (Stage 1 doesn't emit per-bbox confidence — refined in Stage 2).
///
/// Returns an empty Vec on no `<loc_X>` tokens (broken output, no regions detected).
pub fn parse_region_proposal_output(
    text: &str,
    image_w: u32,
    image_h: u32,
) -> Vec<RawCandidate> {
    let coords = extract_loc_tokens(text);
    let mut out = Vec::with_capacity(coords.len() / 4);
    for chunk in coords.chunks_exact(4) {
        let (qx1, qy1, qx2, qy2) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        // Quantized → pixel: floor(q * image_dim / 1000)
        let x1 = ((qx1 as u64) * (image_w as u64) / 1000) as i32;
        let y1 = ((qy1 as u64) * (image_h as u64) / 1000) as i32;
        let x2 = ((qx2 as u64) * (image_w as u64) / 1000) as i32;
        let y2 = ((qy2 as u64) * (image_h as u64) / 1000) as i32;
        // Skip degenerate boxes (zero or negative size after quantization rounding)
        if x2 <= x1 || y2 <= y1 {
            continue;
        }
        out.push(RawCandidate {
            track_id: format!("florence2-stage1-{}", out.len()),
            rect: Rect {
                x: x1,
                y: y1,
                width: x2 - x1,
                height: y2 - y1,
            },
            label: String::new(),
            class: "region".into(),
            confidence: 0.5,
            provisional: true,
        });
    }
    out
}

/// Extract all `<loc_N>` integers from the text in order.
/// Manual parser (no regex dep) — scans for the literal prefix "<loc_" and
/// reads until ">". Robust against intermixed task tokens and arbitrary text.
fn extract_loc_tokens(text: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    let prefix = b"<loc_";
    while i + prefix.len() <= bytes.len() {
        if &bytes[i..i + prefix.len()] == prefix {
            // Found "<loc_", scan until '>'
            let mut j = i + prefix.len();
            let mut value: u32 = 0;
            let mut any_digit = false;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                // Saturating parse — a malformed huge number caps at u32::MAX,
                // but downstream we clamp to [0, 999] anyway.
                value = value.saturating_mul(10).saturating_add((bytes[j] - b'0') as u32);
                any_digit = true;
                j += 1;
            }
            if any_digit && j < bytes.len() && bytes[j] == b'>' {
                // Clamp to the canonical Florence-2 range [0, 999].
                out.push(value.min(999));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}
```

### 3.3 `florence2_stage1_recognise` proper function

```rust
/// Stage 1 region proposer entry point. Runs the full Florence-2 pipeline:
///   1. preprocess (4b-5a-1)
///   2. tokenize (4b-5a-2)
///   3. encoder forward (4b-5a-3)
///   4. decoder + autoregressive loop (4b-5a-4)
///   5. token decode + parse → RawCandidate (this batch, 4b-5a-5)
///
/// Returns `Ok(Vec<RawCandidate>)` with class="region" bboxes on success.
/// Returns `Err` on any pipeline step failure — caller (`stub_recognise_with_session`)
/// converts to fall-through dummy output for L5 robustness.
pub fn florence2_stage1_recognise(
    req: &RecognizeRequest,
    sess: &VisionSession,
) -> Result<Vec<RawCandidate>, VisionBackendError> {
    if req.frame_buffer.is_empty() {
        return Err(VisionBackendError::Other("frame_buffer is empty".into()));
    }
    let stage1 = Florence2Stage1Sessions::from_pool(&sess.session_key)
        .ok_or_else(|| VisionBackendError::Other(format!(
            "Stage1 sub-sessions not in pool for {}",
            sess.session_key,
        )))?;

    // Step 1: preprocess
    let roi = req.rois.first().map(|r| r.rect.clone()).unwrap_or(Rect {
        x: 0, y: 0,
        width: req.frame_width as i32,
        height: req.frame_height as i32,
    });
    let pixel_values = preprocess_image(
        &req.frame_buffer,
        req.frame_width,
        req.frame_height,
        &roi,
    )?;

    // Step 2: tokenize
    let tokenizer_path = match crate::vision_backend::inference::tokenizer_path_for_session(sess) {
        Some(p) if p.exists() => p,
        Some(_) => return Err(VisionBackendError::Other("tokenizer.json not found".into())),
        None => return Err(VisionBackendError::Other("model_path has no parent dir".into())),
    };
    let tokenizer = Florence2Tokenizer::from_file(&tokenizer_path)?;
    let prompt_tokens = tokenizer.tokenize_region_proposal()?;

    // Step 3: encoder
    let encoder_outputs = stage1.encoder_forward(pixel_values, &prompt_tokens)?;

    // Step 4: decoder loop
    let token_ids = stage1.generate_tokens(&encoder_outputs, FLORENCE2_DEFAULT_MAX_LENGTH)?;

    // Step 5: decode + parse
    let text = tokenizer.decode(&token_ids)?;
    let candidates = parse_region_proposal_output(
        &text,
        roi.width.max(0) as u32,
        roi.height.max(0) as u32,
    );
    Ok(candidates)
}
```

### 3.4 `inference.rs::stub_recognise_with_session` 簡素化

```rust
fn stub_recognise_with_session(
    req: RecognizeRequest,
    sess: std::sync::Arc<crate::vision_backend::session::VisionSession>,
) -> Vec<RawCandidate> {
    if sess.session_key.starts_with("florence-2-base:") {
        match crate::vision_backend::florence2::florence2_stage1_recognise(&req, &sess) {
            Ok(candidates) => return candidates,
            Err(e) => {
                tracing::warn!(target: "florence2", "stage1 recognise failed: {e}");
                // Fall through to dummy output for L5 robustness.
            }
        }
    }
    dummy_recognise(req)
}

// `tokenizer_path_for_session` を pub(crate) に格上げ (florence2_stage1_recognise から呼ぶため)
pub(crate) fn tokenizer_path_for_session(
    sess: &crate::vision_backend::session::VisionSession,
) -> Option<std::path::PathBuf> {
    std::path::Path::new(&sess.model_path)
        .parent()
        .map(|p| p.join("tokenizer.json"))
}
```

### 3.5 `eprintln!` → `tracing::warn!` 統一 (R3)

`src/vision_backend/inference.rs` 内の全 `eprintln!("[florence2] ...")` を
`tracing::warn!(target: "florence2", "...")` に置換。

`Cargo.toml`:
```toml
tracing = { version = "0.1", optional = true }
# vision-gpu feature にも追加
vision-gpu = ["dep:ort", "dep:image", "dep:ndarray", "dep:tokenizers", "dep:tracing"]
```

---

## 4. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0 (tracing も未解決確認)
- [ ] `tsc --noEmit` exit 0
- [ ] vitest 4 test file regression 0
- [ ] 最終 full suite で regression 0
- [ ] ADR-005 §5 4b-5a-5 `[x]` flip + summary、**「Stage 1 完結」を明記**
- [ ] 設計書 Status → Implemented (commit hash)
- [ ] Opus self-review BLOCKING 0
- [ ] Rust 8-10 ケース新規 parse test を `florence2.rs::parse_tests` に追加
- [ ] `eprintln!` 全箇所 `tracing::warn!` 置換確認 (`grep -r "eprintln" src/vision_backend/` で 0 件)

---

## 5. Test cases

### 5.1 Rust unit tests (`florence2.rs::parse_tests`)

```rust
#[cfg(all(test, feature = "vision-gpu"))]
mod parse_tests {
    use super::*;

    #[test]
    fn extract_loc_tokens_simple() {
        let text = "<loc_120><loc_50><loc_400><loc_300>";
        let coords = extract_loc_tokens(text);
        assert_eq!(coords, vec![120, 50, 400, 300]);
    }

    #[test]
    fn extract_loc_tokens_empty_string() {
        assert_eq!(extract_loc_tokens(""), Vec::<u32>::new());
    }

    #[test]
    fn extract_loc_tokens_no_loc_tokens() {
        assert_eq!(extract_loc_tokens("hello world"), Vec::<u32>::new());
    }

    #[test]
    fn extract_loc_tokens_with_intermixed_text() {
        let text = "panel<loc_100><loc_200><loc_300><loc_400>form<loc_50><loc_60><loc_900><loc_950>";
        let coords = extract_loc_tokens(text);
        assert_eq!(coords, vec![100, 200, 300, 400, 50, 60, 900, 950]);
    }

    #[test]
    fn extract_loc_tokens_clamps_to_999() {
        let text = "<loc_1500><loc_99999>";
        assert_eq!(extract_loc_tokens(text), vec![999, 999]);
    }

    #[test]
    fn extract_loc_tokens_skips_malformed() {
        let text = "<loc_><loc_abc><loc_500>";
        // First two have no digits / non-digit content; only "<loc_500>" valid.
        assert_eq!(extract_loc_tokens(text), vec![500]);
    }

    #[test]
    fn parse_region_proposal_basic_bbox() {
        // Quantized [120, 50, 400, 300] on 1000x500 image → pixels [120, 25, 400, 150]
        let text = "<loc_120><loc_50><loc_400><loc_300>";
        let candidates = parse_region_proposal_output(text, 1000, 500);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].class, "region");
        assert_eq!(candidates[0].label, "");
        assert!(candidates[0].provisional);
        assert_eq!(candidates[0].rect.x, 120);
        assert_eq!(candidates[0].rect.y, 25);
        assert_eq!(candidates[0].rect.width, 400 - 120);
        assert_eq!(candidates[0].rect.height, 150 - 25);
    }

    #[test]
    fn parse_region_proposal_multiple_bboxes() {
        let text = "<loc_0><loc_0><loc_500><loc_500><loc_500><loc_500><loc_999><loc_999>";
        let candidates = parse_region_proposal_output(text, 1000, 1000);
        assert_eq!(candidates.len(), 2);
    }

    #[test]
    fn parse_region_proposal_drops_partial_trailing() {
        // 5 loc tokens — last one is partial 4-tuple, dropped
        let text = "<loc_100><loc_100><loc_500><loc_500><loc_700>";
        let candidates = parse_region_proposal_output(text, 1000, 1000);
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn parse_region_proposal_skips_degenerate_bbox() {
        // x2 <= x1 case
        let text = "<loc_500><loc_100><loc_400><loc_500>";
        let candidates = parse_region_proposal_output(text, 1000, 1000);
        assert_eq!(candidates.len(), 0);
    }

    #[test]
    fn parse_region_proposal_empty_text() {
        let candidates = parse_region_proposal_output("", 1000, 1000);
        assert_eq!(candidates.len(), 0);
    }

    #[test]
    fn parse_region_proposal_unique_track_ids() {
        let text = "<loc_0><loc_0><loc_100><loc_100><loc_100><loc_100><loc_200><loc_200>";
        let candidates = parse_region_proposal_output(text, 1000, 1000);
        assert_eq!(candidates.len(), 2);
        assert_ne!(candidates[0].track_id, candidates[1].track_id);
    }
}
```

### 5.2 既存テスト維持

- 4b-5a-1 `tests` (7) / 4b-5a-2 `tokenizer_tests` (6) / 4b-5a-3 `encoder_tests` (5) / 4b-5a-4 `decoder_tests` (8) — 全パス維持

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| `tokenizers::Tokenizer::decode` の引数型 (`&[u32]` か `Vec<u32>` か `slice`) | docs.rs/tokenizers で確認、ort 0.21 では `decode(&self, ids: &[u32], skip_special_tokens: bool) -> Result<String>` |
| `decode` が `<loc_X>` を skip する設定の場合 | `skip_special_tokens = false` を必ず指定。Florence-2 の loc tokens は special tokens として登録されているため |
| BART tokenizer が `<loc_X>` を `loc_X` (`<` `>` なし) として decode する | `<loc_X>` 形式が出ない場合 fallback として `loc_X` 形式の parser も検討すべき。本 batch では `<loc_X>` 想定、不一致時は dogfood verify で eprintln 経由で気付く設計 |
| Quantized 0-999 → pixel 変換の boundary (loc_999 → image_w-1 or image_w?) | 設計通り floor(q * dim / 1000): loc_999 on dim=1000 → 999、loc_999 on dim=2000 → 1998 |
| `<loc_X>` parse の overflow (`<loc_99999999999>`) | `saturating_mul/add` + `min(999)` で clamp |
| `roi.width / height` が i32 で負数の可能性 | `.max(0) as u32` で defensive cast |
| tracing crate の direct dep 追加で binary size 増 | tracing は ~50KB pure logging crate、ort も内部で使うのでほぼ無料 |
| `tokenizer_path_for_session` の visibility (現在 private) → florence2.rs から呼べない | `pub(crate)` に格上げ (§3.4 で明示) |
| `florence2_stage1_recognise` 内 `req.rois.first()` が None | `unwrap_or` で full-frame ROI に fallback (4b-5a-1 と同じ pattern) |
| `RawCandidate.track_id` の uniqueness | format! で順序付き ID、index ベース |
| Florence-2 が <REGION_PROPOSAL> task で **無関係 token** を吐く (BOS/EOS/`<region_proposal>` etc.) | `extract_loc_tokens` は `<loc_` 接頭辞のみ拾うので無関係 token は無視 |
| Stage 2 (4b-5b) が「Stage 1 の class='region' candidates を ROI として受ける」設計 | RawCandidate.class="region" を維持、Stage 2 が class_hint="region" を受け取り fine detection |

---

## 7. Acceptable Sonnet judgment scope

- `tokenizers::Tokenizer::decode` の正確な signature (`&[u32]` vs `Vec<u32>`) と error type
- `tracing` crate version (0.1 stable、microversion patch up は OK)
- parse_tests 8-12 ケース範囲で +α
- track_id format 命名 (`florence2-stage1-{i}` 推奨だが微調整可)
- floor 演算の整数除算 vs `(q * dim) / 1000` 順序 (overflow 回避のため u64 経由は必須)
- commit 分割 (3-4 commit 推奨: tokenizer.decode + parse / florence2_stage1_recognise wire / tracing 統一 / docs)

---

## 8. Forbidden Sonnet judgments

### 8.1 API surface 変更
- `VisualBackend` interface 不変
- `ModelRegistry` / `ModelManifest` 不変
- `RecognizeRequest` / `NativeRecognizeRequest` 不変
- `VisionSession::create` signature 不変
- `Florence2Stage1Sessions::encoder_forward` / `decoder_forward` / `generate_tokens` (4b-5a-3/4 signature 不変)
- `Florence2Tokenizer::tokenize_region_proposal` / `tokenize_with_prompt` / `from_file` / `from_tokenizer` 不変 (`decode` は新規追加で OK)
- `RawCandidate` shape 不変

### 8.2 Scope 変更
- OmniParser-v2 / PaddleOCR-v4 実装禁止 (4b-5b/c)
- Cross-check (multi-engine voting) 禁止 (4b-6)
- Phase 4a〜4b-5a-4 成果物変更禁止 (`pub(crate)` 化のみ例外、§3.4)
- DXGI zero-copy 禁止
- ModelManifest schema 変更禁止
- HF Hub network 連携禁止
- regex crate 追加禁止 (手書き parser で十分)

### 8.3 依存追加禁止
- 新 npm package 禁止
- `tracing` 以外の Rust crate 追加禁止
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 8.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)
- `eprintln!` → `tracing::warn!` 置換に伴う test 書換は不要 (test は output stream を assert していない)

### 8.5 絶対不変
- `catch_unwind` barrier 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止
- Phase 4b-5 post-review legacy path / typeof guard (4b-5c まで維持)
- 4b-5a-1 post-review addendum「cargo test 不可受容」基準継承

### 8.6 ドキュメント更新義務
- ADR-005 §5 4b-5a-5 `[x]` flip + summary、**Stage 1 完結を明記**
- 本設計書 Status → Implemented + commit hash

---

## 9. Future work / 次 batch (4b-5b)

- Stage 2 = OmniParser-v2 (single-pass YOLO-like UI element detector)
- 入力: Stage 1 出力の class="region" candidates を ROI として受ける
- 出力: fine-grained UI element bboxes (button/checkbox/text/icon/...)
- Tensor I/O / multi-session pattern は本 batch までで確立済、再利用
- 単純な single-pass session.run のみ、autoregressive loop 不要 → 工数 4-5 日想定

---

## 10. 実装順序 (Sonnet 手順)

### Cargo.toml + tracing 統一

1. `Cargo.toml [dependencies]` に `tracing = { version = "0.1", optional = true }` 追加
2. `[features] vision-gpu = [..., "dep:tracing"]` に追加
3. `src/vision_backend/inference.rs` 内 `eprintln!("[florence2] ...")` 全箇所を `tracing::warn!(target: "florence2", "...")` に置換
4. `src/vision_backend/florence2.rs` 内 `eprintln!` (もし残っていれば) も同様置換
5. `cargo check --release --features vision-gpu` exit 0
6. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
7. `cargo check --release --no-default-features` exit 0 (tracing 未解決確認)

### Florence2Tokenizer::decode + parse_region_proposal_output

8. `florence2.rs` に §3.1 `decode` method 追加
9. `florence2.rs` に §3.2 `parse_region_proposal_output` + `extract_loc_tokens` 追加
10. `parse_tests` mod 追加 (§5.1 8-12 ケース)
11. `cargo check --release --features vision-gpu` exit 0

### florence2_stage1_recognise + stub 簡素化

12. `inference.rs::tokenizer_path_for_session` を `pub(crate)` に格上げ
13. `florence2.rs` に §3.3 `florence2_stage1_recognise` 関数追加
14. `inference.rs::stub_recognise_with_session` を §3.4 通り簡素化 (florence2 経路は florence2_stage1_recognise 呼出のみ)
15. `cargo check --release --features vision-gpu` exit 0

### 最終確認

16. `tsc --noEmit` exit 0
17. vitest 4 test file regression 0 (TS touch なし)
18. `npm run test:capture -- --force` 最終 1 回 (regression 0)
19. ADR-005 §5 4b-5a-5 `[x]` flip + 「Stage 1 完結」summary
20. 設計書 Status → Implemented + commit hash
21. commit 分割 (推奨 4 commit):
    - A: `feat(vision-gpu): Phase 4b-5a-5 — tracing crate adoption + eprintln→tracing::warn! (R3)`
    - B: `feat(vision-gpu): Phase 4b-5a-5 — Florence2Tokenizer::decode + parse_region_proposal_output`
    - C: `feat(vision-gpu): Phase 4b-5a-5 — florence2_stage1_recognise (Stage 1 完結) + stub simplify`
    - D: `docs(vision-gpu): Phase 4b-5a-5 — ADR §5 + design Status (Stage 1 done)`
22. push origin desktop-touch-mcp-fukuwaraiv2
23. Opus self-review (本人 Opus session 別途実施)
24. notification + handbook §6.1 報告

---

END OF DESIGN DOC.
