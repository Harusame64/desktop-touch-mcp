import { describe, it, expect } from "vitest";
import { computeViewportPosition } from "../../src/utils/viewport-position.js";

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
