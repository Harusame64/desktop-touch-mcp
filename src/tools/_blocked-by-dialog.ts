/**
 * internal #380 — a window that its own dialog has disabled is not brought forward or typed into.
 *
 * While a window's modal dialog is open (Notepad's Save As), Windows disables the window
 * (`IsWindowEnabled` false) and the dialog takes the input. `keyboard(windowTitle)` named the window,
 * brought it in front of its dialog, and typed: win2 measured `ok:true, typed: 4` with the keys in
 * neither the window nor the dialog — plain, forceFocus and clipboard alike — and the focus moved off
 * the dialog onto the disabled window (internal dev/953-hw, 5ccdf33a).
 *
 * So the keyboard tools ask here once they have picked their window, before anything is focused, and
 * refuse instead. `isEnabled` is the enumeration's own read: it says false only when the OS said so.
 * The dialog is named from the window's last active popup, so the caller can type into it by name.
 */

import { failWith } from "./_errors.js";
import type { ToolResult } from "./_types.js";
import { getLastActivePopup, getWindowTitleW } from "../engine/win32.js";
import { buildEnvelopeFor } from "../engine/perception/registry.js";

export interface BlockedByDialogTarget {
  hwnd: bigint;
  title: string;
  /** The window's last active popup — the dialog that holds the input — when there is one. */
  dialog: { hwnd: bigint; title: string } | null;
}

/** Null when the window takes input, or when the OS did not say it does not. */
export function blockedByDialogTarget(w: { hwnd: bigint; title: string; isEnabled?: boolean }): BlockedByDialogTarget | null {
  if (w.isEnabled !== false) return null;
  let dialog: BlockedByDialogTarget["dialog"] = null;
  const popup = getLastActivePopup(w.hwnd);
  if (popup !== null && popup !== w.hwnd) {
    let title = "";
    try { title = getWindowTitleW(popup); } catch { /* unnamed */ }
    dialog = { hwnd: popup, title };
  }
  return { hwnd: w.hwnd, title: w.title, dialog };
}

export function blockedByDialogFailure(
  toolName: string,
  blocked: BlockedByDialogTarget,
  opts: { lensId?: string } = {},
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
      ...(blocked.dialog && { dialogHwnd: String(blocked.dialog.hwnd), dialogTitle: blocked.dialog.title }),
      ...(env && { _perceptionForPost: env }),
    },
  );
}
