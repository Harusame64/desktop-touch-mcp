/**
 * Bring a window to the front for a tool that then sends keys to it and reads the screen, and say
 * whether it got there.
 *
 * internal #326 (measured by win2 2026-11-09): `scroll(action='capture')` called
 * `restoreAndFocusWindow` and went on whatever happened. On a first call Windows refused the
 * foreground, so Ctrl+Home and PageDown went into the window that was in front (a terminal), the
 * frames showed that window, and the capture answered ok:true with one frame. This follows the
 * keyboard tool's ladder (`focusWindowForKeyboard`): ask, wait, check; with `force`, ask again on
 * the forced (AttachThreadInput) path and check again. The caller refuses or stops when it is not in
 * front.
 *
 * A window on another virtual desktop is not brought forward at all (internal #221): that would
 * switch the user's desktop. "In front" is the foreground window's top-level root (GA_ROOT) being the
 * target's: an owned dialog of the target in front is not the target, since keys would go to the
 * dialog — the refusal names what is in front instead.
 */
import { restoreAndFocusWindow, getForegroundHwnd, getWindowRoot, enumWindowsInZOrder, getWindowTitleW } from "../engine/win32.js";
import { offDesktopTarget, type OffDesktopTarget } from "./_off-desktop.js";
import { disabledByDialog, type BlockedByDialogTarget } from "./_blocked-by-dialog.js";

export interface BroughtForward {
  /** The target's top-level window is the foreground window. */
  ok: boolean;
  /** The forced path was tried. */
  forced: boolean;
  /** The target is on another virtual desktop: nothing was focused. */
  offDesktop?: OffDesktopTarget;
  /**
   * internal #381: the target is disabled by its own dialog: nothing was focused. Brought forward, it
   * stayed disabled in front of its dialog, took the dialog's focus, and the capture got one frame
   * (win2 S1/S2, dev/380-design-spike b7a8bbee).
   */
  blockedByDialog?: BlockedByDialogTarget;
  /** The title of the window in front when `ok` is false. */
  inFrontTitle?: string;
  rect: { x: number; y: number; width: number; height: number };
}

const SETTLE_MS = 100;

/** Whether the target's top-level window is the foreground window now. */
export function stillInFront(hwnd: bigint): boolean {
  const fg = getForegroundHwnd();
  if (fg == null) return false;
  const root = (h: bigint) => getWindowRoot(h) ?? h;
  return root(fg) === root(hwnd);
}

/** The title of the foreground window, for a refusal's `inFront`. */
export function inFrontTitle(): string | undefined {
  const fg = getForegroundHwnd();
  if (fg == null) return undefined;
  try {
    return getWindowTitleW(fg) || undefined;
  } catch {
    return undefined;
  }
}

export async function bringForward(
  hwnd: bigint,
  opts: { force: boolean; named?: string; settleMs?: number },
): Promise<BroughtForward> {
  const settle = opts.settleMs ?? SETTLE_MS;
  const windows = enumWindowsInZOrder();
  const listed = windows.find((w) => w.hwnd === hwnd);
  const away = listed ? await offDesktopTarget(listed, windows, opts.named) : null;
  if (away) return { ok: false, forced: false, offDesktop: away, rect: { x: 0, y: 0, width: 0, height: 0 } };
  const blocked = listed ? disabledByDialog(listed) : null;
  if (blocked) return { ok: false, forced: false, blockedByDialog: blocked, rect: { x: 0, y: 0, width: 0, height: 0 } };

  let r = restoreAndFocusWindow(hwnd);
  await new Promise<void>((done) => setTimeout(done, settle));
  const rectOf = () => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  if (stillInFront(hwnd)) return { ok: true, forced: false, rect: rectOf() };
  if (!opts.force) return { ok: false, forced: false, inFrontTitle: inFrontTitle(), rect: rectOf() };
  r = restoreAndFocusWindow(hwnd, { force: true });
  await new Promise<void>((done) => setTimeout(done, settle));
  if (stillInFront(hwnd)) return { ok: true, forced: true, rect: rectOf() };
  return { ok: false, forced: true, inFrontTitle: inFrontTitle(), rect: rectOf() };
}

/** The hint a refusal carries: nothing was sent, nothing was captured. */
export const NOT_IN_FRONT_HINT =
  "Windows did not bring the window to the front, so no keys were sent: keys sent now would go to the window in front " +
  "(inFront). Close or answer that window, or click the target window, then try again.";

/** Said when read stopped because the window, which takes page keys only in front, never came to the front. */
export const NEVER_IN_FRONT_READ_NOTE =
  "Windows did not bring the window to the front, and this window takes page keys only while it is in front, so " +
  "reading stopped there instead of sending keys to another window. What was read is complete; click " +
  "the target window (or close the window in front), then call again for the rest.";

/** Said when read stopped because the window, which takes page keys only in front, is on another virtual desktop. */
export const BLOCKED_BY_DIALOG_READ_NOTE =
  "The window is disabled while a dialog it opened is in front, and keys sent to it would reach the dialog. It was " +
  "not brought forward and no page keys were sent, so reading stopped after what it showed. Finish or close the " +
  "dialog, then call again for the rest.";

export const OTHER_DESKTOP_READ_NOTE =
  "The window is on another virtual desktop and takes page keys only while it is in front. Bringing it forward " +
  "would switch the user's desktop, so reading stopped after what could be read without keys. Move the window to " +
  "this desktop (or ask the user to switch), then call again for the rest.";

/** Said when capture lost the front after it was brought forward and before any key was sent. */
export const LOST_FRONT_BEFORE_ANY_KEY_HINT =
  "The window came to the front but stopped being in front before any key was sent, so nothing was sent and " +
  "nothing was captured: keys sent now would go to the window in front (inFront). Bring the window forward and " +
  "call again.";

/** Said when capture lost the front after Ctrl+Home went to the target and before the first frame. */
export const LOST_FRONT_BEFORE_FIRST_FRAME_HINT =
  "The window stopped being in front after Ctrl+Home was sent to it and before the first frame, so nothing was " +
  "captured and no key went to another window. The window may now be scrolled to the top. Bring it forward and " +
  "call again.";

/** Said when the window stopped being in front part way through: what was read stands, the rest was not sent. */
export const LOST_FRONT_NOTE =
  "The window stopped being in front part way through, so the run stopped there rather than send keys to another " +
  "window or capture it. What came before is complete; bring the window forward and call again for the rest.";
