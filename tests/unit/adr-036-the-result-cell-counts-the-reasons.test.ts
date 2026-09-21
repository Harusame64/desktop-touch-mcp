/**
 * ADR-036 — the RESULT axis of the completion grid, and the reasons that are not written anywhere.
 *
 * The road axis got its extractor in #669, the configuration axis in #670. This is the third and
 * last denominator, and it repeats the lesson both of those cost: **the value is not written, it is
 * produced.**
 *
 * The loop's failure arm is typed — `reason: TouchFailReason`, eighteen values, compile-checked.
 * The wrapper ABOVE it returns `reason: string` and does not write it: it computes it from the NAME
 * OF THE ERROR that reached it.
 *
 *     const errorName = result.error.name;                 // _envelope.ts
 *     reason: pascalToSnake(ifUnexp.most_likely_cause)
 *
 * **The first version of this file modelled that producer with `SUGGESTS`** — the advice table,
 * keyed BY the name, downstream of the thing it stood in for. It counted 82 values nothing can
 * produce and missed `handler_error` (every un-typed throw collapses there at `toResultErr`),
 * `unknown` (the fallback) and the three lease codes. Gate 2 on #672 added a fifth lease code and
 * watched the gate print OK. **The number went 101 to 26.**
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PINNED_PASCAL_TO_SNAKE,
  readReturnedCodes,
  readPresentedNames,
  readEnvelopeErrorNames,
  readLeaseCodes,
  readReasonCatalogue,
  readReasonConversion,
  readSuggestsKeys,
  readUnexpectedFallback,
} from "../../scripts/lib/result-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the extractor", () => {
  it("reads the advice table's own keys, not the advice under them", () => {
    const problems: string[] = [];
    const keys = readSuggestsKeys(
      `const SUGGESTS: Record<string, string[]> = {
  ExecutorFailed: ["fall back to click_element"],
  AimOccluded: [
    "the point is covered",
    "NestedLooking: not a key",
  ],
};`,
      problems,
    );
    expect(keys).toEqual(["AimOccluded", "ExecutorFailed"]);
    expect(problems).toEqual([]);
  });

  it("says the table is UNKNOWN, not empty, when it cannot be read", () => {
    // An unreadable table returns an empty set, and an empty set is indistinguishable from "the
    // wrapper produces nothing" — which would silently shrink the axis from 101 to 19.
    const problems: string[] = [];
    expect(readSuggestsKeys(`const SOMETHING_ELSE = {};`, problems)).toEqual([]);
    expect(problems.join("")).toMatch(/SUGGESTS could not be read/);
  });

  it("extracts the conversion instead of re-implementing it, and the difference is real", () => {
    // **A port written from the function's NAME agrees for 90 of the 94 keys and differs on four.**
    // The implementation splits `([a-z])([A-Z])` and nothing else, so a run of capitals does not
    // split. Two implementations that agree most of the time are the worst kind of check.
    const conversion = readReasonConversion(`function pascalToSnake(s: string): string {\n  ${PINNED_PASCAL_TO_SNAKE}\n}`);
    expect(conversion.apply).not.toBeNull();
    expect(conversion.apply!("ExecutorFailed")).toBe("executor_failed");
    // The four the naive port gets wrong — `…NUpper…` stays `nupper`, because there is no lowercase
    // letter before the second capital.
    expect(conversion.apply!("WorkingMemoryNUpperBoundExceeded")).toBe("working_memory_nupper_bound_exceeded");
    expect("WorkingMemoryNUpperBoundExceeded".replace(/(?!^)(?=[A-Z])/g, "_").toLowerCase()).toBe(
      "working_memory_n_upper_bound_exceeded",
    );
  });

  it("refuses to derive an image from a conversion it has not seen", () => {
    const problems: string[] = [];
    const changed = readReasonConversion(
      `function pascalToSnake(s: string): string {\n  return s.replace(/(?!^)(?=[A-Z])/g, "_").toLowerCase();\n}`,
      problems,
    );
    expect(changed.apply).toBeNull();
    expect(problems.join("")).toMatch(/pascalToSnake has changed — the computed reason set must be re-derived/);

    const missing: string[] = [];
    expect(readReasonConversion(`const x = 1;`, missing).apply).toBeNull();
    expect(missing.join("")).toMatch(/pascalToSnake could not be found/);
  });

  it("reads the fallback the wrapper substitutes when there is no if_unexpected", () => {
    // That fallback is a reason a caller can receive which is in no union, in neither catalogue,
    // and — because it is not a `SUGGESTS` key — carries no advice either.
    expect(
      readUnexpectedFallback(`const ifUnexp = envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };`),
    ).toBe("Unknown");
    const problems: string[] = [];
    expect(readUnexpectedFallback(`const ifUnexp = envelope.if_unexpected;`, problems)).toBeNull();
    expect(problems.join("")).toMatch(/fallback could not be read — the reason it produces is unknown, not absent/);
  });

  it("reads a catalogue line, including the ones that name several reasons at once", () => {
    expect(
      readReasonCatalogue(`
        "## When desktop_act returns ok:false",
        "  lease_expired / lease_generation_mismatch / entity_not_found → re-call desktop_discover;",
        "  modal_blocking → dismiss the blocker;",
        "prose that names executor_failed without an arrow",
      `),
    ).toEqual(["entity_not_found", "lease_expired", "lease_generation_mismatch", "modal_blocking"]);
  });

  it("reads the producers: the HandlerError family, and everything else collapsing into it", () => {
    // **Only that family arrives under its own name.** `toResultErr` wraps everything else, so the
    // twenty-odd engine error classes extending plain `Error` all become `HandlerError` rather than
    // each adding a reason — and `HandlerError` is therefore one of the names, and one of the two
    // in no catalogue.
    const problems: string[] = [];
    const names = readEnvelopeErrorNames(
[
        {
          file: "a.ts",
          text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
                 class ExecutorFailed extends HandlerError { constructor() { super(); this.name = "ExecutorFailed"; } }
                 class Deeper extends ExecutorFailed { constructor() { super(); this.name = "Deeper"; } }
                 class NotInFamily extends Error { constructor() { super(); this.name = "NotInFamily"; } }`,
        },
      ],
      problems,
    );
    // The family read now returns the map the presenter read needs alongside the set.
    expect(names.names).toEqual(["Deeper", "ExecutorFailed", "HandlerError"]);
    expect(names.names).not.toContain("NotInFamily");
    expect(names.nameOfClass.get("Deeper")).toBe("Deeper");
    expect(problems).toEqual([]);

    // A name this parser cannot enumerate is REPORTED, unless a human wrote the exemption down.
    const withRoot = `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
                      class Coded extends HandlerError { constructor(code) { super(); this.name = code; } }`;
    const dynamic: string[] = [];
    readEnvelopeErrorNames(
[{ file: "b.ts", text: withRoot }], dynamic);
    expect(dynamic.join("")).toMatch(/Coded sets this.name from `code`, a value this parser cannot enumerate/);

    // **The exemption carries the FILE as well as the class.** One written-down entry must not
    // exempt a same-named class somewhere else — the sibling axes closed exactly this twice.
    const exempted: string[] = [];
    expect(readEnvelopeErrorNames([{ file: "b.ts", text: withRoot }], exempted, ["b.ts:Coded:code"]).names).toEqual([
      "HandlerError",
    ]);
    expect(exempted).toEqual([]);
    const elsewhere: string[] = [];
    readEnvelopeErrorNames(
[{ file: "c.ts", text: withRoot }], elsewhere, ["b.ts:Coded:code"]);
    expect(elsewhere.join("")).toMatch(/Coded sets this.name from/);
  });

  it("reads the names at the presenter's call sites, not by family membership", () => {
    // **Membership was a proxy and the proxy was wrong for two classes.** They extend
    // `HandlerError` and are thrown by the capture engine, but no `toFailureEnvelope(` site ever
    // receives them — they reach a caller through the flat `failWith` surface, so the axis carried
    // two envelope cells that cannot exist (codex, #672, P1). Fourth time today that the answer is
    // the same: read the thing at the point it happens, not something adjacent to it.
    const nameOfClass = new Map([
      ["HandlerError", "HandlerError"],
      ["Presented", "PresentedName"],
      ["NeverPresented", "NeverPresentedName"],
    ]);
    const problems: string[] = [];
    expect(
      readPresentedNames(
        [
          {
            file: "a.ts",
            text: `toFailureEnvelope(
  Err(new Presented("boom")),
  { optIn },
);
throw new NeverPresented("thrown, never handed to the envelope");
toFailureEnvelope(Err(new CodedHandlerError("LiteralCode")), { optIn });`,
          },
        ],
        nameOfClass,
        problems,
      ),
    ).toEqual(["LiteralCode", "PresentedName"]);
    expect(problems).toEqual([]);

    // `toResultErr` is where everything outside the family arrives — but only if a site uses it.
    expect(
      readPresentedNames([{ file: "a.ts", text: `toFailureEnvelope(toResultErr(e), { optIn });` }], nameOfClass),
    ).toEqual(["HandlerError"]);

    // A coded name held in a variable is exempted by the binding it comes from, and reported when
    // the binding is not there.
    const bound = `const { code } = mapIt(v);\ntoFailureEnvelope(Err(new CodedHandlerError(code)), { optIn });`;
    const ok: string[] = [];
    readPresentedNames([{ file: "a.ts", text: bound }], nameOfClass, ok, [
      { file: "a.ts", identifier: "code", from: "mapIt" },
    ]);
    expect(ok).toEqual([]);
    const moved: string[] = [];
    readPresentedNames([{ file: "a.ts", text: bound.replace("mapIt", "other") }], nameOfClass, moved, [
      { file: "a.ts", identifier: "code", from: "mapIt" },
    ]);
    expect(moved.join("")).toMatch(/exempted as coming from mapIt, but nothing in this file binds it/);

    // A shape it cannot name is reported, not skipped.
    const odd: string[] = [];
    readPresentedNames([{ file: "a.ts", text: `toFailureEnvelope(buildIt(x), { optIn });` }], nameOfClass, odd);
    expect(odd.join("")).toMatch(/a shape this parser cannot name/);
  });

  it("reads the lease codes from the function, not from the table beside it", () => {
    // Gate 2's third round on #672: the rewrite claimed to read producers and then read
    // `LEASE_REASON_TO_TYPED_CODE` — a table `mapLeaseValidationToTypedReason` never consults. Two
    // of its names were pinned as produced and nothing produced them.
    const problems: string[] = [];
    expect(
      readReturnedCodes(
        `function mapLeaseValidationToTypedReason(
  reason: string,
): { code: string; tryNext: TryNextAction[] } {
  if (reason === "expired") {
    return { code: "LeaseExpired", tryNext: [] };
  }
  return { code: "Unknown", tryNext: [] };
}`,
        "mapLeaseValidationToTypedReason",
        problems,
      ),
    ).toEqual(["LeaseExpired", "Unknown"]);
    // **The signature carries an object RETURN TYPE.** A brace-balancing scan reads
    // `{ code: string; … }` as the body and reports "returns no literal code" about a function full
    // of them, so the body runs to a `}` in the first column and the code is read inside a
    // `return {…}` only.
    expect(problems).toEqual([]);

    const dynamic: string[] = [];
    readReturnedCodes(`function f(): X {\n  return { code: computeIt(reason), tryNext: [] };\n}`, "f", dynamic);
    expect(dynamic.join("")).toMatch(/f returns a code this parser cannot name: computeIt\(reason\)/);

    // The table survives as a COVERAGE check — the role SUGGESTS was correctly demoted to.
    const lease: string[] = [];
    expect(
      readLeaseCodes(`export const LEASE_REASON_TO_TYPED_CODE = {\n  expired: "LeaseExpired",\n} as const;`, lease),
    ).toEqual(["LeaseExpired"]);
    readLeaseCodes(`const SOMETHING = {};`, lease);
    expect(lease.join("")).toMatch(/LEASE_REASON_TO_TYPED_CODE could not be read/);
  });

  // ── Restored ────────────────────────────────────────────────────────────────
  //
  // **These six were deleted by the commit that changed the producer model, and none of them
  // covers code that commit removed.** Gate 2 on #673 re-broke five and watched them survive:
  // seeding `HandlerError`'s name, the fixed 900-character window, the bare-name class key, the
  // double-quote-only `this.name` match, and the regex-literal desync. Each was bought with a
  // defect found by codex or an earlier round, and each comment explaining the defect outlived the
  // check that enforced it.
  //
  // The lesson is about how the edit was made, not about the code: replacing a block wholesale
  // swallows the cells inside it, and the swallowed ones are invisible in a green run.

  it("reads HandlerError's own name from the tree instead of seeding it", () => {
    // It was a string constant in the extractor, so renaming `this.name = "HandlerError"` — which
    // changes the value on the wire for EVERY un-typed throw — left the gate green while its own
    // summary went on naming `handler_error`.
    const problems: string[] = [];
    expect(
      readEnvelopeErrorNames(
        [
          {
            file: "a.ts",
            text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerFailure"; } }
                   class Child extends HandlerError { constructor() { super(); this.name = "Child"; } }`,
          },
        ],
        problems,
      ).names,
    ).toEqual(["Child", "HandlerFailure"]);
    expect(problems).toEqual([]);

    const gone: string[] = [];
    readEnvelopeErrorNames([{ file: "a.ts", text: `class Other extends Error {}` }], gone);
    expect(gone.join("")).toMatch(/HandlerError's own name could not be read/);
  });

  it("stops at the class's own brace, in both directions", () => {
    // A fixed 900-character window did two things: a constructor longer than it left its class
    // NAMELESS with `problems` empty, and a class with no `this.name` took the literal of the NEXT
    // class — including one explicitly outside the family, which is a reason nothing can produce.
    const long = "    const filler = 1;\n".repeat(90);
    expect(
      readEnvelopeErrorNames([
        { file: "a.ts", text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
class LongOne extends HandlerError {
  constructor() {
    super();
${long}    this.name = "LongConstructorFailure";
  }
}` },
      ]).names,
    ).toContain("LongConstructorFailure");

    expect(
      readEnvelopeErrorNames([
        { file: "a.ts", text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
class InheritsItsParentsName extends HandlerError {}
class NotInTheFamily extends Error {
  constructor() { super(); this.name = "GhostReason"; }
}` },
      ]).names,
    ).toEqual(["HandlerError"]);
  });

  it("keys a class by its file, because two files declare the same name", () => {
    // `AimOccludedError` is declared in `src/engine/aim.ts` (extends `Error`) and in
    // `src/errors/typed-errors.ts` (extends `HandlerError`). With a bare-name key, last writer wins
    // and the axis was correct only because of the order `readdirSync` returned — move one file and
    // two real reasons become "the code no longer produces".
    const both = [
      { file: "src/engine/aim.ts", text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
class Dup extends Error { constructor() { super(); this.name = "DupPlainError"; } }` },
      { file: "src/errors/typed-errors.ts", text: `class Dup extends HandlerError { constructor() { super(); this.name = "DupTyped"; } }` },
    ];
    expect(readEnvelopeErrorNames(both).names).toEqual(["DupTyped", "HandlerError"]);
    expect(readEnvelopeErrorNames([...both].reverse()).names).toEqual(["DupTyped", "HandlerError"]);
  });

  it("reads a name in either quote spelling, because nothing forces one", () => {
    // `this.name = 'NewFailure'` was read as neither a literal nor a dynamic value: the class
    // contributed nothing and raised nothing while the runtime exposed the name (codex, #672).
    // There is no lint rule in this repository forcing double quotes.
    expect(
      readEnvelopeErrorNames([
        {
          file: "a.ts",
          text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
class Single extends HandlerError { constructor() { super(); this.name = 'NewFailure'; } }`,
        },
      ]).names,
    ).toEqual(["HandlerError", "NewFailure"]);
  });

  it("reports a computed advice key instead of dropping it", () => {
    // `[HANDLER_ERROR]: ["retry"]` entered the bracket-depth branch and vanished, and the comment
    // beside the scanner claimed the shape was handled — so adding computed advice for a name that
    // has none today would change what the caller is told while `withoutAdvice` stayed put and the
    // gate stayed green (codex, #672). A comment is a claim, not a check.
    const problems: string[] = [];
    const keys = readSuggestsKeys(
      `const SUGGESTS: Record<string, string[]> = {\n  [HANDLER_ERROR]: ["retry"],\n  Ordinary: ["a"],\n};`,
      problems,
    );
    expect(keys).toEqual(["Ordinary"]);
    expect(problems.join("")).toMatch(/computed key this parser cannot name — the advice coverage is a lower bound/);
  });

  it("does not desync on a regex literal that contains quotes", () => {
    // Once the walk covered all of `src/`, two files desynced the stripper: a regex literal with an
    // odd number of `"` opened a string state that never closed, so every comment below it stopped
    // being stripped and a commented-out error class entered the axis. And the fix has an order to
    // it — tried BEFORE the comment checks, `// foo` parses as an empty regex and 94 advice keys
    // became 20.
    const src = `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
const re = /^Exception calling "GetCurrentPattern" with "\\d+" argument\\(s\\): ".*/;
// class CommentOnly extends HandlerError { constructor() { super(); this.name = "CommentGhost"; } }`;
    expect(readEnvelopeErrorNames([{ file: "a.ts", text: src }]).names).toEqual(["HandlerError"]);
    expect(readSuggestsKeys(`const SUGGESTS: Record<string, string[]> = {
  First: ["a"], // a trailing comment after a brace
  Second: ["b"],
};`)).toEqual(["First", "Second"]);
  });

  it("reads the producer, which is buildFailureEnvelope, not the function that calls it", () => {
    // **The fifth proxy in a row.** `most_likely_cause` is written by `buildFailureEnvelope(name, …)`,
    // which is EXPORTED — `toFailureEnvelope` is one of its callers, and the tree's own docs call the
    // direct call a pattern that existed and was migrated away from. Gate 2 on #673 added a direct
    // call with a fresh literal: it type-checked and the gate printed OK.
    const nameOfClass = new Map([["HandlerError", "HandlerError"]]);
    const problems: string[] = [];
    expect(
      readPresentedNames(
        [{ file: "a.ts", text: `export function brandNew() {\n  return buildFailureEnvelope("BrandNewCause", []);\n}` }],
        nameOfClass,
        problems,
      ),
    ).toEqual(["BrandNewCause"]);
    expect(problems).toEqual([]);

    // A name it cannot enumerate there is reported, and the function's own declaration is not a
    // call site — the road axis learned that about `probeRoute(route: string, …)`.
    const dynamic: string[] = [];
    readPresentedNames([{ file: "a.ts", text: `buildFailureEnvelope(computeIt(x), []);` }], nameOfClass, dynamic);
    expect(dynamic.join("")).toMatch(/buildFailureEnvelope is given `computeIt\(x`/);
    const decl: string[] = [];
    readPresentedNames(
      [{ file: "a.ts", text: `export function buildFailureEnvelope(\n  mostLikelyCause: string,\n) {}` }],
      nameOfClass,
      decl,
    );
    expect(decl).toEqual([]);
  });

  it("takes the two-argument coded form, which is documented and supported", () => {
    // Requiring `)` right after the string made a name-preserving edit go red with two lines
    // claiming the code "no longer produces" a name it produces unchanged — and `--update` refuses
    // while problems exist, so that edit hard-blocked the gate (gate 2, #673).
    const nameOfClass = new Map([["HandlerError", "HandlerError"]]);
    expect(
      readPresentedNames(
        [{ file: "a.ts", text: `toFailureEnvelope(Err(new CodedHandlerError("Foo", "a message")), { optIn });` }],
        nameOfClass,
      ),
    ).toEqual(["Foo"]);
  });

  it("reports two files that declare a class with different names, instead of picking one", () => {
    // `nameOf` is keyed `file:class` precisely because `AimOccludedError` is declared twice with
    // different `this.name` values, and both are presented. Collapsing to a bare name is
    // last-writer-wins over walk order — correct today only because `engine/` sorts first.
    const both = [
      { file: "src/engine/aim.ts", text: `class HandlerError extends Error { constructor() { super(); this.name = "HandlerError"; } }
class Dup extends HandlerError { constructor() { super(); this.name = "DupLong"; } }` },
      { file: "src/errors/typed-errors.ts", text: `class Dup extends HandlerError { constructor() { super(); this.name = "Dup"; } }` },
    ];
    expect(readEnvelopeErrorNames(both).collisions).toEqual(["Dup: Dup / DupLong"]);
    expect(readEnvelopeErrorNames([...both].reverse()).collisions).toEqual(["Dup: Dup / DupLong"]);
  });

  it("does not let a brace inside an advice string close the table early", () => {
    // The advice text is dense with braces — `"Run {tool:list_window_titles}"`, `"until:{mode}"` —
    // and today every one is balanced, so a counter that cannot see strings happens to work. An
    // unbalanced `}` would close the table early and return a SHORT key set with `problems` empty,
    // and `--update` would then write that short set into the grid. Gate 2 on #672 ran it end to
    // end: the first check was loud, the re-pin laundered it, and the next key was invisible.
    const problems: string[] = [];
    expect(
      readSuggestsKeys(
        `const SUGGESTS: Record<string, string[]> = {
  First: ["close it with } or press Escape"],
  Second: ["after the stray brace"],
};`,
        problems,
      ),
    ).toEqual(["First", "Second"]);
    expect(problems).toEqual([]);
  });

  it("reads a key by the grammar, not by its indent and one quote spelling", () => {
    // Seven shapes were probed on #672 and four were silent: a single-quoted key, a computed
    // `[CODE]:` key, a key on the header line, and a four-space reformat. Meanwhile an advice
    // STRING containing a colon at the right indent was added as a fake key. Depth is the grammar;
    // an indent is a spelling, and enumerating spellings does not end.
    const problems: string[] = [];
    const keys = readSuggestsKeys(
      `const SUGGESTS: Record<string, string[]> = { OnHeaderLine: ["a"],
    FourSpaces: ["b"],
  'SingleQuoted': ["c"],
  "DoubleQuoted": ["d"],
  WithFakeKeyInside: ["NotAKey: advice text", \`a template
    spanning lines\`],
};`,
      problems,
    );
    expect(keys).toEqual(["DoubleQuoted", "FourSpaces", "OnHeaderLine", "SingleQuoted", "WithFakeKeyInside"]);
    expect(problems).toEqual([]);
  });

  it("says the table is unreadable, and says it is EMPTY, as two different things", () => {
    // Both arms were unkillable on #672: the only "unreadable" cell used a source with no table at
    // all, which returns two lines earlier at `body === null`.
    const gone: string[] = [];
    expect(readSuggestsKeys(`const SOMETHING_ELSE = {};`, gone)).toEqual([]);
    expect(gone.join("")).toMatch(/SUGGESTS could not be read/);

    const reshaped: string[] = [];
    expect(readSuggestsKeys(`const SUGGESTS: Record<string, string[]> = {
  ...spreadFromSomewhere,
};`, reshaped)).toEqual([]);
    expect(reshaped.join("")).toMatch(/SUGGESTS has no keys at depth 1/);

    // And an unbalanced `{` runs off the end rather than returning a truncated body.
    const unbalanced: string[] = [];
    expect(readSuggestsKeys(`const SUGGESTS: Record<string, string[]> = {
  First: ["a"],
`, unbalanced)).toEqual([]);
    expect(unbalanced.join("")).toMatch(/SUGGESTS could not be read/);
  });

  it("takes the leading name from a catalogue entry and drops its qualifier", () => {
    // `"  executor_failed on terminal textbox (action=type) → …"` catalogues `executor_failed`, not
    // a reason nobody produces. The first version's character class excluded `(`, so it skipped the
    // line entirely; widening it without this rule invented a name instead.
    expect(
      readReasonCatalogue(`"  executor_failed on terminal textbox (action=type) → use V1 terminal instead."`),
    ).toEqual(["executor_failed"]);
    // An empty segment in an `a / / b` list contributes nothing.
    expect(readReasonCatalogue(`"  a_reason / / b_reason → do a thing"`)).toEqual(["a_reason", "b_reason"]);
  });

  it("runs over the real tree, and the numbers in the sentence are the ones the grid pins", () => {
    // **Runs the extraction, and asserts the sentence.** On #672 the OK line's numbers were pinned
    // nowhere: the count could be printed as `999` and all fifteen cells passed. The headline of a
    // gate is the part a reader quotes, so it is the part that has to be checked.
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "check-result-vocabulary.mjs")], {
      encoding: "utf8",
    });
    expect(out).toMatch(/^\[check-result-vocabulary\] OK/m);
    const pinned = JSON.parse(readFileSync(join(REPO, "tests/fixtures/adr-036-result-vocabulary.json"), "utf8"));
    const receivable = new Set([...pinned.typed, ...pinned.computedOnly]);
    // **Both surfaces, named.** win2 measured that one result reaches callers in two spellings —
    // `reason: "working_memory_nupper_bound_exceeded"` only when `"raw"` is asked for, and
    // `most_likely_cause: "WorkingMemoryNUpperBoundExceeded"` otherwise, in an envelope with NO
    // `reason` field. A grid keyed on one never contains the other.
    expect(out).toContain(`can produce ${receivable.size} reasons on the raw surface`);
    expect(out).toContain(`${pinned.producedNames.length} names on the envelope surface`);
    expect(out).toContain("which carries no reason field at all");
    expect(out).toContain(`${pinned.typed.length} typed (TouchFailReason)`);
    expect(out).toContain(`plus ${pinned.computedOnly.length} more COMPUTED`);
    expect(out).toContain(`${pinned.withoutAdvice.length} produced names have no SUGGESTS entry`);
    expect(out).toContain(`The two catalogues differ by ${pinned.cataloguesDifferBy.length}`);
    expect(out).toContain("LOWER BOUND, not a total");

    // The one the wrapper adds that no type and no catalogue carries. `handler_error` is NOT here:
    // `toResultErr` appears at no `toFailureEnvelope(` call site, so the name never arrives.
    expect(pinned.computedOnly).toContain("unknown");
    expect(pinned.computedOnly).not.toContain("handler_error");
    expect(pinned.fallbackReason).toBe("unknown");
    // The producer whose values this extraction does not enumerate, which is why it is a bound.
    expect(pinned.unresolvable).toEqual(["ToolFailureError:code"]);
    // **Three keys carry `err.name` to a caller, and this file counts one of them** (win2 measured
    // it on the machine, 2026-09-17, internal `4ef46b4`):
    //
    //   reason             snake_case    toFailureEnvelope's raw projection   ← counted here
    //   most_likely_cause  PascalCase    toFailureEnvelope's envelope         ← counted here
    //   code               PascalCase    toToolFailure (`const code = err.name`)
    //
    // The engine's path DOES get an envelope — it just carries `data: {ok:false, code:…}` with no
    // `if_unexpected`, where the `toFailureEnvelope` path carries `data: null`. So "it never reaches
    // an envelope" was the wrong rule for a right conclusion, and `code` is a separate axis that
    // shares this one's spellings: matching the two by name would collapse them into one.
    //
    // **Reachability is derived, not pinned by hand.** `handler_error` used to be carried as
    // "produced but with no production caller". Reading the presenter's own call sites answers it
    // structurally — `toResultErr` never appears at one — and two more names leave with it:
    // `RegionOutsideCapturableBoundsError` and `CaptureBackendFailedError` extend `HandlerError`
    // and are thrown by the capture engine, but no `toFailureEnvelope(` site receives them, so they
    // reach a caller through the flat `failWith` surface instead (codex, #672, P1).
    for (const gone of ["HandlerError", "CaptureBackendFailed", "RegionOutsideCapturableBounds"]) {
      expect(pinned.producedNames, gone).not.toContain(gone);
    }
    expect(out).toContain("read at the presenter's own call sites");
    // **The catalogues agree now** (internal #121, 2026-09-21). This read
    // `toEqual(["aim_blocked_by_excluded_window"])` until that day — the server instructions
    // omitted a recovery the tool description offered, pinned as a known difference because a gate
    // red on landing is a gate somebody turns off. The row was written for the server surface and
    // `unknown` was added to both, so the set is empty and the gate FAILS on any difference now.
    expect(pinned.cataloguesDifferBy).toEqual([]);
    for (const name of ["aim_blocked_by_excluded_window", "unknown"]) {
      expect(pinned.toolCatalogue, name).toContain(name);
      expect(pinned.serverCatalogue, name).toContain(name);
    }
    // **The vocabulary is what agrees; the WORDING is not, and must not be read as drift.** Of the
    // rows both surfaces carry, one is byte-identical and twelve differ — the tool description says
    // "V1" beside the v2 surface, the server instructions do not, and the tool description's length
    // is a cost decision with a measurement beside it. A later round that "tidies" them into one
    // text would give every session the long form back.
    expect(pinned.serverCatalogue.slice().sort()).toEqual(pinned.toolCatalogue.slice().sort());
    // Five produced names have no advice entry, so the caller gets the generic line.
    // **Three, not five.** `LeaseGenerationMismatch` and `LeaseDigestMismatch` were pinned here
    // and nothing produced either: they live in the reservation table, and the mapping that
    // actually returns codes never reads it (gate 2 on #672, third round).
    // **Two, not three.** `HandlerError` went with the presenter read: `toResultErr` appears at no
    // `toFailureEnvelope(` call site, so the name never arrives and there is nothing to advise on.
    // **One, not two — 2026-09-21, internal #121, and this one moved because it was FIXED rather
    // than re-counted.** Every correction above narrowed what the extraction had wrongly believed
    // was produced; this one is the product changing. `Unknown` left the list when the
    // handler-throw fallback stopped shipping `try_next: []`, which makes the remaining member the
    // interesting one: `LeaseExpired` has no dictionary entry because its advice is built at the
    // callsite as a rich `{action, args, confidence}` row (site 5a), so "no SUGGESTS entry" and "no
    // advice" are not the same sentence for it. This list is now one name long and neither of the
    // two readings applies to it in the same way — worth saying before someone reads the count as
    // "one road still leaves the caller stranded".
    expect(pinned.withoutAdvice).toEqual(["LeaseExpired"]);
    // **2026-09-18, internal#125 — the sentence above is kept and this is the correction.** Both
    // reserved names are produced now: `mapLeaseValidationToTypedReason` grew the two branches and
    // READS `LEASE_REASON_TO_TYPED_CODE` for them, so the reservation is a checked thing. The two
    // assertions that follow were the opposite of these until this change, and flipping them IS the
    // declaration that the vocabulary moved on purpose rather than drifting.
    //
    // Why it was worth doing: measured on the real machine, a thrown handler, a lease
    // `digest_mismatch` and a lease `generation_mismatch` reached the caller as ONE byte string
    // (`Unknown`, no advice, nothing to tell them apart — internal `6bdcdce` / `4f1a8a4`).
    expect(pinned.reservedLeaseNames).toContain("LeaseDigestMismatch");
    expect(pinned.producedNames).toContain("LeaseDigestMismatch");
    expect(pinned.producedNames).toContain("LeaseGenerationMismatch");
    // **The reverse direction, which nothing asserted before** (mac's review of the #125 plan): a
    // reserved name with no producer is exactly the shape the reservation was found in, and until
    // now the axis only checked "produced with no reservation". Both directions are closed here.
    for (const reserved of pinned.reservedLeaseNames) {
      expect(pinned.producedNames, `${reserved} is reserved and nothing produces it`).toContain(reserved);
    }
  });
});

describe("the check's exit code", () => {
  let root = "";

  const write = (rel: string, body: string) => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };

  const run = (): { status: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [join(root, "scripts", "check-result-vocabulary.mjs")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { status: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  /** The smallest tree the check accepts: a producer family, an advice table, both catalogues. */
  const fixture = (over: Record<string, string> = {}) => {
    const files: Record<string, string> = {
      "src/engine/world-graph/guarded-touch.ts": `export type TouchFailReason =\n  | "executor_failed"\n  | "modal_blocking";`,
      // The producers. `NotInFamily` extends plain Error, so it collapses into `HandlerError` at
      // `toResultErr` rather than adding a reason of its own — that collapse is the axis's shape.
      "src/errors/typed-errors.ts": `export class HandlerError extends Error {
  constructor(m) { super(m); this.name = "HandlerError"; }
}
export class ExecutorFailed extends HandlerError {
  constructor(m) { super(m); this.name = "ExecutorFailed"; }
}
export class NotInFamily extends Error {
  constructor(m) { super(m); this.name = "NotInFamily"; }
}`,
      // `Unknown` carries advice since internal #121, and the baseline tree has to say so or every
      // cell built on this fixture reports the fallback as advice-less — the gate's invariant now
      // runs the other way.
      "src/tools/_errors.ts": `const SUGGESTS: Record<string, string[]> = {\n  ExecutorFailed: ["fall back"],\n  ModalBlocking: ["dismiss"],\n  Unknown: ["observe before acting"],\n};`,
      "src/tools/_envelope.ts": `export const LEASE_REASON_TO_TYPED_CODE = {
  expired: "LeaseExpired",
} as const;
function mapLeaseValidationToTypedReason(
  reason: string,
): { code: string; tryNext: TryNextAction[] } {
  if (reason === "expired") {
    return { code: "LeaseExpired", tryNext: [] };
  }
  return { code: "Unknown", tryNext: [] };
}
const ifUnexp = envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };
function pascalToSnake(s: string): string {
  ${PINNED_PASCAL_TO_SNAKE}
}`,
      "src/server-windows.ts": `const instructions = [\n  "  executor_failed → fall back to click_element;",\n  "  modal_blocking → dismiss the blocker;",\n];`,
      "src/tools/desktop-register.ts": `const description = [\n  "  executor_failed → fall back to click_element;",\n  "  modal_blocking → dismiss the blocker;",\n];`,
    };
    for (const [path, body] of Object.entries({ ...files, ...over })) write(path, body);
  };

  const pin = () => {
    execFileSync(process.execPath, [join(root, "scripts", "check-result-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "result-vocabulary-"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
    cpSync(join(REPO, "scripts", "check-result-vocabulary.mjs"), join(root, "scripts", "check-result-vocabulary.mjs"));
    // **The whole `scripts/lib`, not a list of the files it needs today.** Each of these fixtures
    // used to name its imports one by one, and the list was a hand-written copy of the import
    // graph: the moment `result-vocabulary.mjs` imported `code-vocabulary.mjs` (round 3 of
    // internal#125, to stop keeping a second scanner), two fixtures could not start the gate at
    // all. The failure is loud, but a list that has to be edited by hand is wrong from the commit
    // that outgrows it until someone notices. Copying the directory removes the list.
    cpSync(join(REPO, "scripts", "lib"), join(root, "scripts", "lib"), { recursive: true });
    // **The gate needs the compiler now.** `scripts/lib/typescript-source.mjs` imports
    // `typescript`, and node resolves that by walking up from the script — which, in a temp
    // directory, walks past nothing. CI has it because `npm ci` runs before these gates; this
    // harness has to provide what CI provides, or it tests a tree the gate cannot run in.
    // `"junction"`, not `"dir"`: on Windows a symlink needs Developer Mode or elevation and this
    // threw EPERM on win2's machine, skipping every cell in the file; a junction needs neither.
    // The type is ignored off Windows, so there is no branch. (win2 measured all three there: both
    // symlink forms EPERM, junction created and resolving `typescript`.)
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "junction");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("is 0 when the pinned axis matches the code", () => {
    fixture();
    pin();
    expect(run().status).toBe(0);
  });

  it("is 1 when a new class is HANDED TO the presenter, and silent when it is only thrown", () => {
    // **Joining the family is not enough, and that was the P1.** Two classes extend `HandlerError`
    // and are thrown by the capture engine, but no `toFailureEnvelope(` site receives them — they
    // reach a caller through the flat `failWith` surface — and the axis counted them anyway.
    fixture();
    pin();
    const family = `export class HandlerError extends Error {
  constructor(m) { super(m); this.name = "HandlerError"; }
}
export class ExecutorFailed extends HandlerError {
  constructor(m) { super(m); this.name = "ExecutorFailed"; }
}
export class BrandNewFailure extends HandlerError {
  constructor(m) { super(m); this.name = "BrandNewFailure"; }
}`;
    // Thrown only: the axis does not move.
    write("src/errors/typed-errors.ts", `${family}\nthrow new BrandNewFailure("never presented");`);
    expect(run().status).toBe(0);

    // Handed to the presenter: it does.
    write(
      "src/errors/typed-errors.ts",
      `${family}\ntoFailureEnvelope(Err(new BrandNewFailure("presented")), { optIn });`,
    );
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/producedNames: the code now produces "BrandNewFailure"/);
    expect(out).toMatch(/computedOnly: the code now produces "brand_new_failure"/);
  });

  it("is 1 when the lease MAPPING gains a branch, and says the truth when only the table moves", () => {
    // Gate 2 added the fifth lease code twice on this PR. The first time it was added to the table
    // and the gate went green; the second time the rewrite read the table and the gate went red for
    // a change that produces nothing. Only the function produces.
    fixture();
    pin();
    const mapping = (extra: string) => `export const LEASE_REASON_TO_TYPED_CODE = {
  expired: "LeaseExpired",
} as const;
function mapLeaseValidationToTypedReason(
  reason: string,
): { code: string; tryNext: TryNextAction[] } {
  if (reason === "expired") {
    return { code: "LeaseExpired", tryNext: [] };
  }
${extra}  return { code: "Unknown", tryNext: [] };
}
const ifUnexp = envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };
function pascalToSnake(s: string): string {
  ${PINNED_PASCAL_TO_SNAKE}
}`;
    write("src/tools/_envelope.ts", mapping(`  if (reason === "superseded") {\n    return { code: "LeaseSuperseded", tryNext: [] };\n  }\n`));
    const added = run();
    expect(added.status).toBe(1);
    expect(added.out).toMatch(/computedOnly: the code now produces "lease_superseded"/);
    // …and it is a code the reservation table does not carry, which the reservation exists for.
    expect(added.out).toMatch(/the lease mapping returns "LeaseSuperseded", which LEASE_REASON_TO_TYPED_CODE does not reserve/);

    // A row in the table alone changes the RESERVATION, and the message says so — it does not claim
    // the code now produces a reason.
    write(
      "src/tools/_envelope.ts",
      mapping("").replace('  expired: "LeaseExpired",', '  expired: "LeaseExpired",\n  superseded: "LeaseSuperseded",'),
    );
    const reserved = run();
    expect(reserved.status).toBe(1);
    expect(reserved.out).toMatch(/reservedLeaseNames: the code now produces "LeaseSuperseded"/);
    expect(reserved.out).not.toMatch(/computedOnly: the code now produces "lease_superseded"/);
  });

  it("stops on an unreadable TouchFailReason too, not only on a changed conversion", () => {
    // The early exit's other arm. It was unkillable on #672: with the typed union unreadable the
    // banner printed with ZERO problems under it, which tells the reader nothing at all.
    fixture();
    pin();
    write("src/engine/world-graph/guarded-touch.ts", `export type SomethingElse = "a";`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/cannot derive the axis/);
    expect(out).toMatch(/TouchFailReason could not be read — the typed half of the axis is unknown, not empty/);
  });

  it("names the broken derivation alone, instead of its 82 shadows", () => {
    // **A changed conversion empties the computed set**, and comparing an empty set against the pin
    // produced 96 problems on the real tree where exactly one was true and the rest were its
    // shadow. A reader fixes the loudest thing, so the loudest thing has to be the true one.
    fixture();
    pin();
    write(
      "src/tools/_envelope.ts",
      `const ifUnexp = envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };
function pascalToSnake(s: string): string {
  return s.replace(/(?!^)(?=[A-Z])/g, "_").toLowerCase();
}`,
    );
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/cannot derive the axis/);
    expect(out).toMatch(/pascalToSnake has changed/);
    expect(out).toMatch(/nothing below was compared/);
    // **No shadows.** On the real tree the first version printed 96 problems where one was true and
    // 82 were the empty computed set being compared against the pin. What is checked is the absence
    // of that class of line, not a count — a count moves for reasons unrelated to the property.
    expect(out).not.toMatch(/which the code no longer produces/);
    expect(out).not.toMatch(/which the grid does not count/);
  });

  it("is 1 when a catalogue promises a reason nothing produces", () => {
    fixture();
    pin();
    write("src/server-windows.ts", `const instructions = [\n  "  executor_failed → fall back;",\n  "  modal_blocking → dismiss;",\n  "  never_produced → do a thing;",\n];`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/a catalogue tells the caller to expect "never_produced", which nothing produces/);
  });

  it("is 1 when a typed reason is in no catalogue", () => {
    // The eighteen are the ones a caller is most likely to meet. An uncatalogued one is a recovery
    // path nobody was told about.
    fixture();
    pin();
    write("src/engine/world-graph/guarded-touch.ts", `export type TouchFailReason =\n  | "executor_failed"\n  | "modal_blocking"\n  | "silently_added";`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/silently_added is a TouchFailReason no catalogue mentions/);
  });

  it("is 1 when one catalogue names a reason the other omits", () => {
    // **Promoted from a pin to a failure on 2026-09-21** (internal #121), which could only be done
    // on the day the difference reached zero. Before that, the set held one name and a hard failure
    // would have landed red — #670's reason for pinning instead.
    fixture();
    pin();
    write("src/server-windows.ts", `const instructions = [\n  "  executor_failed → fall back;",\n];`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/the two catalogues no longer name the same reasons/);
  });

  it("is 1 when the two catalogues stop differing in the way they differ today", () => {
    // Pinned as a KNOWN difference rather than failed on — a gate that is red the day it lands is a
    // gate somebody turns off (#670). What is checked is that the difference does not MOVE.
    fixture();
    pin();
    write("src/tools/desktop-register.ts", `const description = [\n  "  executor_failed → fall back;",\n];`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/cataloguesDifferBy: the code now produces "modal_blocking"/);
  });

  it("is 1 when the fallback stops carrying advice", () => {
    // **TURNED AROUND on 2026-09-21 with the invariant it guards (internal #121).** It used to
    // inject `Unknown: ["something"]` and expect the gate to notice the fallback had GAINED a key,
    // because the pinned fact was that it had none. The product now says the opposite on purpose,
    // so the mutation that matters is the one that takes the advice away again — a one-line edit,
    // and the road it silences is the only one a caller cannot interpret.
    fixture();
    pin();
    write("src/tools/_errors.ts", `const SUGGESTS: Record<string, string[]> = {\n  ExecutorFailed: ["fall back"],\n  SomeOtherFailure: ["try again"],\n};`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/fallback "Unknown" is no longer a SUGGESTS key/);
  });

  it("refuses to re-pin while the extraction cannot read the tree", () => {
    // Re-pinning over an unreadable tree writes the short set into the grid, and the grid is then
    // the thing everyone trusts.
    fixture();
    pin();
    const path = join(root, "tests/fixtures/adr-036-result-vocabulary.json");
    const before = readFileSync(path, "utf8");
    write("src/tools/_errors.ts", `const NOT_SUGGESTS = {};`);
    let status = 0;
    try {
      execFileSync(process.execPath, [join(root, "scripts", "check-result-vocabulary.mjs"), "--update"], {
        stdio: "ignore",
      });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
