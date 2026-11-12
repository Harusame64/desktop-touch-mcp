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
 * Any other answer is `none`, and the caller takes the window road, which since ADR-040 PR ② points the
 * wheel at the frame's own visible page or sends none. Nothing here focuses, raises or moves anything.
 */
import { resolvePageSurface, type PageSurfaceDeps } from "./page-surface.js";
import { framesAtWindowBounds } from "./browser-frames.js";
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
 * "<title> - Profile 1 - Microsoft Edge" and "<title> and 2 more pages - …". An empty title shows nothing.
 */
function titleShows(frameTitle: string, tabTitle: string): boolean {
  return tabTitle !== "" && (frameTitle === tabTitle || frameTitle.startsWith(`${tabTitle} `));
}

/** ADR-040 PR ③ — the tab `frame` shows, of the CDP browser's `tabs`. */
export async function tabOfFrame(
  frame: bigint,
  tabs: ReadonlyArray<{ id: string; title: string; url: string; type: string }>,
  deps: TabOfFrameDeps,
): Promise<TabOfFrame> {
  const surface = resolvePageSurface(frame, deps.surface);
  if (surface.kind === "not_shown") return { kind: "none", why: "not_shown" };
  if (surface.kind === "unreadable") return { kind: "none", why: "unreadable" };
  try {
    const rect = deps.frameRect(frame);
    if (rect === null) return { kind: "none", why: "unreadable" };
    const scale = deps.frameScale(frame);
    // The browser's own UI (DevTools' front end docked in the window, a sign-in dialog) is not a tab.
    const pages = tabs.filter((t) => t.type === "page" && !isBrowserUiPage(t.url));
    if (pages.length === 0) return { kind: "none", why: "no_window" };
    const windows = await deps.windowsOf(pages.map((t) => t.id));
    const atFrame = pages.filter((t) => {
      const b = windows.get(t.id)?.bounds;
      return b !== undefined && framesAtWindowBounds([{ region: rect }], b, () => scale).length === 1;
    });
    if (atFrame.length === 0) return { kind: "none", why: "no_window" };

    // The tabs the frame's title shows are asked first: usually one, so one tab is asked, not every tab
    // of the window. When none of them answers visible (a title that changed, an Edge title), the rest are.
    const title = deps.frameTitle(frame);
    const titled = atFrame.filter((t) => titleShows(title, t.title));
    const visibleOf = async (list: typeof atFrame) => {
      const states = await Promise.all(list.map((t) => deps.visibility(t.id)));
      return list.filter((_, n) => states[n] === "visible");
    };
    let visible = titled.length > 0 ? await visibleOf(titled) : [];
    if (visible.length === 0) visible = await visibleOf(atFrame.filter((t) => !titled.includes(t)));
    if (visible.length === 0) return { kind: "none", why: "no_visible_tab" };
    if (visible.length === 1) return { kind: "tab", tabId: visible[0]!.id };
    // Two windows at the frame's rect each showing a tab (two maximized, both drawn): only the title can
    // tell which is this frame's, and it did not.
    const byTitle = visible.filter((t) => titleShows(title, t.title));
    if (byTitle.length === 1) return { kind: "tab", tabId: byTitle[0]!.id };
    return { kind: "none", why: "ambiguous" };
  } catch {
    return { kind: "none", why: "unreadable" };
  }
}
