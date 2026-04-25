# Phase 4b-5b 設計書 — OmniParser-v2 Stage 2 (UI element detector)

- Status: Implemented — commit TBD (2026-04-25)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D5' Stage 2 (OmniParser-v2 icon_detect — fine UI element detector)
- 対応 ADR-005 §5 batch: 4b-5b
- 前提 commits: `c4a9a7f`〜`f9d37e4` (4a〜4b-5a-5 全完了、Florence-2 Stage 1 完結済)
- 期待工数: **3-4 日 (Sonnet 実装、Rust 中心)**

---

## 1. Goal

Stage 2 = **OmniParser-v2 icon_detect** (Microsoft 提供の YOLO11-based UI element detector) を
single-pass forward で動かし、Stage 1 の region candidates を ROI として受け、
fine-grained UI element bboxes (class: button / checkbox / text / icon / ...) を出力する。

Florence-2 (encoder-decoder + autoregressive loop) と異なり、**OmniParser は単純な
single-pass detector** なので Florence-2 の 5 sub-batch 構造は不要。本 batch 1 つで完結。

単一目標:

> `omniparser_stage2_recognise(req, sess)` が image preprocess → 単一 ort::Session::run →
> YOLO 出力 decode + NMS → `RawCandidate[]` (class: 細分化された UI element class) を返す。
> `stub_recognise_with_session` で `omniparser-v2-icon-detect:` prefix dispatch。

### 明示的に本 batch の scope 外

- PaddleOCR-v4 (Stage 3) — **4b-5c**
- Cross-check (multi-engine voting) — 4b-6
- icon_caption model (BLIP-based icon describer) — 将来 ADR、本 batch では icon_detect のみ
- DXGI zero-copy 統合 — Phase 4c

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `src/vision_backend/omniparser.rs` | OmniParser-v2 icon_detect の preprocess + single-pass forward + YOLO output decode + NMS + RawCandidate 化 | ~280 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/vision_backend/mod.rs` | `pub mod omniparser;` 追加 |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | `omniparser-v2-icon-detect:` prefix dispatch を `florence-2-base:` の next else-if として追加。`omniparser::omniparser_stage2_recognise(&req, &sess)` を呼ぶ |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5b checklist` | `[x]` flip + summary、Stage 2 完結明記 |

### 削除禁止

- Phase 4a〜4b-5a-5 skeleton 全て (handbook §4.3、Florence-2 Stage 1 完成品含む)
- `florence2.rs` 全関数 / 構造体 / `florence2_stage1_recognise`
- `catch_unwind` barrier
- Phase 4b-5 post-review legacy path / typeof guard (4b-5c で削除予定)
- 既存 `tracing::warn!` 統一 (4b-5a-5 R3 成果)

### Forbidden な依存追加

- 新 npm package 禁止
- 新 Rust crate 追加禁止 (NMS は手書き実装、既存 `image` / `ndarray` / `tokenizers` (decode 不要だが既設) / `tracing` のみ使用)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

---

## 3. API design

### 3.1 OmniParser config 定数

```rust
//! OmniParser-v2 Stage 2 (icon_detect) inference module.
//!
//! Microsoft's OmniParser-v2 icon_detect is a YOLO11-based detector trained
//! on UI screenshots. It outputs bounding boxes for clickable UI elements:
//! buttons, checkboxes, icons, text blocks, etc.
//!
//! Input: RGB image at the model's expected size (1280×1280 per HF model card).
//! Output: `[1, num_classes + 4, num_anchors]` — YOLOv8/v11 format with bbox
//! (cxcywh) + per-class confidences. Decode + NMS → bbox candidates.

#[cfg(feature = "vision-gpu")]
use ndarray::{Array3, Array4, ArrayView3};

use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::types::{RawCandidate, Rect, RecognizeRequest};
use crate::vision_backend::session::VisionSession;
use crate::vision_backend::session_pool::global_pool;

/// OmniParser-v2 icon_detect input side (square, per HF model card).
pub const OMNIPARSER_INPUT_SIDE: u32 = 1280;

/// Confidence threshold for keeping a detection (typical YOLO default 0.25).
pub const OMNIPARSER_CONF_THRESHOLD: f32 = 0.25;

/// IoU threshold for NMS (typical YOLO default 0.45).
pub const OMNIPARSER_IOU_THRESHOLD: f32 = 0.45;

/// Class label names. OmniParser-v2 icon_detect is trained as a single-class
/// detector ("ui_element"); fine-grained classification (button/checkbox/text)
/// is added by Stage 2.5 (icon_caption) or downstream class_hint propagation.
/// For 4b-5b we emit class="ui_element" — Stage 3 OCR refines text-class
/// candidates by setting label.
pub const OMNIPARSER_CLASS: &str = "ui_element";
```

### 3.2 Image preprocess (YOLO 用)

```rust
/// Preprocess RGBA frame → f32 NCHW [1, 3, 1280, 1280].
///
/// OmniParser uses simple [0, 1] normalization (no ImageNet mean/std), unlike
/// Florence-2. Bilinear resize, RGB order.
#[cfg(feature = "vision-gpu")]
pub fn preprocess_image(
    buffer: &[u8],
    width: u32,
    height: u32,
    roi: &Rect,
) -> Result<Array4<f32>, VisionBackendError> {
    let expected_len = (width as usize) * (height as usize) * 4;
    if buffer.len() != expected_len {
        return Err(VisionBackendError::Other(format!(
            "frame_buffer length {} != width*height*4 {}",
            buffer.len(), expected_len,
        )));
    }
    if width == 0 || height == 0 {
        return Err(VisionBackendError::Other("dimensions must be non-zero".into()));
    }
    // Reuse florence2-style crop / resize pipeline but with /255 only (no
    // mean/std subtraction). Implementation is independent (different
    // input size + different normalization) — duplication kept minimal.
    let crop = clip_roi_to_dim(roi, width, height)?;
    let crop_rgb = extract_crop_rgb(buffer, width, &crop);
    let resized = resize_bilinear_rgb(&crop_rgb, OMNIPARSER_INPUT_SIDE, OMNIPARSER_INPUT_SIDE)?;
    Ok(normalize_to_unit_range(&resized))
}

/// [0, 1] normalization + HWC→NCHW transpose. (No mean/std subtraction.)
#[cfg(feature = "vision-gpu")]
fn normalize_to_unit_range(src: &Array3<u8>) -> Array4<f32> {
    let (h, w, _) = src.dim();
    let mut out = Array4::<f32>::zeros((1, 3, h, w));
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                out[[0, c, y, x]] = src[[y, x, c]] as f32 / 255.0;
            }
        }
    }
    out
}

// `clip_roi_to_dim` / `extract_crop_rgb` / `resize_bilinear_rgb` の実装は
// florence2.rs の同名関数とほぼ同一のため duplicate (公開しない private fn)。
// 共通化は将来 ADR (vision_backend::image_utils 抽出) で。
```

### 3.3 Single-pass forward + YOLO output decode + NMS

```rust
/// Run OmniParser-v2 icon_detect on one ROI and return UI element candidates.
pub fn omniparser_stage2_recognise(
    req: &RecognizeRequest,
    sess: &VisionSession,
) -> Result<Vec<RawCandidate>, VisionBackendError> {
    if req.frame_buffer.is_empty() {
        return Err(VisionBackendError::Other("frame_buffer is empty".into()));
    }

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

    // Step 2: ort run (single input "images", single output)
    let raw_output = run_icon_detect(sess, pixel_values)?;

    // Step 3: YOLO decode + NMS → RawCandidate[]
    Ok(decode_yolo_output(
        raw_output.view(),
        roi.width.max(0) as u32,
        roi.height.max(0) as u32,
        OMNIPARSER_CONF_THRESHOLD,
        OMNIPARSER_IOU_THRESHOLD,
    ))
}

#[cfg(feature = "vision-gpu")]
fn run_icon_detect(
    sess: &VisionSession,
    pixel_values: Array4<f32>,
) -> Result<Array3<f32>, VisionBackendError> {
    use ort::value::Tensor;
    let input_tensor = Tensor::from_array(pixel_values)
        .map_err(|e| VisionBackendError::Other(format!("input tensor: {e}")))?;
    let mut session = sess.lock();
    // YOLO11 ONNX export uses input name "images".
    let outputs = session
        .run(ort::inputs![ "images" => input_tensor ])
        .map_err(|e| VisionBackendError::Other(format!("icon_detect run: {e}")))?;
    let (_, output_tensor) = outputs
        .iter()
        .next()
        .ok_or_else(|| VisionBackendError::Other("icon_detect returned no outputs".into()))?;
    let view = output_tensor
        .try_extract_array::<f32>()
        .map_err(|e| VisionBackendError::Other(format!("output extract: {e}")))?;
    view.into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| VisionBackendError::Other(format!("output dim: {e}")))
        .map(|a| a.to_owned())
}

/// Decode YOLOv8/v11 output and apply NMS.
///
/// Output shape: `[1, 4 + num_classes, num_anchors]`
///   - First 4 channels: bbox in cxcywh (relative to input 1280×1280)
///   - Remaining channels: per-class confidence (single-class for OmniParser)
///
/// Returns RawCandidates with bbox scaled back to original ROI dimensions.
pub fn decode_yolo_output(
    output: ArrayView3<f32>,
    roi_w: u32,
    roi_h: u32,
    conf_threshold: f32,
    iou_threshold: f32,
) -> Vec<RawCandidate> {
    let shape = output.shape();
    if shape[0] != 1 || shape.len() != 3 {
        return Vec::new();
    }
    let n_features = shape[1]; // 4 + num_classes
    let n_anchors = shape[2];
    if n_features < 5 {
        return Vec::new(); // not a YOLO output
    }
    let n_classes = n_features - 4;

    // Collect detections above threshold.
    let mut dets: Vec<Detection> = Vec::new();
    for a in 0..n_anchors {
        let cx = output[[0, 0, a]];
        let cy = output[[0, 1, a]];
        let w = output[[0, 2, a]];
        let h = output[[0, 3, a]];
        let mut best_class = 0usize;
        let mut best_conf = 0f32;
        for c in 0..n_classes {
            let conf = output[[0, 4 + c, a]];
            if conf > best_conf {
                best_conf = conf;
                best_class = c;
            }
        }
        if best_conf < conf_threshold {
            continue;
        }
        // Convert cxcywh (1280-relative) → xyxy in original ROI pixels.
        let scale_x = roi_w as f32 / OMNIPARSER_INPUT_SIDE as f32;
        let scale_y = roi_h as f32 / OMNIPARSER_INPUT_SIDE as f32;
        let x1 = ((cx - w * 0.5) * scale_x).max(0.0) as i32;
        let y1 = ((cy - h * 0.5) * scale_y).max(0.0) as i32;
        let x2 = ((cx + w * 0.5) * scale_x).min(roi_w as f32) as i32;
        let y2 = ((cy + h * 0.5) * scale_y).min(roi_h as f32) as i32;
        if x2 <= x1 || y2 <= y1 {
            continue;
        }
        dets.push(Detection {
            x1, y1, x2, y2,
            confidence: best_conf,
            class_idx: best_class,
        });
    }

    // NMS per class.
    let kept = non_max_suppression(&dets, iou_threshold);

    kept.into_iter()
        .enumerate()
        .map(|(i, d)| RawCandidate {
            track_id: format!("omniparser-stage2-{i}"),
            rect: Rect {
                x: d.x1, y: d.y1,
                width: d.x2 - d.x1,
                height: d.y2 - d.y1,
            },
            label: String::new(),
            class: OMNIPARSER_CLASS.into(),
            confidence: d.confidence as f64,
            provisional: true,
        })
        .collect()
}

#[derive(Clone)]
struct Detection {
    x1: i32, y1: i32, x2: i32, y2: i32,
    confidence: f32,
    class_idx: usize,
}

/// Non-Maximum Suppression: greedy per-class, IoU > threshold drops the lower-confidence box.
fn non_max_suppression(dets: &[Detection], iou_threshold: f32) -> Vec<Detection> {
    let mut sorted: Vec<Detection> = dets.to_vec();
    sorted.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Detection> = Vec::new();
    for d in sorted {
        let suppressed = kept.iter().any(|k| {
            k.class_idx == d.class_idx && iou(k, &d) > iou_threshold
        });
        if !suppressed {
            kept.push(d);
        }
    }
    kept
}

fn iou(a: &Detection, b: &Detection) -> f32 {
    let inter_x1 = a.x1.max(b.x1);
    let inter_y1 = a.y1.max(b.y1);
    let inter_x2 = a.x2.min(b.x2);
    let inter_y2 = a.y2.min(b.y2);
    if inter_x2 <= inter_x1 || inter_y2 <= inter_y1 {
        return 0.0;
    }
    let inter_area = ((inter_x2 - inter_x1) * (inter_y2 - inter_y1)) as f32;
    let a_area = ((a.x2 - a.x1) * (a.y2 - a.y1)) as f32;
    let b_area = ((b.x2 - b.x1) * (b.y2 - b.y1)) as f32;
    let union = a_area + b_area - inter_area;
    if union <= 0.0 { 0.0 } else { inter_area / union }
}
```

### 3.4 `stub_recognise_with_session` への dispatch 追加

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
            }
        }
    } else if sess.session_key.starts_with("omniparser-v2-icon-detect:") {
        match crate::vision_backend::omniparser::omniparser_stage2_recognise(&req, &sess) {
            Ok(candidates) => return candidates,
            Err(e) => {
                tracing::warn!(target: "omniparser", "stage2 recognise failed: {e}");
            }
        }
    }
    dummy_recognise(req)
}
```

---

## 4. Done criteria

- [ ] cargo check 3 features set 全 exit 0
- [ ] tsc --noEmit exit 0
- [ ] vitest 4 test file regression 0
- [ ] 最終 full suite で regression 0
- [ ] ADR-005 §5 4b-5b `[x]` flip + 「Stage 2 完結」明記
- [ ] 設計書 Status → Implemented (commit hash)
- [ ] Opus self-review BLOCKING 0
- [ ] Rust 6-8 ケース新規 omniparser test を `omniparser.rs::tests` に追加 (preprocess shape / decode_yolo_output / NMS / iou など)

---

## 5. Test cases

### 5.1 Rust unit tests (`omniparser.rs::tests`)

```rust
#[cfg(all(test, feature = "vision-gpu"))]
mod tests {
    use super::*;
    use ndarray::Array3;

    fn synth_rgba(w: u32, h: u32, fill: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) { v.extend_from_slice(&fill); }
        v
    }

    #[test]
    fn preprocess_output_shape_is_1_3_1280_1280() {
        let buf = synth_rgba(100, 100, [128, 128, 128, 255]);
        let full = Rect { x: 0, y: 0, width: 100, height: 100 };
        let out = preprocess_image(&buf, 100, 100, &full).unwrap();
        assert_eq!(out.dim(), (1, 3, 1280, 1280));
    }

    #[test]
    fn preprocess_unit_range_no_mean_std() {
        // 128/255 ≈ 0.502 — no ImageNet shift like Florence-2
        let buf = synth_rgba(10, 10, [128, 128, 128, 255]);
        let full = Rect { x: 0, y: 0, width: 10, height: 10 };
        let out = preprocess_image(&buf, 10, 10, &full).unwrap();
        let center = out[[0, 0, 640, 640]];
        assert!((center - 0.502).abs() < 0.01, "expected ~0.502, got {center}");
    }

    #[test]
    fn decode_yolo_returns_empty_on_wrong_shape() {
        let bad = Array3::<f32>::zeros((2, 5, 100));
        let out = decode_yolo_output(bad.view(), 1000, 1000, 0.25, 0.45);
        assert!(out.is_empty());
    }

    #[test]
    fn decode_yolo_filters_below_confidence() {
        // Single anchor with low confidence (0.1)
        let mut output = Array3::<f32>::zeros((1, 5, 1));
        output[[0, 0, 0]] = 640.0; // cx
        output[[0, 1, 0]] = 640.0; // cy
        output[[0, 2, 0]] = 100.0; // w
        output[[0, 3, 0]] = 100.0; // h
        output[[0, 4, 0]] = 0.1;   // conf below 0.25
        let out = decode_yolo_output(output.view(), 1280, 1280, 0.25, 0.45);
        assert!(out.is_empty());
    }

    #[test]
    fn decode_yolo_emits_candidate_when_above_threshold() {
        let mut output = Array3::<f32>::zeros((1, 5, 1));
        output[[0, 0, 0]] = 640.0;
        output[[0, 1, 0]] = 640.0;
        output[[0, 2, 0]] = 100.0;
        output[[0, 3, 0]] = 100.0;
        output[[0, 4, 0]] = 0.9;
        let out = decode_yolo_output(output.view(), 1280, 1280, 0.25, 0.45);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].class, "ui_element");
        assert!(out[0].provisional);
        assert!((out[0].confidence - 0.9).abs() < 0.01);
    }

    #[test]
    fn decode_yolo_scales_to_roi_dimensions() {
        let mut output = Array3::<f32>::zeros((1, 5, 1));
        output[[0, 0, 0]] = 640.0;
        output[[0, 1, 0]] = 640.0;
        output[[0, 2, 0]] = 1280.0;
        output[[0, 3, 0]] = 1280.0;
        output[[0, 4, 0]] = 0.9;
        // ROI 500x300 → bbox should cover roughly the full ROI
        let out = decode_yolo_output(output.view(), 500, 300, 0.25, 0.45);
        assert_eq!(out.len(), 1);
        assert!(out[0].rect.x <= 1);
        assert!(out[0].rect.y <= 1);
        assert!(out[0].rect.width >= 498);
        assert!(out[0].rect.height >= 298);
    }

    #[test]
    fn iou_full_overlap_is_1() {
        let a = Detection { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.5, class_idx: 0 };
        let b = a.clone();
        assert!((iou(&a, &b) - 1.0).abs() < 0.001);
    }

    #[test]
    fn iou_no_overlap_is_0() {
        let a = Detection { x1: 0, y1: 0, x2: 50, y2: 50, confidence: 0.5, class_idx: 0 };
        let b = Detection { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.5, class_idx: 0 };
        assert_eq!(iou(&a, &b), 0.0);
    }

    #[test]
    fn nms_drops_lower_confidence_overlap() {
        let dets = vec![
            Detection { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.9, class_idx: 0 },
            Detection { x1: 10, y1: 10, x2: 110, y2: 110, confidence: 0.5, class_idx: 0 },
        ];
        let kept = non_max_suppression(&dets, 0.45);
        assert_eq!(kept.len(), 1);
        assert!((kept[0].confidence - 0.9).abs() < 0.001);
    }
}
```

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| OmniParser-v2 ONNX の input name (`images` vs `pixel_values` 等) | HF model card 確認、`images` が YOLO11 ONNX export の標準。runtime error なら fallback list で確認 |
| 出力 shape の transpose (`[1, 4+num_classes, num_anchors]` vs `[1, num_anchors, 4+num_classes]`) | 設計コードは前者前提、ultralytics export の標準。後者の場合は `permuted_axes((0, 2, 1))` で揃える調整が必要 |
| Confidence 値の sigmoid 適用 (`raw vs after sigmoid`) | YOLO11 ONNX export は通常 sigmoid 込み (output = sigmoid(logit))、threshold 0.25 直接比較で OK |
| Single-class detector で n_classes=1 vs multi-class (n_classes=2..) | 設計通り max-conf class 取り。multi-class でも動作 |
| 入力 1280×1280 の resize は ~5MB f32 buffer | preprocess は ~10ms、許容 |
| NMS の per-class 実装で global で merge してしまう | `kept.iter().any(|k| k.class_idx == d.class_idx && ...)` で同一 class 内のみ比較 |
| `omniparser.rs` の preprocess helpers (clip_roi / extract_crop / resize) が florence2.rs と重複 | 本 batch では duplicate 維持 (将来 ADR で `image_utils` 抽出)、§9.1 公開 API 維持優先 |
| ROI が 0×0 で渡される (Stage 1 が空 candidate を返した場合) | `roi.width.max(0) as u32` で 0、scale 計算で /0 しないよう preprocess 段階で Err 返却 (`width == 0` check) |
| Florence-2 `tracing::warn!(target: "florence2", ...)` と integrate | 同パターン `target: "omniparser"` で揃える |

---

## 7. Acceptable Sonnet judgment scope

- ort 2.0.0-rc.12 の正確な input/output name 確認
- preprocess helpers (clip_roi / extract_crop / resize) を florence2.rs と同名で `pub(crate)` 化して共有するか、duplicate するかの判断 (本設計書は duplicate 推奨だが §7 で Sonnet 判断可)
- conf/iou threshold の微調整 (default 0.25/0.45 は OK)
- NMS の per-class vs global の境界
- commit 分割 (推奨 2-3 commit: omniparser.rs / inference dispatch / docs)
- tests +α (§5.1 7 ケース超え可)

---

## 8. Forbidden Sonnet judgments

### 8.1 API surface 変更
- 既存の `VisualBackend` / `ModelRegistry` / `RecognizeRequest` / `VisionSession::create` / `Florence2*` / 公開 API 不変
- `RawCandidate` shape 不変

### 8.2 Scope 変更
- icon_caption (BLIP-based icon describer) 実装禁止
- PaddleOCR-v4 (Stage 3) 実装禁止 (4b-5c)
- Cross-check (multi-engine) 禁止 (4b-6)
- Phase 4a〜4b-5a-5 成果物変更禁止

### 8.3 依存追加禁止
- 新 npm package / 新 Rust crate 禁止
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 8.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)

### 8.5 絶対不変
- catch_unwind barrier 削除禁止
- DESKTOP_TOUCH_ENABLE_ONNX_BACKEND / DISABLE_VISUAL_GPU 維持
- PocVisualBackend / bin/win-ocr.exe 削除禁止
- 4b-5 post-review legacy path / typeof guard (4b-5c まで維持)

### 8.6 ドキュメント更新義務
- ADR-005 §5 4b-5b `[x]` flip + summary、Stage 2 完結明記
- 本設計書 Status → Implemented + commit hash

---

## 9. Future work (4b-5c PaddleOCR-v4)

- Stage 3 OCR で text-class candidates の label を埋める
- text density 別の class-aware dispatcher (ADR D3') は後回し可
- Phase 4b-5 post-review legacy path / typeof guard を 4b-5c 完了時に削除

---

## 10. 実装順序

1. `src/vision_backend/omniparser.rs` 新規作成 (§3.1〜§3.3 全コード)
2. `src/vision_backend/mod.rs` に `pub mod omniparser;` 追加
3. `src/vision_backend/inference.rs::stub_recognise_with_session` に omniparser dispatch 追加 (§3.4)
4. `omniparser.rs::tests` mod に §5.1 7 ケース追加
5. `cargo check --release --features vision-gpu` exit 0
6. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
7. `cargo check --release --no-default-features` exit 0
8. `tsc --noEmit` exit 0
9. vitest 4 test file regression 0
10. `npm run test:capture -- --force` 最終 1 回
11. ADR-005 §5 4b-5b `[x]` flip + Stage 2 完結明記
12. 設計書 Status → Implemented + commit hash
13. commit 分割 (推奨 3): omniparser module / inference dispatch / docs
14. push origin
15. Opus self-review (Opus session 別途)
16. notification + handbook §6.1 報告

END.
