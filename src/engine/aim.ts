/**
 * aim.ts — what `desktop_act` is aimed at, and the one refusal that says the aim is gone.
 *
 * ADR-036. A session knows which window it was opened on (`hwnd > tabId > windowTitle`, see
 * `session-registry.ts`), and every backend now takes that handle so a same-titled sibling
 * cannot answer instead. This file holds the piece of that contract both halves need to agree
 * on — the read half emits the code, the executor decides what it means — without either of
 * them importing the other's module graph.
 *
 * Phase 3 of the dig ("make the aim a value rather than a parameter") lands here: today the
 * handle rides as a trailing optional argument, and this is the file that grows a `{ title,
 * hwnd }` when it stops doing that.
 */

/**
 * Backend code for "the handle names a window that is no longer there".
 *
 * `AutomationElement.FromHandle` THROWS for a dead handle rather than returning null, so both
 * hwnd-addressed scripts catch it and print this instead of dying with empty stdout.
 */
export const AIM_WINDOW_GONE = "aim_window_gone";

/**
 * The window this action was aimed at has gone.
 *
 * Its own type because the executor's ladder has to tell it apart from an ordinary UIA failure.
 * "UIA could not do it" is a reason to try the mouse at the entity's rect; "there is nothing
 * there any more" is not — the rect is where the window USED to be, and whatever occupies it now
 * would take the click. That is window drift, one of the five failures the perception graph
 * exists to stop, so this arrives as a refusal rather than as a rung (2ゲート目の指摘).
 */
export class AimedWindowGoneError extends Error {
  readonly hwnd?: bigint;
  constructor(hwnd?: bigint, detail?: string) {
    super(
      `The window this action was aimed at${hwnd !== undefined ? ` (hwnd ${hwnd})` : ""} is gone` +
      `${detail ? `: ${detail}` : ""}. Run desktop_discover again to see what is there now.`,
    );
    this.name = "AimedWindowGoneError";
    this.hwnd = hwnd;
  }
}
