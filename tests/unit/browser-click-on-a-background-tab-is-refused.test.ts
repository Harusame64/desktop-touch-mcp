/**
 * internal #318 — `browser_click` clicks the tab it was asked for, not the tab showing in front of it.
 *
 * MEASURED win2 (2026-10-28, Edge 156, one window, two tabs, the window in front, the target tab
 * behind): main answered `ok: true` at (392,360); the target page logged nothing and stayed hidden,
 * and the tab showing got a trusted pointerdown and click on its own button at that point.
 *
 * The user's decision (2026-10-28): browser_click does not switch the user's tab. The last look
 * before the cursor moves refuses as BrowserPointCovered / coveredBy "tab" when the tab is hidden and
 * another page of the browser is showing, and names both, so the caller can switch and retry. With the
 * display off every page reads hidden, and the click still lands, so then it clicks as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointOwner } from "../../src/engine/point-owner.js";

const EDGE = {
  hwnd: 4242n, title: "Shop - Microsoft Edge", isActive: true, className: "Chrome_WidgetWin_1",
  region: { x: 0, y: 0, width: 1200, height: 900 }, zOrder: 0,
};

const mocks = vi.hoisted(() => ({
  click: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  visibility: {} as Record<string, string>,
  bring: vi.fn(async () => {}),
}));

vi.mock("../../src/engine/window-cache.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/window-cache.js")>()),
  updateWindowCache: () => {},
}));
vi.mock("../../src/engine/nutjs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/nutjs.js")>()),
  mouse: { click: mocks.click, config: {} },
}));
vi.mock("../../src/engine/cursor.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cursor.js")>()),
  moveCursorTo: mocks.move,
}));
vi.mock("../../src/engine/reachable-bounds.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/reachable-bounds.js")>()),
  assertCoordinateReachable: () => {},
}));
vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  listTabs: vi.fn(async () => [
    { id: "t1", type: "page", title: "Shop", url: "https://example.test/" },
    { id: "t2", type: "page", title: "Cart", url: "https://example.test/cart" },
  ]),
  evaluateInTab: vi.fn(async (expr: string, tabId: string | null) => {
    if (expr === "document.visibilityState") return mocks.visibility[tabId ?? ""] ?? "visible";
    throw new Error("no probe in this cell");
  }),
  // The tab's window is EDGE (the frame title shows the other tab, so only the bounds find it).
  getTabWindowBounds: vi.fn(async () => ({ left: 0, top: 0, width: 1200, height: 900 })),
  resolveTabId: vi.fn(async (id: string | null) => id ?? "t1"),
  bringTabToFront: mocks.bring,
  getBrowserProcessId: vi.fn(async () => { throw new Error("no pid in this cell"); }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => [EDGE],
  restoreAndFocusWindow: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
  getWindowDpi: () => 96,
}));

const { osClickAndVerify, browserPointCoveredFailure, hiddenTabCover } = await import("../../src/tools/browser.js");

const aim: PointOwner = { kind: "aim", via: "os_hit_test" };
const other: PointOwner = { kind: "other", hwnd: 888n, title: "Notepad", via: "os_hit_test" };
const SHOP = { tabId: "t1", title: "Shop", url: "https://example.test/" };
const CART = { tabId: "t2", title: "Cart", url: "https://example.test/cart" };

afterEach(() => {
  mocks.click.mockClear();
  mocks.move.mockClear();
  mocks.bring.mockClear();
  mocks.visibility = {};
});

describe("internal #318: the last look before the click", () => {
  it("refuses when the tab is hidden and another page is showing, names both, and switches nothing", async () => {
    mocks.visibility = { t2: "hidden", t1: "visible" };
    expect(await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim)).toEqual({
      covered: "tab", target: CART, showing: [SHOP],
    });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.click).not.toHaveBeenCalled();
    expect(mocks.bring).not.toHaveBeenCalled();
  });

  it("clicks when every page reads hidden (the display off), as before", async () => {
    mocks.visibility = { t2: "hidden", t1: "hidden" };
    const r = await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim);
    expect("covered" in r).toBe(false);
    expect(mocks.click).toHaveBeenCalledTimes(1);
  });

  it("clicks when the tab is showing", async () => {
    const r = await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim);
    expect("covered" in r).toBe(false);
    expect(mocks.click).toHaveBeenCalledTimes(1);
  });

  it("a window on top is still named as a window (with its own advice), not as a hidden tab", async () => {
    mocks.visibility = { t2: "hidden", t1: "visible" };
    expect(await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => other)).toEqual({
      covered: "other", hwnd: 888n, title: "Notepad",
    });
  });

  it("says which tab is showing, which tab to select and how, as BrowserPointCovered / coveredBy tab", () => {
    const r = browserPointCoveredFailure({ covered: "tab", target: CART, showing: [SHOP] }, 392, 360, { selector: "#btn" });
    const body = JSON.parse(r.content[0]!.type === "text" ? r.content[0]!.text : "{}");
    expect(body.code).toBe("BrowserPointCovered");
    expect(body.error).toContain('"Cart" (https://example.test/cart, tabId t2) is not showing');
    expect(body.error).toContain('"Shop" (https://example.test/, tabId t1)');
    expect(body.error).toMatch(/does not switch tabs\. Nothing was clicked/);
    expect(JSON.stringify(body.suggest)).toContain('retry browser_click with tabId \\"t2\\"');
    expect(body.context).toMatchObject({ coveredBy: "tab", target: CART, showing: [SHOP] });
  });
});

describe("internal #318: hiddenTabCover", () => {
  const pages = [
    { id: "t1", type: "page", title: "Shop", url: "https://example.test/" },
    { id: "t2", type: "page", title: "Cart", url: "https://example.test/cart" },
    { id: "sw", type: "service_worker", title: "", url: "https://example.test/sw.js" },
  ];
  const deps = (states: Record<string, unknown[] | unknown>, slept: number[] = []) => ({
    list: async () => pages,
    resolve: async (id: string | null) => id ?? "t1",
    evaluate: async (_e: string, id: string | null) => {
      const v = states[id!];
      if (Array.isArray(v)) return v.length > 1 ? v.shift() : v[0];
      if (v instanceof Error) throw v;
      return v;
    },
    sleep: async (ms: number) => { slept.push(ms); },
  });

  it("a tab that shows within 300 ms (a window only just raised) clicks", async () => {
    expect(await hiddenTabCover("t2", 9222, deps({ t2: ["hidden", "hidden", "visible"], t1: "visible" }))).toBeUndefined();
  });

  it("waits at most 300 ms before refusing", async () => {
    const slept: number[] = [];
    expect(await hiddenTabCover("t2", 9222, deps({ t2: ["hidden"], t1: "visible" }, slept))).toMatchObject({ covered: "tab" });
    expect(slept.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it("asks every other page, not a sample, and never a non-page target", async () => {
    const asked: string[] = [];
    const many = Array.from({ length: 20 }, (_, n) => ({ id: `p${n}`, type: "page", title: `P${n}`, url: `https://e.test/${n}` }));
    const r = await hiddenTabCover("p0", 9222, {
      ...deps({}),
      list: async () => [...many, { id: "sw", type: "service_worker", title: "", url: "" }],
      evaluate: async (_e, id) => { asked.push(id!); return id === "p0" ? "hidden" : id === "p17" ? "visible" : "hidden"; },
    });
    expect(r).toMatchObject({ covered: "tab", showing: [{ tabId: "p17" }] });
    expect(asked).not.toContain("sw");
    expect(new Set(asked).size).toBe(20);
  });

  it("a page that never answers does not hold the click (1 s each) and counts as no answer", async () => {
    vi.useFakeTimers();
    try {
      const p = hiddenTabCover("t2", 9222, {
        ...deps({ t2: "hidden" }),
        evaluate: async (_e, id) => (id === "t2" ? "hidden" : new Promise(() => {})),
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no answer from the tab, or no CDP, clicks as before", async () => {
    expect(await hiddenTabCover("t2", 9222, deps({ t2: new Error("gone"), t1: "visible" }))).toBeUndefined();
    expect(await hiddenTabCover("t2", 9222, { ...deps({}), list: async () => { throw new Error("down"); } })).toBeUndefined();
  });

  it("without a tabId, asks about the tab the call works on", async () => {
    expect(await hiddenTabCover(null, 9222, deps({ t1: "hidden", t2: "visible" }))).toMatchObject({
      covered: "tab", target: { tabId: "t1" }, showing: [{ tabId: "t2" }],
    });
  });
});
