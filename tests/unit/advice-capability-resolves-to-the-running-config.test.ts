/**
 * ADR-036 段階2 B1 — the capability resolver, before any advice line is converted.
 *
 * THE KINDS OF CELL HERE, and why each kind is not obvious. **Not a list of every
 * cell.** It was written as a complete list when the file had 7 cells and has never
 * been one since.
 *
 * **The per-commit sequence that used to sit here is deleted rather than corrected
 * again.** It was wrong three times in the same shape: first "five cells, grown past
 * it twice" (no tree ever had five); then it stopped at the fourth of six commits;
 * then — in the sentence announcing it would not be restated — at the sixth of
 * eight, each time omitting the tree it was written on (gate 2 rounds 2, 3, 4 and 5).
 * **A per-commit history in a comment goes stale on the next commit by
 * construction**, and three corrections did not change that. What survives is the
 * claim above, which is the one that matters; the later cells carry their reason
 * inline.
 *
 *  1. A line with no placeholder passes through BYTE-IDENTICAL. That is what lets
 *     the mechanism ship with zero lines converted.
 *
 *     **The evidence for the 297 dictionary lines is a grep, not this cell.** This
 *     cell feeds three hand-written literals, and the module has no importer
 *     outside this file, so a green suite here cannot say anything about the
 *     corpus. What supports the claim is that the narrow pattern matches **0**
 *     times anywhere in `src` and `tests` outside the module and this file
 *     (measured 2026-09-12), so no existing advice line can be altered by it. Two
 *     different claims, two different instruments — the suite's green is the
 *     weaker one (gate 2, finding 11).
 *
 *     297 is the count of advice strings in the `SUGGESTS` dictionary alone, and it
 *     excludes the four named builders — `getSuggestsForCode` (`_errors.ts:872`),
 *     `nextStepFor` (`_action-guard.ts:258`), `tryBuildSuggestedFix`
 *     (`_action-guard.ts:599`) and `paneIdMissSuggest` (`terminal.ts:731`), the last
 *     being the motivating case in the module header. Two of the four are NOT
 *     exported, so a sweep for exported builders finds two and a reader concludes
 *     the claim is inflated (gate 2 did). An earlier count said 300; that was
 *     a quote-pairing counter meeting quotes inside comments, and the dictionary was
 *     re-counted per code on the Windows machine (94 of 94 agreeing).
 *
 *  2. Every capability is asserted at BOTH corners, naming the tool rather than
 *     "not the other one". One corner green is not evidence: a wrong table can
 *     resolve correctly in one corner by accident — the configuration-axis version
 *     of being satisfied by a one-sided control. This table was cut at the
 *     implementation first and measurement broke two rows in OPPOSITE directions,
 *     which is exactly what a one-corner check would have passed.
 *
 *  3. Dropping happens on BOTH switches now. `disambiguate_window_by_handle` has
 *     no kill-switch provider (that surface returns titles and no handles at all),
 *     and `credential_store` none with the locker off. An earlier version of this
 *     file pinned "no line drops on the surface-swap switch", which measurement
 *     refuted — so the opposite is pinned here, and the two reasons are kept
 *     distinct in the comments even though the behaviour is one.
 *
 *  4. A line mixing a dependent name with names available everywhere keeps the
 *     shared names LITERAL. Nine lines look like that, and an anonymous `{tool}`
 *     could not say which name to resolve.
 *
 *  5. Two placeholders in one line both resolve — one real line names two
 *     dependent tools.
 *
 * ALL FOUR CORNERS ARE BUILT FROM THE `env` ARGUMENT, and that is a fix, not a
 * convenience. `keyLockerDisabled()` used to read the ambient process, so
 * `credential_store` was the one capability that ignored the configuration it was
 * handed — it answered `key_locker` for an env that disables the locker, and
 * dropped the line for an env that enables it (PR-side codex P2 on `64e69a2`). The
 * shared predicate now takes an optional `env`, defaulted, so production still
 * reads the live switch.
 *
 * ONE cell still mutates `process.env`: the one that pins that default. It restores
 * in a `finally`, including on the failing path, because a cell that leaves the
 * switch flipped corrupts every test that runs after it — and that cell exists
 * precisely because "the tests pass with an env argument" would not have caught the
 * production callers reading something else.
 */

import { describe, it, expect } from "vitest";
import {
  providerFor,
  renderAdvice,
  placeholderSource,
  placeholderPattern,
  hasPlaceholder,
  CAPABILITIES,
  type AdviceLine,
} from "../../src/tools/_advice-capability.js";

/**
 * A single backslash, BUILT rather than typed — see the malformed battery below for
 * why. Guarded here so the constant itself cannot be the thing that is wrong.
 */
const BS = String.fromCharCode(92);

/** The four corners of the two kill switches, as `env` maps. */
const V2: Record<string, string | undefined> = {};
const KILL: Record<string, string | undefined> = { DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1" };
const V2_NO_LOCKER: Record<string, string | undefined> = { DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1" };
const KILL_NO_LOCKER: Record<string, string | undefined> = {
  DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1",
  DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1",
};

/**
 * Flip the locker switch for one cell and put it back, including on failure.
 *
 * `body` is deliberately synchronous: a `void`-returning callback that was later
 * made `async` would have its promise ignored, the `finally` would restore the
 * switch before the assertions ran, and the cell would pass while measuring the
 * wrong configuration (gate 2, finding 12).
 */
function withLocker(disabled: boolean, body: () => void): void {
  const key = "DESKTOP_TOUCH_DISABLE_KEY_LOCKER";
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  try {
    if (disabled) process.env[key] = "1";
    else delete process.env[key];
    body();
  } finally {
    if (had) process.env[key] = before;
    else delete process.env[key];
  }
}

describe("ADR-036 B1 — advice names a capability, the presenter resolves it", () => {
  it("passes a line with no placeholder through byte-identical, tool name and all", () => {
    const lines: AdviceLine[] = [
      "Run desktop_discover to see available titles",
      "Do NOT fall back to addressing this window by title. …the keyboard fallback types into whichever window is in front.",
      "",
    ];
    expect(renderAdvice(lines, V2)).toEqual(lines);
    expect(renderAdvice(lines, KILL)).toEqual(lines);
  });

  it("resolves each capability at BOTH corners, named positively on each side", () => {
    // `reidentify_element` is the row measurement re-cut: v2 identifies via
    // entities, the kill switch via the raw tree. Cut at the implementation it
    // looked kill-switch-only, because v2 returns no raw tree.
    expect(providerFor("reidentify_element", V2)).toBe("desktop_discover");
    expect(providerFor("reidentify_element", KILL)).toBe("get_ui_elements");
    expect(providerFor("list_window_titles", V2)).toBe("desktop_discover");
    expect(providerFor("list_window_titles", KILL)).toBe("get_windows");
    expect(providerFor("set_value", V2)).toBe("desktop_act");
    expect(providerFor("set_value", KILL)).toBe("set_element_value");
  });

  it("has no kill-switch provider for naming one window by handle", () => {
    // Measured: that surface returns titles and NO handles (0 of 10, no
    // `hwnd`/`handle` string anywhere), and takes no arguments, so there is not
    // even a flag to ask for one.
    expect(providerFor("disambiguate_window_by_handle", V2)).toBe("desktop_discover");
    expect(providerFor("disambiguate_window_by_handle", KILL)).toBeNull();
  });

  it("drops a line on the SURFACE-SWAP switch when that surface lacks the capability", () => {
    // The claim this replaces said no line drops on this switch. Measurement
    // refuted it, so the refutation is pinned rather than the comfortable version.
    const line: AdviceLine = "Pass the handle {tool:disambiguate_window_by_handle} returns to name one window exactly";
    expect(renderAdvice([line], V2)).toEqual([
      "Pass the handle desktop_discover returns to name one window exactly",
    ]);
    expect(renderAdvice([line], KILL)).toEqual([]);
  });

  it("drops a credential_store line at both locker-off corners, and keeps it at both locker-on corners", () => {
    // The locker axis crosses the surface axis: the capability is gone in the two
    // corners where the switch is set, whichever surface is published. Asserted on
    // all four rather than on one, because this is the capability whose resolution
    // was reading the wrong configuration entirely.
    const line: AdviceLine = "Re-call {tool:credential_store} to reuse the pane";
    const kept = ["Re-call key_locker to reuse the pane"];

    expect(providerFor("credential_store", V2)).toBe("key_locker");
    expect(providerFor("credential_store", KILL)).toBe("key_locker");
    expect(providerFor("credential_store", V2_NO_LOCKER)).toBeNull();
    expect(providerFor("credential_store", KILL_NO_LOCKER)).toBeNull();

    expect(renderAdvice([line], V2)).toEqual(kept);
    expect(renderAdvice([line], KILL)).toEqual(kept);
    expect(renderAdvice([line], V2_NO_LOCKER)).toEqual([]);
    expect(renderAdvice([line], KILL_NO_LOCKER)).toEqual([]);
  });

  it("still reads the LIVE switch when no env is supplied, which is what production does", () => {
    // The cell that makes the default argument load-bearing. Without it, every
    // assertion above could pass while production read something else entirely —
    // which is the defect this shape replaced, one level up.
    const line: AdviceLine = "Re-call {tool:credential_store} to reuse the pane";
    withLocker(false, () => {
      expect(providerFor("credential_store")).toBe("key_locker");
      expect(renderAdvice([line])).toEqual(["Re-call key_locker to reuse the pane"]);
    });
    withLocker(true, () => {
      expect(providerFor("credential_store")).toBeNull();
      expect(renderAdvice([line])).toEqual([]);
    });
  });

  it("keeps names available everywhere LITERAL while resolving the dependent one", () => {
    // Nine real lines have this shape. An anonymous `{tool}` could not say which
    // of the two names is the one to resolve.
    const line: AdviceLine =
      "Fall back to mouse_click({clickAt}) using the entity rect centre from {tool:reidentify_element}";
    expect(renderAdvice([line], V2)).toEqual([
      "Fall back to mouse_click({clickAt}) using the entity rect centre from desktop_discover",
    ]);
    expect(renderAdvice([line], KILL)).toEqual([
      "Fall back to mouse_click({clickAt}) using the entity rect centre from get_ui_elements",
    ]);
  });

  it("resolves two placeholders in one line — one real line names two dependent tools", () => {
    const line: AdviceLine =
      "Focus the field, then re-take it with {tool:reidentify_element} and write with {tool:set_value}";
    expect(renderAdvice([line], KILL)).toEqual([
      "Focus the field, then re-take it with get_ui_elements and write with set_element_value",
    ]);
  });

  it("drops the whole line when ANY placeholder in it has no provider", () => {
    const line: AdviceLine =
      "Re-take it with {tool:reidentify_element}, then name one window with {tool:disambiguate_window_by_handle}";
    expect(renderAdvice([line], V2)).toHaveLength(1);
    expect(renderAdvice([line], KILL)).toEqual([]);
  });

  it("leaves the product's own {tool: syntax alone, and leaves an unknown capability verbatim", () => {
    // BOTH halves of the "DO NOT LOOSEN THAT PATTERN" comment, pinned — the comment
    // previously asserted the second half from reasoning and it was half wrong.
    //
    // `{tool:` is real syntax in this product: `run_macro({tool:"screenshot", …})`
    // appears in tool descriptions, examples and tests. It survives only because
    // the capture is `[a-z_]+` and every real use has a quote or a comma right
    // after the colon. If someone widens it, THIS is the cell that goes red.
    const macro: AdviceLine =
      'Batch it: run_macro({tool:"screenshot", args:{detail:"meta"}})';
    expect(renderAdvice([macro], V2)).toEqual([macro]);
    expect(renderAdvice([macro], KILL)).toEqual([macro]);

    // And an unknown capability is left VERBATIM, neither resolved nor dropped.
    // Measured first, then chosen: without the `KNOWN` check the line rendered
    // `"x undefined y"` — which still reads as a sentence, so a caller would try
    // to "use undefined". `{tool:nope}` reads as broken, which is the point. Not
    // an exception either: this renders on the failure road, so throwing would
    // cost the whole envelope.
    expect(renderAdvice(["x {tool:nope} y"], V2)).toEqual(["x {tool:nope} y"]);
    expect(renderAdvice(["x {tool:nope} y"], KILL)).toEqual(["x {tool:nope} y"]);
  });

  it("pins the pattern TEXT, for the widenings behaviour cannot see", () => {
    // GATE 2, FINDING 2 (a critical). The macro cell above used to be described as
    // "the cell that goes red if someone widens the capture". It does not: widen to
    // `[^}]+` and `{tool:"screenshot", args:{…}` is captured, is not a capability,
    // and is returned VERBATIM — byte-identical output, green cell.
    //
    // THE INVISIBLE CLASS IS NARROWER THAN "ANY WIDENING", and the broad version was
    // written here and measured false (gate 2, finding 1, next round). A widening is
    // invisible only while the match stays INSIDE ONE PLACEHOLDER — capture `}`-free,
    // both braces intact. These two still redden cells, measured:
    //   `\{tool:(.+)\}`    greedy: one match spans two placeholders, so the
    //                      two-placeholder and mixed-precedence cells fail and the
    //                      kill-switch corner stops dropping
    //   `\{tool:([a-z_]+)` no closing brace: a stray `}` survives in the output
    // So the text is pinned for the rest — the part no behaviour can distinguish.
    expect(placeholderSource()).toBe("\\{tool:([a-z_]+)\\}");
    expect(placeholderPattern().flags).toBe("g");
  });

  it("hands out a FRESH pattern each call, because a shared /g regex lies to .test()", () => {
    // GATE 2, FINDING 3. A global RegExp carries `lastIndex`, so one shared instance
    // answers `.test()` for the SAME input true, then false. The consumer this module
    // names is the future gate that scans rendered advice for a leftover `{tool:` —
    // a per-line `.test()` loop, which on a shared instance reports every other line
    // clean. `String.replace` resets `lastIndex`, which is why `renderAdvice` was
    // never affected and why no existing cell would have caught it.
    const a = placeholderPattern();
    const b = placeholderPattern();
    expect(a).not.toBe(b);
    expect(a.test("{tool:set_value}")).toBe(true);
    expect(b.test("{tool:set_value}")).toBe(true);
    // The trap is demonstrated on a LOCALLY built global regex, not on the
    // factory's product. Asserting `[true,false]` on `placeholderPattern()` would
    // pin a JavaScript invariant (every `/g` regex advances `lastIndex`) AND make
    // the suite require this factory to keep returning a stateful object — so the
    // natural hardening, handing out a non-global detector, would go red. Gate 2
    // caught that: a cell can forbid its own fix (round 3, finding 7).
    const mine = new RegExp(placeholderSource(), "g");
    expect([mine.test("{tool:set_value}"), mine.test("{tool:set_value}")]).toEqual([true, false]);
  });

  it("keeps every capability name expressible by that pattern", () => {
    // GATE 2, FINDING 8. The union and the pattern's character class are unlinked:
    // `read_uia2` or `readTree` would compile, be KNOWN, and have a switch arm,
    // while `{tool:read_uia2}` could never match `[a-z_]+` — so it would be left
    // verbatim and be indistinguishable from a typo, with no gate firing.
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const cap of CAPABILITIES) {
      // Checked THROUGH THE REAL PATTERN, not against a re-typed `[a-z_]+`. The
      // hand-copied class was the first version of this cell, and it reintroduced
      // one level up exactly the drift `CAPABILITIES` is derived from `KNOWN` to
      // avoid: widen the pattern to admit digits and the copy would redden a name
      // the pattern now accepts — a false red — while the two could be edited apart
      // in either direction (gate 2, finding 2).
      expect(
        `{tool:${cap}}`.replace(placeholderPattern(), "HIT"),
        `capability ${cap} cannot appear in a placeholder`,
      ).toBe("HIT");
      // And each one resolves to something at one corner or the other; a capability
      // with no provider at any corner is a promise that cannot be declared.
      const anywhere = providerFor(cap, V2) ?? providerFor(cap, KILL);
      expect(anywhere, `capability ${cap} has no provider at either corner`).not.toBeNull();
    }
  });

  it("drops a line that mixes an unknown capability with one that has no provider", () => {
    // GATE 2, FINDING 9 — precedence was reachable but unpinned: drop beats
    // everything, and an unknown name stays verbatim while its line-mates still
    // resolve (the second assertion below shows exactly that, which is why the
    // earlier phrase "verbatim beats resolve" was wrong: they are per-placeholder
    // and independent, and only drop is a whole-line fate — gate 2, finding 5).
    // The consequence worth pinning is the second
    // line: a typo alone SHIPS, placeholder and all, which is the intended visible
    // breakage rather than an accident.
    const mixed: AdviceLine = "{tool:nope} then {tool:disambiguate_window_by_handle}";
    expect(renderAdvice([mixed], KILL)).toEqual([]);
    expect(renderAdvice([mixed], V2)).toEqual(["{tool:nope} then desktop_discover"]);
    expect(renderAdvice(["only {tool:nope}"], V2)).toEqual(["only {tool:nope}"]);
  });

  it("detects a leftover placeholder the way a SCANNER will call it — same answer every time", () => {
    // PR-SIDE CODEX P2 on `6867088`, and the finding is about the cell above as
    // much as the code: a factory that is fresh PER CALL does not help the shape
    // this module's own note described — call it once, then `.test()` each line.
    // That reuses one `/g` instance, so two consecutive identical lines alternate
    // between detected and missed. The cell above dodged exactly that by calling
    // the factory again each time, which is how a green suite hid the real mode.
    //
    // `hasPlaceholder` is stateless (no `/g`), so the scanner's real usage is safe.
    const leftover = "Re-call {tool:nope} to reuse the pane";
    const lines = [leftover, leftover, leftover]; // the alternating case, literally
    expect(lines.map(hasPlaceholder)).toEqual([true, true, true]);
    // And the same instance, hammered, keeps answering:
    for (let i = 0; i < 5; i++) expect(hasPlaceholder(leftover)).toBe(true);
    // Negatives, including the product's own syntax it must not claim — both quote
    // styles, because `macro.ts` uses single quotes and the stub catalog double:
    expect(hasPlaceholder('run_macro({tool:"screenshot", args:{}})')).toBe(false);
    expect(hasPlaceholder("run_macro({tool:'focus_window',params:{title:'x'}})")).toBe(false);
    expect(hasPlaceholder("Run desktop_discover to see available titles")).toBe(false);

    // THE TWO SHAPES THAT BROKE THE OBVIOUS DETECTOR, measured in the product and
    // kept here so the next person does not rediscover them. The first version —
    // quote lookahead, optional closing brace — matched three real places:
    // BYTE-EXACT EXCERPTS of the three real occurrences, not paraphrases of them.
    // Gate 2 round 4 (finding 4) caught the earlier versions: one said `screenshot`
    // where the file says `sleep`, and the other dropped the word " call" and used
    // the wrong indent — so "a cell pins it with the real strings" was itself a
    // paraphrase, which is the shape this whole file exists to distrust.
    // `macro.ts:750` and `stub-tool-catalog.ts:1211`, the escaped-quote shape:
    expect(hasPlaceholder('a special sleep pseudo-step: {tool:\\"sleep\\", params:{ms:N}} (max 10000ms per step)')).toBe(false);
    // A single-quoted example shape — and this one is NOT one of the three
    // occurrences, it is an ordinary negative. The previous version of this line
    // claimed to be byte-exact from `stub-tool-catalog.ts:1211` and was not: 86 of
    // 87 characters matched and then it closed the array with a `]` that is not in
    // the file (the line continues `,{tool:'keyboard',…`). So the fix for two
    // paraphrases minted a third, fabricated string — in the sentence claiming to
    // retire paraphrases (gate 2 round 5, finding 1). Truncated to the part that is
    // byte-exact, and relabelled.
    expect(hasPlaceholder("  [{tool:'focus_window',params:{windowTitle:'Notepad'}},{tool:'sleep',params:{ms:300}}")).toBe(false);
    // `macro.ts:274`, the line whose token is cut at the colon:
    expect(hasPlaceholder("  // `z.object(schema).parse(args)` call. Without this, `run_macro({tool:")).toBe(false);

    // AND THE TWO SHAPES THAT PRICED THE OBVIOUS WAY OF REACHING THE FIVE ABOVE.
    // Allowing whitespace after the opening brace catches `{tool :x}` — and also
    // TypeScript type literals, 4 line-level / 15 whole-file false positives in real
    // product files. Keeping `{tool` adjacent costs nothing, which is why the extra
    // reach is an improvement rather than a trade; these two cells are what make
    // that measurable instead of asserted.
    expect(hasPlaceholder("const x: { tool: string; params: Record<string, unknown> } = y;")).toBe(false);
    expect(hasPlaceholder("return { tool:   ev.tool   };")).toBe(false);

    // THE TWO PREFIX TYPOS THE MODULE LISTS AS "deliberately not flagged" — they had
    // no cell, so "pinned by cells" was false for two of the five entries and
    // nothing would redden if the prefix became lax or stopped matching (gate 2
    // round 5, finding 5). The prefix is literal, which is the whole reason.
    expect(hasPlaceholder("Re-call {tools:set_value} to reuse the pane")).toBe(false);
    expect(hasPlaceholder("Re-call {tool;set_value} to reuse the pane")).toBe(false);
    // And the colon-at-end-of-line shape, with the qualification that matters: the
    // same prose WITH a later `}` on the line IS flagged, because the body walks to
    // the closing brace.
    expect(hasPlaceholder("Re-call {tool: see the handbook")).toBe(false);
    expect(hasPlaceholder("Re-call {tool: see the handbook}")).toBe(true);

    // THE MIRROR HOLE OF THE HTML BRANCH, and these four are SYNTHETIC: no line in
    // the tree looks like this today, so they are not "real strings" — they are the
    // shape a doc pipeline would produce from the product's own example. The branch
    // was added to catch an HTML-escaped LEFTOVER and it flagged an HTML-escaped
    // EXAMPLE, because the quote exemption knew only literal and `\"` quotes
    // (PR-side codex P2 on `572edd8`). One boundary, every encoding: the character
    // after the colon is a quote — literal, backslash-escaped, or an entity.
    expect(hasPlaceholder("run_macro(&#123;tool:&quot;screenshot&quot;,args:&#123;&#125;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#34;screenshot&#34;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&apos;focus_window&apos;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#39;focus_window&#39;&#125;)")).toBe(false);
    // WITH WHITESPACE BETWEEN THE COLON AND THE ENTITY — the shape that showed the
    // skip has to live inside the lookahead, because `\s*` outside it backtracks to
    // zero and the lookahead then sees the space (PR-side codex P2 on `51e2d88`).
    expect(hasPlaceholder("run_macro(&#123;tool: &quot;screenshot&quot;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:  &quot;screenshot&quot;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#x7B;tool: &quot;screenshot&quot;&#x7D;)")).toBe(false);
    // ALL-HEX product examples. Adding the hex COLON created this class and the
    // quote exemption had only named and decimal entities — the same hex/decimal
    // asymmetry the commit before had just congratulated itself for finding, one
    // token to the right (gate 2 round 6, finding 4). Synthetic: zero hex entities
    // exist OUTSIDE this module and this file, measured — the ones inside are these
    // very assertions. The third shape below is the MIXED case (decimal braces, hex
    // quotes), which is the interesting one, not a third all-hex example.
    expect(hasPlaceholder("run_macro(&#x7B;tool&#x3A;&#x22;screenshot&#x22;&#x7D;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#x7B;tool&#x3A;&#x27;focus_window&#x27;&#x7D;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#x22;screenshot&#x22;&#125;)")).toBe(false);

    // AND THE FIVE THAT FORCED THE LOOKAHEAD TO BECOME STRUCTURAL (gate 2 round 7,
    // finding 6). Listing six spellings claimed all of these; writing the quote as
    // `&(?:quot|apos|#x?0*(?:22|27|34|39));` plus the full-width and curly literals
    // covers base, case and LEADING ZEROS by construction — zeros are legal in a
    // numeric character reference, which is the part a list can never finish.
    // Synthetic, like the rest of this group: none of these shapes exists in the tree.
    expect(hasPlaceholder("run_macro(&#123;tool:&#0034;screenshot&#0034;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#x0022;screenshot&#x0022;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#0039;focus_window&#0039;&#125;)")).toBe(false);
    // Full-width and curly quotes, reachable for the same CJK-IME reason the
    // full-width braces and colon are accepted as leftovers:
    expect(hasPlaceholder("run_macro(｛tool：＂screenshot＂｝)")).toBe(false);
    expect(hasPlaceholder("run_macro({tool:“screenshot”})")).toBe(false);
    // Zero-padded BRACES around a quoted example: the padding must not turn a
    // legitimate macro into a leftover. This is the negative half of the same P2 —
    // structuring the braces widens what counts as a brace, so the quote exemption
    // has to keep holding underneath it.
    expect(hasPlaceholder("run_macro(&#x07B;tool&#x03A;&#x22;s&#x22;&#x07D;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#0123;tool&#058;&quot;s&quot;&#0125;)")).toBe(false);

    // REFERENCES TO THE CURLY AND FULL-WIDTH QUOTES. The exemption claimed "a
    // character reference to one" while listing those quotes only as literals, so
    // these eight legitimate examples were flagged — false positives since
    // `572edd8`, untouched by two rewrites that called themselves structural
    // (gate 2 round 8, finding 2). The lesson is the asymmetry, not the characters:
    // widening what counts as a BRACE while leaving the QUOTE side narrower turns
    // product syntax into leftovers.
    expect(hasPlaceholder("run_macro(&#123;tool:&#8220;s&#8221;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#x201C;s&#x201D;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&ldquo;s&rdquo;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#8216;s&#8217;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&lsquo;s&rsquo;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#65282;s&#65282;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#xFF02;s&#xFF02;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#65287;s&#65287;&#125;)")).toBe(false);

    // THE LONG-FORM NAMED ALIASES — and the reason the named side is now exempted
    // wholesale (PR-side codex P2 on `9942d26`). HTML5 defines several names per
    // code point, so listing four of them left these two claiming real examples.
    // Numeric references have a grammar; named ones are a dictionary that keeps
    // growing — the shape that lost ten rounds in this file. Two candidates measured
    // identically (the full alias list vs. exempting any `&name;`), so the one with
    // fewer knobs won.
    expect(hasPlaceholder("run_macro(&#123;tool:&OpenCurlyDoubleQuote;s&CloseCurlyDoubleQuote;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&OpenCurlyQuote;s&CloseCurlyQuote;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&ldquo;s&rdquor;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&lsquo;s&rsquor;&#125;)")).toBe(false);

    // (That trade is gone: the quote names are enumerated explicitly now, so an
    // undefined name no longer buys an exemption — see the assertion below.)
    // `&foo;` is not a defined reference, so the text stays literal and the
    // placeholder is still there — it is a LEFTOVER, and flagging it is correct. The
    // earlier version asserted the opposite, as the cost of a wholesale `&[A-Za-z]+;`
    // exemption that has since been replaced by the explicit quote list (round 9,
    // finding 3, which showed that wildcard also swallowed `&Quot;`).
    expect(hasPlaceholder("use &#123;tool:&foo;set_value&#125; to do it")).toBe(true);

    // GATE 2 ROUND 9, findings 1 to 3 — each of these was a LIVE defect at the head
    // before this commit, and each is a product example or a real string, not a
    // synthetic one.
    //
    // 1. `&quot` without its semicolon: HTML5 parses it (legacy set), so this IS the
    //    quoted macro example. It had been claimed since `51e2d88`, while the comment
    //    said closing the semicolon gap would "re-open" it — it was already open.
    expect(hasPlaceholder("run_macro(&#123;tool:&quot s&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&QUOT;s&QUOT;&#125;)")).toBe(false); // legacy upper
    // 2. The lookahead has FOUR members and only the quote had been structured, so
    //    the reference spellings of whitespace and backslash were claimed. The
    //    backslash pair is the doc-pipeline rendering of a REAL product string —
    //    `{tool:\"sleep\"` at `macro.ts:750` and `stub-tool-catalog.ts:1211`.
    expect(hasPlaceholder("run_macro(&#123;tool:&#32;&quot;s&quot;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#x20;&quot;s&quot;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#160;&quot;s&quot;&#125;)")).toBe(false);
    expect(hasPlaceholder("x &#123;tool:&#92;&quot;sleep&#92;&quot;&#125;")).toBe(false);
    expect(hasPlaceholder("x &#123;tool:&#x5C;&quot;sleep&#x5C;&quot;&#125;")).toBe(false);
    // 3. `&Colon;` is U+2237 ∷, not U+003A — so this is not a placeholder at all and
    //    must not be flagged. It was matched as a colon.
    expect(hasPlaceholder("use &#123;tool&Colon;set_value&#125; x")).toBe(false);

    // AND THE ANSWER MUST NOT DEPEND ON WHERE THE PIPELINE DECODES (gate 1 P2 on
    // `1a715b2`). `&ldquor;` / `&lsquor;` decode to U+201E `„` and U+201A `‚`, which
    // were NOT among the eight quote code points listed — so the same typographic
    // example was exempted BEFORE decoding and flagged AFTER it. Measured: 4 of 8
    // negatives claimed before, 0 after adding those two as literals and as
    // references. Treating a name as an alias of a character it does not decode to
    // is the mistake; the fix is to carry the character.
    expect(hasPlaceholder("run_macro({tool:&ldquor;s&rdquo;})")).toBe(false); // before decoding
    expect(hasPlaceholder("run_macro({tool:„s”})")).toBe(false); // after decoding
    expect(hasPlaceholder("run_macro({tool:‚s’})")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#8222;s&#8221;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&#x201A;s&#x2019;&#125;)")).toBe(false);
    // AND THE SAME EXAMPLE IN LOWER-CASE HEX, which the fix for the round above broke:
    // `/i` came off so the NAMED references would be strict, and it took the hex digits
    // with it. Measured at that head — this pair newly FLAGGED, i.e. a legitimate
    // product example rejected, while three leftovers went missing (in the loop below).
    // Hex digits and the `x` are case-insensitive per spec; a named reference is not.
    expect(hasPlaceholder("run_macro(&#123;tool:&#x201c;s&#x201d;&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro(&#x7b;tool&#x3a;&#x22;screenshot&#x22;&#x7d;)")).toBe(false);
    // AND THE ALIASES FOR THOSE TWO CHARACTERS WERE MISSING (gate 1 P2 on `6f1d48e`,
    // reproduced here before fixing). `&bdquo;` decodes to U+201E and `&sbquo;` to
    // U+201A — the two characters the round above had just added as LITERALS — so
    // leaving the aliases out preserved exactly the pipeline-order dependency that
    // round claimed to remove. The name lists are now DERIVED from the spec's own
    // data file (`https://html.spec.whatwg.org/entities.json`) rather than typed:
    // U+201E is `&bdquo;` and `&ldquor;`, U+201A is `&sbquo;` and `&lsquor;`, and the
    // full-width quotes have no named form at all.
    expect(hasPlaceholder("run_macro({tool:&bdquo;s&rdquo;})")).toBe(false);
    expect(hasPlaceholder("run_macro({tool:&sbquo;s&rsquo;})")).toBe(false);
    // AND A LEGACY REFERENCE NEEDS NO TERMINATOR AT ALL IN TEXT CONTENT (gate 1 P2 on
    // `9fef327`). The `(?![0-9A-Za-z;])` terminator was modelling the ATTRIBUTE rule:
    // the tokenizer flushes a semicolon-less legacy reference as literal text only
    // when it was consumed as part of an attribute and the next character is `=` or
    // alphanumeric. In text content it is consumed, so these three ARE the product's
    // quoted macro example and must stay exempt. The contrast is `&apos set_value`
    // above, which is a positive: `apos` is not in the legacy set, so a parser really
    // does leave it literal.
    expect(hasPlaceholder("run_macro({tool:&quotscreenshot&quot})")).toBe(false);
    expect(hasPlaceholder("run_macro(&#123;tool:&quotscreenshot&quot&#125;)")).toBe(false);
    expect(hasPlaceholder("run_macro({tool:&QUOTscreenshot&QUOT})")).toBe(false);
    // …while the HTML-escaped LEFTOVER (no quote after the colon) stays a positive,
    // asserted in the malformed loop above. That contrast is the whole rule.

    // AND THE MALFORMED ONES, which is why this is not the replacement grammar
    // (PR-side codex P2 on `8375314`). None of these matches `[a-z_]+`, so
    // `renderAdvice` ships them VERBATIM — a strict detector answered `false` and
    // the gate would have waved through exactly the typos it exists to catch.
    for (const bad of [
      "Re-call {tool:set_value2} to reuse the pane", // digit
      "Re-call {tool:set-value} to reuse the pane", // hyphen
      "Re-call {tool:Set_value} to reuse the pane", // capital
      "Re-call {tool:} to reuse the pane", // empty
      "Re-call {tool:set_value to reuse the pane", // truncated, no closing brace
      "Re-call {tool:set value} to reuse the pane", // space inside the braces
      // The five found by asking the BUILT module instead of reading the pattern
      // (win2, on `25f9bb3`). Each was shipped verbatim AND missed by the first lax
      // detector — the same defect one layer down.
      "use {tool :set_value} to do it", // space BEFORE the colon
      "use {TOOL:set_value} to do it", // keyword in capitals
      "use {Tool:set_value} to do it", // mixed case
      "use ｛tool:set_value｝ to do it", // full-width braces (a CJK IME emits these)
      "use &#123;tool:set_value&#125; to do it", // HTML-escaped
      // The backslash family — one shape when gate 1 raised it on `25f9bb3` (where
      // it was "the twentieth"), four entries now, so the ordinal is dropped rather
      // than left heading a group it no longer counts (gate 2 round 5, finding 11):
      // the backslash exemption was
      // added for the product's `{tool:\"sleep\"` and excluded EVERY backslash, so a
      // leftover beginning with one was shipped verbatim and never flagged. Only
      // `\"` and `\'` are exempt now.
      // THE BACKSLASH SHAPES ARE BUILT FROM A CHARACTER CODE, NOT TYPED. The other
      // side's merged battery had three entries whose names said "backslash" while
      // the strings held none: a patch step ate one escape layer, and the run scored
      // them as "resolved away" — a cell that does not contain the character it
      // claims to test. That was the third escape-eaten incident of the day, so the
      // rule is: when an entry exists to test ONE character, do not type it.
      `use {tool:${BS}set_value} to do it`,
      `use {tool:${BS}} to do it`,
      `use {tool:${BS}${BS}set_value} to do it`,
      `use {tool:${BS}${BS}} to do it`,
      // Surfaces found by probing the BUILT module rather than reading the pattern
      // (gate 2 round 5, finding 3). The full-width colon is the realistic one: the
      // IME that emits `｛｝` emits `：` for the colon key just as readily.
      `use {tool${String.fromCharCode(0xff1a)}set_value} to do it`,
      `use ｛tool${String.fromCharCode(0xff1a)}set_value｝ to do it`,
      "use &#x7B;tool:set_value&#x7D; to do it", // hex brace entities
      "use &#123;tool&#58;set_value&#125; to do it", // HTML-escaped colon, decimal
      // A pipeline that emits entities in HEX did so for the braces and not the
      // colon in the first version — the asymmetry a reader would never guess
      // (PR-side codex P2 on `e670ad7`).
      "use &#x7B;tool&#x3A;set_value&#x7D; to do it",
      "use &#123;tool&#x3A;set_value&#125; to do it", // hex colon, decimal braces
      // ZERO-PADDED references, which are legal and were missed while only the
      // quote had been structured (PR-side codex P2 on `99b9b63`). Every reference
      // is written `&(?:#x?0*(?:…));` now, so padding is covered by construction.
      "use &#x07B;tool&#x03A;set_value&#x07D; to do it",
      "use &#0123;tool&#058;set_value&#0125; to do it",
      "use &#x07B;tool&#58;set_value&#125; to do it", // padded hex brace, plain decimal rest
      // REFERENCES TO THE FULL-WIDTH CHARACTERS, and the HTML5 named forms. The
      // detector accepted the literal `｛｝：` while having no reference form for
      // them, so these were shipped verbatim and missed — this module's own two
      // premises composed (a CJK IME emits the full-width characters; a doc pipeline
      // escapes non-ASCII), gate 2 round 8, finding 1.
      "use &#65371;tool&#65306;set_value&#65373; to do it",
      "use &#xFF5B;tool&#xFF1A;set_value&#xFF5D; to do it",
      "use &#65371;tool:set_value&#65373; to do it", // reference brace, literal colon
      "use ｛tool&#65306;set_value｝ to do it", // literal brace, reference colon
      "use &lbrace;tool&colon;set_value&rbrace; to do it",
      "use &lcub;tool&colon;set_value&rcub; to do it",
      "use &#123;tool&colon;set_value&#125; to do it", // decimal braces, named colon
      // And the cross-base conflation that ate a real leftover: `&#x39;` is the
      // digit 9, not an apostrophe, so this must be flagged (round 8, finding 5).
      "use &#123;tool:&#x39;set_value&#125; to do it",
      "use &#123;tool: set_value&#125; to do it", // entity braces, space, a NAME
      // CASE: named references are case-SENSITIVE apart from a small legacy set, so
      // these are UNDEFINED — the text stays literal and the placeholder is still
      // there. Every tree from `572edd8` to `282e0f2` flagged them; the wholesale
      // `&[A-Za-z]+;` exemption plus `/i` had stopped (gate 2 round 9, finding 3).
      "use &#123;tool:&Quot;set_value&#125; to do it",
      "use &#123;tool:&Apos;set_value&#125; to do it",
      "use &#123;tool:&Ldquo;set_value&#125; to do it",
      "use &#123;tool:&RSQUO;set_value&#125; to do it",
      // AND CASE IS A PER-TOKEN QUESTION, WHICH THE FIX FOR THE FOUR ABOVE GOT WRONG.
      // `/i` had been doing three jobs at once — the keyword, the hex digits, and the
      // named references — and only the third was meant to go. Removing the whole flag
      // took the keyword with it (`{TOOL:` / `{Tool:`, two entries above, went red in
      // the gate) and silently took the hex digits too: measured at that head, these
      // three were missed and the legitimate lower-case-hex example above was newly
      // FLAGGED. Hex digits and the `x` are case-insensitive per spec; a named
      // reference is not. So the keyword is written `[Tt][Oo][Oo][Ll]` and every hex
      // reference carries both digit cases, while the named list stays exact.
      "use &#x7b;tool&#x3a;set_value&#x7d; to do it",
      "use &#xff5b;tool&#xff1a;set_value&#xff5d; to do it",
      "use &#X7B;tool&#X3A;set_value&#X7D; to do it", // capital `x` in `&#x`
      // GATE 1's OTHER TWO FINDINGS ON `6f1d48e`, both measured before the fix. Each is
      // a PROPERTY of a named reference that this file had assumed instead of looking
      // up — which code point it decodes to, and whether HTML5 lets it drop its
      // semicolon. Both are now read out of the spec's data file.
      //
      // `&sol;` decodes to U+002F `/`, not to a backslash. It had been listed beside
      // `&bsol;` (U+005C) in the backslash exemption, so this leftover was exempted
      // while its decoded twin `{tool:/set_value}` was flagged.
      "use &#123;tool:&sol;set_value&#125;",
      // The semicolon may be omitted only for HTML5's LEGACY set. Of the names this
      // pattern lists, only `quot`, `QUOT` and `nbsp` are in it (106 names in total);
      // for every other name a parser leaves the text literal, so the placeholder is
      // still there. The `&quot s` example stays exempt — asserted above — because it
      // IS legacy, which is the contrast that makes this a property and not a spelling.
      "use {tool:&apos set_value}",
      "use {tool:&ldquo set_value}",
      "use {tool:&bsol set_value}",
      // THE LOOKAHEAD HAS THREE POSITIONS, AND EVERYTHING HAD BEEN PUT IN THE THIRD
      // (gate 1 P2 x2 on `9fef327`, plus the backslash sibling no finding named; all
      // measured before fixing). The question is "after the colon, is there a QUOTE?",
      // and the shape is padding* escape? quote — which the LITERAL side already had
      // (`\s*` then a quote, `\\` then a quote). Every REFERENCE was added as an
      // alternative of the quote itself, so an encoded space or an encoded backslash
      // satisfied the exemption ALONE, while its decoded twin is flagged.
      "use {tool:&#32;set_value}",
      "use {tool:&#x20;set_value}",
      "use {tool:&#160;set_value}",
      "use {tool:&nbsp;set_value}",
      "use {tool:&NonBreakingSpace;set_value}",
      "use {tool:&Tab;set_value}",
      "use {tool:&NewLine;set_value}",
      // The sibling: the same misplacement for the escape position. The literal
      // `{tool:\set_value}` is a positive two groups above; its encoded spellings were
      // not, which is the asymmetry that named this as a defect rather than a choice.
      "use {tool:&#92;set_value}",
      "use {tool:&#x5C;set_value}",
      "use {tool:&bsol;set_value}",
    ]) {
      expect(renderAdvice([bad], V2), `renderAdvice must ship ${bad} unchanged`).toEqual([bad]);
      expect(hasPlaceholder(bad), `the scan must flag ${bad}`).toBe(true);
    }
    // The contrast that justifies two exports, shown on a locally built global
    // regex so that nothing here requires the factory to stay stateful: the same
    // instance, used the way a hoisting scanner would use it, alternates.
    const hoisted = new RegExp(placeholderSource(), "g");
    expect(lines.map((l) => hoisted.test(l))).toEqual([true, false, true]);
  });

  it("takes only the env, because THIS SERVER's surface cannot diverge from the flag", () => {
    // THIS CELL IS THE HEADSTONE OF AN API THAT SHOULD NOT HAVE BEEN BUILT, kept so
    // the next reader does not build it again.
    //
    // Two review rounds pushed in opposite directions. The first said the flag lies
    // about the surface (`131c663`): `server-windows.ts` loads the v2 module as
    // `await import(…).catch(() => null)` and registration branches on `_desktopV2`,
    // not on the flag — so a null module would publish the V1 fallback while the
    // flag still said v2, and advice would name `desktop_discover` over a V1
    // surface. An optional `Surface` argument was added for that, with cells.
    //
    // The second said there is nothing to model (`e670ad7`), and that is measured:
    //
    //   server-windows.ts:22  import { registerMacroTools } from "./tools/macro.js"
    //   macro.ts:132-137      import { desktopDiscoverRegistrationSchema, … }
    //                           from "./desktop-register.js"
    //   and no module in `src` imports `macro.ts` dynamically (four do in
    //   `tool-naming-phase4.test.ts`, none of which loads `server-windows.ts`)
    //
    // ESM evaluates a module's static dependency graph BEFORE running its body, so
    // `desktop-register.js` is evaluated before `server-windows.ts` reaches its
    // line-98 dynamic import. A missing file fails at link (measured on Windows:
    // `ERR_MODULE_NOT_FOUND … imported from …/dist/tools/macro.js`, the server never
    // starts) and an evaluation throw fails at the same edge. **The `catch` is
    // unreachable for either cause**, so no configuration THIS server can reach has
    // the flag disagreeing with the surface — and the `Surface` parameter was
    // removed. Scoped to this server on purpose: `index.ts` loads a different module
    // off win32, where the divergence IS reachable and a surface argument would not
    // repair it either. See the Linux-stub note in the module — gate 2 round 7
    // (finding 2) found the unscoped sentence still standing here.
    //
    // AND THE REMOVAL ITSELF IS NOT PINNED BY ANY CELL — said plainly, because the
    // first version of this cell claimed it was. It asserted
    // `providerFor.length === 1`, with a comment that re-adding the argument "makes
    // it fail to compile". Both halves are false (gate 2 round 6, finding 1, and
    // re-measured here): `Function.length` counts only parameters BEFORE the first
    // default, so a third one after `env = process.env` leaves it at 1; and
    // `tsconfig.json` includes `src/**/*` only, with no second config, so this file
    // is never type-checked at all — a caller passing a third argument would not
    // fail `tsc` either. An inert guard is worse than none, because it reads as one.
    //
    // What this cell does hold is the BEHAVIOUR the flag alone must produce. If the
    // premise ever becomes reachable — see the Linux-stub note in the module — this
    // is where the change starts.
    expect(providerFor("reidentify_element", V2)).toBe("desktop_discover");
    expect(providerFor("reidentify_element", KILL)).toBe("get_ui_elements");
  });

  it("builds its backslash from a code point, checked here rather than at import time", () => {
    // The guard used to be a module-level `if (…) throw`, which gate 2 round 5
    // (finding 13) measured: mutate the code point and the file reports "Tests: no
    // tests" — all 17 cells vanish instead of one reddening, which also destroys the
    // baseline-16/16 positive control the mutation method depends on. And it compared
    // against a typed "\\", the exact thing the battery comment forbids. So it is a
    // cell, and it compares against the code point.
    expect(BS.charCodeAt(0)).toBe(92);
    expect(BS).toHaveLength(1);
  });

  it("keeps surviving lines in their original order", () => {
    const lines: AdviceLine[] = [
      "first, plain",
      "then {tool:list_window_titles}",
      "last, plain",
    ];
    expect(renderAdvice(lines, KILL)).toEqual(["first, plain", "then get_windows", "last, plain"]);
  });
});
