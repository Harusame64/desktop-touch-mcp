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
  /** WindowFromPoint's child under the point; undefined when it cannot be asked, null when nothing is there. */
  pointAt: (x: number, y: number) => { child: bigint } | null | undefined;
  surface: PageSurfaceDeps;
}

/** Fractions of the page's width and height tried, centre first, then a 5×5 grid. Exported for tests. */
export const WHEEL_POINT_FRACTIONS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  ...[0.1, 0.3, 0.5, 0.7, 0.9].flatMap((fy) => [0.1, 0.3, 0.5, 0.7, 0.9].map((fx) => [fx, fy] as const)),
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
  if (surface.kind === "not_shown") return { kind: "not_visible", frame, why: surface.why };
  const { x, y, width, height } = surface.rect;
  for (const [fx, fy] of WHEEL_POINT_FRACTIONS) {
    const point = { x: Math.round(x + width * fx), y: Math.round(y + height * fy) };
    const at = deps.pointAt(point.x, point.y);
    // Could not ask Windows who is there: keep the caller's point rather than refuse on a missing instrument.
    if (at === undefined) return { kind: "keep" };
    if (at !== null && surface.rwhs.includes(at.child)) return { kind: "point", frame, point };
  }
  return { kind: "not_visible", frame, why: "covered" };
}

export { PAGE_RWH_CLASS };
