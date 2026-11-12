/**
 * ADR-040 — the page surface: the child window a Chromium frame draws its front tab's page in
 * (`Chrome_RenderWidgetHostHWND`, "RWH"), and its rect on screen.
 *
 * Measured by win2 (internal dev/306-viewport, dev/browser-root-spike, dev/adr-040-pre):
 * - the page RWH's client origin is the page viewport's origin, to 0 px, in every layout measured
 *   (normal, maximized, DevTools docked right/left/bottom or undocked, zoom 125 %, two tabs, Edge's
 *   vertical tabs). The page-side formula `screenX + (outerWidth − innerWidth) / 2` was 278 px off with
 *   DevTools docked right, −277 left, −122.5 with Edge's vertical tabs (#306);
 * - its `GetWindowRect` is its `ClientToScreen(0,0)` and `GetClientRect` size (no frame of its own);
 * - with DevTools docked there are two RWH: DevTools' covers the whole content area and the page's is
 *   inside it, its size `innerWidth`×DPR × `innerHeight`×DPR. Docked left, their origins differ (the
 *   page's is 555 px right of DevTools'), so the page's is chosen by size, or as the one inside;
 * - a window that is covered by another, or minimized, has no RWH at all, and its page reads hidden;
 *   a background tab has none either (one RWH per window, the front tab's).
 *
 * Three answers, kept apart (ADR-040 invariant 3): a surface; `not_shown` (minimized, on another
 * virtual desktop, or no RWH while the frame's other children read); and `unreadable` (nothing could
 * be read, or the candidates cannot be told apart). A caller falls back to its old road on
 * `unreadable` — it never refuses on it — so a renamed class cannot turn into refusing every click.
 */
import type { Rect } from "./vision-gpu/types.js";

export const PAGE_RWH_CLASS = "Chrome_RenderWidgetHostHWND";

/** px two sizes may differ by and still be the page's (rounding of innerWidth × DPR). */
const SIZE_TOLERANCE_PX = 2;

export type PageSurface =
  | { kind: "surface"; frame: bigint; rwh: bigint; rect: Rect }
  | { kind: "not_shown"; frame: bigint; why: "minimized" | "cloaked" | "no_page_window" }
  | { kind: "unreadable"; frame: bigint; why: "no_children_read" | "ambiguous" };

export interface PageSurfaceDeps {
  isIconic: (hwnd: bigint) => boolean;
  isCloaked: (hwnd: bigint) => boolean;
  /** The frame's descendant windows, each with its class, visibility and screen rect. Throws when the walk fails. */
  descendants: (frame: bigint) => Array<{ hwnd: bigint; className: string; visible: boolean; rect: Rect | null }>;
}

/** The page size a surface must have, in physical px: the tab's `innerWidth`×DPR × `innerHeight`×DPR. */
export interface PageSizeHint {
  width: number;
  height: number;
}

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Of a frame's RWH rects, the page's (ADR-040 §4.3 step 3), or null when they cannot be told apart.
 * Exported for tests.
 */
export function selectPageRect(rects: readonly Rect[], hint?: PageSizeHint): Rect | null {
  if (rects.length === 0) return null;
  if (rects.length === 1) return rects[0]!;
  if (hint !== undefined) {
    const sized = rects.filter((r) =>
      Math.abs(r.width - hint.width) <= SIZE_TOLERANCE_PX && Math.abs(r.height - hint.height) <= SIZE_TOLERANCE_PX);
    if (sized.length === 1) return sized[0]!;
    if (sized.length > 1 && sized.every((r) => sameRect(r, sized[0]!))) return sized[0]!;
  }
  // DevTools' RWH covers the whole content area and the page's is inside it (right, bottom, left docks).
  const inside = rects.filter((r) => rects.some((o) => o !== r && contains(o, r) && !sameRect(o, r)));
  if (inside.length === 1) return inside[0]!;
  // Undocked DevTools: two of the same rect; either is the page's origin.
  if (rects.every((r) => sameRect(r, rects[0]!))) return rects[0]!;
  return null;
}

/** ADR-040 §4.3 — the page surface of a Chromium frame. No side effects. */
export function resolvePageSurface(frame: bigint, deps: PageSurfaceDeps, hint?: PageSizeHint): PageSurface {
  try {
    if (deps.isIconic(frame)) return { kind: "not_shown", frame, why: "minimized" };
    if (deps.isCloaked(frame)) return { kind: "not_shown", frame, why: "cloaked" };
  } catch {
    return { kind: "unreadable", frame, why: "no_children_read" };
  }
  let children: ReturnType<PageSurfaceDeps["descendants"]>;
  try {
    children = deps.descendants(frame);
  } catch {
    return { kind: "unreadable", frame, why: "no_children_read" };
  }
  if (children.length === 0) return { kind: "unreadable", frame, why: "no_children_read" };
  const rwh = children.filter((c) => c.className === PAGE_RWH_CLASS && c.visible && c.rect !== null);
  if (rwh.length === 0) return { kind: "not_shown", frame, why: "no_page_window" };
  const rect = selectPageRect(rwh.map((c) => c.rect!), hint);
  if (rect === null) return { kind: "unreadable", frame, why: "ambiguous" };
  const owner = rwh.find((c) => sameRect(c.rect!, rect))!;
  return { kind: "surface", frame, rwh: owner.hwnd, rect };
}

/**
 * A point inside the page from its viewport-relative position (physical px from the viewport's top left),
 * placed on the surface's origin. ADR-040 invariant 2: the origin is the RWH's, not `window.screenX`.
 */
export function pointOnSurface(surface: { rect: Rect }, viewportX: number, viewportY: number): { x: number; y: number } {
  return { x: Math.round(surface.rect.x + viewportX), y: Math.round(surface.rect.y + viewportY) };
}
