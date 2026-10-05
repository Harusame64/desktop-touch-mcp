/**
 * internal #252, gate 2 on #792 — the generator's gate, with a positive control that stays.
 *
 * `generate-stub-tool-catalog.mjs` now refuses to write the catalog when it meets something it
 * cannot read. On a healthy tree nothing triggers that, so a gate that broke would go unnoticed
 * (gate 2 measured exactly this: removing the undefined check, or swallowing a failed
 * description, left the run green). These cells run the real script on a copy of `src/` with one
 * unreadable thing put in, and require a non-zero exit, the reason named, and the catalog
 * untouched. The unmodified copy is the control: it must generate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const script = join(repo, "scripts", "generate-stub-tool-catalog.mjs");
let tree = "";

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "stub-gate-"));
  cpSync(join(repo, "src"), join(tree, "src"), { recursive: true });
});
afterAll(() => {
  if (tree) rmSync(tree, { recursive: true, force: true });
});

function run(): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [script], { cwd: tree, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? "") };
  }
}

/** Replace exactly one occurrence of `from` in `file`, run, restore. */
function withEdit(file: string, from: string, to: string, append = ""): { status: number; stderr: string; catalogKept: boolean } {
  const target = join(tree, "src", "tools", file);
  const catalog = join(tree, "src", "stub-tool-catalog.ts");
  const original = readFileSync(target, "utf8");
  const before = readFileSync(catalog, "utf8");
  const hits = original.split(from).length - 1;
  if (hits !== 1) throw new Error(`${file}: expected one "${from}", found ${hits}`);
  writeFileSync(target, original.replace(from, to) + append);
  try {
    const r = run();
    return { ...r, catalogKept: readFileSync(catalog, "utf8") === before };
  } finally {
    writeFileSync(target, original);
  }
}

describe("the stub catalog generator", () => {
  it("generates from the unmodified copy (control)", () => {
    expect(run().status).toBe(0);
  });

  const CASES: Array<[string, string, string, string, string, string?]> = [
    ["an expression it cannot evaluate", "terminal.ts", '"Hard timeout in ms (default 30s)"', "NOT_DEFINED_ANYWHERE", "NOT_DEFINED_ANYWHERE is not defined"],
    ["an argument that evaluates to undefined", "terminal.ts", ".default(30_000)", ".default(UNDEF_FOR_GATE)", "evaluated to undefined", "\nconst UNDEF_FOR_GATE = undefined;\n"],
    ["a union variant it cannot read", "excel.ts", "  runVbaSchema,", "  makeVariantForGate(),", "cannot read the union variant"],
    ["a spread it cannot expand", "terminal.ts", "    ...terminalSendSchema,", "    ...notDeclaredShapeForGate,", "cannot expand the spread"],
    ["a field given by a name it cannot resolve", "mouse.ts", "const verifyDeliveryParam =", "const verifyDeliveryParamRenamedForGate =", "no rule for the field expression"],
  ];

  for (const [what, file, from, to, reason, append] of CASES) {
    it(`refuses ${what}, says so, and leaves the catalog alone`, () => {
      const r = withEdit(file, from, to, append);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(reason);
      expect(r.stderr).toContain("Nothing was written.");
      expect(r.catalogKept).toBe(true);
    });
  }
});
