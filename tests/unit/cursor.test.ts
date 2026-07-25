import { describe, it, expect } from "vitest";
import { planCursorPath, type CursorPoint } from "../../src/engine/cursor.js";
import type { ReachableRegion } from "../../src/engine/reachable-bounds.js";

// ADR-029 Phase 2a — the interpolation the native cursor path walks.
//
// `moveCursorTo` itself needs the native addon and a real desktop, so it is
// exercised by the E2E suite; what is pinned here is the pure planning that
// decides which points ever reach the OS.

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 };

const region = (...monitors: typeof PRIMARY[]): ReachableRegion => ({
  kind: "monitors",
  monitors,
});

const dist = (a: CursorPoint, b: CursorPoint) => Math.hypot(b.x - a.x, b.y - a.y);

describe("planCursorPath", () => {
  it("ends exactly on the destination — an animated move must land where a teleport would", () => {
    const path = planCursorPath({ x: 10, y: 10 }, { x: 907, y: 433 }, region(PRIMARY));
    expect(path[path.length - 1]).toEqual({ x: 907, y: 433 });
  });

  it("steps by a pixel, so applications watching the pointer stream see the whole gesture", () => {
    const path = planCursorPath({ x: 0, y: 0 }, { x: 100, y: 100 }, region(PRIMARY));
    const hops = path.map((p, i) => (i === 0 ? 0 : dist(path[i - 1]!, p)));
    expect(Math.max(...hops)).toBeLessThanOrEqual(2); // one diagonal pixel ≈ 1.41
    // One point per pixel along the diagonal. The planner walks 142 steps
    // (the euclidean distance) but consecutive steps round onto the same pixel
    // on a 45° line, and emitting the same position twice would be noise, so
    // duplicates are dropped — 100 distinct positions is the whole line.
    expect(path.length).toBe(100);
  });

  it("emits a single point when the destination is where the cursor already is", () => {
    expect(planCursorPath({ x: 5, y: 5 }, { x: 5, y: 5 }, region(PRIMARY))).toEqual([{ x: 5, y: 5 }]);
  });

  it("crosses onto a monitor left of the primary one", () => {
    const path = planCursorPath({ x: 100, y: 400 }, { x: -1500, y: 300 }, region(PRIMARY, LEFT));
    expect(path[path.length - 1]).toEqual({ x: -1500, y: 300 });
    // Monotone in x: no backtracking into the primary monitor on the way.
    for (let i = 1; i < path.length; i++) expect(path[i]!.x).toBeLessThanOrEqual(path[i - 1]!.x);
  });

  // The reason bounds are tested per monitor rather than against the virtual
  // screen's bounding box: a straight line across a staggered layout passes
  // through space that belongs to no monitor, and Windows pulls each such point
  // onto the nearest one — real cursor positions the caller never asked for,
  // and with a button held, real dragover / drop-target events there.
  it("never emits a point that lies in the gap of a staggered layout", () => {
    const BOTTOM_RIGHT = { x: 1920, y: 1080, width: 1920, height: 1080 };
    const r = region(PRIMARY, BOTTOM_RIGHT);
    const path = planCursorPath({ x: 100, y: 100 }, { x: 3000, y: 1900 }, r);

    const inSomeMonitor = (p: CursorPoint) =>
      [PRIMARY, BOTTOM_RIGHT].some(
        (m) => p.x >= m.x && p.x < m.x + m.width && p.y >= m.y && p.y < m.y + m.height,
      );
    const strays = path.filter((p) => !inSomeMonitor(p));
    expect(strays).toEqual([]);
    // The jump across the gap is still made — the destination is reached.
    expect(path[path.length - 1]).toEqual({ x: 3000, y: 1900 });
  });

  it("keeps every point when the layout is unknown — an unreadable layout must not stop the move", () => {
    const path = planCursorPath({ x: 0, y: 0 }, { x: 50, y: 0 }, null);
    expect(path.length).toBe(50);
    expect(path[path.length - 1]).toEqual({ x: 50, y: 0 });
  });
});
