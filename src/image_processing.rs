//! Image pre-processing for the Hybrid Non-CDP pipeline (Step 2).
//!
//! Provides `preprocess_image`: a single napi-exported function that accepts
//! a raw RGB/RGBA screenshot buffer and returns a **grayscale, upscaled,
//! contrast-enhanced** buffer suitable for Windows.Media.Ocr.
//!
//! Processing chain (pure u8 integer arithmetic — no f32 intermediate buffers):
//!   1. Grayscale conversion  — BT.601 integer approximation (R×77+G×150+B×29)>>8
//!   2. Bilinear upscale      — Q16 fixed-point, u64 intermediates, no overflow
//!   3. Contrast enhancement  — min-max histogram stretch [min,max]→[0,255]
//!
//! Memory vs. previous f32 implementation:
//!   4K scale=2: ~200 MB f32 peak → ~50 MB u8 (75% reduction)

use napi::bindgen_prelude::*;
use napi_derive::napi;

// ─── Public options / result types (napi objects) ───────────────────────────

/// Input options for `preprocess_image`.
#[napi(object)]
pub struct PreprocessOptions {
    /// Raw pixel buffer (RGB or RGBA layout, row-major).
    pub data: Buffer,
    /// Image width in pixels.
    pub width: u32,
    /// Image height in pixels.
    pub height: u32,
    /// Number of channels per pixel: 3 (RGB) or 4 (RGBA).
    pub channels: u32,
    /// Upscale factor: 1, 2, 3, or 4.
    pub scale: u32,
    /// When true, apply Sauvola adaptive binarization after contrast stretch.
    /// Output pixels become 0 (dark/text) or 255 (light/background) only.
    /// Omit or set false for normal grayscale output.
    pub adaptive: Option<bool>,
}

/// Output of `preprocess_image`.
#[napi(object)]
pub struct ImageProcessingResult {
    /// Processed pixel buffer — 1-channel (grayscale), 8 bpp, row-major.
    pub data: Buffer,
    /// Output image width in pixels (`input.width * scale`).
    pub width: u32,
    /// Output image height in pixels (`input.height * scale`).
    pub height: u32,
    /// Always 1 (single channel grayscale).
    pub channels: u32,
}

// ─── Core implementation ────────────────────────────────────────────────────

/// Upscale + grayscale + contrast-enhance a raw pixel buffer.
///
/// # Errors
/// Returns an error when:
/// - `channels` is not 3 or 4
/// - `scale` is not 2 or 3
/// - `data` length does not match `width × height × channels`
pub fn upscale_grayscale_contrast(opts: PreprocessOptions) -> Result<ImageProcessingResult> {
    // ── Validate inputs ──────────────────────────────────────────────────
    if opts.channels != 3 && opts.channels != 4 {
        return Err(napi::Error::from_reason(format!(
            "preprocess_image: channels must be 3 or 4, got {}",
            opts.channels
        )));
    }
    if opts.scale == 0 || opts.scale > 4 {
        return Err(napi::Error::from_reason(format!(
            "preprocess_image: scale must be 1, 2, 3, or 4, got {}",
            opts.scale
        )));
    }
    let expected_len = (opts.width as usize) * (opts.height as usize) * (opts.channels as usize);
    if opts.data.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "preprocess_image: data length mismatch: expected {expected_len}, got {}",
            opts.data.len()
        )));
    }
    if opts.width == 0 || opts.height == 0 {
        // Return an empty result rather than panicking.
        return Ok(ImageProcessingResult {
            data: Buffer::from(vec![0u8; 0]),
            width: 0,
            height: 0,
            channels: 1,
        });
    }

    // ── Step 1: Grayscale conversion — BT.601 integer approximation ──────
    // Coefficients: R×77 + G×150 + B×29, sum=256 → >>8.
    // Max intermediate: 255×256 = 65280 < u32::MAX — no overflow.
    let gray_u8 = to_grayscale_u8(&opts.data, opts.channels);

    // ── Step 2: Bilinear upscale (Q16 fixed-point) ───────────────────────
    // Memory: u8 uses 1 byte/pixel vs f32's 4 bytes/pixel → 75% reduction.
    let out_w = opts.width.checked_mul(opts.scale).ok_or_else(|| {
        napi::Error::from_reason(format!(
            "preprocess_image: output width overflow ({}×{})",
            opts.width, opts.scale
        ))
    })?;
    let out_h = opts.height.checked_mul(opts.scale).ok_or_else(|| {
        napi::Error::from_reason(format!(
            "preprocess_image: output height overflow ({}×{})",
            opts.height, opts.scale
        ))
    })?;
    let scaled_u8 = bilinear_resize_u8(&gray_u8, opts.width, opts.height, out_w, out_h);

    // ── Step 3: Min-max contrast stretch (u8 → u8) ───────────────────────
    let stretched_u8 = minmax_stretch_u8(&scaled_u8);

    // ── Step 4 (optional): Sauvola adaptive binarization ─────────────────
    // When adaptive=true, output becomes strictly 0/255 (text/background).
    // Improves recognition of thin text on low-contrast or uneven backgrounds.
    let output_u8 = if opts.adaptive == Some(true) {
        sauvola_binarize_u8(&stretched_u8, out_w, out_h, 15, 0.2)
    } else {
        stretched_u8
    };

    Ok(ImageProcessingResult {
        data: Buffer::from(output_u8),
        width: out_w,
        height: out_h,
        channels: 1,
    })
}

// ─── u8 integer processing helpers ──────────────────────────────────────────

/// Convert raw RGB/RGBA to grayscale using BT.601 integer approximation.
///
/// Coefficients: R×77 + G×150 + B×29, normalised by >>8 (sum = 256).
/// Maximum intermediate value: 255 × 256 = 65,280 — fits comfortably in u32.
/// Maximum error vs. f32 floating-point: ±1 LSB (< 0.4%) — sufficient for OCR.
fn to_grayscale_u8(raw: &[u8], channels: u32) -> Vec<u8> {
    let ch = channels as usize;
    raw.chunks_exact(ch)
        .map(|px| {
            let r = px[0] as u32;
            let g = px[1] as u32;
            let b = px[2] as u32;
            ((r * 77 + g * 150 + b * 29) >> 8) as u8
        })
        .collect()
}

/// Bilinear resize of a 1-channel u8 image using Q16 fixed-point arithmetic.
///
/// Ratios are stored as Q16 (×65536). Bilinear weights are products of two Q16
/// factors → Q32, so intermediates use u64. The maximum accumulated value per
/// pixel is 255 × 65536² ≈ 1.1 × 10¹² — well within u64::MAX (≈ 1.8 × 10¹⁹).
///
/// Ratio overflow safety:
///   x_ratio = (src_w-1)×65536 / (dst_w-1).  Worst case src_w=65536:
///   (65535 × 65536) = 4,294,836,225 < u64::MAX ✓
///   x_ratio × dx_max ≤ 65536 × 65535 = 4,294,836,225 < u64::MAX ✓
fn bilinear_resize_u8(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    let mut dst = vec![0u8; (dst_w as usize).saturating_mul(dst_h as usize)];

    // Q16 step sizes (how far to advance in src per 1 dst pixel).
    let x_ratio: u64 = if dst_w > 1 {
        ((src_w as u64 - 1) << 16) / (dst_w as u64 - 1)
    } else {
        0
    };
    let y_ratio: u64 = if dst_h > 1 {
        ((src_h as u64 - 1) << 16) / (dst_h as u64 - 1)
    } else {
        0
    };

    for dy in 0..dst_h as u64 {
        let sy = y_ratio * dy;
        let y0 = (sy >> 16) as u32;
        let y1 = (y0 + 1).min(src_h - 1);
        let fy = sy & 0xFFFF; // fractional part [0, 65535]

        for dx in 0..dst_w as u64 {
            let sx = x_ratio * dx;
            let x0 = (sx >> 16) as u32;
            let x1 = (x0 + 1).min(src_w - 1);
            let fx = sx & 0xFFFF; // fractional part [0, 65535]

            let p00 = src[(y0 * src_w + x0) as usize] as u64;
            let p10 = src[(y0 * src_w + x1) as usize] as u64;
            let p01 = src[(y1 * src_w + x0) as usize] as u64;
            let p11 = src[(y1 * src_w + x1) as usize] as u64;

            // Q32 bilinear weights (products of two Q16 fractions).
            // Sum of weights is always 65536² = 2³².
            let w00 = (65536 - fx) * (65536 - fy);
            let w10 = fx           * (65536 - fy);
            let w01 = (65536 - fx) * fy;
            let w11 = fx           * fy;

            // Round-to-nearest: add 2^31 before >> 32 (±1 LSB max error).
            let val = (p00 * w00 + p10 * w10 + p01 * w01 + p11 * w11 + (1u64 << 31)) >> 32;
            dst[(dy as usize) * (dst_w as usize) + (dx as usize)] = val as u8;
        }
    }

    dst
}

/// Apply min-max histogram stretch to a u8 image: maps [min, max] → [0, 255].
///
/// When all pixels share the same value (flat image), returns mid-grey (128)
/// to avoid division by zero — consistent with the f32 implementation.
fn minmax_stretch_u8(src: &[u8]) -> Vec<u8> {
    if src.is_empty() {
        return Vec::new();
    }

    let min_val = *src.iter().min().unwrap() as u32;
    let max_val = *src.iter().max().unwrap() as u32;
    let range = max_val - min_val;

    if range == 0 {
        return vec![128u8; src.len()];
    }

    // Round-to-nearest: add range/2 before integer division.
    // Max intermediate: (255 × 255 + 127) = 65,152 < u32::MAX — no overflow.
    src.iter()
        .map(|&v| (((v as u32 - min_val) * 255 + range / 2) / range) as u8)
        .collect()
}

/// Sauvola adaptive thresholding on a 1-channel u8 grayscale image.
///
/// For each pixel, computes local mean `m` and standard deviation `σ` in a
/// (`window` × `window`) neighbourhood using integral images — O(1) per pixel.
///
/// Threshold: T(x,y) = m · (1 + k · (σ/R − 1))
///   m = local mean, σ = local std-dev, R = 128 (half of max u8 range), k = 0.2.
///
/// Convention: pixel < T → 0 (dark text), pixel ≥ T → 255 (light background).
///
/// Memory: two u64 integral images of size (w+1)×(h+1).
/// Overflow analysis for a 15×15 window:
///   max sum²  = 225 × 255² = 14,626,875 < u64::MAX ✓
///   max sum   = 225 × 255  = 57,375     < u64::MAX ✓
fn sauvola_binarize_u8(src: &[u8], w: u32, h: u32, window: u32, k: f32) -> Vec<u8> {
    let w = w as usize;
    let h = h as usize;
    let half = (window as usize) / 2;
    let stride = w + 1;

    // Build integral images (1-based, 0-padded border)
    let mut isum  = vec![0u64; stride * (h + 1)];
    let mut isum2 = vec![0u64; stride * (h + 1)];

    for y in 0..h {
        for x in 0..w {
            let v = src[y * w + x] as u64;
            let idx = (y + 1) * stride + (x + 1);
            isum [idx] = v      + isum [idx - stride] + isum [idx - 1] - isum [idx - stride - 1];
            isum2[idx] = v * v  + isum2[idx - stride] + isum2[idx - 1] - isum2[idx - stride - 1];
        }
    }

    let mut dst = vec![0u8; w * h];

    for y in 0..h {
        let y1 = y.saturating_sub(half);
        let y2 = (y + half + 1).min(h);

        for x in 0..w {
            let x1 = x.saturating_sub(half);
            let x2 = (x + half + 1).min(w);

            // Rectangular sum via 4-corner difference on the integral image
            let count = ((y2 - y1) * (x2 - x1)) as u64;
            let a = y2 * stride + x2;
            let b = y1 * stride + x2;
            let c = y2 * stride + x1;
            let d = y1 * stride + x1;
            let sum  = isum [a] - isum [b] - isum [c] + isum [d];
            let sum2 = isum2[a] - isum2[b] - isum2[c] + isum2[d];

            let mean     = sum as f32 / count as f32;
            // Variance = E[X²] − E[X]² ; clamp to ≥0 to absorb integer rounding
            let variance = (sum2 as f32 / count as f32 - mean * mean).max(0.0);
            let sigma    = variance.sqrt();

            const R: f32 = 128.0;
            let threshold = mean * (1.0 + k * (sigma / R - 1.0));

            dst[y * w + x] = if (src[y * w + x] as f32) < threshold { 0 } else { 255 };
        }
    }

    dst
}

// ─── Set-of-Mark label drawing (Step 4) ─────────────────────────────────────

/// One annotated UI element: bounding box + sequential ID to draw on the SoM image.
#[napi(object)]
pub struct SomLabel {
    /// 1-based sequential ID shown in the badge.
    pub id: u32,
    /// Bounding box in image-local coordinates.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Options for `draw_som_labels`.
#[napi(object)]
pub struct DrawSomLabelsOptions {
    /// Raw pixel buffer (RGB or RGBA layout, row-major).
    pub data: Buffer,
    /// Image width in pixels.
    pub width: u32,
    /// Image height in pixels.
    pub height: u32,
    /// Number of channels per pixel: 3 (RGB) or 4 (RGBA).
    pub channels: u32,
    /// Elements to annotate with bounding boxes and ID badges.
    pub labels: Vec<SomLabel>,
}

/// Output of `draw_som_labels` — same dimensions and channel layout as input.
#[napi(object)]
pub struct DrawSomLabelsResult {
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
    pub channels: u32,
}

// ── 5×7 bitmap font for digits 0–9 ──────────────────────────────────────────
//
// Each digit is represented as 7 rows × 5 columns.
// Each row is stored as a u8 where bit 4 = leftmost column, bit 0 = rightmost.
//
// Verified against standard 5×7 LED-style font glyphs.

const DIGIT_FONT: [[u8; 7]; 10] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110], // 0
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110], // 1
    [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111], // 2
    [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110], // 3
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010], // 4
    [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b10001, 0b01110], // 5
    [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110], // 6
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000], // 7
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110], // 8
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b10001, 0b01110], // 9
];

const DIGIT_W: u32 = 5;
const DIGIT_H: u32 = 7;
/// Padding (px) around the digit(s) inside the badge rectangle.
const BADGE_PAD: u32 = 2;
/// Total badge height: top_pad + 7 rows + bottom_pad.
const BADGE_H: u32 = DIGIT_H + BADGE_PAD * 2;

// ── Pixel helpers ────────────────────────────────────────────────────────────

/// Write an RGB pixel at (x, y) in a row-major buffer. Alpha channel (ch=4) is
/// left unchanged. Silently no-ops when the coordinate is out of bounds or the
/// index would overflow the buffer.
#[inline]
fn set_pixel(buf: &mut [u8], x: u32, y: u32, w: u32, h: u32, ch: u32, r: u8, g: u8, b: u8) {
    if x >= w || y >= h {
        return;
    }
    let idx = (y as usize)
        .saturating_mul(w as usize)
        .saturating_add(x as usize)
        .saturating_mul(ch as usize);
    // Need at least 3 bytes for R/G/B; alpha (ch=4, idx+3) is intentionally not touched.
    if idx.saturating_add(2) < buf.len() {
        buf[idx]     = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
    }
}

/// Draw a 2-pixel-thick red rectangle outline.
fn draw_rect_outline(buf: &mut [u8], bx: u32, by: u32, bw: u32, bh: u32, w: u32, h: u32, ch: u32) {
    // Top + bottom edges
    for dx in 0..bw {
        let px = bx.saturating_add(dx);
        for t in 0..2u32 {
            set_pixel(buf, px, by.saturating_add(t), w, h, ch, 255, 0, 0);
            if bh >= t + 1 {
                set_pixel(buf, px, by.saturating_add(bh - 1 - t), w, h, ch, 255, 0, 0);
            }
        }
    }
    // Left + right edges
    for dy in 0..bh {
        let py = by.saturating_add(dy);
        for t in 0..2u32 {
            set_pixel(buf, bx.saturating_add(t), py, w, h, ch, 255, 0, 0);
            if bw >= t + 1 {
                set_pixel(buf, bx.saturating_add(bw - 1 - t), py, w, h, ch, 255, 0, 0);
            }
        }
    }
}

/// Decompose an integer into its decimal digits, most-significant first.
fn id_to_digits(mut id: u32) -> Vec<u8> {
    if id == 0 {
        return vec![0];
    }
    let mut digits = Vec::new();
    while id > 0 {
        digits.push((id % 10) as u8);
        id /= 10;
    }
    digits.reverse();
    digits
}

/// Compute the width of a badge for the given digit sequence.
/// Formula: left_pad + (5px × n) + (1px gap × (n-1)) + right_pad
#[inline]
fn badge_width(n_digits: u32) -> u32 {
    BADGE_PAD + DIGIT_W * n_digits + n_digits.saturating_sub(1) + BADGE_PAD
}

/// Draw a white-filled badge with black digit glyphs at (bx, by) in the buffer.
/// The badge is automatically clamped to the image bounds.
fn draw_badge(buf: &mut [u8], bx: u32, by: u32, img_w: u32, img_h: u32, ch: u32, id: u32) {
    let digits = id_to_digits(id);
    let bw = badge_width(digits.len() as u32);

    // Fill white background (clamped to image bounds)
    let right  = bx.saturating_add(bw).min(img_w);
    let bottom = by.saturating_add(BADGE_H).min(img_h);
    for py in by..bottom {
        for px in bx..right {
            set_pixel(buf, px, py, img_w, img_h, ch, 255, 255, 255);
        }
    }

    // Render each digit glyph
    for (di, &d) in digits.iter().enumerate() {
        let glyph = DIGIT_FONT[d as usize];
        // Each digit cell starts at: left_pad + (digit_index × (glyph_w + 1px_gap))
        let gx = bx.saturating_add(BADGE_PAD).saturating_add(di as u32 * (DIGIT_W + 1));
        let gy = by.saturating_add(BADGE_PAD);
        for row in 0..DIGIT_H {
            let row_bits = glyph[row as usize];
            for col in 0..DIGIT_W {
                // Bit DIGIT_W-1-col is the column from left.
                if (row_bits >> (DIGIT_W - 1 - col)) & 1 == 1 {
                    set_pixel(buf, gx + col, gy + row, img_w, img_h, ch, 0, 0, 0);
                }
            }
        }
    }
}

// ── Public implementation ────────────────────────────────────────────────────

/// Render Set-of-Mark annotations onto a raw RGB/RGBA image buffer.
///
/// For each label, draws:
///   - A 2px red bounding box outline around the element region
///   - A white badge with a black digit ID at the top-left of the box
///
/// All pixel operations are bounds-checked; out-of-bounds coordinates are
/// silently skipped. The buffer is modified in-place (copied from the napi
/// Buffer) and returned as a new Buffer.
pub fn draw_som_labels_impl(opts: DrawSomLabelsOptions) -> Result<DrawSomLabelsResult> {
    if opts.channels != 3 && opts.channels != 4 {
        return Err(napi::Error::from_reason(format!(
            "draw_som_labels: channels must be 3 or 4, got {}",
            opts.channels
        )));
    }
    let expected_len = (opts.width as usize) * (opts.height as usize) * (opts.channels as usize);
    if opts.data.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "draw_som_labels: data length mismatch: expected {expected_len}, got {}",
            opts.data.len()
        )));
    }

    let mut buf = opts.data.to_vec();
    let w  = opts.width;
    let h  = opts.height;
    let ch = opts.channels;

    for label in &opts.labels {
        // Clamp bbox to image bounds
        let bx = label.x.min(w.saturating_sub(1));
        let by = label.y.min(h.saturating_sub(1));
        let bw = label.width.min(w - bx);
        let bh = label.height.min(h - by);

        if bw == 0 || bh == 0 {
            continue;
        }

        draw_rect_outline(&mut buf, bx, by, bw, bh, w, h, ch);
        draw_badge(&mut buf, bx, by, w, h, ch, label.id);
    }

    Ok(DrawSomLabelsResult {
        data: Buffer::from(buf),
        width: w,
        height: h,
        channels: ch,
    })
}
