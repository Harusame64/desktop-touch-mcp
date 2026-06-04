/**
 * _roi-preview.ts — ADR-024 Seed-2 S5 — ROI-OCR → lease-less preview mapping + dedup.
 *
 * Pure helper that turns the ROI-aware OCR elements (S4 `runSomPipeline`) into
 * the `roiCapture.entities` preview, deduped against the entities the most
 * recent `desktop_discover` already returned (OQ-10).
 *
 * Dedup rule (Codex PR #429 P2): an ROI element is a duplicate ONLY when it
 * both overlaps a discover entity (IoU ≥ {@link ROI_DEDUP_IOU}) AND carries the
 * same (normalized) label. An in-place text change — a status/toggle label that
 * flips "Off"→"On" at the same bounds — has matching geometry but different
 * text, and IS the change the capture exists to surface, so it is preserved.
 *
 * Side-effect-free; native OCR + facade access stay in `desktop-register.ts`.
 */

import type { Rect } from "../engine/vision-gpu/types.js";
import type { RoiPreviewEntity } from "../engine/world-graph/guarded-touch.js";
import { rectIoU } from "./_roi-region.js";

/** Minimum IoU at which an ROI element + a discover entity are considered the
 *  same geometry for dedup. 0.5 = the two rects share more than half their union. */
export const ROI_DEDUP_IOU = 0.5;

/** Minimal structural shape of an OCR element (subset of `SomElement`). */
export interface RoiOcrElement {
  /** Merged OCR text. */
  text: string;
  /** Screen-absolute bounding rect. */
  region: Rect;
}

/** Minimal structural shape of a discover entity for dedup. */
export interface DiscoverEntityRef {
  rect: Rect;
  label: string;
}

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Map ROI-OCR elements to lease-less `RoiPreviewEntity[]`, dropping the ones
 * that duplicate a discover entity (same geometry AND same label).
 *
 * `role: "label"` + `actionability: ["click"]` mirror how the SAME OCR source
 * is represented in the discover lane (`ocr-provider.ts`), so the preview and
 * `desktop_discover` describe the same on-screen text identically. The preview
 * is lease-less regardless — the caller re-runs `desktop_discover` for an
 * actionable lease.
 */
export function buildRoiPreviewEntities(
  elements: readonly RoiOcrElement[],
  discoverEntities: readonly DiscoverEntityRef[],
): RoiPreviewEntity[] {
  return elements
    .filter(
      (el) =>
        !discoverEntities.some(
          (d) =>
            rectIoU(el.region, d.rect) >= ROI_DEDUP_IOU &&
            normalizeLabel(d.label) === normalizeLabel(el.text),
        ),
    )
    .map((el) => ({
      label: el.text,
      role: "label",
      rect: el.region,
      actionability: ["click"],
    }));
}
