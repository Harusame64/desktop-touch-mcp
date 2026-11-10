/**
 * internal #286 — the checks `terminal(action:'send'/'run')` makes before it takes the foreground to
 * paste into Windows Terminal.
 *
 * `desktop_act` asks the user before such a paste and checks the destination around the question
 * (`pasteIntoTerminalThroughForeground`, internal #227 / public #764). `terminal` does not ask (the
 * user's decision, 2026-11-11: align the checks, not the question), so only the checks that hold
 * without a question are made here:
 *
 * - the terminal is not the window in front: the selected tab of the window in front is the one the
 *   user is working in, and when the client runs in it the paste and Enter arrive as the user's next
 *   message (win2 measured exactly that on #764);
 * - its selected tab can be read and has exactly one pane: a split tab's paste goes to whichever pane
 *   has the focus, and a tab with no pane (WT's Settings tab) is not a terminal;
 * - the tab is still the same one after the terminal was brought in front, read by RuntimeId: a tab
 *   switched in between would take a command meant for another.
 *
 * The checks that exist only because of the question (text and title that must be shown in full, one
 * line, a same-titled twin the question must tell apart) are not made.
 */

export const WT_WINDOW_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";

export interface WtTab {
  name: string;
  runtimeId: string;
  paneCount: number;
}

export interface WtCheckDeps {
  getForegroundHwnd(): bigint | null;
  getWindowRoot(hwnd: bigint): bigint | null;
  /** `undefined` when it cannot be read, `null` when the window shows no tab. */
  getSelectedTab(hwnd: bigint): Promise<WtTab | null | undefined>;
}

/** Why a paste into Windows Terminal was refused before anything was typed. */
export type WtRefusal = "in_front" | "tab_unreadable" | "tab_split" | "tab_not_terminal" | "tab_changed";

/**
 * Is the terminal the window in front? Fails closed: a foreground that cannot be read counts as this
 * terminal, as on the `desktop_act` road.
 */
export function wtIsInFront(hwnd: bigint, deps: Pick<WtCheckDeps, "getForegroundHwnd" | "getWindowRoot">): boolean {
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
  deps: Pick<WtCheckDeps, "getSelectedTab">,
): Promise<{ ok: true; tab: WtTab } | { ok: false; why: WtRefusal }> {
  let tab: WtTab | null | undefined;
  try { tab = await deps.getSelectedTab(hwnd); } catch { tab = undefined; }
  if (!tab) return { ok: false, why: "tab_unreadable" };
  if (tab.paneCount > 1) return { ok: false, why: "tab_split" };
  if (tab.paneCount !== 1) return { ok: false, why: "tab_not_terminal" };
  return { ok: true, tab };
}

/** Checked before the terminal is brought in front. */
export async function checkWtBeforeForeground(
  hwnd: bigint,
  deps: WtCheckDeps,
): Promise<{ ok: true; tab: WtTab } | { ok: false; why: WtRefusal }> {
  if (wtIsInFront(hwnd, deps)) return { ok: false, why: "in_front" };
  return readWtTab(hwnd, deps);
}

/** Checked after the terminal was brought in front, before the paste. */
export async function checkWtSameTab(
  hwnd: bigint,
  before: WtTab,
  deps: Pick<WtCheckDeps, "getSelectedTab">,
): Promise<{ ok: true } | { ok: false; why: WtRefusal }> {
  const now = await readWtTab(hwnd, deps);
  if (!now.ok) return now;
  return now.tab.runtimeId === before.runtimeId ? { ok: true } : { ok: false, why: "tab_changed" };
}

/** The sentence the caller reads. Every one of them says nothing was typed. */
export function wtRefusalSentence(why: WtRefusal, tabName?: string): string {
  switch (why) {
    case "in_front":
      return "Nothing was typed: this Windows Terminal window is the window in front, where the user is working. " +
        "If the client runs in one of its tabs, the paste would arrive there. Use a terminal in another window, " +
        "or ask the user to switch to another window first.";
    case "tab_unreadable":
      return "Nothing was typed: the Windows Terminal window's selected tab could not be read, so which tab " +
        "would receive the text is not known.";
    case "tab_split":
      return "Nothing was typed: the Windows Terminal tab is split into panes, and the text would go to whichever " +
        "pane has the focus. Use a tab that is not split.";
    case "tab_not_terminal":
      return "Nothing was typed: the Windows Terminal window's selected tab is not a terminal (no terminal pane, " +
        "e.g. the Settings tab). Select a terminal tab.";
    case "tab_changed":
      return "Nothing was typed: the Windows Terminal window's selected tab changed while it was being brought " +
        `in front${tabName !== undefined ? ` (it was "${tabName}")` : ""}.`;
  }
}
