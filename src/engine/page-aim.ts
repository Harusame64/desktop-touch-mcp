/**
 * ADR-040 PR ① — a browser click point placed on the page surface (the frame's page RWH), not on the
 * page-side formula `window.screenX + (outerWidth − innerWidth) / 2` (#306: +278 px with DevTools docked
 * right, −122 px with Edge's vertical tabs).
 *
 * Every road that clicks a page element with the OS cursor builds a `PageAim` (the element centre inside
 * the viewport, physical px, and the viewport's size) and asks `alignToPageSurface` for the screen point.
 * When the surface cannot be read the point stays the formula's, as before (ADR-040 invariant 3). Nothing
 * here focuses, raises or moves anything.
 */
import { getBrowserProcessId, getTabWindowBounds } from "./cdp-bridge.js";
import { enumWindowsInZOrder, getWindowDpi, getWindowProcessId, pageSurfaceDeps } from "./win32.js";
import { frameForWindowBounds, framesOfBrowserProcess } from "./browser-frames.js";
import { resolvePageSurface, pointOnSurface, type PageSurface, type PageSurfaceDeps } from "./page-surface.js";

/** Where a click goes inside the page, independent of where the page sits on screen. */
export interface PageAim {
  /** Element centre from the viewport's top left, physical px (css × devicePixelRatio). */
  viewportX: number;
  viewportY: number;
  /** The viewport's size in physical px (innerWidth/innerHeight × devicePixelRatio): picks the page RWH. */
  hint: { width: number; height: number };
}

/** A `PageAim` from getElementScreenCoords' result, or undefined when an older evaluate did not return the viewport. */
export function aimFromCoords(c: {
  viewport?: { left: number; top: number; width: number; height: number; innerWidth: number; innerHeight: number };
}): PageAim | undefined {
  const v = c.viewport;
  if (v === undefined) return undefined;
  return { viewportX: v.left + v.width / 2, viewportY: v.top + v.height / 2, hint: { width: v.innerWidth, height: v.innerHeight } };
}

/** A `PageAim` from the by-axis resolver's viewport rect (css px) and its gather metrics. */
export function aimFromViewportRect(
  rect: { x: number; y: number; w: number; h: number },
  vp: { dpr: number; innerWidth: number; innerHeight: number },
): PageAim {
  return {
    viewportX: (rect.x + rect.w / 2) * vp.dpr,
    viewportY: (rect.y + rect.h / 2) * vp.dpr,
    hint: { width: Math.round(vp.innerWidth * vp.dpr), height: Math.round(vp.innerHeight * vp.dpr) },
  };
}

export interface PageAimDeps {
  browserPid: (port: number) => Promise<number>;
  tabBounds: (tabId: string | null, port: number) => Promise<{ left: number; top: number; width: number; height: number }>;
  frames: () => Array<{ hwnd: bigint; region: { x: number; y: number; width: number; height: number }; className?: string }>;
  pidOf: (hwnd: bigint) => number;
  scaleOf: (hwnd: bigint) => number;
  surface: PageSurfaceDeps;
}

const realDeps: PageAimDeps = {
  browserPid: (port) => getBrowserProcessId(port),
  tabBounds: (tabId, port) => getTabWindowBounds(tabId, port),
  frames: () => enumWindowsInZOrder(),
  pidOf: getWindowProcessId,
  scaleOf: (hwnd) => getWindowDpi(hwnd) / 96,
  surface: pageSurfaceDeps,
};

const isChromiumFrame = (w: { className?: string }): boolean =>
  w.className === undefined || w.className === "" || w.className === "Chrome_WidgetWin_1";

/**
 * The browser frame the tab is in, without focusing anything: the CDP browser's own frames (its process,
 * when known) and the one frame at the tab's window bounds (internal #305). Undefined when none or several
 * are — two maximized windows share a rect — and the caller keeps the formula's point.
 */
export async function findTabFrame(port: number, tabId: string | null, deps: PageAimDeps = realDeps): Promise<bigint | undefined> {
  const [pid, bounds] = await Promise.all([
    deps.browserPid(port).catch(() => undefined),
    deps.tabBounds(tabId, port).catch(() => undefined),
  ]);
  if (bounds === undefined) return undefined;
  const frames = framesOfBrowserProcess(deps.frames().filter(isChromiumFrame), pid, deps.pidOf);
  return frameForWindowBounds(frames, bounds, (w) => deps.scaleOf(w.hwnd))?.hwnd;
}

/**
 * The screen point for `aim` on the frame's page surface, and the surface it was placed on. When the
 * surface is not shown or cannot be read, `point` is `fallback` (the formula's) and `surface` says why.
 */
export function alignToPageSurface(
  frame: bigint | undefined,
  aim: PageAim | undefined,
  fallback: { x: number; y: number },
  deps: PageSurfaceDeps = realDeps.surface,
): { point: { x: number; y: number }; surface: PageSurface | null } {
  if (frame === undefined || aim === undefined) return { point: fallback, surface: null };
  const surface = resolvePageSurface(frame, deps, aim.hint);
  if (surface.kind !== "surface") return { point: fallback, surface };
  return { point: pointOnSurface(surface, aim.viewportX, aim.viewportY), surface };
}
