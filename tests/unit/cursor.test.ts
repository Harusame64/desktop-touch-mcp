import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// ── moveCursorTo: the branches that decide what actually reaches the OS ──────
//
// The native bindings and the monitor layout are injected, so these run without
// an addon or a desktop. What is pinned here is the behaviour the ADR turns on:
// a failed placement must NOT silently fall back to nut.js (that library clamps
// into the primary monitor, which is the bug), and the two message variants must
// both be reachable.

// `vi.mock` factories are hoisted above ordinary declarations, so the doubles
// they close over have to be created in a hoisted block too.
const h = vi.hoisted(() => ({
  native: {
    win32MoveCursorAbsolute: vi.fn(),
    win32MoveCursorPath: vi.fn(),
    win32GetCursorPos: vi.fn(() => ({ x: 0, y: 0 })),
  },
  nut: { setPosition: vi.fn(), move: vi.fn(), config: { mouseSpeed: 3000 } },
  state: {
    nativeAvailable: true,
    monitors: [{ x: 0, y: 0, width: 1920, height: 1080 }] as {
      x: number;
      y: number;
      width: number;
      height: number;
    }[],
  },
}));
const nativeMock = h.native;
const nutMock = h.nut;

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: h.native,
  hasNativeCursorMove: () => h.state.nativeAvailable,
}));
vi.mock("../../src/engine/win32.js", () => ({
  enumMonitors: () => h.state.monitors.map((bounds) => ({ primary: true, bounds })),
  getPrimaryMonitorBounds: () => h.state.monitors[0] ?? null,
}));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: h.nut,
  Point: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  straightTo: (p: unknown) => p,
  DEFAULT_MOUSE_SPEED: 3000,
}));

const ok = (x: number, y: number) => ({ ok: true, method: "set_cursor_pos", finalX: x, finalY: y });
const blocked = (x: number, y: number, method = "failed") => ({ ok: false, method, finalX: x, finalY: y });

describe("moveCursorTo", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.state.nativeAvailable = true;
    h.state.monitors = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    nativeMock.win32GetCursorPos.mockReturnValue({ x: 0, y: 0 });
    const { _resetReachableRegionCacheForTests } = await import("../../src/engine/reachable-bounds.js");
    _resetReachableRegionCacheForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("teleports through the native binding and leaves nut.js alone", async () => {
    nativeMock.win32MoveCursorAbsolute.mockReturnValue(ok(400, 300));
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    await moveCursorTo(400, 300, 0);
    expect(nativeMock.win32MoveCursorAbsolute).toHaveBeenCalledWith(400, 300);
    expect(nutMock.setPosition).not.toHaveBeenCalled();
    expect(nutMock.move).not.toHaveBeenCalled();
  });

  it("throws instead of retrying through nut.js when the placement fails", async () => {
    // Falling back here would clamp the point into the primary monitor and
    // click the wrong thing — the exact failure this ADR removes.
    nativeMock.win32MoveCursorAbsolute.mockReturnValue(blocked(0, 0));
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    await expect(moveCursorTo(400, 300, 0)).rejects.toMatchObject({ name: "CursorPlacementBlocked" });
    expect(nutMock.setPosition).not.toHaveBeenCalled();
  });

  it("reports a blocked placement as being on a monitor when the layout is known", async () => {
    nativeMock.win32MoveCursorAbsolute.mockReturnValue(blocked(0, 0));
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    const err = await moveCursorTo(400, 300, 0).catch((e: Error) => e);
    expect((err as Error).message).toContain("which is on a connected monitor");
  });

  it("says the layout could not be read when it could not — variant B is not dead code", async () => {
    // Monitor enumeration failing means the guard let the point through
    // unchecked, so the message must not claim it is on a monitor: it may be
    // stale, and the recovery differs.
    h.state.monitors = [];
    nativeMock.win32MoveCursorAbsolute.mockReturnValue(blocked(0, 0));
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    const err = await moveCursorTo(400, 300, 0).catch((e: Error) => e);
    expect((err as Error).message).toContain("the monitor layout could not be read");
    expect((err as Error).message).not.toContain("which is on a connected monitor");
  });

  it("turns an unreadable cursor position into the typed error, not a raw one", async () => {
    // GetCursorPos fails when the session has no input desktop. Escaping as a
    // bare Error would be folded into executor_failed, whose advice loops back.
    nativeMock.win32GetCursorPos.mockImplementation(() => {
      throw new Error("GetCursorPos failed");
    });
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    await expect(moveCursorTo(400, 300, 3000)).rejects.toMatchObject({ name: "CursorPlacementBlocked" });
  });

  it("uses nut.js when the native path is absent, and keeps the primary-monitor guard", async () => {
    h.state.nativeAvailable = false;
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    await moveCursorTo(400, 300, 0);
    expect(nutMock.setPosition).toHaveBeenCalled();
    expect(nativeMock.win32MoveCursorAbsolute).not.toHaveBeenCalled();
    await expect(moveCursorTo(-1500, 300, 0)).rejects.toMatchObject({
      name: "CoordinateOutsideReachableBounds",
    });
  });

  it("animates through the batch binding and verifies only the final segment", async () => {
    nativeMock.win32MoveCursorPath.mockImplementation((pts: CursorPoint[]) => ok(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y));
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    await moveCursorTo(200, 0, 100_000); // fast: few ticks, no real waiting
    const calls = nativeMock.win32MoveCursorPath.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.slice(0, -1).every((c) => c[1] === false)).toBe(true);
    expect(calls[calls.length - 1]![1]).toBe(true);
    const last = calls[calls.length - 1]![0] as CursorPoint[];
    expect(last[last.length - 1]).toEqual({ x: 200, y: 0 });
  });

  it("honours a slow speed instead of flooring it at one point per tick", async () => {
    // Pacing derived from the tick index (rather than the distance emitted)
    // silently ran slow speeds at ~125px/s. 40px at 200px/s ≈ 200ms.
    nativeMock.win32MoveCursorPath.mockImplementation((pts: CursorPoint[]) => ok(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y));
    const { moveCursorTo } = await import("../../src/engine/cursor.js");
    const started = Date.now();
    await moveCursorTo(40, 0, 200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(120);
    expect(elapsed).toBeLessThan(600);
  });
});
