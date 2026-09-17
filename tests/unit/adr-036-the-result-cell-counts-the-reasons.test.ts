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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PINNED_PASCAL_TO_SNAKE,
  readCodedNames,
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
    expect(names).toEqual(["Deeper", "ExecutorFailed", "HandlerError"]);
    expect(names).not.toContain("NotInFamily");
    expect(problems).toEqual([]);

    // A name this parser cannot enumerate is REPORTED, unless a human wrote the exemption down.
    const dynamic: string[] = [];
    readEnvelopeErrorNames(
      [{ file: "b.ts", text: `class Coded extends HandlerError { constructor(code) { super(); this.name = code; } }` }],
      dynamic,
    );
    expect(dynamic.join("")).toMatch(/Coded sets this.name from `code`, a value this parser cannot enumerate/);
    const exempted: string[] = [];
    readEnvelopeErrorNames(
      [{ file: "b.ts", text: `class Coded extends HandlerError { constructor(code) { super(); this.name = code; } }` }],
      exempted,
      ["Coded:code"],
    );
    expect(exempted).toEqual([]);
  });

  it("reads the coded names, and the lease codes that reach them through a variable", () => {
    const problems: string[] = [];
    expect(readCodedNames([{ file: "a.ts", text: `throw new CodedHandlerError("WorkingMemoryNUpperBoundExceeded");` }], problems)).toEqual([
      "WorkingMemoryNUpperBoundExceeded",
    ]);
    readCodedNames([{ file: "a.ts", text: `throw new CodedHandlerError(code);` }], problems);
    expect(problems.join("")).toMatch(/a coded failure takes its name from `code`/);
    const exempt: string[] = [];
    readCodedNames([{ file: "a.ts", text: `throw new CodedHandlerError(code);` }], exempt, ["a.ts:code"]);
    expect(exempt).toEqual([]);

    const lease: string[] = [];
    expect(
      readLeaseCodes(`export const LEASE_REASON_TO_TYPED_CODE = {
  expired: "LeaseExpired",
  digest_mismatch: "LeaseDigestMismatch",
} as const;`, lease),
    ).toEqual(["LeaseDigestMismatch", "LeaseExpired"]);
    expect(lease).toEqual([]);
    readLeaseCodes(`const SOMETHING = {};`, lease);
    expect(lease.join("")).toMatch(/LEASE_REASON_TO_TYPED_CODE could not be read/);
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
    expect(out).toContain(`a caller can receive ${receivable.size} reasons`);
    expect(out).toContain(`${pinned.typed.length} typed (TouchFailReason)`);
    expect(out).toContain(`plus ${pinned.computedOnly.length} more COMPUTED`);
    expect(out).toContain(`${pinned.withoutAdvice.length} produced names have no SUGGESTS entry`);
    expect(out).toContain(`The two catalogues differ by ${pinned.cataloguesDifferBy.length}`);
    expect(out).toContain("LOWER BOUND, not a total");

    // The two the wrapper adds that no type and no catalogue carries.
    expect(pinned.computedOnly).toContain("handler_error");
    expect(pinned.computedOnly).toContain("unknown");
    expect(pinned.fallbackReason).toBe("unknown");
    // The producer whose values this extraction does not enumerate, which is why it is a bound.
    expect(pinned.unresolvable).toEqual(["ToolFailureError:code"]);
    // The catalogues differ by exactly one name, and the tool description is the longer one.
    expect(pinned.cataloguesDifferBy).toEqual(["aim_blocked_by_excluded_window"]);
    expect(pinned.toolCatalogue).toContain("aim_blocked_by_excluded_window");
    expect(pinned.serverCatalogue).not.toContain("aim_blocked_by_excluded_window");
    // Five produced names have no advice entry, so the caller gets the generic line.
    expect(pinned.withoutAdvice).toEqual([
      "HandlerError",
      "LeaseDigestMismatch",
      "LeaseExpired",
      "LeaseGenerationMismatch",
      "Unknown",
    ]);
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
      "src/tools/_errors.ts": `const SUGGESTS: Record<string, string[]> = {\n  ExecutorFailed: ["fall back"],\n  ModalBlocking: ["dismiss"],\n};`,
      "src/tools/_envelope.ts": `export const LEASE_REASON_TO_TYPED_CODE = {
  expired: "LeaseExpired",
} as const;
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
    cpSync(join(REPO, "scripts", "lib", "result-vocabulary.mjs"), join(root, "scripts", "lib", "result-vocabulary.mjs"));
    cpSync(join(REPO, "scripts", "lib", "route-vocabulary.mjs"), join(root, "scripts", "lib", "route-vocabulary.mjs"));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("is 0 when the pinned axis matches the code", () => {
    fixture();
    pin();
    expect(run().status).toBe(0);
  });

  it("is 1 when a new error class joins the family, because that IS a new reason", () => {
    // **The producer, not the advice table.** The first version asserted that adding a `SUGGESTS`
    // key added a reason — it does not; the table is keyed BY the name and is downstream of it.
    // Adding a class to the `HandlerError` family is what puts a new value on the wire.
    fixture();
    pin();
    write(
      "src/errors/typed-errors.ts",
      `export class HandlerError extends Error {
  constructor(m) { super(m); this.name = "HandlerError"; }
}
export class ExecutorFailed extends HandlerError {
  constructor(m) { super(m); this.name = "ExecutorFailed"; }
}
export class BrandNewFailure extends HandlerError {
  constructor(m) { super(m); this.name = "BrandNewFailure"; }
}
export class NotInFamily extends Error {
  constructor(m) { super(m); this.name = "NotInFamily"; }
}`,
    );
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/producedNames: the code now produces "BrandNewFailure"/);
    expect(out).toMatch(/computedOnly: the code now produces "brand_new_failure"/);
    // …and it has no advice entry, which the grid records too.
    expect(out).toMatch(/withoutAdvice: the code now produces "BrandNewFailure"/);
  });

  it("is 1 when a lease code is added, which is the arm that shipped green", () => {
    // Gate 2 on #672 added the fifth lease code the file's own doc anticipates and the gate printed
    // `OK — 101 reasons`, exit 0. It reaches the wire through `new CodedHandlerError(code)`, so the
    // table is a producer and modelling the axis with `SUGGESTS` could not see it.
    fixture();
    pin();
    write(
      "src/tools/_envelope.ts",
      `export const LEASE_REASON_TO_TYPED_CODE = {
  expired: "LeaseExpired",
  superseded: "LeaseSuperseded",
} as const;
const ifUnexp = envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };
function pascalToSnake(s: string): string {
  ${PINNED_PASCAL_TO_SNAKE}
}`,
    );
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/computedOnly: the code now produces "lease_superseded"/);
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

  it("is 1 when the advice-less fallback stops being advice-less", () => {
    fixture();
    pin();
    write("src/tools/_errors.ts", `const SUGGESTS: Record<string, string[]> = {\n  ExecutorFailed: ["fall back"],\n  SomeOtherFailure: ["try again"],\n  Unknown: ["something"],\n};`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/fallback "Unknown" is now a SUGGESTS key/);
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
