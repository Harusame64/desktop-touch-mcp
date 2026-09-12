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
const PLACEHOLDER_SOURCE = "\\{tool:([a-z_]+)\\}";

/**
 * The placeholder syntax, for gates and tests. **A string and a factory, not a
 * shared regex** — and that is the whole point of the shape.
 *
 * A global (`/g`) `RegExp` carries `lastIndex`, so a shared instance answers
 * `.test()` for the SAME input as `true`, then `false`, then `true`. Measured. The
 * consumer this module names is the future gate that walks rendered advice looking
 * for a leftover `{tool:` — i.e. exactly a per-line `.test()` loop, which on a
 * shared instance would report **every other line clean** (gate 2, finding 3, on the
 * commit that first exported it). `String.replace` happens to reset `lastIndex`,
 * which is why `renderAdvice` was never affected and why nothing here would have
 * caught it.
 *
 * So: build your own with `placeholderPattern()`, or read `placeholderSource()` and
 * compile what you need. There is no shared instance to borrow.
 */
export function placeholderSource(): string {
  return PLACEHOLDER_SOURCE;
}

/**
 * A FRESH global pattern, every call — for REPLACING. See {@link placeholderSource}.
 *
 * **Not for scanning.** Freshness per call does not help a scanner: the shape this
 * module's own note described — call the factory once, then `.test()` each line —
 * reuses one `/g` instance, and `lastIndex` then makes **two consecutive identical
 * lines alternate between detected and missed** (PR-side codex P2 on `6867088`,
 * which also pointed out that the cell below dodged the real failure mode by
 * calling the factory again each time).
 *
 * **The scanner itself is no longer in this repository.** The detector that answered
 * "does this line still carry a placeholder" — deliberately laxer than this grammar,
 * because a typo is what a scan exists to find — was carried out of this change on
 * 2026-09-13, verbatim and with its battery, to the route-check work that will
 * consume it. Thirteen review rounds had hardened it against a corpus this product
 * does not have yet. So when a gate is written it takes that detector; it does not
 * hoist a `/g` of its own from this source, which is the alternating bug above.
 */
export function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, "g");
}

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
 * AND NONE OF THE 21 IS AN ADVICE STRING (gate 2, finding 4, which classified them):
 * 14 sit in tool DESCRIPTION strings, 3 in source comments, 4 in `it(…)` titles, and
 * **0 in `SUGGESTS` or in any advice builder**. So the number of advice strings a
 * widened capture could corrupt today is **zero**; what it measures is the collision
 * surface if a description or an example ever becomes advice. Worth keeping for that
 * reason, worth not overstating.
 *
 * **ONE CLASS OF WIDENING IS NOT CAUGHT BY BEHAVIOUR**, and the verbatim fallback is
 * what removed it: widen the capture to `[^}]+` and `{tool:"screenshot", args:{…}`
 * is captured, fails `isCapability`, and is returned VERBATIM — byte-identical
 * output, green cells.
 *
 * NO GENERAL RULE IS STATED HERE, and that is the finding. Two attempts were made
 * to say which wideners behaviour can catch, and **both were measured false** — the
 * second one ("invisible only while both braces are intact") in both directions at
 * once. What is left is a table, its method, and a warning that the table moves.
 *
 * Measured by mutating `PLACEHOLDER_SOURCE` in a copy outside the repo and running
 * this module's cell file per mutation. Counts are BEHAVIOURAL cells: the text pin
 * fires for every mutation, so counting it would be counting the guard as evidence
 * for the thing it replaces.
 *
 * **RE-MEASURED 2026-09-13, on the tree that no longer holds the detector** (16 cells,
 * baseline 16/16 as the positive control). Two rows moved, and one of them is a LOSS
 * that the removal caused — said here rather than left for a reader to discover.
 *
 *   `\{tool:([^}]+)\}`       0   the classic widening: captures `"screenshot", …`,
 *                                fails `isCapability`, returns verbatim
 *   `\{?tool:([a-z_]+)\}`    0   opening brace optional — greedy, so it is consumed
 *   `[a-z_]*\{tool:([a-z_]+)\}`
 *                            0   match may begin outside the placeholder (written
 *                                out rather than elided: an elided mutation cannot
 *                                be re-derived — gate 2 round 4, finding 8. That
 *                                finding had three parts and used to be cited twice
 *                                in this file on purpose, here and beside the
 *                                battery's counts; the second citation left with the
 *                                detector on 2026-09-13, so this is now the only one)
 *   `\{tool:([a-z_]+)\}?`    0   closing brace optional. **It was 1 at `25f9bb3`, and
 *                                the cell that caught it was the detector's — so this
 *                                widening is now caught by nothing in this
 *                                repository.** The detector left on 2026-09-13 with
 *                                its battery; until the gate that owns it is written,
 *                                this row is the measured cost of that move
 *   `\{tool:(.+)\}`          3   one match spans two placeholders
 *   `\{([^}]+)\}`            8   capture becomes `tool:set_value`, so a GENUINE
 *                                placeholder stops resolving
 *   `\{tool:([a-z_]+)`       8   no closing brace: a stray `}` ships in the output.
 *                                **Was 9 at `25f9bb3`** — the ninth was that same
 *                                cell, and this one is not a loss: eight behavioural
 *                                cells still redden
 *
 * **THE SAME MUTATIONS HAVE GIVEN DIFFERENT ANSWERS ON THIS BRANCH**, so each number
 * is named with the tree it was measured on (gate 2 round 4, finding 5, which
 * corrected two rows and the causal phrasing of a third):
 *
 *   `\{tool:([^}]+)\}`     0 at `6867088` → 1 at `8375314` → 0 at `25f9bb3` → 0 here
 *   `\{tool:([a-z_]+)\}?`  0 at `6867088` → 0 at `8375314` → 1 at `25f9bb3` → **0
 *                          here**. It moved twice, in opposite directions and for
 *                          opposite reasons: up when the malformed-verbatim loop gave
 *                          the detector's cell something to catch, back down when that
 *                          cell was removed. A row can fall because coverage was lost
 *   `\{([^}]+)\}`          8 at `6867088` (15 cells) → 9 at `8375314` (16) → 8 at
 *                          `25f9bb3` (16) → 8 here (16) — the differences are the
 *                          cells' CONTENT, not their number; the count on this branch
 *                          no longer only rises, because cells left it
 *
 * **The commits between `25f9bb3` and the removal were never re-measured with these
 * mutants**, so no number is quoted for them: every round after it changed the
 * detector, which the mutants do not touch, and the table was left where it was
 * measured rather than being carried forward as if it had been.
 *
 * The counts were first recorded in this file at `25f9bb3`; the earlier generations
 * carried rows without numbers, so "the numbers moved each time" was describing
 * measurements that had not been written down. So: **the blind spot is a function of the inputs
 * the cells contain, not of the mutation space**, a count without its tree is not a
 * number, and **any widening nobody has run is unobserved rather than invisible.**
 * Which is why the pattern's text is pinned directly, and why this comment carries a
 * table instead of a law.
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
 * loud signal belongs in a gate — an advice line still carrying a placeholder after
 * rendering is a defect, and that check is configuration-independent — rather
 * than in the failure path of a running server. **Stated as a detector, not as a
 * substring**: "still contains `{tool:`" was the earlier wording and it
 * disagrees with the one that was built, which deliberately passes the product's quoted
 * `run_macro({tool:"…"})` — a reader implementing the substring rule would flag that
 * syntax (gate 2 round 4, finding 7). **No number is quoted for it**: the earlier
 * "21 false positives" borrowed an occurrence count for a per-LINE scan (11 lines),
 * and borrowed the repo-wide population for a gate that reads only rendered advice,
 * where this file's own classification says the count is **0** — none of the 21 is an
 * advice string (gate 2 round 5, finding 6). One rule, one home. **That gate does not exist anywhere in
 * this repository yet** — no test and no script scans advice for a leftover
 * `{tool:`, verified rather than assumed — so until one is written, a leftover
 * placeholder is caught by nobody. **And the detector built for it left with this
 * change** — the user's decision of 2026-09-13, because it had drawn thirteen review
 * rounds while the corpus it guards is still empty: it is kept verbatim, with its
 * battery and with the defects still open against it, beside the gate that will call
 * it. **When that gate is written it takes that detector**, not a pattern of its own
 * and not the `/g` factory: the
 * first version of this note described the trap it was trying to prevent. Stated in the future tense on purpose: the
 * present tense would tell a reader they are covered when they are not. (The
 * sequencing that owes it lives in the internal ADR-036 spec, which this repo does
 * not contain; naming a stage letter here would be a reference no reader can
 * follow — gate 2, finding 9.)
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
 * It exists because the union and the placeholder pattern's character class are
 * otherwise UNLINKED: a capability named `read_uia2` or `readTree` would compile, be
 * `KNOWN`, and have a `switch` arm — and `{tool:read_uia2}` could never match
 * `[a-z_]+`, so it would be left verbatim and read exactly like a typo. A cell walks
 * this list **through the pattern itself** — matching `{tool:<name>}` and requiring
 * the whole placeholder to be consumed — rather than against a re-typed character
 * class, which was the first version and reintroduced the very drift this list
 * exists to prevent (gate 2, findings 8 and, for the re-typed class, 2).
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
/**
 * THE FLAG IS THE SURFACE HERE, and that took three rounds to establish — two of
 * them spent building for a state that cannot happen.
 *
 * The worry was real in shape (PR-side codex P2 on `131c663`, verified in source):
 * `server-windows.ts` pre-loads the v2 module as `await import(…).catch(() => null)`
 * — a failed load is swallowed so the server still starts — and registration then
 * branches on `_desktopV2`, not on the flag. A null module publishes the three V1
 * fallback tools while the flag still says `enabled: true`, so advice would name
 * `desktop_discover` over a V1 surface: this ADR's own defect, inside the fix.
 *
 * **It cannot happen, for BOTH causes, because a static import edge dominates the
 * dynamic one:**
 *
 *   `server-windows.ts:22`  `import { registerMacroTools } from "./tools/macro.js"`
 *   `macro.ts:132-137`      `import { desktopDiscoverRegistrationSchema, … }`
 *                           `  from "./desktop-register.js"`
 *   and nothing imports `macro.ts` dynamically (measured: zero `import(…macro…)`)
 *
 * ESM evaluates a module's static dependency graph **before** running its body, so
 * `desktop-register.js` is evaluated before `server-windows.ts` reaches line 98 at
 * all. A missing file fails at link — measured on Windows,
 * `ERR_MODULE_NOT_FOUND … imported from …/dist/tools/macro.js`, and the server never
 * starts. **And a module that RESOLVES but throws while evaluating follows the same
 * edge** (PR-side codex P2 on `e670ad7`), so it too fails before the `catch` exists
 * to catch it — reproduced outside the repo with a four-module graph: with a
 * dependency that throws at evaluation, neither the importing module's body nor its
 * `catch` ran (gate 2 round 6). The `catch` at line 99 is unreachable for either
 * cause.
 *
 * So **the Windows server** has no fifth state to model, and the optional `Surface`
 * parameter that used to sit here — with its cell, asserting how resolution behaves
 * for a flag/surface divergence — **is removed**. Two rounds found the defect the
 * other way round each time: first "the flag lies" (it does not, on any path this
 * server can reach), then "so build for it" (there is nothing to build for).
 *
 * **THE SENTENCE THAT USED TO STAND HERE SAID "no publishable configuration", AND
 * THAT IS FALSE** (gate 2 round 6, finding 2, verified here). `index.ts:15-18`
 * branches on `process.platform === "win32"` and otherwise loads
 * `server-linux-stub.js`, whose catalogue has **30 entries** — and of the **six**
 * tools this table names (five capabilities, six providers) **only `key_locker` is
 * in it** (`stub-tool-catalog.ts:809`). `resolveV2Activation` has **no platform
 * gate**; the `Dockerfile` ships `node dist/index.js` on Debian.
 *
 * So on that entry point **the answer names absent tools in EITHER corner**: v2's
 * `desktop_discover` / `desktop_act` are missing, and so are the kill switch's
 * `get_ui_elements` / `get_windows` / `set_element_value`. That is worth stating
 * precisely, because it is the reason a `Surface` parameter would not have repaired
 * it — there is no corner of this surface to switch to (gate 2 round 7, findings 3
 * and 4, which corrected "none of the five" and the axis). It is **latent**: nothing calls `renderAdvice` yet and the stub answers
 * `UnsupportedPlatform` to everything. But it is the reason the argument above is
 * now scoped to the Windows server, and it is filed for the change that wires the
 * presenter.
 *
 * **What would have to change for the divergence to exist**: break that static edge
 * — `macro.ts` imports the v2 schemas statically, which is what welds the two — and
 * then the `catch` becomes reachable and this parameter becomes necessary. Filed in
 * the internal remaining-work; it is a product change, not a mechanism one.
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
 * everything; an unknown name stays verbatim while its line-mates still resolve.**
 * (An earlier wording said "verbatim beats resolve", which is not a relation this
 * code has — verbatim and resolve are per-PLACEHOLDER and independent, and only
 * drop is a whole-line fate. Gate 2 round 3, finding 5, found the cell showing the
 * opposite of the phrase it was meant to pin — the round is named because a later
 * round's finding 5 is a different one.) An unknown capability sharing a line with
 * one that has no provider here is dropped along with it, so the visible breakage
 * never reaches a caller; an unknown capability alone SHIPS, placeholder and all.
 * Both are reachable the moment a typo meets a kill switch, and both are pinned —
 * neither was until gate 2 asked for it (finding 9).
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
  // One pattern for this call, not one per line. Hoisted after gate 2 pointed out
  // that the loop was building a RegExp per line while the module's own note
  // explains why it needs none: `String.replace` resets `lastIndex`, so even a
  // single shared instance would be correct here (measured — a module-level shared
  // `/g` passes every cell). The factory call stays inside `renderAdvice` rather
  // than at module level so that no module-level GLOBAL regex exists for a later
  // edit to export. ("mutable" was the earlier wording and was corrected: the
  // property meant is the `/g` flag, not mutability — gate 2 round 5, finding 7. The
  // module-level regex that made that distinction concrete, `DETECT_LEFTOVER`, left
  // this file with the detector on 2026-09-13, so there is now no module-level regex
  // here at all.) A module-level `const` would not be exported either, so that
  // reason alone does not choose between the two — and the rejected option demonstrably
  // works (a shared module-level `/g` passes every cell, measured twice). This is a
  // preference with a narrow reason, stated as such (gate 2 round 4, finding 9).
  const pattern = placeholderPattern();
  for (const line of lines) {
    let dropped = false;
    const rendered = line.replace(pattern, (whole: string, cap: string) => {
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
