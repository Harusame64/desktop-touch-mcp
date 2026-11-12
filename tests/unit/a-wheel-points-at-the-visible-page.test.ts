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
  pointAt: over.pointAt ?? ((x) => ({ child: over.visibleFromX === null ? 9n : x >= (over.visibleFromX ?? 0) ? PAGE : 9n })),
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
    expect(wheelPointOnPage(FRAME, deps({ visibleFromX: 900 }))).toEqual({ kind: "point", frame: FRAME, point: { x: 1000, y: 250 } });
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
    expect(t).toMatch(/cover every part of its page/);
    expect(t).toContain('focus_window({ hwnd: "1280" })');
    expect(t).toContain('scroll({ action: "raw", hwnd: "1280", direction: "down", amount: 3 })');
    expect(t).toMatch(/browser_eval\(\{ tabId, expression: "window\.scrollBy/);
  });
  it("on another desktop: asks for the user rather than switching it", () => {
    const t = text(pageNotVisibleScrollFailure({ frame: 0x500n, why: "cloaked" }, "up", 1) as never);
    expect(t).toMatch(/another virtual desktop/);
    expect(t).not.toContain("focus_window");
  });
});
