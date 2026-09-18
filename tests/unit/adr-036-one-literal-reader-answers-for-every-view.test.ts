/**
 * ADR-036 — one literal reader, and the views that must not disagree with it.
 *
 * Three functions used to run the same walk over literals: `maskLiterals` and `stringRanges` in
 * `code-vocabulary.mjs` (byte-identical loops four hundred lines apart), and `maskStringContents`
 * in `result-vocabulary.mjs`. Each time this tree learned a grammar rule, some of them learned it
 * and some did not — #672 taught `stripComments` about regex literals, #674 found eight scanners
 * below it that had not, #677 found the rule copied into a reader for a language with no regex
 * literals at all, and internal#125 grew a fresh one sixty lines under the comment that says not to.
 *
 * They are views of `literalSpans` now. **An agreement test goes silent when both sides break
 * together**, so the agreement cells here are paired with cells that NAME the behaviour: what a
 * literal is, what division is, and what the mask promises about length.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { literalSpans, literalEnd, significantBefore, stripComments } from "../../scripts/lib/route-vocabulary.mjs";
import { maskStringContents } from "../../scripts/lib/result-vocabulary.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules") walk(full);
      } else if (name.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(REPO, "src"));
  return out;
};

describe("what the one reader says a literal is", () => {
  it("reads a regex literal whose body contains quotes and braces", () => {
    // The shape that cost three PRs: the quotes inside a regex are not string delimiters and the
    // braces inside it are not blocks. A reader that gets this wrong desynchronises for the rest of
    // the file and drops producers with `problems` empty.
    const text = 'const re = /^a"b\\{c/;\nconst after = "still a string";\n';
    const spans = literalSpans(text);
    expect(spans).toHaveLength(2);
    expect(text.slice(spans[0][0], spans[0][1])).toBe('/^a"b\\{c/');
    expect(text.slice(spans[1][0], spans[1][1])).toBe('"still a string"');
  });

  it("does not read division as a literal, in either arrangement", () => {
    // The mirror error. Calling division a regex would blank real code, which under-reads just as
    // silently as the other direction — #677's lesson, where Rust fell one way and C# the other
    // out of the same cause.
    expect(literalSpans("const q = a / b;\n")).toEqual([]);
    expect(literalSpans("const q = a / b / c;\n")).toEqual([]);
    const mixed = literalSpans('const q = a / b + "tail";\n');
    expect(mixed).toHaveLength(1);
    expect('const q = a / b + "tail";\n'.slice(mixed[0][0], mixed[0][1])).toBe('"tail"');
  });

  it("reads BOTH of two literals that touch, with no character between them", () => {
    // Found by a mutation that every other cell here survived: advancing to `end` instead of
    // `end - 1` (the loop's own `i++` supplies the last step) skips exactly one character, which is
    // invisible unless a literal begins at the index the previous one ended on. It does, 47 files'
    // worth — `\`index.js\`'s candidate list` and the nested templates in `engine/aim.ts`.
    //
    // The COUNT stays right, which is why a cell that only counted would have passed: the walk
    // finds a second literal either way. It finds the WRONG one — it opens at the closing quote of
    // the first and runs to the end of the line, swallowing the code in between.
    const text = 'x("a""b");\n';
    const spans = literalSpans(text);
    expect(spans.map(([s, e]) => text.slice(s, e))).toEqual(['"a"', '"b"']);
    const backtick = "const s = `index.js`'s candidate list';\n";
    expect(literalSpans(backtick).map(([s, e]) => backtick.slice(s, e))).toEqual([
      "`index.js`",
      "'s candidate list'",
    ]);
  });

  it("stops a single-quoted run at the newline, so one stray quote cannot swallow the file", () => {
    const text = "const a = 'unterminated\nconst b = 1;\n";
    const spans = literalSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0][1]).toBeLessThanOrEqual(text.indexOf("\n") + 1);
  });

  it("lets a template literal cross a newline, because that one may", () => {
    const text = "const a = `one\ntwo`;\nconst b = 1;\n";
    const spans = literalSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0][0], spans[0][1])).toBe("`one\ntwo`");
  });

  it("READS A CONTROL HEADER'S `)` AS A VALUE — a known gap, pinned so the fix is visible", () => {
    // After the `)` that closes an `if`/`while`/`for` header a regex may legally begin, but
    // `significantBefore` answers `)` and `literalEnd` reads the slash as division. Found by gate 2
    // on internal#125 (round 4). It is unreachable in this tree today — `src` and `scripts` contain
    // no unbraced control body that is a regex literal — and it is a property of `literalEnd`, which
    // this PR moved without changing. Pinned as it BEHAVES, not as it should, so that the PR which
    // fixes it has to come here and say so.
    const text = 'if (r) /"/.test(x);\n';
    expect(significantBefore(text, text.indexOf("/"))).toBe(")");
    expect(literalEnd(text, text.indexOf("/"), ")")).toBe(-1);
    // and the same slash after a value really is division, which is why the answer is not simply
    // "a `)` allows a regex".
    expect(literalEnd("const q = a / b;\n", "const q = a ".length, "a")).toBe(-1);
  });
});

describe("the mask promises length, and the views promise agreement", () => {
  it("keeps the source's length, so a span found on the mask indexes the original", () => {
    const text = 'const s = "{tool:reidentify_element}";\nconst re = /["\']/g;\n';
    const masked = maskStringContents(text);
    expect(masked).toHaveLength(text.length);
    // the braces inside the string are gone from the copy, so a brace-balancer reads them as absent
    expect(masked).not.toContain("{tool");
    expect(masked.indexOf('"')).toBe(text.indexOf('"'));
  });

  it("blanks a regex literal's interior exactly as it blanks a string's", () => {
    const text = 'const re = /a"{b/;\n';
    const masked = maskStringContents(text);
    expect(masked).toBe('const re = /    /;\n');
  });

  it("keeps a newline inside a template literal, so line structure survives", () => {
    const text = "const a = `one\ntwo`;\n";
    const masked = maskStringContents(text);
    expect(masked).toBe("const a = `   \n   `;\n");
    expect(masked.split("\n")).toHaveLength(text.split("\n").length);
  });

  it("agrees with the mask on every literal in every source file in the tree", () => {
    // The agreement half. On its own it would go quiet if both views broke the same way, which is
    // why the cells above name the behaviour instead of comparing two implementations.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    let spansSeen = 0;
    const disagreed: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const masked = maskStringContents(source);
      if (masked.length !== source.length) {
        disagreed.push(`${file}: mask changed the length`);
        continue;
      }
      for (const [start, end] of literalSpans(source)) {
        spansSeen++;
        // the delimiters survive in the mask, and the interior is blank or a newline
        if (masked[start] !== source[start] || masked[end - 1] !== source[end - 1]) {
          disagreed.push(`${file}:${start} delimiter changed`);
          break;
        }
        for (let j = start + 1; j < end - 1; j++) {
          if (masked[j] !== " " && masked[j] !== "\n") {
            disagreed.push(`${file}:${j} interior not blanked (${JSON.stringify(masked[j])})`);
            break;
          }
        }
      }
    }
    expect(spansSeen).toBeGreaterThan(10000);
    expect(disagreed).toEqual([]);
  });
});

describe("the one reader, against TypeScript's own scanner", () => {
  /**
   * Every character TypeScript says belongs to a literal's TEXT. A template's `${…}` is code, so
   * `TemplateHead` / `Middle` / `Tail` are marked and the expressions between them are not.
   */
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

  it("classifies every character of every source file exactly as TypeScript does", () => {
    // **An oracle, not a second opinion.** Every other agreement cell in this file compares two
    // things this tree wrote, and both can be wrong the same way — three hand-written encodings of
    // "where may a regex begin" agreed for years while all three allowed one after `x++`. This one
    // compares against the compiler that defines the answer.
    //
    // The comparison is on the STRIPPED text, because that is what every gate reads; a backtick in
    // prose is not a template, and TypeScript would be right to say it is.
    //
    // Zero permitted exceptions, on purpose. It ran with one — regular-expression FLAG letters,
    // 82 characters in 2,124,147 — and taking them into the literal cost a single line. A list of
    // allowed differences is a list nobody re-reads.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const disagreed: string[] = [];
    let compared = 0;
    for (const path of files) {
      const source = stripComments(readFileSync(path, "utf8"));
      let expectedMask: Uint8Array;
      try {
        expectedMask = oracle(source);
      } catch {
        continue;
      }
      const mine = new Uint8Array(source.length);
      for (const [start, end] of literalSpans(source)) for (let i = start; i < end; i++) mine[i] = 1;
      for (let i = 0; i < source.length; i++) {
        compared++;
        if (expectedMask[i] === mine[i]) continue;
        const line = source.slice(0, i).split("\n").length;
        disagreed.push(`${path}:${line} typescript=${expectedMask[i]} ours=${mine[i]} ${JSON.stringify(source.slice(Math.max(0, i - 30), i + 10))}`);
        break;
      }
    }
    expect(compared).toBeGreaterThan(1_000_000);
    expect(disagreed).toEqual([]);
  });

  it("removes exactly TypeScript's comments, leaving its token stream untouched", () => {
    // **The invariant is the TOKEN stream, not the characters.** The stripper leaves a separator
    // where a comment was, on purpose, so comparing text would report a difference that is the fix.
    // Comparing tokens is what a separator protects and what deleting one destroys: before #679 all
    // four strippers turned `foo/**/bar` into `foobar`, and this cell would have said so on the day
    // it landed.
    //
    // The comment ranges come from the syntax tree, not from a bare `ts.createScanner` loop — a raw
    // scanner desynchronises on a template literal and on a regex unless it is driven with
    // `reScanTemplateToken` / `reScanSlashToken`, and it reported 99 of 203 files as disagreeing
    // when the disagreement was its own.
    const commentRanges = (source: string): Uint8Array => {
      const marked = new Uint8Array(source.length);
      const file = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const seen = new Set<number>();
      const visit = (node: ts.Node): void => {
        const full = node.getFullStart();
        if (!seen.has(full)) {
          seen.add(full);
          for (const r of ts.getLeadingCommentRanges(source, full) ?? []) {
            for (let i = r.pos; i < r.end; i++) marked[i] = 1;
          }
        }
        const end = node.getEnd();
        if (!seen.has(-end - 1)) {
          seen.add(-end - 1);
          // A comment after the last token on a line is TRAILING and belongs to nothing's leading
          // trivia — `"ConsoleWindowClass", // conhost.exe` is the shape.
          for (const r of ts.getTrailingCommentRanges(source, end) ?? []) {
            for (let i = r.pos; i < r.end; i++) marked[i] = 1;
          }
        }
        node.getChildren(file).forEach(visit);
      };
      file.getChildren(file).forEach(visit);
      return marked;
    };
    const tokens = (source: string): string[] => {
      const file = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const out: string[] = [];
      const visit = (node: ts.Node): void => {
        const kids = node.getChildren(file);
        if (kids.length === 0) {
          const text = node.getText(file);
          if (text !== "") out.push(text);
          return;
        }
        kids.forEach(visit);
      };
      file.getChildren(file).forEach(visit);
      return out;
    };

    const files = sourceFiles();
    const disagreed: string[] = [];
    let compared = 0;
    for (const path of files) {
      const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      let marks: Uint8Array;
      try {
        marks = commentRanges(source);
      } catch {
        continue;
      }
      let withoutComments = "";
      for (let i = 0; i < source.length; i++) if (marks[i] === 0) withoutComments += source[i];
      let expectedTokens: string[];
      let ourTokens: string[];
      try {
        expectedTokens = tokens(withoutComments);
        ourTokens = tokens(stripComments(source));
      } catch {
        continue;
      }
      compared++;
      if (expectedTokens.length === ourTokens.length && expectedTokens.every((x, n) => x === ourTokens[n])) continue;
      const k = expectedTokens.findIndex((x, n) => x !== ourTokens[n]);
      disagreed.push(`${path} token ${k}: typescript=${JSON.stringify(expectedTokens.slice(k, k + 4))} ours=${JSON.stringify(ourTokens.slice(k, k + 4))}`);
    }
    expect(compared).toBeGreaterThan(100);
    expect(disagreed).toEqual([]);
  });
});
