import { describe, it, expect } from "vitest";
import {
  assertCoordinateReachable,
  isCoordinateReachable,
} from "../../src/engine/reachable-bounds.js";

// ADR-029 Phase 1 — nut.js clamps any point outside the primary monitor into it,
// so the guard has to refuse such points before the cursor moves.

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };

describe("reachable-bounds guard", () => {
  it("accepts points inside the reachable region, including its top-left corner", () => {
    expect(isCoordinateReachable(0, 0, PRIMARY)).toBe(true);
    expect(isCoordinateReachable(960, 540, PRIMARY)).toBe(true);
    expect(isCoordinateReachable(1919, 1079, PRIMARY)).toBe(true);
  });

  it("rejects points past the right / bottom edge (half-open interval)", () => {
    expect(isCoordinateReachable(1920, 540, PRIMARY)).toBe(false);
    expect(isCoordinateReachable(960, 1080, PRIMARY)).toBe(false);
  });

  it("rejects negative coordinates — the monitor-to-the-left case", () => {
    expect(isCoordinateReachable(-200, 400, PRIMARY)).toBe(false);
    expect(isCoordinateReachable(400, -50, PRIMARY)).toBe(false);
  });

  it("throws a typed error naming the coordinate and the reachable area", () => {
    let thrown: unknown;
    try {
      assertCoordinateReachable(-1500, 300, PRIMARY);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.name).toBe("CoordinateOutsideReachableBounds");
    expect(err.message).toContain("(-1500, 300)");
    expect(err.message).toContain("1920x1080");
  });

  it("does not throw for a reachable coordinate", () => {
    expect(() => assertCoordinateReachable(10, 10, PRIMARY)).not.toThrow();
  });

  // A machine whose monitor enumeration fails must stay usable: an unknown
  // region means "cannot judge", not "block everything".
  it("allows any coordinate when the reachable region is unknown", () => {
    expect(isCoordinateReachable(-5000, -5000, null)).toBe(true);
    expect(() => assertCoordinateReachable(-5000, -5000, null)).not.toThrow();
  });
});
