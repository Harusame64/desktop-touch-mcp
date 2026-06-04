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

import { filterDirtyRectsToWindow } from "../../src/tools/_roi-region.js";

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
