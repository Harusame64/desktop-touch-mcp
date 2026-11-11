/**
 * internal #380 — a window that its own dialog has disabled is not typed into.
 *
 * While a window's modal dialog is open (Notepad's Save As), Windows disables the window
 * (`IsWindowEnabled` false) and the dialog takes the input. win2 measured `keyboard` named at the
 * window (internal dev/953-hw 5ccdf33a, dev/954-hw 9a43b76c):
 * - the foreground roads (type plain, forceFocus, clipboard; press; sequence) brought the disabled
 *   window in front of its dialog, answered ok:true, and the keys went nowhere;
 * - the roads that post WM_CHAR (method:'background', a pinned hwnd, foreground_flash on a plain
 *   window) answered ok:true with the text in the DIALOG's file-name field — a window the call did
 *   not name.
 * So every keyboard road asks here once it has picked its window, before anything is focused, sent
 * or spent, and refuses instead.
 *
 * The blocker is found as desktop_act's modal check finds it (`_window-blocker.ts`): the live window
 * of the disabled window's owner family, else of its thread. When none is live (a minimized owner
 * whose dialog is hidden with it), the window is refused without a dialog to name.
 */

import { failWith } from "./_errors.js";
import type { ToolResult } from "./_types.js";
import { liveBlockerOf } from "./_window-blocker.js";
import { buildEnvelopeFor } from "../engine/perception/registry.js";

export interface BlockedByDialogTarget {
  hwnd: bigint;
  title: string;
  /**
   * The window that holds the input: its title, else its class name, else "dialog". Null when none
   * is live — a minimized owner whose dialog is hidden with it. Such a window is refused all the
   * same: restored, it stayed disabled and the keys went nowhere (win2, dev/954-hw 649e581c).
   */
  dialog: { hwnd: bigint; name: string } | null;
}

/**
 * `w` as the enumeration lists it: `isEnabled` is false only when the OS said so. A disabled window
 * takes no keyboard input, whatever disabled it, so every one is refused; the dialog is named when
 * one is live.
 */
export function blockedByDialogTarget(w: { hwnd: bigint; title: string; isEnabled?: boolean }): BlockedByDialogTarget | null {
  if (w.isEnabled !== false) return null;
  let dialog: BlockedByDialogTarget["dialog"] = null;
  try {
    dialog = liveBlockerOf(w.hwnd);
  } catch { /* unnamed */ }
  return { hwnd: w.hwnd, title: w.title, dialog };
}

/**
 * An explicit `hwnd` naming a window its dialog has disabled is handed back as the DIALOG by
 * `resolveWindowTarget` (`parent_disabled_prefer_popup`, H3 case 5 — kept for click_element). For
 * the keyboard that typed into the dialog's file-name field, a window the call did not name (win2,
 * dev/954-hw 649e581c), so it is refused as the windowTitle road is.
 */
export function redirectedToDialog(
  hwndArg: string | undefined,
  resolved: { hwnd: bigint; title: string; warnings: readonly string[] } | null | undefined,
  ownerTitle: (h: bigint) => string,
): BlockedByDialogTarget | null {
  if (hwndArg === undefined || !resolved?.warnings.includes("parent_disabled_prefer_popup")) return null;
  let owner: bigint;
  try { owner = BigInt(hwndArg); } catch { return null; }
  let title = "";
  try { title = ownerTitle(owner); } catch { /* unnamed */ }
  return { hwnd: owner, title, dialog: { hwnd: resolved.hwnd, name: resolved.title } };
}

export function blockedByDialogFailure(
  toolName: string,
  blocked: BlockedByDialogTarget,
  opts: { lensId?: string; extra?: Record<string, unknown> } = {},
): ToolResult {
  const env = opts.lensId ? buildEnvelopeFor(opts.lensId, { toolName }) : null;
  return failWith(
    new Error(
      blocked.dialog
        ? "WindowBlockedByDialog: the target window is disabled while a dialog it opened is in front, and " +
            "it takes no input until the dialog closes. Nothing was focused or sent."
        : "WindowBlockedByDialog: the target window is disabled and takes no input, and no dialog of its is " +
            "showing (it may be minimized with the window). Nothing was focused or sent.",
    ),
    toolName,
    {
      hwnd: String(blocked.hwnd),
      windowTitle: blocked.title,
      ...(blocked.dialog && { dialogHwnd: String(blocked.dialog.hwnd), dialogTitle: blocked.dialog.name }),
      ...opts.extra,
      ...(env && { _perceptionForPost: env }),
    },
  );
}
