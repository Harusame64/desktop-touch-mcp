/**
 * ADR-036 — the RESULT axis of the completion grid, and the reasons that are not written anywhere.
 *
 * The road axis got its extractor in #669, the configuration axis in #670. This is the third and
 * last denominator, and it repeats the lesson both of those cost: **the value is not written, it is
 * produced.**
 *
 * The loop's failure arm is typed — `reason: TouchFailReason`, eighteen values, compile-checked.
 * The wrapper ABOVE it returns `reason: string` and does not write it:
 *
 *     reason: pascalToSnake(ifUnexp.most_likely_cause)
 *
 * `most_likely_cause` is a PascalCase code from `SUGGESTS`, a 94-key `Record<string, string[]>`
 * with no union, defaulting to `"Unknown"`. So a caller can receive **101** distinct reasons, of
 * which 18 are enumerated anywhere and 83 are in neither catalogue. Grepping for `reason: "…"`
 * finds the literals and misses all of it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PINNED_PASCAL_TO_SNAKE,
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

  it("runs over the real tree, and the numbers are the ones the grid pins", () => {
    // **Runs the extraction.** The sibling axis shipped a cell named for reading the real tree whose
    // body read the checked-in JSON — it could not fail for any change to the extractor, and gate 2
    // proved it by blinding the extractor and watching the cell stay green (#670).
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "check-result-vocabulary.mjs")], {
      encoding: "utf8",
    });
    expect(out).toMatch(/^\[check-result-vocabulary\] OK/m);
    // Named, not counted: these are the claims the axis rests on.
    expect(out).toMatch(/18 typed \(TouchFailReason\)/);
    expect(out).toMatch(/COMPUTED by the wrapper/);
    const pinned = JSON.parse(readFileSync(join(REPO, "tests/fixtures/adr-036-result-vocabulary.json"), "utf8"));
    // The fifth of the axis that has a type, and the four fifths that do not.
    expect(pinned.typed).toHaveLength(18);
    expect(pinned.computedOnly.length).toBeGreaterThan(80);
    expect(pinned.fallbackReason).toBe("unknown");
    // The two catalogues disagree by exactly one name, and the tool description is the longer one.
    expect(pinned.cataloguesDifferBy).toEqual(["aim_blocked_by_excluded_window"]);
    expect(pinned.toolCatalogue).toContain("aim_blocked_by_excluded_window");
    expect(pinned.serverCatalogue).not.toContain("aim_blocked_by_excluded_window");
    // Six typed reasons have no machine-readable advice — prose is all they carry.
    expect(pinned.withoutSuggests).toEqual([
      "entity_outside_viewport",
      "lease_digest_mismatch",
      "lease_expired",
      "lease_generation_mismatch",
      "modal_blocking",
      "origin_window_not_visible",
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

  /** The smallest tree the check accepts: one typed reason, one advice key, both catalogues. */
  const fixture = (over: Record<string, string> = {}) => {
    const files: Record<string, string> = {
      "src/engine/world-graph/guarded-touch.ts": `export type TouchFailReason =\n  | "executor_failed"\n  | "modal_blocking";`,
      "src/tools/_errors.ts": `const SUGGESTS: Record<string, string[]> = {\n  ExecutorFailed: ["fall back"],\n  SomeOtherFailure: ["try again"],\n};`,
      "src/tools/_envelope.ts": `const ifUnexp = envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };
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

  it("is 1 when an advice key is added, because a caller can now receive one more reason", () => {
    // This is the half with no type. A new key is a new value on the wire, and nothing in the
    // compiler, the catalogues or the tests would otherwise say so.
    fixture();
    pin();
    write("src/tools/_errors.ts", `const SUGGESTS: Record<string, string[]> = {\n  ExecutorFailed: ["fall back"],\n  SomeOtherFailure: ["try again"],\n  BrandNewFailure: ["do something"],\n};`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/computedOnly: the code now produces "brand_new_failure"/);
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
    expect(out.match(/^\s+- /gm) ?? []).toHaveLength(1);
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
