/**
 * ADR-024 Seed-2 S3b — `filterDirtyRectsToWindow` unit tests (OQ-11c).
 *
 * Pins the per-output→window coordinate/sign conversion (sub-plan §2 S3b
 * review axis): screen-absolute dirty rects intersected with the target
 * window rect, out-of-window dirty excluded, survivors translated to
 * window-relative coordinates. The window origin is intentionally non-zero in
 * most cases so a missing `- windowRect.x/y` translation (or a wrong sign)
 * fails loudly.
 */

import { describe, it, expect } from "vitest";

import {
  filterDirtyRectsToWindow,
  boundingBox,
  rectIoU,
} from "../../src/tools/_roi-region.js";

// Window at a non-zero screen origin so the relative translation is observable.
const WINDOW = { x: 100, y: 200, width: 800, height: 600 };

describe("filterDirtyRectsToWindow (S3b window-rect filter)", () => {
  it("fully-inside rect → translated to window-relative coordinates", () => {
    // Screen-abs (150, 260) inside the window at origin (100, 200) →
    // relative (50, 60).
    const out = filterDirtyRectsToWindow(
      [{ x: 150, y: 260, width: 40, height: 30 }],
      WINDOW,
    );
    expect(out).toEqual([{ x: 50, y: 60, width: 40, height: 30 }]);
  });

  it("rect entirely outside the window → excluded", () => {
    // On the same monitor but past the window's right/bottom edges (e.g. a
    // notification toast or another window).
    const out = filterDirtyRectsToWindow(
      [{ x: 1000, y: 900, width: 50, height: 50 }],
      WINDOW,
    );
    expect(out).toEqual([]);
  });

  it("rect partially overlapping the top-left corner → clipped then relative", () => {
    // Screen-abs rect straddles the window's top-left corner (origin 100,200).
    // It spans x:[80,160] y:[180,260]; clipped to the window that's
    // x:[100,160] y:[200,260] → relative x:[0,60] y:[0,60] → (0,0,60,60).
    const out = filterDirtyRectsToWindow(
      [{ x: 80, y: 180, width: 80, height: 80 }],
      WINDOW,
    );
    expect(out).toEqual([{ x: 0, y: 0, width: 60, height: 60 }]);
  });

  it("rect partially overlapping the bottom-right corner → clipped to window edge", () => {
    // Window right edge = 100+800 = 900, bottom = 200+600 = 800. A rect at
    // screen (870, 770, 80, 80) spans to (950, 850); clipped to (870..900,
    // 770..800) = 30x30 → relative (770, 570, 30, 30).
    const out = filterDirtyRectsToWindow(
      [{ x: 870, y: 770, width: 80, height: 80 }],
      WINDOW,
    );
    expect(out).toEqual([{ x: 770, y: 570, width: 30, height: 30 }]);
  });

  it("mixed batch → keeps only window-overlapping rects, each made relative", () => {
    const inside = { x: 150, y: 260, width: 40, height: 30 }; // → (50,60,40,30)
    const outside = { x: 1000, y: 900, width: 50, height: 50 }; // excluded
    const corner = { x: 80, y: 180, width: 80, height: 80 }; // → (0,0,60,60)
    const out = filterDirtyRectsToWindow([inside, outside, corner], WINDOW);
    expect(out).toEqual([
      { x: 50, y: 60, width: 40, height: 30 },
      { x: 0, y: 0, width: 60, height: 60 },
    ]);
  });

  it("empty input → empty output (roiCapture absent fallback, acceptance ③)", () => {
    expect(filterDirtyRectsToWindow([], WINDOW)).toEqual([]);
  });

  it("zero-area edge touch (shares only the right border) → excluded", () => {
    // Rect's left edge sits exactly on the window's right edge (x=900) → width
    // clips to 0 → not an ROI.
    const out = filterDirtyRectsToWindow(
      [{ x: 900, y: 300, width: 40, height: 40 }],
      WINDOW,
    );
    expect(out).toEqual([]);
  });

  it("window at origin (0,0) → relative == absolute (no translation artifact)", () => {
    const out = filterDirtyRectsToWindow(
      [{ x: 10, y: 20, width: 30, height: 40 }],
      { x: 0, y: 0, width: 800, height: 600 },
    );
    expect(out).toEqual([{ x: 10, y: 20, width: 30, height: 40 }]);
  });

  it("rect exactly equal to the window → full-window relative ROI", () => {
    const out = filterDirtyRectsToWindow([{ ...WINDOW }], WINDOW);
    expect(out).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);
  });

  it("secondary monitor (negative window origin) → sign-safe window-relative output", () => {
    // Monitor to the left of the primary: window at screen-abs x=-1920. A
    // dirty rect on that monitor at screen-abs (-1900, 50) must map to
    // window-relative (-1900 - -1920, 50 - 0) = (20, 50). Pins the PR #102 /
    // §3.2 secondary-monitor axis (subtraction must stay sign-safe).
    const secondary = { x: -1920, y: 0, width: 800, height: 600 };
    const onSecondary = { x: -1900, y: 50, width: 40, height: 30 };
    const onPrimary = { x: 200, y: 300, width: 40, height: 30 }; // other monitor → excluded
    const out = filterDirtyRectsToWindow([onSecondary, onPrimary], secondary);
    expect(out).toEqual([{ x: 20, y: 50, width: 40, height: 30 }]);
  });

  it("dirty rect fully containing the window → clipped down to the full window", () => {
    // A monitor-wide repaint (rect strictly larger than the window on every
    // side) clips to exactly the window → full-window relative ROI.
    const out = filterDirtyRectsToWindow(
      [{ x: -50, y: -50, width: 5000, height: 5000 }],
      WINDOW,
    );
    expect(out).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);
  });

  it("does not mutate or alias the input rects", () => {
    const input = { x: 150, y: 260, width: 40, height: 30 };
    const out = filterDirtyRectsToWindow([input], WINDOW);
    expect(out[0]).not.toBe(input);
    expect(input).toEqual({ x: 150, y: 260, width: 40, height: 30 });
  });
});

describe("boundingBox (S5 ROI union)", () => {
  it("returns null for an empty input", () => {
    expect(boundingBox([])).toBeNull();
  });

  it("returns the same rect for a single input", () => {
    expect(boundingBox([{ x: 10, y: 20, width: 30, height: 40 }])).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it("encloses several disjoint rects", () => {
    // (10,10)-(20,20) and (50,40)-(80,100) → enclosing (10,10)-(80,100).
    const out = boundingBox([
      { x: 10, y: 10, width: 10, height: 10 },
      { x: 50, y: 40, width: 30, height: 60 },
    ]);
    expect(out).toEqual({ x: 10, y: 10, width: 70, height: 90 });
  });

  it("encloses overlapping rects (union, not intersection)", () => {
    const out = boundingBox([
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 30, y: 30, width: 50, height: 50 },
    ]);
    expect(out).toEqual({ x: 0, y: 0, width: 80, height: 80 });
  });

  it("handles negative coordinates (secondary monitor space)", () => {
    const out = boundingBox([
      { x: -100, y: -50, width: 20, height: 20 },
      { x: -40, y: 10, width: 30, height: 30 },
    ]);
    expect(out).toEqual({ x: -100, y: -50, width: 90, height: 90 });
  });
});

describe("rectIoU (S5 OQ-10 dedup metric)", () => {
  it("is 1 for identical rects", () => {
    const r = { x: 5, y: 5, width: 10, height: 10 };
    expect(rectIoU(r, { ...r })).toBe(1);
  });

  it("is 0 for non-overlapping rects", () => {
    expect(
      rectIoU({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }),
    ).toBe(0);
  });

  it("is 0 for a zero-area edge touch", () => {
    // Share only the right edge (x=10) → no area overlap.
    expect(
      rectIoU({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    ).toBe(0);
  });

  it("computes a partial overlap ratio", () => {
    // Two 10x10 rects offset by (5,0): intersection 5x10=50, union 200-50=150 → 1/3.
    expect(
      rectIoU({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }),
    ).toBeCloseTo(50 / 150, 6);
  });

  it("a half-contained quarter-overlap clears/misses the 0.5 dedup gate as expected", () => {
    // 25% area overlap → IoU = 25/(100+100-25) = 25/175 ≈ 0.143 < 0.5 (kept).
    const iou = rectIoU(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    );
    expect(iou).toBeCloseTo(25 / 175, 6);
    expect(iou).toBeLessThan(0.5);
  });
});
