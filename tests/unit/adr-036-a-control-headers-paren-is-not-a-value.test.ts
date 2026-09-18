/**
 * ADR-036 — the last coarse encoding in the literal reader: a `)` is not always a value.
 *
 * After the `)` that closes an `if` / `while` / `for` HEADER a statement begins, and a statement may
 * begin with a regular expression. Reading the character alone answered "value", so the slash was
 * division, the quote inside the regex opened a string, and everything after it on the line was
 * blanked out of the mask — a producer sitting there left the axis with nothing reported.
 *
 * Found by gate 2 on internal#125 (round 4) and pinned as it behaved through #678 and #679, because
 * it is unreachable in this tree: `src` and `scripts` contain no unbraced control body that is a
 * regex literal. Only a shape fired on purpose can say a reader is wrong about a construct nobody
 * has written yet — which is also why the widening below needs its controls more than its cases.
 *
 * **These cells let TypeScript judge.** The expectations are not hand-written masks: each shape is
 * classified by `ts.createSourceFile` and by `literalSpans`, and the two must agree character for
 * character. A hand-written expectation encodes what I believed while writing it; the compiler
 * encodes the language. The whole-tree oracle in
 * `adr-036-one-literal-reader-answers-for-every-view.test.ts` cannot speak to this change at all,
 * because the tree contains none of these shapes.
 */
import { describe, expect, it } from "vitest";

import ts from "typescript";

import { maskLiteralContents, literalSpans, significantBefore } from "../../scripts/lib/route-vocabulary.mjs";

/** Every character TypeScript says belongs to a literal's text — a template's `${…}` is code. */
const oracle = (source: string): Uint8Array => {
  const marked = new Uint8Array(source.length);
  const file = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ]);
  const mark = (node: ts.Node): void => {
    if (kinds.has(node.kind)) {
      for (let i = node.getStart(file); i < node.getEnd(); i++) marked[i] = 1;
      return;
    }
    node.forEachChild(mark);
  };
  file.forEachChild(mark);
  return marked;
};

const agreesWithTypeScript = (source: string): string | null => {
  const want = oracle(source);
  const mine = new Uint8Array(source.length);
  for (const [start, end] of literalSpans(source)) for (let i = start; i < end; i++) mine[i] = 1;
  for (let i = 0; i < source.length; i++) {
    if (want[i] === mine[i]) continue;
    return `at ${i}: typescript=${want[i]} ours=${mine[i]} ${JSON.stringify(source.slice(Math.max(0, i - 24), i + 24))}`;
  }
  return null;
};

describe("a `)` that closes a control header opens a statement", () => {
  it.each([
    ['if (r) /a"b/.test(x);', 'function f(r: RegExp, x: string) { if (r) /a"b/.test(x); }'],
    ['while (r) /a"b/.exec(x);', 'function f(r: RegExp, x: string) { while (r) /a"b/.exec(x); }'],
    ['for (;;) /a"b/.exec(x);', 'function f(x: string) { for (;;) /a"b/.exec(x); }'],
    ['for (const a of b) /a"b/.exec(a);', 'function f(b: string[]) { for (const a of b) /a"b/.exec(a); }'],
    ['if (g()) /a"b/.test(x);', 'function f(g: () => boolean, x: string) { if (g()) /a"b/.test(x); }'],
    [
      'for (let i = 0; i < n; i++) /a"b/.test(x);',
      'function f(n: number, x: string) { for (let i = 0; i < n; i++) /a"b/.test(x); }',
    ],
  ])("reads the regex after %s exactly as TypeScript does", (_label, source) => {
    expect(agreesWithTypeScript(source)).toBeNull();
  });

  it.each([
    ["a call's `)`", "function f(g: () => number) { const v = g() / 2; return v; }"],
    ["a group's `)`", "function f(a: number, b: number) { const v = (a + b) / 2; return v; }"],
    ["an index's `]`", "function f(m: number[], i: number) { const v = m[i] / 2; return v; }"],
    [
      "a call's `)` on the same line as a header's",
      "function f(a: boolean, g: () => number) { if (a) { } const v = g() / 2; return v; }",
    ],
  ])("still reads division after %s, exactly as TypeScript does", (_label, source) => {
    // **The controls are the work.** This change WIDENS what counts as a regex, and widening is the
    // one direction that can quietly stop a literal being blanked. A reader that answered "regex"
    // for every `)` would pass every case above and fail all of these.
    expect(agreesWithTypeScript(source)).toBeNull();
  });
});

describe("what the widening does to the mask, named rather than compared", () => {
  // The agreement cells above have a compiler on the other side, which is a far better second
  // opinion than another thing this tree wrote — but they still say nothing about what the mask is
  // FOR. These do: the sentinel is live code after the construct, because one inside the regex is
  // blanked under both readings and cannot tell them apart.
  it("stops eating the rest of the line after a header", () => {
    expect(maskLiteralContents('if (r) /"/.test(x); KEEPME;')).toContain("KEEPME");
    expect(maskLiteralContents('while (r) /"/.exec(x); KEEPME;')).toContain("KEEPME");
    expect(maskLiteralContents('for (;;) /"/.exec(x); KEEPME;')).toContain("KEEPME");
  });

  it("still blanks the regex itself", () => {
    expect(maskLiteralContents("if (r) /INSIDE/.test(x);")).not.toContain("INSIDE");
  });

  it("still leaves division alone, with both `)` on one line", () => {
    expect(maskLiteralContents('if (a) { } let v = f(b) / 2; KEEPME; let w = "x";')).toContain("KEEPME");
    expect(maskLiteralContents("let v = f(a) / INSIDE / 2;")).toContain("INSIDE");
  });

  it("was already right after `do`, `switch` and `catch`, and still is", () => {
    // The scope is exactly "a `)` immediately before the slash". After `do` the significant
    // character is the keyword itself, and `switch (x) {` / `catch (e) {` put a `{` there — all
    // three already read correctly, and none of them is a cell for this fix. They are cells against
    // it: a change that touched them would be reaching past what it is for. (win2 measured the same
    // thing from the shape set's side, and `do` is a control there for the same reason.)
    expect(maskLiteralContents('do /"INSIDE/.test(x); while (r); KEEPME;')).toContain("KEEPME");
    expect(maskLiteralContents('do /"INSIDE/.test(x); while (r); KEEPME;')).not.toContain("INSIDE");
    expect(significantBefore('do /"/.test(x);', 'do '.length)).toBe("do");
  });

  it("tells the header's `)` from a postfix `++` that sits right before it", () => {
    // `for (let i = 0; i < n; i++)` puts the two rules this reader learned in #679 and here at the
    // same character. The `)` is what precedes the slash, so the header lookup answers first; the
    // `++` belongs to the header's own last expression and never reaches the question.
    const source = 'for (let i = 0; i < n; i++) /"INSIDE/.test(x); KEEPME;';
    expect(significantBefore(source, source.indexOf('/"'))).toBe("for");
    expect(maskLiteralContents(source)).toContain("KEEPME");
    expect(maskLiteralContents(source)).not.toContain("INSIDE");
  });

  it("answers the keyword for a header's `)` and the character for any other", () => {
    // The seam itself. `significantBefore` returns `)` for a value and the KEYWORD for a header, and
    // `literalEnd` knows the three keywords — which is why the widening could be one entry in a list
    // rather than a second rule about parentheses.
    const header = 'if (r) /"/.test(x);';
    expect(significantBefore(header, header.indexOf('/"'))).toBe("if");
    const call = "let v = f(a) / 2;";
    expect(significantBefore(call, call.indexOf("/ 2"))).toBe(")");
  });
});
