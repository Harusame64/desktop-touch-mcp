/**
 * internal #318 — `browser_click` does not click for a tab that is not showing in its window.
 *
 * MEASURED win2 (2026-10-28, Edge 156, main b344753e and #871 alike): two tabs in one window, the
 * window in front, the target tab behind another tab. `browser_click {selector, tabId}` answered
 * `ok: true` at (392,360); the target page got no pointerdown or click and stayed
 * `visibilityState: hidden`, and the point was the front tab's body text. `ensureBrowserFocused`
 * brought the tab forward only when its window was not in front.
 *
 * Now the tab is brought forward (Page.bringToFront), and a tab still hidden at click time is
 * refused as BrowserPointCovered / coveredBy "tab" before the cursor moves.
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
  visibility: [] as string[],
  raised: [] as string[],
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
  listTabs: vi.fn(async () => [{ id: "t2", type: "page", title: "Cart", url: "https://example.test/cart" }]),
  // document.visibilityState answers from the queue; the click probe gets nothing (unverifiable).
  evaluateInTab: vi.fn(async (expr: string) => {
    if (expr === "document.visibilityState") return mocks.visibility.shift() ?? "visible";
    throw new Error("no probe in this cell");
  }),
  bringTabToFront: vi.fn(async (id: string) => { mocks.raised.push(id); }),
  resolveTabId: vi.fn(async (id: string | null) => id ?? "t2"),
  getTabWindowBounds: vi.fn(async () => ({ left: 0, top: 0, width: 1200, height: 900, windowState: "normal" })),
  getBrowserProcessId: vi.fn(async () => { throw new Error("no pid in this cell"); }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => [EDGE],
  restoreAndFocusWindow: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
  getWindowDpi: () => 96,
}));

const { osClickAndVerify, browserPointCoveredFailure, tabIsHidden } = await import("../../src/tools/browser.js");

const aim: PointOwner = { kind: "aim", via: "os_hit_test" };

afterEach(() => {
  mocks.click.mockClear();
  mocks.move.mockClear();
  mocks.visibility.length = 0;
  mocks.raised.length = 0;
});

describe("internal #318: a click for a tab that is not showing", () => {
  it("is refused before the cursor moves when the tab stays hidden", async () => {
    mocks.visibility.push("hidden", "hidden");
    const r = await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim);
    expect(r).toEqual({ covered: "tab" });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.click).not.toHaveBeenCalled();
    expect(mocks.raised).toContain("t2");
  });

  it("clicks when bringing the tab forward made it show", async () => {
    mocks.visibility.push("hidden", "visible");
    const r = await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim);
    expect("covered" in r).toBe(false);
    expect(mocks.click).toHaveBeenCalledTimes(1);
  });

  it("clicks as before when the tab is showing", async () => {
    mocks.visibility.push("visible");
    const r = await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim);
    expect("covered" in r).toBe(false);
    expect(mocks.click).toHaveBeenCalledTimes(1);
  });

  it("brings the tab forward even when its window is already in front", async () => {
    mocks.visibility.push("visible");
    await osClickAndVerify(392, 360, "#btn", "t2", 9222, () => aim);
    expect(mocks.raised).toEqual(["t2"]);
  });

  it("says what is wrong and what to do, as BrowserPointCovered / coveredBy tab", () => {
    const r = browserPointCoveredFailure({ covered: "tab" }, 392, 360, { selector: "#btn" });
    const body = JSON.parse(r.content[0]!.type === "text" ? r.content[0]!.text : "{}");
    expect(body.code).toBe("BrowserPointCovered");
    expect(body.error).toMatch(/not showing in its window/);
    expect(body.error).toMatch(/Nothing was clicked/);
    expect(JSON.stringify(body.suggest)).toMatch(/display is off/);
    expect(body.context.coveredBy).toBe("tab");
  });
});

describe("internal #318: tabIsHidden answers true only for hidden", () => {
  it.each([
    ["hidden", true],
    ["visible", false],
    ["prerender", false],
    [undefined, false],
  ])("%s → %s", async (answer, expected) => {
    expect(await tabIsHidden("t", 9222, async () => answer)).toBe(expected);
  });

  it("an error is no answer, so it clicks as before", async () => {
    expect(await tabIsHidden("t", 9222, async () => { throw new Error("gone"); })).toBe(false);
  });
});
