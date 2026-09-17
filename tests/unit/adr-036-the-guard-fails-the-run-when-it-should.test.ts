/**
 * ADR-036 `internal#119` — does `check:native-types` FAIL when it should?
 *
 * **Every other cell in this suite drives the recognizer directly, and that is a blind spot the
 * size of the product.** The wiring round put it plainly: nothing in `tests/` ran the script, so
 * when every problem `parseNapiFunctions` produced was collected into a variable that was never
 * printed and never failed the run, the whole suite stayed green — and would have stayed green if
 * the printing were deleted again. The defects of the last two rounds were all found by running the
 * script by hand.
 *
 * So these cells run it: a fixture tree in a temp directory, one mutation at a time, asserting the
 * EXIT CODE and the text of the finding. A diagnosis that does not reach stderr and the exit code
 * has not reached anybody.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
let root = "";

/** The smallest tree the guard accepts: one struct, one function that returns it, both declared. */
function writeFixture(over: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "src/lib.rs": `use napi_derive::napi;

#[napi(object)]
pub struct Thing {
    pub alpha: String,
    pub beta: Option<u32>,
}

#[napi(object)]
pub struct Opts {
    pub win: String,
}

#[napi]
pub fn make_thing() -> Thing {
    Thing { alpha: String::new(), beta: None }
}

#[napi]
pub fn take_opts(opts: Opts) -> u32 {
    1
}
`,
    "index.d.ts": `export interface NativeThing {
  alpha: string
  beta?: number
}
export declare function makeThing(): NativeThing
export declare function takeOpts(opts: { win: string }): number
`,
    "index.js": `export const makeThing = nativeBinding.makeThing;
export const takeOpts = nativeBinding.takeOpts;
`,
    "src/engine/native-types.ts": `export interface NativeThing {
  alpha: string
  beta?: number
}
`,
  };
  for (const [path, body] of Object.entries({ ...files, ...over })) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
}

function run(): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", "check-native-types.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "native-types-guard-"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  cpSync(join(REPO, "scripts", "check-native-types.mjs"), join(root, "scripts", "check-native-types.mjs"));
  cpSync(join(REPO, "scripts", "lib", "napi-shapes.mjs"), join(root, "scripts", "lib", "napi-shapes.mjs"));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the guard's exit code", () => {
  it("is 0 on a tree that agrees, and says what it compared", () => {
    writeFixture();
    const { status, out } = run();
    expect(out).toMatch(/OK —/);
    expect(status).toBe(0);
  });

  it("is 1 when the published typings are missing a field the addon sends", () => {
    // The #667 defect itself, in one line.
    writeFixture({
      "index.d.ts": `export interface NativeThing {
  alpha: string
}
export declare function makeThing(): NativeThing
export declare function takeOpts(opts: { win: string }): number
`,
    });
    const { status, out } = run();
    expect(out).toMatch(/is missing `beta`/);
    expect(status).toBe(1);
  });

  it("is 1 for an export nobody declared", () => {
    writeFixture();
    writeFixture({
      "src/extra.rs": `use napi_derive::napi;

#[napi]
pub fn undeclared_export(x: u32) -> u32 {
    x
}
`,
    });
    const { status, out } = run();
    expect(out).toMatch(/undeclaredExport/);
    expect(status).toBe(1);
  });

  it("is 1 for an item the parser cannot read — the wiring case", () => {
    // **This is the cell the wiring round asked for.** The problem was produced, collected, and
    // dropped; the run printed OK. Nothing in the suite could see it, because nothing ran the
    // script.
    writeFixture();
    writeFixture({
      "src/extra.rs": `use napi_derive::napi;

#[napi]
pub fn generic_head<T: Into<String>>(x: u32) -> u32 {
    x
}
`,
    });
    const { status, out } = run();
    expect(out).toMatch(/cannot read the item/);
    expect(status).toBe(1);
  });

  it("is 1 for an export hidden behind an aliased attribute", () => {
    writeFixture();
    writeFixture({
      "src/extra.rs": `pub(crate) use napi_derive::napi as na;

#[na]
pub fn hidden_by_alias(x: u32) -> u32 {
    x
}
`,
    });
    const { status, out } = run();
    expect(out).toMatch(/hiddenByAlias/);
    expect(status).toBe(1);
  });

  it("is 1 when a comma-separated inline parameter declares a field Rust does not have", () => {
    writeFixture({
      "index.d.ts": `export interface NativeThing {
  alpha: string
  beta?: number
}
export declare function makeThing(): NativeThing
export declare function takeOpts(opts: { win: string, bogus: number }): number
`,
    });
    const { status, out } = run();
    expect(out).toMatch(/bogus/);
    expect(status).toBe(1);
  });
});
