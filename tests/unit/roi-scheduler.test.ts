import { describe, it, expect } from "vitest";
import { scheduleRois } from "../../src/engine/vision-gpu/roi-scheduler.js";
import type { Rect } from "../../src/engine/vision-gpu/types.js";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });

describe("scheduleRois", () => {
  it("returns skip when no dirty rects", () => {
    const out = scheduleRois({ dirtyRects: [], nowMs: 1000 });
    expect(out.mode).toBe("skip");
    expect(out.rois).toHaveLength(0);
    expect(out.skipped).toBe(0);
  });

  it("returns recognize with expanded rois on first call (no lastScheduledMs)", () => {
    const out = scheduleRois({ dirtyRects: [R(10, 10, 20, 20)], nowMs: 1000 }, { expandPx: 8 });
    expect(out.mode).toBe("recognize");
    expect(out.rois).toHaveLength(1);
    expect(out.rois[0]).toEqual({ x: 2, y: 2, width: 36, height: 36 });
  });

  it("returns tracking with skipped rects when inside debounce window", () => {
    const out = scheduleRois(
      { dirtyRects: [R(0, 0, 10, 10), R(100, 100, 10, 10)], nowMs: 1030, lastScheduledMs: 1000 },
      { debounceMs: 50 }
    );
    expect(out.mode).toBe("tracking");
    expect(out.skipped).toBe(2);
    expect(out.rois).toHaveLength(0);
  });

  it("returns tracking (not recognize) inside cooldown window", () => {
    const out = scheduleRois(
      { dirtyRects: [R(0, 0, 10, 10)], nowMs: 1100, lastScheduledMs: 1000 },
      { debounceMs: 50, cooldownMs: 200 }
    );
    expect(out.mode).toBe("tracking");
    expect(out.skipped).toBe(0);
    expect(out.rois).toHaveLength(1);
  });

  it("returns recognize after cooldown has passed", () => {
    const out = scheduleRois(
      { dirtyRects: [R(0, 0, 10, 10)], nowMs: 1300, lastScheduledMs: 1000 },
      { debounceMs: 50, cooldownMs: 200 }
    );
    expect(out.mode).toBe("recognize");
  });

  it("merges overlapping dirty rects into one roi", () => {
    const out = scheduleRois(
      { dirtyRects: [R(0, 0, 30, 30), R(10, 10, 30, 30)], nowMs: 1000 },
      { expandPx: 0 }
    );
    expect(out.rois).toHaveLength(1);
    expect(out.rois[0]).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("keeps non-overlapping dirty rects as separate rois after expansion", () => {
    const out = scheduleRois(
      { dirtyRects: [R(0, 0, 10, 10), R(200, 200, 10, 10)], nowMs: 1000 },
      { expandPx: 0 }
    );
    expect(out.rois).toHaveLength(2);
  });

  it("full-frame fallback is not in the normal path — recognize mode does not return a single large roi covering everything", () => {
    const out = scheduleRois(
      { dirtyRects: [R(50, 50, 10, 10)], nowMs: 1000 },
      { expandPx: 8 }
    );
    // roi should be local to the dirty rect, not a full-frame rect
    expect(out.rois[0].width).toBeLessThan(200);
    expect(out.rois[0].height).toBeLessThan(200);
  });
});
