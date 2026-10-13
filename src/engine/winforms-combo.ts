/**
 * internal #238 — the WinForms editable combo box, whose text UI Automation can change without the
 * application seeing it.
 *
 * MEASURED win2 (2026-10-13, main `ae122bbc`, fixture FX238, 3/3 each): a native `ValuePattern.SetValue`
 * on a WinForms editable ComboBox — the combo itself, or the Win32 `Edit` inside it, which discover lists
 * as a second textbox of the same name — shows the new text and answers `S_OK`, but WinForms' TextChanged
 * never fires, so a data binding has nothing to push and the application's model stays old. A TextBox in
 * the same form, a WinForms DropDownList (same window class), and a WPF editable ComboBox all reached
 * their model through the same write. Character messages to the inner Edit (WM_CHAR, or typing in the
 * foreground) raise TextChanged and do reach it, while the combo holds the focus.
 *
 * One predicate for every place that asks, as in `keyboard-hosts.ts`. The window facts are read from the
 * handle at act time: the entity records the element's own window (`nativeWindowHandle`), and the class
 * and style of that window and its parent say which control it is. A fact that cannot be read (a handle
 * recreated since discover, a build that cannot ask) answers "not this control", which keeps the write
 * as it was — failing open, toward the old false success, never toward refusing another control.
 */
import type { UiEntity } from "./world-graph/types.js";
import { parseHandle } from "./keyboard-target.js";

/** What a window says about itself: its class, its style bits (`GWL_STYLE`) and its parent. */
export interface ComboWindowFacts {
  readonly className: string;
  readonly style: number | null;
  readonly parent: bigint | null;
}

export type ComboWindowFactsReader = (hwnd: bigint) => ComboWindowFacts | undefined | Promise<ComboWindowFacts | undefined>;

/** WinForms' window class for its ComboBox: `WindowsForms10.COMBOBOX.app.0.<hash>`. Not localised. */
const WINFORMS_COMBO_CLASS = /^WindowsForms10\.COMBOBOX\./i;
/** The low two style bits name the combo's kind: CBS_SIMPLE 1, CBS_DROPDOWN 2, CBS_DROPDOWNLIST 3. */
const CBS_KIND_MASK = 0x3;
const CBS_DROPDOWNLIST = 0x3;

function isEditableWinFormsCombo(facts: ComboWindowFacts | undefined): boolean {
  if (facts === undefined || facts.style === null) return false;
  if (!WINFORMS_COMBO_CLASS.test(facts.className)) return false;
  // A DropDownList has no text of its own to change: its write moves the selection, which was measured
  // to reach the model. CBS_SIMPLE has an Edit like CBS_DROPDOWN and is treated alike (not measured).
  return (facts.style & CBS_KIND_MASK) !== CBS_DROPDOWNLIST;
}

/**
 * The combo's own window when `entity` is a WinForms editable combo box or the Edit inside one, else
 * `undefined`.
 */
export async function editableWinFormsComboOf(entity: UiEntity, read: ComboWindowFactsReader): Promise<bigint | undefined> {
  const own = parseHandle(entity.locator?.uia?.nativeWindowHandle) ?? undefined;
  if (own === undefined) return undefined;
  if (entity.controlType === "ComboBox") {
    return isEditableWinFormsCombo(await read(own)) ? own : undefined;
  }
  if (entity.controlType === "Edit") {
    const parent = (await read(own))?.parent ?? null;
    if (parent === null) return undefined;
    return isEditableWinFormsCombo(await read(parent)) ? parent : undefined;
  }
  return undefined;
}
