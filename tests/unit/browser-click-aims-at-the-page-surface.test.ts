/**
 * ADR-040 PR ① — browser_click's point comes from the page surface (the frame's page window), not from
 * the page-side formula (#306: +278 px with DevTools docked right). The surface is read before the window
 * is brought forward (so the reachability check still runs first, ADR-029) and again after it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointOwner } from "../../src/engine/point-owner.js";
import type { PageSurface } from "../../src/engine/page-surface.js";

const mocks = vi.hoisted(() => ({
  moved: [] as Array<{ x: number; y: number }>,
  reached: [] as Array<{ x: number; y: number }>,
  windows: [] as unknown[],
}));

vi.mock("../../src/engine/window-cache.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/window-cache.js")>()),
  updateWindowCache: () => {},
}));
vi.mock("../../src/engine/nutjs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/nutjs.js")>()),
  mouse: { click: vi.fn(async () => {}), config: {} },
}));
vi.mock("../../src/engine/cursor.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cursor.js")>()),
  moveCursorTo: vi.fn(async (x: number, y: number) => { mocks.moved.push({ x, y }); }),
}));
vi.mock("../../src/engine/reachable-bounds.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/reachable-bounds.js")>()),
  assertCoordinateReachable: (x: number, y: number) => { mocks.reached.push({ x, y }); },
}));
vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  listTabs: vi.fn(async () => [{ id: "TAB", type: "page", title: "K306", url: "http://127.0.0.1/k306" }]),
  evaluateInTab: vi.fn(async () => { throw new Error("no CDP in this cell"); }),
  getTabWindowBounds: vi.fn(async () => { throw new Error("no bounds in this cell"); }),
  getBrowserProcessId: vi.fn(async () => { throw new Error("no pid in this cell"); }),
  bringTabToFront: vi.fn(async () => { throw new Error("no raise in this cell"); }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => mocks.windows,
  restoreAndFocusWindow: () => {},
}));

const { osClickAndVerify } = await import("../../src/tools/browser.js");
const { PAGE_RWH_CLASS } = await import("../../src/engine/page-surface.js");

const FRAME = 7001n;
// The browser window the fallback title search finds (ensureBrowserFocused returns it).
mocks.windows = [{ hwnd: FRAME, title: "K306 - Google Chrome", isActive: true, className: "Chrome_WidgetWin_1", region: { x: 100, y: 100, width: 1200, height: 800 }, zOrder: 0 }];
const AIM: PointOwner = { kind: "aim", via: "os_hit_test" };
const PAGE_AIM = { viewportX: 380, viewportY: 20, hint: { width: 629, height: 705 } };
const SURFACE: PageSurface = { kind: "surface", frame: FRAME, rwh: 855176n, rect: { x: 108, y: 187, width: 629, height: 705 } };

afterEach(() => {
  mocks.moved.length = 0;
  mocks.reached.length = 0;
});

function deps(script: Array<{ point: { x: number; y: number }; surface: PageSurface | null }>, child?: bigint, cls = PAGE_RWH_CLASS) {
  let i = 0;
  return {
    findFrame: vi.fn(async () => FRAME),
    align: vi.fn(() => script[Math.min(i++, script.length - 1)]!),
    childAt: () => child,
    classOf: () => cls,
  };
}

describe("osClickAndVerify places the point on the page surface (ADR-040 PR ①)", () => {
  it("clicks at the surface's point, checked for reach before the window is focused (the #306 cell)", async () => {
    const d = deps([{ point: { x: 488, y: 207 }, surface: SURFACE }]);
    await osClickAndVerify(766, 207, null, "TAB", 9222, () => AIM, false, PAGE_AIM, d as never);
    expect(mocks.reached[0]).toEqual({ x: 488, y: 207 });
    expect(mocks.moved).toEqual([{ x: 488, y: 207 }]);
  });

  it("a covered window: the formula's point is checked first, the surface read again after the raise", async () => {
    const notShown: PageSurface = { kind: "not_shown", frame: FRAME, why: "no_page_window" };
    const d = deps([
      { point: { x: 766, y: 207 }, surface: notShown }, // before the raise
      { point: { x: 766, y: 207 }, surface: notShown }, // just after: the page window not there yet
      { point: { x: 488, y: 207 }, surface: SURFACE },
    ]);
    await osClickAndVerify(766, 207, null, "TAB", 9222, () => AIM, false, PAGE_AIM, d as never);
    expect(mocks.reached).toEqual([{ x: 766, y: 207 }, { x: 488, y: 207 }]);
    expect(mocks.moved).toEqual([{ x: 488, y: 207 }]);
  });

  it("refuses when another page window of the frame (DevTools) is under the point, and does not move the cursor", async () => {
    const d = deps([{ point: { x: 488, y: 207 }, surface: SURFACE }], 1641660n);
    const r = await osClickAndVerify(766, 207, null, "TAB", 9222, () => AIM, false, PAGE_AIM, d as never);
    expect(r).toEqual({ covered: "panel", hwnd: 1641660n });
    expect(mocks.moved).toEqual([]);
  });

  it("another child class under the point says nothing either way: it clicks", async () => {
    const d = deps([{ point: { x: 488, y: 207 }, surface: SURFACE }], 99n, "Intermediate D3D Window");
    await osClickAndVerify(766, 207, null, "TAB", 9222, () => AIM, false, PAGE_AIM, d as never);
    expect(mocks.moved).toEqual([{ x: 488, y: 207 }]);
  });

  it("an unreadable surface keeps the caller's point (invariant 3)", async () => {
    const d = deps([{ point: { x: 766, y: 207 }, surface: { kind: "unreadable", frame: FRAME, why: "ambiguous" } }]);
    await osClickAndVerify(766, 207, null, "TAB", 9222, () => AIM, false, PAGE_AIM, d as never);
    expect(mocks.moved).toEqual([{ x: 766, y: 207 }]);
  });

  it("without an aim, the caller's point, as before (control)", async () => {
    const d = deps([{ point: { x: 1, y: 1 }, surface: SURFACE }]);
    await osClickAndVerify(766, 207, null, "TAB", 9222, () => AIM, false, undefined, d as never);
    expect(d.findFrame).not.toHaveBeenCalled();
    expect(mocks.moved).toEqual([{ x: 766, y: 207 }]);
  });
});
