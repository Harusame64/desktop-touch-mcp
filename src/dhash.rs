//! 64-bit difference hash (dHash) computation.
//!
//! Equivalent to `dHashFromRaw` in image.ts.
//! Pure Rust — no sharp/libvips dependency.
//!
//! Algorithm:
//!   1. Convert RGB/RGBA → grayscale (BT.601: Y = 0.299R + 0.587G + 0.114B)
//!   2. Resize to 9×8 using bilinear interpolation
//!   3. For each of the 8 rows, compare adjacent pixels → 8 bits per row → 64 bits total

use napi::Result;

/// Compute a 64-bit dHash from raw RGB/RGBA pixel data.
pub fn dhash_from_raw(raw: &[u8], width: u32, height: u32, channels: u32) -> Result<u64> {
    if width == 0 || height == 0 {
        return Ok(0);
    }
    if channels != 3 && channels != 4 {
        return Err(napi::Error::from_reason(format!(
            "channels must be 3 or 4, got {channels}"
        )));
    }
    let expected_len = (width as usize) * (height as usize) * (channels as usize);
    if raw.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "buffer length mismatch: expected {expected_len}, got {}",
            raw.len()
        )));
    }

    // Step 1: Convert to grayscale
    let gray = to_grayscale(raw, width, height, channels);

    // Step 2: Resize to 9×8 (bilinear)
    let resized = bilinear_resize(&gray, width, height, 9, 8);

    // Step 3: Horizontal comparison → 64-bit hash
    let mut hash: u64 = 0;
    for row in 0..8u32 {
        for col in 0..8u32 {
            let left = resized[(row * 9 + col) as usize];
            let right = resized[(row * 9 + col + 1) as usize];
            hash = (hash << 1) | u64::from(left > right);
        }
    }

    Ok(hash)
}

/// Convert raw RGB/RGBA to grayscale using BT.601 luminance coefficients.
/// Returns a Vec<f32> of luminance values (one per pixel).
fn to_grayscale(raw: &[u8], width: u32, height: u32, channels: u32) -> Vec<f32> {
    let pixel_count = (width as usize) * (height as usize);
    let ch = channels as usize;
    let mut gray = Vec::with_capacity(pixel_count);

    for i in 0..pixel_count {
        let idx = i * ch;
        let r = raw[idx] as f32;
        let g = raw[idx + 1] as f32;
        let b = raw[idx + 2] as f32;
        gray.push(0.299 * r + 0.587 * g + 0.114 * b);
    }

    gray
}

/// Bilinear interpolation resize of a single-channel (grayscale) image.
fn bilinear_resize(
    src: &[f32],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<f32> {
    let mut dst = vec![0.0f32; (dst_w * dst_h) as usize];

    let x_ratio = if dst_w > 1 {
        (src_w as f64 - 1.0) / (dst_w as f64 - 1.0)
    } else {
        0.0
    };
    let y_ratio = if dst_h > 1 {
        (src_h as f64 - 1.0) / (dst_h as f64 - 1.0)
    } else {
        0.0
    };

    for dy in 0..dst_h {
        let sy = y_ratio * dy as f64;
        let y0 = sy.floor() as u32;
        let y1 = (y0 + 1).min(src_h - 1);
        let fy = (sy - y0 as f64) as f32;

        for dx in 0..dst_w {
            let sx = x_ratio * dx as f64;
            let x0 = sx.floor() as u32;
            let x1 = (x0 + 1).min(src_w - 1);
            let fx = (sx - x0 as f64) as f32;

            let p00 = src[(y0 * src_w + x0) as usize];
            let p10 = src[(y0 * src_w + x1) as usize];
            let p01 = src[(y1 * src_w + x0) as usize];
            let p11 = src[(y1 * src_w + x1) as usize];

            let top = p00 + fx * (p10 - p00);
            let bot = p01 + fx * (p11 - p01);
            dst[(dy * dst_w + dx) as usize] = top + fy * (bot - top);
        }
    }

    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_image_hash_is_zero() {
        // All pixels identical → no pixel is brighter than its neighbor → hash = 0
        let buf = vec![128u8; 32 * 32 * 3];
        let hash = dhash_from_raw(&buf, 32, 32, 3).unwrap();
        assert_eq!(hash, 0);
    }

    #[test]
    fn gradient_image_hash_nonzero() {
        // Horizontal gradient: left is brighter → all comparison bits = 1
        let mut buf = vec![0u8; 64 * 64 * 3];
        for y in 0..64 {
            for x in 0..64 {
                let val = (255 - x * 4).min(255) as u8;
                let idx = (y * 64 + x) * 3;
                buf[idx] = val;
                buf[idx + 1] = val;
                buf[idx + 2] = val;
            }
        }
        let hash = dhash_from_raw(&buf, 64, 64, 3).unwrap();
        // Horizontal gradient left→right decreasing: left > right for every pair
        assert_eq!(hash, u64::MAX); // all 64 bits set
    }

    #[test]
    fn rgba_works() {
        let buf = vec![100u8; 16 * 16 * 4];
        let hash = dhash_from_raw(&buf, 16, 16, 4).unwrap();
        assert_eq!(hash, 0);
    }

    #[test]
    fn zero_size_returns_zero() {
        let hash = dhash_from_raw(&[], 0, 0, 3).unwrap();
        assert_eq!(hash, 0);
    }

    #[test]
    fn invalid_buffer_length_errors() {
        let buf = vec![0u8; 10];
        assert!(dhash_from_raw(&buf, 32, 32, 3).is_err());
    }

    #[test]
    fn bilinear_resize_identity() {
        // 9×8 → 9×8 should be (near) identity
        let src: Vec<f32> = (0..72).map(|i| i as f32).collect();
        let dst = bilinear_resize(&src, 9, 8, 9, 8);
        for (a, b) in src.iter().zip(dst.iter()) {
            assert!((a - b).abs() < 0.01, "mismatch: {a} vs {b}");
        }
    }
}
