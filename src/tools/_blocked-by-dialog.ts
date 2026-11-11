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
 * of the disabled window's owner family, else of its thread. When nothing live blocks it — a window
 * disabled for its own work, or a minimized owner whose dialog is hidden with it — this answers null
 * and the call goes on as before (bringing a minimized owner back brings its dialog back). A read
 * that throws decides nothing.
 */

import { failWith } from "./_errors.js";
import type { ToolResult } from "./_types.js";
import { liveBlockerOf } from "./_window-blocker.js";
import { buildEnvelopeFor } from "../engine/perception/registry.js";

export interface BlockedByDialogTarget {
  hwnd: bigint;
  title: string;
  /** The window that holds the input: its title, else its class name, else "dialog". */
  dialog: { hwnd: bigint; name: string };
}

/** `w` as the enumeration lists it: `isEnabled` is false only when the OS said so. */
export function blockedByDialogTarget(w: { hwnd: bigint; title: string; isEnabled?: boolean }): BlockedByDialogTarget | null {
  if (w.isEnabled !== false) return null;
  let blocker: { name: string; hwnd: bigint } | null;
  try {
    blocker = liveBlockerOf(w.hwnd);
  } catch {
    return null;
  }
  return blocker === null ? null : { hwnd: w.hwnd, title: w.title, dialog: blocker };
}

export function blockedByDialogFailure(
  toolName: string,
  blocked: BlockedByDialogTarget,
  opts: { lensId?: string; extra?: Record<string, unknown> } = {},
): ToolResult {
  const env = opts.lensId ? buildEnvelopeFor(opts.lensId, { toolName }) : null;
  return failWith(
    new Error(
      "WindowBlockedByDialog: the target window is disabled while a dialog it opened is in front, and " +
        "it takes no input until the dialog closes. Nothing was focused or sent.",
    ),
    toolName,
    {
      hwnd: String(blocked.hwnd),
      windowTitle: blocked.title,
      dialogHwnd: String(blocked.dialog.hwnd),
      dialogTitle: blocked.dialog.name,
      ...opts.extra,
      ...(env && { _perceptionForPost: env }),
    },
  );
}
