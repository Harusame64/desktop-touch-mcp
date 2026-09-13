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
 * WHAT MAKES THIS EVIDENCE rather than a green light: the same walker is pointed at
 * `key-locker-tool.ts`, which MUST reach all three native modules. A walker that
 * silently stops resolving — a changed extension, a moved file, a regex that no
 * longer matches — reports "clean" for the advice road and would look identical to
 * success. The control fails first.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** `import … from "x"`, `export … from "x"`, and bare `import "x"` — static edges only. */
const EDGE = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(join(REPO, file), "utf8");
    for (const m of src.matchAll(EDGE)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined || !spec.startsWith(".")) continue; // node: and packages are not our graph
      const guess = normalize(join(dirname(file), spec)).replace(/\.js$/, ".ts");
      if (existsSync(join(REPO, guess))) walk(guess);
    }
  };
  walk(entry);
  return [...seen].map((f) => relative("", f));
}

const NATIVE = [
  "src/engine/win32.ts",
  "src/engine/native-engine.ts",
  "src/engine/key-locker-host.ts",
];

describe("the advice road's import graph", () => {
  it("does not reach the Windows-native chain — with a control that says the walker can find it", () => {
    // THE CONTROL FIRST, deliberately: if this assertion is the one that fails, the
    // walker is broken and the assertion below means nothing.
    const locker = reachable("src/tools/key-locker-tool.ts");
    for (const n of NATIVE) {
      expect(locker, `the walker must still reach ${n} from the locker tool`).toContain(n);
    }

    const advice = reachable("src/tools/_advice-capability.ts");
    for (const n of NATIVE) {
      expect(advice, `the advice road must not reach ${n}`).not.toContain(n);
    }
    // And it must not get there through the manager either, which is the module the
    // predicate used to live in.
    expect(advice).not.toContain("src/engine/key-locker/key-locker-manager.ts");
  });

  it("keeps the switch a leaf: the file it lives in imports nothing", () => {
    const leaf = "src/engine/key-locker/key-locker-switch.ts";
    expect(reachable(leaf)).toEqual([leaf]);
    // Stated twice on purpose, because the line above would also pass if the walker
    // stopped matching: the file's text carries no import at all.
    const src = readFileSync(join(REPO, leaf), "utf8");
    expect(src).not.toMatch(/(?:^|\n)\s*(?:import|export)\b[^;\n]*\bfrom\b/);
  });
});
