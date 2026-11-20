/**
 * internal #421 — browser_click's OS press carries the page's press guard, as desktop_act's CDP press does. The
 * guard goes in right before the press and is read after it: a press whose first event lands on something the
 * landing rule does not allow (the page moved between the read and the press) is stopped in the page and answered
 * BrowserPointCovered / coveredBy "page_stopped", naming what it landed on. A press that landed is answered as
 * before, and with no element to guard nothing is installed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointOwner } from "../../src/engine/point-owner.js";

const EDGE = {
  hwnd: 4242n, title: "Shop - Microsoft Edge", isActive: true, className: "Chrome_WidgetWin_1",
  region: { x: 0, y: 0, width: 1200, height: 900 }, zOrder: 0,
};

const mocks = vi.hoisted(() => ({
  click: vi.fn(async () => {}),
  guard: { install: { ok: true } as unknown, read: { ok: true, blocked: 0, first: null } as unknown },
  calls: [] as string[],
}));

vi.mock("../../src/engine/window-cache.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/window-cache.js")>()),
  updateWindowCache: () => {},
}));
vi.mock("../../src/engine/nutjs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/nutjs.js")>()),
  mouse: { click: async () => { mocks.calls.push("press"); await mocks.click(); }, config: {} },
}));
vi.mock("../../src/engine/cursor.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cursor.js")>()),
  moveCursorTo: vi.fn(async () => { mocks.calls.push("move"); }),
}));
vi.mock("../../src/engine/reachable-bounds.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/reachable-bounds.js")>()),
  assertCoordinateReachable: () => {},
}));
vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  listTabs: vi.fn(async () => [{ id: "t1", type: "page", title: "Shop", url: "https://example.test/" }]),
  evaluateInTab: vi.fn(async (expr: string) => {
    if (expr === "document.visibilityState") return "visible";
    if (expr.includes("window.addEventListener(types[i], onEvent, true)")) { mocks.calls.push("guard"); return mocks.guard.install; }
    if (expr.includes("var g = window.__dtmPressGuard;")) { mocks.calls.push("read"); return mocks.guard.read; }
    throw new Error("no probe in this cell");
  }),
  getTabWindowBounds: vi.fn(async () => ({ left: 0, top: 0, width: 1200, height: 900 })),
  resolveTabId: vi.fn(async (id: string | null) => id ?? "t1"),
  getWindowIdsForTargets: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, 1]))),
  bringTabToFront: vi.fn(async () => {}),
  getBrowserProcessId: vi.fn(async () => { throw new Error("no pid in this cell"); }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => [EDGE],
  restoreAndFocusWindow: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
  getWindowDpi: () => 96,
}));

const { osClickAndVerify, browserPointCoveredFailure } = await import("../../src/tools/browser.js");

const aim: PointOwner = { kind: "aim", via: "os_hit_test" };
const press = (guard?: string) => osClickAndVerify(392, 360, "#btn", "t1", 9222, () => aim, false, undefined, undefined, guard);

afterEach(() => {
  mocks.click.mockClear();
  mocks.calls = [];
  mocks.guard = { install: { ok: true }, read: { ok: true, blocked: 0, first: null } };
});

describe("internal #421: browser_click's press guard", () => {
  it("installs the guard after the cursor moved, right before the press, and reads it after", async () => {
    await press("#btn");
    expect(mocks.calls).toEqual(["move", "guard", "press", "read"]);
  });

  it("answers page_stopped, naming what the press landed on, when the guard stopped it", async () => {
    mocks.guard.read = { ok: true, blocked: 3, first: 'div.menu "Account"' };
    const r = await press("#btn");
    // The probe is not installed in this cell, so whether the page reacted is unknown (round 2 on #1005).
    expect(r).toEqual({ covered: "page_stopped", first: 'div.menu "Account"', pageReacted: null, at: { x: 392, y: 360 } });
    const f = browserPointCoveredFailure(r as never, 392, 360, { selector: "#btn" });
    const body = JSON.parse((f.content[0] as { text: string }).text) as { code: string; error: string; context: Record<string, unknown> };
    expect(body.code).toBe("BrowserPointCovered");
    expect(body.context.coveredBy).toBe("page_stopped");
    expect(body.context.landedOn).toBe('div.menu "Account"');
    expect(body.context.pageReacted).toBe(null);
    expect(body.error).toContain("the element was not clicked");
    expect(body.error).toContain("could not be measured");
  });

  it("says the page still changed when its own listener ran before the stop (/code-review on #1005)", async () => {
    const f = browserPointCoveredFailure({ covered: "page_stopped", first: "div.menu", pageReacted: true }, 1, 2, { selector: "#btn" });
    const body = JSON.parse((f.content[0] as { text: string }).text) as { error: string; context: Record<string, unknown> };
    expect(body.context.pageReacted).toBe(true);
    expect(body.error).toContain("The page still changed");
  });

  it("says nothing more when the probe measured no change (pageReacted false)", async () => {
    const f = browserPointCoveredFailure({ covered: "page_stopped", first: "div.menu", pageReacted: false }, 1, 2, { selector: "#btn" });
    const body = JSON.parse((f.content[0] as { text: string }).text) as { error: string; context: Record<string, unknown> };
    expect(body.context.pageReacted).toBe(false);
    expect(body.error).not.toContain("still changed");
    expect(body.error).not.toContain("could not be measured");
  });

  it("answers the probe's verdict when the press landed (blocked 0)", async () => {
    const r = await press("#btn");
    expect("covered" in r).toBe(false);
  });

  it("reads the guard though its install answered nothing: the answer can be lost after it ran (/code-review on #1005)", async () => {
    mocks.guard.install = null;
    mocks.guard.read = { ok: true, blocked: 2, first: "div.menu" };
    const r = await press("#btn");
    expect(mocks.calls).toEqual(["move", "guard", "press", "read"]);
    expect(r).toMatchObject({ covered: "page_stopped", first: "div.menu" });
  });

  it("waits for the press to reach the page before reading the guard, though the probe was not installed (/code-review on #1005)", async () => {
    // The probe throws in this cell ("no probe"), so its verdict does not wait; the guard's read must.
    const t0 = Date.now();
    await press("#btn");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  it("keeps the probe's verdict when the guard could not be read (control: no reading, no claim)", async () => {
    mocks.guard.read = null;
    expect("covered" in (await press("#btn"))).toBe(false);
  });

  it("installs nothing without an element to guard (the by-axis road, as before)", async () => {
    await press(undefined);
    expect(mocks.calls).toEqual(["move", "press"]);
  });
});
