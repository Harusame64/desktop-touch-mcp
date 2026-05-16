//! ADR-019 Stage 4 — SSIM residual between two same-size pre/post frames.
//!
//! Implementation: Wang, Bovik, Sheikh, Simoncelli 2004 reference
//! ("Image quality assessment: from error visibility to structural similarity")
//! with L=255 dynamic range, K1=0.01, K2=0.03, over an 8×8 sliding window
//! with stride 4. Per-window SSIM is computed from sliding means / variances
//! / covariance; the residual map is `1.0 - ssim_window` per window, and a
//! window is "above threshold" when `1.0 - ssim_window > RESIDUAL_WINDOW_THRESHOLD`.
//!
//! Output:
//! - `fraction_changed`: fraction of windows above threshold ∈ [0.0, 1.0]
//! - `centroid`: mean window-coordinate centroid of above-threshold windows
//!   (omitted when zero windows are above threshold)
//! - `mean_ssim`: mean SSIM across all windows in the region; the
//!   Wang "perceptually identical" cutoff (≥ 0.99) is exposed via
//!   `VisualMotionObservation.residual.meanSsim` so callers can audit the
//!   `no_change` vs `indeterminate` boundary (sub-plan §4 P15(a)).
//!
//! Stage 4 P1 ships the scalar implementation only (correctness first); P12
//! later adds AVX2 + SSE2 runtime dispatch when the scalar p99 misses the
//! 15 ms unit budget. The module structure mirrors `pixel_diff.rs` so the
//! optimisation pass can drop in the SIMD paths without re-shaping the API.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Wang 2004 dynamic range for 8-bit images.
const L_RANGE: f64 = 255.0;
/// Wang 2004 stability constant K1 (small, prevents 0/0 in low-luma regions).
const K1: f64 = 0.01;
/// Wang 2004 stability constant K2 (small, prevents 0/0 in low-contrast regions).
const K2: f64 = 0.03;
/// SSIM stability constants (C1 = (K1·L)², C2 = (K2·L)²).
const C1: f64 = (K1 * L_RANGE) * (K1 * L_RANGE);
const C2: f64 = (K2 * L_RANGE) * (K2 * L_RANGE);

/// Sliding-window side length (Wang 2004 8×8).
const WINDOW_SIZE: u32 = 8;
/// Sliding-window stride. Stride 4 produces 4-pixel overlap (50 %)
/// per Wang 2004 §IV.A; trades compute for spatial smoothness.
const WINDOW_STRIDE: u32 = 4;
/// Per-window `1.0 - ssim` threshold for the residual aggregation.
/// Sub-plan §2.5 locks this at 0.05 (default).
const RESIDUAL_WINDOW_THRESHOLD: f64 = 0.05;

#[napi(object)]
pub struct SsimRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct SsimCentroid {
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
pub struct SsimResidualResult {
    /// Fraction of 8×8 sliding windows whose `1 - SSIM` exceeded
    /// `RESIDUAL_WINDOW_THRESHOLD` (default 0.05). 0.0 means no change;
    /// 1.0 means every window changed.
    pub fraction_changed: f64,
    /// Mean window-centre centroid of above-threshold windows (in `region`
    /// coordinates when a region is supplied, else absolute frame
    /// coordinates). Omitted when `fraction_changed === 0` (no changed
    /// windows to mean).
    pub centroid: Option<SsimCentroid>,
    /// Mean SSIM across all windows in the region. Useful for the Wang
    /// "perceptually identical" cutoff (≥ 0.99) as a `no_change` disambiguator.
    pub mean_ssim: f64,
}

/// ADR-019 Stage 4 — SSIM residual between two same-size pre/post frames.
/// Public API surface called via napi.
///
/// `region` selects an inner sub-rect (in pre / post coordinates); pass
/// `None` for whole-frame. The centroid (when emitted) is the mean
/// window-centre coordinate of windows above threshold, useful for
/// click-feedback "where did the repaint land?" diagnostics.
///
/// Errors when input shapes are inconsistent: buffer length mismatch,
/// channels ∉ {3,4}, or region falls outside the frame.
pub fn compute_ssim_residual(
    pre: &[u8],
    post: &[u8],
    width: u32,
    height: u32,
    channels: u32,
    region: Option<SsimRegion>,
) -> Result<SsimResidualResult> {
    if channels != 3 && channels != 4 {
        return Err(napi::Error::from_reason(format!(
            "channels must be 3 or 4, got {channels}"
        )));
    }
    let expected_len = (width as usize) * (height as usize) * (channels as usize);
    if pre.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "pre buffer length mismatch: expected {expected_len}, got {}",
            pre.len()
        )));
    }
    if post.len() != expected_len {
        return Err(napi::Error::from_reason(format!(
            "post buffer length mismatch: expected {expected_len}, got {}",
            post.len()
        )));
    }

    // Resolve effective region (full frame when None).
    let (rx, ry, rw, rh) = match region {
        Some(r) => (r.x, r.y, r.width, r.height),
        None => (0u32, 0u32, width, height),
    };

    // Degenerate (zero / out-of-bounds) region → trivial result.
    if rw == 0 || rh == 0 {
        return Ok(SsimResidualResult {
            fraction_changed: 0.0,
            centroid: None,
            mean_ssim: 1.0,
        });
    }
    if rx.checked_add(rw).map_or(true, |sum| sum > width)
        || ry.checked_add(rh).map_or(true, |sum| sum > height)
    {
        return Err(napi::Error::from_reason(format!(
            "region (x={rx}, y={ry}, w={rw}, h={rh}) falls outside frame ({width}×{height})"
        )));
    }

    // Window too large for region → emit single-window mean SSIM over the
    // entire region with no above-threshold reporting (graceful degrade).
    if rw < WINDOW_SIZE || rh < WINDOW_SIZE {
        let ssim_full = ssim_single_window_scalar(
            pre, post, width, channels, rx, ry, rw, rh,
        );
        // No sliding window grid — caller sees mean_ssim only, with no
        // residual fraction (region too small for the 8×8 analysis).
        return Ok(SsimResidualResult {
            fraction_changed: 0.0,
            centroid: None,
            mean_ssim: ssim_full.clamp(-1.0, 1.0),
        });
    }

    compute_ssim_scalar(pre, post, width, channels, rx, ry, rw, rh)
}

/// Scalar reference implementation. Iterates 8×8 sliding windows with
/// `WINDOW_STRIDE = 4` over the region, computes per-window SSIM on the
/// luminance channel (BT.601-weighted grayscale of RGB), aggregates the
/// fraction of windows whose `1 - SSIM > RESIDUAL_WINDOW_THRESHOLD`, and
/// returns the centroid of above-threshold window centres.
fn compute_ssim_scalar(
    pre: &[u8],
    post: &[u8],
    width: u32,
    channels: u32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
) -> Result<SsimResidualResult> {
    // Window grid step counts. A 16×16 region with stride 4 / window 8 yields
    // ceil((16-8)/4) + 1 = 3 windows per axis = 9 windows.
    let x_steps = (rw - WINDOW_SIZE) / WINDOW_STRIDE + 1;
    let y_steps = (rh - WINDOW_SIZE) / WINDOW_STRIDE + 1;
    let total_windows = (x_steps as u64) * (y_steps as u64);
    if total_windows == 0 {
        // Defensive — already gated by `rw >= WINDOW_SIZE` check above.
        return Ok(SsimResidualResult {
            fraction_changed: 0.0,
            centroid: None,
            mean_ssim: 1.0,
        });
    }

    let mut above_count: u64 = 0;
    let mut sum_ssim: f64 = 0.0;
    let mut centroid_sum_x: f64 = 0.0;
    let mut centroid_sum_y: f64 = 0.0;

    for wy in 0..y_steps {
        let y0 = ry + wy * WINDOW_STRIDE;
        for wx in 0..x_steps {
            let x0 = rx + wx * WINDOW_STRIDE;
            let ssim = ssim_single_window_scalar(
                pre,
                post,
                width,
                channels,
                x0,
                y0,
                WINDOW_SIZE,
                WINDOW_SIZE,
            );
            let ssim_clamped = ssim.clamp(-1.0, 1.0);
            sum_ssim += ssim_clamped;
            let residual = 1.0 - ssim_clamped;
            if residual > RESIDUAL_WINDOW_THRESHOLD {
                above_count += 1;
                // Window centre, expressed in absolute frame coords (caller
                // intersects with region offsets if needed).
                let cx = x0 as f64 + (WINDOW_SIZE as f64) / 2.0;
                let cy = y0 as f64 + (WINDOW_SIZE as f64) / 2.0;
                centroid_sum_x += cx;
                centroid_sum_y += cy;
            }
        }
    }

    let fraction_changed = above_count as f64 / total_windows as f64;
    let mean_ssim = sum_ssim / total_windows as f64;
    let centroid = if above_count > 0 {
        Some(SsimCentroid {
            x: centroid_sum_x / above_count as f64,
            y: centroid_sum_y / above_count as f64,
        })
    } else {
        None
    };

    Ok(SsimResidualResult {
        fraction_changed,
        centroid,
        mean_ssim,
    })
}

/// Compute SSIM on a single window of arbitrary size, on the luminance
/// channel only (BT.601-weighted RGB → grayscale).
///
/// Used both for the sliding-window grid (size = 8×8) and for the
/// graceful-degrade single-window case when the region is smaller than the
/// minimum 8×8 window.
fn ssim_single_window_scalar(
    pre: &[u8],
    post: &[u8],
    width: u32,
    channels: u32,
    x0: u32,
    y0: u32,
    w: u32,
    h: u32,
) -> f64 {
    let stride = (width * channels) as usize;
    let ch = channels as usize;
    let n = (w as usize) * (h as usize);
    if n == 0 {
        return 1.0;
    }

    let mut sum_a: f64 = 0.0;
    let mut sum_b: f64 = 0.0;
    let mut sum_aa: f64 = 0.0;
    let mut sum_bb: f64 = 0.0;
    let mut sum_ab: f64 = 0.0;

    for y in y0..(y0 + h) {
        for x in x0..(x0 + w) {
            let idx = (y as usize) * stride + (x as usize) * ch;
            let a = luminance(pre[idx], pre[idx + 1], pre[idx + 2]);
            let b = luminance(post[idx], post[idx + 1], post[idx + 2]);
            sum_a += a;
            sum_b += b;
            sum_aa += a * a;
            sum_bb += b * b;
            sum_ab += a * b;
        }
    }

    let n_f = n as f64;
    let mean_a = sum_a / n_f;
    let mean_b = sum_b / n_f;
    let var_a = (sum_aa / n_f) - mean_a * mean_a;
    let var_b = (sum_bb / n_f) - mean_b * mean_b;
    let cov_ab = (sum_ab / n_f) - mean_a * mean_b;

    // Wang 2004 eq. 13.
    let numerator = (2.0 * mean_a * mean_b + C1) * (2.0 * cov_ab + C2);
    let denominator = (mean_a * mean_a + mean_b * mean_b + C1) * (var_a + var_b + C2);

    if denominator.abs() < f64::EPSILON {
        // Constant block on both sides — define SSIM = 1.0 (perceptually
        // identical, no contrast to register). This matches reference
        // implementations like `dssim` for uniform regions.
        return 1.0;
    }
    numerator / denominator
}

/// BT.601 luminance (Y = 0.299 R + 0.587 G + 0.114 B). Alpha is ignored
/// for 4-channel buffers (alpha-premultiplied content rare on
/// `PrintWindow` outputs; CLAUDE.md §3.2 carry-over keeps RGBA semantics
/// to the upstream image-diff helper).
#[inline]
fn luminance(r: u8, g: u8, b: u8) -> f64 {
    0.299 * (r as f64) + 0.587 * (g as f64) + 0.114 * (b as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buf_filled(width: u32, height: u32, channels: u32, value: u8) -> Vec<u8> {
        vec![value; (width * height * channels) as usize]
    }

    #[test]
    fn same_frame_returns_zero_fraction() {
        let buf = buf_filled(64, 64, 4, 128);
        let r = compute_ssim_residual(&buf, &buf, 64, 64, 4, None).unwrap();
        assert!(r.fraction_changed.abs() < 1e-9, "fraction_changed should be 0");
        assert!(r.centroid.is_none(), "no centroid for identical frames");
        assert!(
            r.mean_ssim >= 0.999,
            "mean_ssim should be ≥ 0.999 for identical frames, got {}",
            r.mean_ssim
        );
    }

    #[test]
    fn rgb_three_channel_supported() {
        let buf = buf_filled(32, 32, 3, 200);
        let r = compute_ssim_residual(&buf, &buf, 32, 32, 3, None).unwrap();
        assert!(r.fraction_changed.abs() < 1e-9);
        assert!(r.mean_ssim >= 0.999);
    }

    #[test]
    fn black_rect_on_white_centroid_near_centre() {
        // 200×200 white, with a 20×20 black rectangle centred at (100, 100).
        let w = 200u32;
        let h = 200u32;
        let ch = 4u32;
        let pre = buf_filled(w, h, ch, 255);
        let mut post = pre.clone();
        // Draw black rect [90..110) × [90..110) in `post`.
        let stride = (w * ch) as usize;
        let chan = ch as usize;
        for y in 90..110usize {
            for x in 90..110usize {
                let i = y * stride + x * chan;
                post[i] = 0;
                post[i + 1] = 0;
                post[i + 2] = 0;
                // alpha untouched
            }
        }
        // Force a deterministic difference somewhere we can read.
        assert_ne!(pre, post);
        let r = compute_ssim_residual(&pre, &post, w, h, ch, None).unwrap();
        // Some windows must register a change (high-contrast 20×20 patch).
        assert!(
            r.fraction_changed > 0.0,
            "fraction_changed should be > 0 for non-identical frames, got {}",
            r.fraction_changed
        );
        // Wang threshold not violated by entire image — fraction must be
        // small (~few percent of windows touched).
        assert!(
            r.fraction_changed < 0.5,
            "small black-rect should touch < 50% of windows, got {}",
            r.fraction_changed
        );
        let c = r.centroid.expect("centroid present when fraction > 0");
        // Centroid should be near (100, 100) within ~16 px (sub-plan G4-1).
        let dx = (c.x - 100.0).abs();
        let dy = (c.y - 100.0).abs();
        assert!(
            dx <= 16.0 && dy <= 16.0,
            "centroid ({}, {}) should be within 16 px of (100, 100)",
            c.x,
            c.y
        );
        // mean_ssim should be high (most windows untouched) but < 1.0.
        assert!(
            r.mean_ssim > 0.9 && r.mean_ssim < 1.0,
            "mean_ssim should be in (0.9, 1.0), got {}",
            r.mean_ssim
        );
    }

    #[test]
    fn region_bounds_check_rejects_out_of_frame() {
        let buf = buf_filled(16, 16, 4, 0);
        let region = SsimRegion {
            x: 10,
            y: 10,
            width: 20,
            height: 20,
        };
        let r = compute_ssim_residual(&buf, &buf, 16, 16, 4, Some(region));
        assert!(r.is_err());
    }

    #[test]
    fn buffer_length_mismatch_returns_error() {
        let pre = vec![0u8; 10];
        let post = vec![0u8; 16 * 16 * 4];
        let r = compute_ssim_residual(&pre, &post, 16, 16, 4, None);
        assert!(r.is_err());
    }

    #[test]
    fn invalid_channels_returns_error() {
        let buf = vec![0u8; 16 * 16 * 2];
        let r = compute_ssim_residual(&buf, &buf, 16, 16, 2, None);
        assert!(r.is_err());
    }

    #[test]
    fn zero_region_returns_trivial_result() {
        let buf = buf_filled(16, 16, 4, 128);
        let region = SsimRegion {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        let r = compute_ssim_residual(&buf, &buf, 16, 16, 4, Some(region)).unwrap();
        assert!(r.fraction_changed.abs() < 1e-9);
        assert!(r.centroid.is_none());
    }

    #[test]
    fn region_smaller_than_window_returns_single_ssim() {
        // 4×4 region < 8×8 window → graceful degrade: returns mean_ssim only.
        let buf = buf_filled(16, 16, 4, 128);
        let region = SsimRegion {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
        };
        let r = compute_ssim_residual(&buf, &buf, 16, 16, 4, Some(region)).unwrap();
        // Identical → mean_ssim ≈ 1.0, no above-threshold windows.
        assert!(r.fraction_changed.abs() < 1e-9);
        assert!(r.mean_ssim >= 0.999);
    }

    #[test]
    fn subregion_isolates_change() {
        // Whole-frame change, but region in untouched corner → no change.
        let w = 64u32;
        let h = 64u32;
        let ch = 4u32;
        let pre = buf_filled(w, h, ch, 0);
        let mut post = pre.clone();
        // Change only the bottom-right quadrant in `post`.
        let stride = (w * ch) as usize;
        let chan = ch as usize;
        for y in 32..64usize {
            for x in 32..64usize {
                let i = y * stride + x * chan;
                post[i] = 255;
                post[i + 1] = 255;
                post[i + 2] = 255;
            }
        }
        // Region in the untouched top-left quadrant.
        let region = SsimRegion {
            x: 0,
            y: 0,
            width: 24,
            height: 24,
        };
        let r =
            compute_ssim_residual(&pre, &post, w, h, ch, Some(region)).unwrap();
        assert!(
            r.fraction_changed.abs() < 1e-9,
            "untouched region should report no change, got {}",
            r.fraction_changed
        );
        assert!(r.mean_ssim >= 0.999);
    }
}
