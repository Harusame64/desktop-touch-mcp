/**
 * aim.ts — what `desktop_act` is aimed at, and the refusals that say the aim cannot be honoured.
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

/**
 * The aimed press would land outside the window it named.
 *
 * `assertPointIsInsideAim` refuses when the point taken from the entity's remembered rect is no
 * longer inside the aimed window — it moved, or it was minimised (rect at -32000). The refusal
 * was right from the first day; what it threw was a plain `Error`, so `GuardedTouchLoop` reported
 * `executor_failed`, whose published first suggestion is "fall back to mouse_click using the
 * entity rect center". That is the coordinate this refusal just rejected, named verbatim: the
 * executor closed the door and the envelope handed back the key (PR 側 codex, 2026-09-09).
 *
 * Distinct from {@link AimedWindowGoneError}: there the window is gone and nothing addressed to
 * it can succeed; here the window is alive and the coordinate is stale, so a fresh
 * `desktop_discover` returns a rect that works.
 */
export class AimedPointOutsideWindowError extends Error {
  readonly hwnd?: bigint;
  constructor(message: string, hwnd?: bigint) {
    super(message);
    this.name = "AimedPointOutsideWindowError";
    this.hwnd = hwnd;
  }
}

/**
 * Every route to the window the call named has failed, and the blind fallback is refused.
 *
 * An unpinned call finishes a failed UIA click by pressing the entity's rect: a title was never a
 * promise about which window, and the rect is all it ever had. A call that named its window by
 * handle is the opposite case — the coordinate is not aimed at anything, and ADR-036 exists to
 * stop exactly that press. So the ladder ends, and this type carries why.
 *
 * Not click-specific: the type / setValue ladder ends the same way after `uiaSetValue` and the
 * background WM_CHAR rung are both spent, and it was still arriving as `executor_failed` — whose
 * advice opens with the coordinate press the click path had just been taught to refuse. Two
 * actions were giving opposite advice about the same aim (2ゲート目の指摘, 2026-09-09).
 *
 * Same shape as {@link AimedPointOutsideWindowError}, different cause — there the aim went stale,
 * here the aim is current and the attempt on it failed.
 */
export class AimedRouteFailedError extends Error {
  readonly hwnd?: bigint;
  constructor(message: string, hwnd?: bigint, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimedRouteFailedError";
    this.hwnd = hwnd;
  }
}
