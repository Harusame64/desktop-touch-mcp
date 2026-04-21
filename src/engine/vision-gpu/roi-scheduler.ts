import type { Rect } from "./types.js";

export interface RoiScheduleInput {
  dirtyRects: Rect[];
  nowMs: number;
  lastScheduledMs?: number;
}

export interface RoiScheduleOutput {
  rois: Rect[];
  skipped: number;
  /**
   * "skip"      — no dirty rects; nothing to do this tick.
   * "tracking"  — inside debounce or cooldown window; rois computed but no inference.
   * "recognize" — rois are ready for detector/recognizer dispatch.
   *
   * Intentionally distinct from the runtime 4-state machine (Idle/Armed/Engaged/Recover)
   * to avoid naming collisions.
   */
  mode: "skip" | "tracking" | "recognize";
}

export interface RoiSchedulerOptions {
  /** Pixel expansion applied to each dirty rect before merge (default: 16). */
  expandPx?: number;
  /** Minimum ms between scheduling decisions (default: 50). */
  debounceMs?: number;
  /** ms window after a recognize pass during which only tracking mode runs (default: 200). */
  cooldownMs?: number;
}

function expandRect(r: Rect, px: number): Rect {
  return { x: r.x - px, y: r.y - px, width: r.width + px * 2, height: r.height + px * 2 };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

function mergeTwo(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Single-pass O(n²) merge. Transitively-overlapping rects may not fully merge
 * in one pass (e.g., A–C–B where A and B don't directly intersect but both do
 * with C). This is acceptable for PoC because Desktop Duplication dirty rects
 * are typically disjoint axis-aligned tiles. Add a fixed-point loop if
 * pathological comb patterns appear in practice.
 */
function mergeOverlapping(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    let absorbed = false;
    for (let i = 0; i < out.length; i++) {
      if (intersects(out[i], r)) {
        out[i] = mergeTwo(out[i], r);
        absorbed = true;
        break;
      }
    }
    if (!absorbed) out.push({ ...r });
  }
  return out;
}

export function scheduleRois(
  input: RoiScheduleInput,
  opts: RoiSchedulerOptions = {}
): RoiScheduleOutput {
  const expandPx = opts.expandPx ?? 16;
  const debounceMs = opts.debounceMs ?? 50;
  const cooldownMs = opts.cooldownMs ?? 200;

  if (input.dirtyRects.length === 0) {
    return { rois: [], skipped: 0, mode: "skip" };
  }

  if (input.lastScheduledMs !== undefined) {
    const gap = input.nowMs - input.lastScheduledMs;
    if (gap < debounceMs) {
      return { rois: [], skipped: input.dirtyRects.length, mode: "tracking" };
    }
    if (gap < cooldownMs) {
      const rois = mergeOverlapping(input.dirtyRects.map((r) => expandRect(r, expandPx)));
      return { rois, skipped: 0, mode: "tracking" };
    }
  }

  const rois = mergeOverlapping(input.dirtyRects.map((r) => expandRect(r, expandPx)));
  return { rois, skipped: 0, mode: "recognize" };
}
