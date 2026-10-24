/**
 * internal #305 — browser_click finds the tab's browser window by the window's bounds, not its title.
 *
 * By title, two windows showing tabs with the same title were the same window to `ensureBrowserFocused`:
 * the first in z-order was brought forward, and the covered-point check (#834) was asked about it. When
 * the windows overlap, the OS click could go into the other window's page.
 *
 * MEASURED win2 (2026-10-24, Chrome, one process, two windows each with a "K835-PAGE" tab): CDP
 * `Browser.getWindowForTarget` bounds × devicePixelRatio equal the frame's GetWindowRect (the
 * enumeration's region) exactly for normal windows at 100 % and 150 %, and within 2 px for a maximized
 * window at 150 %. The cells below use those numbers. The scale is the frame's monitor's, never the
 * tab's devicePixelRatio, which includes the page zoom (codex on #837).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointOwner } from "../../src/engine/point-owner.js";

type W = { hwnd: bigint; title: string; isActive: boolean; className?: string; region: { x: number; y: number; width: number; height: number }; zOrder: number };
const frame = (hwnd: bigint, region: W["region"], isActive = false, zOrder = 0): W =>
  ({ hwnd, title: "K835-PAGE - Google Chrome", isActive, className: "Chrome_WidgetWin_1", region, zOrder });

const mocks = vi.hoisted(() => ({
  windows: [] as unknown[],
  focused: [] as bigint[],
  bounds: undefined as undefined | { left: number; top: number; width: number; height: number },
  dpi: new Map<bigint, number>(),
  boundsAskedFor: [] as Array<string | null>,
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
  moveCursorTo: vi.fn(async () => {}),
}));
vi.mock("../../src/engine/reachable-bounds.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/reachable-bounds.js")>()),
  assertCoordinateReachable: () => {},
}));
vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  listTabs: vi.fn(async () => [
    { id: "EB77BA", type: "page", title: "K835-PAGE", url: "http://127.0.0.1/k835" },
    { id: "B7AE2D", type: "page", title: "K835-PAGE", url: "http://127.0.0.1/k835" },
  ]),
  evaluateInTab: vi.fn(async () => { throw new Error("no CDP in this cell"); }),
  getTabWindowBounds: vi.fn(async (tabId: string | null) => {
    mocks.boundsAskedFor.push(tabId);
    if (!mocks.bounds) throw new Error("Browser.getWindowForTarget failed");
    return mocks.bounds;
  }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => mocks.windows,
  restoreAndFocusWindow: (h: bigint) => { mocks.focused.push(h); },
  getWindowDpi: (h: bigint) => mocks.dpi.get(h) ?? 96,
}));

const { osClickAndVerify, frameForWindowBounds } = await import("../../src/tools/browser.js");

afterEach(() => {
  mocks.focused.length = 0;
  mocks.boundsAskedFor.length = 0;
  mocks.bounds = undefined;
  mocks.dpi.clear();
});

// win2's side-by-side cell at 100 %: the left window is first in z-order.
const LEFT = frame(1001n, { x: 0, y: 50, width: 940, height: 700 }, true, 0);
const RIGHT = frame(1002n, { x: 960, y: 50, width: 940, height: 700 }, false, 1);
const AIM: PointOwner = { kind: "aim", via: "os_hit_test" };

describe("frameForWindowBounds — win2's measured cells", () => {
  it("normal windows side by side at 100 %: the bounds pick the right one, not the first", () => {
    expect(frameForWindowBounds([LEFT, RIGHT], { left: 960, top: 50, width: 940, height: 700 }, () => 1)).toBe(RIGHT);
    expect(frameForWindowBounds([LEFT, RIGHT], { left: 0, top: 50, width: 940, height: 700 }, () => 1)).toBe(LEFT);
  });

  it("normal window at 150 %: DIP bounds × 1.5 are the physical rect", () => {
    const w = frame(2001n, { x: 960, y: 60, width: 930, height: 750 });
    const other = frame(2002n, { x: 0, y: 60, width: 930, height: 750 });
    expect(frameForWindowBounds([other, w], { left: 640, top: 40, width: 620, height: 500 }, () => 1.5)).toBe(w);
  });

  it("maximized at 100 % and 150 %: GetWindowRect within 2 px", () => {
    const max100 = frame(3001n, { x: -8, y: -8, width: 1936, height: 1048 });
    expect(frameForWindowBounds([max100], { left: -8, top: -8, width: 1936, height: 1048 }, () => 1)).toBe(max100);
    const max150 = frame(3002n, { x: -11, y: -11, width: 1942, height: 1030 });
    expect(frameForWindowBounds([max150], { left: -7, top: -7, width: 1296, height: 688 }, () => 1.5)).toBe(max150);
  });

  it("no frame at the bounds, or two at the same rect: no answer, so the caller falls back", () => {
    expect(frameForWindowBounds([LEFT, RIGHT], { left: 400, top: 300, width: 800, height: 600 }, () => 1)).toBeUndefined();
    const twin = frame(1003n, { ...RIGHT.region });
    expect(frameForWindowBounds([LEFT, RIGHT, twin], { left: 960, top: 50, width: 940, height: 700 }, () => 1)).toBeUndefined();
  });

  it("page zoom does not scale the bounds: a zoomed tab's window never matches a bigger frame (codex on #837)", () => {
    // 100 % display, tab zoomed to 125 %: devicePixelRatio would be 1.25, and 800×600 DIPs × 1.25
    // is exactly the other window's 1000×750. The monitor's scale is 1.
    const target = frame(4001n, { x: 0, y: 0, width: 800, height: 600 });
    const bigger = frame(4002n, { x: 0, y: 0, width: 1000, height: 750 });
    expect(frameForWindowBounds([bigger], { left: 0, top: 0, width: 800, height: 600 }, () => 1)).toBeUndefined();
    expect(frameForWindowBounds([bigger, target], { left: 0, top: 0, width: 800, height: 600 }, () => 1)).toBe(target);
  });

  it("each frame is scaled by its own monitor", () => {
    // Same DIP bounds; only the frame on the 150 % monitor is at bounds × 1.5.
    const at150 = frame(5001n, { x: 960, y: 60, width: 930, height: 750 });
    const at100 = frame(5002n, { x: 640, y: 40, width: 620, height: 500 });
    const scale = (w: W) => (w === at150 ? 1.5 : 1);
    expect(frameForWindowBounds([at150, at100], { left: 640, top: 40, width: 620, height: 500 }, scale)).toBeUndefined();
    expect(frameForWindowBounds([at150], { left: 640, top: 40, width: 620, height: 500 }, scale)).toBe(at150);
  });

  it("a frame one window-border off is not the window (the tolerance is not a border)", () => {
    expect(frameForWindowBounds([RIGHT], { left: 960 + 8, top: 50, width: 940 - 16, height: 700 - 8 }, () => 1)).toBeUndefined();
  });
});

describe("osClickAndVerify brings forward, and asks about, the tab's own window", () => {
  it("the named tab is in the second window: that window is focused and asked, not the first by title", async () => {
    mocks.windows = [LEFT, RIGHT];
    mocks.bounds = { left: 960, top: 50, width: 940, height: 700 };
    const asked: bigint[] = [];
    await osClickAndVerify(1400, 400, null, "B7AE2D", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.boundsAskedFor).toEqual(["B7AE2D"]);
    expect(mocks.focused).toEqual([RIGHT.hwnd]);
    expect(asked).toEqual([RIGHT.hwnd]);
  });

  it("the tab's window is already active: nothing is brought forward, and it is the one asked", async () => {
    mocks.windows = [LEFT, RIGHT];
    mocks.bounds = { left: 0, top: 50, width: 940, height: 700 };
    const asked: bigint[] = [];
    await osClickAndVerify(400, 400, null, "EB77BA", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.focused).toEqual([]);
    expect(asked).toEqual([LEFT.hwnd]);
  });

  it("the scale comes from the frame's monitor: at 150 % the DIP bounds find the frame at 1.5×", async () => {
    const left150 = frame(6001n, { x: 0, y: 75, width: 1410, height: 1050 }, true, 0);
    const right150 = frame(6002n, { x: 1440, y: 75, width: 1410, height: 1050 }, false, 1);
    mocks.windows = [left150, right150];
    mocks.dpi.set(6001n, 144).set(6002n, 144);
    mocks.bounds = { left: 960, top: 50, width: 940, height: 700 };
    const asked: bigint[] = [];
    await osClickAndVerify(2000, 600, null, "B7AE2D", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(asked).toEqual([right150.hwnd]);
  });

  it("without bounds from CDP it falls back to the title, as before: the active window with that title", async () => {
    mocks.windows = [LEFT, RIGHT];
    const asked: bigint[] = [];
    await osClickAndVerify(1400, 400, null, "B7AE2D", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.boundsAskedFor).toEqual(["B7AE2D"]);
    expect(asked).toEqual([LEFT.hwnd]);
  });
});
