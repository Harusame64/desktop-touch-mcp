/**
 * ADR-040 — the page surface: a Chromium frame's page window (Chrome_RenderWidgetHostHWND), chosen and
 * read with win2's measured rects (internal dev/306-viewport, dev/adr-040-pre).
 */
import { describe, it, expect } from "vitest";
import { selectPageRect, resolvePageSurface, pointOnSurface, PAGE_RWH_CLASS, type PageSurfaceDeps } from "../../src/engine/page-surface.js";

const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
// win2, dev/adr-040-pre (1200×800 window, inner 629×705 with DevTools docked right/left, 1184×405 bottom).
const DEVTOOLS = r(108, 187, 1184, 705);
const RIGHT = r(108, 187, 629, 705);
const LEFT = r(663, 187, 629, 705);
const BOTTOM = r(108, 187, 1184, 405);

describe("selectPageRect (ADR-040 §4.3)", () => {
  it("one page window: that one", () => {
    expect(selectPageRect([r(108, 187, 1184, 705)])).toEqual(r(108, 187, 1184, 705));
  });
  it("DevTools docked right: the page's by size, or the one inside without a size", () => {
    expect(selectPageRect([DEVTOOLS, RIGHT], { width: 629, height: 705 })).toEqual(RIGHT);
    expect(selectPageRect([DEVTOOLS, RIGHT])).toEqual(RIGHT);
  });
  it("DevTools docked left (origins differ by 555 px): the page's, not DevTools' origin", () => {
    expect(selectPageRect([DEVTOOLS, LEFT], { width: 629, height: 705 })).toEqual(LEFT);
    expect(selectPageRect([DEVTOOLS, LEFT])).toEqual(LEFT);
  });
  it("DevTools docked bottom: the page's", () => {
    expect(selectPageRect([DEVTOOLS, BOTTOM], { width: 1184, height: 405 })).toEqual(BOTTOM);
    expect(selectPageRect([DEVTOOLS, BOTTOM])).toEqual(BOTTOM);
  });
  it("two side by side (neither inside the other): the size alone picks the page's", () => {
    expect(selectPageRect([r(0, 0, 629, 705), r(640, 0, 500, 705)], { width: 500, height: 705 })).toEqual(r(640, 0, 500, 705));
  });
  it("a size within 2 px still picks it (rounding of innerWidth × DPR)", () => {
    expect(selectPageRect([DEVTOOLS, LEFT], { width: 631, height: 704 })).toEqual(LEFT);
  });
  it("DevTools undocked (two of the same rect): that rect, either is the origin", () => {
    expect(selectPageRect([RIGHT, { ...RIGHT }])).toEqual(RIGHT);
  });
  it("two that neither contains nor matches: none (cannot be told apart)", () => {
    expect(selectPageRect([r(0, 0, 100, 100), r(200, 0, 120, 100)])).toBeNull();
  });
});

function deps(over: Partial<PageSurfaceDeps> & { children?: ReturnType<PageSurfaceDeps["descendants"]> } = {}): PageSurfaceDeps {
  return {
    isIconic: over.isIconic ?? (() => false),
    isCloaked: over.isCloaked ?? (() => false),
    descendants: over.descendants ?? (() => over.children ?? []),
  };
}
const rwh = (hwnd: bigint, rect: ReturnType<typeof r>, visible = true) => ({ hwnd, className: PAGE_RWH_CLASS, visible, rect });

describe("resolvePageSurface (ADR-040 invariant 3: surface / not shown / unreadable)", () => {
  it("a frame with its page window: the surface", () => {
    const s = resolvePageSurface(1n, deps({ children: [rwh(855176n, RIGHT), rwh(1641660n, DEVTOOLS)] }), { width: 629, height: 705 });
    expect(s).toEqual({ kind: "surface", frame: 1n, rwh: 855176n, rwhs: [855176n], rect: RIGHT, others: 1 });
  });
  it("two page windows at one rect (DevTools undocked): both are the page's", () => {
    const s = resolvePageSurface(1n, deps({ children: [rwh(10n, RIGHT), rwh(11n, { ...RIGHT })] }));
    expect(s).toMatchObject({ kind: "surface", rwhs: [10n, 11n] });
  });
  it("minimized and cloaked frames are not shown", () => {
    expect(resolvePageSurface(1n, deps({ isIconic: () => true, children: [rwh(2n, RIGHT)] }))).toMatchObject({ kind: "not_shown", why: "minimized" });
    expect(resolvePageSurface(1n, deps({ isCloaked: () => true, children: [rwh(2n, RIGHT)] }))).toMatchObject({ kind: "not_shown", why: "cloaked" });
  });
  it("a covered frame (children readable, no page window): not shown", () => {
    const s = resolvePageSurface(1n, deps({ children: [{ hwnd: 3n, className: "Intermediate D3D Window", visible: true, rect: r(0, 0, 10, 10) }] }));
    expect(s).toMatchObject({ kind: "not_shown", why: "no_page_window" });
  });
  it("a hidden page window counts as none", () => {
    expect(resolvePageSurface(1n, deps({ children: [rwh(2n, RIGHT, false)] }))).toMatchObject({ kind: "not_shown" });
  });
  it("no children read at all (the walk failed or found none): unreadable, not 'not shown'", () => {
    expect(resolvePageSurface(1n, deps({ children: [] }))).toMatchObject({ kind: "unreadable", why: "no_children_read" });
    expect(resolvePageSurface(1n, deps({ descendants: () => { throw new Error("no addon"); } }))).toMatchObject({ kind: "unreadable" });
  });
  it("page windows that cannot be told apart: unreadable", () => {
    expect(resolvePageSurface(1n, deps({ children: [rwh(2n, r(0, 0, 100, 100)), rwh(3n, r(200, 0, 120, 100))] })))
      .toMatchObject({ kind: "unreadable", why: "ambiguous" });
  });
});

describe("pointOnSurface", () => {
  it("places a viewport point on the surface's origin (the #306 cell: DevTools right, centre 488 css)", () => {
    // Formula point was 766 for a centre at 488 (+278); the surface origin is the viewport's.
    expect(pointOnSurface({ rect: RIGHT }, 380, 20)).toEqual({ x: 488, y: 207 });
  });
});
