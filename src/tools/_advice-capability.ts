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
import { keyLockerDisabled } from "../engine/key-locker/key-locker-switch.js";

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
  /**
   * The credential locker's own facilities: saving or listing a binding, and
   * launching the anchored console pane that credential autofill keys off. Gone
   * entirely when the locker switch is set — the one capability with no provider
   * rather than a different one.
   *
   * **The name is narrower than the capability, and that is recorded rather than
   * renamed here** (gate 2, 2026-09-13): every advice line that motivated this
   * design recommends `key_locker({action:'launch_console'})` — opening a pane, not
   * storing a secret (`terminal.ts:739`, `:747`, `:756`). Resolution is correct
   * either way, since both roads are the same tool behind the same switch. The
   * rename belongs with the change that converts the lines, because the capability
   * tables that would have to move with it live beside those lines.
   */
  | "credential_store";

/**
 * Advice text carries `{tool:<capability>}`. Named rather than a bare `{tool}`
 * because 9 lines mix a configuration-dependent name with names available
 * everywhere (`"…fall back to mouse_click({clickAt}) using the entity rect centre
 * from desktop_discover…"`), so a single anonymous placeholder cannot say which
 * name is the one to resolve. One line names two dependent tools, which the named
 * form also covers — so the capability lives IN the text and there is no separate
 * field to drift out of sync with it.
 *
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
 * The capabilities, as a value. A `Record<Capability, true>` rather than a second
 * list: the compiler rejects a missing key AND an extra one, so this cannot drift
 * from the union above.
 *
 * WHY A RUNTIME CHECK AT ALL, when `Capability` is a type. A placeholder is a
 * STRING, and the compiler never reads inside a string — so `{tool:reidentify_elemnt}`
 * is a typo no gate in this file can catch, and what it does at runtime is this
 * module's choice. Measured before choosing, on the tree of that day: with no check,
 * an unknown name fell off the end of `providerFor`'s exhaustive `switch`, the
 * `=== null` guard could not fire, and the line rendered the literal word
 * `undefined` — `"x {tool:nope} y"` came back as `"x undefined y"`. That was the
 * WORST of the available outcomes,
 * because "…use undefined to reopen the pane" still reads as a sentence, while an
 * unresolved `{tool:…}` reads as broken. So an unknown capability is left VERBATIM.
 *
 * AND IT IS NOT AN EXCEPTION, deliberately. This module renders on the FAILURE
 * road: every caller is already building a refusal. Throwing here would turn a
 * tool failure into an unhandled error and cost the envelope, the code and the
 * other advice lines — the fix failing into the shape of the bug it fixes. The
 * **What that measurement says TODAY is different, and stronger** (gate 2,
 * 2026-09-13, second round, which caught this paragraph still arguing from the old
 * tree): `providerFor`'s typed road now THROWS on a value from outside the union,
 * so removing this screen would not render `undefined` — it would throw while a
 * refusal is being built, costing the envelope. The screen is what keeps the failure
 * road non-throwing, and the cell that pins an unknown capability rendering verbatim
 * is what reddens if someone removes it. **The claim is checkable now, which the
 * earlier one was not.**
 *
 * The loud signal belongs in a gate — an advice line still carrying a placeholder
 * after rendering is a defect, and that check is configuration-independent — rather
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
 * THERE USED TO BE A THIRD RETURN THE SIGNATURE DID NOT NAME, and it is closed.
 * The `switch` is exhaustive over `Capability`, so a `cap` from outside the union
 * fell off its end and this returned `undefined` (measured) — not the documented
 * `null`, so a caller's `=== null` never fired and the literal word `undefined`
 * reached the sentence. TypeScript stops that at a typed call site, but `tests/**`
 * is outside `tsconfig.json`'s `include` and eslint here is not type-aware, so a
 * test-side or JS caller could pass a string straight through (gate 2, finding 7).
 *
 * **The two roads are now separate functions, because one `null` cannot mean both
 * "no provider in this configuration" and "no such capability"** — a caller
 * implementing the documented drop-on-null protocol would make a line carrying
 * `{tool:reidentify_elemnt}` VANISH, which is the silent outcome this module's
 * verbatim policy exists to prevent, and the opposite of what `renderAdvice` does
 * with the same string (gate 2, 2026-09-13, second round):
 *
 *   `providerFor(cap: Capability)`  — typed road. `string` or `null`. A value from
 *                                     outside the union is impossible by type, so
 *                                     it THROWS rather than inventing an answer.
 *                                     The throw cannot reach the failure road:
 *                                     `renderAdvice` screens with `isCapability`
 *                                     before calling, and a cell reddens if that
 *                                     screen is removed.
 *   `providerForName(name: string)` — untyped road, for text. `string`, `null`, or
 *                                     `UNKNOWN_CAPABILITY`, which is a symbol: it
 *                                     cannot be confused with `null` by a drop
 *                                     protocol, and it cannot be interpolated into
 *                                     a sentence without throwing at the call site.
 *
 * **`renderAdvice` is still the only placeholder-safe entry point.**
 *
 * The predicates are the ones REGISTRATION reads. Deliberate: resolution reading a
 * different source of truth than registration would drift silently the first time
 * one of them changed. Both take `env`, which makes ALL FOUR corners reproducible in
 * a unit test with no Windows machine — `keyLockerDisabled` did not take one until
 * codex pointed out that this function then answered for the wrong configuration.
 *
 * (The rest of this comment used to be a SECOND doc block. Two blocks in a row and
 * only the last one attaches, so quick-info on `providerFor` showed the essay below
 * and not the contract above it — the half a caller needs. Merged; the same shape
 * the removal left behind on `KNOWN` one round earlier, found by gate 2 both times.)
 *
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
 * **THAT ARGUMENT IS ABOUT ONE CAUSE — a failed import — AND IT DOES NOT COVER THE
 * OTHER: WHEN each side reads the switch** (gate 2, 2026-09-13, third round;
 * verified in source here). Registration takes a SNAPSHOT and this function reads
 * LIVE:
 *
 *   `server-windows.ts:86`   `resolveV2Activation(process.env)` at module init, once
 *   `server-windows.ts:98`   `_desktopV2` awaited there too, frozen for the process
 *   `server-windows.ts:259`  `registerKeyLockerTools(s)` runs inside
 *                            `createMcpServer()`, so the LOCKER switch is re-read per
 *                            server — once per request in stateless HTTP mode
 *   here                     both switches read from `env` at CALL time
 *
 * So the two switches do not even agree with each other about freshness, and a
 * process that changes `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2` after startup would have
 * this function answer for a surface that was never published — this ADR's own
 * defect, arriving through the door the argument above does not watch. **Nothing in
 * the product does that today** (the cells do it deliberately, which is how the
 * shape is visible at all), so it is latent like the platform gap, and it is stated
 * rather than argued away. **The fix is not another parameter**: registration and
 * resolution should read ONE configuration captured at the same moment, which is a
 * change to how the server hands the presenter its configuration — so it belongs to
 * the change that wires the presenter, not to the mechanism.
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
 * and 4, which corrected "none of the five" and the axis). It stays harmless for a
 * DIFFERENT reason than the one written here before this PR wired the presenter: it
 * is no longer "nothing calls `renderAdvice` yet" (gate 2, 2026-09-13) — the resolver
 * runs on every Windows refusal now. What holds on the stub is that the stub answers
 * `UnsupportedPlatform` to everything and builds that refusal by hand, without this
 * module. That is the reason the argument above is scoped to the Windows server.
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
  return providerForConfig(cap, adviceConfigurationFromEnv(env));
}

/**
 * The same answer from a RESOLVED configuration rather than from an environment.
 *
 * Two entry points, one switch: the env road is what the cells and the four-corner
 * sweeps drive, and the configuration road is what the presenter uses, because what
 * registration did is not always what the environment said (see
 * {@link AdviceConfiguration}).
 */
export function providerForConfig(cap: Capability, cfg: AdviceConfiguration): string | null {
  const v2 = cfg.v2;
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
      return cfg.credentialStore ? "key_locker" : null;
    default: {
      // Impossible by type, and reachable in fact from `tests/**` (outside
      // `tsconfig.json`'s include) or from JS. It THROWS rather than answering,
      // because every answer available here is a lie a caller would act on: `null`
      // means "dropped for this configuration" and would make a typo vanish
      // silently, and `undefined` — what this used to return — reaches the sentence
      // as the literal word. Text goes to `providerForName`, which has a third
      // answer for exactly this. The throw cannot reach the failure road:
      // `renderAdvice` screens with `isCapability` first.
      //
      // `never` rather than a plain `throw`: the assignment is what keeps a MISSING
      // arm a compile error. Without it, the next capability added to the union
      // would compile and throw at runtime.
      const unhandled: never = cap;
      throw new TypeError(
        `providerFor: ${String(unhandled)} is not a capability — use providerForName for text`,
      );
    }
  }
}

/**
 * The same question asked with a STRING, for callers whose input is text — a
 * placeholder's capture, a line read from the dictionary, a gate walking rendered
 * advice.
 *
 * Three answers, and the third is why this function exists: `UNKNOWN_CAPABILITY`
 * for a name this module does not know. It is a symbol so that it cannot be
 * mistaken for `null` by a drop-on-null protocol, and so that a caller of THIS
 * function who spends the answer without checking it — `` `use ${answer}` `` —
 * throws at their own call site instead of shipping a word into a sentence.
 *
 * **That is a claim about this function's return value and nothing else, and it was
 * read as a claim about the module** (win2, 2026-09-13, from the measurement):
 * `renderAdvice`'s output is unchanged and an unknown placeholder still ships
 * VERBATIM — measured on the built module at two commits. `renderAdvice` never sees
 * this symbol, because it screens with `isCapability` and then takes the typed road,
 * which is what keeps a typo visible rather than dropped (gate 2, 2026-09-13).
 */
export const UNKNOWN_CAPABILITY: unique symbol = Symbol("advice-capability:unknown");

export function providerForName(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null | typeof UNKNOWN_CAPABILITY {
  return isCapability(name) ? providerFor(name, env) : UNKNOWN_CAPABILITY;
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
 *
 * ---
 *
 * **WHAT THE CHANGE THAT CONVERTS THE LINES HAS TO DECIDE, written here because that
 * is where its author will be reading** (gate 2, 2026-09-13, both rounds).
 *
 * **"Neither is a defect today — nothing calls this yet" stood here, and this PR is
 * what made it false** (gate 2, 2026-09-13): the resolver now runs on every refusal on
 * Windows, through `toToolFailure` and `buildFailureEnvelope`. Items 1 and 3 were
 * ANSWERED by that wiring and are struck through below; item 2 is live and reaches
 * callers the moment a line it describes carries a placeholder.
 *
 *   **1. ~~There is no floor: an advice set can render to `[]`.~~ DONE — the floor is
 *   `ADVICE_WITHHELD_FLOOR`, applied on BOTH roads (`renderTryNext` and
 *   `renderAdviceWithFloor`), and only where a real sentence was dropped.** Kept
 *   because the reasoning is what the conversion still needs: the case is not
 *   hypothetical and it is this module's own motivating one. `paneIdMissSuggest`'s
 *   malformed-`paneId` branch (`terminal.ts:742-750`) returns exactly two lines and
 *   BOTH name `key_locker`, so once they carry `{tool:credential_store}` a server
 *   started with the locker off drops both and the `TerminalWindowNotFound` refusal
 *   ships with no suggestions at all. That is worse than the defect being fixed: a
 *   wrong tool name is a recoverable answer, no answer is not. Decide it WITH the
 *   conversion — a fallback line, a caller-visible count, or "zero is correct for
 *   this code", per code. Note the shape: the advice most worth having is the advice
 *   most likely to be configuration-dependent, so the empty set is not a rare corner.
 *
 *   **2. A whole-line drop throws away the part that had nothing to do with the
 *   missing tool.** The same branch's first line is *"paneId is malformed. Valid
 *   forms: a decimal console hwnd … or `wt:<pid>:<startMs>`. Use the `paneId` field
 *   from key_locker(…) verbatim."* The format specification is the caller's actual
 *   answer and is true whether or not the locker exists; only the last clause depends
 *   on it. This is the LIST case above wearing different clothes — a sentence that is
 *   mostly configuration-independent — and the converter meets it on the first line
 *   it touches, so it is named here rather than left to be rediscovered.
 *   **3. ~~Resolution and registration must come from ONE captured configuration.~~
 *   DONE — that is this PR.** `createMcpServer()` captures what registration DID and
 *   the presenters resolve against it; the text below is kept as the statement of the
 *   problem it answers.
 *   This function read the switches live; `server-windows.ts` snapshots the v2 flag
 *   at module init and re-reads the locker per server. The details are in the flag
 *   argument above; what the wiring change owes is the shape — hand the presenter the
 *   configuration that registration actually used, rather than letting both re-derive
 *   it from ambient env at different times.
 *
 *   **4. ~~This module's import of `keyLockerDisabled` drags the native chain onto
 *   the failure road.~~ DONE 2026-09-13, before the conversion, because the wiring is
 *   what would have made it bite.** The predicate now lives in
 *   `engine/key-locker/key-locker-switch.ts`, a leaf that imports nothing, and
 *   `key-locker-manager.ts` re-exports it so the switch still has one reader.
 *   Measured by walking static imports from this file: **the native chain reached,
 *   down to none** — with the control that the same walker still reaches all three
 *   from `key-locker-tool.ts`. **The module COUNTS that went with it (15 → 3) belong
 *   to one walk and not to the question**: that walk counts this file and follows
 *   type-only edges, the cell's walker skips them, and win2's walk over the emitted
 *   `dist/` answers smaller again because tsc has already erased them (12 → 3, or
 *   11 → 2 without the root). All four agree on what matters and none of the numbers
 *   is portable — a count without its method is not a number, and gate 2 caught this
 *   line quoting one across two methods. It is kept as a numbered item rather
 *   than deleted because the list is a checklist and a silently vanished line reads
 *   like a line that was never there. **The property is pinned by a cell**
 *   (`the-advice-road-does-not-import-the-native-chain.test.ts`), which is the part
 *   that was missing when this was only prose: `tsc`, `eslint` and every other cell
 *   stay green if a later edit gives the leaf an import (gate 2, third and fourth
 *   rounds; the cell answers the fourth).
 */
export function renderAdvice(
  lines: readonly AdviceLine[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return renderAdviceWith(lines, adviceConfigurationFromEnv(env));
}

/** {@link renderAdvice}, driven by a resolved configuration. One loop, two doors. */
export function renderAdviceWith(
  lines: readonly AdviceLine[],
  cfg: AdviceConfiguration,
): string[] {
  return renderAdviceEach(lines, cfg).filter((line): line is string => line !== null);
}

/**
 * The same rendering, **per line**: `null` where a line was dropped, so a caller that
 * has to keep something else beside each line can tell WHICH line went.
 *
 * **This exists because compacting lost the pairing** (gate 2, 2026-09-13, a high).
 * `renderTryNext` carried `args` and `confidence` beside each `action`, rendered the
 * whole list in one call for the pattern hoist, and re-attached by index — but the
 * compacted array has no gap where a row was dropped, so **every row after a drop
 * took the next survivor's text while keeping its own arguments**, and the last
 * survivor was discarded. Measured on the built code: a caller acting on advice that
 * belonged to a different row. Counting survivors is not identifying them.
 */
export function renderAdviceEach(
  lines: readonly AdviceLine[],
  cfg: AdviceConfiguration,
): (string | null)[] {
  // THE CONTAINER, and this is the last place it can move to: every road — both
  // presenters, both `*ForCaller` doors, `renderAdvice`, `renderAdviceWith` — comes
  // through this loop. The guard was in the two callers, which is where gate 2 found
  // it in the eighth round: `renderAdviceForCaller("some advice")` is exported, a
  // string is iterable, and `for…of` shipped the sentence one character per line —
  // no throw, no red, the worst of the three shapes measured on the flat road. The
  // doc above names three `ok:true` roads as future callers of this seam; each of
  // them would otherwise have had to re-derive the same guard.
  if (!Array.isArray(lines)) return [];
  const out: (string | null)[] = [];
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
    // NOT A STRING? Drop it — and do not throw. (This said "pass it through untouched"
    // until gate 2 read it against the `out.push(null)` three lines below and the
    // comment on it, which had already recorded WHY pass-through was wrong. The
    // previous round's wording outlived the round: an edit made on the strength of
    // this line would have restored the measured `suggest: [null]`.)
    // This module's own rule is that it never
    // throws on the failure road — every caller here is already building a refusal, so
    // a throw costs the envelope, the code and the sibling lines: the fix failing into
    // the shape of the bug. Wiring the seam in made `line.replace` reachable with a
    // value `tsc` cannot vouch for, because both roads are exported and `tests/**` is
    // outside the include (gate 2, 2026-09-13: `buildFailureEnvelope("X", [{}])` threw
    // `Cannot read properties of undefined`). Same door `providerForConfig`'s `default`
    // arm guards, and the same answer: refuse to invent, do not take the caller down.
    if (typeof line !== "string") {
      // DROPPED, not passed through. Not thrown either: this module's rule is that it
      // never throws on the failure road. But passing it through put a non-string into
      // a `string[]` on the wire — `suggest: [null]` reached a caller, whose own
      // `.trim()` then threw on their side instead of ours, and the floor's
      // `length > 0` guard read it as advice (gate 2, 2026-09-13). Refusing to invent,
      // and refusing to ship what the type says is not there, are the same answer.
      out.push(null);
      continue;
    }
    let dropped = false;
    const rendered = line.replace(pattern, (whole: string, cap: string) => {
      // A capability this module does not know stays verbatim — visibly broken
      // beats a sentence that reads as advice. See the note on `KNOWN`.
      if (!isCapability(cap)) return whole;
      const tool = providerForConfig(cap, cfg);
      if (tool === null) {
        dropped = true;
        // Discarded — the whole line is dropped below. Returning the placeholder
        // rather than "" so that nothing reads as "the sentence survives with the
        // name blanked out", which is a behaviour this module does not have.
        return whole;
      }
      return tool;
    });
    out.push(dropped ? null : rendered);
  }
  return out;
}

/**
 * The one slot. See {@link AdviceConfiguration} for WHY it is a capture and not
 * `process.env` at call time, and for the hazard the fallback carries.
 */
let captured: Readonly<AdviceConfiguration> | null = null;
let warnedAboutDisagreement = false;

/**
 * THE CONFIGURATION THE PRESENTER RESOLVES AGAINST, captured once where
 * registration reads it.
 *
 * **Why a capture and not `process.env` at call time.** The server reads the two
 * switches at DIFFERENT moments — `server-windows.ts:86` resolves the v2 flag at
 * module init and freezes `_desktopV2` for the process, while
 * `registerKeyLockerTools` runs inside `createMcpServer()` and therefore re-reads the
 * locker per server (once per request in stateless HTTP mode). A presenter that read
 * ambient env at call time would answer for a surface that was never published the
 * moment anything changed the flag after startup. The fix is not another parameter:
 * registration and resolution read ONE configuration, taken at one instant
 * (gate 2, 2026-09-13, third round on the mechanism PR).
 *
 * **The fallback is the environment, and it is a hazard, so it is pinned rather than
 * hidden**: a server that never captures behaves exactly as before, which is what
 * keeps every existing test and every non-server caller working — and which would
 * also silently swallow a forgotten `captureAdviceConfiguration` call. **That last
 * sentence stood here while no such cell existed** (gate 2, 2026-09-13, which deleted
 * the call in `server-windows.ts` and watched everything stay green). There is one
 * now: it parses the shipped `server-windows.ts` and asserts the call is inside
 * `createMcpServer`, with a control that the walk finds the function at all — reading
 * the shipped source rather than a copy of the belief about it. Importing the server
 * to check would start one.
 *
 * The RESOLVED surface, not the environment that suggested it.
 *
 * **The first version of this captured `process.env`, and gate 2 showed that is the
 * same defect one layer along** (2026-09-13): the v2 half of the surface is not the
 * flag, it is `_desktopV2` — the module the server actually loaded and branched its
 * registration on — and that was decided at module init, while an env snapshot taken
 * inside `createMcpServer()` is a second reading of a second thing. Two readings of
 * two things is what this round exists to remove, so what is captured is what
 * registration DID: `v2` is "the v2 module is the surface I registered", and
 * `credentialStore` is "the locker registered its tool".
 */
export interface AdviceConfiguration {
  /** The v2 surface was registered — `_desktopV2 !== null`, not the flag's value. */
  v2: boolean;
  /** The locker's capability is available — what `registerKeyLockerTools` read. */
  credentialStore: boolean;
}

/**
 * Take the configuration for this server. Call it where registration reads the switches.
 *
 * **One slot, process-wide, and that is correct only while both inputs are** (gate 2,
 * 2026-09-13). `createMcpServer()` runs once per request in stateless HTTP mode and
 * each call overwrites this; today every server computes the same answer, because
 * `_desktopV2` is frozen at module init and the locker predicate reads `process.env`.
 * The day a second source appears — an embedder building two servers, a per-server
 * config object — the last capture answers for every earlier server, and this needs
 * per-server plumbing rather than a module global.
 */
export function captureAdviceConfiguration(cfg: AdviceConfiguration): void {
  // A SECOND capture that DISAGREES with the first is the exact condition under which
  // one slot is the wrong shape — two servers whose surfaces differ, with one global
  // answering for both. Both gates raised the scope; neither could name a way to reach
  // it today, because both inputs are process-global. So it is not silently allowed:
  // the disagreement is announced on the server's own channel, once, with both
  // answers, so the first report of the real thing arrives as a line rather than as a
  // caller wondering why the advice named a tool they do not have.
  if (
    !warnedAboutDisagreement &&
    captured !== null &&
    (captured.v2 !== cfg.v2 || captured.credentialStore !== cfg.credentialStore)
  ) {
    // ONCE, and the flag is what makes that true: `captured` is overwritten every
    // call, so two alternating surfaces logged on every `createMcpServer()` — once per
    // request in stateless HTTP mode — while this comment claimed "once" (gate 2).
    warnedAboutDisagreement = true;
    console.error(
      "[desktop-touch] advice configuration changed mid-process: " +
        `was {v2:${String(captured.v2)},credentialStore:${String(captured.credentialStore)}}, ` +
        `now {v2:${String(cfg.v2)},credentialStore:${String(cfg.credentialStore)}} — ` +
        "advice is resolved from ONE process-wide capture, so a server registered under " +
        "the earlier surface may now answer under the later one",
    );
  }
  captured = Object.freeze({ ...cfg });
}

/** The configuration an `env` describes — the fallback road, and what the cells drive. */
export function adviceConfigurationFromEnv(
  env: Record<string, string | undefined> = process.env,
): AdviceConfiguration {
  return { v2: resolveV2Activation(env).enabled, credentialStore: !keyLockerDisabled(env) };
}

/** True when a server has taken its configuration; false while the fallback is live. */
export function adviceConfigurationWasCaptured(): boolean {
  return captured !== null;
}

/** Forget the capture. For cells; the server captures once per `createMcpServer`. */
export function resetAdviceConfiguration(): void {
  captured = null;
  warnedAboutDisagreement = false;
}

/**
 * The line a road substitutes when the resolver empties advice that existed.
 *
 * **One constant, because the two roads must say the same thing.** The floor exists
 * because gate 2 found the flat road and the envelope road answering differently for
 * one code; writing the sentence out twice would have left that fixed by hand and
 * re-breakable by a one-sided reword, with every cell green (gate 2, 2026-09-13).
 *
 * **And one constant means the sentence must be true on BOTH roads, which the first
 * version was not.** It ended "— see the error message", and only the flat road has
 * one: measured, `toToolFailure` answers `{ok, code, error, suggest}` while
 * `buildFailureEnvelope` answers `{_version, data, as_of, confidence, if_unexpected}`
 * and `compatFailureRaw` answers `{ok, reason, diff, if_unexpected}` — no `error` in
 * either, and `detail` is optional and usually absent. So a `KeyLockerConsentRequired`
 * refusal on the envelope road shipped this as its ONLY recovery line and pointed the
 * caller at a field that is not there (gate 2, 2026-09-13, ninth round). The pointer
 * is gone rather than made conditional: **the caller holds the whole response, and a
 * pointer that is right on one road and wrong on the other is worse than none.**
 */
export const ADVICE_WITHHELD_FLOOR = "No recovery is available in this configuration.";

/**
 * Whether the floor's sentence is TRUE of this input — the rule, hoisted beside the
 * sentence for the same reason the sentence was hoisted.
 *
 * The floor names a cause: *"in this configuration"*. That holds when a real sentence
 * was dropped for want of a provider, and not when the caller passed entries that were
 * never sentences. Both roads decide it; **centralising the string and leaving the
 * predicate written out twice keeps the one-sided-drift hazard and only moves it a
 * level up** (gate 2, 2026-09-13, eighth round) — a later edit that teaches one road
 * to treat, say, a whitespace-only line as "not a sentence" reproduces the asymmetry
 * with every cell green, because the only shared artefact would be the constant.
 */
export function adviceExisted(lines: readonly unknown[]): boolean {
  return Array.isArray(lines) && lines.some((line) => typeof line === "string");
}

/**
 * Render advice for THIS server's configuration — the entry point the presenters use.
 *
 * Every advice line that travels as `suggest` or `try_next` **from a tool** passes
 * through here — on the flat shape (`toToolFailure`) and on the envelope
 * (`buildFailureEnvelope`).
 *
 * **"which the lint rule makes the only builder" was too strong** (gate 2,
 * 2026-09-13). `no-tool-failure-shape-direct-construct` is registered for
 * `src/tools` only (`eslint.config.mjs:80`, a `files:` glob under that directory), and
 * `src/server-linux-stub.ts:52-69` is outside it: its `CallToolRequestSchema` handler
 * hand-builds `{ok:false, code:"UnsupportedPlatform", error, suggest:[…]}` and does
 * not import `_errors.ts` at all. **That is a failure road this seam does not cover**,
 * and it is not one of the `ok:true` sites enumerated below. It is harmless today for
 * a reason about its CONTENT, not its road — its three lines name no
 * configuration-dependent tool, and no capability has a provider on that platform in
 * either corner — so the gate the conversion owes must walk it rather than trust this
 * paragraph.
 *
 * **NOT "every advice line on the failure road", which is what this said until gate 2
 * measured it** (2026-09-13). Advice also travels on that road in fields this seam
 * never sees: `nextStepFor()` (`_action-guard.ts:279`) writes sentences naming
 * `desktop_discover` into `context.guard.next` and into the refusal's own `error`
 * string, and `toToolFailure` renders `suggest` and nothing else. Under the kill
 * switch a guarded action's `target_not_found` therefore tells the caller to call a
 * tool this server never registered — **this ADR's motivating defect, on the road this
 * change is about**. It is not fixed here because those fields are not advice arrays
 * and touching them moves bytes, which is the one thing this round claims it does not
 * do; it goes to the conversion with its measurement. That is deliberate: the dictionary is not
 * the only source of advice — 28 literal `suggest:` sites and a named builder
 * (`paneIdMissSuggest`) produce lines the dictionary never sees, and `WaitTimeout` is
 * a measured case where the literal beats the dictionary. A seam on the dictionary
 * alone would have been a fix that misses the road it was aimed at.
 *
 * **THERE IS A THIRD ROAD AND IT IS NOT COVERED: advice on an `ok:true` payload.**
 * The sentence above said "both roads" until gate 2 measured otherwise
 * (2026-09-13). Three sites ship advice on success and touch neither presenter:
 * `excel.ts:272` (`ok({… suggest})` for `check_access_vbom`), `ocr-bridge.ts:552`
 * (a per-element `suggest` on low-confidence OCR — a singular `string` on
 * `ActionableElement`, a different type from the failure road's `string[]`), and
 * `terminal.ts:2824` (`readError.suggest`, hand-built inside an `ok:true` run
 * result). **None of them names a configuration-dependent tool today**, which is why
 * the conversion does not reach them — and is also why the gate that will check this
 * must, because "harmless" there is a property of the current wording and not of the
 * road. Recorded as remaining work rather than widened here: a success payload is a
 * different shape with different callers, and this round's claim is byte stability.
 *
 * **THIS FUNCTION TAKES NO CONFIGURATION, and JavaScript will not tell you.** Pass one
 * as a second argument and it is silently dropped, so the call answers about the
 * RUNNING PROCESS instead of the corner you meant — measured by win2 on 2026-09-13,
 * whose harness then reported "locker present" at all four corners, including the two
 * without a provider. That reads as "nothing was dropped", agrees with today's correct
 * answer, and would go on agreeing after a conversion broke something: the strongest
 * kind of false green. **If you hold a configuration, call {@link renderAdviceWith}.**
 *
 * (These were two adjacent blocks separated by a blank line, so hover showed only the
 * warning and the coverage statement above it — the `ok:true` roads and the stub —
 * vanished. This file records the same shape being fixed on `providerFor` at lines
 * 373-376, and gate 2 found it here twice: raised in the fifth round, and STILL HERE
 * in the eighth, because the edit that claimed to merge them never ran — see the
 * commit that fixes this.)
 */
export function renderAdviceForCaller(lines: readonly AdviceLine[]): string[] {
  return renderAdviceWith(lines, captured ?? adviceConfigurationFromEnv());
}

/**
 * {@link renderAdviceForCaller}, **per line**: `null` where a line was dropped.
 *
 * For a caller that carries something else beside each line — `try_next` rows have
 * `args` and `confidence` — because compacting the list loses which line went, and
 * re-pairing by counting survivors put one row's text beside another row's arguments
 * (gate 2, 2026-09-13, a high).
 *
 * **IT TAKES NO CONFIGURATION EITHER, and the hazard is its sibling's, verbatim.**
 * `renderAdviceEachForCaller(lines, cfg)` drops the second argument in silence and
 * answers about the running process — the same measured false green
 * ({@link renderAdviceForCaller}), one function over. **If you hold a configuration,
 * call {@link renderAdviceEach}.**
 */
export function renderAdviceEachForCaller(lines: readonly AdviceLine[]): (string | null)[] {
  return renderAdviceEach(lines, captured ?? adviceConfigurationFromEnv());
}
