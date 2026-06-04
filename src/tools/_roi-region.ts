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
