/**
 * internal #224 — the fields a WM_CHAR is posted into through the window they are drawn in.
 *
 * MEASURED win2 (2026-09-30), Word's body (`Edit`, automationId `Body`, no window of its own, no
 * Value) in the `_WwG` document window: a WM_CHAR posted to `_WwG` is typed at Word's caret, with Word
 * in front or behind, the IME open or closed, and whatever holds Word's focus (with the ribbon's
 * font-size box focused, the thread's focus was that box). Nothing else was measured, and a host that
 * is not measured is not assumed to behave alike: a browser's render widget routes characters to the
 * page's own focus, which can be another field (gate 2).
 *
 * One predicate, for every place that asks (the capability offered, the rung's receiver, the setValue
 * refusal): three versions of it disagreed within one change (gate 2).
 */
import type { UiEntity } from "./world-graph/types.js";
import { parseHandle } from "./keyboard-target.js";

export const KEYBOARD_HOST_CLASSES: ReadonlySet<string> = new Set(["_WwG"]);

/** The window to post into for this field, or `undefined` when it is not one this route was measured on. */
export function keyboardHostOf(entity: UiEntity): bigint | undefined {
  const uia = entity.locator?.uia;
  if (entity.controlType !== "Edit" || uia === undefined) return undefined;
  if (uia.automationId !== "Body") return undefined;
  if (uia.nativeWindowHandle !== undefined) return undefined;
  if ((entity.patterns ?? []).includes("ValuePattern")) return undefined;
  if (uia.hostWindowClass === undefined || !KEYBOARD_HOST_CLASSES.has(uia.hostWindowClass)) return undefined;
  return parseHandle(uia.hostWindowHandle) ?? undefined;
}
