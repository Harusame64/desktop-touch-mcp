/**
 * ADR-036 — the places where a reader decided a grammar question with something that is not the
 * grammar, and the shapes on both sides of each one.
 *
 * Five sites, three kinds of coarseness:
 *
 *   length   `config-vocabulary.mjs` cut the Rust raw-string `#` run out of a twelve-character slice
 *            `code-vocabulary.mjs`   asked for `ok: false` inside sixteen characters
 *            `route-vocabulary.mjs`  allowed four hundred characters from `{` to `route:`
 *            `route-vocabulary.mjs`  allowed thirty-nine from a newline to the next declaration
 *   spelling `literalEnd`            read `x++ /` as `x + /`, because it looked at one character
 *
 * All five lost in SILENCE, and none of them was reachable in this tree — which is the argument for
 * the cells rather than against the fix: `problems` stays empty on both sides of every one of these
 * bounds, so the only thing that can say the reader is wrong is a shape fired at it on purpose.
 *
 * **Every cell here comes in a pair**, because four of the five changes LOOSEN what the reader
 * accepts, and loosening is the one direction that can quietly cost detection. The shape that used
 * to fall out must now be read; the shape that must still be refused must still be refused.
 */
import { describe, expect, it } from "vitest";

import {
  readSwitchesFromRust,
  readSwitchesFromScript,
  stripComments as stripConfigComments,
} from "../../scripts/lib/config-vocabulary.mjs";
import { readHandBuiltFlatFailures } from "../../scripts/lib/code-vocabulary.mjs";
import { stripComments as stripResultComments } from "../../scripts/lib/result-vocabulary.mjs";
import {
  maskLiteralContents,
  readInlineFieldUnion,
  readRoadVocabulary,
  stripComments as stripRouteComments,
} from "../../scripts/lib/route-vocabulary.mjs";
import {
  readInlineFieldUnion as parsedReadInlineFieldUnion,
  readRoadVocabulary as parsedReadRoadVocabulary,
} from "../../scripts/lib/typescript-source.mjs";

// **Both type readers.** The gates read through the parser since #681; these cells were written
// against the scanner and would otherwise guard only a reader no gate calls (gate 2 on #681).
const ROAD_READERS = [
  { name: "scanner", readRoadVocabulary },
  { name: "parser", readRoadVocabulary: parsedReadRoadVocabulary },
];
const TYPE_READERS = [
  { name: "scanner", readInlineFieldUnion },
  { name: "parser", readInlineFieldUnion: parsedReadInlineFieldUnion },
];

describe("length: the Rust raw-string `#` run is counted, not windowed", () => {
  // The literal holds an ODD number of quotes on purpose. With an even number the parse comes back
  // into sync by luck and the shape passes while measuring nothing — the trap that called this
  // construct safe on #677, called the result mask safe on internal#125, and cost win2 a cell here.
  const rust = (prefix: string, hashes: number): string => {
    const h = "#".repeat(hashes);
    return `fn main() {\n  let s = ${prefix}${h}"a " b"${h};\n  let v = std::env::var("DTM_SENTINEL_${prefix}${hashes}");\n}\n`;
  };

  it.each([
    ["r", 10], // the last count the twelve-character window could hold
    ["r", 11], // the first it could not
    ["r", 40],
    ["br", 9], // the prefix eats one character of the window, so `br` died a count earlier
    ["br", 10],
    ["br", 40],
  ])("reads the switch after a %s string with %i hashes", (prefix, hashes) => {
    const problems: string[] = [];
    const found = readSwitchesFromRust(rust(prefix, hashes), "m.rs", problems);
    expect(found).toContain(`DTM_SENTINEL_${prefix}${hashes}`);
    expect(problems).toEqual([]);
  });

  it("reads a hash-free `r\"…\"`, which the grammar forbids a quote inside", () => {
    // Zero hashes is not a row in the table above: `r"a " b"` is not one literal with a quote in it,
    // it is `r"a "` followed by a fresh string. The shape that breaks the others cannot be written
    // here, and saying so is the difference between a case that passes and a case that is absent.
    const source = 'fn main() {\n  let s = r"a b";\n  let v = std::env::var("DTM_SENTINEL_r0");\n}\n';
    expect(readSwitchesFromRust(source, "m.rs", [])).toContain("DTM_SENTINEL_r0");
  });

  it("still ends the literal at the matching delimiter, not at the first one that looks like it", () => {
    // The pair for the loosening above: a longer run must not make a SHORTER closing delimiter end
    // the literal. `r##"…"#…"##` carries `"#` inside it, which is not the close.
    const source = 'fn main() {\n  let s = r##"a "# b"##;\n  let v = std::env::var("DTM_AFTER");\n}\n';
    expect(readSwitchesFromRust(source, "m.rs", [])).toEqual(["DTM_AFTER"]);
  });
});

describe("length: `ok: false` is anchored, and the whitespace in it has no length", () => {
  const handBuilt = (key: string, gap: string): string =>
    `function f() {\n  return { ${key}:${gap}false, code: "HandBuiltSentinel", error: "x" };\n}\n`;

  it.each([
    ["ok", 1],
    ["ok", 8], // the last gap the sixteen-character window could hold
    ["ok", 9], // the first it could not
    ["ok", 30],
    ['"ok"', 6],
    ['"ok"', 7],
    ["'ok'", 7],
  ])("finds the hand-built failure with %s and a gap of %i", (key, gap) => {
    const found = readHandBuiltFlatFailures([{ file: "f.ts", text: handBuilt(key, " ".repeat(gap)) }]);
    expect(JSON.stringify(found)).toContain("HandBuiltSentinel");
  });

  it("finds it across a line break with two levels of indent", () => {
    const source = 'function f() {\n  return {\n    ok:\n      false,\n    code: "WrappedSentinel",\n    error: "x",\n  };\n}\n';
    expect(JSON.stringify(readHandBuiltFlatFailures([{ file: "f.ts", text: source }]))).toContain("WrappedSentinel");
  });

  it("does not take `ok: true`, or an `ok` that is part of a longer word", () => {
    // The pair. Anchoring the question must not widen it.
    const ok = 'function f() {\n  return { ok: true, code: "NotAFailure", error: "x" };\n}\n';
    const word = 'function f() {\n  return { notok: false, code: "NotTheKey", error: "x" };\n}\n';
    expect(JSON.stringify(readHandBuiltFlatFailures([{ file: "f.ts", text: ok }]))).not.toContain("NotAFailure");
    expect(JSON.stringify(readHandBuiltFlatFailures([{ file: "f.ts", text: word }]))).not.toContain("NotTheKey");
  });
});

describe.each(ROAD_READERS)("length: the probeAim object is read, not measured ($name)", ({ readRoadVocabulary }) => {
  const call = (gap: number): string =>
    `function e() {\n  probeAim("act.route", {\n    note: "${"p".repeat(gap)}",\n    route: "gap_${gap}",\n  });\n}\n`;

  it.each([300, 399, 400, 401, 900])("reads the road when the gap to `route:` is %i", (gap) => {
    const out = readRoadVocabulary(call(gap));
    expect([...out.route]).toContain(`gap_${gap}`);
    expect(out.problems).toEqual([]);
  });

  it("does not take a `route` nested inside another property", () => {
    // The pair for removing the window: an unbounded search would find a nested `route:` that is
    // not this call's road. Depth is the grammar, and the depth-1 reader answers it.
    const source =
      'function e() {\n  probeAim("act.route", { extra: { route: "nested_not_mine" }, route: "mine" });\n}\n';
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("mine");
    expect([...out.route]).not.toContain("nested_not_mine");
  });

  it("does not take a call that a sentence is quoting", () => {
    const source = 'function e() {\n  const doc = `probeAim("act.route", { route: "in_prose" })`;\n}\n';
    expect([...readRoadVocabulary(source).route]).not.toContain("in_prose");
  });

  it("says so when the object carries no road of its own", () => {
    const source = 'function e() {\n  probeAim("act.route", { extra: { route: "nested_only" } });\n}\n';
    const out = readRoadVocabulary(source);
    expect(out.problems.join("\n")).toContain("carries no `route` of its own");
  });
});

describe.each(TYPE_READERS)("length: a declaration ends the one above it, however much whitespace it carries ($name)", ({ readInlineFieldUnion }) => {
  const pair = (gap: number): string =>
    `\nexport type FirstType = {\n  why: "mine"\n}\nexport${" ".repeat(gap)}type SecondType = {\n  why: "not_mine"\n};\n`;

  it.each([1, 29, 30, 120])("stops at the next declaration with a gap of %i", (gap) => {
    // Thirty-nine characters was the window, and the grounds written down for it were "the longest
    // spelling is `export interface`". That is the longest MINIMAL spelling; whitespace between two
    // tokens is unbounded, so the values of the type BELOW joined this one's union in silence.
    expect(readInlineFieldUnion(pair(gap), "FirstType", "why", [])).toEqual(["mine"]);
  });

  it("still does not treat a word that merely starts with a keyword as a declaration", () => {
    // The pair. `\b` is what keeps `constant` from ending a type, and anchoring must not lose it.
    const source = '\nexport type FirstType = {\n  why: "mine"\n}\nconstant_thing_not_a_decl = 1;\nexport type S = { why: "not_mine" };\n';
    expect(readInlineFieldUnion(source, "FirstType", "why", [])).toEqual(["mine"]);
  });
});

describe("spelling: a postfix `++` ends a value, so the slash after it is division", () => {
  it("leaves the code after `x++ / 2` alone", () => {
    // `literalEnd`'s character class holds `+` because a regex may follow a BINARY one, and reading
    // one character cannot tell `x + /` from `x++ /`. It answered "regex" for both, so everything to
    // the end of the line was read as a literal and blanked out of the masked copy — a producer
    // sitting there would have left the axis with nothing reported.
    expect(maskLiteralContents("let y = x++ / 2; KEEPME; let z = a / b;")).toContain("KEEPME");
    expect(maskLiteralContents("let y = x-- / 2; KEEPME; let z = a / b;")).toContain("KEEPME");
  });

  it("still opens a regex after a binary `+`, and after nothing at all", () => {
    // The pair, and the one that matters most: this change narrows what counts as a regex, and a
    // narrowing that goes one token too far stops blanking literals that must be blanked.
    expect(maskLiteralContents('x + /"INSIDE/.test(s)')).not.toContain("INSIDE");
    expect(maskLiteralContents('/"INSIDE/.test(s)')).not.toContain("INSIDE");
    expect(maskLiteralContents('const r = /"INSIDE/;')).not.toContain("INSIDE");
  });

  it("counts the RUN of `+`, because `x+++/re/` is `x++ + /re/`", () => {
    // Round 1 of gate 2 on this PR. The first version of the rule read the two characters nearest
    // the slash: in a run of three it sees `++`, answers division, and the regex's quote then opens
    // a string that blanks the rest of the line. An even run ends in `++`, which closes a value; an
    // odd run ends in a single `+`, which opens one.
    //
    // **The sentinel is in live code after the construct.** One placed INSIDE the regex is blanked
    // either way — as a regex's interior when the reader is right, and as a string's interior when
    // it is wrong — so it cannot tell the two readings apart. The first instrument used here did
    // exactly that and reported the defect fixed while it was still there.
    expect(maskLiteralContents('let a = x+++/"/.test(s); KEEPME;')).toContain("KEEPME");
    expect(maskLiteralContents('let a = x--- /"/.test(s); KEEPME;')).toContain("KEEPME");
    expect(maskLiteralContents('let a = x+ /"/.test(s); KEEPME;')).toContain("KEEPME");
  });

  it("needs no rule for a PREFIX `++`, because its significant character is the identifier", () => {
    expect(maskLiteralContents("++x / 2; KEEPME;")).toContain("KEEPME");
    expect(maskLiteralContents("--x / 2; KEEPME;")).toContain("KEEPME");
  });

  it("still reads a call's `)` and an index's `]` as values", () => {
    expect(maskLiteralContents("f(a) / 2; KEEPME;")).toContain("KEEPME");
    expect(maskLiteralContents("m[i] / 2; KEEPME;")).toContain("KEEPME");
    expect(maskLiteralContents("(a + b) / 2; KEEPME;")).toContain("KEEPME");
  });
});

describe("a comment is a token separator, and four strippers were deleting it", () => {
  it.each([
    ["route", stripRouteComments],
    ["result", stripResultComments],
    ["config", stripConfigComments],
  ])("%s keeps the tokens a block comment separates", (_name, strip) => {
    // `foo/**/bar` came out as `foobar`, `return/**/x;` as `returnx;`. Every reader in this tree did
    // it, and has since before #674 — found by gate 2 on this PR, through the one consequence that
    // had just become visible: `x+/**/+ /re/` becomes `x++ /re/`, which the operator-run rule then
    // reads as a postfix increment and calls the regex division.
    expect(strip("foo/**/bar")).toBe("foo bar");
    expect(strip("return/**/x;")).toBe("return x;");
  });

  it("the Rust stripper keeps it too, through a NESTED block comment", () => {
    // Rust's block comments nest, which is the only part of that branch that differs.
    const source = 'fn main() { let a = foo/* outer /* inner */ still */bar; let v = std::env::var("DTM_AFTER_NESTED"); }';
    expect(readSwitchesFromRust(source, "m.rs", [])).toEqual(["DTM_AFTER_NESTED"]);
  });

  it("does not lose the line a comment sat on", () => {
    // The pair: the contract of these functions is that every line keeps its INDEX. The separator
    // must not add one, and a multi-line comment must still leave its newlines behind.
    const source = "const a = 1;\n/* two\n   lines */\nconst b = 2;\n";
    expect(stripRouteComments(source).split("\n")).toHaveLength(source.split("\n").length);
  });

  it("keeps the code after `x+/**/+ /re/`, because those are two operators", () => {
    expect(maskLiteralContents(stripRouteComments('let v = x+/**/+ /"/.test(s); KEEPME;'))).toContain("KEEPME");
  });
});

describe.each(ROAD_READERS)("a template's interpolation is code, and its text is prose ($name)", ({ readRoadVocabulary }) => {
  it("finds a producer written inside `${…}`", () => {
    // The mask that replaced the 400-character window knew too much: it blanked the whole template,
    // including the executable `${…}`, so this call was invisible with no road and no problem
    // reported. The window it replaced DID find it, because a window does not know what a literal
    // is (gate 2 on this PR, round 2).
    const source = 'function e() {\n  const s = `${probeAim("act.route", { route: "templated" })}`;\n}\n';
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("templated");
    expect(out.problems).toEqual([]);
  });

  it("still does not find one written in a template's TEXT", () => {
    // The pair, and the reason the mask is there at all: prose in this tree quotes the shapes it
    // describes, and a quoted call is not a call.
    const source = 'function e() {\n  const doc = `probeAim("act.route", { route: "in_prose" })`;\n}\n';
    expect([...readRoadVocabulary(source).route]).not.toContain("in_prose");
  });

  it("reads a template nested inside an interpolation, where the old model desynchronised", () => {
    // Taking the whole template as one literal ended it at the INNER template's opening backtick,
    // after which the reader had string text as code and code as string text for the rest of the
    // expression. Ten files in `src` are shaped this way.
    const source = 'const m = `a${x ? `b${y}c` : "d"}e`; const after = "SENTINEL";\n';
    const masked = maskLiteralContents(source);
    expect(masked).toHaveLength(source.length);
    expect(masked).toContain("x ?");          // the interpolation is code
    expect(masked).not.toContain("SENTINEL"); // and the string after it is still a string
    expect(masked).not.toContain("abc");
  });
});

describe.each(ROAD_READERS)("a comment inside a template's interpolation is still a comment ($name)", ({ readRoadVocabulary }) => {
  it("strips it, so its prose cannot enter an axis as code", () => {
    // Gate 2 on this PR, round 3. Every stripper here took a template as one quoted run, so a
    // `/* … */` inside a `${…}` survived. Harmless while nothing looked inside — and this PR made
    // `literalSpans` look: the closing `/` of `*/` sits after a `*`, which opens a value, so it read
    // as a regex and ate the rest of the line.
    const source = 'const s = `${/* x */ 1}`; probeAim("act.route", { route: "after" });\n';
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("after");
    expect(out.problems).toEqual([]);
  });

  it("keeps a switch named only in such a comment out of the configuration axis", () => {
    // The other direction, and the one that was already wrong before this PR: the comment's prose
    // was read as source, so a name written there joined the axis beside the real switches.
    const source = 'const s = `${/* process.env.DTM_GHOST */ 1}`;\nconst v = process.env.DTM_REAL;\n';
    const found = readSwitchesFromScript(source, "f.ts", []);
    expect(found.read).toEqual(["DTM_REAL"]);
  });

  it("still leaves a template's TEXT alone, comment-looking or not", () => {
    // The pair: `${…}` is code, the text around it is not, and a `//` in the text is not a comment.
    const source = 'const s = `see https://example.com/ and /* not a comment */ here`;\nconst v = process.env.DTM_KEPT;\n';
    expect(stripRouteComments(source)).toContain("https://example.com/");
    expect(stripRouteComments(source)).toContain("/* not a comment */");
    expect(readSwitchesFromScript(source, "f.ts", []).read).toEqual(["DTM_KEPT"]);
  });
});

describe.each(ROAD_READERS)("the helper's forwarding call is exempted by WHERE it is, and only there ($name)", ({ readRoadVocabulary }) => {
  const helper = 'function probeRoute(route: string, aimHwnd: bigint, entity: UiEntity, extra = {}): void {\n  probeAim("act.route", { route, ...extra });\n}\n';

  it("exempts probeRoute's own forwarding call", () => {
    // The helper's body ends with `probeAim("act.route", { route, … })`, forwarding the parameter it
    // was given. That site names no road; the roads that reach it are exactly the literals the
    // `probeRoute("…")` rule reads, so reporting it would make the gate red about a producer that is
    // already fully enumerated one rule up.
    const source = `${helper}function caller(): void {\n  probeRoute("a_real_one", h, e, {});\n}\n`;
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("a_real_one");
    expect(out.problems).toEqual([]);
  });

  it("reports a shorthand `route` in ANY OTHER function", () => {
    // Gate 2 on this PR, round 4. The first version walked up to eight `{…}` candidates after the
    // `function` keyword until one spanned the call — which reads straight past the helper: a direct
    // `probeAim("act.route", { route })` in a later function landed inside THAT function's block,
    // the walk accepted it, and the exemption swallowed a dynamic producer with neither a road nor a
    // problem. Eight was also one more arbitrary bound, in a PR about removing them.
    const source = `${helper}function somethingElse(route: string): void {\n  probeAim("act.route", { route });\n}\n`;
    const out = readRoadVocabulary(source);
    expect(out.problems.join("\n")).toContain("non-literal road");
  });

  it.each([
    "Promise<{ ok: boolean }>",
    "{ ok: boolean } | null",
    "Array<{ a: 1 }>[]",
    "{ ok: boolean } & { more: 1 }",
  ])("finds the body past a WRAPPED return type: %s", (annotation) => {
    // Gate 2 on this PR, round 5. Checking only for an immediately following `{` took the type
    // literal as the body whenever the type continued with `>` or `|` instead — and the helper's own
    // forwarding call was then reported, so the gate went red about a producer that is enumerated
    // one rule up. A type CONTINUES after its block; a body does not.
    const source = `function probeRoute(route: string): ${annotation} {\n  probeAim("act.route", { route });\n  return null as never;\n}\nfunction caller(): void {\n  probeRoute("a_real_one", h, e, {});\n}\n`;
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("a_real_one");
    expect(out.problems).toEqual([]);
  });

  it("does not walk out of the body into an `export { … }` that follows it", () => {
    // The pair for that loosening: after a REAL body, `}\nexport { probeRoute };` also offers an
    // identifier and then a brace. The continuation has to START with a type character, or the
    // search leaves the function.
    const source =
      'function probeRoute(route: string): void {\n  probeAim("act.route", { route });\n}\nexport { probeRoute };\nfunction caller(): void {\n  probeRoute("a_real_one", h, e, {});\n}\n';
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("a_real_one");
    expect(out.problems).toEqual([]);
  });

  it("finds the body past an OBJECT RETURN TYPE, which opens a brace of its own", () => {
    // `): { ok: boolean } {` puts two blocks in a row after the parameter list, and the first is the
    // annotation. They are told apart by what follows the first one closing — another `{` means the
    // first was a type. Taking the wrong one does not fail loudly here: the exemption simply stops
    // applying to the helper's own call, which reports a producer that IS enumerated one rule up.
    const source =
      'function probeRoute(route: string): { ok: boolean } {\n  probeAim("act.route", { route });\n  return { ok: true };\n}\nfunction caller(): void {\n  probeRoute("a_real_one", h, e, {});\n}\n';
    const out = readRoadVocabulary(source);
    expect([...out.route]).toContain("a_real_one");
    expect(out.problems).toEqual([]);
  });
});

describe.each(TYPE_READERS)("a brace inside a literal is not a brace, in the type reader too ($name)", ({ readInlineFieldUnion }) => {
  // Found on a calm re-read of `readInlineFieldUnion` AFTER five review rounds, none of which
  // reached it: the rounds were anchored on the lines this branch changed, and these two sit just
  // above and just below them. The function ends a type at a `;` "at brace depth 0" and reads the
  // field's value up to `[^;{}]` — and neither knew what a literal was, in a module that by then
  // had a mask sitting three hundred lines up.
  const pair = (member: string): string =>
    `export type T = {\n  why: "a" | ${member}\n};\nexport type Other = {\n  why: "not_mine"\n};\n`;

  it("reads a member whose text contains `{`", () => {
    // This tree's advice strings are full of `{tool:…}`, so the shape is not exotic here. It was
    // dropped with `problems` empty — the silent direction.
    expect(readInlineFieldUnion(pair('"{tool:x}"'), "T", "why", [])).toEqual(["a", "{tool:x}"]);
  });

  it("reads a member whose text contains `}`, and does not run on into the next type", () => {
    // The loud direction of the same defect: the stray `}` closed the type early, and the NEXT
    // type's values joined this one's union.
    const problems: string[] = [];
    expect(readInlineFieldUnion(pair('"}"'), "T", "why", problems)).toEqual(["a", "}"]);
    expect(problems).toEqual([]);
  });

  it("still ends the type at the next top-level declaration", () => {
    // The pair: making the scan literal-aware must not make it blind to the end of the type.
    expect(readInlineFieldUnion(pair('"b"'), "T", "why", [])).toEqual(["a", "b"]);
  });

  it("still says so when the union is not one of string literals", () => {
    const problems: string[] = [];
    const source = 'export type T = {\n  why: `pre_${string}`\n};\n';
    expect(readInlineFieldUnion(source, "T", "why", problems)).toEqual([]);
    expect(problems.join("\n")).toContain("stopped being a union of literals");
  });
});
