/**
 * The window that holds the input while a disabled top-level window waits on it — its modal dialog.
 *
 * Moved out of `desktop-register.ts` (`productionFindBlockingWindow`, desktop_act's modal check) so
 * that `keyboard` (internal #380) names a blocker the same way: the live window of the disabled
 * window's owner family, else of its thread, nearest the top. Not the window's last active popup
 * (see below). `null` means nothing live blocks it: a window disabled for its own work, or one whose
 * dialog is hidden with it (a minimized owner) — not a modal. A read that throws throws.
 */

import {
  getWindowOwner, isWindowEnabled, enumTopLevelWindowHandles, getWindowThreadId, getWindowTitleW,
  getWindowClassName, getWindowRenderState,
} from "../engine/win32.js";

export interface WindowBlockerDeps {
  owner?: (hwnd: bigint) => bigint | null;
  isEnabled?: (hwnd: bigint) => boolean;
  topLevelWindows?: () => bigint[];
  threadOf?: (hwnd: bigint) => number;
  isVisible?: (hwnd: bigint) => boolean;
  title?: (hwnd: bigint) => string;
  className?: (hwnd: bigint) => string;
}

function isPopupVisible(hwnd: bigint): boolean {
  return getWindowRenderState(hwnd)?.visible ?? false;
}

/** `root` is a top-level window already read as disabled. */
export function liveBlockerOf(root: bigint, deps: WindowBlockerDeps = {}): { name: string; hwnd: bigint } | null {
  const isEnabled = deps.isEnabled ?? isWindowEnabled;
  // The top of the OWNER chain, walked by `GW_OWNER`. Not `GA_ROOTOWNER`: that walks `GetParent`,
  // which returns the owner only for a popup-styled window, and a WinForms Form dialog is an
  // overlapped window — owned by the main window, yet its own "root owner". Keyed on that, the
  // WinForms `ShowDialog` and a MessageBox it opened fell out of the family, and the act answered
  // ok:true again (win2, 2026-09-19, internal `e7f3980`). Bounded: an owner loop cannot exist in
  // Windows, but a read that tears must not spin.
  const ownerOf = deps.owner ?? getWindowOwner;
  const topOwnerOf = (w: bigint): bigint => {
    let at = w;
    for (let i = 0; i < 32; i++) {
      const next = ownerOf(at);
      if (next === null || next === at) return at;
      at = next;
    }
    return at;
  };
  const chainTop = topOwnerOf(root);
  // The windows that OWN the entity's — never its blocker: a modal is owned by what it blocks, not
  // the other way round. Without this, an owned palette the app disabled for its own reasons named
  // its enabled main window as the dialog blocking it (gate 2, round 3).
  const ownersOfRoot = new Set<bigint>();
  for (let at = ownerOf(root), i = 0; at !== null && i < 32; at = ownerOf(at), i++) ownersOfRoot.add(at);
  // **The dialog is the window of this owner family that is still live**: visible, enabled, not
  // the entity's own — and of those, the one nearest the top of the Z-order. A modal disables the
  // windows it blocks and stays enabled itself; a nested dialog sits above the one that opened it.
  //
  // The "last active popup" reading this replaced named whatever was activated last: a hidden
  // popup Windows still remembers, or a palette the user clicked while the modal was up — and
  // when WinForms' `MessageBox` had disabled that palette too, the check fell silent and the act
  // answered `ok:true` under a real modal, the defect this exists to end (win2, 2026-09-19,
  // internal `a24d9c3`). The family is every window whose `GW_OWNER` chain tops out
  // where this one's does. The handle list is unfiltered and front-to-back (EnumWindows).
  const isVisible = deps.isVisible ?? isPopupVisible;
  const windows = (deps.topLevelWindows ?? enumTopLevelWindowHandles)();
  const live = (w: bigint): boolean => w !== root && !ownersOfRoot.has(w) && isVisible(w) && isEnabled(w);
  // **An ownerless modal is not in any family**: `MessageBox(NULL, …, MB_TASKMODAL)` and a WPF
  // `ShowDialog()` with no `Owner` disable every top-level window of their THREAD and own none of
  // them (gate 2, round 3 — the #126 shape again, one step out). A modal loop runs on the thread
  // of the windows it blocks, so the thread is the family's fallback: asked only when the owner
  // family has nothing live.
  const threadOf = deps.threadOf ?? getWindowThreadId;
  const rootThread = threadOf(root);
  const popup =
    windows.find((w) => live(w) && topOwnerOf(w) === chainTop) ??
    (rootThread !== 0 ? windows.find((w) => live(w) && threadOf(w) === rootThread) : undefined) ??
    null;
  // Disabled with nothing live in its family or its thread: its own work, not a modal.
  if (popup === null) return null;
  const title = (deps.title ?? getWindowTitleW)(popup);
  // Untitled is still a dialog: the ground is the disabled window, not the name. The handle is
  // what a caller can use to reach it; a class name stands in for the missing title.
  const name = title !== "" ? title : (deps.className ?? getWindowClassName)(popup) || "dialog";
  return { name, hwnd: popup };
}
