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
use crate::vision_backend::types::{RawCandidate, Rect};

// RecognizeRequest and VisionSession are used only in the vision-gpu path.
#[cfg(feature = "vision-gpu")]
use crate::vision_backend::types::RecognizeRequest;
#[cfg(feature = "vision-gpu")]
use crate::vision_backend::session::VisionSession;

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

// ─────────────────────────────────────────────────────────────────────────────
// Image preprocess helpers (private, duplicate from florence2.rs per §7)
// ─────────────────────────────────────────────────────────────────────────────

/// Internal crop descriptor.
#[cfg(feature = "vision-gpu")]
struct Crop {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// Clip a screen-absolute Rect to the frame bounds. Returns Err if the
/// resulting area is empty. Empty roi (w<=0 || h<=0) yields full frame.
#[cfg(feature = "vision-gpu")]
fn clip_roi_to_dim(roi: &Rect, width: u32, height: u32) -> Result<Crop, VisionBackendError> {
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
fn resize_bilinear_rgb(
    src: &ndarray::Array3<u8>,
    dst_w: u32,
    dst_h: u32,
) -> Result<ndarray::Array3<u8>, VisionBackendError> {
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

/// [0, 1] normalization + HWC→NCHW transpose. (No mean/std subtraction.)
#[cfg(feature = "vision-gpu")]
fn normalize_to_unit_range(src: &ndarray::Array3<u8>) -> Array4<f32> {
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

// ─────────────────────────────────────────────────────────────────────────────
// Public preprocess API
// ─────────────────────────────────────────────────────────────────────────────

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
            buffer.len(),
            expected_len,
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

// ─────────────────────────────────────────────────────────────────────────────
// YOLO output types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Detection {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    confidence: f32,
    class_idx: usize,
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-pass forward + YOLO decode + NMS
// ─────────────────────────────────────────────────────────────────────────────

/// Run OmniParser-v2 icon_detect on one ROI and return UI element candidates.
#[cfg(feature = "vision-gpu")]
pub fn omniparser_stage2_recognise(
    req: &RecognizeRequest,
    sess: &VisionSession,
) -> Result<Vec<RawCandidate>, VisionBackendError> {
    if req.frame_buffer.is_empty() {
        return Err(VisionBackendError::Other("frame_buffer is empty".into()));
    }

    // Step 1: preprocess
    let roi = req.rois.first().map(|r| r.rect.clone()).unwrap_or(Rect {
        x: 0,
        y: 0,
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
        .run(ort::inputs!["images" => input_tensor])
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
            x1,
            y1,
            x2,
            y2,
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
                x: d.x1,
                y: d.y1,
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

/// Non-Maximum Suppression: greedy per-class, IoU > threshold drops the lower-confidence box.
fn non_max_suppression(dets: &[Detection], iou_threshold: f32) -> Vec<Detection> {
    let mut sorted: Vec<Detection> = dets.to_vec();
    sorted.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<Detection> = Vec::new();
    for d in sorted {
        let suppressed = kept
            .iter()
            .any(|k| k.class_idx == d.class_idx && iou(k, &d) > iou_threshold);
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
    if union <= 0.0 {
        0.0
    } else {
        inter_area / union
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(all(test, feature = "vision-gpu"))]
mod tests {
    use super::*;
    use ndarray::Array3;

    fn synth_rgba(w: u32, h: u32, fill: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            v.extend_from_slice(&fill);
        }
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
