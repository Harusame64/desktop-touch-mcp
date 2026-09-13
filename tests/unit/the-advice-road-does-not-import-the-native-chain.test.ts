/**
 * The advice resolver must stay reachable from the failure road without dragging
 * Windows-native modules behind it.
 *
 * WHY A CELL AND NOT A COMMENT. The only thing the leaf extraction bought is a
 * property of the IMPORT GRAPH, and nothing else in this repo can see it: `tsc`,
 * `eslint` and every existing cell stay green if someone adds
 * `import { … } from "./key-locker-host.js"` to the leaf for a shared constant
 * (gate 2, 2026-09-13). Once the presenter is wired into `_errors.ts`, that import
 * would make every refusal, on every platform, evaluate `engine/win32.ts` — which
 * calls `win32SetProcessDpiAwareness(2)` while it loads.
 *
 * WHY *STATIC* REACHABILITY IS THE RIGHT QUESTION, given that the last step to the
 * addon is dynamic (win2, measured 2026-09-13): the door is outside `dist/` —
 * `engine/native-engine.js` reaches it with `import("../../index.js")` — so a walker
 * that only follows static edges never sees the door itself. It does not need to.
 * **The only road to that dynamic step runs through modules that must be imported
 * statically first**, so cutting one static edge makes the step unreachable from
 * this closure. What this cell measures is a closure, NOT the process: other roots
 * still load the addon, and must.
 *
 * WHAT MAKES THIS EVIDENCE rather than a green light — three controls, because the
 * first version of this cell had one and it was not enough (gate 2, 2026-09-13,
 * second round on this branch):
 *
 *   1. the same walker MUST reach all three native modules from
 *      `key-locker-tool.ts`. A walker that stops resolving reports "clean" for the
 *      advice road and looks exactly like success.
 *   2. every relative specifier it meets MUST resolve. Control 1 travels a different
 *      path from the subject, so a resolution failure confined to the advice road
 *      passes both `not.toContain` assertions **vacuously** while the control stays
 *      green. The first version had exactly that hole: an extensionless import on
 *      the advice road would have been invisible.
 *   3. the leaf's text is checked with a DIFFERENT shape from the walker's. The
 *      first version used the same newline-bounded regex twice and called it two
 *      statements — and both missed a multi-line `import {\n … \n} from "…"`, which
 *      is the dominant style in this repo (52 of 200 files under `src/`) and the
 *      verbatim regression named above. Two statements of one regex are one
 *      statement.
 *
 * TYPE-ONLY edges are NOT followed, in BOTH spellings: `import type { X } from …`
 * and `import { type X } from …` where every specifier carries `type`. tsc erases
 * both, so they cost nothing at module-evaluation time, which is the cost this cell
 * is about. Following them would be wrong in two directions (gate 2, third round on
 * this branch): a free type import on the advice road would redden CI, and the
 * cheapest answer to a false red is deleting the guard — and CONTROL 1 would credit
 * an edge that does not exist at load time, reporting "the walker still works" for a
 * path `tsc` deleted. The inline spelling is already in this repo
 * (`key-locker-capture-driver.ts` → `ssh-session-watch.js`).
 *
 * THE WALKER IS A PARSER, NOT A REGEX — and that is the third fix of one class.
 * A regular expression over TypeScript kept being *nearly* right, and each round
 * found the next spelling it did not model: multi-line imports (gate 1 and gate 2,
 * independently), named type-only specifiers, a semicolon-less type alias merging
 * into the next statement, `import { type as x }` where `type` is the imported
 * VALUE's name and not a modifier, and `createRequire(import.meta.url)("…")`, which
 * loads synchronously while looking nothing like an import. Five spellings in four
 * rounds, every one of them real and every one found by someone else.
 *
 * So the question is asked of the compiler that owns the grammar: `ts.createSourceFile`
 * gives the statements, `importClause.isTypeOnly` and each specifier's `isTypeOnly`
 * say what tsc will erase, and a call expression says what `import(…)` and `require(…)`
 * do. **This is the same lesson as the entity table**: when a rule depends on a
 * grammar, use the grammar's own reader rather than typing what it accepts.
 *
 * WRITING THIS FILE: use a writer that does NOT interpret escapes — a quoted
 * heredoc, an editor, `String.fromCharCode` — never `printf` or a shell-interpolated
 * `node -e`. win2 lost a day's instrument to the other kind on 2026-09-13: a regex
 * meant to say "word boundary" was saved with a literal BACKSPACE in it, so the flag
 * it guarded never fired, and the silence read exactly like "there is nothing here to
 * skip". Four layers did it on one day, including the writer that saved the lesson
 * ABOUT it. The sweep that finds it is
 * `LC_ALL=C grep -rn $'[\x01-\x08\x0b\x0c\x0e-\x1f]'` with a positive control,
 * because a sweep that finds nothing and a sweep that cannot fire look identical.
 *
 * PATHS ARE COMPARED IN POSIX SPELLING. `path.join` answers `src\engine\win32.ts`
 * on Windows, and the literals here are `/`-spelled, so an unnormalised walker is
 * RED on the machine that runs the pre-merge capture — and red on CONTROL 1 first,
 * with the three subject assertions passing vacuously behind it (gate 2, third
 * round; the shape the controls exist for, arriving in the controls' own plumbing).
 * The cell asserts the spelling directly, so the next reader does not have to know.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The edges of one file, as the compiler sees them.
 *
 *  - `import … from "x"` / `export … from "x"` / bare `import "x"` — a value edge
 *    unless tsc erases the whole statement: `import type { … }`, or a named clause
 *    whose every specifier carries `type`. `import { type as x }` is NOT erased —
 *    there `type` is the imported name, which `isTypeOnly` reports correctly and a
 *    regex cannot.
 *  - `import("x")` — a dynamic edge. Reported separately: at the top level it loads
 *    at module evaluation, inside a function it costs nothing until called.
 *  - `require("x")` and `createRequire(…)("x")` — a SYNCHRONOUS edge that looks
 *    nothing like an import and loads its target while the module evaluates.
 */
interface Edges {
  value: string[];
  dynamic: string[];
  require: string[];
}

function edgesOf(file: string): Edges {
  const src = ts.createSourceFile(
    file,
    readFileSync(join(REPO, file), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const out: Edges = { value: [], dynamic: [], require: [] };
  const literal = (n: ts.Node | undefined): string | null =>
    n !== undefined && ts.isStringLiteralLike(n) ? n.text : null;

  // `const req = createRequire(import.meta.url)` then `req("…")` — the common
  // spelling, and the one the first version of this check missed while catching the
  // immediate `createRequire(…)("…")` form. Found by running the mutation instead of
  // reading it: the reviewer's example used the immediate form, real code does not.
  const requireBindings = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "createRequire"
    ) {
      requireBindings.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(src);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null && !erased(node.importClause)) out.value.push(spec);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null && !exportErased(node)) out.value.push(spec);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = literal(node.arguments[0]);
        if (spec !== null) out.dynamic.push(spec);
      } else if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || requireBindings.has(node.expression.text))
      ) {
        const spec = literal(node.arguments[0]);
        if (spec !== null) out.require.push(spec);
      } else if (ts.isCallExpression(node.expression)) {
        // `createRequire(import.meta.url)("…")` — the callee is itself a call.
        const inner = node.expression.expression;
        if (ts.isIdentifier(inner) && inner.text === "createRequire") {
          const spec = literal(node.arguments[0]);
          if (spec !== null) out.require.push(spec);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

/** A whole import statement tsc erases: `import type {…}`, or every specifier `type`. */
function erased(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false; // bare `import "x"` — a side-effect edge
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false; // a default binding is a value
  const named = clause.namedBindings;
  if (named === undefined || !ts.isNamedImports(named)) return false; // `* as ns`
  return named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
}

function exportErased(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

/** Repo-relative, `/`-spelled, whatever the host separator is. */
function posix(p: string): string {
  return p.split(sep).join("/");
}

interface Reach {
  files: string[];
  /** Relative specifiers no candidate path resolved — an empty set is part of the claim. */
  unresolved: string[];
  /** Every dynamic or `require` edge met, with the file that carries it. */
  runtimeEdges: string[];
}

function reach(entry: string): Reach {
  const seen = new Set<string>();
  const unresolved = new Set<string>();
  const runtimeEdges = new Set<string>();
  const resolve = (from: string, spec: string): string | null => {
    const base = posix(normalize(join(dirname(from), spec)));
    const candidates = [
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.mjs$/, ".mts"),
      base.replace(/\.cjs$/, ".cts"),
      `${base}.ts`,
      posix(join(base, "index.ts")),
      base,
    ];
    return candidates.find((c) => existsSync(join(REPO, c)) && c.endsWith(".ts")) ?? null;
  };
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const e = edgesOf(file);
    for (const spec of [...e.dynamic, ...e.require]) {
      if (spec.startsWith(".")) runtimeEdges.add(`${file} -> ${spec}`);
    }
    for (const spec of [...e.value, ...e.require]) {
      if (!spec.startsWith(".")) continue; // node: and packages are not our graph
      const hit = resolve(file, spec);
      if (hit === null) unresolved.add(`${file} -> ${spec}`);
      else walk(hit);
    }
  };
  walk(entry);
  return { files: [...seen], unresolved: [...unresolved], runtimeEdges: [...runtimeEdges] };
}

const NATIVE = [
  "src/engine/win32.ts",
  "src/engine/native-engine.ts",
  "src/engine/key-locker-host.ts",
];
const ADVICE = "src/tools/_advice-capability.ts";
const LEAF = "src/engine/key-locker/key-locker-switch.ts";

describe("the advice road's import graph", () => {
  it("does not reach the Windows-native chain — controls first, because a broken walker looks clean", () => {
    // CONTROL 1: the walker can still find what must be found.
    const locker = reach("src/tools/key-locker-tool.ts");
    for (const n of NATIVE) {
      expect(locker.files, `the walker must still reach ${n} from the locker tool`).toContain(n);
    }

    const advice = reach(ADVICE);

    // CONTROL 2: nothing was skipped on the way. Without this, a specifier the
    // resolver cannot follow makes the claim below pass by seeing nothing.
    expect(advice.unresolved, "every relative import on the advice road must resolve").toEqual([]);
    expect(locker.unresolved, "and on the control's road too").toEqual([]);

    for (const n of NATIVE) {
      expect(advice.files, `the advice road must not reach ${n}`).not.toContain(n);
    }
    // Nor through the manager, which is the module the predicate used to live in.
    expect(advice.files).not.toContain("src/engine/key-locker/key-locker-manager.ts");

    // CONTROL 5: the edges that are not imports. `import("…")` at the top level
    // evaluates its target at module load; `require("…")` and
    // `createRequire(import.meta.url)("…")` do it synchronously while looking nothing
    // like an import (gate 1 and gate 2, 2026-09-13, on two consecutive heads). The
    // parser reports them separately, and the advice closure — three small files —
    // may carry none at all. Deliberately stricter than "top-level only": telling
    // top-level from function-scoped is a judgement, and three files do not need it.
    // The control road is exempt on purpose: `native-engine.ts` reaches the addon
    // with exactly this shape, which is why the door is where it is.
    expect(advice.runtimeEdges, "no dynamic or require edge on the advice road").toEqual([]);

    // CONTROL 4: the spelling itself. On Windows `path.join` answers backslashes, and
    // every assertion above compares against `/`-spelled literals — so without this,
    // the cell is red on the machine that runs the pre-merge capture and the subject
    // assertions pass vacuously behind a red control. Asserted rather than trusted,
    // because this machine cannot produce the failing spelling.
    for (const f of [...advice.files, ...locker.files]) {
      expect(f, `paths must be posix-spelled: ${f}`).not.toMatch(/\\/);
    }
  });

  it("keeps the switch a leaf: the file it lives in imports nothing", () => {
    const leaf = reach(LEAF);
    expect(leaf.files).toEqual([LEAF]);
    expect(leaf.runtimeEdges).toEqual([]);
    expect(edgesOf(LEAF)).toEqual({ value: [], dynamic: [], require: [] });

    // CONTROL 3: a DIFFERENT MECHANISM from the parser, so one broken reader cannot
    // silence both. Text, with comments removed by a rule of its own — if the parser
    // were mis-wired to report nothing, this still sees an import; if this regex is
    // wrong, the parser above still sees one.
    const src = readFileSync(join(REPO, LEAF), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(src, "no import statement").not.toMatch(/^\s*import\b/m);
    expect(src, "no from clause").not.toMatch(/\bfrom\s*["']/);
    expect(src, "no dynamic import or require").not.toMatch(/\b(?:import|require)\s*\(/);
  });
});
