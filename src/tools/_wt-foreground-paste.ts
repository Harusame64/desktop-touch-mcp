/**
 * internal #372 — the Windows Terminal checks around a paste through the foreground, shared by every
 * tool that brings WT in front and pastes into it without asking: `terminal(action:'send'/'run')`
 * (internal #286, #370) and `keyboard(action:'type')`.
 *
 * Before the focus move (`wtBeforeFocus`): this build must be able to read WT's tabs and to put the
 * focus on a pane, and the selected tab must be one terminal pane. A minimized window's tab is not read
 * yet (it is read once the focus move restored it).
 *
 * After the focus move (`wtAfterFocus`), with nothing typed yet:
 * - the selected tab is read again, and must be the one read before (by RuntimeId);
 * - the window in front must still be WT (a tab read awaits; a window that came in front meanwhile
 *   would take the paste);
 * - the keyboard focus is put on that tab's pane (an open find box or a focused tab item would take
 *   the paste otherwise), and WT must still be in front after it.
 *
 * A refusal after the focus move puts back the window the user was in, unless the user has moved to
 * another window meanwhile (then that window keeps the foreground).
 */

import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { focusTerminalPane, getSelectedTab, selectedTabReadable, terminalPaneFocusable } from "../engine/uia-bridge.js";
import { checkWtTabInFront, readWtTab, type WtRefusal, type WtTab } from "./_wt-terminal-checks.js";

/** A refused paste: nothing was typed. */
export interface WtGuardRefusal {
  why: WtRefusal;
  /** The tab read before the focus move, for `tab_changed`'s sentence. */
  tabName?: string;
  /** This call brought WT in front and the window the user was in could not be put back. */
  leftInFront?: boolean;
  /** Set when there was a window to put back: whether it is in front again. */
  foregroundRestored?: boolean;
}

/** The window in front now; `undefined` when it cannot be read. */
export function activeHwnd(): bigint | null | undefined {
  try {
    return enumWindowsInZOrder().find((w) => w.isActive)?.hwnd ?? null;
  } catch {
    return undefined;
  }
}

/** Is this window the one in front now? Fails closed (a failed read is "no"). */
export function wtIsActive(hwnd: bigint): boolean {
  return activeHwnd() === hwnd;
}

/** The live tab readers, as `_wt-terminal-checks` takes them. */
export function wtCheckDeps() {
  return { tabReaderAvailable: selectedTabReadable, getSelectedTab };
}

/**
 * Before the focus move. `before` is the tab read now, or `null` for a minimized window (read after the
 * move restored it).
 */
export async function wtBeforeFocus(
  win: { hwnd: bigint; isMinimized: boolean },
): Promise<{ ok: true; before: WtTab | null } | { ok: false; refusal: WtGuardRefusal }> {
  // A server that cannot read tabs at all refuses before anything moves, minimized or not (gate 2 on #934).
  if (!selectedTabReadable()) return { ok: false, refusal: { why: "tab_reader_unavailable" } };
  // The pane focus after the move needs this export; without it, refused before anything moves (#370).
  if (!terminalPaneFocusable()) return { ok: false, refusal: { why: "pane_focus_unavailable" } };
  if (win.isMinimized) return { ok: true, before: null };
  const read = await readWtTab(win.hwnd, wtCheckDeps());
  if (!read.ok) return { ok: false, refusal: { why: read.why } };
  return { ok: true, before: read.tab };
}

/**
 * After the focus move, before anything is typed. `prevFgHwnd`: the window in front before the move,
 * read after `wtBeforeFocus` (the user may have moved while it read).
 */
export async function wtAfterFocus(
  hwnd: bigint,
  before: WtTab | null,
  prevFgHwnd: bigint | null,
): Promise<{ ok: true } | { ok: false; refusal: WtGuardRefusal }> {
  const refuseInFront = async (why: WtRefusal): Promise<{ ok: false; refusal: WtGuardRefusal }> => {
    const tabName = before?.name;
    // WT no longer in front: the user moved to another window while this call read the tab or waited
    // for the pane's focus. That window keeps the foreground (PR codex on #936).
    if (!wtIsActive(hwnd)) return { ok: false, refusal: { why, tabName } };
    // Put back the window the user was in: nothing was typed, and this call took the foreground. Tried
    // as the forward move is: plainly, then through AttachThreadInput (gate 2 on #934). With no
    // window in front before, there is nothing to put back, and WT is left in front.
    let leftInFront = prevFgHwnd !== hwnd;
    if (prevFgHwnd && prevFgHwnd !== hwnd) {
      for (const force of [false, true]) {
        try {
          if (force) restoreAndFocusWindow(prevFgHwnd, { force: true });
          else restoreAndFocusWindow(prevFgHwnd);
        } catch { /* read below */ }
        await new Promise<void>((r) => setTimeout(r, 100));
        leftInFront = activeHwnd() !== prevFgHwnd;
        if (!leftInFront) break;
      }
    }
    return {
      ok: false,
      refusal: {
        why, tabName, leftInFront,
        ...(prevFgHwnd !== hwnd && { foregroundRestored: !leftInFront }),
      },
    };
  };

  const same = await checkWtTabInFront(hwnd, before, wtCheckDeps());
  if (!same.ok) return refuseInFront(same.why);
  // The tab read awaits (up to 2 s): a window that came in front meanwhile would take the paste (PR
  // codex on #934). Not put back: that is the window the user moved to. Checked before the pane focus
  // too, whose SetFocus would take the foreground back.
  if (!wtIsActive(hwnd)) return { ok: false, refusal: { why: "foreground_moved" } };
  // internal #370: the paste goes to WT's focused control — its find box when open, a tab item — so the
  // focus is put on the tab's pane first, as the flash does (internal #230).
  const pane = await focusTerminalPane(hwnd, same.tab.runtimeId);
  // Another window came in front during the pane's tree reads: nothing was focused (gate 2 on #936).
  if (pane === "foreground_moved") return { ok: false, refusal: { why: "foreground_moved" } };
  if (pane !== "focused") return refuseInFront(pane === "tab_changed" ? "tab_changed" : "pane_not_focused");
  // The focus wait awaits too (up to 1 s). Nothing awaits between this and the caller's paste.
  if (!wtIsActive(hwnd)) return { ok: false, refusal: { why: "foreground_moved" } };
  return { ok: true };
}
