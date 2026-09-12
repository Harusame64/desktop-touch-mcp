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
 * itself is what the cell file holds, **and its size is not written here at all**.
 * That number has now been wrong four times in this comment — "six and four", then
 * "16 and 8", then the parent's "18" in a sentence that said three had just been
 * added (gate 2 rounds 4 and 7), and then "21" in the very commit that added five
 * more, **with the corrected count on screen from the gate run**. A live count kept
 * in another file's prose is false the next time the battery grows, which is every
 * round. **Count it where it lives.** The obvious pattern —
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
 * measured **over the battery as it stood at that commit, 16 malformed shapes and 8
 * negatives**: 0 missed, 0 false positives, 0 negatives claimed, the product's own
 * `{tool:\"sleep\"` still excluded. (The figure is left with its commit rather than
 * refreshed: it is a record of what was run then, and the battery has grown every
 * round since — gate 2 round 6, findings 3 and 7, which found two such figures
 * reading as current. **The pair above is `572edd8`'s, where that exemption actually landed:
 * 13 positives and 7 negatives.** The "16 and 8" written here before matched no
 * commit's battery at all — round 7, finding 5, which walked every tree on the
 * branch: 6/5, 13/7, 15/8, 15/12, 20/18, 22/18, 22/21.)
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
 * is restated once, and **now as a STRUCTURE rather than a list of spellings**: the
 * character after the colon is a quote — literal (including the full-width and curly
 * forms), backslash-escaped, or a character reference to one, written
 * `&(?:quot|apos|#x?0*(?:22|27|34|39));` so that **base, case and leading zeros are
 * all covered by construction**.
 *
 * **AND THE SAME SHAPE HAS TO HOLD FOR THE BRACES AND THE COLON, which took one more
 * round.** Structuring only the quote left `&#x7B;` / `&#x3A;` / `&#125;` as exact
 * spellings, so a zero-padded reference — `&#x07B;tool&#x03A;set_value&#x07D;`, all
 * legal — was shipped verbatim and **not** flagged (PR-side codex P2 on `99b9b63`).
 * Measured: three such shapes missed. Writing every reference the same way
 * (`&(?:#x?0*(?:7B|123));`, `&(?:#x?0*(?:3A|58));`, `&(?:#x?0*(?:7D|125));`) takes
 * that to 0 missed, tree false positives still 0, and **every negative still clean**
 * — including a zero-padded brace around a *quoted* example, which must stay
 * unflagged. (No count: "12 of 12" stood here and was the FIFTH wrong battery figure
 * in this comment, minted by the commit whose headline was that counting stops
 * happening here — gate 2 round 8, finding 3.)
 *
 * **AND THAT ROUND FOUND THE LIST HAD ONLY MOVED: from spellings to CODE POINTS.**
 * `(?:7B|123)` still enumerates, and the detector accepted the literal full-width
 * brace while having no reference form for it — so `&#65371;tool&#65306;…&#65373;`,
 * its hex twin, the mixed forms, and the HTML5 **named** references
 * (`&lbrace;` `&colon;` `&rbrace;` `&lcub;` `&rcub;`) were all shipped verbatim and
 * missed: **8 of 16 probes**, measured. It is this module's own two premises
 * composed — a CJK IME emits `｛｝：`, and a doc pipeline escapes non-ASCII, so
 * references TO the full-width characters are the natural product of both.
 *
 * The mirror was live too: the exemption claimed "a character reference to one"
 * while carrying no reference forms for the curly and full-width quotes it lists as
 * literals, so **8 legitimate product examples were flagged** (`&#8220;`,
 * `&#x201C;`, `&ldquo;`, `&#8216;`, `&lsquo;`, `&#65282;`, `&#xFF02;`, `&#65287;`) —
 * false positives since `572edd8`, untouched by two "structural" rewrites.
 *
 * **AND `#x?` LET EACH BASE BORROW THE OTHER'S DIGITS.** `&#x39;` is the digit `9`,
 * not an apostrophe, yet it was exempted — so `{tool:&#x39;set_value}` was a missed
 * leftover; symmetrically `&#x123;` (`ģ`) counted as a brace. Each reference is now
 * written per code point AND per base (`#0*123` decimal-only, `#x0*7B` hex-only),
 * with the named forms and the full-width code points beside the ASCII ones.
 * Measured **over that round's probe set — 16 shapes and 18 negatives, all of them
 * clean, 0 tree false positives** (gate 2 round 8, findings 1, 2 and 5). The pair is
 * a record of that run, not a live size: the probe set grows every round too, and
 * the lesson about counts applies to it exactly as it did to the battery.
 *
 * **Fixing one token and leaving its neighbours enumerated is what kept
 * this class coming back.** The widenings, by the commit that made each — because a
 * narrated ordering of them was measured wrong twice (two pairs landed together and
 * one pair was inverted, and the "nth round" ordinals were not reconstructible from
 * the record — gate 2 round 8, finding 4): `572edd8` full-width braces **and** their
 * decimal references; `e670ad7` the full-width colon, hex brace references **and**
 * the decimal colon reference; `d7af13d` the hex colon; `99b9b63` hex quotes;
 * `ad89dde` zero-padded and full-width/curly quote LITERALS; `282e0f2` zero-padded
 * braces and colon.
 *
 * The enumerated version was false as implemented, and the measurement is why this
 * one is structural: with six spellings listed, **5 of 14 negatives were claimed** —
 * zero-padded `&#0034;` / `&#x0022;` / `&#0039;` (leading zeros are legal in numeric
 * references), plus full-width `＂` and curly `“ ”` (reachable for the same CJK-IME
 * reason the full-width braces and colon are accepted). The structural form takes
 * that to 0, with tree false positives still 0 and no leftover missed (gate 2 round
 * 7, finding 6 — "the same product example one encoding further right").
 *
 * The previous clause was missing until gate 2 round 6 (finding 4): the hex colon
 * `&#x3A;` had been added while the quote exemption still listed only named and
 * decimal entities, so an all-hex product example
 * (`run_macro(&#x7B;tool&#x3A;&#x22;screenshot&#x22;&#x7D;)`) was newly flagged — the
 * same hex/decimal asymmetry this comment had just congratulated itself for
 * catching, recreated one token to the right. Measured over the tree and the battery
 * as it stood at that commit (16 positives, 12 negatives): 0 false positives, 0
 * malformed missed, 0 negatives claimed **at `51e2d88`, where that exemption landed:
 * 15 positives and 12 negatives** (the "16 positives" written here matched no tree —
 * round 7, finding 5). The hex quote entities and three more negatives came after,
 * and it has grown every round since; **the battery LIVES in the cell file and its
 * size is not stated anywhere** — nothing counts it there either, which is the
 * honest version: the shapes are the record, the number was only ever a summary that
 * went stale (gate 2 round 8, finding 7, on the wording "counted in the cell file").
 *
 * **CASE IS A PER-TOKEN QUESTION, AND ONE FLAG CANNOT ANSWER IT.** `/i` used to sit on
 * this pattern, where it was doing three jobs at once: the keyword `tool`, the hex
 * digits, and the named references. **Only the third was wrong** (see the next block),
 * and removing the whole flag broke the other two — the "fix one token, leave its
 * neighbours" shape of every round above, except this time the class came back one
 * token to the LEFT, *inside* the fix for the round before it.
 *
 * Three arms, one run, over the battery in the cell file plus a probe set for this
 * class (a record of that run; no denominators, because the populations grow):
 *
 *   `1a715b2` as committed, `/i` on .... 5 positives missed, 11 negatives claimed.
 *                                        Four misses are the `&Quot;` class the next
 *                                        block is about; the fifth is `&foo;`, which
 *                                        this tree deliberately flips to a positive
 *                                        (named as the cost further down)
 *   the same text with `/i` removed .... 10 missed, 11 claimed. The five added misses
 *                                        are the flag's OTHER two jobs: the keyword
 *                                        (`{TOOL:`, `{Tool:` — the cells that went red
 *                                        in the gate) and three lower-case-hex
 *                                        leftovers. The eleventh claimed negative is
 *                                        new as well, and it is a legitimate product
 *                                        example rejected:
 *                                        `run_macro(&#123;tool:&#x201c;s&#x201d;&#125;)`
 *   this text .......................... 0 missed, 0 claimed, 0 tree false positives
 *
 * Hex digits and the `x` are case-insensitive per spec, so every hex reference carries
 * both digit cases BY CONSTRUCTION (`#[xX]0*7[Bb]`), and the keyword is written
 * `[Tt][Oo][Oo][Ll]`. The named list stays exact, which is the whole point of the next
 * block. **The pattern text was GENERATED from the previous one by a recorded
 * transformation rather than retyped**, so the string these numbers describe is the
 * string that ships.
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
 * **And the skip is a POSITION, not an alternative of the quote** — which took until
 * round twelve to get right for the encoded spellings. See the three-position block
 * below.
 *
 * **THREE MORE SURFACES, all at zero cost** (gate 2 round 5, finding 3, which probed
 * the built module rather than reading the pattern): the **full-width colon** `：`
 * (U+FF1A) — the same IME that emits `｛｝` emits it for the colon key — plus the
 * **hex** brace entities `&#x7B;`/`&#x7D;` beside the decimal ones, and the
 * **HTML-escaped colon** `&#58;`. Adding all three keeps tree false positives at 0
 * and takes the battery from 8 missed shapes to 0.
 *
 * **THE SEMICOLON PARAGRAPH BELOW WAS FALSE IN BOTH HALVES, and the false positive it
 * said it was avoiding was already live** (gate 2 round 9, finding 1, re-measured
 * here). `hasPlaceholder("run_macro(&#123;tool:&quot s&#125;)")` answered **true**:
 * HTML5 parses `&quot` without its semicolon (the legacy set), so that text IS the
 * product's quoted example, and it had been claimed since `51e2d88`. The two halves
 * are also independent — closing the leftover side needs no change to the exemption,
 * because a negative lookahead can only ever REMOVE flags. The real hazard is the one
 * this file already documents for a backtrackable `\s*`: a naive `;?` lets the engine
 * retry and see the `;` instead of the quote.
 *
 * **THE TERMINATOR THEREFORE DIFFERS BY REFERENCE KIND, AND THE SPEC SAYS WHICH.**
 * §13.2.5.78, *named character reference state*, quoted rather than summarised:
 * "Consume the maximum number of characters possible, where the consumed characters are
 * one of the identifiers in the first column of the named character references table.
 * … If the character reference was consumed **as part of an attribute**, and the last
 * character matched is not a U+003B SEMICOLON character (;), and the next input
 * character is either a U+003D EQUALS SIGN character (=) or an ASCII alphanumeric,
 * then, for historical reasons, flush code points consumed as a character reference…
 * Otherwise: If the last character matched is not a U+003B SEMICOLON character (;),
 * then this is a **missing-semicolon-after-character-reference** parse error."
 *
 * So the flush-as-literal path is **conditional on being inside an attribute**; in text
 * content the reference RESOLVES, parse error and all. These strings are source text
 * and advice prose, not attribute values, so text-content semantics is the model —
 * stated as a scoping choice, not as a property of the string. Three consequences,
 * which is exactly the shape the pattern now has:
 *
 *   a LEGACY name        carries **no terminator at all** — `&quot` is consumed even
 *                        when an alphanumeric follows (`&quotscreenshot`)
 *   a NON-LEGACY name    requires its `;`, because longest-match runs against the
 *                        table's first column and that column holds `&quot` **and**
 *                        `&quot;` but only `&apos;` — never `&apos`
 *   a NUMERIC reference  may omit it (`(?:;|(?![0-9A-Za-z;]))` is kept there)
 *
 * **AND `/i` WAS BREAKING THE COMMIT'S OWN PRINCIPLE.** References are written per
 * code point and per base — then the flag made case a wildcard. Named references are
 * case-SENSITIVE apart from a small legacy set, so `&Quot;` `&Apos;` `&Ldquo;`
 * `&RSQUO;` are **undefined**: the text stays literal, the placeholder is still
 * there, and every tree from `572edd8` to `282e0f2` flagged them while this branch
 * had stopped. The mirror was live too — `&Colon;` is U+2237 ∷, not a colon, and was
 * matched as one. The flag is gone; `QUOT` is listed explicitly because it is legacy.
 * **And removing it was not free** — it was covering the keyword and the hex digits
 * too, so both had to be written per token instead. Measured above.
 *
 * **AND THE LOOKAHEAD HAS THREE POSITIONS — `padding* escape? quote` — AND EVERY
 * REFERENCE HAD BEEN PUT IN THE THIRD ONE.** The question it asks is "after the colon,
 * is there a QUOTE?", and the literal side always had the right shape: whitespace is
 * skippable, a backslash is an optional escape, and **a quote is still required after
 * them**. The reference spellings were added as alternatives of the quote ITSELF, so an
 * encoded space or an encoded backslash satisfied the exemption **alone**, while its
 * decoded twin was flagged (gate 1 P2 ×2 on `9fef327`).
 *
 * Measured before fixing: **seven encoded-whitespace leftovers missed** —
 * `{tool:&#32;set_value}`, `&#x20;`, `&#160;`, `&nbsp;`, `&NonBreakingSpace;`,
 * `&Tab;`, `&NewLine;` — **plus three for the escape** (`&#92;`, `&#x5C;`, `&bsol;`),
 * a sibling no finding named and the sharpest evidence that this is a POSITION error
 * rather than a spelling one: the literal `{tool:\set_value}` was already a positive
 * while its own encoded spellings were not. Three legitimate examples were claimed at
 * the same time (the semicolon-less legacy forms, above). After: **0 missed, 0 claimed,
 * 0 tree false positives.**
 *
 * Each position's members are derived BY CODE POINT from the spec data file — padding
 * is U+0020 / U+0009 / U+000A / U+00A0, the escape is U+005C, the quote is the ten
 * listed above — so a name cannot end up in the wrong position by being spelled there.
 *
 * **The earlier wording here was the defect stated as the design**: "the REFERENCE
 * spellings of whitespace and backslash are exempted, the literal characters are not".
 * The literals are not exempted alone either — they are padding and escape. That
 * wording came from round nine, where a bare `\s` and `\\` **in the quote class**
 * exempted *any* space after the colon and turned the cell for `{tool: set_value}` red;
 * the fix then moved the reference forms into the same wrong place. **Fixing wider than
 * the finding, and then narrower than the structure** — both caught before a commit,
 * by the battery and by gate 1 respectively.
 *
 * The reference spellings were genuinely claimed:
 * `&#32;` `&#x20;` `&#160;` before a quote, and `&#92;` `&#x5C;` — **the
 * doc-pipeline rendering of a REAL product string**, `{tool:\"sleep\"` at
 * `macro.ts:750` and `stub-tool-catalog.ts:1211`, the two occurrences this file pins
 * byte-exactly. Measured over the round's probe set: **7 false positives → 0, 4
 * missed → 1**, tree false positives 0 throughout. The one still missed is the
 * semicolon-less leftover, named below as a choice.
 *
 * **AND THE NAMED SIDE IS A DICTIONARY, NOT A GRAMMAR — SO IT IS DERIVED FROM THE
 * SPEC'S OWN DATA FILE AND NOT TYPED HERE.** Numeric references have a grammar and can
 * be written exactly; names are a table, and **writing that table from memory is what
 * lost ten rounds in a row in this file.** A bare `&[A-Za-z]+;` exemption swallowed the
 * `&Quot;` class above; listing `ldquo|rdquo|lsquo|rsquo` left
 * `&OpenCurlyDoubleQuote;` and `&OpenCurlyQuote;` claiming legitimate examples
 * (PR-side codex P2 on `9942d26`); and the explicit list that replaced it still got
 * three properties wrong (P2 ×3 on `6f1d48e`).
 *
 * **All three were the same defect: a PROPERTY of a name, assumed instead of looked
 * up.** `https://html.spec.whatwg.org/entities.json` states both properties directly —
 * the code points a name decodes to, and (by the presence of a key without `;`)
 * whether HTML5 lets the semicolon be dropped. 2,231 entities. What it corrected:
 *
 *   `&bdquo;` `&sbquo;`   the aliases for U+201E and U+201A — **the two characters the
 *                         previous round had just added as LITERALS**. Omitting the
 *                         names preserved the very pipeline-order dependency that
 *                         round claimed to remove: exempt before decoding, flagged
 *                         after.
 *   `&sol;`               decodes to U+002F `/`, **not** a backslash. It had been put
 *                         beside `&bsol;` (U+005C) in the escape exemption — one of
 *                         this file's own over-wide fixes — so `{tool:&sol;set_value}`
 *                         was exempted while `{tool:/set_value}` was flagged.
 *   the semicolon         is not one rule for every name. Longest-match runs against
 *                         the table's first column, which holds `&quot` **and**
 *                         `&quot;` but only `&apos;` — so a legacy name is consumed
 *                         without its semicolon and a non-legacy one is left literal,
 *                         placeholder and all. Of the names here the legacy members are
 *                         exactly `nbsp`, `quot`, `QUOT` (106 exist in total).
 *                         **Round twelve refined this again**: a legacy name needs no
 *                         terminator AT ALL in text content, not merely an optional
 *                         semicolon — see the rule quoted above.
 *
 * **And the derivation found an alias none of the three findings mentions**:
 * `&NonBreakingSpace;`, a second name for U+00A0. A hand-written list would have
 * missed it for an eleventh round; a derived one cannot. The full-width quotes U+FF02
 * and U+FF07 have **no** named form, which is why none appears.
 *
 * Measured over the battery in the cell file, the round's probe table and the tree:
 * `6f1d48e` **4 positives missed, 2 negatives claimed**; this text **0, 0, and 0 tree
 * false positives**. The pattern was generated from the previous one by a recorded
 * transformation, so the string measured is the string that ships.
 *
 * **This is the first completeness claim this file can support**, and it is narrow:
 * for the code points the exemption names, the list is complete *against the spec
 * data*. It says nothing about the malformed set, which is still open by construction.
 *
 * **AND IT DID NOT CLOSE THE CLASS — round twelve arrived within the hour** (gate 1 P2
 * ×2 on `9fef327`, on the POSITION axis). A complete table says nothing about whether
 * each member sits in the right position, or carries the right terminator. **The claim
 * in the previous commit's message — that the recurrence mechanism was gone rather than
 * patched again — was too strong**, and is corrected here and in the PR: one axis was
 * closed, another was still open, and nothing here licenses a claim about the next one.
 *
 * (The cost recorded here before — "a leftover whose capability begins with a named
 * reference is missed" — belonged to the wholesale `&name;` exemption, which is gone.
 * `{tool:&foo;set_value}` **is** flagged now: `&foo;` is not a defined reference, so
 * the text stays literal and the placeholder is still there. The stated alternative,
 * "maintaining a list of every HTML5 alias forever", is what the data file makes free.)
 *
 * **STILL NOT FLAGGED, deliberately — and one of these is a choice, not a limit**:
 * a reference with **no closing semicolon** (`&#123tool&#58set_value&#125`). HTML5
 * parses those, and they are missed here. **The earlier rationale for that was
 * wrong** — it claimed closing the leftover side would re-open a false positive on
 * `run_macro(&#123;tool:&quot s…)`, a string that (a) does not exist in this product
 * (**zero HTML character references anywhere in `src`+`tests` outside this module and
 * its cell file, measured**, so it was synthetic while being labelled the product's)
 * and (b) was **already** being claimed. The exemption now covers it.
 *
 * The gap stays open for a plainer reason: **nothing needs it**. A capability name is
 * `[a-z_]+`, the advice corpus contains no character references at all, and the gate
 * that would consume this does not exist yet. Widening the leftover side to
 * semicolon-less references is measurable work with no measured beneficiary, so it is
 * recorded as unclosed rather than done (gate 2 rounds 8 and 9).
 *
 * Also **still not flagged**: an unbalanced quote — the literal
 * `{tool:'set_value}`, and **since the structural exemption, its entity spellings
 * too** (`&#123;tool:&#x22;set_value&#125;` was flagged at `d7af13d` and is not now;
 * gate 2 round 7, finding 10, which caught the narrowing going unrecorded) — and
 * a tab or NBSP after the opening brace — the latter is the clause priced at 4/15
 * false positives, so it stays rejected. Recorded as choices, not as coverage.
 *
 * STATELESS because it is not global: without `/g`, `.test()` never advances
 * `lastIndex`, so the answer cannot depend on call order. That is the distinction
 * worth keeping visible rather than hiding behind another factory.
 */
const DETECT_LEFTOVER =
  /(?:[{｛]|&(?:lbrace|lcub|#0*123|#[xX]0*7[Bb]|#0*65371|#[xX]0*[Ff][Ff]5[Bb]);)[Tt][Oo][Oo][Ll]\s*(?:[:：]|&(?:colon|#0*58|#[xX]0*3[Aa]|#0*65306|#[xX]0*[Ff][Ff]1[Aa]);)(?!(?:\s|&(?:nbsp);?|&(?:NonBreakingSpace|NewLine|Tab);|&(?:#0*(?:32|9|10|160)|#[xX]0*(?:20|9|[Aa]|[Aa]0));?)*(?:\\|&(?:bsol);|&(?:#0*(?:92)|#[xX]0*(?:5[Cc]));?)?(?:["'＂＇“”‘’„‚]|&(?:quot|QUOT);?|&(?:CloseCurlyDoubleQuote|OpenCurlyDoubleQuote|CloseCurlyQuote|OpenCurlyQuote|ldquor|lsquor|rdquor|rsquor|bdquo|ldquo|lsquo|rdquo|rsquo|sbquo|apos);|&(?:#0*(?:34|39|8216|8217|8218|8220|8221|8222|65282|65287)|#[xX]0*(?:22|27|2018|2019|201[Aa]|201[Cc]|201[Dd]|201[Ee]|[Ff][Ff]02|[Ff][Ff]07));?))[^}｝"']*(?:[}｝]|&(?:rbrace|rcub|#0*125|#[xX]0*7[Dd]|#0*65373|#[xX]0*[Ff][Ff]5[Dd]);)|(?:[{｛]|&(?:lbrace|lcub|#0*123|#[xX]0*7[Bb]|#0*65371|#[xX]0*[Ff][Ff]5[Bb]);)[Tt][Oo][Oo][Ll]\s*(?:[:：]|&(?:colon|#0*58|#[xX]0*3[Aa]|#0*65306|#[xX]0*[Ff][Ff]1[Aa]);)(?!(?:\s|&(?:nbsp);?|&(?:NonBreakingSpace|NewLine|Tab);|&(?:#0*(?:32|9|10|160)|#[xX]0*(?:20|9|[Aa]|[Aa]0));?)*(?:\\|&(?:bsol);|&(?:#0*(?:92)|#[xX]0*(?:5[Cc]));?)?(?:["'＂＇“”‘’„‚]|&(?:quot|QUOT);?|&(?:CloseCurlyDoubleQuote|OpenCurlyDoubleQuote|CloseCurlyQuote|OpenCurlyQuote|ldquor|lsquor|rdquor|rsquor|bdquo|ldquo|lsquo|rdquo|rsquo|sbquo|apos);|&(?:#0*(?:34|39|8216|8217|8218|8220|8221|8222|65282|65287)|#[xX]0*(?:22|27|2018|2019|201[Aa]|201[Cc]|201[Dd]|201[Ee]|[Ff][Ff]02|[Ff][Ff]07));?))[^}｝"'\s]+/;

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
