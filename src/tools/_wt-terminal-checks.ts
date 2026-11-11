/**
 * internal #286 — the checks `terminal(action:'send'/'run')` makes when it takes the foreground to
 * paste into Windows Terminal.
 *
 * `desktop_act` asks the user before such a paste and checks the destination around the question
 * (`pasteIntoTerminalThroughForeground`, internal #227 / public #764). `terminal` does not ask (the
 * user's decision, 2026-11-11: align the checks, not the question), so only the checks that hold
 * without a question are made here:
 *
 * - its selected tab can be read and has exactly one pane: a split tab's paste goes to whichever pane
 *   has the focus, and a tab with no pane (WT's Settings tab) is not a terminal;
 * - the tab is still the same one after the terminal was brought in front, read by RuntimeId: a tab
 *   switched in between would take a command meant for another.
 *
 * Not made: the window-in-front refusal. On the `desktop_act` road the question is in front while the
 * user answers, so a terminal in front is the user's own. Without a question this server puts the
 * terminal in front itself (`run` leaves it there, `launch_console` opens it there), and the refusal
 * turned away every second `run` (gate 2 on #934; the user chose to drop it, 2026-11-11). Nor the
 * checks that exist only because of the question (text and title shown in full, one line, a
 * same-titled twin the question must tell apart).
 */

export interface WtTab {
  name: string;
  runtimeId: string;
  paneCount: number;
}

export interface WtCheckDeps {
  /** False when this build or configuration cannot read a tab at all (native UIA disabled, old addon). */
  tabReaderAvailable(): boolean;
  /** `undefined` when it cannot be read, `null` when the window shows no tab. */
  getSelectedTab(hwnd: bigint): Promise<WtTab | null | undefined>;
}

/** Why a paste into Windows Terminal was refused before anything was typed. */
export type WtRefusal =
  | "minimized"
  | "tab_reader_unavailable"
  | "tab_unreadable"
  | "tab_split"
  | "tab_not_terminal"
  | "tab_changed"
  | "foreground_moved"
  | "pane_not_focused";

/**
 * Is this window Windows Terminal? Read by the same classifier that keeps it off the background road
 * (`canInjectViaPostMessage`: its class, or its process), so the two roads cannot disagree (gate 2 on
 * #934). A window whose class and process both read empty is a failed read, and is checked as Windows
 * Terminal rather than let through unchecked.
 */
export function isWindowsTerminal(check: { reason?: string; className?: string; processName?: string }): boolean {
  // `class_unknown` is the classifier's own failed read (a read threw) (gate 2 on #934).
  if (check.reason === "wt_xaml_pipeline" || check.reason === "class_unknown") return true;
  return check.reason === undefined && !check.className && !check.processName;
}

/**
 * Is the terminal the window in front? Fails closed: a foreground that cannot be read counts as this
 * terminal. Used by `desktop_act`, where the question is in front while the user answers.
 */
export function wtIsInFront(
  hwnd: bigint,
  deps: { getForegroundHwnd(): bigint | null; getWindowRoot(hwnd: bigint): bigint | null },
): boolean {
  try {
    const fg = deps.getForegroundHwnd();
    return fg === null || fg === hwnd || deps.getWindowRoot(fg) === hwnd;
  } catch {
    return true;
  }
}

/** The selected tab, or why it cannot be pasted into. */
export async function readWtTab(
  hwnd: bigint,
  deps: WtCheckDeps,
): Promise<{ ok: true; tab: WtTab } | { ok: false; why: WtRefusal }> {
  if (!deps.tabReaderAvailable()) return { ok: false, why: "tab_reader_unavailable" };
  let tab: WtTab | null | undefined;
  try { tab = await deps.getSelectedTab(hwnd); } catch { tab = undefined; }
  if (!tab) return { ok: false, why: "tab_unreadable" };
  if (tab.paneCount > 1) return { ok: false, why: "tab_split" };
  if (tab.paneCount !== 1) return { ok: false, why: "tab_not_terminal" };
  return { ok: true, tab };
}

/**
 * Checked after the terminal was brought in front, before the paste. With the tab read before the
 * focus move, it must be the same tab; without one (the window was minimized, and a minimized window's
 * tab is not read before it is restored), the tab read now is the one pasted into.
 */
export async function checkWtTabInFront(
  hwnd: bigint,
  before: WtTab | null,
  deps: WtCheckDeps,
): Promise<{ ok: true } | { ok: false; why: WtRefusal }> {
  const now = await readWtTab(hwnd, deps);
  if (!now.ok) return now;
  if (before === null) return { ok: true };
  return now.tab.runtimeId === before.runtimeId ? { ok: true } : { ok: false, why: "tab_changed" };
}

/**
 * The sentence the caller reads. Every one of them says nothing was typed. `leftInFront`: the
 * refusal came after this call brought the terminal in front, and the window the user was in could not
 * be put back in front.
 */
export function wtRefusalSentence(why: WtRefusal, opts: { tabName?: string; leftInFront?: boolean } = {}): string {
  const tail = opts.leftInFront
    ? " Windows Terminal was brought in front and the window the user was in could not be put back: it is behind the terminal. Tell the user before anything else."
    : "";
  switch (why) {
    case "minimized":
      return "Nothing was typed: the Windows Terminal window is minimized, and method:'foreground_flash' does not " +
        "restore it. Restore it, or send without method:'foreground_flash'.";
    case "tab_reader_unavailable":
      return "Nothing was typed: this server cannot read Windows Terminal's tabs (native UI Automation is disabled " +
        "by DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1, or the native addon is too old), so which tab would receive the " +
        "text is not known. Sending again gives the same answer." + tail;
    case "tab_unreadable":
      return "Nothing was typed: the Windows Terminal window's selected tab could not be read, so which tab " +
        "would receive the text is not known." + tail;
    case "tab_split":
      return "Nothing was typed: the Windows Terminal tab is split into panes, and the text would go to whichever " +
        "pane has the focus. Use a tab that is not split." + tail;
    case "tab_not_terminal":
      return "Nothing was typed: the Windows Terminal window's selected tab is not a terminal (no terminal pane, " +
        "e.g. the Settings tab). Select a terminal tab." + tail;
    case "tab_changed":
      return "Nothing was typed: the Windows Terminal window's selected tab changed while it was being brought " +
        `in front${opts.tabName !== undefined ? ` (it was "${opts.tabName}")` : ""}.` + tail;
    case "foreground_moved":
      return "Nothing was typed: another window came in front while the Windows Terminal tab was being read " +
        "after the terminal was brought in front, and the paste would have gone there. Send again.";
    case "pane_not_focused":
      return "Nothing was typed: the Windows Terminal pane did not take the keyboard focus in time (or UI Automation " +
        "was busy), so the paste was not sent — it would have gone to another control (an open find box, a tab)." + tail;
  }
}
