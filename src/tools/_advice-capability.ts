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
 * calling the factory again each time). Use {@link hasPlaceholder}.
 */
export function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, "g");
}

/**
 * The detector, and it is deliberately **LAXER than the replacement grammar**.
 *
 * The first version reused `PLACEHOLDER_SOURCE`, which made it blind to exactly the
 * mistakes a scan exists to find (PR-side codex P2 on `8375314`): `{tool:set_value2}`,
 * `{tool:set-value}` and `{tool:Set_value}` do not match the strict grammar, so
 * `renderAdvice` leaves them **verbatim in the shipped line** — and a strict detector
 * answers `false`, so the gate would wave them through. A typo is the likeliest
 * leftover there is, and the strict form could not see any typo that broke the
 * character class.
 *
 * So it matches `{tool:` followed by anything that is not a quote — either braced,
 * or an unbraced non-space RUN.
 *
 * **WHAT IT DELIBERATELY DOES NOT FLAG**, measured at this commit and pinned by
 * cells, because "laxer than the grammar" is not "catches every malformed form"
 * (gate 2 round 4, finding 1 — the earlier wording claimed the first shape below):
 *
 *   `Re-call {tool:`          nothing after the colon **and no later `}` on the
 *   `Re-call {tool: …prose`   line**. NOT flagged, and that is the price of the false
 *                             positive at `macro.ts:274`, which is exactly this
 *                             shape in a source comment (the colon ends the line).
 *                             **Prose WITH a later `}` on the line IS flagged** —
 *                             `"{tool: see the handbook}"` matches, because the body
 *                             walks to the closing brace. The earlier entry claimed
 *                             the blanket shape (gate 2 round 5, finding 4).
 *   `{tools:…}` `{tool;…}`    a typo in the PREFIX rather than in the name. The
 *                             prefix is literal here, so these are out of reach —
 *                             the fix made the NAME lax and left the prefix strict.
 *   `{ tool:set_value}`       a space after the opening brace. The clause that would
 *                             catch it was **rejected**, not bought: it prices at
 *                             4/15 false positives on TypeScript type literals, so
 *                             what is bought is this blind spot (gate 2 round 5,
 *                             finding 10 — the earlier wording inverted the subject).
 *   `{tool:"x"}` `{tool:'x'}` quoted, i.e. the product's own macro syntax.
 * The quote exclusion is what keeps the product's own syntax out:
 * `run_macro({tool:"screenshot", …})` and `{tool:'focus_window', …}` both put a
 * quote immediately after the colon.
 *
 * **THE SHAPE WAS CHOSEN BY MEASUREMENT, AND THE FIRST TRY WAS WRONG.** Four
 * candidates were run against the `{tool:` occurrences in `src` and `tests`
 * **excluding this module and its own cell file** — **21** of them, the same count as
 * the base commit, because the exclusion removes exactly what this branch added.
 * **The unexcluded number is not worth quoting**: it was written here as 46, gate 2
 * measured 99 at `25f9bb3`, and this tree now reads 104 occurrences on 84 lines
 * across 6 files, of which **83 sit in this module and its cell file** — it moves
 * every time either file is edited, which is the reason the population is NAMED
 * rather than counted (gate 2 round 4, finding 2). **Four candidates, of which three
 * have their score recorded in this file** — the strict reuse, the quote-lookahead
 * (3 false positives), and the whitespace-after-brace variant (4 line / 15 whole-file)
 * — plus the shipped one (gate 2 round 5, finding 9: "two" undercounted its own text). The battery
 * itself is what the cell file holds, and counted there rather than here: **15
 * malformed positives and 8 negatives** at this commit (the earlier "six positives
 * and four negatives" was a count of an earlier battery left in place while the
 * battery grew — gate 2 round 4, finding 8). The obvious pattern —
 * quote lookahead, optional closing brace — scored **3 false positives**, for two
 * reasons a reader would otherwise rediscover the hard way:
 *
 *   `{tool:\"screenshot\"…`  the character after the colon is a BACKSLASH, so a
 *                            lookahead for `["']` does not fire (`macro.ts:750`,
 *                            `stub-tool-catalog.ts:1211`)
 *   `…run_macro({tool:` EOL  nothing follows the colon on that line, so an
 *                            everything-optional pattern matches the empty tail
 *                            (`macro.ts:274` — the same line that made the widened
 *                            count 21-vs-20 earlier in this file)
 *
 * The shipped pattern requires either a closing brace or a non-empty run, and
 * exempts **only `\"` and `\'`** rather than every backslash — see the last block
 * below for why that distinction is load-bearing.
 *
 * **FIVE MORE SHAPES CAME FROM ASKING THE BUILT MODULE, NOT THE PATTERN** (win2, on
 * `25f9bb3`, with positive controls: a well-formed placeholder is both detected and
 * resolved away). Each is shipped VERBATIM by `renderAdvice` and was missed by the
 * first lax detector:
 *
 *   `{tool :set_value}`    a space BEFORE the colon
 *   `{TOOL:…}` / `{Tool:…}`  the keyword in capitals, or mixed
 *   `｛tool:set_value｝`    **full-width braces** — the realistic one here, because
 *                          these sources carry Japanese comments and a CJK IME
 *                          emits `｛｝` without the writer noticing
 *   `&#123;tool:…&#125;`   HTML-escaped, if the text ever passes a doc pipeline
 *
 * **The extra reach cost nothing, and that was measured rather than assumed.** The
 * obvious way to reach it — allowing whitespace after the opening brace — matches
 * TypeScript type literals (`{ tool: string; params: … }`, `{ tool:   ev.tool }`):
 * **4 line-level / 15 whole-file false positives** in real product files. Keeping
 * `{tool` ADJACENT and allowing space only before the colon catches all five at
 * **0 false positives, line-by-line and whole-file**. So this is an improvement, not
 * a trade — had it cost false positives it would have been a judgement call, and
 * those get named as such in this file.
 *
 * **AND THE BACKSLASH EXEMPTION WAS TOO BROAD, which is the twentieth shape.**
 * `{tool:\set_value}` is shipped verbatim and was NOT flagged, because a lookahead
 * for `[\\]` excludes every backslash rather than the escaped quotes it was added
 * for (PR-side codex P2 on `25f9bb3`). Exempting only `\"` and `\'` catches it —
 * measured over 16 malformed shapes and 8 negatives: **0 missed, 0 false positives,
 * 0 negatives claimed**, the product's own `{tool:\"sleep\"` still excluded.
 *
 * **The measuring side wrote "the twentieth shape is unobserved, not absent" while
 * nineteen were tried. Gate 1 produced the twentieth within the hour.** That is the
 * reason this file states no completeness claim about the malformed set.
 *
 * **AND WIDENING A SURFACE BRINGS THAT SURFACE'S PRODUCT EXAMPLES WITH IT** — the
 * HTML branch added above to catch an HTML-escaped LEFTOVER also flagged an
 * HTML-escaped legitimate EXAMPLE: `run_macro(&#123;tool:&quot;screenshot&quot;…)`,
 * because the quote exemption knew only literal and backslash-escaped quotes and
 * read `&quot;` as ordinary content (PR-side codex P2 on `572edd8`). So the boundary
 * is restated once, for every encoding: **the character after the colon is a quote —
 * literal, backslash-escaped, or an HTML entity.** Measured over the tree and a
 * battery of 16 malformed positives and 12 negatives: **0 false positives, 0
 * malformed missed, 0 negatives claimed**.
 *
 * The entity alternatives are lower-case only ON PURPOSE: this regex already carries
 * `/i`, so `&QUOT;` is covered by the flag. Adding case variants measured identically
 * — a knob with no measured benefit is not added.
 *
 * **THE WHITESPACE SKIP MUST SIT INSIDE THE LOOKAHEAD, and that is not a style
 * choice.** A legitimate example can put a space after the colon —
 * `run_macro(&#123;tool: &quot;screenshot&quot;&#125;)` — and the first attempt wrote
 * the skip OUTSIDE, as `:\s*(?!…quote…)`. That still claimed it: `\s*` is
 * backtrackable, so the engine retries with zero characters consumed, the lookahead
 * then sees the SPACE rather than the entity, passes, and the body swallows
 * `&quot;…`. Measured both ways — outside: 3 of 13 negatives claimed; inside
 * (`:(?!\s*…quote…)`): **0** (PR-side codex P2 on `51e2d88`).
 *
 * **THREE MORE SURFACES, all at zero cost** (gate 2 round 5, finding 3, which probed
 * the built module rather than reading the pattern): the **full-width colon** `：`
 * (U+FF1A) — the same IME that emits `｛｝` emits it for the colon key — plus the
 * **hex** brace entities `&#x7B;`/`&#x7D;` beside the decimal ones, and the
 * **HTML-escaped colon** `&#58;`. Adding all three keeps tree false positives at 0
 * and takes the battery from 8 missed shapes to 0.
 *
 * **STILL NOT FLAGGED, deliberately**: an unbalanced quote (`{tool:'set_value}`) and
 * a tab or NBSP after the opening brace — the latter is the clause priced at 4/15
 * false positives, so it stays rejected. Recorded as choices, not as coverage.
 *
 * STATELESS because it is not global: without `/g`, `.test()` never advances
 * `lastIndex`, so the answer cannot depend on call order. That is the distinction
 * worth keeping visible rather than hiding behind another factory.
 */
const DETECT_LEFTOVER =
  /(?:[{｛]|&#123;|&#x7B;)tool\s*(?:[:：]|&#58;)(?!\s*(?:["']|\\["']|&quot;|&#34;|&apos;|&#39;))[^}｝"']*(?:[}｝]|&#125;|&#x7D;)|(?:[{｛]|&#123;|&#x7B;)tool\s*(?:[:：]|&#58;)(?!\s*(?:["']|\\["']|&quot;|&#34;|&apos;|&#39;))[^}｝"'\s]+/i;

/**
 * True if `text` still carries something that looks like a `{tool:…}` placeholder —
 * **including a malformed one**. This is the entry point for a gate or any per-line
 * scan; the answer does not depend on call order.
 *
 * Not the same question as "would `renderAdvice` resolve it": that is
 * {@link placeholderSource}'s grammar, and the gap between the two is the whole
 * point — the gap is where typos live.
 */
export function hasPlaceholder(text: string): boolean {
  return DETECT_LEFTOVER.test(text);
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
 * this module's cell file per mutation, baseline 16/16 as a positive control. Counts
 * are BEHAVIOURAL cells: the text pin fires for every mutation, so counting it would
 * be counting the guard as evidence for the thing it replaces.
 *
 *   `\{tool:([^}]+)\}`       0   the classic widening: captures `"screenshot", …`,
 *                                fails `isCapability`, returns verbatim
 *   `\{?tool:([a-z_]+)\}`    0   opening brace optional — greedy, so it is consumed
 *   `[a-z_]*\{tool:([a-z_]+)\}`
 *                            0   match may begin outside the placeholder (written
 *                                out rather than elided: an elided mutation cannot
 *                                be re-derived — gate 2 round 4, finding 8, which
 *                                had three parts and is therefore cited twice in
 *                                this file ON PURPOSE: the elided row here, and the
 *                                battery counts above. Round 5 asked whether one of
 *                                the two was misattributed; the record says neither
 *                                is, so the citation stays and says why)
 *   `\{tool:([a-z_]+)\}?`    1   closing brace optional — the SCANNER cell catches it
 *   `\{tool:(.+)\}`          3   one match spans two placeholders
 *   `\{([^}]+)\}`            8   capture becomes `tool:set_value`, so a GENUINE
 *                                placeholder stops resolving
 *   `\{tool:([a-z_]+)`       9   no closing brace: a stray `}` ships in the output
 *
 * **THE SAME MUTATIONS HAVE GIVEN DIFFERENT ANSWERS ON THIS BRANCH**, so each number
 * is named with the tree it was measured on (gate 2 round 4, finding 5, which
 * corrected two rows and the causal phrasing of a third):
 *
 *   `\{tool:([^}]+)\}`     0 at `6867088` → 1 at `8375314` → 0 here
 *   `\{tool:([a-z_]+)\}?`  0 at `6867088` → 0 at `8375314` → 1 here — it did NOT
 *                          move "the same way": it moved only at this commit, and
 *                          because the malformed-verbatim loop is new
 *   `\{([^}]+)\}`          8 at `6867088` (15 cells) → 9 at `8375314` (16) → 8 here (16)
 *                          — the 9-vs-8 difference is the cells' CONTENT, not their
 *                          number; the count on this branch only ever rose
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
 * loud signal belongs in a gate — an advice line that {@link hasPlaceholder} flags
 * after rendering is a defect, and that check is configuration-independent — rather
 * than in the failure path of a running server. **Stated as a call, not as a
 * substring**: "still contains `{tool:`" was the earlier wording and it now
 * disagrees with the detector, which deliberately passes the product's quoted
 * `run_macro({tool:"…"})` — a reader implementing the substring rule would flag that
 * syntax (gate 2 round 4, finding 7). **No number is quoted for it**: the earlier
 * "21 false positives" borrowed an occurrence count for a per-LINE scan (11 lines),
 * and borrowed the repo-wide population for a gate that reads only rendered advice,
 * where this file's own classification says the count is **0** — none of the 21 is an
 * advice string (gate 2 round 5, finding 6). One rule, one home. **That gate does not exist anywhere in
 * this repository yet** — no test and no script scans advice for a leftover
 * `{tool:`, verified rather than assumed — so until one is written, a leftover
 * placeholder is caught by nobody. **When it is written, it calls
 * {@link hasPlaceholder}**, not a pattern of its own and not the `/g` factory: the
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
 * What the server ACTUALLY published, when the caller knows it.
 *
 * **A FIFTH STATE IS REACHABLE IN SOURCE, AND THE ONE WAY ANYONE TRIED TO BUILD IT
 * TURNED OUT TO BE LOUD** (PR-side codex P2 on `131c663`, verified in source; then
 * measured on Windows).
 *
 * In source: `server-windows.ts` pre-loads the v2 module with
 * `await import(…).catch(() => null)` — a failed load is deliberately swallowed so
 * the server still starts — and registration branches on **`_desktopV2`**, not on
 * the flag, so a null module publishes the three V1 fallback tools instead. The flag
 * would then say `enabled: true` over a V1 surface.
 *
 * Measured: **removing the module file does NOT produce that state — the server does
 * not start at all.** `macro.ts:137` imports `./desktop-register.js` **statically**,
 * and it is the only file that does, so ESM link fails in a different importer before
 * that `catch` can run: `ERR_MODULE_NOT_FOUND … imported from …/dist/tools/macro.js`.
 * A missing file is therefore a loud failure, not a silent surface swap, and the
 * flag-only default is not wrong on that path.
 *
 * **What stays possible and UNOBSERVED** is a module that resolves but throws while
 * evaluating — a missing native addon, a partial package. That reaches the `catch`,
 * and then the divergence is real. It could not be simulated by renaming a file, so
 * it is unobserved rather than absent, and that is the whole reason this parameter
 * exists: the caller that knows the surface can say so.
 *
 * That makes the module's own design rule ("the predicates are the ones REGISTRATION
 * reads") false on exactly one path — and this is the defect this whole ADR exists to
 * close, sitting inside the fix: advice naming a tool the caller cannot call.
 *
 * So a caller that knows the surface passes it, and the flag reading is the fallback
 * for callers that do not. The presenter will pass it when it is wired; until then
 * every call here is the reading, which is why the reading is labelled rather than
 * hidden.
 */
export type Surface = {
  /** True when the v2 module loaded AND registered, i.e. `_desktopV2 !== null`. */
  v2Loaded: boolean;
};

export function providerFor(
  cap: Capability,
  env: Record<string, string | undefined> = process.env,
  surface?: Surface,
): string | null {
  // `surface` is the measurement; `env` is the reading. See {@link Surface}.
  const v2 = surface ? surface.v2Loaded : resolveV2Activation(env).enabled;
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
  surface?: Surface,
): string[] {
  const out: string[] = [];
  // One pattern for this call, not one per line. Hoisted after gate 2 pointed out
  // that the loop was building a RegExp per line while the module's own note
  // explains why it needs none: `String.replace` resets `lastIndex`, so even a
  // single shared instance would be correct here (measured — a module-level shared
  // `/g` passes every cell). The factory call stays inside `renderAdvice` rather
  // than at module level so that no module-level GLOBAL regex exists for a later
  // edit to export. ("mutable" was the earlier wording and a reader checking it
  // finds `DETECT_LEFTOVER` two hundred lines above — a module-level regex, but not
  // `/g`, so it carries no live `lastIndex`. The property meant was the flag, not
  // mutability: gate 2 round 5, finding 7.) A module-level `const` would not be exported either, so that
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
      const tool = providerFor(cap, env, surface);
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
