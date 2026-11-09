/**
 * Bring a window to the front for a tool that then sends keys to it and reads the screen, and say
 * whether it got there.
 *
 * internal #326 (measured by win2 2026-11-09): `scroll(action='capture')` called
 * `restoreAndFocusWindow` and went on whatever happened. On a first call Windows refused the
 * foreground, so Ctrl+Home and PageDown went into the window that was in front (a terminal), the
 * frames showed that window, and the capture answered ok:true with one frame. This follows the
 * keyboard tool's ladder (`focusWindowForKeyboard`): ask, wait, check; escalate to the forced
 * (AttachThreadInput) path; check again. The caller refuses when it is still not in front.
 */
import { restoreAndFocusWindow, getForegroundHwnd, getWindowRoot } from "../engine/win32.js";

export interface BroughtForward {
  /** The window (or a window of its top-level tree) is in front. */
  ok: boolean;
  /** The forced path was needed (or tried). */
  forced: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

const SETTLE_MS = 100;

function inFront(hwnd: bigint): boolean {
  const fg = getForegroundHwnd();
  if (fg == null) return false;
  const root = (h: bigint) => getWindowRoot(h) ?? h;
  return root(fg) === root(hwnd);
}

export async function bringForward(hwnd: bigint, settleMs = SETTLE_MS): Promise<BroughtForward> {
  let r = restoreAndFocusWindow(hwnd);
  await new Promise<void>((done) => setTimeout(done, settleMs));
  if (inFront(hwnd)) return { ok: true, forced: false, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  r = restoreAndFocusWindow(hwnd, { force: true });
  await new Promise<void>((done) => setTimeout(done, settleMs));
  return { ok: inFront(hwnd), forced: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
}

/** The hint a refusal carries: nothing was sent, nothing was captured. */
export const NOT_IN_FRONT_HINT =
  "Windows refused to bring the window to the front (both the normal request and the forced one), so no keys were sent " +
  "and nothing was captured: keys sent now would go to the window in front. Click the window or bring it forward, then try again.";
