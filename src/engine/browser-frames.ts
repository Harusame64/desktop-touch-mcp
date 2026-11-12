/**
 * internal #305 / ADR-040 — matching a CDP tab's browser window to the OS frames. Shared by browser_click
 * (`browser.ts`) and the page surface (`page-aim.ts`), so the two cannot disagree about which window a tab
 * is in. Moved here unchanged from `browser.ts`.
 */

/** Physical px a frame's rect may differ from the tab's window bounds × scale and still be that window. */
export const FRAME_BOUNDS_TOLERANCE_PX = 3;

/**
 * internal #305 — the Chromium frame whose rect is the tab's window, or undefined unless exactly one is.
 *
 * `bounds` is `Browser.getWindowForTarget` in DIPs; the enumeration's region is GetWindowRect in
 * physical px, so each frame is compared at its own monitor's scale (`scaleOf`, DPI / 96). Not the
 * tab's devicePixelRatio: that includes the page zoom, and at 125 % zoom a window at 800×600 DIPs
 * would match another frame at 1000×750 (codex on #837). win2 measured bounds × scale equal to the
 * rect for a normal window and within 2 px for a maximized one at 150 % (−10.5 against −11), so the
 * tolerance is 3. Two frames at the same rect cannot be told apart this way, and neither can by
 * title; that answers undefined too.
 */
export function framesAtWindowBounds<T extends { region: { x: number; y: number; width: number; height: number } }>(
  frames: readonly T[],
  bounds: { left: number; top: number; width: number; height: number },
  scaleOf: (frame: T) => number,
): T[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= FRAME_BOUNDS_TOLERANCE_PX;
  return frames.filter((w) => {
    const s = scaleOf(w);
    return near(w.region.x, bounds.left * s) &&
      near(w.region.y, bounds.top * s) &&
      near(w.region.width, bounds.width * s) &&
      near(w.region.height, bounds.height * s);
  });
}

/** The one frame at the tab's window bounds, or undefined when none or several are (see above). */
export function frameForWindowBounds<T extends { region: { x: number; y: number; width: number; height: number } }>(
  frames: readonly T[],
  bounds: { left: number; top: number; width: number; height: number },
  scaleOf: (frame: T) => number,
): T | undefined {
  const hits = framesAtWindowBounds(frames, bounds, scaleOf);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * internal #305 — the frames of the CDP browser itself, when its process is known and owns any.
 *
 * Another Chromium browser (or a Chromium app) can show a window with the same title at the same
 * rect: win2 saw a click for an Edge tab go into a Chrome page that way. Without a process id, or
 * when none of the frames carries it, the frames stay as they were.
 */
export function framesOfBrowserProcess<T extends { hwnd: bigint }>(
  frames: readonly T[],
  browserPid: number | undefined,
  pidOf: (hwnd: bigint) => number,
): readonly T[] {
  if (browserPid === undefined) return frames;
  const own = frames.filter((w) => pidOf(w.hwnd) === browserPid);
  return own.length > 0 ? own : frames;
}

