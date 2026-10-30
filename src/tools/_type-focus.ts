/**
 * _type-focus.ts — internal #322: is the keyboard focus on a control that takes no typed text?
 *
 * Its own module so the unit suite can answer for it (`tests/unit/setup-diagnostic-log.ts`): the
 * handlers it guards are driven by dozens of test files, and a real read there would ask the desktop
 * the tests run on.
 */

import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";

/**
 * Internal #322 — UIA control types that take no typed text: a character sent to one is dropped, and a
 * space or Enter presses it. Edit, Document, ComboBox, List items and custom controls are left out,
 * because some of them do take text (Chromium reports a web text input as ComboBox, a list takes
 * type-ahead).
 */
const TAKES_NO_TEXT_CONTROL_TYPES = new Set([
  "Button", "SplitButton", "CheckBox", "RadioButton", "Hyperlink", "MenuItem", "TabItem",
]);

/**
 * The focused element's control type when it is one of `TAKES_NO_TEXT_CONTROL_TYPES` and exposes no
 * value; otherwise null, as when there is no focus or the read fails. Unnamed elements count, as in
 * the post snapshot. Its name is not returned: the post carries it only under the value switch.
 */
export async function focusedControlThatTakesNoText(): Promise<string | null> {
  try {
    const { focused } = await getFocusedAndPointInfo(0, 0, false, 800, true);
    if (!focused || focused.value != null) return null;
    return TAKES_NO_TEXT_CONTROL_TYPES.has(focused.controlType) ? focused.controlType : null;
  } catch {
    return null;
  }
}
