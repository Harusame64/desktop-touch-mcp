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
  providerForName,
  UNKNOWN_CAPABILITY,
  renderAdvice,
  placeholderSource,
  placeholderPattern,
  CAPABILITIES,
  type AdviceLine,
} from "../../src/tools/_advice-capability.js";

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

  it("answers a name it does not know with a symbol, not with null and not by falling off", () => {
    // GATE 2, 2026-09-13, SECOND ROUND. The two roads exist because one `null` cannot
    // mean both "no provider in this configuration" (drop the line) and "no such
    // capability" (a typo). A caller implementing the documented drop-on-null protocol
    // would make `{tool:reidentify_elemnt}` VANISH — the silent outcome the verbatim
    // policy exists to prevent.
    //
    // Pinned here because the previous round's evidence for the runtime answer was a
    // probe outside the repo, and a probe is not a cell: a later refactor of
    // `providerFor` to a lookup table would reopen the hole with a green suite.
    expect(providerForName("credential_stores", V2)).toBe(UNKNOWN_CAPABILITY);
    expect(providerForName("", V2)).toBe(UNKNOWN_CAPABILITY);
    // A symbol cannot be spent as a tool name by accident: interpolation throws at the
    // call site rather than shipping a word into a sentence.
    const answer = providerForName("nope", V2);
    expect(() => `use ${answer as unknown as string}`).toThrow(TypeError);
    // And the known road agrees with the typed one, at both corners.
    for (const cap of CAPABILITIES) {
      expect(providerForName(cap, V2)).toBe(providerFor(cap, V2));
      expect(providerForName(cap, KILL)).toBe(providerFor(cap, KILL));
    }
  });

  it("throws on the TYPED road for a value from outside the union, rather than answering", () => {
    // The typed road has no honest answer for this input, so it refuses to invent one.
    // It used to return `undefined` (the exhaustive switch fell off its end), which is
    // not the documented `null` protocol and reaches the sentence as a word.
    //
    // The throw cannot reach the failure road: `renderAdvice` screens with
    // `isCapability` first, and the verbatim cell above reddens if that screen goes.
    expect(() => providerFor("credential_stores" as never, V2)).toThrow(TypeError);
    expect(() => providerFor("credential_stores" as never, V2)).toThrow(/not a capability/);
  });

  it("renders to an EMPTY array when every line drops — pinned, because it is a decision owed", () => {
    // Not a wish: `paneIdMissSuggest`'s malformed-paneId branch is two lines and both
    // name `key_locker`, so with the locker off the caller gets no advice at all. This
    // cell pins today's answer so the change that converts the lines has to face it
    // rather than discover it (gate 2, 2026-09-13, both rounds).
    const bothDependent: AdviceLine[] = [
      "Re-call {tool:credential_store} to get the paneId back",
      "Lost it? {tool:credential_store} again",
    ];
    withLocker(true, () => {
      expect(renderAdvice(bothDependent)).toEqual([]);
    });
    withLocker(false, () => {
      expect(renderAdvice(bothDependent)).toEqual([
        "Re-call key_locker to get the paneId back",
        "Lost it? key_locker again",
      ]);
    });
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
