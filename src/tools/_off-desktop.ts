/**
 * internal #221 — a window on another virtual desktop is not brought forward.
 *
 * `enumWindowsInZOrder` lists windows on other virtual desktops (DWM cloaks them, `isCloaked`), and
 * a title search can pick one: it can come ahead of a same-titled window on the screen. Bringing it
 * forward switches the user to its desktop. win2 measured `keyboard(windowTitle)` doing that, twice
 * per call, and typing nothing (2026-09-30). So the tools that bring their window forward before
 * acting ask here first, and refuse instead.
 *
 * Which window a title picks is NOT changed. The readers (screenshot, UIA, OCR, the read-backs) find
 * their window by title too, some of them in Rust where the cloak cannot be seen, and a writer that
 * picked differently from them would act on one window and report on another (gate 2 on #763).
 *
 * Only bringing forward is refused. A route that does not take the foreground (background WM_CHAR,
 * PrintWindow) reaches such a window without switching the desktop (win2, same day), and
 * `focus_window` exists to bring a window forward, so neither asks here.
 */

import { failWith } from "./_errors.js";
import type { ToolResult } from "./_types.js";
import { nativeUia } from "../engine/native-engine.js";
import { buildEnvelopeFor } from "../engine/perception/registry.js";

export interface OffDesktopTarget {
  hwnd: bigint;
  title: string;
  /** Another window whose title contains the one the call named is on this desktop. */
  sameTitleOnScreen: boolean;
}

type Listed = { hwnd: bigint; title: string; isCloaked?: boolean };

/**
 * Is this cloaked window on another virtual desktop? A cloak alone does not say so: DWM also cloaks
 * a window its app hid, and a UWP frame the system keeps (gate 2 on #763). `IVirtualDesktopManager`
 * answers the question itself. When it cannot be asked (no native engine), the window is taken to
 * be elsewhere: the refusal is the side that cannot switch the user's desktop.
 */
async function isOnAnotherDesktop(hwnd: bigint): Promise<boolean> {
  const ask = nativeUia?.uiaGetVirtualDesktopStatus;
  if (!ask) return true;
  try {
    const key = String(hwnd);
    const answer = (await ask.call(nativeUia, [key]))[key];
    // The native side answers "on the current desktop" when COM fails, as its other caller wants.
    return answer === false;
  } catch {
    return true;
  }
}

/**
 * The target, when it is on another virtual desktop; null otherwise. `named` is the title the call
 * searched by (undefined for a handle-only call), used to say whether a same-titled window is here.
 * Costs nothing for a window that is not cloaked, which is nearly every call.
 */
export async function offDesktopTarget(
  target: Listed,
  windows: readonly Listed[] | (() => readonly Listed[]),
  named: string | undefined,
): Promise<OffDesktopTarget | null> {
  if (!target.isCloaked) return null;
  if (!(await isOnAnotherDesktop(target.hwnd))) return null;
  const q = named?.toLowerCase();
  const list = typeof windows === "function" ? windows() : windows;
  const sameTitleOnScreen = q !== undefined && q !== "" && list.some(
    (w) => w.hwnd !== target.hwnd && !w.isCloaked && w.title.toLowerCase().includes(q),
  );
  return { hwnd: target.hwnd, title: target.title, sameTitleOnScreen };
}

/**
 * The refusal: nothing was sent, and the desktop was not switched. `lensId` adds the perception
 * envelope, as the tools' other early refusals do.
 */
export function offDesktopFailure(
  toolName: string,
  off: OffDesktopTarget,
  opts: { lensId?: string; extra?: Record<string, unknown> } = {},
): ToolResult {
  const env = opts.lensId ? buildEnvelopeFor(opts.lensId, { toolName }) : null;
  return failWith(
    new Error(
      "WindowOnOtherDesktop: the target window is on another virtual desktop. Bringing it forward " +
      "would switch the user's desktop, so nothing was sent.",
    ),
    toolName,
    {
      hwnd: String(off.hwnd),
      windowTitle: off.title,
      sameTitleOnScreen: off.sameTitleOnScreen,
      ...opts.extra,
      ...(env && { _perceptionForPost: env }),
    },
  );
}
