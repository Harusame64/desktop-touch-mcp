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

import { readSwitchesFromRust } from "../../scripts/lib/config-vocabulary.mjs";
import { readHandBuiltFlatFailures } from "../../scripts/lib/code-vocabulary.mjs";
import {
  maskLiteralContents,
  readInlineFieldUnion,
  readRoadVocabulary,
} from "../../scripts/lib/route-vocabulary.mjs";

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

describe("length: the probeAim object is read, not measured", () => {
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

describe("length: a declaration ends the one above it, however much whitespace it carries", () => {
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
