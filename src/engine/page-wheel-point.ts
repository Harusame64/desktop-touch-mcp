/**
 * ADR-040 PR ② (internal #396) — the screen point a window-road wheel carries for a Chromium window.
 *
 * Chromium sends a posted WM_MOUSEWHEEL to whatever window is under its lParam point, not to the window it
 * was posted to (win2, dev/adr-040-pr2-pre, OQ-40-8): posted to the back window's page window at a point
 * the front window covers, the front window scrolled 0→1200 and the back one not at all; at a point only
 * the back window showed, only the back one scrolled. So every post for a Chromium window carries a point
 * where its own page is visible, and when there is none nothing is posted (ADR-040 invariant 5).
 *
 * Three answers, as the page surface's (invariant 3): a point; `not_visible` (the page is not on screen
 * anywhere it could be reached); and `keep` (not a Chromium window, or it could not be read), where the
 * caller keeps its own point, as before. Nothing here focuses, raises or moves anything.
 */
import { PAGE_RWH_CLASS, resolvePageSurface, type PageSurfaceDeps } from "./page-surface.js";

/** The top-level class of Chrome, Edge and Electron windows. */
export const CHROMIUM_FRAME_CLASS = "Chrome_WidgetWin_1";

export type WheelPagePoint =
  | { kind: "keep" }
  | { kind: "point"; frame: bigint; point: { x: number; y: number } }
  | { kind: "not_visible"; frame: bigint; why: "covered" | "minimized" | "cloaked" | "no_page_window" };

export interface WheelPointDeps {
  rootOf: (hwnd: bigint) => bigint | null;
  classOf: (hwnd: bigint) => string;
  /** WindowFromPoint's child and its root; undefined when it cannot be asked, null when nothing is there. */
  pointAt: (x: number, y: number) => { child: bigint; root: bigint } | null | undefined;
  /** The frame's own rect, for the one point a frame without a page window is asked at. */
  rectOf: (hwnd: bigint) => { x: number; y: number; width: number; height: number } | null;
  surface: PageSurfaceDeps;
}

/**
 * Fractions of the page's width and height tried: the centre first, then a 7×7 grid whose outer lines lie
 * 2 % in from the edges, so a strip left showing along an edge is found (gate 2 on #969). Exported for tests.
 */
const GRID = [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.98];
export const WHEEL_POINT_FRACTIONS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  ...GRID.flatMap((fy) => GRID.map((fx) => [fx, fy] as const)).filter(([fx, fy]) => !(fx === 0.5 && fy === 0.5)),
];

/** ADR-040 PR ② — where to point a posted wheel for `hwnd` (a frame or one of its children). */
export function wheelPointOnPage(hwnd: bigint, deps: WheelPointDeps): WheelPagePoint {
  let frame: bigint;
  try {
    frame = deps.rootOf(hwnd) ?? hwnd;
    if (deps.classOf(frame) !== CHROMIUM_FRAME_CLASS) return { kind: "keep" };
  } catch {
    return { kind: "keep" };
  }
  const surface = resolvePageSurface(frame, deps.surface);
  if (surface.kind === "unreadable") return { kind: "keep" };
  if (surface.kind === "not_shown") {
    if (surface.why !== "no_page_window") return { kind: "not_visible", frame, why: surface.why };
    // No page window does not by itself prove the window is covered: a window just brought forward, or a
    // Chromium window that draws no page (Task Manager), has none either, and a wheel at its centre worked
    // before (gate 2 on #969; the same reading as browser_click's, PR #967 P12). Refuse only when another
    // window is what Windows finds at that centre, as when it covers all of it (win2 OQ-40-8 Q3).
    const r = deps.rectOf(frame);
    if (r === null) return { kind: "keep" };
    const at = deps.pointAt(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    if (at === undefined || (at !== null && at.root === frame)) return { kind: "keep" };
    return { kind: "not_visible", frame, why: "no_page_window" };
  }
  const { x, y, width, height } = surface.rect;
  let asked = 0;
  for (const [fx, fy] of WHEEL_POINT_FRACTIONS) {
    const point = { x: Math.round(x + width * fx), y: Math.round(y + height * fy) };
    const at = deps.pointAt(point.x, point.y);
    // Could not ask at this point. When the centre could not be asked either, keep the caller's point rather
    // than refuse on a missing instrument; once the centre was read as covered, falling back to it would
    // post at a point known to be another window's (gate 2 on #969), so try the next one.
    if (at === undefined) {
      if (asked === 0) return { kind: "keep" };
      continue;
    }
    asked += 1;
    // Visible when this frame is the window there and the child is not another page window (DevTools' own,
    // which Chromium would hand the wheel). A child inside the page window counts as the page (gate 2).
    if (at !== null && at.root === frame && (surface.rwhs.includes(at.child) || deps.classOf(at.child) !== PAGE_RWH_CLASS)) {
      return { kind: "point", frame, point };
    }
  }
  return { kind: "not_visible", frame, why: "covered" };
}
