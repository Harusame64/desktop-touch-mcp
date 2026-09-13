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

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Comments carry example imports; they are not edges. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * `import … from "x"`, `export … from "x"`, and bare `import "x"` — across newlines.
 * The clause between the keyword and `from` is captured so a TYPE-ONLY statement can
 * be told apart, and `[^;]` keeps one statement from swallowing the next.
 */
const EDGE = /\b(import|export)\b([^;'"]*?)from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

/** Repo-relative, `/`-spelled, whatever the host separator is. */
function posix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * A clause `tsc` erases entirely: `import type { … }`, or a named list whose every
 * specifier is `type`-prefixed and which has no default/namespace binding beside it.
 * `import Foo, { type Bar }` keeps a value binding and is NOT type-only.
 */
function typeOnly(clause: string): boolean {
  if (/^\s*type\b/.test(clause)) return true;
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced === null) return false; // default or namespace import: a value edge
  const beside = clause.slice(0, braced.index).replace(/[\s,]/g, "");
  if (beside !== "") return false; // a default binding sits outside the braces
  const specs = braced[1]!.split(",").map((x) => x.trim()).filter((x) => x !== "");
  return specs.length > 0 && specs.every((x) => /^type\s/.test(x));
}

interface Reach {
  files: string[];
  /** Relative specifiers no candidate path resolved — an empty set is part of the claim. */
  unresolved: string[];
}

function reach(entry: string): Reach {
  const seen = new Set<string>();
  const unresolved = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = stripComments(readFileSync(join(REPO, file), "utf8"));
    for (const m of src.matchAll(EDGE)) {
      const clause = m[2] ?? "";
      const spec = m[3] ?? m[4];
      if (spec === undefined || !spec.startsWith(".")) continue; // node: and packages are not our graph
      if (typeOnly(clause)) continue; // erased by tsc; costs nothing at load
      const base = posix(normalize(join(dirname(file), spec)));
      const candidates = [
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.mjs$/, ".mts"),
        base.replace(/\.cjs$/, ".cts"),
        `${base}.ts`,
        posix(join(base, "index.ts")),
        base,
      ];
      const hit = candidates.find((c) => existsSync(join(REPO, c)) && c.endsWith(".ts"));
      if (hit === undefined) unresolved.add(`${file} -> ${spec}`);
      else walk(hit); // already repo-relative; `relative("", …)` would drag in the cwd
    }
  };
  walk(entry);
  return { files: [...seen], unresolved: [...unresolved] };
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
    expect(reach(LEAF).files).toEqual([LEAF]);
    // CONTROL 3: a different shape from the walker's, so one broken regex cannot
    // silence both. Any `import` statement at all, and any `from "…"` clause.
    const src = stripComments(readFileSync(join(REPO, LEAF), "utf8"));
    expect(src, "no import statement").not.toMatch(/^\s*import\b/m);
    expect(src, "no from clause").not.toMatch(/\bfrom\s*["']/);
  });
});
