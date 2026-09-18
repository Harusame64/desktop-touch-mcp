/**
 * ADR-036 — the first reader that stopped being a character scanner.
 *
 * `readUnion` and `readInlineFieldUnion` used to find a type declaration's end by counting braces
 * on a masked copy, decide "the next declaration starts here" inside a thirty-nine character
 * window, and cut the field's value out with `[^;{}]`. Every one of those was a defect: the window
 * let the type below join this one's union (#679), the brace count lost a member holding `{` and
 * pulled in the next type's when it held `}` (found on a re-read of the same function after five
 * review rounds had passed over it). They are `ts.createSourceFile` now — a type alias is a node,
 * and its members are a list.
 *
 * **Three kinds of cell, because no one of them is enough here.**
 *
 *  1. *Agreement with the reader being replaced*, over every real input the two gates pass it. On
 *     its own this is the trap this repository has already named — two implementations can be wrong
 *     the same way and the comparison goes quiet.
 *  2. *Behaviour, named*: what a union is, what an unreadable member is, what an absent declaration
 *     is, and what a file that does not parse is.
 *  3. *A producer added to the tree*: a member that exists in neither reader's world until this test
 *     writes it. **This is the only cell that can catch both readers being silent together**, which
 *     is the failure mode (1) cannot see.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  readInlineFieldUnion as oldReadInlineFieldUnion,
  readUnion as oldReadUnion,
} from "../../scripts/lib/route-vocabulary.mjs";
import { parseSource, readInlineFieldUnion, readUnion } from "../../scripts/lib/typescript-source.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

describe("the parser answers what the scanner answered, on the tree's own types", () => {
  const ground = (impl: typeof readUnion, source: string): string[] =>
    impl(source, "KeyboardGround", () => [], []) ?? [];

  it.each([
    ["TouchFailReason", "src/engine/world-graph/guarded-touch.ts"],
    ["KeyboardGround", "src/engine/keyboard-target.ts"],
    ["ExecutorKind", "src/engine/world-graph/types.ts"],
    ["AdvertisedExecutorKind", "src/capabilities/registry.ts"],
  ])("reads %s the same, values and problems", (name, path) => {
    const source = read(path);
    const oldProblems: string[] = [];
    const newProblems: string[] = [];
    expect(readUnion(source, name, () => [], newProblems)).toEqual(oldReadUnion(source, name, () => [], oldProblems));
    expect(newProblems).toEqual(oldProblems);
  });

  it("expands a template member against the union it names, the same way", () => {
    // `` `ground_disabled:${KeyboardGround}` `` is a member, not decoration. Expanding it is a rule
    // about THIS tree, not about the language, so it is rewritten here at the size it had.
    const source = read("src/engine/keyboard-target.ts");
    const oldProblems: string[] = [];
    const newProblems: string[] = [];
    const resolve = (impl: typeof readUnion) => (n: string) => (n === "KeyboardGround" ? ground(impl, source) : []);
    expect(readUnion(source, "LandingWhy", resolve(readUnion), newProblems)).toEqual(
      oldReadUnion(source, "LandingWhy", resolve(oldReadUnion as typeof readUnion), oldProblems),
    );
    expect(newProblems).toEqual(oldProblems);
  });

  it.each([
    ["Homing", "why", "src/engine/aim.ts"],
    ["PointOwner", "why", "src/engine/point-owner.ts"],
  ])("reads %s.%s the same, values and problems", (typeName, field, path) => {
    const source = read(path);
    const oldProblems: string[] = [];
    const newProblems: string[] = [];
    expect(readInlineFieldUnion(source, typeName, field, newProblems)).toEqual(
      oldReadInlineFieldUnion(source, typeName, field, oldProblems),
    );
    expect(newProblems).toEqual(oldProblems);
  });
});

describe("a producer neither reader has seen", () => {
  // **The cell the agreement cells cannot be.** Two implementations can be silent together; a value
  // that exists only because this test wrote it has to be found by both, or one of them is not
  // reading the tree it claims to read.
  it("is found by both readers when a member is added to a real union", () => {
    const source = read("src/engine/world-graph/guarded-touch.ts").replace(
      "export type TouchFailReason =",
      'export type TouchFailReason =\n  | "a_reason_written_only_by_this_test"',
    );
    expect(readUnion(source, "TouchFailReason", () => [], [])).toContain("a_reason_written_only_by_this_test");
    expect(oldReadUnion(source, "TouchFailReason", () => [], [])).toContain("a_reason_written_only_by_this_test");
  });

  it("is found by both readers when a field value is added to a real inline union", () => {
    const source = read("src/engine/point-owner.ts").replace(/\bwhy:\s*"/, 'why:\n        | "a_why_written_only_by_this_test"\n        | "');
    expect(readInlineFieldUnion(source, "PointOwner", "why", [])).toContain("a_why_written_only_by_this_test");
    expect(oldReadInlineFieldUnion(source, "PointOwner", "why", [])).toContain("a_why_written_only_by_this_test");
  });
});

describe("what the parser says, named rather than compared", () => {
  it("reads a member whose text carries braces, which the scanner lost in silence", () => {
    // The defect that survived five review rounds on the function this replaces: the brace count
    // ran on the raw text, so `"{tool:x}"` ended the type early. There is no brace count now.
    const source = 'export type T = "a" | "{tool:x}" | "}";\nexport type Other = "not_mine";\n';
    expect(readUnion(source, "T", () => [], [])).toEqual(["a", "{tool:x}", "}"]);
  });

  it("stops at the declaration, whatever sits between it and the next one", () => {
    // The thirty-nine character window is gone with the scanner. Whitespace between two tokens has
    // no length, and the declaration is a node either way.
    const source = `export type T = "a";\nexport${" ".repeat(400)}type Other = "not_mine";\n`;
    expect(readUnion(source, "T", () => [], [])).toEqual(["a"]);
  });

  it("reads an inline union whose members are not all objects", () => {
    // Found by a mutation that every other cell survived: dropping the "is this an object type"
    // guard changed nothing, because `Homing` and `PointOwner` are unions of objects all the way
    // through and the guard never fired on a real input. A member that is not an object has no
    // `members` to walk, so without the guard this throws rather than answering.
    const source = 'export type T =\n  | "a_plain_member"\n  | { why: "from_the_object" };\n';
    expect(readInlineFieldUnion(source, "T", "why", [])).toEqual(["from_the_object"]);
    expect(oldReadInlineFieldUnion(source, "T", "why", [])).toEqual(["from_the_object"]);
  });

  it("says so when a member is not a quoted literal", () => {
    const problems: string[] = [];
    expect(readUnion('export type T = "a" | SomeOtherUnion;\n', "T", () => [], problems)).toEqual(["a"]);
    expect(problems.join("\n")).toContain("is not a quoted literal this parser reads");
  });

  it("says so when a template member names a union it cannot resolve", () => {
    const problems: string[] = [];
    readUnion("export type T = `p:${Unknown}`;\n", "T", () => [], problems);
    expect(problems.join("\n")).toContain("cannot resolve the template member");
  });

  it("returns null for a declaration that is not there, and says so for the inline form", () => {
    expect(readUnion('export type T = "a";\n', "Absent", () => [], [])).toBeNull();
    const problems: string[] = [];
    expect(readInlineFieldUnion('export type T = { why: "a" };\n', "Absent", "why", problems)).toEqual([]);
    expect(problems.join("\n")).toContain("not found");
  });

  it("does not take a type that is declared but not exported", () => {
    // The scanner searched for the text `export type <name>`; the parser is asked the same question
    // about the node, and a local type alias is a different declaration.
    expect(readUnion('type T = "a";\n', "T", () => [], [])).toBeNull();
  });

  it("REPORTS A FILE THAT DID NOT PARSE, and still returns what it could", () => {
    // **`ts.createSourceFile` never throws.** It returns a tree with fewer nodes in it, which is the
    // silent under-read this whole effort is against, one level up: the answer would simply be
    // shorter and nothing would say why. Every entry point reports the diagnostics instead.
    const problems: string[] = [];
    const values = readUnion('export type T = "a" | "b";\nfunction broken( {\n', "T", () => [], problems, "broken.ts");
    expect(values).toEqual(["a", "b"]);
    expect(problems.join("\n")).toContain("did not parse");
    expect(problems.join("\n")).toContain("LOWER BOUND");
  });

  it("reports nothing for a file that parses", () => {
    const problems: string[] = [];
    parseSource('export type T = "a";\n', "fine.ts", problems);
    expect(problems).toEqual([]);
  });
});
