/**
 * ADR-036 — the CONFIGURATION axis of the completion grid, and the shapes that hide from it.
 *
 * The road axis got its extractor in #669. This is the second of the three denominators, and it
 * repeats the lesson that one cost five rounds over there: **a sweep that sees one shape returns a
 * set that looks complete.** Counted on `06a66999`, the product reads 75 switches from four roots
 * in six syntactic shapes, and `process.env.NAME` under `src/` finds fewer than two thirds — the
 * eleven it misses include the two the map says define the grid (`DISABLE_NATIVE_UIA`, which makes
 * native UIA's third value, and `KEYBOARD_RUNG_UNCHECKED`, which deletes a column).
 *
 * Every cell below pins a shape that was found by WIDENING the sweep, not by thinking harder about
 * it. That is the honest order: the names came from the tree, not from a list anybody remembered.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readDocumentedSwitches,
  readSwitchesFromRust,
  readSwitchesFromTypeScript,
} from "../../scripts/lib/config-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the extractor", () => {
  it("reads a switch through every shape the product actually uses", () => {
    // Six shapes, five of them in TypeScript. The middle three are the ones a `process.env.` sweep
    // cannot see, and they are where the testable switches live: half the engine takes the
    // environment as an argument (`readKeyboardRungSwitch(env = process.env)`) precisely so cells
    // can drive it, which is exactly why the sweep that misses it misses those.
    const { names } = readSwitchesFromTypeScript(`
      const a = process.env.DESKTOP_TOUCH_SHAPE_ONE;
      const b = process.env["DESKTOP_TOUCH_SHAPE_TWO"];
      function f(env) { return env.DESKTOP_TOUCH_SHAPE_THREE ?? env["DESKTOP_TOUCH_SHAPE_FOUR"]; }
      const KEY = "DESKTOP_TOUCH_SHAPE_FIVE";
      const c = process.env[KEY];
    `);
    expect(names).toEqual([
      "DESKTOP_TOUCH_SHAPE_FIVE",
      "DESKTOP_TOUCH_SHAPE_FOUR",
      "DESKTOP_TOUCH_SHAPE_ONE",
      "DESKTOP_TOUCH_SHAPE_THREE",
      "DESKTOP_TOUCH_SHAPE_TWO",
    ]);
  });

  it("keeps the operating system's environment out of the axis", () => {
    // `LOCALAPPDATA` and friends are read too, and they are not dimensions: nothing the product
    // does chooses them. Folding them in would inflate the denominator with slots no cell could
    // ever fill, and a grid with permanently unreachable slots is one nobody reads.
    const { names, platform } = readSwitchesFromTypeScript(`
      const home = process.env.LOCALAPPDATA;
      const which = process.env["PROGRAMFILES(X86)"];
      const ours = process.env.DTM_BG_AUTO;
    `);
    expect(names).toEqual(["DTM_BG_AUTO"]);
    expect(platform).toEqual(["LOCALAPPDATA", "PROGRAMFILES(X86)"]);
  });

  it("reports a lookup whose key it cannot name, instead of returning a shorter set", () => {
    // The whole failure this file exists to end: a key the parser cannot resolve contributes
    // nothing and says nothing, so the axis comes back complete-looking and one dimension short.
    const problems: string[] = [];
    readSwitchesFromTypeScript(`function f(k) { return process.env[k]; }`, "x.ts", problems);
    expect(problems).toEqual(["x.ts: a switch is read through a key this parser cannot name: env[k]"]);
  });

  it("recognises the one dynamic lookup that is not a switch at all", () => {
    // `launch.ts` expands `%VAR%` tokens out of a REG_EXPAND_SZ registry value, so the key belongs
    // to the REGISTRY, not to us: it reads arbitrary environment and contributes no dimension.
    // Recognised narrowly — by the `%…%` replace on the same line — so any other dynamic key still
    // surfaces. (The road axis learned the same distinction for `homing.why`.)
    const problems: string[] = [];
    readSwitchesFromTypeScript(
      `const expanded = raw.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);`,
      "launch.ts",
      problems,
    );
    expect(problems).toEqual([]);
  });

  it("reads the addon's own switches, which no TypeScript sweep can see", () => {
    // Three switches are read only by Rust under `src/`, and four more by a separate crate. They
    // carry the axis's one lattice constraint: **a switch only the addon reads cannot be exercised
    // in a build with no addon**, so they are not a free dimension to multiply by.
    const problems: string[] = [];
    expect(
      readSwitchesFromRust(
        `let a = std::env::var("DESKTOP_TOUCH_RING_CAPACITY");
         let b = std::env::var("PATH");`,
        "ring.rs",
        problems,
      ),
    ).toEqual(["DESKTOP_TOUCH_RING_CAPACITY"]);
    expect(problems).toEqual([]);
    readSwitchesFromRust(`let c = std::env::var(name_from_somewhere);`, "ring.rs", problems);
    expect(problems.join("")).toMatch(/cannot name: std::env::var\(name_from_somewhere\)/);
  });

  it("tells a tombstone apart from a documented switch", () => {
    // A removed switch KEEPS its name in the README on purpose: a user whose config still sets it
    // needs to be told it does nothing. A sweep that cannot tell the two apart reports every
    // tombstone as a lie, and a gate that cries wolf on day one is a gate somebody turns off.
    const { documented, tombstoned } = readDocumentedSwitches(`
| \`DESKTOP_TOUCH_LIVE_KNOB\` | off | does a thing |

### Removed: \`DESKTOP_TOUCH_OLD_KNOB\`

This was the opt-in in v0.16.x and has no effect now.
    `);
    expect(documented).toEqual(["DESKTOP_TOUCH_LIVE_KNOB"]);
    expect(tombstoned).toEqual(["DESKTOP_TOUCH_OLD_KNOB"]);
  });

  it("reads the real tree, and the count is the one the grid pins", () => {
    // Here so a change to the EXTRACTOR shows up next to a change to the code. The numbers are the
    // ones the extraction produced on 2026-09-17 and that the pinned file carries.
    const pinned = JSON.parse(readFileSync(join(REPO, "tests/fixtures/adr-036-config-vocabulary.json"), "utf8"));
    expect(Object.keys(pinned.readIn).length).toBe(75);
    // The two the map says define the grid, and neither is reachable through `process.env.NAME`.
    expect(pinned.readIn["DESKTOP_TOUCH_DISABLE_NATIVE_UIA"]).toEqual(["src:ts"]);
    expect(pinned.readIn["DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED"]).toEqual(["src:ts"]);
    expect(pinned.roles["DESKTOP_TOUCH_DISABLE_NATIVE_UIA"]).toBe("axis");
    // The launcher is a different process from the server and reads its own switches: a sweep of
    // `src/` alone misses the only three an end user is told to set during install.
    expect(pinned.readIn["DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED"]).toEqual(["bin:ts"]);
  });
});

describe("the check's exit code", () => {
  let root = "";

  const write = (rel: string, body: string) => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };

  const run = (): { status: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [join(root, "scripts", "check-config-vocabulary.mjs")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { status: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  /** The smallest tree the check accepts: one switch in each language, and a README that names one. */
  const fixture = (over: Record<string, string> = {}) => {
    const files: Record<string, string> = {
      "src/server.ts": `const a = process.env.DESKTOP_TOUCH_LIVE_KNOB;\n`,
      "src/win32/ring.rs": `fn f() { let _ = std::env::var("DESKTOP_TOUCH_RING_CAPACITY"); }\n`,
      "README.md": "| `DESKTOP_TOUCH_LIVE_KNOB` | off | does a thing |\n",
    };
    for (const [path, body] of Object.entries({ ...files, ...over })) write(path, body);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "config-vocabulary-"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
    cpSync(join(REPO, "scripts", "check-config-vocabulary.mjs"), join(root, "scripts", "check-config-vocabulary.mjs"));
    cpSync(join(REPO, "scripts", "lib", "config-vocabulary.mjs"), join(root, "scripts", "lib", "config-vocabulary.mjs"));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const pin = () => {
    writeFileSync(
      join(root, "tests/fixtures/adr-036-config-vocabulary.json"),
      `${JSON.stringify({ readIn: {}, roles: {}, documented: [], tombstoned: [] })}\n`,
    );
    execFileSync(process.execPath, [join(root, "scripts", "check-config-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
  };

  it("is 0 when the pinned axis matches the code", () => {
    fixture();
    pin();
    expect(run().status).toBe(0);
  });

  it("is 1 when a switch is added in any of the shapes", () => {
    // One cell per shape would say the same thing five times; what matters is that the pin catches
    // an addition made the way a real one would be made — and the shapes themselves are pinned by
    // the extractor cell above.
    for (const [file, body] of [
      ["src/added-one.ts", `const x = process.env.DESKTOP_TOUCH_ADDED_ONE;\n`],
      ["src/added-two.ts", `function f(env) { return env["DESKTOP_TOUCH_ADDED_TWO"]; }\n`],
      ["src/added-three.ts", `const K = "DESKTOP_TOUCH_ADDED_THREE";\nconst y = process.env[K];\n`],
      ["src/win32/added.rs", `fn g() { let _ = std::env::var("DESKTOP_TOUCH_ADDED_FOUR"); }\n`],
    ] as const) {
      fixture();
      pin();
      write(file, body);
      const { status, out } = run();
      expect(status, file).toBe(1);
      expect(out, file).toMatch(/the code now reads DESKTOP_TOUCH_ADDED_/);
      rmSync(join(root, file));
    }
  });

  it("is 1 when a switch moves to another process", () => {
    // **The reading site is part of the fact, not decoration.** The launcher and the server are
    // different processes; a switch that starts being read by both has changed what a run can be
    // configured with, and the name alone cannot say so.
    fixture();
    pin();
    write("bin/launcher.js", `const x = process.env.DESKTOP_TOUCH_LIVE_KNOB;\n`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/DESKTOP_TOUCH_LIVE_KNOB is read from bin:ts, src:ts, where the grid says src:ts/);
    rmSync(join(root, "bin/launcher.js"));
  });

  it("is 1 when a removed switch loses its tombstone", () => {
    // Removing the read without leaving the tombstone turns a switch that did something into a
    // switch that silently does nothing, for every user whose config still sets it.
    fixture();
    pin();
    const path = join(root, "tests/fixtures/adr-036-config-vocabulary.json");
    const pinned = JSON.parse(readFileSync(path, "utf8"));
    pinned.roles["DESKTOP_TOUCH_GONE_KNOB"] = "removed";
    writeFileSync(path, `${JSON.stringify(pinned)}\n`);
    expect(run().out).toMatch(/DESKTOP_TOUCH_GONE_KNOB was removed with no tombstone/);

    write("README.md", "| `DESKTOP_TOUCH_LIVE_KNOB` | off |\n\n### Removed: `DESKTOP_TOUCH_GONE_KNOB`\n");
    expect(run().status).toBe(0);
  });

  it("is 1 when the README documents a switch nothing reads", () => {
    fixture();
    pin();
    write("README.md", "| `DESKTOP_TOUCH_LIVE_KNOB` | off |\n| `DESKTOP_TOUCH_PHANTOM` | off |\n");
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/README\.md documents DESKTOP_TOUCH_PHANTOM, which nothing reads/);
  });

  it("is 1 when an addon-only switch is given a role that implies a build can reach it", () => {
    // The lattice constraint. `native` is not a label for tidiness: it is the statement that this
    // dimension does not exist in a build with no addon, so multiplying by it would count cells
    // that cannot be run.
    fixture();
    pin();
    const path = join(root, "tests/fixtures/adr-036-config-vocabulary.json");
    const pinned = JSON.parse(readFileSync(path, "utf8"));
    expect(pinned.roles["DESKTOP_TOUCH_RING_CAPACITY"]).toBe("unclassified");
    pinned.roles["DESKTOP_TOUCH_RING_CAPACITY"] = "axis";
    writeFileSync(path, `${JSON.stringify(pinned)}\n`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/is read only by the addon \(src:rs\), so its role should be "native"/);
  });

  it("refuses to re-pin while a lookup cannot be named", () => {
    // Re-pinning over an unreadable tree writes the SHORT set into the grid, and the grid is then
    // the thing everyone trusts. Same refusal as the road axis.
    fixture();
    pin();
    const path = join(root, "tests/fixtures/adr-036-config-vocabulary.json");
    const before = readFileSync(path, "utf8");
    write("src/dynamic.ts", `function f(k) { return process.env[k]; }\n`);
    let status = 0;
    try {
      execFileSync(process.execPath, [join(root, "scripts", "check-config-vocabulary.mjs"), "--update"], {
        stdio: "ignore",
      });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    rmSync(join(root, "src/dynamic.ts"));
  });
});
