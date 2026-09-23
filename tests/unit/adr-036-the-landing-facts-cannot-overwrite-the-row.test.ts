/**
 * The landing facts cannot overwrite the row they are spread into — internal #130, shape ⑧.
 *
 * The road reader is syntax-only (rule 1) and exempts a call's spread, so
 * `probeRoute("keyboard", …, { why, …, ...keyboardLanding(…) })` is read without looking inside
 * `keyboardLanding`. A spread wins over what was written before it: a landing fact named `why` would
 * replace the row's own `why`, and nothing would say so. The user chose (2026-09-23) to have the
 * compiler refuse it: `keyboardLanding` returns `LandingFacts`, which cannot carry any key listed in
 * `RowKeysLandingMayNotWrite`.
 *
 * That list is only right while it names every key the row already has where the landing is spread.
 * This cell reads the executor with the TypeScript parser (not a hand scanner) and derives that set
 * from the producers themselves — the probe row writer's own keys (`aim-probe.ts` `writeRow`),
 * `probeRoute`'s, `probeRefusal`'s, and each object literal that spreads `keyboardLanding(…)` — so a
 * call site that starts writing a new key fails here until the list names it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const PATH = "src/tools/desktop-executor.ts";
const source = parse(PATH);
/** Where every probe row is finally built: `writeRow`'s object, whose keys come before `...data`. */
const probeSource = parse("src/engine/aim-probe.ts");

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/**
 * Property names an object literal writes itself, including a computed name that is a string literal
 * and the literal keys of an inline `...{ … }`. Anything whose name cannot be read here — a computed
 * name from an expression, a spread of anything but the landing call — throws: the cell below
 * cannot vouch for a key it cannot see (gate 2 on #725 measured three such additions passing).
 */
function ownKeys(obj: ts.ObjectLiteralExpression, allowSpreadOf?: string): string[] {
  const out: string[] = [];
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isAccessor(p)) {
      const n = p.name;
      if (ts.isIdentifier(n) || ts.isStringLiteral(n)) out.push(n.text);
      else if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) out.push(n.expression.text);
      else throw new Error(`a key whose name this cell cannot read: ${p.getText()}`);
    } else if (ts.isSpreadAssignment(p)) {
      const e = p.expression;
      if (ts.isObjectLiteralExpression(e)) out.push(...ownKeys(e));
      else if (!(allowSpreadOf && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === allowSpreadOf)) {
        throw new Error(`a spread this cell cannot read: ${p.getText()}`);
      }
    }
  }
  return out;
}

/**
 * The keys a producer writes BEFORE the caller's own object is spread in (`...data` / `...extra`):
 * those are what a later spread can overwrite. Read from every object literal in `fn` that spreads.
 */
function keysBeforeTheCallersSpread(file: ts.SourceFile, fn: string): string[] {
  const keys: string[] = [];
  walk(file, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fn && n.body) {
      walk(n.body, (m) => {
        if (ts.isObjectLiteralExpression(m) && m.properties.some((q) => ts.isSpreadAssignment(q))) {
          for (const q of m.properties) {
            if (ts.isSpreadAssignment(q)) break;
            if ((ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && ts.isIdentifier(q.name)) keys.push(q.name.text);
            else throw new Error(`a producer key this cell cannot read: ${q.getText()}`);
          }
        }
      });
    }
  });
  return keys;
}
const rowWriterKeys = () => keysBeforeTheCallersSpread(probeSource, "writeRow");
const producerKeys = (fn: string) => keysBeforeTheCallersSpread(source, fn);

function listedKeys(): string[] {
  let found: string[] | null = null;
  walk(source, (n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === "RowKeysLandingMayNotWrite" && ts.isUnionTypeNode(n.type)) {
      found = n.type.types.map((t) => {
        if (!ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) throw new Error("the list is not a union of string literals");
        return t.literal.text;
      });
    }
  });
  if (found === null) throw new Error("RowKeysLandingMayNotWrite not found");
  return found;
}

/** Every object literal that spreads `keyboardLanding(…)`, with the keys it writes itself. */
function spreadSites(): Array<{ line: number; keys: string[] }> {
  const sites: Array<{ line: number; keys: string[] }> = [];
  walk(source, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const spreads = n.properties.some((p) =>
      ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression)
      && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === "keyboardLanding");
    if (spreads) sites.push({ line: source.getLineAndCharacterOfPosition(n.getStart()).line + 1, keys: ownKeys(n, "keyboardLanding") });
  });
  return sites;
}

describe("internal #130 ⑧ — the landing facts cannot overwrite the row", () => {
  it("finds the four spread sites the waive row counted, and the producers' own keys", () => {
    expect(spreadSites()).toHaveLength(4);
    expect(producerKeys("probeRoute")).toEqual(["route", "hasAim", "aimHwnd", "entityId", "entityLabel"]);
    expect(producerKeys("probeRefusal")).toEqual(["rung", "refused"]);
    expect(rowWriterKeys()).toEqual(["seq", "tsMs", "pid", "seam"]);
  });

  it("lists every key the row carries before the landing is spread into it", () => {
    const listed = new Set(listedKeys());
    const needed = new Set([...rowWriterKeys(), ...producerKeys("probeRoute"), ...producerKeys("probeRefusal")]);
    for (const site of spreadSites()) for (const k of site.keys) needed.add(k);
    const missing = [...needed].filter((k) => !listed.has(k));
    expect(missing, "a row key a landing fact could overwrite, not refused by LandingFacts").toEqual([]);
  });

  it("keeps the refusal readonly and never-typed: without readonly, `facts.why = undefined` compiles (gate 2)", () => {
    let text: string | null = null;
    walk(source, (n) => {
      if (ts.isTypeAliasDeclaration(n) && n.name.text === "LandingFacts") text = n.type.getText(source);
    });
    expect(text).toBe("Record<string, unknown> & { readonly [K in RowKeysLandingMayNotWrite]?: never }");
  });

  it("types both producers of landing facts with the refusing type", () => {
    for (const fn of ["keyboardLanding", "receiverFacts"]) {
      let returns: string | null = null;
      walk(source, (n) => {
        if (ts.isFunctionDeclaration(n) && n.name?.text === fn && n.type) returns = n.type.getText(source);
      });
      expect(returns, fn).toBe("LandingFacts");
    }
  });
});
