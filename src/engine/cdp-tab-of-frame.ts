/**
 * ADR-040 PR ③ (internal #319 item 2, the rest) — which CDP tab a Chromium frame shows, for a wheel aimed at
 * that frame by hwnd.
 *
 * The CDP road used to take the port's default tab whatever window was asked, so a wheel for the window
 * behind scrolled the one in front and answered delivered_via_cdp (win2, #965 W2/W4, and main b1c614e9 in
 * OQ-40-8). A tab is the frame's only when all of these hold (ADR-040 invariants 1 and 6):
 * - the frame has a page surface (a covered, minimized or cloaked window has none, and its page does not
 *   take a CDP wheel: spike S1);
 * - the tab is in a browser window whose bounds are the frame's rect;
 * - the tab answers `document.visibilityState` "visible" (one per window: the front tab's).
 * When two windows share the frame's rect (two maximized), the frame's title decides; when it cannot, no tab.
 *
 * Kept from the old road, so this takes nothing away that cannot be shown to go elsewhere:
 * - a surface that cannot be read (a renamed class, a walk that failed) does not stop the promotion; the
 *   rect and the visibility still decide (ADR-040 invariant 3: never refuse on "unreadable");
 * - when no window is at the frame's rect × its scale (a scaled secondary monitor, whose DIP origin is not
 *   its physical origin / scale), a window of the frame's size is taken instead, when it holds a tab the
 *   frame's title shows;
 * - when every tab at the rect reads hidden (the display off, the session locked: OQ-40-1) and one window is
 *   there, the one tab whose title the frame shows is still taken — it is this frame's own tab.
 *
 * Any other answer is `none`, and the caller takes the window road, which since ADR-040 PR ② points the
 * wheel at the frame's own visible page or sends none. Nothing here focuses, raises or moves anything.
 */
import { resolvePageSurface, type PageSurfaceDeps } from "./page-surface.js";
import { FRAME_BOUNDS_TOLERANCE_PX } from "./browser-frames.js";
import { isBrowserUiPage } from "./cdp-default-tab.js";
import type { Rect } from "./vision-gpu/types.js";

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TabOfFrameDeps {
  surface: PageSurfaceDeps;
  /** The frame's GetWindowRect, physical px. */
  frameRect: (frame: bigint) => Rect | null;
  /** The frame's monitor scale (DPI / 96): CDP window bounds are DIPs. */
  frameScale: (frame: bigint) => number;
  frameTitle: (frame: bigint) => string;
  /** `Browser.getWindowForTarget` for each target: its window id and bounds (DIPs). Throws when unreachable. */
  windowsOf: (targetIds: readonly string[]) => Promise<Map<string, { windowId: number; bounds?: WindowBounds }>>;
  /** The tab's `document.visibilityState`, or undefined when it gave no answer in time. */
  visibility: (tabId: string) => Promise<unknown>;
}

export type TabOfFrame =
  | { kind: "tab"; tabId: string }
  | { kind: "none"; why: "not_shown" | "unreadable" | "no_window" | "no_visible_tab" | "ambiguous" };

/**
 * Whether a frame title shows this tab's title: Chrome's "<title> - Google Chrome", Edge's
 * "<title> - Profile 1 - Microsoft Edge" and "<title> and 2 more pages - …". The title is followed by one of
 * those joins, so "Foo" is not shown by "Foo Bar - Google Chrome" (gate 2). An empty title shows nothing.
 */
function titleShows(frameTitle: string, tabTitle: string): boolean {
  return tabTitle !== "" &&
    (frameTitle === tabTitle || frameTitle.startsWith(`${tabTitle} - `) || frameTitle.startsWith(`${tabTitle} and `));
}

/** ADR-040 PR ③ — the tab `frame` shows, of the CDP browser's `tabs`. */
export async function tabOfFrame(
  frame: bigint,
  tabs: ReadonlyArray<{ id: string; title: string; url: string; type: string }>,
  deps: TabOfFrameDeps,
): Promise<TabOfFrame> {
  const surface = resolvePageSurface(frame, deps.surface);
  if (surface.kind === "not_shown") return { kind: "none", why: "not_shown" };
  try {
    const rect = deps.frameRect(frame);
    if (rect === null) return { kind: "none", why: "unreadable" };
    const scale = deps.frameScale(frame);
    // The browser's own UI (DevTools' front end docked in the window, a sign-in dialog) is not a tab.
    const pages = tabs.filter((t) => t.type === "page" && !isBrowserUiPage(t.url));
    if (pages.length === 0) return { kind: "none", why: "no_window" };
    const windows = await deps.windowsOf(pages.map((t) => t.id));
    const near = (a: number, b: number) => Math.abs(a - b) <= FRAME_BOUNDS_TOLERANCE_PX;
    const sized = pages.filter((t) => {
      const b = windows.get(t.id)?.bounds;
      return b !== undefined && near(rect.width, b.width * scale) && near(rect.height, b.height * scale);
    });
    const placed = sized.filter((t) => {
      const b = windows.get(t.id)!.bounds!;
      return near(rect.x, b.left * scale) && near(rect.y, b.top * scale);
    });
    const title = deps.frameTitle(frame);
    // By size alone, a window is this frame's only when it holds a tab the frame's title shows: another window
    // of the same size elsewhere, with this frame's own tabs left out of the answer, is not (codex on #971).
    const owned = new Set(sized.filter((t) => titleShows(title, t.title)).map((t) => windows.get(t.id)!.windowId));
    const atFrame = placed.length > 0 ? placed : sized.filter((t) => owned.has(windows.get(t.id)!.windowId));
    if (atFrame.length === 0) return { kind: "none", why: "no_window" };
    const oneWindow = new Set(atFrame.map((t) => windows.get(t.id)!.windowId)).size === 1;

    const titled = atFrame.filter((t) => titleShows(title, t.title));
    const visibleOf = async (list: typeof atFrame) => {
      const states = await Promise.all(list.map((t) => deps.visibility(t.id)));
      return list.filter((_, n) => states[n] === "visible");
    };
    // In one window, the tabs the frame's title shows are asked first: usually one, so one tab is asked,
    // not every tab of the window; the rest only when none of them answers visible (a title that changed).
    // With two windows at the rect every tab is asked, since a visible tab of the other window would
    // otherwise go unseen beside a titled one (gate 2).
    let visible: typeof atFrame;
    if (oneWindow && titled.length > 0) {
      visible = await visibleOf(titled);
      if (visible.length === 0) visible = await visibleOf(atFrame.filter((t) => !titled.includes(t)));
    } else {
      visible = await visibleOf(atFrame);
    }
    if (visible.length === 0) {
      if (oneWindow && titled.length === 1) return { kind: "tab", tabId: titled[0]!.id };
      return { kind: "none", why: "no_visible_tab" };
    }
    // In one window, its one visible tab. With two windows at the rect, a visible tab may be the other
    // window's — this frame's own can read hidden or give no answer in time while the other's is drawn — so
    // only a tab the frame's title shows is taken (agy on #971).
    if (oneWindow && visible.length === 1) return { kind: "tab", tabId: visible[0]!.id };
    const byTitle = visible.filter((t) => titleShows(title, t.title));
    if (byTitle.length === 1) return { kind: "tab", tabId: byTitle[0]!.id };
    return { kind: "none", why: "ambiguous" };
  } catch {
    return { kind: "none", why: "unreadable" };
  }
}
