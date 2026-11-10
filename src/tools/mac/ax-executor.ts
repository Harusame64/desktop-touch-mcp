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

export interface MacAxExecutorDeps {
  perform(target: NativeMacAxTarget, action: string): Promise<NativeMacActResult>;
  setValue(target: NativeMacAxTarget, value: string): Promise<NativeMacActResult>;
  /** Insert at a UTF-16 offset (negative = end) through the selection; the rest of the text is untouched. */
  insertText?(target: NativeMacAxTarget, text: string, at?: number): Promise<NativeMacActResult>;
  /** Whether this act was asked to append (desktop_act `append: true`) rather than replace. */
  appendMode?(): boolean;
  /**
   * internal #259 — an open was sent and the app did not confirm it; the tool says so beside the
   * result (`open.confirmed: false`). Not the touch loop's `landing`: that is ADR-036's keyboard
   * landing axis, which the route grid counts, and a mac open is not one of its roads.
   */
  noteOpenUnconfirmed?(why: string): void;
  /**
   * internal #259 — the name of the list item at this target now (`nameOpenableCells`), undefined
   * when there is none or it cannot be read. The native act checks a cell by its element key, which
   * holds no name, so a row that now holds another item would pass it (gate 2 on #927).
   */
  itemNameAt?(target: NativeMacAxTarget): Promise<string | undefined>;
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
 * internal #259 — open a list item (a Finder sidebar entry or list row) with AXOpen, as a double-click
 * does: a folder opens in the window, a file in its app.
 *
 * AXOpen does not answer for what it did. Finder opened the item and answered
 * `attribute_unsupported` every time (2026-11-10, macOS 27.2: three sidebar entries and a folder row,
 * 5 of 5). Only that measured answer is taken as "sent, not confirmed": the act answers success and
 * the tool says the open is unconfirmed (`noteOpenUnconfirmed`). Every other failure refuses (gate 2
 * on #927: an allowlist, so a reason added later, or one that means nothing was sent, cannot pass for
 * a success) — `invalid_ui_element` with "not known whether it was done": an opened item can take its
 * cell with it, so "the element is gone; nothing was done" would not hold.
 */
const OPEN_UNCONFIRMED = new Set(["attribute_unsupported"]);

async function openItem(deps: MacAxExecutorDeps, target: NativeMacAxTarget, expectedName: string | undefined): Promise<void> {
  // Read the item's name just before opening: another item sorted into the row is refused, never
  // opened in its place. Fails closed: no reader, no name, or another name — nothing is sent.
  const now = deps.itemNameAt === undefined || expectedName === undefined ? undefined : await deps.itemNameAt(target);
  if (now === undefined || now !== expectedName) {
    throw new TargetGoneError(
      `open: the item is not ${JSON.stringify(expectedName)} now`,
      undefined,
      "The list item this act named is not there now (the row holds another item, or it could not be read). Nothing was done."
    );
  }
  const r = await deps.perform(target, "AXOpen");
  if (r.ok) return;
  const reason = r.reason ?? "unknown";
  if (OPEN_UNCONFIRMED.has(reason)) {
    deps.noteOpenUnconfirmed?.(
      `The app answered the open with ${reason}, which it may do even when the item opened. desktop_discover again to see whether it opened.`
    );
    return;
  }
  if (reason === "invalid_ui_element") throw new MacAxActError(`open: ${reason}`, reason);
  refuse(r, "open");
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

    // A list item opens (internal #259). The same fact the touch loop reads (the entity's role), so
    // the two cannot disagree about which entities open (gate 2 on #927).
    if (entity.role === "listitem") {
      // Only invoke opens one (the loop refuses the rest first; this holds if a caller did not).
      if (action !== "invoke") throw new MacAxActError(`${action} on a list item: only invoke opens it`, "invoke_required");
      await openItem(deps, target, entity.label);
      return "ax";
    }

    // click / invoke / auto: the native call presses only what the element advertises.
    const r = await deps.perform(target, "AXPress");
    if (!r.ok) refuse(r, "press");
    return "ax";
  };
}
