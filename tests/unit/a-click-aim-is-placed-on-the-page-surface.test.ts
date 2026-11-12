/**
 * ADR-040 PR ① — the parts every browser click road uses: the aim inside the page, the tab's frame found
 * without side effects, and the point placed on the frame's page surface.
 */
import { describe, it, expect } from "vitest";
import { aimFromCoords, aimFromViewportRect, findTabFrame, alignToPageSurface, type PageAimDeps } from "../../src/engine/page-aim.js";
import { PAGE_RWH_CLASS, type PageSurfaceDeps } from "../../src/engine/page-surface.js";

describe("the aim inside the page", () => {
  it("from getElementScreenCoords: the element centre in physical px, and the viewport size", () => {
    const aim = aimFromCoords({ viewport: { left: 300, top: 0, width: 160, height: 40, innerWidth: 629, innerHeight: 705 } });
    expect(aim).toEqual({ viewportX: 380, viewportY: 20, hint: { width: 629, height: 705 } });
  });
  it("from an older evaluate without the viewport: none, so the caller's point stays", () => {
    expect(aimFromCoords({})).toBeUndefined();
  });
  it("from the by-axis resolver's css rect at dpr 1.5", () => {
    const aim = aimFromViewportRect({ x: 100, y: 10, w: 40, h: 20 }, { dpr: 1.5, innerWidth: 800, innerHeight: 600 });
    expect(aim).toEqual({ viewportX: 180, viewportY: 30, hint: { width: 1200, height: 900 } });
  });
});

const frame = (hwnd: bigint, x: number, className = "Chrome_WidgetWin_1") =>
  ({ hwnd, region: { x, y: 0, width: 800, height: 600 }, className });
function aimDeps(over: Partial<PageAimDeps> = {}): PageAimDeps {
  return {
    browserPid: async () => 4242,
    tabBounds: async () => ({ left: 900, top: 0, width: 800, height: 600 }),
    frames: () => [frame(1n, 0), frame(2n, 900)],
    pidOf: () => 4242,
    scaleOf: () => 1,
    surface: { isIconic: () => false, isCloaked: () => false, descendants: () => [] },
    ...over,
  };
}

describe("findTabFrame (no side effects)", () => {
  it("the one frame of the browser at the tab's window bounds", async () => {
    expect(await findTabFrame(9222, "T", aimDeps())).toBe(2n);
  });
  it("another browser's frame at the same bounds is not a candidate", async () => {
    const d = aimDeps({ frames: () => [frame(9n, 900), frame(2n, 900)], pidOf: (h) => (h === 9n ? 9999 : 4242) });
    expect(await findTabFrame(9222, "T", d)).toBe(2n);
  });
  it("two frames at the same rect (two maximized windows): none, the caller keeps its point", async () => {
    expect(await findTabFrame(9222, "T", aimDeps({ frames: () => [frame(1n, 900), frame(2n, 900)] }))).toBeUndefined();
  });
  it("the tab's bounds unreadable: none", async () => {
    expect(await findTabFrame(9222, "T", aimDeps({ tabBounds: async () => { throw new Error("no"); } }))).toBeUndefined();
  });
  it("a window that is not a Chromium frame is never the tab's", async () => {
    expect(await findTabFrame(9222, "T", aimDeps({ frames: () => [frame(2n, 900, "Notepad")] }))).toBeUndefined();
  });
});

const surfaceWith = (rects: Array<{ x: number; y: number; width: number; height: number }>): PageSurfaceDeps => ({
  isIconic: () => false,
  isCloaked: () => false,
  descendants: () => rects.map((rect, i) => ({ hwnd: BigInt(100 + i), className: PAGE_RWH_CLASS, visible: true, rect })),
});

describe("alignToPageSurface", () => {
  const aim = { viewportX: 380, viewportY: 20, hint: { width: 629, height: 705 } };
  it("places the aim on the page window: DevTools docked left (the page's origin is 663, not 108)", () => {
    const d = surfaceWith([{ x: 108, y: 187, width: 1184, height: 705 }, { x: 663, y: 187, width: 629, height: 705 }]);
    expect(alignToPageSurface(2n, aim, { x: 0, y: 0 }, d).point).toEqual({ x: 1043, y: 207 });
  });
  it("no frame or no aim: the fallback point", () => {
    const d = surfaceWith([{ x: 108, y: 187, width: 629, height: 705 }]);
    expect(alignToPageSurface(undefined, aim, { x: 5, y: 6 }, d).point).toEqual({ x: 5, y: 6 });
    expect(alignToPageSurface(2n, undefined, { x: 5, y: 6 }, d).point).toEqual({ x: 5, y: 6 });
  });
  it("a surface that is not shown: the fallback point, and it says why", () => {
    const d: PageSurfaceDeps = { isIconic: () => true, isCloaked: () => false, descendants: () => [] };
    const r = alignToPageSurface(2n, aim, { x: 5, y: 6 }, d);
    expect(r.point).toEqual({ x: 5, y: 6 });
    expect(r.surface).toMatchObject({ kind: "not_shown", why: "minimized" });
  });
});
