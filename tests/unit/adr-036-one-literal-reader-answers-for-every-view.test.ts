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

import { describe, expect, it } from "vitest";

import { literalSpans, literalEnd, significantBefore } from "../../scripts/lib/route-vocabulary.mjs";
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
