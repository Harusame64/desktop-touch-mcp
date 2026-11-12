/**
 * ADR-040 PR ③ (internal #319 item 2, the rest) — the CDP road's tab is the one the frame shows: the frame
 * has a page surface, the tab is in the browser window at the frame's rect, and it is visible. Anything
 * else is none, and the wheel takes the window road (PR ②).
 */
import { describe, it, expect, vi } from "vitest";
import { tabOfFrame, type TabOfFrameDeps } from "../../src/engine/cdp-tab-of-frame.js";
import { PAGE_RWH_CLASS } from "../../src/engine/page-surface.js";

const FRAME = 0x100n;
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const bounds = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const page = (id: string, title: string, url = `https://${id.toLowerCase()}.example/`) => ({ id, title, url, type: "page" });

// win2-like: a normal window at 100,100 1200×800 and a second one beside it at 1300,100.
const LEFT = { rect: rect(100, 100, 1200, 800), bounds: bounds(100, 100, 1200, 800) };
const RIGHT = { rect: rect(1300, 100, 1200, 800), bounds: bounds(1300, 100, 1200, 800) };
// Two maximized windows on one 1920×1080 monitor share the same rect.
const MAX = { rect: rect(-8, -8, 1936, 1056), bounds: bounds(-8, -8, 1936, 1056) };

function deps(over: {
  surface?: "surface" | "covered" | "minimized" | "cloaked" | "unreadable";
  frameRect?: ReturnType<TabOfFrameDeps["frameRect"]>;
  scale?: number;
  title?: string;
  windows?: Record<string, { windowId: number; bounds?: ReturnType<typeof bounds> }>;
  windowsThrow?: boolean;
  visible?: string[];
}): TabOfFrameDeps & { visibility: ReturnType<typeof vi.fn> } {
  const s = over.surface ?? "surface";
  const children = s === "surface"
    ? [{ hwnd: 0x200n, className: PAGE_RWH_CLASS, visible: true, rect: rect(110, 180, 1180, 710) }]
    : s === "covered"
      ? [{ hwnd: 0x201n, className: "Intermediate D3D Window", visible: true, rect: rect(0, 0, 10, 10) }]
      : [];
  return {
    surface: {
      isIconic: () => s === "minimized",
      isCloaked: () => s === "cloaked",
      descendants: () => {
        if (s === "unreadable") throw new Error("no addon");
        return children;
      },
    },
    frameRect: () => (over.frameRect === undefined ? LEFT.rect : over.frameRect),
    frameScale: () => over.scale ?? 1,
    frameTitle: () => over.title ?? "",
    windowsOf: async (ids) => {
      if (over.windowsThrow) throw new Error("CDP unreachable");
      const all = over.windows ?? {};
      return new Map(ids.filter((id) => all[id] !== undefined).map((id) => [id, all[id]!]));
    },
    visibility: vi.fn(async (id: string) => ((over.visible ?? []).includes(id) ? "visible" : "hidden")),
  };
}

describe("tabOfFrame — a frame with no page surface is not on the CDP road (ADR-040 invariant 6)", () => {
  const tabs = [page("A", "A")];
  const windows = { A: { windowId: 1, bounds: LEFT.bounds } };
  it.each(["covered", "minimized", "cloaked"] as const)("%s: none, and no tab is asked", async (surface) => {
    const d = deps({ surface, windows, visible: ["A"], title: "A - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "not_shown" });
    expect(d.visibility).not.toHaveBeenCalled();
  });
  it("the surface cannot be read: the rect and the visibility still decide (invariant 3, never refuse on it)", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ surface: "unreadable", windows, visible: ["A"] }))).toEqual({ kind: "tab", tabId: "A" });
    expect(await tabOfFrame(FRAME, tabs, deps({ surface: "unreadable", windows, visible: [] }))).toEqual({ kind: "none", why: "no_visible_tab" });
  });
  it("the control: the same window with its surface is on the CDP road", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: ["A"], title: "A - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
});

describe("tabOfFrame — the tab is in the window at the frame's rect (internal #319 item 2)", () => {
  // The default tab (most recently used, listed first) is the other window's: the old road took it.
  const tabs = [page("R", "Right page"), page("L", "Left page")];
  const windows = { R: { windowId: 2, bounds: RIGHT.bounds }, L: { windowId: 1, bounds: LEFT.bounds } };
  it("two windows side by side, both shown: the left frame's tab, not the first listed", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: ["R", "L"], title: "Left page - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "L" });
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: RIGHT.rect, windows, visible: ["R", "L"], title: "Right page - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "R" });
  });
  it("by rect even when the frame's title shows neither (an Edge title, a title that changed)", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: ["R", "L"], title: "Something else - Microsoft Edge" })))
      .toEqual({ kind: "tab", tabId: "L" });
  });
  it("no window at the frame's rect: none", async () => {
    const d = deps({ frameRect: rect(500, 500, 700, 500), windows, visible: ["R", "L"] });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "no_window" });
    expect(d.visibility).not.toHaveBeenCalled();
  });
  it("a tab whose window gave no bounds is not at the frame", async () => {
    const d = deps({ windows: { R: { windowId: 2, bounds: bounds(1300, 100, 900, 600) }, L: { windowId: 1 } }, visible: ["L"] });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "no_window" });
  });
  it("bounds are DIPs: at 150 % the frame's rect is the bounds × 1.5 (3 px tolerance)", async () => {
    const d = deps({ scale: 1.5, frameRect: rect(150, 150, 1800, 1200), windows: { L: { windowId: 1, bounds: LEFT.bounds } }, visible: ["L"] });
    expect(await tabOfFrame(FRAME, [page("L", "Left page")], d)).toEqual({ kind: "tab", tabId: "L" });
    const off = deps({ scale: 1.5, frameRect: rect(150, 150, 1804, 1200), windows: { L: { windowId: 1, bounds: LEFT.bounds } }, visible: ["L"] });
    expect(await tabOfFrame(FRAME, [page("L", "Left page")], off)).toEqual({ kind: "none", why: "no_window" });
  });
  it("a scaled secondary monitor (DIP origin ≠ physical / scale): a window of the frame's size is taken", async () => {
    // Physical x 2000 on a 150 % monitor right of a 1920 px one; Chrome puts its DIP left near 1973.
    const d = deps({ scale: 1.5, frameRect: rect(2000, 150, 1800, 1200), windows: { L: { windowId: 1, bounds: bounds(1973, 100, 1200, 800) } }, visible: ["L"] });
    expect(await tabOfFrame(FRAME, [page("L", "Left page")], d)).toEqual({ kind: "tab", tabId: "L" });
  });
  it("a window at the frame's place wins over another only of its size", async () => {
    const w = { R: { windowId: 2, bounds: RIGHT.bounds }, L: { windowId: 1, bounds: LEFT.bounds } };
    expect(await tabOfFrame(FRAME, tabs, deps({ windows: w, visible: ["R", "L"], title: "" }))).toEqual({ kind: "tab", tabId: "L" });
  });
  it("the browser endpoint cannot be reached: none", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windowsThrow: true, visible: ["L"] }))).toEqual({ kind: "none", why: "unreadable" });
  });
});

describe("tabOfFrame — the tab the window shows (ADR-040 invariant 1)", () => {
  const tabs = [page("BG", "Background"), page("FG", "Front")];
  const windows = { BG: { windowId: 1, bounds: LEFT.bounds }, FG: { windowId: 1, bounds: LEFT.bounds } };
  it("of two tabs of one window, the visible one, not the first listed", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: ["FG"], title: "Front - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "FG" });
  });
  it("the tab the frame's title shows is asked first, and alone when it answers visible", async () => {
    const d = deps({ windows, visible: ["FG"], title: "Front - Google Chrome" });
    await tabOfFrame(FRAME, tabs, d);
    expect(d.visibility.mock.calls).toEqual([["FG"]]);
  });
  it("when the titled tab is hidden (its title changed), the rest are asked", async () => {
    const d = deps({ windows, visible: ["BG"], title: "Front - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "tab", tabId: "BG" });
    expect(d.visibility.mock.calls).toEqual([["FG"], ["BG"]]);
  });
  it("every page hidden (the display off, OQ-40-1), one window: the tab the frame's title shows, as the old road reached", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: [], title: "Front - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "FG" });
  });
  it("every page hidden and the frame's title shows none of them: none", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: [], title: "Other - Google Chrome" })))
      .toEqual({ kind: "none", why: "no_visible_tab" });
  });
  it("every page hidden at a rect two windows share: none, even with a title (it could be the other window's)", async () => {
    const two = { BG: { windowId: 1, bounds: LEFT.bounds }, FG: { windowId: 2, bounds: LEFT.bounds } };
    expect(await tabOfFrame(FRAME, tabs, deps({ windows: two, visible: [], title: "Front - Google Chrome" })))
      .toEqual({ kind: "none", why: "no_visible_tab" });
  });
  it("DevTools' front end docked in the window answers visible too, and is not the tab", async () => {
    const withDevTools = [page("DT", "DevTools", "devtools://devtools/bundled/devtools_app.html"), ...tabs];
    const d = deps({ windows: { ...windows, DT: { windowId: 1, bounds: LEFT.bounds } }, visible: ["DT", "FG"] });
    expect(await tabOfFrame(FRAME, withDevTools, d)).toEqual({ kind: "tab", tabId: "FG" });
    expect(d.visibility.mock.calls.flat()).not.toContain("DT");
  });
  it("targets that are not pages are not tabs", async () => {
    const d = deps({ windows: { SW: { windowId: 1, bounds: LEFT.bounds } }, visible: ["SW"] });
    expect(await tabOfFrame(FRAME, [{ id: "SW", title: "", url: "https://x/sw.js", type: "service_worker" }], d))
      .toEqual({ kind: "none", why: "no_window" });
  });
});

describe("tabOfFrame — two maximized windows at one rect (spike S4)", () => {
  const tabs = [page("A", "Alpha"), page("B", "Beta")];
  const windows = { A: { windowId: 1, bounds: MAX.bounds }, B: { windowId: 2, bounds: MAX.bounds } };
  it("only the front one is drawn (the one behind is hidden): that one, when the frame's title shows it", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["B"], title: "Beta - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "B" });
  });
  it("this frame's own tab gives no answer and the other window's is the one visible: none, not the other's (agy)", async () => {
    // The back frame (title Alpha) whose surface could not be read: its tab reads hidden, the front's visible.
    expect(await tabOfFrame(FRAME, tabs, deps({ surface: "unreadable", frameRect: MAX.rect, windows, visible: ["B"], title: "Alpha - Google Chrome" })))
      .toEqual({ kind: "none", why: "ambiguous" });
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["B"], title: "" })))
      .toEqual({ kind: "none", why: "ambiguous" });
  });
  it("two same-title windows, only the front drawn (#965 W4c): the front's tab", async () => {
    const same = [page("A", "Same"), page("B", "Same")];
    expect(await tabOfFrame(FRAME, same, deps({ frameRect: MAX.rect, windows, visible: ["A"], title: "Same - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
  it("both drawn, different titles: the one the frame's title shows", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Beta - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "B" });
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Alpha - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
  it("both drawn, the same title: none (cannot be told apart)", async () => {
    const same = [page("A", "Same"), page("B", "Same")];
    expect(await tabOfFrame(FRAME, same, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Same - Google Chrome" })))
      .toEqual({ kind: "none", why: "ambiguous" });
  });
  it("both drawn and the frame's title shows neither: none", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Gamma - Google Chrome" })))
      .toEqual({ kind: "none", why: "ambiguous" });
  });
  it("an empty title shows nothing: a frame whose title could not be read does not pick the untitled tab", async () => {
    const untitled = [page("A", ""), page("B", "Beta")];
    expect(await tabOfFrame(FRAME, untitled, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "" })))
      .toEqual({ kind: "none", why: "ambiguous" });
  });
  it("both drawn, the frame's title names one, and the other window's tab has a shorter title it starts with", async () => {
    // Window A's frame reads "Foo Bar - …"; window B shows "Foo". B is not this frame's (gate 2).
    const foo = [page("A", "Foo Bar"), page("B", "Foo")];
    expect(await tabOfFrame(FRAME, foo, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Foo Bar - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
  it("both drawn, two windows at the rect: every tab is asked, not only a titled one (gate 2)", async () => {
    // A's frame still reads "Foo Bar - …" while A shows "Baz"; B shows "Foo Bar". Asking the titled tab alone
    // would find B visible and take it; asked together, the title decides only between visible tabs.
    const lag = [page("A", "Baz"), page("B", "Foo Bar")];
    const d = deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Foo Bar - Google Chrome" });
    await tabOfFrame(FRAME, lag, d);
    expect(d.visibility.mock.calls.flat().sort()).toEqual(["A", "B"]);
  });
  it("Edge's title with more pages ('<title> and 2 more pages - …') shows that tab", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Beta and 2 more pages - Profile 1 - Microsoft\u200b Edge" })))
      .toEqual({ kind: "tab", tabId: "B" });
  });
  it("a title is a whole title: 'Alpha' does not show 'Alp'", async () => {
    const near = [page("A", "Alp"), page("B", "Beta")];
    expect(await tabOfFrame(FRAME, near, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Alpha - Google Chrome" })))
      .toEqual({ kind: "none", why: "ambiguous" });
  });
});
