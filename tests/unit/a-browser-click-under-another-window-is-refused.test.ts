/**
 * internal #274 — `browser_click` does not click a point another window covers.
 *
 * MEASURED win2 (2.3.0 dogfood, main `3953af04`, 2026-10-08; same on 2.2.0): Edge's first-run welcome
 * panel, a separate window Edge owns, covered the whole browser. `browser_click` on a button answered
 * `ok: true` with `verifyDelivery` `unverifiable` / `no_dom_mutation`; the OS click landed on the panel
 * and nothing happened in the page.
 *
 * The click is an OS cursor click, so the check is Windows' own answer to "who takes a press here"
 * (`whoIsUnderPoint`), asked after the browser is brought forward and before the cursor moves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointOwner } from "../../src/engine/point-owner.js";

type W = { hwnd: bigint; title: string; isActive: boolean; className?: string; region: { x: number; y: number; width: number; height: number }; zOrder: number };
const EDGE: W = { hwnd: 4242n, title: "Shop - Microsoft Edge", isActive: true, className: "Chrome_WidgetWin_1", region: { x: 0, y: 0, width: 1200, height: 900 }, zOrder: 0 };

const mocks = vi.hoisted(() => ({
  click: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  windows: [] as unknown[],
  focused: [] as bigint[],
  cached: [] as unknown[][],
}));

vi.mock("../../src/engine/window-cache.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/window-cache.js")>()),
  updateWindowCache: (ws: unknown[]) => { mocks.cached.push(ws); },
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
  evaluateInTab: vi.fn(async () => { throw new Error("no CDP in this cell"); }),
  getTabWindowBounds: vi.fn(async () => { throw new Error("no CDP in this cell"); }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => mocks.windows,
  restoreAndFocusWindow: (h: bigint) => { mocks.focused.push(h); },
}));

const { osClickAndVerify, browserPointCover, browserPointCoveredFailure } = await import("../../src/tools/browser.js");

afterEach(() => {
  mocks.click.mockClear();
  mocks.move.mockClear();
  mocks.focused.length = 0;
  mocks.cached.length = 0;
  mocks.windows = [EDGE];
});
mocks.windows = [EDGE];

const owners: Record<string, PointOwner> = {
  owned: { kind: "owned", hwnd: 777n, title: "Welcome to Microsoft Edge", via: "os_hit_test" },
  other: { kind: "other", hwnd: 888n, title: "Notepad", via: "os_hit_test" },
  blocked: { kind: "blocked", why: "excluded_window", via: "os_hit_test" },
  aim: { kind: "aim", via: "os_hit_test" },
  unknown: { kind: "unknown", why: "unattributable_window", via: "os_hit_test" },
};

describe("osClickAndVerify asks who is on top before it moves the cursor", () => {
  for (const kind of ["owned", "other", "blocked"] as const) {
    it(`${kind}: nothing is moved or clicked, and the cover comes back`, async () => {
      const asked: Array<[bigint, number, number]> = [];
      const r = await osClickAndVerify(283, 125, null, null, 9222, (aim, x, y) => { asked.push([aim, x, y]); return owners[kind]!; });
      expect(asked).toEqual([[4242n, 283, 125]]);
      expect(r).toHaveProperty("covered");
      expect(mocks.move).not.toHaveBeenCalled();
      expect(mocks.click).not.toHaveBeenCalled();
    });
  }

  for (const kind of ["aim", "unknown"] as const) {
    it(`${kind}: it clicks as before`, async () => {
      const r = await osClickAndVerify(283, 125, null, null, 9222, () => owners[kind]!);
      expect(r).not.toHaveProperty("covered");
      expect(mocks.move).toHaveBeenCalledWith(283, 125);
      expect(mocks.click).toHaveBeenCalledTimes(1);
    });
  }
});

describe("which window the point is asked about", () => {
  const ask = async () => {
    const asked: bigint[] = [];
    await osClickAndVerify(283, 125, null, null, 9222, (aim) => { asked.push(aim); return owners.aim!; });
    return asked;
  };

  it("the browser window it brought forward, when it was not in front", async () => {
    mocks.windows = [{ ...EDGE, isActive: false }];
    expect(await ask()).toEqual([4242n]);
    expect(mocks.focused).toEqual([4242n]);
  });

  it("not a non-browser window whose title holds the tab's title (gate 2 on #834)", async () => {
    mocks.windows = [{ ...EDGE, hwnd: 1n, title: "Shop - notes.txt", className: "Notepad", isActive: true }, { ...EDGE, isActive: false }];
    expect(await ask()).toEqual([4242n]);
  });

  it("the window of the tab the click is for, not the first tab's (codex P1 on #834)", async () => {
    const CART = { ...EDGE, hwnd: 5151n, title: "Cart - Microsoft Edge", isActive: false };
    mocks.windows = [EDGE, CART];
    const asked: bigint[] = [];
    await osClickAndVerify(283, 125, null, "t2", 9222, (aim) => { asked.push(aim); return owners.aim!; });
    expect(asked).toEqual([5151n]);
  });

  it("the window cache still gets every window, not only the browser frames (codex P2 on #834)", async () => {
    const NOTES = { ...EDGE, hwnd: 1n, title: "notes.txt", className: "Notepad", isActive: false };
    mocks.windows = [NOTES, EDGE];
    await ask();
    expect(mocks.cached[0]).toContainEqual(NOTES);
  });

  it("with no browser window found, nothing is asked and it clicks as before", async () => {
    mocks.windows = [];
    expect(await ask()).toEqual([]);
    expect(mocks.click).toHaveBeenCalledTimes(1);
  });

  it("an answer from the window list (no hit test) is not a refusal — it cannot see an overlay's transparency", () => {
    expect(browserPointCover({ kind: "owned", hwnd: 1n, title: "x", via: "enumeration" })).toBeUndefined();
    expect(browserPointCover({ kind: "other", hwnd: 1n, title: "x", via: "enumeration" })).toBeUndefined();
    expect(browserPointCover({ kind: "blocked", why: "excluded_window", via: "enumeration" })).toBeDefined();
  });
});

describe("the refusal", () => {
  it("names the browser's own window and another window, and never the excluded one", () => {
    const text = (k: keyof typeof owners) => {
      const r = browserPointCoveredFailure(browserPointCover(owners[k]!)!, 283, 125, { selector: "#buy" });
      return JSON.parse((r.content[0] as { text: string }).text) as { ok: boolean; code: string; error: string; context: Record<string, unknown> };
    };
    const owned = text("owned");
    expect(owned).toMatchObject({ ok: false, code: "BrowserPointCovered" });
    expect(owned.error).toContain("a window of the browser itself");
    expect(owned.error).toContain("Welcome to Microsoft Edge");
    expect(owned.error).toContain("Nothing was clicked");
    expect(text("other").error).toContain("\"Notepad\" (hwnd 888)");
    const blocked = text("blocked");
    expect(blocked.error).toContain("a window this server may not act through");
    expect(blocked.error).not.toMatch(/hwnd/);
  });

  it("is not made for the browser window or for no answer", () => {
    expect(browserPointCover(owners.aim!)).toBeUndefined();
    expect(browserPointCover(owners.unknown!)).toBeUndefined();
  });
});
