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

describe("a real type in this tree that the scanner asserted the absence of", () => {
  // Found by win2's third instrument — the first two could not see this PR at all, because they
  // import the vocabulary modules and what changed is which reader those modules take. This one
  // puts the two readers side by side over the whole tree: 10,407 questions, 146 answered
  // differently, none of them among the seven the gates actually ask.
  //
  // **`DiagnosticEvent` is 34,041 characters long and `tier` sits on line 1456 of 1457.** The
  // scanner did not merely return a short list: it pushed `has no tier field where one was
  // expected` — a positive claim of absence, about a field that is there. A gate reading this type
  // would have been told the axis has no values rather than told nothing.
  it.each([
    ["tier", ["1", "2", "3", "4"]],
    ["origin", ["background", "per-tool", "watcher"]],
    ["ancestryPidHit", ["recycled", "unverified"]],
    ["consoleHostParentState", ["alive", "gone", "recycled", "unverified"]],
    ["consoleHostParentPidHit", ["recycled", "unverified"]],
  ])("reads DiagnosticEvent.%s, which the scanner reported as absent", (field, expected) => {
    const source = read("src/engine/diagnostic-log.ts");
    const problems: string[] = [];
    expect(readInlineFieldUnion(source, "DiagnosticEvent", field as string, problems)).toEqual(expected);
    expect(problems).toEqual([]);

    const scannerProblems: string[] = [];
    expect(oldReadInlineFieldUnion(source, "DiagnosticEvent", field as string, scannerProblems)).toEqual([]);
    expect(scannerProblems.join("\n")).toContain(`has no ${field} field`);
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

  it.each([
    ['grouped inside a field\'s union', 'export type T =\n  | { why: "a" | ("b" | "c") };\n', ["a", "b", "c"]],
    ["around the whole field", 'export type T =\n  | { why: ("b" | "c") };\n', ["b", "c"]],
    ["around an object member of the outer union", 'export type T =\n  | { why: "a" }\n  | ({ why: "b" });\n', ["a", "b"]],
  ])("reads through parentheses %s", (_label, source, expected) => {
    // **Parentheses are not a type**, they group one. Reading the `ParenthesizedTypeNode` as a
    // member instead of what it wraps returned ["a"] with `problems` EMPTY — a shorter set that
    // looks exactly like a complete one, which is the failure this module exists to end. codex
    // found the first shape; the third is the same node one level out, on the outer union, and no
    // review named it. They are one fix because they are one grammar fact.
    const problems: string[] = [];
    expect(readInlineFieldUnion(source as string, "T", "why", problems)).toEqual(expected);
    expect(problems).toEqual([]);
    expect(oldReadInlineFieldUnion(source as string, "T", "why", [])).toEqual(expected);
  });

  it("unwraps parentheses at any depth, not one level of them", () => {
    // A rule that holds at depth one and not at depth two is a spelling, and this repository's own
    // note is that enumerating spellings does not terminate. `(("b" | "c"))` is legal TypeScript
    // and means what `"b" | "c"` means.
    const problems: string[] = [];
    expect(readUnion('export type T = "a" | (("b" | "c"));\n', "T", () => [], problems)).toEqual(["a", "b", "c"]);
    expect(problems).toEqual([]);
  });

  it.each([
    ["an intersection", 'export type T = ({ tag: "x" } & { why: "a" }) | { why: "b" };\n'],
    ["a wrapper type", 'export type T = Readonly<{ why: "a" }> | { why: "b" };\n'],
  ])("names %s in the outer union instead of skipping it, because it may carry the field", (_label, source) => {
    // codex, round 2, and it is the SAME defect as the parentheses one arriving at its third
    // address: `if (!ts.isTypeLiteralNode(member)) continue;` was a silent skip. The direct object
    // sets `seen`, so the reader answered `["b"]` and reported nothing while the scanner it
    // replaces found both. This parser is syntax-only and will not decide what `A & B` or
    // `Readonly<T>` contains — but it says so, and an unknown reported beats an unknown skipped.
    const problems: string[] = [];
    expect(readInlineFieldUnion(source as string, "T", "why", problems)).toEqual(["b"]);
    expect(problems.join("\n")).toContain("is not an object type this parser reads");
    expect(problems.join("\n")).toContain("is NOT in this answer");
    expect(oldReadInlineFieldUnion(source as string, "T", "why", [])).toEqual(["a", "b"]);
  });

  it.each([
    ["a plain literal", 'export type T =\n  | "a_plain_member"\n  | { why: "from_the_object" };\n', ["from_the_object"]],
    ["undefined", 'export type T = undefined | { why: "b" };\n', ["b"]],
  ])("stays silent about %s, which provably carries no field at all", (_label, source, expected) => {
    // **Not every skip is a silence worth breaking.** A member whose emptiness is a syntactic fact
    // contributes nothing and there is nothing to report; making this noisy too would be a rule
    // that cannot tell "no field here" from "cannot see whether there is a field here", which is
    // the distinction the cells above exist for.
    const problems: string[] = [];
    expect(readInlineFieldUnion(source as string, "T", "why", problems)).toEqual(expected);
    expect(problems).toEqual([]);
  });

  it("says so when a FIELD's member is not a quoted literal, rather than dropping it", () => {
    // The same contract `readUnion` keeps. The reader being replaced drops this one in silence, so
    // this is a place the new reader says MORE than the old one — named here rather than left to
    // be read as a differential surprise.
    const problems: string[] = [];
    expect(readInlineFieldUnion('export type T = { why: "a" | SomeOtherUnion };\n', "T", "why", problems)).toEqual(["a"]);
    expect(problems.join("\n")).toContain("is not a quoted literal this parser reads");
    expect(oldReadInlineFieldUnion('export type T = { why: "a" | SomeOtherUnion };\n', "T", "why", [])).toEqual(["a"]);
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

  it("does not take a type that is declared but not exported, AND says it is there", () => {
    // The scanner searched for the text `export type <name>`; the parser is asked the same question
    // about the node, and a local type alias is a different declaration. **Absent and withheld are
    // different answers** — returning null for both is how a gate is told an axis has no values
    // rather than told nothing, so the null is now preceded by the reason.
    const problems: string[] = [];
    expect(readUnion('type T = "a";\n', "T", () => [], problems)).toBeNull();
    expect(problems.join("\n")).toContain("not exported");
    expect(problems.join("\n")).toContain("read as ABSENT");
  });

  it("says so when the name belongs to an interface rather than a type alias", () => {
    const problems: string[] = [];
    expect(readInlineFieldUnion('export interface T { why: "a" }\n', "T", "why", problems)).toEqual([]);
    expect(problems.join("\n")).toContain("declared as an interface");
  });

  it.each([
    ["an index signature", 'export type T = { [k: string]: "a" } | { why: "b" };\n', "has a name this parser cannot read"],
    ["the field written as a method", "export type T = { why(): void } | { why: \"b\" };\n", "not as a property with a type"],
  ])("names %s inside an object member rather than skipping it", (_label, source, expected) => {
    // The member-level silence had a twin one level further in: an index signature has no name at
    // all, and a method is not a property with a type. Both used to `continue`.
    const problems: string[] = [];
    expect(readInlineFieldUnion(source as string, "T", "why", problems)).toEqual(["b"]);
    expect(problems.join("\n")).toContain(expected as string);
  });

  it("stays silent on a union of plain objects, which is what the gates actually pass", () => {
    // The control for all of the above: every rule added this round must leave a healthy type
    // completely quiet, or the gates fill with noise and stop being read.
    const problems: string[] = [];
    expect(readInlineFieldUnion('export type T = { why: "a" } | { why: "b" };\n', "T", "why", problems)).toEqual(["a", "b"]);
    expect(problems).toEqual([]);
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

  it.each([
    ['an indexed access', 'export type T = "a" | Other["x"];\n', ["a"], ["a", "x"]],
    ["an intersection", 'export type T = "a" | ("b" & "c");\n', ["a"], ["a", "b", "c"]],
  ])("names %s rather than mining a value out of it", (_label, source, expected, whatTheScannerSaid) => {
    // **The scanner did not only lose values, it invented them.** `Other["x"]` is a lookup, not a
    // member, and `"b" & "c"` is one member, not two — both of them fed the completion grid values
    // no caller can ever receive, which inflates a denominator as quietly as a lost member shrinks
    // it. Pinned with the scanner's own answer beside it so the difference is a decision, not drift.
    const problems: string[] = [];
    expect(readUnion(source as string, "T", () => [], problems)).toEqual(expected);
    expect(problems.join("\n")).toContain("is not a quoted literal this parser reads");
    expect(oldReadUnion(source as string, "T", () => [], [])).toEqual(whatTheScannerSaid);
  });

  it("does not reach a field of the same name nested inside another member", () => {
    // "Depth one" was a brace count on a masked copy; here an object type's `members` ARE its
    // depth-one properties, so the nested `why` is not reachable by accident. The scanner captured
    // both — this is the difference named, because the differential on this tree cannot show it.
    const source = 'export type T = { outer: { why: "nested" }, why: "top" };\n';
    expect(readInlineFieldUnion(source, "T", "why", [])).toEqual(["top"]);
    expect(oldReadInlineFieldUnion(source, "T", "why", [])).toEqual(["nested", "top"]);
  });

  it("reports nothing for a file that parses", () => {
    const problems: string[] = [];
    parseSource('export type T = "a";\n', "fine.ts", problems);
    expect(problems).toEqual([]);
  });
});
