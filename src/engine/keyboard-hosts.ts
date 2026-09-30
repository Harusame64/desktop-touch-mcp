/**
 * internal #224 — the windows a WM_CHAR can be posted into on behalf of a control drawn in them.
 *
 * MEASURED win2 (2026-09-30), Word's `_WwG` document window: a WM_CHAR posted to it is typed at the
 * body's caret, with Word in front or behind, the IME open or closed, and whatever holds Word's focus
 * (with the ribbon's font-size box focused, the thread's focus was that box). No other class was
 * measured, and a host that is not measured is not assumed to behave alike: a browser's render widget
 * routes characters to the page's own focus, which can be another field (gate 2).
 */
export const KEYBOARD_HOST_CLASSES: ReadonlySet<string> = new Set(["_WwG"]);

export function isKeyboardHostClass(className: string | undefined): boolean {
  return className !== undefined && KEYBOARD_HOST_CLASSES.has(className);
}
