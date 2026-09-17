/**
 * ADR-036 — the fourth denominator: the `code` a caller receives on a flat tool failure.
 *
 * The third axis ended by naming this one and not counting it: `code` shares a producer and a
 * spelling with `most_likely_cause`, so matching the two by name collapses two axes into one.
 *
 * These cells drive the extractor with spellings the tree does not contain, and then drive the
 * SCRIPT against a fixture tree and assert its exit code — the lesson #668 ended on: the unit suite
 * does not run in this repo's CI, so a guard that only exists as a function nothing runs is a guard
 * that is not there.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  fieldAtDepthOne,
  isTypeLiteral,
  readClassifyArms,
  readEmbeddedScriptCodes,
  readFailArgsCode,
  readFailCodeSites,
  readHandBuiltFlatFailures,
} from "../../scripts/lib/code-vocabulary.mjs";
import { stripComments } from "../../scripts/lib/route-vocabulary.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

describe("the comment stripper the four extractions share", () => {
  it("does not read a `//` that is inside a string", () => {
    // **This is why the fourth denominator exists as a file and not as a number.** The stripper was
    // line-at-a-time and not string-aware, so `"See https://github.com/…"` was truncated at the
    // `//` — and what that leaves behind is not a missing comment but an UNBALANCED QUOTE, after
    // which every brace-matching parser downstream silently reads the wrong block. The
    // non-Windows stub's hand-built failure vanished from a sweep that had listed it minutes
    // before, with `problems` empty (2026-09-18).
    const src = `const a = { url: "https://example.com/x", code: "Kept" }; // gone\n`;
    const out = stripComments(src);
    expect(out).toContain('"https://example.com/x"');
    expect(out).toContain('code: "Kept"');
    expect(out).not.toContain("gone");
  });

  it("keeps every line's index, so a reported line number is the file's", () => {
    const src = 'a;\n/* two\n   lines */\nb; // x\n`tpl\nstill tpl`;\n';
    expect(stripComments(src).split("\n").length).toBe(src.split("\n").length);
  });

  it("does not let one stray quote swallow the rest of the file", () => {
    // A `'` this scanner takes for an opener when it is not one would hide everything after it —
    // the same silent under-read, one cause further along. A single-quoted run ends at the newline
    // because TypeScript's does.
    const src = "const s = 'it\nconst code = \"StillHere\";\n";
    expect(stripComments(src)).toContain("StillHere");
  });
});

describe("the classifier's arms", () => {
  const dictionaryArm = `
function classify(message: string): { code: string; suggest: string[] } {
  const declared = /^\\s*([A-Z][A-Za-z0-9]*):/.exec(message)?.[1];
  if (declared && Object.hasOwn(SUGGESTS, declared)) {
    return { code: declared, suggest: SUGGESTS[declared] ?? [] };
  }
  if (message.includes("timeout")) return { code: "WaitTimeout", suggest: SUGGESTS.WaitTimeout };
  return { code: "ToolError", suggest: [] };
}`;

  it("reads the body, not the return-type annotation", () => {
    // `function classify(message: string): { code: string; suggest: string[] } {` — the first `{`
    // after the name belongs to the TYPE. Taking it returned an empty vocabulary with `problems`
    // empty, which is the shape of every defect these gates exist to end.
    const arms = readClassifyArms(dictionaryArm);
    expect(arms.literals).toEqual(["ToolError", "WaitTimeout"]);
  });

  it("reads the residual rather than knowing it in advance", () => {
    // `"ToolError"` is a value the tree can change. A gate that knows the answer before it looks
    // has stopped measuring the tree.
    expect(readClassifyArms(dictionaryArm).residual).toBe("ToolError");
    expect(readClassifyArms(dictionaryArm.replace('"ToolError"', '"Residual2"')).residual).toBe("Residual2");
  });

  it("reports an arm that takes a code from the message with no dictionary check", () => {
    // **The ceiling is the whole difference between this axis and the other three.** With the
    // `Object.hasOwn(SUGGESTS, …)` guard, a message cannot name a code that is in no dictionary;
    // without it the axis has no upper bound and the pinned sets are a lower bound wearing a
    // total's clothes.
    const problems: string[] = [];
    const arms = readClassifyArms(dictionaryArm.replace("declared && Object.hasOwn(SUGGESTS, declared)", "declared"), problems);
    expect(problems.join("")).toMatch(/no upper bound/);
    expect(arms.dictionaryArms.every((a: { guarded: boolean }) => a.guarded)).toBe(false);
  });

  it("says so when the cascade has no message-reading arm at all", () => {
    const problems: string[] = [];
    readClassifyArms(
      `function classify(message: string): { code: string } {\n  return { code: "ToolError" };\n}`,
      problems,
    );
    expect(problems.join("")).toMatch(/no arm that reads a code out of the message/);
  });

  it("reads the real classifier, and both of its arms are guarded", () => {
    const problems: string[] = [];
    const arms = readClassifyArms(readFileSync(join(REPO, "src/tools/_errors.ts"), "utf8"), problems);
    expect(problems).toEqual([]);
    expect(arms.literals.length).toBeGreaterThanOrEqual(60);
    expect(arms.dictionaryArms.length).toBe(2);
    expect(arms.dictionaryArms.every((a: { guarded: boolean }) => a.guarded)).toBe(true);
    expect(arms.residual).toBe("ToolError");
  });
});

describe("the codes the call sites supply", () => {
  const read = (text: string, problems: string[] = []) => readFailCodeSites([{ file: "f.ts", text }], problems);

  it("resolves a literal, a ternary of literals, and a local const", () => {
    // A ternary is a producer of TWO values — `BrowserAmbiguousTarget` and
    // `BrowserNoActionableTarget` exist nowhere else in the tree.
    expect(read(`failCode("ToolError", m);`).codes).toEqual(["ToolError"]);
    expect(read(`const code = k === "a" ? "Ambiguous" : "NoActionable";\nfailCode(code, m);`).codes).toEqual([
      "Ambiguous",
      "NoActionable",
    ]);
    expect(read(`failCode(k ? "A" : "B", m);`).codes).toEqual(["A", "B"]);
  });

  it("resolves one level of local wrapper", () => {
    // `key-locker-tool.ts` has `function fail(code: string, message: string) { return failCode(code,
    // …) }` and names the code at its own call sites. Reporting the wrapper as unreadable would
    // bury four real codes under a complaint about a helper.
    const { codes } = read(`
function fail(code: string, message: string): ToolResult {
  return failCode(code, message, { suggest: getSuggestsForCode(code) });
}
return fail("KeyLockerDisabled", "KeyLockerDisabled: not active");
return fail("KeyLockerNoSuchBinding", "KeyLockerNoSuchBinding: none");
`);
    expect(codes).toEqual(["KeyLockerDisabled", "KeyLockerNoSuchBinding"]);
  });

  it("reports a code it cannot read instead of counting one less", () => {
    const problems: string[] = [];
    read(`failCode(codeFromSomewhere, m);`, problems);
    expect(problems.join("")).toMatch(/cannot read/);
  });

  it("does not read the declaration as a call site", () => {
    const problems: string[] = [];
    const { codes } = read(`export function failCode(\n  code: string,\n  error: string,\n) {}`, problems);
    expect(codes).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("does not stop at a newline when the call is wrapped", () => {
    const problems: string[] = [];
    expect(read(`failCode(\n  "AimWindowGone",\n  message,\n);`, problems).codes).toEqual(["AimWindowGone"]);
    expect(problems).toEqual([]);
  });
});

describe("the flat failures nothing renders", () => {
  it("is keyed on the shape, not on the field name", () => {
    // `code:` is worn by at least four other axes here — the key-locker injector's snake_case
    // results, the terminal's exit-mode reject code, the console-paste reason, and macro's
    // forwarded inner code. A sweep for the spelling merges five axes on a shared word.
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `function x() { return { ok: false, code: "no_secret" }; }` },
      { file: "b.ts", text: `function y() { return { ok: false, code: "Real", error: "e" }; }` },
    ]);
    expect(found.map((f: { code: string }) => f.code)).toEqual(["Real"]);
  });

  it("does not read a type declaration as a value", () => {
    // `export interface ToolFailure { ok: false; code: string; error: string }` wears the exact
    // shape. The separator is the discriminator — a value's members are comma-separated.
    expect(isTypeLiteral("{ ok: false; code: string; error: string }")).toBe(true);
    expect(isTypeLiteral(`{ ok: false, code: "X", error: "e" }`)).toBe(false);
    const found = readHandBuiltFlatFailures([
      { file: "t.ts", text: `export interface ToolFailure {\n  ok: false;\n  code: string;\n  error: string;\n}` },
    ]);
    expect(found).toEqual([]);
  });

  it("reads the code at depth one, not the one nested under context", () => {
    expect(fieldAtDepthOne(`{ ok: false, context: { code: "inner" }, code: "outer", error: "e" }`, "code")).toBe(
      '"outer"',
    );
  });

  it("finds the non-Windows stub, whose failure never goes through a presenter", () => {
    // The shape every MCP directory sees, and the producer that made the stripper's defect visible:
    // its advice lines are written inline and never pass the resolver the other roads share.
    const found = readHandBuiltFlatFailures([
      { file: "src/server-linux-stub.ts", text: readFileSync(join(REPO, "src/server-linux-stub.ts"), "utf8") },
    ]);
    expect(found.map((f: { code: string }) => f.code)).toEqual(["UnsupportedPlatform"]);
  });
});

describe("the codes spelled in another language", () => {
  it("resolves an interpolated constant across files, and keeps its real spelling", () => {
    // `"code":"${AIM_WINDOW_GONE}"` inside a PowerShell string resolves to `aim_window_gone` —
    // snake_case, in a field named `code`. Printing `${AIM_WINDOW_GONE}` as if it were the code
    // would hide the one value that proves why these axes are counted at their producers instead of
    // matched by the name of the key they ride on.
    const codes = readEmbeddedScriptCodes([
      { file: "engine/aim.ts", text: `export const AIM_WINDOW_GONE = "aim_window_gone";` },
      { file: "engine/bridge.ts", text: 'const ps = `Write-Output \'{"ok":false,"code":"${AIM_WINDOW_GONE}"}\'`;' },
    ]);
    expect(codes.map((c: { code: string }) => c.code)).toEqual(["aim_window_gone"]);
  });
});

describe("failArgs' fixed code", () => {
  it("is read out of the body rather than assumed", () => {
    expect(readFailArgsCode(readFileSync(join(REPO, "src/tools/_errors.ts"), "utf8"))).toBe("InvalidArgs");
  });

  it("says so when the body stops building a literal", () => {
    const problems: string[] = [];
    readFailArgsCode(
      `export function failArgs(m: string, t: string): ToolResult {\n  const failure = { ok: false, code: chosen, error: m };\n  return fail(failure);\n}`,
      problems,
    );
    expect(problems.join("")).toMatch(/no longer builds a literal/);
  });
});

describe("what gate 2 found on this PR, kept as cells", () => {
  // Eight findings, each verified against the tree before it was fixed. The cells are here rather
  // than in the describe blocks above because what they pin is one round's worth of ways this
  // extraction can under-read in SILENCE — the single failure mode all four denominators exist to
  // end.

  it("1. does not read a regex literal's `\\/\\/` as the start of a comment", () => {
    // The character-scanning rewrite fixed the string case and reintroduced it one construct over:
    // `/^https?:\/\//i` lost everything after it on the line — including the `{` that opens the
    // `if` — leaving a brace balance of -1 on two live files.
    const src = 'if (!/^https?:\\/\\//i.test(url)) {\n  go();\n}\n';
    const out = stripComments(src);
    expect(out).toContain("test(url)) {");
    expect([...out].filter((c) => c === "{").length).toBe(1);
    // A regex with a `/` inside a character class, and a division that is not a regex.
    expect(stripComments("const re = /[/]/; const q = a / b; // gone")).toBe("const re = /[/]/; const q = a / b; ");
  });

  it("1b. loses no block opener anywhere in src", () => {
    // The tree-wide form of the same claim: every line that ends in `) {` still ends in `{` after
    // stripping. 2331 lines on 2026-09-18, and the regex defect above broke two of them.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(join(REPO, "src"));
    const lost: string[] = [];
    let checked = 0;
    for (const file of files) {
      const raw = readFileSync(file, "utf8").split("\n");
      const stripped = stripComments(readFileSync(file, "utf8")).split("\n");
      raw.forEach((line, i) => {
        if (!/\)\s*\{$/.test(line) || /["`]/.test(line)) return;
        checked++;
        if (!/\{$/.test((stripped[i] ?? "").trimEnd())) lost.push(`${file}:${i + 1}`);
      });
    }
    expect(checked).toBeGreaterThan(1000);
    expect(lost).toEqual([]);
  });

  it("2. resolves a call site's binding to the nearest one before it, not the file's first", () => {
    // `browser.ts` binds `const code` twice. Resolving from the top gave both `failCode(code, …)`
    // sites the first binding's two codes, and the four the second site names were in the pin only
    // because other call sites happened to name them.
    const text = `
const code = a ? "First" : "Second";
failCode(code, m);
const code = b === "x" ? "Third" : "Fourth";
failCode(code, m);
`;
    const { sites } = readFailCodeSites([{ file: "f.ts", text }]);
    expect(sites.filter((s: { line: number }) => s.line === 3).map((s: { code: string }) => s.code)).toEqual([
      "First",
      "Second",
    ]);
    expect(sites.filter((s: { line: number }) => s.line === 5).map((s: { code: string }) => s.code)).toEqual([
      "Third",
      "Fourth",
    ]);
  });

  it("2b. reads a chain of ternaries, and keeps a condition's literal out of it", () => {
    // Four branches, and the conditions compare against string literals of their own. A reader that
    // collected every literal in the expression would put a comparison's right-hand side into the
    // caller-visible vocabulary.
    const { codes } = readFailCodeSites([
      {
        file: "f.ts",
        text: `const code = e === "ScopeNotFound" ? "ScopeNotFound" : e === "NoResults" ? "BrowserSearchNoResults" : e === "Timeout" ? "BrowserSearchTimeout" : "ToolError";\nfailCode(code, m);`,
      },
    ]);
    expect(codes).toEqual(["BrowserSearchNoResults", "BrowserSearchTimeout", "ScopeNotFound", "ToolError"]);
  });

  it("2c. reports a binding it cannot read rather than borrowing another site's", () => {
    const problems: string[] = [];
    readFailCodeSites([{ file: "f.ts", text: `const code = a ? "A" : somethingElse;\nfailCode(code, m);` }], problems);
    expect(problems.join("")).toMatch(/cannot read/);
  });

  it("3. resolves the dictionary guard against the enclosing `if`, in both directions", () => {
    // A byte window was wrong both ways: a second, unguarded arm within 400 characters of a guarded
    // one read as guarded (the false negative on the one invariant this axis rests on), and a
    // guarded arm with a long body ahead of it read as unbounded.
    const guarded = (src: string) =>
      readClassifyArms(src).dictionaryArms.map((a: { guarded: boolean }) => a.guarded);
    const arm = (cond: string, body = "") =>
      `function classify(m) { const d = "x"; if (${cond}) { ${body}return { code: d, suggest: [] }; } return { code: "ToolError" }; }`;
    expect(guarded(arm("d && Object.hasOwn(SUGGESTS, d)"))).toEqual([true]);
    expect(guarded(arm("d"))).toEqual([false]);
    // the guarded arm, with 600 characters of body before the return
    expect(guarded(arm("d && Object.hasOwn(SUGGESTS, d)", `const pad = "${"x".repeat(600)}"; `))).toEqual([true]);
    // guarded arm followed by an unguarded one: the second must not inherit the first's check
    expect(
      guarded(
        `function classify(m) { const d = "x"; if (d && Object.hasOwn(SUGGESTS, d)) { return { code: d, suggest: [] }; } if (d) { return { code: d, suggest: [] }; } return { code: "ToolError" }; }`,
      ),
    ).toEqual([true, false]);
    // and `if (c) return { … }`, with no block of its own
    expect(
      guarded(
        `function classify(m) { const d = "x"; if (d && Object.hasOwn(SUGGESTS, d)) return { code: d, suggest: [] }; return { code: "ToolError" }; }`,
      ),
    ).toEqual([true]);
  });

  it("4. sees a hand-built failure written in the tree's own shorthand", () => {
    // `return { ok: false, code, error }` is exactly how `toToolFailure` builds this shape, and the
    // sweep that promised such a producer "cannot exist quietly" skipped it.
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `function f() { return { ok: false, code, error }; }` },
    ]);
    expect(found.map((f: { expression: string }) => f.expression)).toEqual(["code"]);
    expect(found[0].code).toBeNull();
  });

  it("5. reads an arm that builds its object in a local and returns the local", () => {
    // Matching `return {` dropped the code silently, and because the dictionary arms were still
    // found, nothing said the cascade had become unreadable.
    const problems: string[] = [];
    const arms = readClassifyArms(
      `function classify(m) {
  if (m.includes("q")) { const out = { code: "HiddenArm", suggest: [] }; return out; }
  const d = "x";
  if (d && Object.hasOwn(SUGGESTS, d)) { return { code: d, suggest: [] }; }
  return { code: "ToolError", suggest: [] };
}`,
      problems,
    );
    expect(arms.literals).toEqual(["HiddenArm", "ToolError"]);
    expect(problems).toEqual([]);
  });

  it("6. keeps a computed code out of the count, and still pins the site", () => {
    // `code: err.name` was entering the ceiling as the STRING "err.name", and the headline said a
    // caller can receive a code by that name.
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `function f() { return { ok: false, code: err.name, error: m }; }` },
    ]);
    expect(found[0].code).toBeNull();
    expect(found[0].expression).toBe("err.name");
  });

  it("7. sees a JSON-shaped hand-built failure with quoted keys", () => {
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `function f() { return { "ok": false, "code": "X", "error": "e" }; }` },
    ]);
    expect(found.map((f: { code: string }) => f.code)).toEqual(["X"]);
  });

  it("7b. does not read a sentence that DESCRIBES the shape as a site that builds it", () => {
    // Teaching the sweep two more spellings taught it to read prose: `wait-until.ts`'s own caveats
    // string contains `{ok:false, code:'WaitTimeout', error, suggest:[...]}`, and the generated
    // catalogue copies it. Same class as a comment quoting a road literal, one quote character over.
    const found = readHandBuiltFlatFailures([
      {
        file: "a.ts",
        text: `const caveats = "On timeout the response is {ok:false, code:'WaitTimeout', error, suggest:[...]}.";`,
      },
    ]);
    expect(found).toEqual([]);
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
      const out = execFileSync(process.execPath, [join(root, "scripts", "check-code-vocabulary.mjs")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { status: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  const repin = () =>
    execFileSync(process.execPath, [join(root, "scripts", "check-code-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });

  const ERRORS = `
const SUGGESTS: Record<string, string[]> = {
  WaitTimeout: ["wait and retry"],
  KeyLockerDisabled: ["enable the locker"],
  AimOccluded: ["move the window"],
};
function classify(message: string): { code: string; suggest: string[] } {
  const declared = /^\\s*([A-Z][A-Za-z0-9]*):/.exec(message)?.[1];
  if (declared && Object.hasOwn(SUGGESTS, declared)) {
    return { code: declared, suggest: SUGGESTS[declared] ?? [] };
  }
  if (message.includes("timeout")) return { code: "WaitTimeout", suggest: SUGGESTS.WaitTimeout };
  return { code: "ToolError", suggest: [] };
}
export function failCode(code: string, error: string): ToolResult {
  return fail(toToolFailure(new ToolFailureError(code, { displayMessage: error })));
}
export function failArgs(message: string, toolName: string): ToolResult {
  const failure: ToolFailure = { ok: false, code: "InvalidArgs", error: message };
  return fail(failure);
}
`;

  /** The smallest tree the check accepts: a dictionary, a cascade, one call site, one pinned axis. */
  const fixture = (over: Record<string, string> = {}) => {
    const files: Record<string, string> = {
      "src/tools/_errors.ts": ERRORS,
      "src/tools/terminal.ts": `return failCode("KeyLockerDisabled", "KeyLockerDisabled: not active");`,
      "tests/fixtures/adr-036-result-vocabulary.json": JSON.stringify({ producedNames: ["AimOccluded", "Unknown"] }),
    };
    for (const [path, body] of Object.entries({ ...files, ...over })) write(path, body);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "code-vocabulary-"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    cpSync(join(REPO, "scripts", "check-code-vocabulary.mjs"), join(root, "scripts", "check-code-vocabulary.mjs"));
    for (const lib of ["route-vocabulary.mjs", "result-vocabulary.mjs", "code-vocabulary.mjs"]) {
      cpSync(join(REPO, "scripts", "lib", lib), join(root, "scripts", "lib", lib));
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("is 0 when the pinned axis matches the code", () => {
    fixture();
    repin();
    const { status, out } = run();
    expect(out).toMatch(/OK —/);
    expect(out).toMatch(/CEILING/);
    expect(status).toBe(0);
  });

  it("is 1 when the classifier grows a code the grid does not count", () => {
    fixture();
    repin();
    write(
      "src/tools/_errors.ts",
      ERRORS.replace('return { code: "ToolError", suggest: [] };', 'if (message.includes("x")) return { code: "BrandNewCode", suggest: [] };\n  return { code: "ToolError", suggest: [] };'),
    );
    const { status, out } = run();
    expect(out).toMatch(/BrandNewCode/);
    expect(status).toBe(1);
  });

  it("is 1 when a call site names a code the grid does not count", () => {
    fixture();
    repin();
    write("src/tools/terminal.ts", `return failCode("SomethingElse", "m");`);
    const { status, out } = run();
    expect(out).toMatch(/SomethingElse/);
    expect(status).toBe(1);
  });

  it("is 1 when the dictionary guard is removed and the axis stops being bounded", () => {
    // **The mutation this gate exists for.** Dropping `Object.hasOwn(SUGGESTS, declared)` lets any
    // producer's message name any code, and every count below it becomes a lower bound printed as a
    // total. Nothing else in the tree notices: the types are `string`, the tests pass, the
    // dictionary is untouched.
    fixture();
    repin();
    write("src/tools/_errors.ts", ERRORS.replace("declared && Object.hasOwn(SUGGESTS, declared)", "declared"));
    const { status, out } = run();
    expect(out).toMatch(/no upper bound|no longer bounded/);
    expect(status).toBe(1);
  });

  it("is 1 when a second file starts rendering flat failures itself", () => {
    // A fourth entry point: `toToolFailure` called from outside `_errors.ts` puts a code on the
    // wire without passing any of the three readings.
    fixture();
    repin();
    write("src/tools/rogue.ts", `export const r = () => toToolFailure(err);`);
    const { status, out } = run();
    expect(out).toMatch(/fourth flat-failure entry point/);
    expect(status).toBe(1);
  });

  it("is 1 when a hand-built flat failure appears", () => {
    fixture();
    repin();
    write("src/tools/rogue2.ts", `export const r = () => ({ ok: false, code: "HandRolled", error: "e" });`);
    const { status, out } = run();
    expect(out).toMatch(/HandRolled/);
    expect(status).toBe(1);
  });

  it("is 1 when a code the grid counts stops being produced", () => {
    fixture();
    repin();
    write("src/tools/terminal.ts", `// the call site is gone`);
    const { status, out } = run();
    expect(out).toMatch(/no longer produces/);
    expect(status).toBe(1);
  });

  it("refuses to compare anything when it cannot read the classifier", () => {
    // The lesson from #672: a broken derivation empties every set, and comparing an empty set
    // against the pin buries the one true line under sixty-five shadows of it.
    fixture();
    repin();
    write("src/tools/_errors.ts", ERRORS.replace("function classify(", "function classifyRenamed("));
    const { status, out } = run();
    expect(out).toMatch(/cannot derive the axis/);
    expect(out).toMatch(/nothing below was compared/);
    expect(status).toBe(1);
  });
});
