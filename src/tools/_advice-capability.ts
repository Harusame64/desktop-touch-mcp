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
export const PLACEHOLDER = /\{tool:([a-z_]+)\}/g;

/**
 * DO NOT LOOSEN THAT PATTERN. `{tool:` is already real syntax in this product —
 * `run_macro({tool:"screenshot", args:{…}})` appears in tool descriptions,
 * examples and tests (`macro.ts`, `ui-elements.ts`, `stub-tool-catalog.ts`,
 * `tool-naming-phase4.test.ts`). It does not collide today only because the
 * capture is `[a-z_]+` and every real use has a QUOTE right after the colon
 * (`{tool:"…"`), or a comma (`{tool, params}`).
 *
 * THE NUMBERS, WITH THEIR METHOD, because two counts of "the same thing" disagreed
 * and both were right (measured 2026-09-12 over `src` and `tests`):
 *
 *   `{tool:` occurrences outside this module and its test ... 21, on 11 lines, in 4
 *     files (`stub-tool-catalog.ts` 7, `macro.ts` 9, `ui-elements.ts` 1,
 *     `tool-naming-phase4.test.ts` 4)
 *   this pattern, `[a-z_]+` ......................... 0 of them
 *   a widened `[^}]+` capture, applied per STRING .... 20 of them
 *   the same widened capture, applied to whole files . 21 — `[^}]` matches newlines,
 *     so it spans the one occurrence (`macro.ts:274`) whose closing brace is on the
 *     next line
 *
 * The per-string number is the operative one: `renderAdvice` applies the pattern to
 * one advice string at a time. A count is meaningless without its method, and this
 * pair is the cheapest available reminder — the Windows measurement said 21 and
 * gate 2 said 20 for the same mutation.
 *
 * **WIDENING IS NOT CAUGHT BY BEHAVIOUR.** It used to be, and the verbatim fallback
 * added alongside this comment is what removed it: widen the capture and
 * `{tool:"screenshot", args:{…}` is captured, fails `isCapability`, and is returned
 * VERBATIM — byte-identical output, green cells. Generally, **every mutation that
 * makes this pattern match MORE is now invisible behaviourally**, and only ones
 * that make it match LESS can be observed. So a cell asserts `PLACEHOLDER.source`
 * directly (gate 2, finding 2 — it found this comment claiming a guard the same
 * commit had destroyed).
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
 * loud signal belongs in a gate — an advice line that still contains `{tool:` after
 * rendering is a defect, and that check is configuration-independent — rather than
 * in the failure path of a running server. **That gate does not exist yet**: it is
 * stage B4 in the spec, and until it is written a leftover placeholder is caught by
 * nobody. Stated in the future tense on purpose, because the present tense here
 * would tell a reader they are covered when they are not.
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
 * The capability names, for gates and tests. Derived from `KNOWN` rather than
 * written again, so it cannot list something the resolver does not know.
 *
 * It exists because the union and `PLACEHOLDER`'s character class are otherwise
 * UNLINKED: a capability named `read_uia2` or `readTree` would compile, be `KNOWN`,
 * and have a `switch` arm — and `{tool:read_uia2}` could never match `[a-z_]+`, so
 * it would be left verbatim and read exactly like a typo. A cell walks this list
 * against the pattern's class (gate 2, finding 8).
 */
export const CAPABILITIES: readonly Capability[] = Object.keys(KNOWN) as Capability[];

/**
 * The provider of `cap` in the configuration described by `env`, or `null` when
 * that configuration has no provider — in which case the line is dropped.
 *
 * THERE IS A THIRD RETURN THE SIGNATURE DOES NOT NAME. The `switch` is exhaustive
 * over `Capability`, so a `cap` from outside the union falls off its end and this
 * returns `undefined` (measured). TypeScript stops that at a typed call site, but
 * `tests/**` is outside `tsconfig.json`'s `include` and eslint here is not
 * type-aware, so a test-side or future caller can pass a string straight through.
 * **`renderAdvice` is the only placeholder-safe entry point** — it screens with
 * `isCapability` first. Call this directly only with a literal from the union
 * (gate 2, finding 7).
 *
 * The predicates are the ones REGISTRATION reads. Deliberate: resolution reading a
 * different source of truth than registration would drift silently the first time
 * one of them changed. Both take `env`, which makes ALL FOUR corners reproducible in
 * a unit test with no Windows machine — `keyLockerDisabled` did not take one until
 * codex pointed out that this function then answered for the wrong configuration.
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
      // `env` is passed on, like every other capability here. It did not used to be:
      // `keyLockerDisabled()` read the ambient process, which made this the ONE
      // capability that ignored the configuration it was handed — `providerFor
      // ("credential_store", { DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1" })` still
      // answered `key_locker`, and the inverse mismatch dropped a line that the
      // named configuration provides. A signature that takes a configuration and
      // then models a different one for one of its five answers is worse than one
      // that never took it (PR-side codex P2 on `64e69a2`). The shared predicate was
      // widened rather than re-implemented here, so the switch keeps one reader.
      return keyLockerDisabled(env) ? null : "key_locker";
  }
}

/**
 * An advice line: plain text, or text carrying `{tool:<capability>}` placeholders.
 *
 * A plain alias, and it buys nothing — annotating a string with it does not check
 * that its placeholders name real capabilities, because the compiler never reads
 * inside a string. It is here to name the argument's ROLE, not to validate it
 * (gate 2, finding 12).
 */
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
 * PRECEDENCE, for a line carrying more than one kind of placeholder: **drop beats
 * verbatim, verbatim beats resolve.** An unknown capability sharing a line with one
 * that has no provider here is dropped along with it, so the visible breakage never
 * reaches a caller; an unknown capability alone SHIPS, placeholder and all. Both are
 * reachable the moment a typo meets a kill switch, and both are now pinned — neither
 * was until gate 2 asked for it (finding 9).
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
        // Discarded — the whole line is dropped below. Returning the placeholder
        // rather than "" so that nothing reads as "the sentence survives with the
        // name blanked out", which is a behaviour this module does not have.
        return whole;
      }
      return tool;
    });
    if (!dropped) out.push(rendered);
  }
  return out;
}
