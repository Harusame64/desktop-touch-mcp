# Phase 4b-5a-1 設計書 — Florence-2 Stage 1 image preprocess + frame_buffer plumbing

- Status: Implemented (2026-04-25、commits de09bc1〜866e692、post-review addendum 含む)

**Post-review addendum (Opus review 2026-04-25、BLOCKING 0)**:
- §5 Done criteria の `cargo test --release --features vision-gpu florence2` 要件は本プロジェクトの **napi-rs cdylib + `-lnode` link 制約** で実行不可 (inference.rs / session_pool.rs tests も同じ状態)。後続 sub-batch (4b-5a-2/3/4 以降) でも同基準: **cargo check 3 features set exit 0 + `#[cfg(test)]` body 存在 + logic 読解による正確性確認** で代替する。4b-5a-3 以降 encoder 実接続時に integration test 手段を ADR-005 §5 の完了基準側で再設計
- §11 step 16 (`recognizeRoisLegacy` helper 拡張) は誤記: 実装上 `recognizeRois` メソッド内 `else` 枝として存在し、独立 helper ではない。frame_buffer forward は同 method 内で処理済、実装影響なし
- §11 step 17 (`src/engine/poc/poc-visual-backend.ts`) は **不存在パス**。該当 file は project 内に無く、本 batch で touch 不要 (設計書側の defect、実装影響なし)
- Sonnet 追加判断 5 件 (ndarray explicit listing / 手動 Debug impl / cargo test 制約 / feature gate / commit 5 分割) は全て §8 許容範囲内と判定
- RECOMMEND 3 件は 4b-5a-3 以降で対応予定:
  1. `expect()` 4 箇所を `Result` 経路に格上げ (L5 safety margin 向上)
  2. `extract_crop_rgb` を `Array3::from_shape_fn` / unsafe slice copy で ~3-5x 高速化
  3. `eprintln!` を `tracing::warn!` に統一 (既存 code style 確認次第)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D1' (Rust backend) / D5' Stage 1 (Florence-2-base region proposer)
- 対応 ADR-005 §5 batch: 4b-5a (Florence-2 Stage 1 の sub-sub-batch 1/4)
- 前提 commits: `c4a9a7f`〜`ad936f3` (Phase 4a + 4b-1 + 4b-3 + 4b-4 + 4b-5 framework + 4b-5 BLOCKING fix)
- 期待工数: **3-4 日 (Sonnet 実装、Rust 中心 + TS 最小配線)**

---

## 1. Goal

Florence-2 Stage 1 real inference の **前段階**: frame RGBA bytes を受け取り
ImageNet normalize 済の f32 ndarray `[1, 3, 768, 768]` に変換する preprocess pipeline
を Rust 側に実装し、`frame_buffer` を napi 経由で TS から Rust に渡す配線を通す。

単一目標:

> `OnnxBackend.recognizeRois(targetKey, rois, frameWidth, frameHeight, frameBuffer)`
> で受け取った frame bytes が Rust `florence2::preprocess_image(&buffer, w, h, roi)` に
> 到達し、ImageNet normalize + resize 済の f32 ndarray `[1, 3, 768, 768]` を返す。
> 実 Florence-2 session は呼び出さない (encoder + tokenizer は 4b-5a-2/3/4)、
> `stub_recognise_with_session` は preprocess を呼んで形状確認したうえで
> 既存の stub RawCandidates (1 per ROI) を返す。

### 明示的に本 batch の scope 外

- Florence-2 tokenizer (`<REGION_PROPOSAL>` prompt 生成) — **4b-5a-2**
- Florence-2 encoder + decoder autoregressive loop + KV cache 管理 — **4b-5a-3**
- `<loc_X>` token parse → bbox 変換 — **4b-5a-4**
- OmniParser-v2 (Stage 2) / PaddleOCR-v4 (Stage 3) — **4b-5b / 4b-5c**
- zero-copy DXGI GPU buffer 接続 (現状は napi Buffer 経由の heap copy、将来 Phase 4c で optimize) — scope 外
- Real Florence-2 ONNX artifact のダウンロード実装 — scope 外 (4b-5a-3 で session init 確認時に user 手動 download or 同梱 batch 別途)

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `src/vision_backend/florence2.rs` | Florence-2 Stage 1 preprocess + 将来の encoder dispatch skeleton | ~220 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `Cargo.toml [dependencies]` | `image = { version = "0.25", default-features = false, features = ["png"] }` 追加 (resize 用、PNG feature は test fixture デコード用最小限) |
| `src/vision_backend/mod.rs` | `pub mod florence2;` 追加 |
| `src/vision_backend/types.rs::RecognizeRequest` | `frame_buffer: Buffer` field 追加 (napi `Buffer` 型、空バッファは legacy dummy path) |
| `src/lib.rs::VisionRecognizeTask::compute` (L515-527) | placeholder `RecognizeRequest` literal に `frame_buffer: Buffer::from(vec![])` 追加 (コンパイル維持) |
| `src/vision_backend/inference.rs::stub_recognise_with_session` | session_key が `"florence-2-base:..."` で frame_buffer が非空の時、`florence2::preprocess_image` を呼んで shape 検証 + 既存 stub candidates を返す |
| `src/engine/native-types.ts::NativeRecognizeRequest` | `frameBuffer: Buffer` field 追加 (camelCase、Node.js Buffer) |
| `src/engine/vision-gpu/backend.ts::VisualBackend` | `recognizeRois` の optional 5th parameter として `frameBuffer?: Buffer` 追加。既存 backend (PocVisualBackend) は引数無視する形で OK |
| `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` | `frameBuffer?: Buffer` 引数追加、stage pipeline に forward |
| `src/engine/vision-gpu/stage-pipeline.ts::StagePipelineInput` | `frameBuffer: Buffer` field 追加 (必須、empty Buffer でも OK) |
| `src/engine/vision-gpu/stage-pipeline.ts::runStagePipeline` | 各 stage の `NativeRecognizeRequest` に `frameBuffer` を添える |
| `src/engine/poc/poc-visual-backend.ts::recognizeRois` | 引数変更対応のため signature に `_frameBuffer?: Buffer` 追加 (無視) |
| `src/engine/vision-gpu/onnx-backend.ts::recognizeRoisLegacy` (4b-5 post-review fix で追加された helper) | 同 signature 拡張 |
| `tests/unit/visual-gpu-onnx-backend.test.ts` (追記、既存書換禁止) | `frameBuffer` を mock request に追加した新規 test case 1-2 件 |
| `tests/unit/stage-pipeline.test.ts` (追記) | `frameBuffer` を `StagePipelineInput` に含めた更新。既存テストは新 field 追加に伴う **build fix 1 行追加 (空 Buffer)** のみ許容 (handbook §4.1: API 変更に伴う accuracy 追従、logic 変更なし) |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5a checklist` | **新規 sub-batch checklist 追加** ([ ] 4b-5a-1 〜 [ ] 4b-5a-4)、今回の batch は `[x]` flip |

### 削除禁止

- Phase 4a/4b-1/4b-3/4b-4/4b-5 skeleton 全て (handbook §4.3)
- Phase 4b-5 の `VisionSessionPool` / `stage-pipeline.ts` 基本構造 / `isCpuOnlyVariant` / `EpName` "WebGPU"
- `catch_unwind` barrier (inference.rs / session.rs) (L5)
- Phase 4b-5 post-review で追加した `recognizeRoisLegacy` fall-through (4b-5c 完了時点で削除対象、本 batch では維持)
- `ensureWarm` の `typeof visionInitSession !== "function"` guard (同上、本 batch では維持)

### Forbidden な依存追加

- 新 npm package 禁止
- `image` crate 以外の Rust crate 追加禁止 (tokenizers / candle / fast_image_resize 等は後続 batch)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

**注**: `image` crate の追加は本設計書で明示許可 (scope 上必要、§9.3 の一般禁止 rule の例外)。

---

## 3. API design

### 3.1 Rust: `florence2.rs` 新規 module

```rust
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
//! Phase 4b-5a-2 scope (future):
//!   - `tokenize_prompt`: `<REGION_PROPOSAL>` task token → input_ids + attention_mask
//!
//! Phase 4b-5a-3 scope (future):
//!   - Encoder + decoder ort::Session::run with KV-cache autoregressive loop
//!
//! Phase 4b-5a-4 scope (future):
//!   - `<loc_X>` token sequence → bbox RawCandidate[] parser

use ndarray::{Array4, ArrayView4};

use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::types::Rect;

/// Florence-2-base expects 768x768 RGB images (per Microsoft's HF model card).
pub const FLORENCE2_INPUT_SIDE: u32 = 768;

/// ImageNet mean (RGB order, per-channel), applied after /255 normalization.
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet std (RGB order, per-channel).
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

struct Crop { x: u32, y: u32, w: u32, h: u32 }

/// Copy the crop region from an RGBA buffer into a packed RGB Array3 (H, W, 3).
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
pub fn expected_shape() -> (usize, usize, usize, usize) {
    (1, 3, FLORENCE2_INPUT_SIDE as usize, FLORENCE2_INPUT_SIDE as usize)
}
```

### 3.2 Rust: `RecognizeRequest::frame_buffer` 追加

```rust
// Before (types.rs)
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RecognizeRequest {
    pub target_key: String,
    pub session_key: String,
    pub rois: Vec<RoiInput>,
    pub frame_width: u32,
    pub frame_height: u32,
    pub now_ms: f64,
}

// After (Phase 4b-5a-1)
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RecognizeRequest {
    pub target_key: String,
    pub session_key: String,
    pub rois: Vec<RoiInput>,
    pub frame_width: u32,
    pub frame_height: u32,
    /// Captured frame RGBA bytes, length = frame_width * frame_height * 4.
    /// Empty buffer → legacy dummy path (no preprocess, stub candidates).
    pub frame_buffer: napi::bindgen_prelude::Buffer,
    pub now_ms: f64,
}
```

**Backward-compat note**: Adding a field to a `#[napi(object)]` struct is
non-breaking for TS callers that supply the field; existing mocks without
`frameBuffer` will fail TS compile. Handle by updating mock helpers in
tests (field addition only, no logic change — handbook §4.1 accuracy 追従).

### 3.3 Rust: `stub_recognise_with_session` の dispatch

```rust
// inference.rs
fn stub_recognise_with_session(
    req: RecognizeRequest,
    sess: std::sync::Arc<crate::vision_backend::session::VisionSession>,
) -> Vec<RawCandidate> {
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
```

### 3.4 TS: `VisualBackend.recognizeRois` signature 拡張

```typescript
// src/engine/vision-gpu/backend.ts
export interface VisualBackend {
  // ... existing members ...
  recognizeRois?(
    targetKey: string,
    rois: RoiInput[],
    frameWidth?: number,
    frameHeight?: number,
    frameBuffer?: Buffer,  // ← Phase 4b-5a-1 addition (optional, backward-compat)
  ): Promise<UiEntityCandidate[]>;
}
```

**Backward-compat**: optional parameter なので既存 consumer (test mocks、
PocVisualBackend) は変更不要。`PocVisualBackend.recognizeRois` / `OnnxBackend.recognizeRois` /
`recognizeRoisLegacy` / `runStagePipeline` caller は `_frameBuffer` を受け取り forward
するだけ (実処理は florence2 session_key 分岐のみ)。

### 3.5 TS: `stage-pipeline.ts::StagePipelineInput` に `frameBuffer` 追加

```typescript
export interface StagePipelineInput {
  targetKey: string;
  rois: NativeRecognizeRequest["rois"];
  frameWidth: number;
  frameHeight: number;
  frameBuffer: Buffer;  // ← 追加 (empty Buffer も可)
  nowMs: number;
}

// runStagePipeline の各 stage call に frameBuffer を添える
const stage1 = await visionRecognize({
  targetKey: input.targetKey,
  sessionKey: keys.stage1,
  rois: input.rois,
  frameWidth: input.frameWidth,
  frameHeight: input.frameHeight,
  frameBuffer: input.frameBuffer,  // ← 追加
  nowMs: input.nowMs,
});
// stage2, stage3 も同様に frameBuffer を forward
```

### 3.6 TS: `OnnxBackend.recognizeRois` の frameBuffer 対応

```typescript
async recognizeRois(
  targetKey: string,
  rois: RoiInput[],
  frameWidth?: number,
  frameHeight?: number,
  frameBuffer?: Buffer,  // ← 追加
): Promise<UiEntityCandidate[]> {
  if (!OnnxBackend.isAvailable() || !nativeVision?.visionRecognizeRois) return [];
  if (rois.length === 0) return [];

  const effectiveBuffer = frameBuffer ?? Buffer.alloc(0);
  // Backward-compat: empty Buffer triggers legacy dummy path in Rust
  // (frame_buffer.is_empty()), keeping 4a/4b-1 test assertions stable.

  if (this.state !== "warm" || this.stageKeys === null) {
    return this.recognizeRoisLegacy(targetKey, rois, frameWidth, frameHeight, effectiveBuffer);
  }

  const nativeRois = rois.map((r) => ({
    trackId: r.trackId,
    rect: { ...r.rect },
    classHint: r.classHint ?? null,
  }));
  const input: StagePipelineInput = {
    targetKey,
    rois: nativeRois,
    frameWidth: frameWidth ?? this.opts.defaultFrameWidth ?? 0,
    frameHeight: frameHeight ?? this.opts.defaultFrameHeight ?? 0,
    frameBuffer: effectiveBuffer,
    nowMs: Date.now(),
  };
  // ... (rest unchanged)
}
```

### 3.7 Cargo.toml 変更

```toml
[dependencies]
# 既存 ...
# Phase 4b-5a-1: image preprocessing (bilinear resize for Florence-2 input)
image = { version = "0.25", default-features = false, features = ["png"] }
```

**選定根拠**:
- `default-features = false` + 最小 feature `"png"` (test fixture 用、実行時は不要)
- resize アルゴリズム (`FilterType::Triangle` = bilinear) が SIMD 無しでも 768x768 で ~1ms 以下
- 実績ある crate (40M+ DL/mo、well-maintained)
- 代替 `fast_image_resize` は SIMD 特化だが依存が重く、本 batch の scope に過剰

---

## 4. Frame buffer 流れの図

```text
[DXGI Capture (既存 src/duplication/)]
    │
    ▼ raw RGBA bytes (Buffer)
[TS caller (visual-provider / OnnxBackend 呼び出し元)]
    │
    ▼ OnnxBackend.recognizeRois(targetKey, rois, w, h, frameBuffer)
[OnnxBackend]
    │
    ▼ StagePipelineInput { ..., frameBuffer }
[runStagePipeline]
    │
    ▼ NativeRecognizeRequest { ..., frameBuffer }  (各 stage × 3 回)
[nativeVision.visionRecognizeRois (napi)]
    │
    ▼ RecognizeRequest { ..., frame_buffer: Buffer }
[recognize_rois_blocking → stub_recognise_with_session]
    │
    ▼ florence-2-base:* session_key なら
[florence2::preprocess_image(&buffer, w, h, roi)]
    │
    ▼ Array4<f32> [1, 3, 768, 768]  (4b-5a-1 はここまで、debug_assert で shape 確認)
[将来 4b-5a-3: encoder + decoder → RawCandidate[]]
```

**zero-copy 考慮**: 現状 napi `Buffer` は JS heap → Rust slice で shallow reference
(deref &[u8])、copy は発生しない。Rust → ndarray 変換時に 1 回 copy (O(w*h*3))、
これは画像内容変換のため不可避。将来 Phase 4c の DXGI zero-copy 化で
"Rust が DXGI texture から直接読み出す" 形に移行。

---

## 5. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0
- [ ] `cargo test --release --features vision-gpu florence2` で preprocess テスト全パス
- [ ] `tsc --noEmit` exit 0
- [ ] `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 既存全パス (引数追加に伴う更新のみ、logic 変更なし)
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 既存全パス + frameBuffer 関連追記 1-2 件
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` regression 0
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` regression 0
- [ ] 最終 `npm run test:capture -- --force` **1 回のみ**: regression 0 (pre-existing e2e 2 件を超えないこと)
- [ ] ADR-005 §5 4b-5a-1 checklist `[x]` flip + 新規 4b-5a-1〜4b-5a-4 sub-batch entries の追加
- [ ] 本設計書 Status を `Implemented (2026-04-??、commit hash)` に更新
- [ ] Opus self-review BLOCKING 0

---

## 6. Test cases

### 6.1 Rust unit tests (`florence2.rs` 内 `#[cfg(test)]`)

最低 6 ケース:

```rust
#[cfg(test)]
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
```

### 6.2 TS tests

既存 `stage-pipeline.test.ts` の 6 ケースは `StagePipelineInput` に
`frameBuffer: Buffer.alloc(0)` を追加するだけ (logic 変更なし、build fix)。

`visual-gpu-onnx-backend.test.ts` に 1-2 ケース追記:

```typescript
it("recognizeRois forwards frameBuffer to native request when provided", async () => {
  const recorded: any[] = [];
  vi.doMock("../../src/engine/native-engine.js", () => ({
    nativeVision: {
      visionInitSession: vi.fn().mockResolvedValue({ ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: "k" }),
      visionRecognizeRois: vi.fn().mockImplementation(async (req) => {
        recorded.push({ sessionKey: req.sessionKey, bufferLen: req.frameBuffer?.length ?? 0 });
        return req.rois.map((r: any) => ({ trackId: r.trackId, rect: r.rect, label: "", class: "other", confidence: 0.5, provisional: true }));
      }),
      detectCapability: vi.fn().mockReturnValue(/* AMD profile */),
    },
    nativeEngine: null, nativeUia: null,
  }));
  const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
  const b = new OnnxBackend();
  await b.ensureWarm({ kind: "game", id: "g1" });
  const frameBuf = Buffer.alloc(100 * 100 * 4, 128);
  await b.recognizeRois("window:1", [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 100 } }], 100, 100, frameBuf);
  expect(recorded.length).toBeGreaterThanOrEqual(1);
  expect(recorded[0].bufferLen).toBe(100 * 100 * 4);
});

it("recognizeRois without frameBuffer uses empty Buffer (legacy-safe)", async () => {
  // same as above, without passing frameBuffer — bufferLen should be 0
});
```

### 6.3 Backward-compat 既存テストの生存

- Phase 4a / 4b-1 の既存 test (block A/B/C 含む) が `frameBuffer` なしで通り続けること。
  OnnxBackend.recognizeRois の 5 番目引数は optional、`NativeRecognizeRequest.frameBuffer`
  は **必須 field** なので、mock helper が引数無しで request を作っている箇所は
  `frameBuffer: Buffer.alloc(0)` で補う (handbook §4.1: API 変更に伴う accuracy 追従、
  logic 変更なし)。

---

## 7. Known traps

### 新規予想される罠

| 罠 | 対策 |
|---|---|
| `image` crate の feature flag が足りず link 失敗 | `features = ["png"]` で最小開始、足りなければ `"jpeg", "webp"` を足す。default-features=false は必須 (pulling BMP etc. pulls extra weight) |
| `napi::bindgen_prelude::Buffer` のライフタイム扱い | Buffer は Clone + Deref<Target=[u8]>、`&req.frame_buffer` が &[u8] 相当で OK。to_vec() は不要 |
| ImageNet normalize 定数の channel order (RGB vs BGR) | Florence-2 HF model card が RGB order を記載。RGBA → RGB 抽出時に alpha を drop (順序は R,G,B,A で変わらず R,G,B 先頭 3 channel) |
| Bilinear resize の精度差 (Triangle vs Lanczos) | Florence-2 公式は bilinear (Python Transformers pipeline)、`FilterType::Triangle` = bilinear で一致 |
| `Buffer::from(vec![])` の cost | empty Buffer 生成は 0 byte allocation、cost 無視できる |
| test mock helper 修正箇所の多さ | 既存 `NativeRecognizeRequest` を作る場所を grep で全部拾い、空 Buffer 補填。これは logic 変更ではない |
| 768x768 resize の test 実行時間 | uniform grey 画像で ~5ms、test 全体で <1s の増加。許容 |
| napi Buffer のゼロコピー保証 | napi-rs は JS Buffer の backing store を Rust slice として expose、heap copy は発生しない (現 flow では buffer 自体の生成で JS 側 1 回 copy は発生、これは前提) |
| `RecognizeRequest` の `Buffer` field で `Clone` 不可 | napi Buffer は `Clone` 実装済 (Arc<Vec<u8>> 相当)、既存 `#[derive(Clone, Debug)]` で問題なし。ただし Debug 出力は非推奨 (大きいので eprintln! に使わない) |
| stage 3 recognize 時に同じ Buffer を 3 stage で共有 → race? | napi Buffer は immutable、read-only 共有 OK |

### Phase 4a/4b で観測済の罠 (本 batch で再発させない)

- windows crate API mismatch (本 batch は windows 操作なし、影響なし)
- ort prebuilt 不在 (load-dynamic 維持、影響なし)
- bench_ms 空時 tier ソート (4b-4 で解決済)
- empty session_key insert (4b-5 post-review で guard 追加済)

---

## 8. Acceptable Sonnet judgment scope

Sonnet が設計書内で独自判断して良い範囲:

- `image` crate のバージョン微調整 (`0.25.x` → `0.26.x` が既に安定版ならそちら)
- `FilterType::Triangle` vs `FilterType::Lanczos3` の選択 (bilinear 相当なら Triangle 推奨だが Lanczos3 でも可)
- test helper 関数名 / 英語 wording
- `stub_recognise_with_session` 内の eprintln! を `tracing::warn!` に置換するかどうか (既存コードスタイル準拠)
- `Buffer::alloc(0)` vs `Buffer::from(vec![])` の empty buffer 生成手段
- `NativeRecognizeRequest` / `StagePipelineInput` の mock helper 内での空 buffer 補填の実装 (どの helper 関数に入れるか)
- commit 分割判断 (3-4 commit に分割推奨、設計書 §11 参照)
- preprocess test の境界条件追加 (黒画像、白画像、非対称 ROI 等) — 設計書 §6 の 7 ケースを超える追加は OK
- `clip_roi` の負数座標処理の境界値挙動 (Rect の x, y は i32 なので負数が入り得る。設計コードは `roi.x.max(0)` で保守的に処理)

---

## 9. Forbidden Sonnet judgments

### 9.1 API surface 変更
- `VisualBackend` interface の既存 method (ensureWarm / recognizeRois / getStableCandidates / onDirty / dispose / getWarmState / updateSnapshot) の戻り値型 / 既存引数型 変更禁止。`recognizeRois` への optional `frameBuffer` **追加** のみ許可
- `ModelRegistry` method 不変 (4b-4 成果物)
- `NativeSessionInit` / `NativeSessionResult` / `RawCandidate` / `UiEntityCandidate` 不変
- `SelectedEp` / `EpName` 不変
- `ort::Session` lifecycle semantics 不変
- `VisionSession::create` signature 不変

### 9.2 Scope 変更
- Florence-2 tokenizer 実装禁止 (4b-5a-2)
- Florence-2 encoder / decoder session.run 実装禁止 (4b-5a-3)
  - ただし `stub_recognise_with_session` 内で preprocess を **呼ぶ** ことは許可 (§3.3 通り)、preprocess 結果を使って session.run する実装は禁止
- `<loc_X>` token parse 禁止 (4b-5a-4)
- OmniParser-v2 / PaddleOCR-v4 実装禁止 (4b-5b/c)
- DXGI zero-copy 統合禁止 (Phase 4c)
- `vision_retire_session` napi 追加禁止 (4b-5c 以降)
- Rust 内 threading / rayon 並列化禁止 (preprocess は single-thread で十分、SIMD 化も scope 外)
- Phase 4a/4b-1/4b-3/4b-4/4b-5 成果物変更禁止

### 9.3 依存追加禁止
- 新 npm package 禁止
- `image` crate 以外の Rust crate 追加禁止 (tokenizers / candle / fast_image_resize / anyhow / thiserror etc.)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 9.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)
- 既存 `StagePipelineInput` を使う test の **field 追加 1 行** (`frameBuffer: Buffer.alloc(0)`) は
  「API 変更に伴う accuracy 追従」、logic 変更ではない (Phase 4b-4 の Vulkan→WebGPU rename と同じ位置づけ)
- 新規 test file 作成禁止 (追記のみ、florence2 preprocess は Rust `#[cfg(test)]` 内で)

### 9.5 絶対不変
- `catch_unwind` barrier (inference.rs / session.rs) 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` opt-in flag 維持
- `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` kill-switch 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止
- Phase 4b-5 post-review で追加した legacy path / typeof guard (4b-5c 完了時まで維持、本 batch で削除しない)
- `WarmState` 型 (4b-5 で "evicted" 再利用決定、新 variant 追加禁止)

### 9.6 ドキュメント更新義務
- ADR-005 §5 に **4b-5a-1 から 4b-5a-4 の 4 sub-sub-batch checklist を新規追加** (本 batch 設計書で決定した分割計画)、4b-5a-1 のみ `[x]` flip
- 本設計書 Status を `Implemented (2026-04-??、commit hash)` に

---

## 10. Future work / 次 batch への hand-off

### 10.1 Phase 4b-5a-2 (次の着手)

- `tokenizers` crate (HuggingFace 公式、pure Rust) 追加
- Florence-2 の BART tokenizer config をロード (HF hub から `tokenizer.json`)
- `<REGION_PROPOSAL>` prompt → `input_ids: [i64]` + `attention_mask: [i64]`
- special token id (`<loc_X>` X=0..999) の parse 用 mapping 準備 (4b-5a-4 で使用)

### 10.2 Phase 4b-5a-3

- `stub_recognise_with_session` から本実装 `florence2_stage1_recognise` に分離
- ort::Session::run with pixel_values + input_ids + attention_mask
- encoder_hidden_states 取得、decoder autoregressive loop
- KV cache 管理 (past_key_values 30+ tensors)
- greedy decode で token 列を得る

### 10.3 Phase 4b-5a-4

- token 列を decode → text (e.g., `"panel<loc_10><loc_20><loc_100><loc_200>"`)
- `<loc_X>` parse → Rect (ピクセル座標に戻す)
- RawCandidate 作成 (class = "region" / "form" / "panel" 等、label = "")

### 10.4 Phase 4b-5b (OmniParser-v2) / 4b-5c (PaddleOCR-v4)

- Stage 2/3 の実 inference。Florence-2 より単純な single-pass detection 系モデル、
  本 batch で確立した preprocess pattern を再利用

---

## 11. 実装順序 (Sonnet 手順)

### Rust 側

1. `Cargo.toml` に `image = { version = "0.25", default-features = false, features = ["png"] }` 追加
2. `src/vision_backend/florence2.rs` 新規作成 (§3.1 全体)
3. `src/vision_backend/mod.rs` に `pub mod florence2;` 追加
4. `src/vision_backend/types.rs::RecognizeRequest` に `frame_buffer: Buffer` field 追加 (§3.2)
5. `src/lib.rs::VisionRecognizeTask::compute` の placeholder literal に `frame_buffer: Buffer::from(vec![])` 追加
6. `src/vision_backend/inference.rs::stub_recognise_with_session` を §3.3 通り改修
7. Rust unit tests (§6.1) 7 ケース追加
8. `cargo check --release --features vision-gpu` exit 0
9. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
10. `cargo check --release --no-default-features` exit 0
11. `cargo test --release --features vision-gpu florence2` 全緑

### TS 側

12. `src/engine/native-types.ts::NativeRecognizeRequest` に `frameBuffer: Buffer` 追加
13. `src/engine/vision-gpu/backend.ts::VisualBackend.recognizeRois` に optional `frameBuffer?: Buffer` 追加 (§3.4)
14. `src/engine/vision-gpu/stage-pipeline.ts::StagePipelineInput` に `frameBuffer: Buffer` 追加 + `runStagePipeline` で各 stage に forward (§3.5)
15. `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` に `frameBuffer?: Buffer` 引数追加、stage pipeline に forward (§3.6)
16. `src/engine/vision-gpu/onnx-backend.ts::recognizeRoisLegacy` helper も同 signature 拡張
17. `src/engine/poc/poc-visual-backend.ts::recognizeRois` の signature 拡張 (引数追加、body 未使用)
18. `tsc --noEmit` exit 0
19. 既存 test で `NativeRecognizeRequest` / `StagePipelineInput` を作る箇所に `frameBuffer: Buffer.alloc(0)` を補填 (handbook §4.1 accuracy 追従)
20. `visual-gpu-onnx-backend.test.ts` に §6.2 追記 1-2 ケース
21. `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 全緑 (引数追加のみ、logic 不変)
22. `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 全緑 (既存 + 新規)

### 最終確認

23. `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` regression 0
24. `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` regression 0
25. `npm run test:capture -- --force` で full suite 最終 1 回 (regression 0)
26. `docs/visual-gpu-backend-adr-v2.md §5` に **4b-5a-1〜4b-5a-4 の新規 sub-sub-batch checklist を追加**、4b-5a-1 `[x]` flip + summary
27. 本設計書 Status を `Implemented (2026-04-??、commit hash)` に
28. commit 分割 (推奨 3-4 commit):
    - commit A: `feat(vision-gpu): Phase 4b-5a-1 — Florence-2 preprocess module (Rust)`
    - commit B: `feat(vision-gpu): Phase 4b-5a-1 — frame_buffer plumbing (napi + TS)`
    - commit C: `test(vision-gpu): Phase 4b-5a-1 — preprocess unit tests + frameBuffer mock updates`
    - commit D: `docs(vision-gpu): Phase 4b-5a-1 — ADR §5 sub-batch checklist + design Status`
29. push origin desktop-touch-mcp-fukuwaraiv2
30. Opus self-review は本人 (Opus session) が別 session で実施、Sonnet は要請のみ
31. `mcp__desktop-touch__notification_show` で Windows 通知

---

END OF DESIGN DOC.
