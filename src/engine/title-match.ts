/**
 * internal #221 — which windows a title names.
 *
 * Its own module, with nothing imported, so the many test files that replace `_resolve-window.ts`
 * or `win32.ts` wholesale do not also replace the predicate their handler searches with.
 */

/**
 * internal #221 — the windows whose title contains `title` (case-insensitive), in the order given,
 * leaving out the ones DWM has cloaked.
 *
 * `enumWindowsInZOrder` keeps a cloaked window — one on another virtual desktop, or a UWP frame the
 * system has hidden — and it can come ahead of the visible one in Z-order. A title search that lands
 * on it reaches nothing on the screen: `keyboard(windowTitle)` brought it forward, which switched the
 * user to the other desktop, and typed nothing (win2, 2026-09-30). Every title search that picks or
 * counts a window goes through here, so what is picked and what is counted are the same windows.
 * A window whose cloak could not be read (`isCloaked` absent) is kept, as the enumeration keeps it.
 */
export function windowsTitled<W extends { title: string; isCloaked?: boolean }>(
  windows: readonly W[],
  title: string,
): W[] {
  const q = title.toLowerCase();
  return windows.filter((w) => !w.isCloaked && w.title.toLowerCase().includes(q));
}

/**
 * internal #221 — true when `title` is worn only by cloaked windows: there is such a window, and
 * none of them is on the screen. A title search then finds nothing, and the caller is told why
 * rather than that the window does not exist.
 */
export function titleIsOnlyOffScreen(
  windows: readonly { title: string; isCloaked?: boolean }[],
  title: string,
): boolean {
  if (!title) return false;
  const q = title.toLowerCase();
  const worn = windows.filter((w) => w.title.toLowerCase().includes(q));
  return worn.length > 0 && worn.every((w) => w.isCloaked);
}
