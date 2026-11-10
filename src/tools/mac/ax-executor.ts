/**
 * Mac port M2-2: desktop_act through macOS Accessibility.
 *
 * Acts on the element `locator.ax` names, through the native `macAx*` calls,
 * which refuse when its window changed or the element is not found by its
 * keys (at its path, or — when it was unique — where it moved; internal #260). Nothing
 * here takes the foreground: AXPress and AXValue reach a background app.
 *
 * Refusals map onto the touch loop's existing reasons (guarded-touch.ts):
 * - the element is gone or no longer what was read → `TargetGoneError`
 *   (`entity_not_found`: nothing was done; discover again);
 * - a write the app accepted but whose value did not become the text →
 *   `ValueNotAppliedError` (`value_not_applied`);
 * - anything else → a plain error (`executor_failed`).
 *
 * `type` and `setValue` both replace the field's whole value, as `type`
 * through UI Automation does on Windows.
 */

import type { NativeMacActResult, NativeMacAxTarget } from "../../engine/native-types.js";
import { TargetGoneError, ValueNotAppliedError } from "../../engine/aim.js";
import type { ExecutorFn } from "../desktop.js";
import type { ExecutorOutcome } from "../../engine/world-graph/types.js";

export interface MacAxExecutorDeps {
  perform(target: NativeMacAxTarget, action: string): Promise<NativeMacActResult>;
  setValue(target: NativeMacAxTarget, value: string): Promise<NativeMacActResult>;
  /** Insert at a UTF-16 offset (negative = end) through the selection; the rest of the text is untouched. */
  insertText?(target: NativeMacAxTarget, text: string, at?: number): Promise<NativeMacActResult>;
  /** Whether this act was asked to append (desktop_act `append: true`) rather than replace. */
  appendMode?(): boolean;
}

/** Mirrors `VALUE_CHAR_CAP` in src/macos/ax.rs. */
export const VALUE_CHAR_CAP = 2000;

/** `invalid_ui_element`: the element was destroyed between the read and the act. */
const GONE = new Set(["element_not_found", "element_changed", "invalid_ui_element"]);

/** A sheet or app-modal window blocks the element (the native act checked; nothing was done). */
export class ModalBlockingError extends Error {
  readonly callerDetail: string;
  constructor(blocker: string | undefined) {
    super(`modal_blocking: ${blocker ?? "unknown"}`);
    this.name = "ModalBlockingError";
    const [kind, ...rest] = (blocker ?? "").split(":");
    const title = rest.join(":");
    this.callerDetail =
      kind === "sheet"
        ? `A sheet is open on this window${title ? ` ("${title}")` : ""}; nothing behind it was touched. Answer the sheet first: ` +
          "desktop_discover on the window again, or — when its controls are drawn by another process, as the open/save panel's are — on the sheet's own title (e.g. \"保存\" / \"Save\")."
        : `A modal window of this app is open${title ? ` ("${title}")` : ""}; nothing was touched. Answer it first (desktop_discover with its title).`;
  }
}

function refuse(r: NativeMacActResult, what: string): never {
  const reason = r.reason ?? "unknown";
  if (reason === "modal_blocking") throw new ModalBlockingError(r.blocker);
  if (reason === "not_applied_after_press") {
    // The native write pressed an unfocused web field to focus it, then the write failed: something was done.
    throw new ValueNotAppliedError(
      `${what}: ${reason}`,
      undefined,
      "The field did not take the write, so it was pressed to focus it, and the write after that failed (the page may have replaced the field). Discover again and check the field before typing."
    );
  }
  if (GONE.has(reason)) {
    throw new TargetGoneError(
      `${what}: ${reason}`,
      undefined,
      reason === "element_changed"
        ? "The element this act named is not what it was read as: its window changed since desktop_discover, or nothing in it is that element now (or more than one is). Nothing was done."
        : "The element this act named is no longer there. Nothing was done."
    );
  }
  throw new MacAxActError(`${what}: ${reason}`, reason);
}

/**
 * Any other refusal or AX error (`action_not_advertised`, `value_not_settable`, `cannot_complete`, ...):
 * the touch loop reports `executor_failed`, and the native reason — our own vocabulary, never the
 * app's text — is published as the detail (`callerDetail`, aim.ts `CallerFacingRefusal`).
 */
export class MacAxActError extends Error {
  readonly callerDetail: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "MacAxActError";
    this.callerDetail = `The Accessibility act was refused or failed: ${reason}. Nothing is known to have been done.`;
  }
}

/**
 * Refusals of an open that come before anything was asked of the app: the element was not found by
 * its keys, it does not advertise AXOpen, or a sheet blocks it. Nothing was done.
 */
const OPEN_NOT_SENT = new Set(["element_not_found", "element_changed", "action_not_advertised", "modal_blocking"]);

/**
 * internal #259 — open a cell (a Finder sidebar entry or list row) with AXOpen, as a double-click
 * does: a folder opens in the window, a file in its app.
 *
 * AXOpen does not answer for what it did. Finder opened the item and answered
 * `attribute_unsupported` every time (2026-11-10, macOS 27.2: three sidebar entries and a folder row,
 * 5 of 5), and an opened item can take its cell with it. So once the action was sent, a failure is
 * not "nothing was done": the act answers success with the open unconfirmed (`landing`), and the
 * caller reads the view (`diff`, or discover again) to see whether it opened.
 */
async function openCell(deps: MacAxExecutorDeps, target: NativeMacAxTarget): Promise<ExecutorOutcome> {
  const r = await deps.perform(target, "AXOpen");
  if (r.ok) return { kind: "ax" };
  if (OPEN_NOT_SENT.has(r.reason ?? "")) refuse(r, "open");
  return {
    kind: "ax",
    landing: {
      confirmed: false,
      why: `The app answered the open with ${r.reason ?? "an error"}; Finder answers so even when the item opened. Read the view (diff, or desktop_discover again) to see whether it opened.`,
      referenceFrom: "ax_open",
    },
  };
}

export function createMacAxExecutor(deps: MacAxExecutorDeps): ExecutorFn {
  return async (entity, action, text) => {
    const ax = entity.locator?.ax;
    if (ax === undefined) throw new MacAxActError("mac executor: the entity has no AX locator", "no_ax_locator");
    const target: NativeMacAxTarget = {
      pid: ax.pid,
      id: ax.id,
      expectedRole: ax.role,
      expectedRootKey: ax.rootKey,
      expectedElementKey: ax.elementKey,
      relocatable: ax.unique === true,
    };

    if (action === "type" || action === "setValue") {
      // `auto` on a type-only field resolves to `type`; without text it must not fall to a press.
      if (text === undefined) throw new MacAxActError(`${action}: no text`, "text_required");
      if (deps.appendMode?.() === true) {
        // Append without reading the old text back in: replacing with "old + new" would cut a long
        // document at the read cap and delete the rest (codex, #782).
        if (deps.insertText === undefined) throw new MacAxActError("append: not available", "append_unavailable");
        const r = await deps.insertText(target, text, -1);
        if (!r.ok) refuse(r, "append");
        // The read-back is capped, so the end can be checked only when the whole text came back.
        const after = r.valueAfter;
        if (after !== undefined && Array.from(after).length < VALUE_CHAR_CAP && !after.endsWith(text)) {
          throw new ValueNotAppliedError(
            "append: the field does not end with the text written",
            undefined,
            "The app accepted the insertion but the field does not end with the text now."
          );
        }
        return "ax";
      }
      const r = await deps.setValue(target, text);
      if (!r.ok) refuse(r, "setValue");
      // The native read-back is capped at VALUE_CHAR_CAP characters (src/macos/ax.rs).
      if (r.valueAfter !== undefined && r.valueAfter !== Array.from(text).slice(0, VALUE_CHAR_CAP).join("")) {
        throw new ValueNotAppliedError(
          "setValue: the value read back is not the text written",
          undefined,
          "The app accepted the write but the field does not hold the text now (it may reformat or reject it)."
        );
      }
      return "ax";
    }

    if (ax.role === "AXCell") {
      // Only invoke opens a cell (the loop refuses the rest first; this holds if a caller did not).
      if (action !== "invoke") throw new MacAxActError(`${action} on a cell: only invoke opens it`, "invoke_required");
      return openCell(deps, target);
    }

    // click / invoke / auto: the native call presses only what the element advertises.
    const r = await deps.perform(target, "AXPress");
    if (!r.ok) refuse(r, "press");
    return "ax";
  };
}
