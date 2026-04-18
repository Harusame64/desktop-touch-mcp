//! Block-based pixel comparison engine with SIMD acceleration.
//!
//! Equivalent to `computeChangeFraction` in layer-buffer.ts.
//! Uses SSE2 `_mm_sad_epu8` (psadbw) to process 16 bytes per cycle on x86_64.

use napi::Result;

#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

const BLOCK_SIZE: u32 = 8;
const NOISE_THRESHOLD: u32 = 16;

/// Compute the fraction of 8×8 blocks whose average per-channel delta exceeds
/// the noise threshold.
///
/// # Arguments
/// - `prev`, `curr` — raw pixel buffers (RGB or RGBA, same layout)
/// - `width`, `height` — image dimensions in pixels
/// - `channels` — 3 (RGB) or 4 (RGBA); only the first 3 channels are compared
///
/// # Returns
/// `0.0` when images are identical, `1.0` when every block differs.
pub fn compute_change_fraction(
    prev: &[u8],
    curr: &[u8],
    width: u32,
    height: u32,
    channels: u32,
) -> Result<f64> {
    if width == 0 || height == 0 {
        return Ok(0.0);
    }
    if channels != 3 && channels != 4 {
        return Err(napi::Error::from_reason(format!(
            "channels must be 3 or 4, got {channels}"
        )));
    }
    let expected_len = (width as usize) * (height as usize) * (channels as usize);
    if prev.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "prev buffer length mismatch: expected {expected_len}, got {}",
            prev.len()
        )));
    }
    if curr.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "curr buffer length mismatch: expected {expected_len}, got {}",
            curr.len()
        )));
    }

    let blocks_x = (width + BLOCK_SIZE - 1) / BLOCK_SIZE;
    let blocks_y = (height + BLOCK_SIZE - 1) / BLOCK_SIZE;
    let total_blocks = blocks_x * blocks_y;
    if total_blocks == 0 {
        return Ok(0.0);
    }

    let stride = (width * channels) as usize;
    let ch = channels as usize;

    #[cfg(target_arch = "x86_64")]
    let changed_blocks = unsafe {
        compute_blocks_sse2(prev, curr, width, height, channels, blocks_x, blocks_y, stride, ch)
    };

    #[cfg(not(target_arch = "x86_64"))]
    let changed_blocks =
        compute_blocks_scalar(prev, curr, width, height, blocks_x, blocks_y, stride, ch);

    Ok(changed_blocks as f64 / total_blocks as f64)
}

// ---------------------------------------------------------------------------
// SSE2 SIMD path (x86_64 — guaranteed on all 64-bit x86 CPUs)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "sse2")]
unsafe fn compute_blocks_sse2(
    prev: &[u8],
    curr: &[u8],
    width: u32,
    height: u32,
    channels: u32,
    blocks_x: u32,
    blocks_y: u32,
    stride: usize,
    ch: usize,
) -> u32 {
    unsafe {
        let prev_ptr = prev.as_ptr();
        let curr_ptr = curr.as_ptr();

        // For RGBA: zero alpha bytes before SAD; for RGB: all-ones (identity AND)
        let mask = if channels == 4 {
            _mm_set1_epi32(0x00FFFFFFu32 as i32)
        } else {
            _mm_set1_epi8(-1i8)
        };

        let mut changed_blocks: u32 = 0;

        for by in 0..blocks_y {
            let y0 = by * BLOCK_SIZE;
            let y1 = (y0 + BLOCK_SIZE).min(height);

            for bx in 0..blocks_x {
                let x0 = bx * BLOCK_SIZE;
                let x1 = (x0 + BLOCK_SIZE).min(width);
                let pixels_in_row = (x1 - x0) as usize;
                let bytes_in_row = pixels_in_row * ch;
                let pixel_count = pixels_in_row * (y1 - y0) as usize;

                let mut block_sad: u32 = 0;

                for y in y0..y1 {
                    let base = y as usize * stride + x0 as usize * ch;
                    let p = prev_ptr.add(base);
                    let c = curr_ptr.add(base);
                    block_sad += row_sad_sse2(p, c, bytes_in_row, mask, ch);
                }

                // Multiplication avoids integer division truncation (JS float parity).
                if pixel_count > 0 && block_sad > pixel_count as u32 * 3 * NOISE_THRESHOLD {
                    changed_blocks += 1;
                }
            }
        }

        changed_blocks
    }
}

/// Compute SAD for one block row using SSE2 `psadbw`.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "sse2")]
unsafe fn row_sad_sse2(
    p: *const u8,
    c: *const u8,
    len: usize,
    mask: __m128i,
    ch: usize,
) -> u32 {
    unsafe {
        let mut total: u32 = 0;
        let mut off: usize = 0;

        // 16 bytes at a time — psadbw produces two u64 partial sums
        while off + 16 <= len {
            let pv = _mm_loadu_si128(p.add(off) as *const __m128i);
            let cv = _mm_loadu_si128(c.add(off) as *const __m128i);
            let pvm = _mm_and_si128(pv, mask);
            let cvm = _mm_and_si128(cv, mask);
            let sad = _mm_sad_epu8(pvm, cvm);
            total += _mm_cvtsi128_si32(sad) as u32;
            total += _mm_extract_epi16(sad, 4) as u32;
            off += 16;
        }

        // 8 bytes — upper 64 bits are zero, contributing 0 to SAD
        if off + 8 <= len {
            let pv = _mm_loadl_epi64(p.add(off) as *const __m128i);
            let cv = _mm_loadl_epi64(c.add(off) as *const __m128i);
            let pvm = _mm_and_si128(pv, mask);
            let cvm = _mm_and_si128(cv, mask);
            let sad = _mm_sad_epu8(pvm, cvm);
            total += _mm_cvtsi128_si32(sad) as u32;
            off += 8;
        }

        // Scalar tail (at most 7 bytes). Skip alpha bytes for RGBA.
        while off < len {
            if ch == 4 && off % 4 == 3 {
                off += 1;
                continue;
            }
            let d = (*p.add(off) as i32 - *c.add(off) as i32).unsigned_abs();
            total += d;
            off += 1;
        }

        total
    }
}

// ---------------------------------------------------------------------------
// Scalar fallback (non-x86_64 targets + unit-test reference)
// ---------------------------------------------------------------------------

#[cfg(any(test, not(target_arch = "x86_64")))]
fn compute_blocks_scalar(
    prev: &[u8],
    curr: &[u8],
    width: u32,
    height: u32,
    blocks_x: u32,
    blocks_y: u32,
    stride: usize,
    ch: usize,
) -> u32 {
    let mut changed_blocks: u32 = 0;

    for by in 0..blocks_y {
        let y0 = by * BLOCK_SIZE;
        let y1 = (y0 + BLOCK_SIZE).min(height);

        for bx in 0..blocks_x {
            let x0 = bx * BLOCK_SIZE;
            let x1 = (x0 + BLOCK_SIZE).min(width);

            let mut sum_delta: u32 = 0;
            let mut count: u32 = 0;

            for y in y0..y1 {
                let row_offset = (y as usize) * stride;
                for x in x0..x1 {
                    let idx = row_offset + (x as usize) * ch;
                    let d0 = (prev[idx] as i32 - curr[idx] as i32).unsigned_abs();
                    let d1 = (prev[idx + 1] as i32 - curr[idx + 1] as i32).unsigned_abs();
                    let d2 = (prev[idx + 2] as i32 - curr[idx + 2] as i32).unsigned_abs();
                    sum_delta += d0 + d1 + d2;
                    count += 1;
                }
            }

            if count > 0 && sum_delta > count * 3 * NOISE_THRESHOLD {
                changed_blocks += 1;
            }
        }
    }

    changed_blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_images_return_zero() {
        let buf = vec![128u8; 100 * 100 * 3];
        let result = compute_change_fraction(&buf, &buf, 100, 100, 3).unwrap();
        assert!((result - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn completely_different_images_return_one() {
        let prev = vec![0u8; 16 * 16 * 3];
        let curr = vec![255u8; 16 * 16 * 3];
        let result = compute_change_fraction(&prev, &curr, 16, 16, 3).unwrap();
        assert!((result - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn zero_dimensions_return_zero() {
        let result = compute_change_fraction(&[], &[], 0, 0, 3).unwrap();
        assert!((result - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn rgba_channels_work() {
        let prev = vec![0u8; 32 * 32 * 4];
        let curr = vec![255u8; 32 * 32 * 4];
        let result = compute_change_fraction(&prev, &curr, 32, 32, 4).unwrap();
        assert!((result - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn buffer_length_mismatch_returns_error() {
        let prev = vec![0u8; 10];
        let curr = vec![0u8; 10 * 10 * 3];
        let result = compute_change_fraction(&prev, &curr, 10, 10, 3);
        assert!(result.is_err());
    }

    #[test]
    fn invalid_channels_returns_error() {
        let buf = vec![0u8; 10 * 10 * 2];
        let result = compute_change_fraction(&buf, &buf, 10, 10, 2);
        assert!(result.is_err());
    }

    #[test]
    fn partial_block_boundary() {
        let prev = vec![0u8; 10 * 10 * 3];
        let mut curr = vec![0u8; 10 * 10 * 3];
        for y in 0..8 {
            for x in 0..8 {
                let idx = (y * 10 + x) * 3;
                curr[idx] = 255;
                curr[idx + 1] = 255;
                curr[idx + 2] = 255;
            }
        }
        let result = compute_change_fraction(&prev, &curr, 10, 10, 3).unwrap();
        assert!((result - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn noise_below_threshold_is_ignored() {
        let prev = vec![100u8; 8 * 8 * 3];
        let curr = vec![110u8; 8 * 8 * 3];
        let result = compute_change_fraction(&prev, &curr, 8, 8, 3).unwrap();
        assert!((result - 0.0).abs() < f64::EPSILON);
    }

    /// Verify SIMD path matches scalar reference for random RGB data.
    #[test]
    fn simd_matches_scalar_rgb() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let (w, h, ch): (u32, u32, usize) = (100, 75, 3);
        let len = w as usize * h as usize * ch;
        let mut prev = vec![0u8; len];
        let mut curr = vec![0u8; len];

        for i in 0..len {
            let mut s = DefaultHasher::new();
            (i as u64).hash(&mut s);
            prev[i] = (s.finish() & 0xFF) as u8;
            (i as u64 + 0x1234).hash(&mut s);
            curr[i] = (s.finish() & 0xFF) as u8;
        }

        let stride = w as usize * ch;
        let bx = (w + BLOCK_SIZE - 1) / BLOCK_SIZE;
        let by = (h + BLOCK_SIZE - 1) / BLOCK_SIZE;
        let scalar = compute_blocks_scalar(&prev, &curr, w, h, bx, by, stride, ch);

        #[cfg(target_arch = "x86_64")]
        {
            let simd = unsafe {
                compute_blocks_sse2(&prev, &curr, w, h, ch as u32, bx, by, stride, ch)
            };
            assert_eq!(simd, scalar, "SIMD and scalar must match for RGB");
        }
    }

    /// Verify SIMD path matches scalar reference for random RGBA data.
    #[test]
    fn simd_matches_scalar_rgba() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let (w, h, ch): (u32, u32, usize) = (50, 40, 4);
        let len = w as usize * h as usize * ch;
        let mut prev = vec![0u8; len];
        let mut curr = vec![0u8; len];

        for i in 0..len {
            let mut s = DefaultHasher::new();
            (i as u64 + 999).hash(&mut s);
            prev[i] = (s.finish() & 0xFF) as u8;
            (i as u64 + 5678).hash(&mut s);
            curr[i] = (s.finish() & 0xFF) as u8;
        }

        let stride = w as usize * ch;
        let bx = (w + BLOCK_SIZE - 1) / BLOCK_SIZE;
        let by = (h + BLOCK_SIZE - 1) / BLOCK_SIZE;
        let scalar = compute_blocks_scalar(&prev, &curr, w, h, bx, by, stride, ch);

        #[cfg(target_arch = "x86_64")]
        {
            let simd = unsafe {
                compute_blocks_sse2(&prev, &curr, w, h, ch as u32, bx, by, stride, ch)
            };
            assert_eq!(simd, scalar, "SIMD and scalar must match for RGBA");
        }
    }
}
