/**
 * ADR-040 PR ③ (internal #319 item 2, the rest) — the CDP road's tab is the one the frame shows: the frame
 * has a page surface, the tab is in the browser window at the frame's rect, the frame's title shows it, and
 * it is visible. Anything else is none, and the wheel takes the window road (PR ②), which scrolls the frame's
 * own visible page or sends none — so none costs no reach, and a guess could name another window's tab.
 */
import { describe, it, expect, vi } from "vitest";
import { tabOfFrame, type TabOfFrameDeps } from "../../src/engine/cdp-tab-of-frame.js";
import { PAGE_RWH_CLASS } from "../../src/engine/page-surface.js";

const FRAME = 0x100n;
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const bounds = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const page = (id: string, title: string, url = `https://${id.toLowerCase()}.example/`) => ({ id, title, url, type: "page" });

// A normal window at 100,100 1200×800 and a second one beside it at 1300,100.
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
  silent?: string[];
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
    visibility: vi.fn(async (id: string) =>
      (over.silent ?? []).includes(id) ? undefined : (over.visible ?? []).includes(id) ? "visible" : "hidden"),
  };
}

describe("tabOfFrame — a frame with no page surface is not on the CDP road (ADR-040 invariant 6)", () => {
  const tabs = [page("A", "Alpha")];
  const windows = { A: { windowId: 1, bounds: LEFT.bounds } };
  it.each(["covered", "minimized", "cloaked"] as const)("%s: none, and no tab is asked", async (surface) => {
    const d = deps({ surface, windows, visible: ["A"], title: "Alpha - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "not_shown" });
    expect(d.visibility).not.toHaveBeenCalled();
  });
  it("the surface cannot be read: none, the window road keeps its own point (gate 2 on #971: no guess)", async () => {
    const d = deps({ surface: "unreadable", windows, visible: ["A"], title: "Alpha - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "unreadable" });
  });
  it("the control: the same window with its surface is on the CDP road", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: ["A"], title: "Alpha - Google Chrome" })))
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
  it("a tab of another window whose title the frame shows is not taken: the rect comes first", async () => {
    const same = [page("R", "Same"), page("L", "Other")];
    const d = deps({ windows, visible: ["R", "L"], title: "Same - Google Chrome" });
    expect(await tabOfFrame(FRAME, same, d)).toEqual({ kind: "none", why: "no_window" });
    expect(d.visibility).not.toHaveBeenCalled();
  });
  it("no window at the frame's rect: none", async () => {
    const d = deps({ frameRect: rect(500, 500, 700, 500), windows, visible: ["R", "L"], title: "Left page - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "no_window" });
    expect(d.visibility).not.toHaveBeenCalled();
  });
  it("another window of the same size elsewhere is not the frame's (codex on #971)", async () => {
    const d = deps({ windows: { R: { windowId: 2, bounds: RIGHT.bounds } }, visible: ["R"], title: "Right page - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "no_window" });
  });
  it("a tab whose window gave no bounds is not at the frame", async () => {
    const d = deps({ windows: { L: { windowId: 1 } }, visible: ["L"], title: "Left page - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "no_window" });
  });
  it("bounds are DIPs: at 150 % the frame's rect is the bounds × 1.5 (3 px tolerance)", async () => {
    const w = { L: { windowId: 1, bounds: LEFT.bounds } };
    expect(await tabOfFrame(FRAME, [page("L", "Left page")], deps({ scale: 1.5, frameRect: rect(150, 150, 1800, 1200), windows: w, visible: ["L"], title: "Left page - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "L" });
    expect(await tabOfFrame(FRAME, [page("L", "Left page")], deps({ scale: 1.5, frameRect: rect(150, 150, 1804, 1200), windows: w, visible: ["L"], title: "Left page - Google Chrome" })))
      .toEqual({ kind: "none", why: "no_window" });
  });
  it("the browser endpoint cannot be reached: none", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windowsThrow: true, visible: ["L"], title: "Left page - Google Chrome" })))
      .toEqual({ kind: "none", why: "unreadable" });
  });
});

describe("tabOfFrame — the tab the frame's title shows, and visible (ADR-040 invariant 1)", () => {
  const tabs = [page("BG", "Background"), page("FG", "Front")];
  const windows = { BG: { windowId: 1, bounds: LEFT.bounds }, FG: { windowId: 1, bounds: LEFT.bounds } };
  it("of two tabs of one window, the one the title shows; only it is asked, and only its window is looked up", async () => {
    const d = deps({ windows, visible: ["FG"], title: "Front - Google Chrome" });
    const windowsOf = vi.spyOn(d, "windowsOf");
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "tab", tabId: "FG" });
    expect(d.visibility.mock.calls).toEqual([["FG"]]);
    expect(windowsOf.mock.calls).toEqual([[["FG"]]]);
  });
  it("the titled tab reads hidden (a title that lags): none, not another tab of the window", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, visible: ["BG"], title: "Front - Google Chrome" })))
      .toEqual({ kind: "none", why: "no_visible_tab" });
  });
  it("the title shows no tab: none, and nothing is asked", async () => {
    const d = deps({ windows, visible: ["FG"], title: "Something else - Google Chrome" });
    expect(await tabOfFrame(FRAME, tabs, d)).toEqual({ kind: "none", why: "no_titled_tab" });
    expect(d.visibility).not.toHaveBeenCalled();
  });
  it("an empty title shows nothing", async () => {
    expect(await tabOfFrame(FRAME, [page("U", ""), ...tabs], deps({ windows: { ...windows, U: { windowId: 1, bounds: LEFT.bounds } }, visible: ["U"], title: "" })))
      .toEqual({ kind: "none", why: "no_titled_tab" });
  });
  it("the titled tab gives no answer in time: none (gate 2 on #971)", async () => {
    expect(await tabOfFrame(FRAME, tabs, deps({ windows, silent: ["FG"], title: "Front - Google Chrome" })))
      .toEqual({ kind: "none", why: "unreadable" });
  });
  it("DevTools' front end docked in the window is not a tab, even titled and visible", async () => {
    const withDevTools = [page("DT", "Front", "devtools://devtools/bundled/devtools_app.html"), ...tabs];
    const d = deps({ windows: { ...windows, DT: { windowId: 1, bounds: LEFT.bounds } }, visible: ["DT", "FG"], title: "Front - Google Chrome" });
    expect(await tabOfFrame(FRAME, withDevTools, d)).toEqual({ kind: "tab", tabId: "FG" });
    expect(d.visibility.mock.calls.flat()).not.toContain("DT");
  });
  it("targets that are not pages are not tabs", async () => {
    const d = deps({ windows: { SW: { windowId: 1, bounds: LEFT.bounds } }, visible: ["SW"], title: "SW - Google Chrome" });
    expect(await tabOfFrame(FRAME, [{ id: "SW", title: "SW", url: "https://x/sw.js", type: "service_worker" }], d))
      .toEqual({ kind: "none", why: "no_titled_tab" });
  });
});

describe("tabOfFrame — how a title is shown", () => {
  const windows = { A: { windowId: 1, bounds: LEFT.bounds }, B: { windowId: 1, bounds: LEFT.bounds } };
  it("Edge's title with more pages ('<title> and 2 more pages - …') shows that tab", async () => {
    expect(await tabOfFrame(FRAME, [page("A", "Alpha"), page("B", "Beta")], deps({ windows, visible: ["B"], title: "Beta and 2 more pages - Profile 1 - Microsoft​ Edge" })))
      .toEqual({ kind: "tab", tabId: "B" });
  });
  it("Edge's profile title ('<title> - Profile 1 - Microsoft Edge') shows that tab", async () => {
    expect(await tabOfFrame(FRAME, [page("A", "Alpha"), page("B", "Beta")], deps({ windows, visible: ["A"], title: "Alpha - Profile 1 - Microsoft​ Edge" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
  it("a frame title that is the tab's title alone (an app window, a PWA) shows it", async () => {
    expect(await tabOfFrame(FRAME, [page("A", "Alpha"), page("B", "Beta")], deps({ windows, visible: ["A"], title: "Alpha" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
  it("a title is a whole title: 'Alp' is not shown by 'Alpha - …'", async () => {
    expect(await tabOfFrame(FRAME, [page("A", "Alp")], deps({ windows, visible: ["A"], title: "Alpha - Google Chrome" })))
      .toEqual({ kind: "none", why: "no_titled_tab" });
  });
  it("the longest title shown wins: 'Docs' is not taken for a frame showing 'Docs - Project' (gate 2 on #971)", async () => {
    const d = deps({ windows, visible: ["B"], title: "Docs - Project - Google Chrome" });
    expect(await tabOfFrame(FRAME, [page("A", "Docs - Project"), page("B", "Docs")], d)).toEqual({ kind: "none", why: "no_visible_tab" });
    expect(d.visibility.mock.calls).toEqual([["A"]]);
  });
});

describe("tabOfFrame — two maximized windows at one rect (spike S4)", () => {
  const windows = { A: { windowId: 1, bounds: MAX.bounds }, B: { windowId: 2, bounds: MAX.bounds } };
  it("different titles: the one the frame's title shows", async () => {
    const tabs = [page("A", "Alpha"), page("B", "Beta")];
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Beta - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "B" });
    expect(await tabOfFrame(FRAME, tabs, deps({ frameRect: MAX.rect, windows, visible: ["B"], title: "Alpha - Google Chrome" })))
      .toEqual({ kind: "none", why: "no_visible_tab" });
  });
  it("the same title, only the front drawn (#965 W4c): the front's tab", async () => {
    const same = [page("A", "Same"), page("B", "Same")];
    expect(await tabOfFrame(FRAME, same, deps({ frameRect: MAX.rect, windows, visible: ["A"], title: "Same - Google Chrome" })))
      .toEqual({ kind: "tab", tabId: "A" });
  });
  it("the same title, both drawn: none (cannot be told apart)", async () => {
    const same = [page("A", "Same"), page("B", "Same")];
    expect(await tabOfFrame(FRAME, same, deps({ frameRect: MAX.rect, windows, visible: ["A", "B"], title: "Same - Google Chrome" })))
      .toEqual({ kind: "none", why: "ambiguous" });
  });
  it("the same title, one of them silent: none, the silent one could be the drawn one", async () => {
    const same = [page("A", "Same"), page("B", "Same")];
    expect(await tabOfFrame(FRAME, same, deps({ frameRect: MAX.rect, windows, visible: ["A"], silent: ["B"], title: "Same - Google Chrome" })))
      .toEqual({ kind: "none", why: "unreadable" });
  });
});
