import { describe, it, expect } from "vitest";
import { computeViewportPosition, computePageRatio } from "../../src/utils/viewport-position.js";

const viewport = { x: 0, y: 0, width: 1920, height: 1080 };

describe("computeViewportPosition", () => {
  it("returns in-view for element fully inside viewport", () => {
    expect(computeViewportPosition({ x: 100, y: 100, width: 200, height: 50 }, viewport)).toBe("in-view");
  });

  it("returns in-view for element center exactly at viewport center", () => {
    expect(computeViewportPosition({ x: 860, y: 515, width: 200, height: 50 }, viewport)).toBe("in-view");
  });

  it("returns above when element center is above viewport top", () => {
    expect(computeViewportPosition({ x: 100, y: -60, width: 200, height: 50 }, viewport)).toBe("above");
  });

  it("returns below when element center is below viewport bottom", () => {
    expect(computeViewportPosition({ x: 100, y: 1090, width: 200, height: 50 }, viewport)).toBe("below");
  });

  it("returns left when element center is left of viewport", () => {
    expect(computeViewportPosition({ x: -200, y: 500, width: 100, height: 50 }, viewport)).toBe("left");
  });

  it("returns right when element center is right of viewport", () => {
    expect(computeViewportPosition({ x: 2000, y: 500, width: 100, height: 50 }, viewport)).toBe("right");
  });

  it("prioritises above over left when both apply", () => {
    // center is above and to the left
    expect(computeViewportPosition({ x: -200, y: -60, width: 100, height: 50 }, viewport)).toBe("above");
  });

  it("works with non-zero viewport origin (e.g. secondary monitor)", () => {
    const vpRight = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(computeViewportPosition({ x: 2100, y: 500, width: 200, height: 50 }, vpRight)).toBe("in-view");
    expect(computeViewportPosition({ x: 100, y: 500, width: 200, height: 50 }, vpRight)).toBe("left");
  });
});

describe("computePageRatio", () => {
  it("element at top of page → 0", () => {
    expect(computePageRatio({ x: 0, y: 0, width: 100, height: 20 }, 2000)).toBeCloseTo(0.005);
  });

  it("element at exact centre of page → 0.5", () => {
    expect(computePageRatio({ x: 0, y: 990, width: 100, height: 20 }, 2000)).toBeCloseTo(0.5);
  });

  it("element at bottom of page → ~1", () => {
    const ratio = computePageRatio({ x: 0, y: 1980, width: 100, height: 20 }, 2000);
    expect(ratio).toBeGreaterThanOrEqual(0.99);
    expect(ratio).toBeLessThanOrEqual(1.0);
  });

  it("clamps below 0", () => {
    expect(computePageRatio({ x: 0, y: -100, width: 100, height: 20 }, 2000)).toBe(0);
  });

  it("clamps above 1", () => {
    expect(computePageRatio({ x: 0, y: 3000, width: 100, height: 20 }, 2000)).toBe(1);
  });

  it("returns 0 when documentHeight is 0 or negative", () => {
    expect(computePageRatio({ x: 0, y: 500, width: 100, height: 50 }, 0)).toBe(0);
    expect(computePageRatio({ x: 0, y: 500, width: 100, height: 50 }, -100)).toBe(0);
  });

  it("zero-height element uses y as the reference point", () => {
    const ratio = computePageRatio({ x: 0, y: 1000, width: 100, height: 0 }, 2000);
    expect(ratio).toBeCloseTo(0.5);
  });

  it("unused viewport param — function signature is (rect, documentHeight)", () => {
    // Verify the function signature doesn't include viewportRect as a required arg
    const ratio = computePageRatio({ x: 0, y: 500, width: 100, height: 0 }, 1000);
    expect(ratio).toBeCloseTo(0.5);
  });
});
