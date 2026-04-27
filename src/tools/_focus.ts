/**
 * _focus.ts — Shared focus-loss detection utility.
 *
 * Used by mouse_click, keyboard_type, keyboard_press, and terminal_send
 * to detect when another window (e.g. pinned Claude CLI) steals focus
 * from the intended target after an action completes.
 */

import {
  enumWindowsInZOrder,
  getWindowProcessId,
  getProcessIdentityByPid,
} from "../engine/win32.js";

export interface FocusLost {
  /** Milliseconds elapsed between action completion and focus measurement */
  afterMs: number;
  /** Title of the window that was expected to remain focused */
  expected: string;
  /** Title of the window that stole focus */
  stolenBy: string;
  /** Process name of the window that stole focus (without .exe) */
  stolenByProcessName: string;
}

/**
 * Detect focus loss after an action.
 *
 * @param opts.target        Expected title substring of the focused window.
 *                           If null/empty and homingNotes is empty, returns null (no-op).
 * @param opts.homingNotes   Notes from applyHoming — if a "brought X to front" note exists,
 *                           the target was explicitly restored and focus detection is active.
 * @param opts.settleMs      Wait this many ms before measuring foreground. Default 300.
 * @returns FocusLost if focus was stolen, null otherwise.
 */
export async function detectFocusLoss(opts: {
  target?: string;
  homingNotes?: string[];
  settleMs: number;
}): Promise<FocusLost | null> {
  const { target, homingNotes = [], settleMs } = opts;

  // Determine if we should track focus.
  // We track when:
  //   (a) homing brought a window to front (explicit homing note), OR
  //   (b) windowTitle was provided (caller knows the target window)
  const homingBrought = homingNotes.some((n) => n.startsWith("brought "));
  const hasTarget = !!target && target.length > 0;
  if (!homingBrought && !hasTarget) {
    return null; // no-op path
  }

  const startedAt = Date.now();
  if (settleMs > 0) {
    await new Promise<void>((r) => setTimeout(r, settleMs));
  }
  const afterMs = Date.now() - startedAt;

  // Measure current foreground
  let fg: { title: string; hwnd: bigint } | null = null;
  try {
    const wins = enumWindowsInZOrder();
    const active = wins.find((w) => w.isActive);
    if (active) fg = { title: active.title, hwnd: active.hwnd };
  } catch {
    return null;
  }

  if (!fg) return null;

  // Determine effective target to compare against
  let effectiveTarget = target ?? "";
  if (!effectiveTarget && homingBrought) {
    // Extract target from the note: `brought "X" to front`
    const note = homingNotes.find((n) => n.startsWith("brought "));
    if (note) {
      const m = note.match(/^brought "(.+)" to front/);
      if (m) effectiveTarget = m[1];
    }
  }

  if (!effectiveTarget.trim()) return null;

  // If foreground contains the expected target substring, no focus loss
  if (fg.title.toLowerCase().includes(effectiveTarget.toLowerCase())) {
    return null;
  }

  // Focus was stolen — gather info about the thief
  let stolenByProcessName = "";
  try {
    const pid = getWindowProcessId(fg.hwnd);
    if (pid) {
      const ident = getProcessIdentityByPid(pid);
      stolenByProcessName = ident.processName;
    }
  } catch {
    // best-effort
  }

  return {
    afterMs,
    expected: effectiveTarget,
    stolenBy: fg.title,
    stolenByProcessName,
  };
}

/**
 * No-settle variant of detectFocusLoss for mid-stream foreground checks.
 *
 * Used by Focus Leash Phase B: keyboard.type() chunked send loop calls this
 * between chunks to detect user-side focus theft as it happens (vs. the
 * post-action detectFocusLoss which waits settleMs first). Returns the same
 * FocusLost shape on theft, null when target is still in foreground.
 *
 * Implementation note: this is a thin wrapper around detectFocusLoss with
 * settleMs=0 — keeping the foreground measurement logic in one place.
 */
export async function checkForegroundOnce(opts: {
  target?: string;
  homingNotes?: string[];
}): Promise<FocusLost | null> {
  return detectFocusLoss({ ...opts, settleMs: 0 });
}
