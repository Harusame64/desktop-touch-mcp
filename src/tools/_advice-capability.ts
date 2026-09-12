/**
 * ADR-036 — advice names a CAPABILITY; this module resolves it to the tool that
 * provides it in the configuration currently running.
 *
 * WHY. A switch hides a tool, and nothing hides the advice that recommends it.
 * `paneIdMissSuggest` is a pure function of `paneId`, so its output is
 * byte-identical at all four corners of the two kill switches and keeps naming
 * `key_locker` in the two corners where the locker is gone (measured on Windows).
 * None of the four advice builders takes the configuration as an input, so fixing
 * wordings cannot hold: the next pure function written the same way reintroduces
 * it. The fix has to sit in the layer that knows the configuration.
 *
 * CAPABILITIES ARE CUT AT THE RECOVERY, NOT AT THE IMPLEMENTATION. The first
 * version of this table was cut at the implementation ("raw UIA tree", "window
 * list with handles") and measurement broke two of its rows in OPPOSITE
 * directions: the kill switch cannot list windows with handles, and v2 does not
 * return a raw tree (20 nodes, `automationId` 0, `rect` 0, re-taken in three
 * modes). What the advice actually wants is "identify the element again", and
 * BOTH surfaces do that — one through entities, one through the tree. Only the
 * grain was wrong.
 *
 * AND THE ORIGINAL DESIGN'S COVERAGE CLAIM IS FALSE AS MEASURED. The kill-switch
 * fallback re-publishes three V1 tools with the comment "so the operator does not
 * lose function coverage". Coverage is not preserved in either direction: the
 * absorption consolidated a SURFACE, it did not preserve capability. So a
 * capability can be missing on the surface-swap switch too — which is why
 * dropping a line is NOT confined to the locker (an earlier version of this
 * comment said it was).
 */

import { resolveV2Activation } from "./desktop-activation.js";
import { keyLockerDisabled } from "../engine/key-locker/key-locker-manager.js";

/**
 * A capability is listed here only when naming its provider directly could hand a
 * caller a tool it cannot call, or one that cannot do what the sentence promises.
 * Not an inventory of what the product can do.
 */
export type Capability =
  /**
   * Identify the element again. BOTH surfaces provide it, differently — v2 via
   * entities (`entityId` / `label` / `role`), the kill switch via the raw tree
   * (`automationId` / `name` / `controlType`).
   *
   * WORDING CONSTRAINT, and it applies to every line using this capability: the
   * two identifiers have different lifetimes. `automationId` survives across
   * calls and can be handed to the next `click_element`; `entityId` is bound to a
   * view and a lease, so a different view can name the same element differently
   * and the lease expires (the measured `LeaseExpired` road). **Advice that reads
   * as "save this id and use it later" is false on v2.** Keep the sentence at
   * "take it again" — which is what re-running discovery does anyway, since that
   * re-takes the lease.
   */
  | "reidentify_element"
  /**
   * List the open windows by title. THREE providers, not one per corner: v2's
   * `desktop_discover`, the kill switch's `get_windows`, and — in every
   * configuration — `screenshot({detail:"meta"})`, which also returns `windows[]`
   * with titles.
   *
   * SELECTION RULE: name the tool whose intent the caller can read. `screenshot`
   * hides the intent in a "list the windows" context, so an enumerating tool wins
   * even though the screenshot road is available everywhere. Written down because
   * the opposite choice is the tempting one — technically safe at all four
   * corners, and worse as advice.
   */
  | "list_window_titles"
  /**
   * Name ONE window out of several wearing the same title, by its handle.
   * **v2 only.** `get_windows` returns titles and no handles at all (0 of 10, no
   * `hwnd`/`handle` string in the response, and it takes no arguments, so there is
   * not even a flag to ask). `get_ui_elements` does carry `nativeWindowHandle`,
   * but only for a window the caller has ALREADY named — it cannot enumerate
   * candidates. And `desktop_state` returns a handle only for the focused window
   * and the one under the cursor, which is not an answer about "which of these".
   */
  | "disambiguate_window_by_handle"
  /** Set a value through UIA ValuePattern. Both corners, measured: the kill switch reports `channel: "value"`, v2 reports `channel: "uia"`, and neither fell through to the keyboard. */
  | "set_value"
  /** Store a credential. Gone entirely when the locker switch is set — the one capability with no provider rather than a different one. */
  | "credential_store";

/**
 * Advice text carries `{tool:<capability>}`. Named rather than a bare `{tool}`
 * because 9 lines mix a configuration-dependent name with names available
 * everywhere (`"…fall back to mouse_click({clickAt}) using the entity rect centre
 * from desktop_discover…"`), so a single anonymous placeholder cannot say which
 * name is the one to resolve. One line names two dependent tools, which the named
 * form also covers — so the capability lives IN the text and there is no separate
 * field to drift out of sync with it.
 */
const PLACEHOLDER = /\{tool:([a-z_]+)\}/g;

/**
 * DO NOT LOOSEN THAT PATTERN. `{tool:` is already real syntax in this product —
 * `run_macro({tool:"screenshot", args:{…}})` appears in tool descriptions,
 * examples and tests (`macro.ts`, `ui-elements.ts`, `stub-tool-catalog.ts`,
 * `tool-naming-phase4.test.ts`). It does not collide today only because the
 * capture is `[a-z_]+` and every real use has a QUOTE right after the colon
 * (`{tool:"…"`), or a comma (`{tool, params}`). Measured: 0 matches across the
 * product. Widen the capture to `[^}]+` and it catches 21 REAL places — measured
 * independently on the Windows machine over `src` and `tests`: four files contain
 * `{tool:`, this pattern matches 0 of them, the widened pattern 21
 * (`{tool:'focus_window',params:{…}` and friends). The cell that goes red when
 * someone widens this is guarding 21 existing strings, not a hypothetical.
 */

/**
 * The capabilities, as a value. A `Record<Capability, true>` rather than a second
 * list: the compiler rejects a missing key AND an extra one, so this cannot drift
 * from the union above.
 *
 * WHY A RUNTIME CHECK AT ALL, when `Capability` is a type. A placeholder is a
 * STRING, and the compiler never reads inside a string — so `{tool:reidentify_elemnt}`
 * is a typo no gate in this file can catch, and what it does at runtime is this
 * module's choice. Measured before choosing: with no check, an unknown name falls
 * off the end of `providerFor`'s exhaustive `switch`, the `=== null` guard cannot
 * fire, and the line renders the literal word `undefined` — `"x {tool:nope} y"`
 * came back as `"x undefined y"`. That is the WORST of the available outcomes,
 * because "…use undefined to reopen the pane" still reads as a sentence, while an
 * unresolved `{tool:…}` reads as broken. So an unknown capability is left VERBATIM.
 *
 * AND IT IS NOT AN EXCEPTION, deliberately. This module renders on the FAILURE
 * road: every caller is already building a refusal. Throwing here would turn a
 * tool failure into an unhandled error and cost the envelope, the code and the
 * other advice lines — the fix failing into the shape of the bug it fixes. The
 * loud signal belongs in the gate (an advice line that still contains `{tool:`
 * after rendering is a defect, and that check is configuration-independent), not
 * in the failure path of a running server.
 */
const KNOWN: Record<Capability, true> = {
  reidentify_element: true,
  list_window_titles: true,
  disambiguate_window_by_handle: true,
  set_value: true,
  credential_store: true,
};

function isCapability(name: string): name is Capability {
  return Object.prototype.hasOwnProperty.call(KNOWN, name);
}

/**
 * The provider of `cap` in the configuration described by `env`, or `null` when
 * that configuration has no provider — in which case the line is dropped.
 *
 * The predicates are the ones REGISTRATION reads. Deliberate: resolution reading a
 * different source of truth than registration would drift silently the first time
 * one of them changed. `resolveV2Activation` takes `env`, which makes three of the
 * four corners reproducible in a unit test with no Windows machine.
 */
export function providerFor(
  cap: Capability,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const v2 = resolveV2Activation(env).enabled;
  switch (cap) {
    case "reidentify_element":
      return v2 ? "desktop_discover" : "get_ui_elements";
    case "list_window_titles":
      return v2 ? "desktop_discover" : "get_windows";
    case "disambiguate_window_by_handle":
      return v2 ? "desktop_discover" : null;
    case "set_value":
      return v2 ? "desktop_act" : "set_element_value";
    case "credential_store":
      // Reads `process.env` directly because it owns the live kill switch, so an
      // `env` argument cannot override it. The other three corners still work.
      return keyLockerDisabled() ? null : "key_locker";
  }
}

/** An advice line: plain text, or text carrying `{tool:<capability>}` placeholders. */
export type AdviceLine = string;

/**
 * Render advice for the configuration in `env`.
 *
 * A line with no placeholder passes through BYTE-IDENTICAL, including any tool
 * name already written into it. That is what lets the mechanism ship with zero
 * lines converted: every existing line keeps its exact bytes and the suite staying
 * green means the mechanism broke nothing — not that the advice is correct.
 *
 * A line whose placeholders all resolve is rendered. A line with ANY placeholder
 * whose capability has no provider here is DROPPED, and that now happens on both
 * switches: `disambiguate_window_by_handle` has no kill-switch provider, and
 * `credential_store` none with the locker off. Two reasons, one behaviour — the
 * capability is absent, either because it was removed or because the replacement
 * surface does not have it.
 *
 * NOT HANDLED, and filed rather than guessed: two lines name a dependent tool as
 * one MEMBER OF A LIST of similar tools ("…(keyboard / desktop_act /
 * browser_click)…"). Neither operation fits — resolving is wrong because the
 * sentence is not telling the caller to use it, dropping is wrong because the
 * sentence stays true without it. Those need a third operation (remove one name
 * from a list, keep the sentence) and are left alone until the shape is decided.
 */
export function renderAdvice(
  lines: readonly AdviceLine[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let dropped = false;
    const rendered = line.replace(PLACEHOLDER, (whole: string, cap: string) => {
      // A capability this module does not know stays verbatim — visibly broken
      // beats a sentence that reads as advice. See the note on `KNOWN`.
      if (!isCapability(cap)) return whole;
      const tool = providerFor(cap, env);
      if (tool === null) {
        dropped = true;
        return "";
      }
      return tool;
    });
    if (!dropped) out.push(rendered);
  }
  return out;
}
