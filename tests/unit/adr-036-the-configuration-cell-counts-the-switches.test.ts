/**
 * ADR-036 — the CONFIGURATION axis of the completion grid, and the shapes that hide from it.
 *
 * The road axis got its extractor in #669. This is the second of the three denominators, and it
 * repeats the lesson that one cost five rounds over there: **a sweep that sees one shape returns a
 * set that looks complete.** Counted on `06a66999`, the product reads **79** switches from six
 * places in **four languages**, and `process.env.NAME` under `src/` — the sweep anybody would write
 * first — finds **41**. Among the 38 it misses are the two the map says define the grid
 * (`DISABLE_NATIVE_UIA`, which makes native UIA's third value, and `KEYBOARD_RUNG_UNCHECKED`, which
 * deletes a column), and the three the launcher reads during install.
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
  readSwitchesFromCSharp,
  readSwitchesFromRust,
  readSwitchesFromScript,
} from "../../scripts/lib/config-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the extractor", () => {
  it("reads a switch through every shape the product actually uses", () => {
    // Six shapes, five of them in TypeScript. The middle three are the ones a `process.env.` sweep
    // cannot see, and they are where the testable switches live: half the engine takes the
    // environment as an argument (`readKeyboardRungSwitch(env = process.env)`) precisely so cells
    // can drive it, which is exactly why the sweep that misses it misses those.
    const { read } = readSwitchesFromScript(`
      const a = process.env.DESKTOP_TOUCH_SHAPE_ONE;
      const b = process.env["DESKTOP_TOUCH_SHAPE_TWO"];
      function f(env: NodeJS.ProcessEnv) { return env.DESKTOP_TOUCH_SHAPE_THREE ?? env["DESKTOP_TOUCH_SHAPE_FOUR"]; }
      const KEY = "DESKTOP_TOUCH_SHAPE_FIVE";
      const c = process.env[KEY];
    `);
    expect(read).toEqual([
      "DESKTOP_TOUCH_SHAPE_FIVE",
      "DESKTOP_TOUCH_SHAPE_FOUR",
      "DESKTOP_TOUCH_SHAPE_ONE",
      "DESKTOP_TOUCH_SHAPE_THREE",
      "DESKTOP_TOUCH_SHAPE_TWO",
    ]);
  });

  it("does not treat an identifier named `env` as an environment", () => {
    // **The rule that the prefix filter was hiding.** `guarded-touch.ts` has
    // `private readonly env: TouchEnvironment` — a dependency bag — and the first version read
    // thirteen of its METHOD NAMES as switches. They were invisible only because a
    // `DESKTOP_TOUCH_|DTM_` prefix threw them away, so the prefix was load-bearing for CORRECTNESS
    // while it was documented as classification. An environment is recognised by its BINDING now.
    const bag = readSwitchesFromScript(`
      class Touch {
        constructor(private readonly env: TouchEnvironment) {}
        run() { return this.env.resolveLiveEntities() && env.findBlockingModal(); }
      }
    `);
    expect(bag.read).toEqual([]);

    // Both spellings of a real one: the annotation, and the default. Eight sites in the tree spell
    // the type structurally (`Record<string, string | undefined> = process.env`), and a rule that
    // asked for `NodeJS.ProcessEnv` dropped the two switches those sites read.
    const annotated = readSwitchesFromScript(`function f(env: NodeJS.ProcessEnv) { return env.DESKTOP_TOUCH_A; }`);
    const defaulted = readSwitchesFromScript(
      `function g(env: Record<string, string | undefined> = process.env) { return env["DESKTOP_TOUCH_B"]; }`,
    );
    expect(annotated.read).toEqual(["DESKTOP_TOUCH_A"]);
    expect(defaulted.read).toEqual(["DESKTOP_TOUCH_B"]);
  });

  it("does not let an annotation's comma swallow the parameter before it", () => {
    // `resolveCaptureFile(captureId: string, env: NodeJS.ProcessEnv = process.env)` — the
    // annotation `Record<string, string | undefined>` carries a COMMA, so a regex that read
    // leftwards through it made `captureId` an environment and put `length` and `some` in the axis.
    // The binding name is scanned to its real separator now.
    const v = readSwitchesFromScript(
      `export function f(captureId: string, env: NodeJS.ProcessEnv = process.env) {
         return captureId.length > 0 ? env.DESKTOP_TOUCH_REAL : null;
       }`,
    );
    expect(v.read).toEqual(["DESKTOP_TOUCH_REAL"]);
  });

  it("does not call an assignment a read", () => {
    // The axis is what a run can be configured WITH. `injector.ts` SETS `DTM_GIT_USERNAME` for a
    // child process; counting that as a read pinned the switch at a site that never looks at it,
    // while its real reader — a C# file — was outside the walk entirely.
    const v = readSwitchesFromScript(
      `const child = { ...process.env };
       child.DTM_GIT_USERNAME = user;
       const back = child.DTM_GIT_USERNAME;`,
    );
    expect(v.written).toEqual(["DTM_GIT_USERNAME"]);
    expect(v.read).toEqual(["DTM_GIT_USERNAME"]);
    const writeOnly = readSwitchesFromScript(`const c = { ...process.env }; c.DTM_ONLY_WRITTEN = "1";`);
    expect(writeOnly.written).toEqual(["DTM_ONLY_WRITTEN"]);
    expect(writeOnly.read).toEqual([]);
  });

  it("reads the C# side tools, which ship as executables the server spawns", () => {
    // Leaving `.cs` out of the walk cost two dimensions outright (`DTM_LOCKER_PIPE`,
    // `DTM_ASKPASS_TICKET`) and mis-sited a third.
    const problems: string[] = [];
    expect(
      readSwitchesFromCSharp(
        `var pipe = Environment.GetEnvironmentVariable("DTM_LOCKER_PIPE");
         var who = Environment.GetEnvironmentVariable(fromSomewhereElse);`,
        "Program.cs",
        problems,
      ),
    ).toEqual(["DTM_LOCKER_PIPE"]);
    expect(problems.join("")).toMatch(/cannot name: GetEnvironmentVariable\(fromSomewhereElse\)/);
  });

  it("escapes a holder's name before building a pattern out of it", () => {
    // CodeQL caught this on #670 (`js/incomplete-sanitization`, high): the holder names go into a
    // regex and only `$` was escaped — the one metacharacter a JS identifier can legally carry.
    // The names come out of source text this parser does not control, so a fragment carrying `.`
    // or `(` would have built a pattern matching something else entirely, silently, and the axis
    // would come back WRONG rather than short. Same family as every other finding this week: a
    // rule narrowed to the case its author pictured.
    const v = readSwitchesFromScript(
      `const a.b = process.env;
       const env: NodeJS.ProcessEnv = process.env;
       const x = env.DESKTOP_TOUCH_STILL_FOUND;`,
    );
    expect(v.read).toContain("DESKTOP_TOUCH_STILL_FOUND");
    // A `$` in a real identifier still works — that is what the original escape was for.
    expect(readSwitchesFromScript(`const $env: NodeJS.ProcessEnv = process.env; const y = $env.DTM_X;`).read).toEqual([
      "DTM_X",
    ]);
  });

  it("keeps a `//` inside a string from eating the rest of the line", () => {
    // A URL is the ordinary way this happens, and the loss was silent — `problems` empty.
    const v = readSwitchesFromScript(`fetch("http://host", { h: process.env.DESKTOP_TOUCH_TOKEN });`);
    expect(v.read).toEqual(["DESKTOP_TOUCH_TOKEN"]);
  });

  it("reports a lookup whose key it cannot name, instead of returning a shorter set", () => {
    // The whole failure this file exists to end: a key the parser cannot resolve contributes
    // nothing and says nothing, so the axis comes back complete-looking and one dimension short.
    const problems: string[] = [];
    readSwitchesFromScript(`function f(k) { return process.env[k]; }`, "x.ts", problems);
    expect(problems).toEqual(["x.ts: a switch is read through a key this parser cannot name: env[k]"]);
  });

  it("exempts a dynamic key only where a human wrote the exemption down", () => {
    // **The exemption is a list, not a pattern.** The first version recognised the one legitimate
    // dynamic lookup by the TEXT OF ITS LINE — a `%…%` replace nearby — which is an exemption keyed
    // on a spelling, the exact shape gate 2 closed on the road axis one week earlier. Any line that
    // happened to carry a regex literal like `/%(` swallowed its own dynamic key in silence.
    const src = `const expanded = raw.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);`;
    const unlisted: string[] = [];
    readSwitchesFromScript(src, "src/utils/launch.ts", unlisted, []);
    expect(unlisted.join("")).toMatch(/cannot name: env\[name\]/);

    const listed: string[] = [];
    readSwitchesFromScript(src, "src/utils/launch.ts", listed, ["src/utils/launch.ts:name"]);
    expect(listed).toEqual([]);

    // The listing is per file AND per identifier, so the same name elsewhere still surfaces.
    const elsewhere: string[] = [];
    readSwitchesFromScript(`const v = process.env[name];`, "src/other.ts", elsewhere, ["src/utils/launch.ts:name"]);
    expect(elsewhere.join("")).toMatch(/cannot name: env\[name\]/);
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
    ).toEqual(["DESKTOP_TOUCH_RING_CAPACITY", "PATH"]); // membership is decided by the pinned platform list, not here
    expect(problems).toEqual([]);

    // **Every spelling, because `use std::env;` is one refactor away from the tree's 21
    // fully-qualified sites.** A reader anchored on `std::env::var` would have gone silent for all
    // of them at once, with `problems` empty — the set coming back short and looking complete.
    expect(readSwitchesFromRust(`use std::env;\nlet a = env::var("DESKTOP_TOUCH_QUALIFIED_OFF");`)).toEqual([
      "DESKTOP_TOUCH_QUALIFIED_OFF",
    ]);
    expect(readSwitchesFromRust(`use std::env::var;\nlet a = var("DESKTOP_TOUCH_BARE");`)).toEqual([
      "DESKTOP_TOUCH_BARE",
    ]);
    // A bare `var(` with no such import is somebody else's function, not an environment read.
    expect(readSwitchesFromRust(`let a = var("NOT_AN_ENV_READ");`)).toEqual([]);

    // Comments are claims, not reads — including the trailing and block forms, which the first
    // version left in and pinned as switches the code does not read.
    expect(readSwitchesFromRust(`fn f() {} // std::env::var("DESKTOP_TOUCH_GHOST")`)).toEqual([]);
    expect(readSwitchesFromRust(`/* std::env::var("DESKTOP_TOUCH_GHOST2") */`)).toEqual([]);
    // And a call quoted INSIDE a string — an error message telling the user what to set is exactly
    // that shape — used to raise a permanent false problem, so `--update` could never re-pin again.
    const quoted: string[] = [];
    expect(readSwitchesFromRust(`let msg = "set it with std::env::var(\\"DESKTOP_TOUCH_GHOST3\\")";`, "a.rs", quoted)).toEqual([]);
    expect(quoted).toEqual([]);

    readSwitchesFromRust(`let c = std::env::var(name_from_somewhere);`, "ring.rs", problems);
    expect(problems.join("")).toMatch(/cannot name/);
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

    // **A heading can bury two names.** The first version `continue`d on the heading, so the second
    // name landed in NEITHER set: if it was marked removed the guard cried "no tombstone" against a
    // README that plainly had one, and if it was still read the README documented it invisibly.
    expect(readDocumentedSwitches("### Removed: `DESKTOP_TOUCH_A` and `DESKTOP_TOUCH_B`").tombstoned).toEqual([
      "DESKTOP_TOUCH_A",
      "DESKTOP_TOUCH_B",
    ]);

    // A heading inside a fenced block is an EXAMPLE of a tombstone, not one.
    expect(readDocumentedSwitches("```\n### Removed: `DESKTOP_TOUCH_C`\n```").tombstoned).toEqual([]);

    // **The Japanese page writes `削除済み:`.** With only the English spelling its tombstone could
    // never match, so a switch buried there would read as documented-but-unread forever — and a fix
    // found in one language does not propagate by itself.
    expect(readDocumentedSwitches("### 削除済み: `DESKTOP_TOUCH_JA_KNOB`").tombstoned).toEqual([
      "DESKTOP_TOUCH_JA_KNOB",
    ]);
  });

  it("runs the extraction over the real tree, and agrees with the pin", () => {
    // **The first version of this cell read the fixture and asserted about the JSON.** It could not
    // fail for any change to the extractor or the source: gate 2 made `readSwitchesFromRust` return
    // nothing — blinding the axis to eleven switches — and the script went red on seven lines while
    // this cell, the one NAMED for reading the real tree, stayed green. A cell whose name promises
    // the tree and whose body reads a file will be trusted by the next reader.
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "check-config-vocabulary.mjs")], {
      encoding: "utf8",
    });
    expect(out).toMatch(/^\[check-config-vocabulary\] OK/m);
    // Named, not counted: `79` moves for any commit that adds a switch and would be re-pinned on
    // reflex, but these three are the claims the PR rests on.
    expect(out).toMatch(/four languages|tools:cs/);
    const pinned = JSON.parse(readFileSync(join(REPO, "tests/fixtures/adr-036-config-vocabulary.json"), "utf8"));
    // The two the map says define the grid — neither reachable through `process.env.NAME`.
    expect(pinned.roles["DESKTOP_TOUCH_DISABLE_NATIVE_UIA"]).toBe("axis");
    expect(pinned.readIn["DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED"]).toEqual(["src:ts"]);
    // The launcher is a different process and reads its own; win2 confirmed all three fire at
    // startup on the machine (2026-09-17, internal `58afc09`).
    expect(pinned.readIn["DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED"]).toEqual(["bin:ts"]);
    // A switch with no prefix at all. Membership cannot be a naming convention.
    expect(pinned.readIn["GITHUB_TOKEN"]).toEqual(["bin:ts"]);
    // Its only reader is a C# executable the server spawns; the TypeScript site only WRITES it.
    expect(pinned.readIn["DTM_GIT_USERNAME"]).toEqual(["tools:cs"]);
    // The axis is a lower bound, and the reason is carried rather than rounded away.
    expect(pinned.unresolvable).toHaveLength(1);
    expect(pinned.unresolvable[0].site).toBe("src/utils/launch.ts:193");
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
      "README.ja.md": "| `DESKTOP_TOUCH_LIVE_KNOB` | off | 何かする |\n",
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
      ["src/added-two.ts", `function f(env: NodeJS.ProcessEnv) { return env["DESKTOP_TOUCH_ADDED_TWO"]; }\n`],
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

  it("is 1 when a switch-shaped name is read from a holder it cannot confirm", () => {
    // Recognising an environment by its binding means an UNTYPED, UNDEFAULTED holder is not one —
    // which is how the `TouchEnvironment` dependency bag is rejected. Without this net
    // `someBag["DESKTOP_TOUCH_X"]` would contribute nothing and say nothing, so the axis would come
    // back one short and complete-looking, which is the failure this file exists to end.
    fixture();
    pin();
    write("src/unconfirmed.ts", `function f(bag) { return bag["DESKTOP_TOUCH_HIDDEN"]; }\n`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/DESKTOP_TOUCH_HIDDEN is read from `bag`, which this parser cannot confirm/);
    rmSync(join(root, "src/unconfirmed.ts"));
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
    expect(out).toMatch(/DESKTOP_TOUCH_LIVE_KNOB is read at bin:ts, src:ts, where the grid says src:ts/);
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
    write("README.ja.md", "| `DESKTOP_TOUCH_LIVE_KNOB` | off |\n\n### 削除済み: `DESKTOP_TOUCH_GONE_KNOB`\n");
    // The READMEs' own sets are pinned too, so burying the name is a change the grid must record —
    // which is the point: they were written into the fixture and read by nobody before.
    const after = run();
    expect(after.status).toBe(1);
    expect(after.out).toMatch(/the READMEs now list DESKTOP_TOUCH_GONE_KNOB as tombstoned/);
    expect(after.out).not.toMatch(/was removed with no tombstone/);
  });

  it("is 1 when the README documents a switch nothing reads", () => {
    fixture();
    pin();
    write("README.md", "| `DESKTOP_TOUCH_LIVE_KNOB` | off |\n| `DESKTOP_TOUCH_PHANTOM` | off |\n");
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/the READMEs document DESKTOP_TOUCH_PHANTOM, which nothing reads/);
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

  it("is 1 when a role is a word the grid does not know", () => {
    // **Nothing validated the value before.** `"banana"` passed — and, sharper, a one-character
    // typo of `"removed"` disarmed the tombstone promise permanently with no output, because a
    // `roles` key that is neither read nor exactly `"removed"` was visited by no loop at all. The
    // test of a one-character criterion is not "would anyone do it on purpose" but "would the gate
    // notice if it vanished".
    fixture();
    pin();
    const path = join(root, "tests/fixtures/adr-036-config-vocabulary.json");
    const pinned = JSON.parse(readFileSync(path, "utf8"));
    pinned.roles["DESKTOP_TOUCH_LIVE_KNOB"] = "banana";
    pinned.roles["DESKTOP_TOUCH_A_GHOST"] = "remvoed";
    writeFileSync(path, `${JSON.stringify(pinned)}\n`);
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toMatch(/DESKTOP_TOUCH_LIVE_KNOB has the role "banana", which is not one of/);
    expect(out).toMatch(/DESKTOP_TOUCH_A_GHOST has the role "remvoed"/);
  });

  it("ratchets the unclassified count downward, and keeps a role through a removal", () => {
    // **A yellow gate nobody looks at stays yellow** (win2, 2026-09-17). Printing the count is not
    // enough: 60 of 75 could sit unclassified forever while the guard returned green. The number
    // may hold or fall, never rise, so a new switch costs a decision — which is what the FAIL
    // message always claimed and what the code did not do.
    fixture();
    pin();
    write("src/new-knob.ts", `const k = process.env.DESKTOP_TOUCH_BRAND_NEW;\n`);
    const added = run();
    expect(added.status).toBe(1);
    expect(added.out).toMatch(/switches are unclassified, where the grid allows/);
    rmSync(join(root, "src/new-knob.ts"));

    // **And `--update` does not get to discard a human decision.** The first version deleted the
    // role of any name that stopped being read — the exact path the tombstone invariant exists for,
    // so that invariant could never fire on the workflow a person actually takes.
    const path = join(root, "tests/fixtures/adr-036-config-vocabulary.json");
    const withRole = JSON.parse(readFileSync(path, "utf8"));
    withRole.roles["DESKTOP_TOUCH_LIVE_KNOB"] = "axis";
    writeFileSync(path, `${JSON.stringify(withRole)}\n`);
    write("src/server.ts", "const nothing = 1;\n");
    execFileSync(process.execPath, [join(root, "scripts", "check-config-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    expect(JSON.parse(readFileSync(path, "utf8")).roles["DESKTOP_TOUCH_LIVE_KNOB"]).toBe("axis");
    expect(run().out).toMatch(/the READMEs document DESKTOP_TOUCH_LIVE_KNOB, which nothing reads/);
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
