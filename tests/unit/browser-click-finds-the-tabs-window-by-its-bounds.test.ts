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
  pid: new Map<bigint, number>(),
  browserPid: undefined as number | undefined,
  raised: [] as string[],
  onRaise: undefined as undefined | (() => void),
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
  getBrowserProcessId: vi.fn(async () => {
    if (mocks.browserPid === undefined) throw new Error("SystemInfo.getProcessInfo failed");
    return mocks.browserPid;
  }),
  bringTabToFront: vi.fn(async (tabId: string) => {
    mocks.raised.push(tabId);
    if (!mocks.onRaise) throw new Error("Page.bringToFront failed");
    mocks.onRaise();
  }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => mocks.windows,
  restoreAndFocusWindow: (h: bigint) => { mocks.focused.push(h); },
  getWindowDpi: (h: bigint) => mocks.dpi.get(h) ?? 96,
  getWindowProcessId: (h: bigint) => mocks.pid.get(h) ?? 0,
}));

const { osClickAndVerify, frameForWindowBounds, framesOfBrowserProcess } = await import("../../src/tools/browser.js");

afterEach(() => {
  mocks.focused.length = 0;
  mocks.boundsAskedFor.length = 0;
  mocks.bounds = undefined;
  mocks.dpi.clear();
  mocks.pid.clear();
  mocks.browserPid = undefined;
  mocks.raised.length = 0;
  mocks.onRaise = undefined;
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

/**
 * internal #305 part 2. MEASURED win2 (2026-10-24, Chrome 155 + Edge 155 open together):
 * SystemInfo.getProcessInfo's one "browser" entry equals GetWindowThreadProcessId of that browser's
 * frames and not the other's; Page.bringToFront raised the tab's window to the foreground from a
 * background process over the same browser's other window, over a terminal, and Chrome over Edge,
 * but not Edge over Chrome (#840's round). On #837's round, without these, an
 * Edge click went into a Chrome page at the same rect, and with two maximized windows a click for the
 * window behind pressed the front window's button.
 */
describe("the CDP browser's own frames, and bringing the tab forward when its bounds are shared", () => {
  const RECT = { x: 0, y: 50, width: 900, height: 600 };
  const MAX = { x: -8, y: -8, width: 1936, height: 1048 };

  it("another browser's window at the same rect is not a candidate: the Edge tab's own frame is asked", async () => {
    const chromeA = { ...frame(1051258n, RECT, true, 0), title: "K835-PAGE - Google Chrome" };
    const edgeA = { ...frame(3738296n, RECT, false, 1), title: "K835-PAGE - Microsoft Edge" };
    mocks.windows = [chromeA, edgeA];
    mocks.pid.set(chromeA.hwnd, 4336).set(edgeA.hwnd, 15864);
    mocks.browserPid = 15864;
    mocks.bounds = { left: 0, top: 50, width: 900, height: 600 };
    const asked: bigint[] = [];
    await osClickAndVerify(400, 300, null, "B7AE2D", 9346, (aim) => { asked.push(aim); return AIM; });
    expect(asked).toEqual([edgeA.hwnd]);
    // CDP's raise was tried first; it failed in this cell, so the window was focused as before.
    expect(mocks.raised).toEqual(["B7AE2D"]);
    expect(mocks.focused).toEqual([edgeA.hwnd]);
  });

  it("the one matching frame behind another process's window is raised through CDP, not restoreAndFocusWindow", async () => {
    // win2 on #840: with another browser in front, focusing the frame lost the foreground and the
    // click was refused as covered. Page.bringToFront raised a Chrome window over Edge (it did not
    // raise Edge over Chrome; that case falls back and is refused as before).
    const edgeA = { ...frame(1509488n, RECT, true, 0), title: "K835-PAGE - Microsoft Edge" };
    const chromeB = { ...frame(3869878n, { x: 200, y: 150, width: 900, height: 600 }, false, 1), title: "K835-PAGE - Google Chrome" };
    mocks.windows = [edgeA, chromeB];
    mocks.pid.set(edgeA.hwnd, 38836).set(chromeB.hwnd, 24284);
    mocks.browserPid = 24284;
    mocks.bounds = { left: 200, top: 150, width: 900, height: 600 };
    mocks.onRaise = () => { mocks.windows = [{ ...chromeB, isActive: true, zOrder: 0 }, { ...edgeA, isActive: false, zOrder: 1 }]; };
    const asked: bigint[] = [];
    await osClickAndVerify(600, 450, null, "B7AE2D", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.raised).toEqual(["B7AE2D"]);
    expect(mocks.focused).toEqual([]);
    expect(asked).toEqual([chromeB.hwnd]);
  });

  it("when CDP raises nothing, the frame is focused as before and is the one asked (the click is refused if covered)", async () => {
    // Edge behind Chrome: bringToFront answers but the foreground stays on Chrome.
    const chromeA = { ...frame(3869088n, RECT, true, 0), title: "K835-PAGE - Google Chrome" };
    const edgeB = { ...frame(2231482n, { x: 200, y: 150, width: 900, height: 600 }, false, 1), title: "K835-PAGE - Microsoft Edge" };
    mocks.windows = [chromeA, edgeB];
    mocks.pid.set(chromeA.hwnd, 24284).set(edgeB.hwnd, 38836);
    mocks.browserPid = 38836;
    mocks.bounds = { left: 200, top: 150, width: 900, height: 600 };
    mocks.onRaise = () => {};
    const asked: bigint[] = [];
    await osClickAndVerify(600, 450, null, "B7AE2D", 9346, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.raised).toEqual(["B7AE2D"]);
    expect(mocks.focused).toEqual([edgeB.hwnd]);
    expect(asked).toEqual([edgeB.hwnd]);
  });

  it("without bounds the title search is narrowed to the browser's frames too", async () => {
    const chromeA = { ...frame(1051258n, RECT, true, 0), title: "K835-PAGE - Google Chrome" };
    const edgeA = { ...frame(3738296n, RECT, false, 1), title: "K835-PAGE - Microsoft Edge" };
    mocks.windows = [chromeA, edgeA];
    mocks.pid.set(chromeA.hwnd, 4336).set(edgeA.hwnd, 15864);
    mocks.browserPid = 15864;
    const asked: bigint[] = [];
    await osClickAndVerify(400, 300, null, "B7AE2D", 9346, (aim) => { asked.push(aim); return AIM; });
    expect(asked).toEqual([edgeA.hwnd]);
  });

  it("two maximized windows of one browser: the tab is brought forward and the frame that took the foreground is asked", async () => {
    const front = frame(919904n, MAX, true, 0);
    const behind = frame(1051258n, MAX, false, 1);
    mocks.windows = [front, behind];
    mocks.pid.set(front.hwnd, 4336).set(behind.hwnd, 4336);
    mocks.browserPid = 4336;
    mocks.bounds = { left: -8, top: -8, width: 1936, height: 1048 };
    mocks.onRaise = () => { mocks.windows = [{ ...behind, isActive: true, zOrder: 0 }, { ...front, isActive: false, zOrder: 1 }]; };
    const asked: bigint[] = [];
    await osClickAndVerify(400, 300, null, "EB77BA", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.raised).toEqual(["EB77BA"]);
    expect(asked).toEqual([behind.hwnd]);
  });

  it("the front window still in front after the raise is no evidence: the title decides (codex P1 on #840)", async () => {
    // Two maximized windows, different titles; the wrong one is in front and CDP answers without
    // raising anything. Accepting the front window would click into it; the title names the right one.
    const front = { ...frame(919904n, MAX, true, 0), title: "Other - Google Chrome" };
    const behind = frame(1051258n, MAX, false, 1);
    mocks.windows = [front, behind];
    mocks.pid.set(front.hwnd, 4336).set(behind.hwnd, 4336);
    mocks.browserPid = 4336;
    mocks.bounds = { left: -8, top: -8, width: 1936, height: 1048 };
    mocks.onRaise = () => {};
    const asked: bigint[] = [];
    await osClickAndVerify(400, 300, null, "EB77BA", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.raised).toEqual(["EB77BA"]);
    expect(asked).toEqual([behind.hwnd]);
    expect(mocks.focused).toEqual([behind.hwnd]);
  });

  it("the tab's window already in front: nothing is raised over it, and the title keeps it", async () => {
    const front = frame(919904n, MAX, true, 0);
    const behind = { ...frame(1051258n, MAX, false, 1), title: "Other - Google Chrome" };
    mocks.windows = [front, behind];
    mocks.bounds = { left: -8, top: -8, width: 1936, height: 1048 };
    mocks.onRaise = () => {};
    const asked: bigint[] = [];
    await osClickAndVerify(400, 300, null, "EB77BA", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(asked).toEqual([front.hwnd]);
    expect(mocks.focused).toEqual([]);
  });

  it("when bringing it forward fails, the title decides, as before", async () => {
    const front = frame(919904n, MAX, true, 0);
    const behind = frame(1051258n, MAX, false, 1);
    mocks.windows = [front, behind];
    mocks.bounds = { left: -8, top: -8, width: 1936, height: 1048 };
    const asked: bigint[] = [];
    await osClickAndVerify(400, 300, null, "EB77BA", 9222, (aim) => { asked.push(aim); return AIM; });
    expect(mocks.raised).toEqual(["EB77BA"]);
    expect(asked).toEqual([front.hwnd]);
  });

  it("a process id no frame carries narrows nothing (the control)", () => {
    expect(framesOfBrowserProcess([LEFT, RIGHT], 9999, () => 4336)).toEqual([LEFT, RIGHT]);
    expect(framesOfBrowserProcess([LEFT, RIGHT], undefined, () => 4336)).toEqual([LEFT, RIGHT]);
  });
});

