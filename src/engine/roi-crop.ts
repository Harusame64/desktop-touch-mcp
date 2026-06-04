/**
 * roi-crop.ts — ADR-024 Seed-2 S4 — RGBA buffer ROI crop helper.
 *
 * Pure helper used by `runSomPipeline` (`ocr-bridge.ts`) to crop a captured
 * window RGBA buffer down to a region of interest before OCR, so the
 * visual-only post-action path (ADR-024 Seed-2) OCRs only the changed region
 * instead of the whole window.
 *
 * Coordinate space: `roi` is **image-local** — i.e. relative to the captured
 * window buffer's top-left, the SAME space the OCR pipeline already works in
 * before it adds `origin` to reach screen-absolute coords. (S3b produces
 * window-relative rects; since the SoM buffer's (0,0) maps to the window's
 * top-left, window-relative == image-local here.) The crop is clamped to the
 * buffer bounds, and the returned `x`/`y` are the **clamped** top-left so the
 * caller can shift its `origin` by exactly the crop offset and keep every
 * downstream coordinate (screen-absolute conversion, SoM label placement)
 * correct without any other change.
 *
 * Pure + side-effect-free; returns `null` when the ROI does not overlap the
 * buffer at all (caller treats that as "nothing to OCR").
 *
 * Sub-plan: `desktop-touch-mcp-internal@…:docs/adr-024-seed2-plan.md` §2 S4.
 */

import type { Rect } from "./vision-gpu/types.js";

export interface CroppedRgba {
  /** Tightly-packed RGBA bytes of the cropped region (`width * height * 4`). */
  data: Buffer;
  /** Crop width in pixels (clamped to the source buffer). */
  width: number;
  /** Crop height in pixels (clamped to the source buffer). */
  height: number;
  /** Clamped image-local x of the crop's top-left (= origin shift to apply). */
  x: number;
  /** Clamped image-local y of the crop's top-left (= origin shift to apply). */
  y: number;
}

/**
 * Crop an RGBA buffer to `roi` (image-local), clamped to the buffer bounds.
 *
 * @param data   Source RGBA bytes, row-major, `width * height * 4` length.
 * @param width  Source buffer width in pixels.
 * @param height Source buffer height in pixels.
 * @param roi    Image-local crop rect. Fractional coords are floored (top-left)
 *               / ceiled (bottom-right) so the crop never loses edge pixels.
 * @returns The cropped region + its clamped top-left, or `null` when `roi`
 *          does not overlap the buffer (zero-area intersection).
 */
export function cropRgbaToRoi(
  data: Buffer,
  width: number,
  height: number,
  roi: Rect,
): CroppedRgba | null {
  // Clamp the ROI to the buffer. Floor the top-left and ceil the bottom-right
  // so a sub-pixel ROI still captures the pixels it touches.
  const x0 = Math.max(0, Math.floor(roi.x));
  const y0 = Math.max(0, Math.floor(roi.y));
  const x1 = Math.min(width, Math.ceil(roi.x + roi.width));
  const y1 = Math.min(height, Math.ceil(roi.y + roi.height));

  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return null; // no overlap with the buffer

  const out = Buffer.allocUnsafe(cw * ch * 4);
  const srcRowStride = width * 4;
  const dstRowStride = cw * 4;
  for (let row = 0; row < ch; row++) {
    const srcStart = (y0 + row) * srcRowStride + x0 * 4;
    const dstStart = row * dstRowStride;
    data.copy(out, dstStart, srcStart, srcStart + dstRowStride);
  }

  return { data: out, width: cw, height: ch, x: x0, y: y0 };
}
