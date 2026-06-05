/**
 * _roi-region.ts — ADR-024 Seed-2 S3b — window-rect intersection filter (OQ-11c).
 *
 * Converts the per-output DXGI dirty rects surfaced by S3a
 * (`VisualMotionObservation.dirtyRects`, screen-absolute / per-output) into
 * **window-relative** ROI rects:
 *
 *   1. Intersect each dirty rect with the target window rect.
 *   2. Drop rects that miss the window entirely — DXGI dirty rects are
 *      reported per *output* (whole monitor), so a single poll can carry dirty
 *      regions belonging to other windows, the mouse cursor, or notifications
 *      sharing the same monitor. Those must not leak into the act's ROI crop.
 *   3. Translate the survivors into window-origin-relative coordinates
 *      (subtract `windowRect.x` / `windowRect.y`) so they line up with the
 *      `roiCapture.roi` / `somImage` crop space (a window-relative rect, per
 *      the S1 contract `RoiCapture.roi`).
 *
 * Pure + side-effect-free. **No production consumer yet**: the act-response
 * fold (S5) calls this to build `roiCapture.roi` after the ROI-aware OCR (S4)
 * produces the entity preview. S3b ships + unit-tests the geometry in
 * isolation so the per-output→window coordinate/sign conversion is reviewable
 * on its own (sub-plan §2 S3b review axis).
 *
 * Sub-plan: `desktop-touch-mcp-internal@…:docs/adr-024-seed2-plan.md` §2 S3b.
 */

import type { Rect } from "../engine/vision-gpu/types.js";

/**
 * Intersect the per-output dirty rects with `windowRect` and return the
 * overlapping regions in **window-relative** coordinates. Rects that do not
 * overlap the window are excluded.
 *
 * @param dirtyRects Screen-absolute per-output dirty rects (S3a
 *                   `VisualMotionObservation.dirtyRects`). May be empty.
 * @param windowRect Screen-absolute target window rect (same coordinate space
 *                   as `dirtyRects` — both desktop screen-absolute).
 * @returns Window-relative ROI rects (origin = window top-left). **Empty** when
 *          no dirty rect overlaps the window — the caller (S5) treats `[]` as
 *          "no ROI" and omits `roiCapture` (sub-plan §2 S3b acceptance ③).
 */
export function filterDirtyRectsToWindow(
  dirtyRects: readonly Rect[],
  windowRect: Rect,
): Rect[] {
  const out: Rect[] = [];

  const winLeft = windowRect.x;
  const winTop = windowRect.y;
  const winRight = windowRect.x + windowRect.width;
  const winBottom = windowRect.y + windowRect.height;

  for (const r of dirtyRects) {
    // Clip the dirty rect to the window bounds (screen-absolute).
    const left = Math.max(r.x, winLeft);
    const top = Math.max(r.y, winTop);
    const right = Math.min(r.x + r.width, winRight);
    const bottom = Math.min(r.y + r.height, winBottom);

    const width = right - left;
    const height = bottom - top;
    // No overlap (or a zero-area edge touch) → not part of the window's ROI.
    if (width <= 0 || height <= 0) continue;

    // Translate into window-origin-relative coordinates for the crop space.
    out.push({
      x: left - winLeft,
      y: top - winTop,
      width,
      height,
    });
  }

  return out;
}

/**
 * ADR-024 Seed-2 S5 — union bounding box of a set of rects.
 *
 * The S1 contract `RoiCapture.roi` is a **single** crop rect, but S3b yields a
 * list of window-relative dirty regions. S5 reduces them to the one rect that
 * encloses all of them (the crop the `somImage` covers + the region the
 * ROI-aware OCR runs on).
 *
 * @returns The enclosing rect, or `null` for an empty input (no ROI).
 */
export function boundingBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * ADR-024 Seed-2 S5c-1b — clamp a window-relative rect to the window bounds.
 *
 * The frame-diff ROI bbox (`VisualMotionObservation.roiBbox`) is already
 * window-relative and, by construction, lies inside the captured window (it is
 * derived from a crop that was itself clipped to the window rect). This is a
 * defence-in-depth clamp for the rare case where the window resized between the
 * pre-frame capture and the post-action `getWindowRectByHwnd` read, so the crop
 * never reads outside the buffer downstream.
 *
 * @param roi        Window-relative candidate ROI (origin = window top-left).
 * @param windowRect Screen-absolute window rect — only its `width`/`height`
 *                   bound the clamp (the ROI is already window-relative).
 * @returns The clamped window-relative rect, or `null` when the clamp leaves no
 *          positive area (ROI fully outside the current window) — the caller
 *          then falls back to the DXGI bbox / full window.
 */
export function clampRectToWindow(roi: Rect, windowRect: Rect): Rect | null {
  const left = Math.max(0, roi.x);
  const top = Math.max(0, roi.y);
  const right = Math.min(roi.x + roi.width, windowRect.width);
  const bottom = Math.min(roi.y + roi.height, windowRect.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

/**
 * ADR-024 Seed-2 S5 — intersection-over-union of two rects.
 *
 * Used to dedup the post-action ROI-OCR preview against the entities the most
 * recent `desktop_discover` already returned (OQ-10): an ROI entity whose rect
 * substantially overlaps a discover entity is "the same entity" and is dropped
 * from the preview so the act response highlights only what changed.
 *
 * @returns IoU in `[0, 1]`; `0` when the rects do not overlap.
 */
export function rectIoU(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const iw = x1 - x0;
  const ih = y1 - y0;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
