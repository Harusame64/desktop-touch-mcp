/**
 * ADR-040 PR ② (internal #396) — the point a posted wheel carries for a Chromium window, and the refusal
 * when its page is visible nowhere. win2 OQ-40-8: Chromium sends a posted wheel to the window under its
 * point, so a covered point scrolls the window in front.
 */
import { describe, it, expect } from "vitest";
import { wheelPointOnPage, type WheelPointDeps } from "../../src/engine/page-wheel-point.js";
import { pageNotVisibleScrollFailure } from "../../src/tools/mouse.js";

const FRAME = 1n;
const PAGE = 2n;
const RECT = { x: 100, y: 200, width: 1000, height: 500 };
const deps = (over: Partial<WheelPointDeps> & { iconic?: boolean; cloaked?: boolean; visibleFromX?: number | null } = {}): WheelPointDeps => ({
  rootOf: over.rootOf ?? (() => FRAME),
  classOf: over.classOf ?? (() => "Chrome_WidgetWin_1"),
  // 9n: the front window's page window (another frame's).
  pointAt: over.pointAt ?? ((x) => (over.visibleFromX !== null && x >= (over.visibleFromX ?? 0) ? { child: PAGE, root: FRAME } : { child: 9n, root: 8n })),
  rectOf: over.rectOf ?? (() => ({ x: 90, y: 100, width: 1020, height: 610 })),
  surface: over.surface ?? {
    isIconic: () => over.iconic ?? false,
    isCloaked: () => over.cloaked ?? false,
    descendants: () => [{ hwnd: PAGE, className: "Chrome_RenderWidgetHostHWND", visible: true, rect: RECT }],
  },
});

describe("wheelPointOnPage", () => {
  it("the page's centre when it shows", () => {
    expect(wheelPointOnPage(PAGE, deps())).toEqual({ kind: "point", frame: FRAME, point: { x: 600, y: 450 } });
  });
  it("a visible part when the centre is covered", () => {
    expect(wheelPointOnPage(FRAME, deps({ visibleFromX: 900 }))).toEqual({ kind: "point", frame: FRAME, point: { x: 1000, y: 210 } });
  });
  it("a strip along the right edge, narrower than the inner grid: found (gate 2 on #969)", () => {
    // Visible only from x 1075 (97.5 % of the page): the 0.98 line, x 1080.
    expect(wheelPointOnPage(FRAME, deps({ visibleFromX: 1075 }))).toMatchObject({ kind: "point", point: { x: 1080 } });
  });
  it("a child window inside the page window counts as the page; DevTools' page window does not", () => {
    const child = deps({ pointAt: () => ({ child: 3n, root: FRAME }), classOf: (h) => (h === 3n ? "Chrome_WidgetWin_0" : "Chrome_WidgetWin_1") });
    expect(wheelPointOnPage(FRAME, child)).toMatchObject({ kind: "point" });
    const devtools = deps({ pointAt: () => ({ child: 4n, root: FRAME }), classOf: (h) => (h === 4n ? "Chrome_RenderWidgetHostHWND" : "Chrome_WidgetWin_1") });
    expect(wheelPointOnPage(FRAME, devtools)).toMatchObject({ kind: "not_visible", why: "covered" });
  });
  it("the point query fails after the centre was read as covered: the next points are tried, not the centre", () => {
    let n = 0;
    const flaky = deps({ pointAt: (x) => { n += 1; if (n === 1) return { child: 9n, root: 8n }; if (n === 2) return undefined; return x >= 900 ? { child: PAGE, root: FRAME } : { child: 9n, root: 8n }; } });
    expect(wheelPointOnPage(FRAME, flaky)).toMatchObject({ kind: "point" });
    let m = 0;
    const allFail = deps({ pointAt: () => { m += 1; return m === 1 ? { child: 9n, root: 8n } : undefined; } });
    expect(wheelPointOnPage(FRAME, allFail)).toMatchObject({ kind: "not_visible", why: "covered" });
  });
  it("no page window: kept when the frame itself is at its centre (just raised, or a page-less window), refused when another window is", () => {
    const noPage = { isIconic: () => false, isCloaked: () => false, descendants: () => [{ hwnd: 7n, className: "Intermediate D3D Window", visible: true, rect: RECT }] };
    expect(wheelPointOnPage(FRAME, deps({ surface: noPage, pointAt: () => ({ child: 7n, root: FRAME }) }))).toEqual({ kind: "keep" });
    expect(wheelPointOnPage(FRAME, deps({ surface: noPage, pointAt: () => ({ child: 9n, root: 8n }) }))).toEqual({ kind: "not_visible", frame: FRAME, why: "no_page_window" });
    expect(wheelPointOnPage(FRAME, deps({ surface: noPage, pointAt: () => undefined }))).toEqual({ kind: "keep" });
  });
  it("visible nowhere, minimized, on another desktop: not visible", () => {
    expect(wheelPointOnPage(FRAME, deps({ visibleFromX: null }))).toEqual({ kind: "not_visible", frame: FRAME, why: "covered" });
    expect(wheelPointOnPage(FRAME, deps({ iconic: true }))).toMatchObject({ kind: "not_visible", why: "minimized" });
    expect(wheelPointOnPage(FRAME, deps({ cloaked: true }))).toMatchObject({ kind: "not_visible", why: "cloaked" });
  });
  it("not a Chromium window, or one that cannot be read: keep the caller's point", () => {
    expect(wheelPointOnPage(FRAME, deps({ classOf: () => "XLMAIN" }))).toEqual({ kind: "keep" });
    expect(wheelPointOnPage(FRAME, deps({ classOf: () => { throw new Error("gone"); } }))).toEqual({ kind: "keep" });
    expect(wheelPointOnPage(FRAME, deps({ surface: { isIconic: () => false, isCloaked: () => false, descendants: () => [] } }))).toEqual({ kind: "keep" });
    expect(wheelPointOnPage(FRAME, deps({ pointAt: () => undefined }))).toEqual({ kind: "keep" });
  });
});

describe("the refusal gives a road on (ADR-040 invariant 8)", () => {
  const text = (r: { content: Array<{ type: string; text?: string }> }) => {
    const j = JSON.parse(r.content[0]!.text!) as { error: string; suggest?: string[] };
    return [j.error, ...(j.suggest ?? [])].join("\n");
  };
  it("covered: nothing was scrolled, why, the next calls with their values, and a road that moves no window", () => {
    const t = text(pageNotVisibleScrollFailure({ frame: 0x500n, why: "covered" }, "down", 3) as never);
    expect(t).toMatch(/Nothing was scrolled/);
    expect(t).toMatch(/cover every point of its page that was tried/);
    // focus_window by hwnd names exactly this window (internal #401).
    expect(t).toContain('focus_window({ hwnd: "1280" })');
    expect(t).toContain('scroll({ action: "raw", hwnd: "1280", direction: "down", amount: 3 })');
    // browser_eval's union needs action:"js" (codex on #969).
    expect(t).toContain('browser_eval({ action: "js", tabId: "<its tabId from browser_open>", expression: "window.scrollBy(0, 300)" })');
    // The tool that lists tabs is browser_open; browser_connect is no longer registered (agy on #969).
    expect(t).toContain("browser_open lists its tabs");
    expect(t).not.toContain("browser_connect");
  });
  it("the script road scrolls the way and about the distance asked (gate 2 on #969)", () => {
    expect(text(pageNotVisibleScrollFailure({ frame: 1n, why: "covered" }, "up", 5) as never)).toContain("window.scrollBy(0, -500)");
    expect(text(pageNotVisibleScrollFailure({ frame: 1n, why: "covered" }, "left", 2) as never)).toContain("window.scrollBy(-200, 0)");
  });
  it("carries the call's warnings (an ambiguous title)", () => {
    const r = pageNotVisibleScrollFailure({ frame: 1n, why: "covered" }, "down", 1, ["2 windows match"]) as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toContain("2 windows match");
  });
  it("on another desktop: asks for the user rather than switching it", () => {
    const t = text(pageNotVisibleScrollFailure({ frame: 0x500n, why: "cloaked" }, "up", 1) as never);
    expect(t).toMatch(/another virtual desktop/);
    expect(t).not.toContain("focus_window");
  });
});
