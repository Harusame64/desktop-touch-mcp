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
  fieldsAtDepthOne,
  isCalledOutside,
  isTypeLiteral,
  keysAtDepthOne,
  readClassifyArms,
  readEmbeddedScriptCodes,
  readFailArgsCode,
  readFailCodeSites,
  readHandBuiltFlatFailures,
} from "../../scripts/lib/code-vocabulary.mjs";
import { stripComments as stripConfigComments } from "../../scripts/lib/config-vocabulary.mjs";
import { stripComments as stripResultComments } from "../../scripts/lib/result-vocabulary.mjs";
import { stripComments } from "../../scripts/lib/route-vocabulary.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** Every `.ts` file under `src`, as the checks read them. */
function srcSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push({ file: full.slice(REPO.length).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(join(REPO, "src"));
  return out;
}

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

describe("all three comment strippers, because there are three", () => {
  it("none of them reads a regex literal's `\\/\\/` as a comment", () => {
    // **The same defect has three audiences.** This tree carries three implementations of
    // `stripComments` — `route-vocabulary` (the road and code axes), `result-vocabulary` and
    // `config-vocabulary` — and fixing the one this PR touched left the configuration axis reading
    // `/^https?:\/\//i` as a comment: `engine/cdp-bridge.ts:582` lost the `{` that opens its `if`,
    // so every brace-matching read after it walked into the wrong block with nothing reported. The
    // configuration pin did not move (79 switches before and after), so the corruption was latent —
    // which is exactly how it would have stayed until something downstream depended on it.
    const line = 'if (!/^https?:\\/\\//i.test(url)) {';
    for (const [name, strip] of [
      ["route", stripComments],
      ["result", stripResultComments],
      ["config", stripConfigComments],
    ] as const) {
      expect(strip(`${line}\n  go();\n}\n`).split("\n")[0], name).toBe(line);
    }
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
  const read = (text: string) => readFailCodeSites([{ file: "f.ts", text }]);

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

  it("records a code it cannot read instead of counting one less", () => {
    // Round 2 moved this from `problems` to a pinned list: the parser is not broken, the tree has a
    // producer whose values cannot be enumerated, and the summary says "lower bound" because of it.
    expect(read(`failCode(codeFromSomewhere, m);`).unreadable.join("")).toMatch(/codeFromSomewhere/);
  });

  it("does not read the declaration as a call site", () => {
    // **Asserts the `unreadable` list, not an empty-by-construction channel.** The old shape checked
    // a `problems` array this reader never writes to — a cell that could not go red (gate 2, round 3).
    const { codes, unreadable } = read(`export function failCode(\n  code: string,\n  error: string,\n) {}`);
    expect(codes).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it("does not stop at a newline when the call is wrapped", () => {
    const wrapped = read(`failCode(\n  "AimWindowGone",\n  message,\n);`);
    expect(wrapped.codes).toEqual(["AimWindowGone"]);
    expect(wrapped.unreadable).toEqual([]);
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

  it("2c. records a binding it cannot read rather than borrowing another site's", () => {
    // Round 2 moved this out of `problems`: a call site that forwards a computed value is a producer
    // whose values cannot be enumerated, not a broken parser. It is pinned, and the summary stops
    // calling the count a ceiling while the list is non-empty.
    const { unreadable } = readFailCodeSites([
      { file: "f.ts", text: `const code = a ? "A" : somethingElse;\nfailCode(code, m);` },
    ]);
    expect(unreadable.join("")).toMatch(/somethingElse/);
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

describe("what gate 2's second pass found, kept as cells", () => {
  it("1. records a wrapper call that forwards a computed value instead of dropping it", () => {
    // **The live one**: `key-locker-tool.ts:172` is `fail(code, …)` inside `keyLockerFailure`, where
    // `code = String(err.code)` — an arbitrary runtime string from a thrown object, forwarded onto
    // the caller's flat `code`. The wrapper loop skipped any non-literal argument silently, so
    // `LockerNotBound` and `SshFingerprintSetRequired` reached callers while the summary called the
    // count a CEILING and exited 0.
    const { unreadable, codes } = readFailCodeSites([
      {
        file: "k.ts",
        text: `
function fail(code: string, message: string): ToolResult {
  return failCode(code, message, { suggest: getSuggestsForCode(code) });
}
function present(err: unknown): ToolResult {
  const code = String((err as { code: unknown }).code);
  return fail(code, "m");
}
return fail("KeyLockerDisabled", "KeyLockerDisabled: not active");
`,
      },
    ]);
    expect(codes).toEqual(["KeyLockerDisabled"]);
    expect(unreadable.join("")).toMatch(/fail\(code\)/);
  });

  it("1b. the real tree still has exactly that one unenumerable call site", () => {
    const sources = srcSources();
    const { unreadable } = readFailCodeSites(sources);
    expect(unreadable).toEqual(["src/tools/key-locker-tool.ts:172: fail(code)"]);
  });

  it("2. reads the dictionary guard's POLARITY, not its presence", () => {
    // A substring test cannot tell a check from its negation. `!Object.hasOwn(SUGGESTS, declared)`
    // makes a producer's message able to name ANY code — the exact unbounding this axis exists to
    // catch — and left the gate green, still printing "both check the dictionary first".
    const arm = (cond: string) =>
      readClassifyArms(
        `function classify(m) { const d = "x"; if (${cond}) { return { code: d, suggest: [] }; } return { code: "ToolError" }; }`,
      ).dictionaryArms.map((a: { guarded: boolean }) => a.guarded);
    expect(arm("d && Object.hasOwn(SUGGESTS, d)")).toEqual([true]);
    expect(arm("d && !Object.hasOwn(SUGGESTS, d)")).toEqual([false]);
    expect(arm("Object.hasOwn(SUGGESTS, d) || override")).toEqual([false]);
    expect(arm("d")).toEqual([false]);
  });

  it("4. attributes a producer to the declaration that encloses it, function or arrow", () => {
    // Taking the last `function` keyword above the literal attributed an arrow-const producer to an
    // unrelated neighbour, and the reachability question was then answered about that neighbour —
    // a false "no caller outside its file" that also dropped the code from the count.
    const found = readHandBuiltFlatFailures([
      {
        file: "a.ts",
        text: `function localHelper() { return 1; }\nexport const makeFailure = () => ({ ok: false, code: "ProbeRogueCode", error: "e" });`,
      },
    ]);
    expect(found[0].fn).toBe("makeFailure");
    expect(found[0].exported).toBe(true);
  });

  it("4b. does not mistake a local variable for the enclosing declaration", () => {
    // `const failure: ToolFailure = { … }` is a local. Reading it as the enclosing form answers the
    // reachability question about a variable — which is how `failArgs` came back as `failure`.
    const found = readHandBuiltFlatFailures([
      {
        file: "a.ts",
        text: `export function failArgs(m: string) {\n  const failure = { ok: false, code: "InvalidArgs", error: m };\n  return fail(failure);\n}`,
      },
    ]);
    expect(found[0].fn).toBe("failArgs");
  });

  it("5. does not call a JSON-shaped TypeScript literal an embedded-script code", () => {
    // The mirror image of the prose defect: the hand-built sweep reads quoted keys now, so the same
    // site would be recorded twice, each set calling it something different.
    expect(readEmbeddedScriptCodes([{ file: "a.ts", text: `export const r = { "ok": false, "code": "NotAScript" };` }])).toEqual(
      [],
    );
  });

  it("5b. resolves an interpolated constant that is not exported", () => {
    const codes = readEmbeddedScriptCodes([
      { file: "a.ts", text: `const GONE = "aim_window_gone";\nconst ps = \`Write-Output '{"ok":false,"code":"\${GONE}"}'\`;` },
    ]);
    expect(codes.map((c: { code: string }) => c.code)).toEqual(["aim_window_gone"]);
  });

  it("5c. does not read a quoted VALUE sitting in key position as a property", () => {
    // Found by the mutation round, not by the review: `{ "ok": false, "note": "code", "error": "e" }`
    // put the string `"code"` where a key would be, and the walker read it as a shorthand property
    // named `code` — a negative control that went red. Shorthand is a bare identifier by grammar, so
    // only the unquoted form may omit its colon, and a value is skipped rather than scanned through.
    expect(
      readHandBuiltFlatFailures([{ file: "a.ts", text: `export const example = { "ok": false, "note": "code", "error": "e" };` }]),
    ).toEqual([]);
    expect(keysAtDepthOne(`{ ok: false, code: "X", error: "e" }`)).toEqual(["ok", "code", "error"]);
  });

  it("3. states the overlap rather than printing parts that do not add up", () => {
    // The headline read as a decomposition and its five parts summed to 117 where the same sentence
    // said 106 — nine failCode codes are also classifier literals, and two codes are counted in two
    // producer sets each.
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "check-code-vocabulary.mjs")], {
      encoding: "utf8",
    });
    expect(out).toMatch(/the parts below share \d+ members, so they do not add up to it/);
    expect(out).toMatch(/LOWER BOUND, not a total/);
    expect(out).not.toMatch(/at most \d+ codes/);
  });
});

describe("what gate 2's third pass found, kept as cells", () => {
  // Round 1 taught the stripper about strings, round 2 about regex literals, and round 3 found that
  // **none of the eight scanners below it had learned either**. The lesson is not about regexes: a
  // grammar rule learned in one scanner has to be learned by all of them, and the way to make that
  // true is to have one. `literalEnd` is that one.

  it("1. reads a producer whose neighbour holds a regex literal", () => {
    // `error: s.replace(/'/g, "''")` left every scanner below the stripper with an unbalanced quote,
    // and the producer beside it vanished from a function that has no `problems` channel at all.
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `export function g(s) { return { ok: false, code: "RegexValueCode", error: s.replace(/'/g, "''") }; }` },
    ]);
    expect(found.map((f: { code: string }) => f.code)).toEqual(["RegexValueCode"]);
  });

  it("2. is not fooled by a closing brace inside an earlier string value", () => {
    // The backward walk to the enclosing `{` tracked braces with no literal awareness at all, so
    // `error: "}"` balanced the object against its own brace and the site was skipped silently. It
    // is a forward pass with a stack now.
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `export function f() { return { error: "}", ok: false, code: "StringBraceCode" }; }` },
    ]);
    expect(found.map((f: { code: string }) => f.code)).toEqual(["StringBraceCode"]);
  });

  it("6. sees BOTH codes a conditional spread can produce", () => {
    // `{ ok:false, ...(c ? {code:"A"} : {code:"B"}), … }` is the tree's own idiom; counting brackets
    // uniformly buried the key two levels below the depth-1 walk.
    //
    // **And then the first version of this cell pinned the loss.** Reading the spread found the
    // first branch and stopped, so `Other` never entered the axis — with nothing in `problems` and
    // nothing in `unreadable` — and this cell asserted exactly that one-code result, locking it in
    // (gate 2 on #674, round 4, finding 5). A cell written from the fix's output agrees with the
    // fix, including where the fix is short.
    const found = readHandBuiltFlatFailures([
      { file: "a.ts", text: `export const h = (c) => ({ ok: false, ...(c ? { code: "SpreadCode" } : { code: "Other" }), error: "e" });` },
    ]);
    expect(found.map((f: { code: string }) => f.code).sort()).toEqual(["Other", "SpreadCode"]);
  });

  it("scans the whole tree in well under a second", () => {
    // The first forward-stack version read the word behind the cursor by slicing from the start of
    // the file — O(n²) over 2 MB, and the check went from milliseconds to minutes. A gate nobody can
    // afford to run is a gate that gets removed, so the bound is a cell.
    const started = Date.now();
    readHandBuiltFlatFailures(srcSources());
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("5. counts distinct call sites, not site-times-code rows", () => {
    // `sites` holds one row per resolved code, so a four-branch ternary contributes four. Printing
    // its length said 49 where there are 45 locations — a number that names one thing and counts
    // another, the same class as the parts that summed to 117.
    const { sites } = readFailCodeSites([
      { file: "f.ts", text: `const code = a ? "A" : b ? "B" : "C";\nfailCode(code, m);` },
    ]);
    expect(sites.length).toBe(3);
    expect(new Set(sites.map((s: { file: string; line: number }) => `${s.file}:${s.line}`)).size).toBe(1);
  });

  it("4. does not assert a definitive negative off a set it calls a lower bound", () => {
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "check-code-vocabulary.mjs")], {
      encoding: "utf8",
    });
    if (/LOWER BOUND, not a total/.test(out)) {
      expect(out).not.toMatch(/fall outside it, so for those the flat surface cannot say/);
      expect(out).toMatch(/which is not the same as there being none/);
    }
  });

  it("3. the CI step does not repeat the claim the script retracted", () => {
    // The third audience of the same sentence. Round 2 corrected the script and the library header;
    // this copy kept the retracted "CLOSED ABOVE", so a reader auditing CI got the old claim.
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/check:code-vocabulary/);
    expect(ci).not.toMatch(/CLOSED ABOVE/);
  });
});

describe("what gate 2's fourth pass found, kept as cells", () => {
  it("1. does not take a parenthesised expression for an arrow's parameter list", () => {
    // `= (` matched `const trimmed = (s ?? "").trim()`, and the enclosure check confirmed it because
    // the first `{` after such a line is usually the producer's own object literal. The reachability
    // answer was then about the wrong name, and `ceiling` drops a site answered unreachable.
    const found = readHandBuiltFlatFailures([
      {
        file: "a.ts",
        text: `export function insertText(s) { const trimmed = (s ?? "").trim(); return { ok: false, code: "X", error: trimmed }; }`,
      },
    ]);
    expect(found[0].fn).toBe("insertText");
    expect(found[0].exported).toBe(true);
  });

  it("2. reads the guard's POLARITY from the expression's structure", () => {
    // **The cell this replaces was written from the fix's output.** It asserted the three spellings
    // the alternation had been written for, so it stayed green for `=== true`, `!== false`, `!!x`
    // and `!(a && x)` — the four the predicate actually got wrong, one of which left the axis
    // unbounded at exit 0 (gate 2 on #674, round 5, finding 7). The title claimed a class its body
    // did not measure.
    //
    // **And enumerating spellings does not terminate**: three rounds added one at a time and each
    // found the next. The property is "the arm is entered only when membership holds", so the table
    // below is the property's truth table, and the reader answers it by parsing rather than by
    // matching text.
    const arm = (cond: string) =>
      readClassifyArms(
        `function classify(m) { const d = "x"; if (${cond}) { return { code: d, suggest: [] }; } return { code: "ToolError" }; }`,
      ).dictionaryArms.map((a: { guarded: boolean }) => a.guarded)[0];
    const table: [string, boolean][] = [
      ["d && Object.hasOwn(SUGGESTS, d)", true],
      ["d && !Object.hasOwn(SUGGESTS, d)", false],
      ["d && !(Object.hasOwn(SUGGESTS, d))", false],
      ["d && Object.hasOwn(SUGGESTS, d) === false", false],
      ["d && Object.hasOwn(SUGGESTS, d) !== true", false],
      // positives that a spelling-matcher read as inversions and reddened CI for
      ["d && Object.hasOwn(SUGGESTS, d) === true", true],
      ["d && Object.hasOwn(SUGGESTS, d) !== false", true],
      ["d && !!Object.hasOwn(SUGGESTS, d)", true],
      // inversions that a spelling-matcher read as positive, leaving the axis unbounded at exit 0
      ["!(d && Object.hasOwn(SUGGESTS, d))", false],
      ["!((Object.hasOwn(SUGGESTS, d)))", false],
      // a disjunct can reach the arm on its own
      ["Object.hasOwn(SUGGESTS, d) || override", false],
      [`d && Object.hasOwn(SUGGESTS, d) || d === "z"`, false],
      // brackets and operators inside a string are neither
      [`d && !m.includes("(") && Object.hasOwn(SUGGESTS, d)`, true],
      [`d && m !== "a||b" && Object.hasOwn(SUGGESTS, d)`, true],
      ["d", false],
    ];
    for (const [cond, required] of table) expect(arm(cond), cond).toBe(required);
  });

  it("3. the guard reader knows the shared grammar too", () => {
    // The one scanner that had not learned it. A `"}"` or a `"("` inside a string — three
    // behaviour-preserving edits — flipped `guarded` to false and turned CI RED, claiming the axis
    // was unbounded. A gate that reddens for a comment-shaped edit is a gate somebody turns off.
    const arm = (cond: string, body = "") =>
      readClassifyArms(
        `function classify(m) { const d = "x"; if (${cond}) { ${body}return { code: d, suggest: [] }; } return { code: "ToolError" }; }`,
      ).dictionaryArms.map((a: { guarded: boolean }) => a.guarded);
    expect(arm("d && Object.hasOwn(SUGGESTS, d)", `const note = "}"; `)).toEqual([true]);
    expect(arm("d && Object.hasOwn(SUGGESTS, d)", `const note = "{"; `)).toEqual([true]);
    expect(arm(`d && !m.includes(")") && Object.hasOwn(SUGGESTS, d)`)).toEqual([true]);
  });

  it("6. the configuration stripper puts the regex branch AFTER both comment checks", () => {
    // **The fix for the regex defect introduced a comment defect one line above it.** Inserted
    // between the `//` and `/*` tests, `const x = /* … */ 5;` read as a regex literal, so comment
    // prose entered the configuration axis as code — and a multi-line one desynced the string mask,
    // which hides a real switch. `browser.ts:2490` hits the first form today.
    expect(stripConfigComments(`const x = /* SECRET */ 5;`)).toBe("const x =  5;");
    expect(stripConfigComments(`if (!/^https?:\\/\\//i.test(u)) {`)).toBe(`if (!/^https?:\\/\\//i.test(u)) {`);
    // the multi-line form, whose damage was to the mask rather than to the text
    expect(stripConfigComments(`const a =\n  /* note\n     with a " quote */ 1;\nconst d = process.env.AFTER;`)).toContain(
      "process.env.AFTER",
    );
  });

  it("5. reads every value a field takes, not the first one", () => {
    // The reader under the sweep. `fieldAtDepthOne` keeps its single-value contract for the callers
    // that want one; the sweep asks for all of them, because a conditional spread gives the field
    // two and the caller can receive either.
    expect(fieldsAtDepthOne(`{ ok:false, ...(c ? { code:"AAA" } : { code:"BBB" }), error:"e" }`, "code")).toEqual([
      '"AAA"',
      '"BBB"',
    ]);
    expect(fieldAtDepthOne(`{ ok:false, code:"X", error:"e" }`, "code")).toBe('"X"');
  });

  it("7. does not read a method call as a call to a free function", () => {
    // `Object.keys(o)` answered reachability TRUE for a producer whose enclosing name is `keys`.
    // Round 5 then showed that answering FALSE is just as wrong — a producer reached through a
    // property is called — so the property form now answers `null`, and only the absence of both
    // forms answers `false`. `null` keeps the code in the count; `false` removes it.
    expect(isCalledOutside([{ file: "a.ts", text: "const z = Object.keys(o);" }], "keys", "b.ts")).toBeNull();
    expect(isCalledOutside([{ file: "a.ts", text: "const z = keys(o);" }], "keys", "b.ts")).toBe(true);
    expect(isCalledOutside([{ file: "a.ts", text: "const z = 1;" }], "keys", "b.ts")).toBe(false);
  });

  it("9. finds the wrapper's own declaration whatever it names its parameter", () => {
    // Hard-coding `code: string` made a behaviour-neutral rename add a phantom entry to
    // `unreadableCallSites` and the summary then claimed a call site that does not exist.
    const { codes, unreadable } = readFailCodeSites([
      {
        file: "k.ts",
        text: `
function fail(name: string, message: string): ToolResult {
  return failCode(name, message);
}
return fail("KeyLockerDisabled", "m");
`,
      },
    ]);
    expect(codes).toEqual(["KeyLockerDisabled"]);
    expect(unreadable).toEqual([]);
  });
});

describe("what gate 2's fifth pass found, kept as cells", () => {
  it("5. resolves an arrow whose parameters or return type contain parentheses", () => {
    // Round 4's fix demanded a paren-FREE parameter list, which lost `(a, b = f())` and
    // `(cb: (n) => void)` — both of which the form it replaced had resolved correctly. And while
    // fixing that, excluding `>` from the return-type slot lost `): Promise<ToolResult> =>`, which
    // is how `macro.ts`'s site was attributed to `dispatchableStepNames` for one run.
    const fn = (text: string) => readHandBuiltFlatFailures([{ file: "a.ts", text }])[0];
    expect(fn(`export const h = (a, b = fallback()) => { return { ok: false, code: "X", error: "e" }; };`).fn).toBe("h");
    expect(fn(`export const h = (cb: (n: number) => void) => { return { ok: false, code: "Y", error: "e" }; };`).fn).toBe("h");
    expect(
      fn(`export const h = async ({ a }: Args): Promise<R> => { return { ok: false, code: "Z", error: "e" }; };`).fn,
    ).toBe("h");
  });

  it("6. answers UNKNOWN, not `false`, when the only call is through a property", () => {
    // `false` is the one answer that REMOVES a code from the count, so a producer reached through a
    // dispatch table or a re-export must not be answered with it.
    expect(isCalledOutside([{ file: "a.ts", text: "api.insertText(1);" }], "insertText", "b.ts")).toBeNull();
    expect(isCalledOutside([{ file: "a.ts", text: "insertText(1);" }], "insertText", "b.ts")).toBe(true);
    expect(isCalledOutside([{ file: "a.ts", text: "const z = 1;" }], "insertText", "b.ts")).toBe(false);
  });

  it("4. a second unenumerable call site in the same file changes the pin", () => {
    // Deduping after the line number was stripped collapsed two `String(err.code)` forwards into one
    // entry, so adding another left the pin byte-identical and the gate green.
    const { unreadable } = readFailCodeSites([
      {
        file: "x.ts",
        text: `
function fail(code: string, m: string) { return failCode(code, m); }
export const a = (e: { code: string }) => fail(String(e.code), "m");
export const b = (e: { code: string }) => fail(String(e.code), "m");
`,
      },
    ]);
    expect(unreadable.length).toBe(2);
    expect(new Set(unreadable.map((u: string) => u.replace(/^([^:]+):\d+: /, "$1: "))).size).toBe(1);
  });
});

describe("the root class win2 found in their own extraction, swept here", () => {
  it("ends a binding at a `;` that is not inside a literal", () => {
    // win2's Opus round on internal#125 found a non-greedy `}` stopping inside
    // `{tool:reidentify_element}` — an object cut short because the scan did not know what a string
    // is. The user's rule of 2026-09-18 is to ask whether a pinpoint fix is enough and chase the
    // root, so the same class was swept here: `[^;]+` stopped at the semicolon inside
    // `cond ? "a;b" : "Second"`, and the truncated text was then reported as UNREADABLE — an
    // under-read wearing an honest answer's clothes, which is worse than a wrong one.
    const read = (text: string) => readFailCodeSites([{ file: "f.ts", text }]);
    expect(read(`const code = cond ? "a;b" : "Second";\nfailCode(code, m);`).codes).toEqual(["Second", "a;b"]);
    expect(read(`const code = "{tool:reidentify_element}";\nfailCode(code, m);`).codes).toEqual([
      "{tool:reidentify_element}",
    ]);
    // and a genuinely unreadable binding is still reported as one
    expect(read(`const code = somethingElse;\nfailCode(code, m);`).unreadable.length).toBe(1);
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
