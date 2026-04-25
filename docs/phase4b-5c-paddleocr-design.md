# Phase 4b-5c 設計書 — PaddleOCR-v4 Stage 3 (text OCR) + 4b-5 post-review legacy 除去

- Status: Implemented (2026-04-25、commits `2778847`〜`094183f`)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D5' Stage 3 (PaddleOCR-v4 text recognition)
- 対応 ADR-005 §5 batch: 4b-5c (**4b-5 シリーズの最終**)
- 前提 commits: `c4a9a7f`〜`cbb30ed` (4a〜4b-5b 完了、Stage 1/2 完結済)
- 期待工数: **3-4 日 (Sonnet 実装、Rust 中心 + TS legacy 除去)**

---

## 1. Goal

**メインタスク**:
Stage 3 = **PaddleOCR-v4 text recognition** を実装し、Stage 2 から受けた `class="ui_element"` 候補の各 bbox 領域に対して OCR を実行、認識された text を `label` に埋めて `class="text"` の RawCandidate を返す。Stage 1→2→3 直列 pipeline が end-to-end で動く状態に到達。

**サブタスク (4b-5 post-review の cleanup)**:
- `OnnxBackend.recognizeRois` の legacy path fall-through 削除 (4b-5 post-review BLOCKING B1 で残置されていた)
- `ensureWarm` の `typeof visionInitSession !== "function"` guard 削除 (同 B1)
- 該当 Block A / Block B 既存テストを新 API 挙動に accuracy 追従 (handbook §4.1 範囲)

同時に 4b-5b review RECOMMEND R1 (omniparser / florence2 preprocess 共通化) は本 batch scope 外 — 将来 ADR で抽出。

### scope 外

- Cross-check (multi-engine voting) — 4b-6
- PaddleOCR 検出 model (text_detect) — Stage 2 (OmniParser) が bbox を提供するので **recognition のみ**
- PaddleOCR direction classifier — text 向きは通常水平想定、cls は省略
- PaddleOCR-mobile variant (INT8) — 同アルゴリズムなので将来 variant 切替で対応
- Florence-2 icon_caption / GOT-OCR2 / Surya 等 — 将来 ADR

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `src/vision_backend/paddleocr.rs` | PaddleOCR-v4 server recognition の preprocess (dynamic width) + single-pass forward + CTC greedy decode + dict lookup | ~320 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/vision_backend/mod.rs` | `pub mod paddleocr;` 追加 |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | `paddleocr-v4-server:` prefix dispatch 追加 (else-if chain 3rd arm) |
| `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` | **legacy path fall-through 削除** (4b-5 post-review B1)。warm 未達時は `[]` を返す (設計書 §3.8 の元仕様に回帰) |
| `src/engine/vision-gpu/onnx-backend.ts::ensureWarm` | **`typeof nativeVision.visionInitSession !== "function"` guard 削除** (4b-5 post-review B1)。guard 削除後は `visionInitSession` 不在なら evicted へ遷移 |
| `src/engine/vision-gpu/onnx-backend.ts::recognizeRoisLegacy` helper | **削除** (legacy path 本体除去) |
| `tests/unit/visual-gpu-onnx-backend.test.ts` Block A / Block B | 新 API 挙動へ accuracy 追従 (Block A: `visionInitSession 不在 → "evicted"` 期待に変更、Block B: `ensureWarm 未呼出 → recognizeRois は [] 返却` 期待に変更)。handbook §4.1 accuracy 追従として明示許可 |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5c checklist` | `[x]` flip + summary、「Stage 3 完結 + 4b-5 post-review legacy 除去」明記 |

### 削除禁止

- Phase 4a〜4b-5b skeleton 全て (Florence-2 Stage 1 / OmniParser Stage 2 全関数)
- `catch_unwind` barrier
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU`
- `PocVisualBackend` / `bin/win-ocr.exe`

### Forbidden な依存追加

- 新 npm package 禁止
- 新 Rust crate 追加禁止 (CTC decode は手書き、dict loading は `std::fs` で十分)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

---

## 3. API design

### 3.1 PaddleOCR config + dict loading

```rust
//! PaddleOCR-v4 Stage 3 (text recognition) inference module.
//!
//! PaddleOCR-v4 server recognition is a CRNN/SVTR-based sequence model that
//! takes a cropped text-region image (fixed H=48, variable W) and outputs
//! CTC logits over a character dictionary (~6625 classes for PP-OCRv4 multilingual).

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

    pub fn num_classes(&self) -> usize { self.chars.len() }

    /// Look up character by class id. Returns empty string for blank or OOB.
    pub fn lookup(&self, class_id: usize) -> &str {
        self.chars.get(class_id).map(|s| s.as_str()).unwrap_or("")
    }
}
```

### 3.2 Image preprocess (PaddleOCR 用、dynamic width)

```rust
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

// clip_roi / extract_crop_rgb / resize_bilinear_rgb は florence2/omniparser と重複 —
// 将来 ADR で image_utils 抽出 (4b-5b R1 継承)
```

### 3.3 Single-pass forward + CTC greedy decode

```rust
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
    for (i, roi) in req.rois.iter().enumerate() {
        // Per-ROI preprocess + forward + decode
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
    Ok(out)
}

fn dict_path_for_session(sess: &VisionSession) -> Option<std::path::PathBuf> {
    Path::new(&sess.model_path)
        .parent()
        .map(|p| p.join("paddleocr_keys.txt"))
}

#[cfg(feature = "vision-gpu")]
fn run_rec(
    sess: &VisionSession,
    pixel_values: Array4<f32>,
) -> Result<Array3<f32>, VisionBackendError> {
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
```

### 3.4 `stub_recognise_with_session` dispatch 追加

```rust
fn stub_recognise_with_session(
    req: RecognizeRequest,
    sess: std::sync::Arc<crate::vision_backend::session::VisionSession>,
) -> Vec<RawCandidate> {
    if sess.session_key.starts_with("florence-2-base:") {
        match crate::vision_backend::florence2::florence2_stage1_recognise(&req, &sess) {
            Ok(c) => return c,
            Err(e) => tracing::warn!(target: "florence2", "stage1 failed: {e}"),
        }
    } else if sess.session_key.starts_with("omniparser-v2-icon-detect:") {
        match crate::vision_backend::omniparser::omniparser_stage2_recognise(&req, &sess) {
            Ok(c) => return c,
            Err(e) => tracing::warn!(target: "omniparser", "stage2 failed: {e}"),
        }
    } else if sess.session_key.starts_with("paddleocr-v4-server:") {
        match crate::vision_backend::paddleocr::paddleocr_stage3_recognise(&req, &sess) {
            Ok(c) => return c,
            Err(e) => tracing::warn!(target: "paddleocr", "stage3 failed: {e}"),
        }
    }
    dummy_recognise(req)
}
```

### 3.5 TS 側: legacy path / typeof guard 除去 (4b-5 post-review B1 clean)

```typescript
// onnx-backend.ts::ensureWarm — typeof guard 削除
async ensureWarm(target: WarmTarget): Promise<WarmState> {
  if (!OnnxBackend.isAvailable()) {
    this.state = "evicted";
    return this.state;
  }
  // 削除: `typeof nativeVision!.visionInitSession !== "function"` guard
  // 4b-5a-1〜4b-5c で visionInitSession は常時 available の前提が確立済

  if (this.state === "warm" && this.stageKeys !== null) return "warm";
  // ... 以降は従来通り manifest load + 3 × visionInitSession
}

// onnx-backend.ts::recognizeRois — legacy path 削除
async recognizeRois(
  targetKey: string,
  rois: RoiInput[],
  frameWidth?: number,
  frameHeight?: number,
  frameBuffer?: Buffer,
): Promise<UiEntityCandidate[]> {
  if (!OnnxBackend.isAvailable() || !nativeVision?.visionRecognizeRois) return [];
  if (rois.length === 0) return [];
  if (this.state !== "warm" || this.stageKeys === null) {
    // 4b-5 post-review B1 fix 削除後の挙動: warm 未達 → [] 返却
    // (旧 4b-1 時代の Block B test backward-compat 期間終了)
    return [];
  }
  // ... stage pipeline 経由 (従来通り)
}

// onnx-backend.ts::recognizeRoisLegacy helper 削除
// (4b-5 post-review で追加された互換 helper、本 batch で除去)
```

既存テスト更新 (handbook §4.1 accuracy 追従):
- Block A (`visionInitSession intentionally absent`): 期待 state `"warm"` → `"evicted"`
- Block B: `ensureWarm 未呼出で recognizeRois を呼ぶ → native 呼出` 期待を `[]` 返却期待に変更

---

## 4. Done criteria

- [ ] cargo check 3 features set 全 exit 0
- [ ] tsc --noEmit exit 0
- [ ] vitest: stage-pipeline 6 + onnx-backend 更新版 (B1 除去に伴い Block A/B の期待値変更) + model-registry 22 + session 17 / regression 0
- [ ] 最終 full suite で regression 0
- [ ] ADR-005 §5 4b-5c `[x]` flip + 「Stage 3 完結 + 4b-5 post-review B1 legacy 除去」明記
- [ ] 設計書 Status → Implemented + commit hash
- [ ] Opus self-review BLOCKING 0
- [ ] Rust 7-10 ケース `paddleocr.rs::tests`
- [ ] `recognizeRoisLegacy` helper 削除確認 (`grep -n "recognizeRoisLegacy" src/engine/vision-gpu/` で 0 件)
- [ ] `typeof nativeVision.*.visionInitSession` guard 削除確認

---

## 5. Test cases

### 5.1 Rust `paddleocr.rs::tests`

```rust
#[cfg(all(test, feature = "vision-gpu"))]
mod tests {
    use super::*;
    use ndarray::Array3;
    use std::io::Write;

    fn synth_rgba(w: u32, h: u32, fill: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) { v.extend_from_slice(&fill); }
        v
    }

    fn write_tmp_dict(lines: &[&str]) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("paddleocr-test-{}.txt", std::process::id()));
        let mut f = std::fs::File::create(&tmp).expect("create dict");
        for line in lines { writeln!(f, "{line}").unwrap(); }
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
}
```

### 5.2 TS test updates (Block A/B accuracy 追従)

```typescript
// tests/unit/visual-gpu-onnx-backend.test.ts

// Block A 変更: visionInitSession intentionally absent → ensureWarm should transition to "evicted"
describe("OnnxBackend without visionInitSession (post-4b-5c legacy removal)", () => {
  it("ensureWarm() transitions to 'evicted' when visionInitSession is absent", async () => {
    // ... (mock without visionInitSession)
    const state = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(state).toBe("evicted"); // changed from "warm"
  });
});

// Block B 変更: recognizeRois without ensureWarm → returns [] (legacy path removed)
describe("visionInitSession with mocked native binding", () => {
  it("recognizeRois without ensureWarm returns [] (post-4b-5c)", async () => {
    // ... (mock)
    const result = await backend.recognizeRois("window:1", [{ trackId: "t1", rect: {...} }]);
    expect(result).toEqual([]); // changed from "native called 1 time"
  });
});
```

他の Block B tests (Block C label format、Block D warm path、Block E frameBuffer forwarding) は **挙動変更なし**、既存のまま全パス。

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| PaddleOCR rec ONNX input name (`x` vs `images` vs `input`) | PaddlePaddle export の convention は `x`、runtime error なら fallback |
| dict file 名 (`paddleocr_keys.txt` vs `ppocr_keys_v1.txt` vs `dict.txt`) | convention `paddleocr_keys.txt` で揃える、不在なら Err |
| PaddleOCR output shape: `[1, seq_len, num_classes]` vs `[1, num_classes, seq_len]` | 通常 `[B, T, C]`、ONNX export で軸順序違いあれば transpose |
| CTC blank が index 0 か num_classes-1 か (export 依存) | PP-OCRv4 標準は 0、違う場合は const 切替 |
| 複数 ROI を loop するので slow — 10 ROI で 50ms想定 | 許容 (Stage 2 が ROI 数を 10-30 程度に絞る設計) |
| 固定 H=48 が入力に合わない (縦書き text) | 本 batch は横書き前提、縦書きは将来 ADR |
| dict UTF-8 multi-byte char (Japanese/Chinese) | `String::push_str` で multi-byte 安全、line 単位 split で mojibake 回避 |
| tests で tmp file の cleanup 漏れ | `std::fs::remove_file(path).ok()` 使用 (失敗許容) |
| ctc_greedy_decode の f32::NEG_INFINITY 初期値で全 NaN 入力時 | best_idx=0 (blank) → 空 string 返却、適切 |
| Block A/B test 更新が handbook §4.1 違反にならないか | 本設計書 §3.5 で accuracy 追従として明示許可、logic/API 変更に追従するだけで logic は不変 |

---

## 7. Acceptable Sonnet judgment scope

- PaddleOCR rec ONNX input name (`x` が正しいが別名なら retry)
- dict path file 名 (`paddleocr_keys.txt` 推奨、別名でも可)
- ctc_greedy_decode の blank index default (0 を期待、他 export で違えば const 切替)
- tests +α (§5.1 10 ケース超え可)
- commit 分割 (推奨 3-4 commit: paddleocr / TS legacy removal / tests update / docs)
- normalize constants 微調整 (PP-OCRv4 server vs mobile で差がある可能性)

---

## 8. Forbidden Sonnet judgments

### 8.1 API surface 変更
- 既存 public API 不変 (florence2 / omniparser / VisualBackend / RawCandidate 等)
- `ensureWarm` / `recognizeRois` signature 不変 (body 内 logic のみ改修)
- `isAvailable` / `dispose` / `onDirty` / `getStableCandidates` / `updateSnapshot` / `getWarmState` 不変

### 8.2 Scope 変更
- Cross-check (4b-6) 禁止
- PaddleOCR detection / direction classifier 実装禁止
- PaddleOCR-mobile variant dispatcher 禁止 (D3' class-aware、将来 batch)
- Phase 4a〜4b-5b 成果物変更禁止

### 8.3 依存追加禁止
- 新 npm / Rust crate 禁止
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 8.4 テスト書換禁止
- Block A/B 以外の既存 test body 変更禁止
- Block A/B 変更は **accuracy 追従**、logic 不変

### 8.5 絶対不変
- catch_unwind barrier 削除禁止
- DESKTOP_TOUCH_ENABLE_ONNX_BACKEND / DISABLE_VISUAL_GPU 維持
- PocVisualBackend / bin/win-ocr.exe 削除禁止

### 8.6 ドキュメント更新義務
- ADR-005 §5 4b-5c `[x]` flip + 「Stage 3 完結 + 4b-5 post-review B1 除去」明記
- 本設計書 Status → Implemented + commit hash

---

## 9. Future work (4b-6 以降)

- Cross-check (multi-engine voting) — D3' が 2 engine の Levenshtein distance で投票
- PaddleOCR-mobile variant dispatcher — text density でルーティング (ADR §281)
- BenchmarkHarness 実測 (4b-7) + vendor matrix (4b-8)
- 4b-5b R1 (florence2/omniparser/paddleocr preprocess helpers 共通化 — `vision_backend::image_utils` 抽出 ADR-007 候補)

---

## 10. 実装順序

1. `src/vision_backend/paddleocr.rs` 新規作成 (§3.1〜§3.3 全コード + `paddleocr.rs::tests`)
2. `src/vision_backend/mod.rs` に `pub mod paddleocr;` 追加
3. `src/vision_backend/inference.rs::stub_recognise_with_session` に paddleocr dispatch 追加 (§3.4)
4. cargo check 3 features set 全 exit 0
5. `src/engine/vision-gpu/onnx-backend.ts::ensureWarm` から `typeof visionInitSession` guard 削除 (§3.5)
6. `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` から legacy path 削除 (§3.5)
7. `recognizeRoisLegacy` helper 削除
8. `tests/unit/visual-gpu-onnx-backend.test.ts` Block A/B accuracy 追従 (expect 値変更のみ)
9. tsc --noEmit exit 0
10. vitest 4 test file regression 0 (Block A/B は期待値変更済)
11. `npm run test:capture -- --force` 最終 1 回 (regression 0)
12. ADR-005 §5 4b-5c `[x]` flip + Stage 3 完結明記 + 4b-5 post-review B1 除去記述
13. 設計書 Status → Implemented + commit hash
14. commit 分割 (推奨 4):
    - A: `feat(vision-gpu): Phase 4b-5c — PaddleOCR-v4 Stage 3 recognition (Rust)`
    - B: `feat(vision-gpu): Phase 4b-5c — paddleocr dispatch in stub_recognise_with_session`
    - C: `refactor(vision-gpu): Phase 4b-5c — remove 4b-5 post-review legacy path + typeof guard (B1)`
    - D: `docs(vision-gpu): Phase 4b-5c — ADR §5 + design Status (Stage 3 done)`
15. push origin
16. Opus self-review (Opus session 別途)
17. notification + handbook §6.1 報告

END.
