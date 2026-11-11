/**
 * internal #380 — the keyboard does not deliver to a window that its own dialog has disabled.
 *
 * While a window's modal dialog is open (Notepad's Save As), Windows disables the window
 * (`IsWindowEnabled` false) and the dialog takes the input. win2 measured `keyboard` named at such a
 * window (internal dev/953-hw, dev/954-hw, dev/380-design-spike):
 * - the foreground roads brought it in front of its dialog, answered ok:true, and the keys reached
 *   no field — the focus moved off the dialog (C1, 10/10);
 * - WM_CHAR posted to it went into the DIALOG's file-name field, a window the call did not name;
 * - a window disabled with no dialog showing (minimized with it, or disabled by its app) took the
 *   keys at its top window and inserted nothing, also ok:true (E3, K3).
 *
 * Two gates, one per kind of delivery, placed where the call is about to act:
 * - {@link beforeForeground} — before the window is brought forward. The internal #221 off-desktop
 *   check runs first, inside it, so every road says the same thing for a window that is both.
 * - {@link beforePost} — before WM_CHAR is posted. It asks the post handle's TOP-LEVEL window: a
 *   disabled form's child Edit stays enabled, and WM_CHAR posted to it does insert (K3b).
 *
 * Refused only where the keys are measured not to reach the named window (the user's rule: a
 * stronger guard must not take away what works):
 * - a console window is never refused — a conhost disabled by its Properties dialog still takes
 *   keyboard and terminal input into its input line (T1, T1b);
 * - a window whose enabled state cannot be read goes on as before (the enumeration and
 *   `isWindowEnabled` both answer "enabled" when they cannot ask).
 *
 * The dialog is named as desktop_act's modal check names it (`_window-blocker.ts`): the live window
 * of the disabled window's owner family, else of its thread. Not the last active popup, which names
 * a disabled owned window after a forced foreground (K2).
 */

import { failWith } from "./_errors.js";
import type { ToolResult } from "./_types.js";
import { liveBlockerOf } from "./_window-blocker.js";
import { offDesktopTarget, type OffDesktopTarget } from "./_off-desktop.js";
import { buildEnvelopeFor } from "../engine/perception/registry.js";
import { getWindowClassName, getWindowRoot, getWindowTitleW, isWindowEnabled } from "../engine/win32.js";
import { TERMINAL_WINDOW_CLASSES } from "../engine/bg-input.js";
import { parseWindowHandle } from "../engine/aim.js";

export interface BlockedByDialogTarget {
  hwnd: bigint;
  title: string;
  /** The window that holds the input: its title, else its class name, else "dialog". */
  dialog: { hwnd: bigint; name: string } | null;
  /** The dialog could not be looked for (a read threw) — not "no dialog is showing". */
  dialogUnread?: true;
}

function isConsoleClass(hwnd: bigint): boolean {
  try {
    return TERMINAL_WINDOW_CLASSES.has(getWindowClassName(hwnd));
  } catch {
    return false;
  }
}

function blocked(hwnd: bigint, title: string): BlockedByDialogTarget {
  try {
    return { hwnd, title, dialog: liveBlockerOf(hwnd) };
  } catch {
    return { hwnd, title, dialog: null, dialogUnread: true };
  }
}

/** A top-level window as the enumeration lists it: `isEnabled` is false only when the OS said so. */
export function disabledByDialog(w: { hwnd: bigint; title: string; isEnabled?: boolean }): BlockedByDialogTarget | null {
  if (w.isEnabled !== false) return null;
  if (isConsoleClass(w.hwnd)) return null;
  return blocked(w.hwnd, w.title);
}

type Listed = Parameters<typeof offDesktopTarget>[0];
export type ForegroundGate = { offDesktop: OffDesktopTarget } | { blockedByDialog: BlockedByDialogTarget } | null;

/** Before `target` is brought forward: another virtual desktop first (internal #221), then disabled. */
export async function beforeForeground(
  target: Listed & { isEnabled?: boolean },
  windows: Parameters<typeof offDesktopTarget>[1],
  named: string | undefined,
): Promise<ForegroundGate> {
  const away = await offDesktopTarget(target, windows, named);
  if (away) return { offDesktop: away };
  const b = disabledByDialog(target);
  return b ? { blockedByDialog: b } : null;
}

/** Before WM_CHAR is posted to `hwnd`: its top-level window, disabled and not a console, is refused. */
export function beforePost(hwnd: bigint): BlockedByDialogTarget | null {
  let root: bigint = hwnd;
  try { root = getWindowRoot(hwnd) ?? hwnd; } catch { /* the handle itself */ }
  if (isWindowEnabled(root)) return null;
  if (isConsoleClass(root)) return null;
  let title = "";
  try { title = getWindowTitleW(root); } catch { /* untitled */ }
  return blocked(root, title);
}

/**
 * An explicit `hwnd` naming a window its dialog has disabled is handed back as the DIALOG by
 * `resolveWindowTarget` (`parent_disabled_prefer_popup`, H3 case 5 — kept for click_element, where a
 * click at the dialog's button is what the caller meant). For the keyboard it typed into the
 * dialog's file-name field (win2, dev/954-hw), so it is refused as the windowTitle road is, and the
 * dialog is named the same way; the popup the resolver moved to stands in only when the family walk
 * names none.
 */
export function redirectedToDialog(
  hwndArg: string | undefined,
  resolved: { hwnd: bigint; title: string; warnings: readonly string[] } | null | undefined,
): BlockedByDialogTarget | null {
  if (hwndArg === undefined || !resolved?.warnings.includes("parent_disabled_prefer_popup")) return null;
  const owner = parseWindowHandle(hwndArg);
  if (owner === undefined) return null;
  let title = "";
  try { title = getWindowTitleW(owner); } catch { /* untitled */ }
  const b = blocked(owner, title);
  return b.dialog !== null ? b : { hwnd: owner, title, dialog: { hwnd: resolved.hwnd, name: resolved.title } };
}

export function blockedByDialogFailure(
  toolName: string,
  target: BlockedByDialogTarget,
  opts: { lensId?: string; extra?: Record<string, unknown> } = {},
): ToolResult {
  const env = opts.lensId ? buildEnvelopeFor(opts.lensId, { toolName }) : null;
  const why = target.dialog
    ? "the target window is disabled while a dialog it opened is in front, and it takes no input until the dialog closes."
    : target.dialogUnread
      ? "the target window is disabled and takes no input; which dialog holds the input could not be read."
      : "the target window is disabled and takes no input, and no dialog of its is showing (it may be minimized with the window).";
  return failWith(
    new Error(`WindowBlockedByDialog: ${why} Nothing was focused or sent.`),
    toolName,
    {
      hwnd: String(target.hwnd),
      windowTitle: target.title,
      ...(target.dialog && { dialogHwnd: String(target.dialog.hwnd), dialogTitle: target.dialog.name }),
      ...(target.dialogUnread && { dialogUnread: true }),
      ...opts.extra,
      ...(env && { _perceptionForPost: env }),
    },
  );
}
