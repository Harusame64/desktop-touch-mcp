/**
 * internal #318 — `browser_click` clicks the tab it was asked for, not the tab showing in front of it.
 *
 * MEASURED win2 (2026-10-28, Edge 156, one window, two tabs, the window in front, the target tab
 * behind): main answered `ok: true` at (392,360); the target page logged nothing and stayed hidden,
 * and the tab showing got a trusted pointerdown and click on its own button at that point.
 *
 * Now the click handlers resolve the tab once, bring it forward when it is hidden and wait for it to
 * show before computing the point (showTabForClick). The last look before the cursor moves refuses
 * as BrowserPointCovered / coveredBy "tab" only when the tab is still hidden and another page of the
 * browser is showing: with the display off every page reads hidden, and the click still lands.
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
  getBrowserProcessId: vi.fn(async () => { throw new Error("no pid in this cell"); }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => [EDGE],
  restoreAndFocusWindow: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
  getWindowDpi: () => 96,
}));

const { osClickAndVerify, browserPointCoveredFailure, tabIsHidden, showTabForClick, anotherPageShowing } =
  await import("../../src/tools/browser.js");

const aim: PointOwner = { kind: "aim", via: "os_hit_test" };
const other: PointOwner = { kind: "other", hwnd: 888n, title: "Notepad", via: "os_hit_test" };

afterEach(() => {
  mocks.click.mockClear();
  mocks.move.mockClear();
  mocks.visibility = {};
});

describe("internal #318: the last look before the click", () => {
  it("refuses when the tab is hidden and another page is showing, before the cursor moves", async () => {
    mocks.visibility = { t2: "hidden", t1: "visible" };
    expect(await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim)).toEqual({ covered: "tab" });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.click).not.toHaveBeenCalled();
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

  it("says what is wrong and what to do, as BrowserPointCovered / coveredBy tab", () => {
    const r = browserPointCoveredFailure({ covered: "tab" }, 392, 360, { selector: "#btn" });
    const body = JSON.parse(r.content[0]!.type === "text" ? r.content[0]!.text : "{}");
    expect(body.code).toBe("BrowserPointCovered");
    expect(body.error).toMatch(/another page of the browser is/);
    expect(body.error).toMatch(/Nothing was clicked/);
    expect(JSON.stringify(body.suggest)).toMatch(/same tabId/);
    expect(body.context.coveredBy).toBe("tab");
  });
});

describe("internal #318: showTabForClick, before the point is computed", () => {
  const make = (states: boolean[], over: Partial<Parameters<typeof showTabForClick>[2]> = {}) => {
    const calls: string[] = [];
    let raised = false;
    const deps = {
      resolve: async (id: string | null) => { calls.push(`resolve:${id}`); return id ?? "t9"; },
      // hidden until brought forward, then each read takes the next state
      hidden: async () => (raised ? states.shift() ?? false : true),
      bring: async (id: string) => { calls.push(`bring:${id}`); raised = true; },
      sleep: async (ms: number) => { calls.push(`sleep:${ms}`); },
      ...over,
    };
    return { deps, calls };
  };

  it("brings a hidden tab forward and waits until it shows", async () => {
    const { deps, calls } = make([true, true, false]);
    expect(await showTabForClick("t2", 9222, deps)).toBe("t2");
    expect(calls).toEqual(["resolve:t2", "bring:t2", "sleep:50", "sleep:50"]);
  });

  it("pins a missing tabId to the one tab every later step asks about", async () => {
    const { deps, calls } = make([false]);
    expect(await showTabForClick(null, 9222, deps)).toBe("t9");
    expect(calls).toEqual(["resolve:null", "bring:t9"]);
  });

  it("gives up after 500 ms and lets the last look decide", async () => {
    const { deps, calls } = make(Array(20).fill(true));
    await showTabForClick("t2", 9222, deps);
    expect(calls.filter((c) => c.startsWith("sleep")).length).toBe(10);
  });

  it("does nothing to a tab that is showing", async () => {
    const { deps, calls } = make([], { hidden: async () => false });
    await showTabForClick("t2", 9222, deps);
    expect(calls).toEqual(["resolve:t2"]);
  });

  it("no CDP: keeps the tabId as it was", async () => {
    const { deps } = make([], { resolve: async () => { throw new Error("down"); } });
    expect(await showTabForClick(null, 9222, deps)).toBeNull();
  });
});

describe("internal #318: helpers", () => {
  it.each([["hidden", true], ["visible", false], ["prerender", false], [undefined, false]])(
    "tabIsHidden: %s → %s",
    async (answer, expected) => {
      expect(await tabIsHidden("t", 9222, async () => answer)).toBe(expected);
    },
  );

  it("tabIsHidden: an error is no answer", async () => {
    expect(await tabIsHidden("t", 9222, async () => { throw new Error("gone"); })).toBe(false);
  });

  it("anotherPageShowing asks only the other pages", async () => {
    const asked: string[] = [];
    const list = async () => [
      { id: "t1", type: "page" }, { id: "t2", type: "page" }, { id: "sw", type: "service_worker" },
    ];
    const evaluate = async (_e: string, id: string | null) => { asked.push(id!); return id === "t2" ? "visible" : "hidden"; };
    expect(await anotherPageShowing("t2", 9222, { list, evaluate })).toBe(false);
    expect(asked).toEqual(["t1"]);
    expect(await anotherPageShowing("t1", 9222, { list, evaluate })).toBe(true);
  });
});

// The cells above call the pieces; these read browser_click's handler for the wiring (comments
// removed): both paths show and pin the tab before anything computes its point.
describe("internal #318: browser_click wires showTabForClick before the point is computed", () => {
  it("in the by-axis path and the selector path", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const code = readFileSync(resolve(__dirname, "../../src/tools/browser.ts"), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const at = code.indexOf("export const browserClickElementHandler");
    const handler = code.slice(at, code.indexOf("\n};\n", at));
    expect(handler).toMatch(/const shownTabId = \(await showTabForClick\(tabId \?\? null, port\)\)[\s\S]{0,200}handleBrowserClickByAxis\(\{[^}]*tabId: shownTabId/);
    const shown = handler.indexOf("effectiveTabId = (await showTabForClick(effectiveTabId ?? null, port))");
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(handler.indexOf("getElementScreenCoords("));
  });
});
