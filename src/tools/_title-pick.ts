/**
 * Which of the windows a title matches a tool that MOVES or BRINGS FORWARD a window takes first.
 *
 * `enumWindowsInZOrder` lists hidden (DWM-cloaked) windows too, and a packaged app minimised has two
 * windows with its title: its frame (shown, minimised) and its content (hidden and frozen, and
 * listed above the frame — even at z 0 after a failed bring-forward). win2, 2026-10-04 (internal
 * `dev/llm22-drive`, F5/F8): `window_dock(title:'電卓')` moved the hidden content, set it topmost and
 * answered ok while the Calculator the user sees stayed minimised; `focus_window` aimed at the same
 * content and failed. A window that is shown is taken before a hidden one with the same title.
 *
 * Only for tools that move or bring forward. The readers keep their own pick (`_off-desktop.ts`
 * explains why they must agree with one another).
 */
export function titleMatchesShownFirst<T extends { title: string; isCloaked?: boolean }>(
  windows: readonly T[],
  titleQuery: string,
): T[] {
  const query = titleQuery.toLowerCase();
  const matches = windows.filter((w) => w.title.toLowerCase().includes(query));
  return [...matches.filter((w) => w.isCloaked !== true), ...matches.filter((w) => w.isCloaked === true)];
}
