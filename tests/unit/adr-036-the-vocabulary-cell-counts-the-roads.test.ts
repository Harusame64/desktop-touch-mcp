/**
 * ADR-036 — the completion grid's vocabulary, and the guard that keeps it honest.
 *
 * The gate's denominator is "the vocabulary extracted from the code × configuration × result"
 * (the user's decision, 2026-09-11). **Extracted, not hand-listed** — so these cells drive the
 * extractor with spellings the tree does not contain yet, and then drive the SCRIPT against a
 * fixture tree and assert its exit code. The second half is the lesson #668 ended on: the unit
 * suite does not run in this repo's CI, and a guard nothing runs is a guard that is not there.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readInlineFieldUnion,
  readRoadVocabulary,
  readUnion,
  stripComments,
} from "../../scripts/lib/route-vocabulary.mjs";
import {
  readInlineFieldUnion as parsedReadInlineFieldUnion,
  readRoadVocabulary as parsedReadRoadVocabulary,
  readUnion as parsedReadUnion,
} from "../../scripts/lib/typescript-source.mjs";

// **Both road readers.** The gate reads the road through the parser; the scanner stays as the
// differential control, and every cell written against it now asks both.
const ROAD_READERS = [
  { name: "scanner", readRoadVocabulary },
  { name: "parser", readRoadVocabulary: parsedReadRoadVocabulary },
];

const REPO = fileURLToPath(new URL("../..", import.meta.url));

describe.each(ROAD_READERS)("the extractor ($name)", ({ name, readRoadVocabulary }) => {
  it("does not read the literals that comments quote", () => {
    // `why: "uia_set_value"` appears in prose one screen above the line that produces it. A raw
    // grep counts the comment; the extraction is wrong in the direction that looks complete.
    const src = `
// why: "from_a_comment"
/* route: "also_from_a_comment" */
probeRoute("real_road", undefined, entity, { why: "real_why" });
`;
    const v = readRoadVocabulary(src);
    expect(v.route).toEqual(["real_road"]);
    expect(v.why).toEqual(["real_why"]);
    expect(stripComments(src).split("\n").length).toBe(src.split("\n").length);
  });

  it("reports every shape of non-literal, not one of them", () => {
    // **Gate 2 fed the first version six spellings and five under-counted in silence**: a ternary,
    // a `const` holding the value, a variable named `route` (exempted BY NAME — an exemption whose
    // only effect was to open a hole named after the field it guarded), a road with a digit, and a
    // nested object before `route:`. The promise in the header is that the count is either right or
    // says it is not.
    for (const call of [
      `probeRoute(chosenRoad, undefined, entity, {});`,
      `const route = "sneaky"; probeRoute(route, undefined, entity, {});`,
      `probeRoute(NEW_ROAD, undefined, entity, {});`,
    ]) {
      expect(readRoadVocabulary(call).problems.join(""), call).toMatch(/non-literal/);
    }
    // **A conditional of literals is the one shape the two readers answer differently, on purpose.**
    // The scanner cannot read it and says so; the parser reads BOTH branches, because both roads are
    // producible — a complete answer, which is what the report was standing in for. Either way the
    // count is right or says it is not; neither under-counts in silence.
    const ternaryRoad = readRoadVocabulary(`probeRoute(cond ? "shell_road" : "wsl_road", undefined, entity, {});`);
    const ternaryWhy = readRoadVocabulary(`probeRoute("uia", undefined, entity, { why: ok ? "a" : "b" });`);
    if (name === "scanner") {
      expect(ternaryRoad.problems.join("")).toMatch(/non-literal/);
      expect(ternaryWhy.problems.join("")).toMatch(/why is not a literal/);
    } else {
      expect(ternaryRoad.route).toEqual(["shell_road", "wsl_road"]);
      expect(ternaryRoad.problems).toEqual([]);
      expect(ternaryWhy.why).toEqual(["a", "b"]);
      expect(ternaryWhy.problems).toEqual([]);
    }
  });

  it("does not report a call that was merely wrapped across lines", () => {
    // The capture stopped at the newline, so ordinary formatting was reported as a non-literal —
    // and the offender printed was the EMPTY STRING, saying nothing about what it objected to. A
    // gate that goes red for a reformat, without naming a cause, is a gate somebody loosens next
    // month (gate 2 on #669, second pass).
    const v = readRoadVocabulary(`probeRoute(
  "uia",
  aimHwnd,
  entity,
  { why: "uia_invoke" },
);`);
    expect(v.problems).toEqual([]);
    expect(v.route).toEqual(["uia"]);
  });

  it("reports a non-literal at every producer, not only at probeRoute", () => {
    // `probedStep` and `refusal` name a rung as their first argument, and a rung read from a
    // variable shrinks the rung axis exactly as a road does. Both were unguarded.
    expect(readRoadVocabulary(`probedStep(step, aimHwnd, entity, () => {});`).problems.join("")).toMatch(
      /probedStep is given a non-literal: step/,
    );
    expect(readRoadVocabulary(`throw refusal(kind, "aim_occluded", err);`).problems.join("")).toMatch(
      /refusal is given a non-literal: kind/,
    );
  });

  it("exempts probedStep's forwarding by the BINDING it forwards, not by the two names", () => {
    // **The same hole, written twice in one branch.** Gate 2 closed `probeRoute`'s exemption-by-name
    // (`!== "route"`) and this file was then given one for `probeRefusal` in the same commit. win2
    // shot it on 2026-09-17 (internal `790e43a`): keep `rung, refused` and change what `refused`
    // HOLDS, and a refusal ground that reaches the row walks past — `OK`, exit 0.
    // `adr029Refusal`'s body is read to a `}` in the first column, the way the executor writes it.
    const readable = `function adr029Refusal(k) {
  return "cursor_placement_blocked";
}
async function probedStep(rung, aimHwnd, entity, step) {
  const refused = adr029Refusal(err);
  if (refused !== undefined) probeRefusal(rung, refused, aimHwnd, entity);
}`;
    expect(readRoadVocabulary(readable).problems).toEqual([]);
    expect(readRoadVocabulary(readable).refused).toEqual(["cursor_placement_blocked"]);

    const smuggled = readable.replace("adr029Refusal(err);", 'adr029Refusal(err) ?? "smuggled_ground";');
    const v = readRoadVocabulary(smuggled);
    expect(v.refused).not.toContain("smuggled_ground");
    expect(v.problems.join("")).toMatch(/probedStep no longer forwards/);
    expect(v.problems.join("")).toMatch(/probeRefusal is given a non-literal/);

    // **What the binding HOLDS is the property; its annotation is not.** win2 priced the tightening
    // on 2026-09-17 (internal `f493bad`): wrapping, whitespace and a trailing comment are free, and
    // an annotation was the one meaning-preserving edit that went red. Narrowing a match rule is
    // harder than loosening it, so the four shapes that DO change the value are pinned beside it.
    const annotated = readable.replace("const refused =", "const refused: string | undefined =");
    expect(readRoadVocabulary(annotated).problems).toEqual([]);
    for (const smuggle of [
      'adr029Refusal(err) ?? "x";',
      'adr029Refusal(err) || "x";',
      'err ? adr029Refusal(err) : "x";',
    ]) {
      const bent = readable.replace("adr029Refusal(err);", smuggle);
      expect(readRoadVocabulary(bent).problems.join(""), smuggle).toMatch(/probedStep no longer forwards/);
    }
    // **`const` is load-bearing**: it is what rules out a later `refused = "smuggled"`, which the
    // binding test cannot see because it reads one statement. Writing the rule this way means the
    // day somebody relaxes it to `let`, the exemption lifts rather than widening in silence — and
    // this cell is where that shows. (Found by the loop above, which asserted the reassignment
    // shape and went green: `const refused = …; refused = "x";` does not compile, so the case is
    // unreachable — but `let` does, and that is the one to pin.)
    const reassigned = readable.replace("const refused =", "let refused =").replace(
      "adr029Refusal(err);",
      'adr029Refusal(err);\n  refused = "smuggled_ground";',
    );
    expect(readRoadVocabulary(reassigned).problems.join("")).toMatch(/probedStep no longer forwards/);
  });

  it("collects a refusal ground written straight onto the row", () => {
    // **This rule was DELETED** in the commit that took gate 2's first pass, which made the guard
    // weaker than the head it replaced: a new ground on an already-pinned rung entered no set and
    // raised no problem, so the script printed `OK` and exited 0 (gate 2 on #669, second pass).
    expect(
      readRoadVocabulary(`probeRoute("refusal", aimHwnd, entity, { rung: "window_gone", refused: "aim_window_gone" });`)
        .refused,
    ).toEqual(["aim_window_gone"]);
  });

  it("reads a road whose name carries a digit", () => {
    // `[a-z_]+` where the other fields used `[a-z0-9_]+`: dropped, not reported.
    expect(readRoadVocabulary(`probeRoute("cdp2", undefined, entity, {});`).route).toContain("cdp2");
  });

  it("resolves the whys that are written through a variable, by name", () => {
    // `why: homing.applied ? null : homing.why` and `why: owner.why` are legitimate: the union each
    // draws from is named in the expression. The caller resolves them, because the caller has the
    // files — and `why: verdict.why` is kept OUT of this axis, because it is the landing axis
    // wearing the same field name.
    const v = readRoadVocabulary(
      `probeRoute("homing", undefined, entity, { why: homing.applied ? null : homing.why });
       probeRoute("containment_check", undefined, entity, { why: owner.why });
       const row = { landing: { confirmed: false, why: verdict.why } };`,
      (name) => (name === "homing.why" ? ["from_homing"] : name === "owner.why" ? ["from_owner"] : ["from_landing"]),
    );
    expect(v.problems).toEqual([]);
    expect(v.why).toContain("from_homing");
    expect(v.why).toContain("from_owner");
    expect(v.why).not.toContain("from_landing");
    // **The row's landing whys are what the row SPELLS**, not what `LandingWhy` declares. The first
    // version filled this from the resolver — the same call the checker uses for the `landingWhy`
    // axis — so the invariant that compared them could not fail and the fixture carried the same
    // eleven values twice (gate 2 on #669, second pass).
    expect(v.landingWhyOnTheRow).toEqual([]);
    expect(v.landingWhyDrawsFromTheUnion).toBe(true);
  });

  it("keeps the landing why off the road axis in BOTH its spellings", () => {
    // The dynamic spelling was routed away from the first version; the literal one fell straight
    // through, so `receiver_unknown` was pinned on three axes at once while the comment beside the
    // rule claimed a separation (gate 2 on #669, second pass). A comment is a claim, not a check.
    const v = readRoadVocabulary(
      `probeRoute("keyboard", undefined, entity, { why: "uia_invoke", landing: { confirmed: false, why: "receiver_unknown", referenceFrom: "none" } });`,
    );
    expect(v.why).toEqual(["uia_invoke"]);
    expect(v.landingWhyOnTheRow).toEqual(["receiver_unknown"]);
    expect(v.landingWhyDrawsFromTheUnion).toBe(false);
    expect(v.problems).toEqual([]);
  });

  it("reads a producer's values out of its annotation when the call site is a shorthand", () => {
    // `probeRoute("keyboard", …, { why, … })` is an ES6 shorthand: it carries no `why:` at all, so
    // the ONLY place those values are spelled is the parameter's annotation. The first version
    // skipped annotations with a comment saying their literals "are already collected at their
    // producing call sites" — they were not, and `keyboard_only_entity` was a why the row writes,
    // missing from the axis and from the pin, with `problems` empty (gate 2 on #669, second pass).
    const v = readRoadVocabulary(
      `function rung(why: "uia_set_value_failed" | "keyboard_only_entity") {
         probeRoute("keyboard", undefined, entity, { why, verdict: "unchecked" });
       }`,
    );
    expect(v.why).toEqual(["keyboard_only_entity", "uia_set_value_failed"]);
    expect(v.problems).toEqual([]);
    // A union that is NOT all quoted literals is reported, not skipped — the skip is what hid the
    // hole above, so the narrow case is the only one that stays silent.
    expect(readRoadVocabulary(`function f(why: KeyboardRungWhy | "a") {}`).problems).toEqual([
      "a why union is not all quoted literals: KeyboardRungWhy | \"a\"",
    ]);
  });

  it("says so when the function that produces three refusal grounds has moved", () => {
    // `probedStep` hands `probeRefusal` a variable; three grounds live in `adr029Refusal` and in no
    // call site. If it is renamed, the set is short by three and the run would otherwise pass.
    // Only reported when something routes through it — an alarm that is always on is read as noise.
    const v = readRoadVocabulary(`probedStep("mouse_press", () => {});`);
    expect(v.problems.join("")).toMatch(/adr029Refusal has moved/);
    expect(readRoadVocabulary(`probeRoute("uia", undefined, entity, {});`).problems).toEqual([]);
  });

  // **The same cells, over BOTH type readers.** The gates read unions through the parser since
  // #681, and these cells were written against the scanner — so they guarded a reader no gate
  // called any more, and a mutation of the one that IS called could not reach them (gate 2 on
  // #681). The scanner stays as the differential control until the last axis moves, so it keeps
  // its row. Where the two word a problem differently, each row carries its own wording; the
  // SHAPES are the claim, and both must name all three.
  describe.each([
    {
      reader: {
        name: "scanner",
        readUnion,
        readInlineFieldUnion,
        unreadable: [
          "X: cannot resolve the template member `focus_lost:${Unknown}`",
          "Y: member `plain_backtick` is not a quoted literal this parser reads",
          "Z: no quoted members — `(typeof ARR)[number]` is not a union this parser reads",
          "Z: member `(typeof ARR)[number]` is not a quoted literal this parser reads",
        ],
      },
    },
    {
      reader: {
        name: "parser",
        readUnion: parsedReadUnion,
        readInlineFieldUnion: parsedReadInlineFieldUnion,
        unreadable: [
          "X: cannot resolve the template member `focus_lost:${Unknown}`",
          "Y: member ``plain_backtick`` is not a quoted literal this parser reads",
          "Z: member `(typeof ARR)[number]` is not a quoted literal this parser reads",
        ],
      },
    },
  ])("the type reader ($reader.name)", ({ reader }) => {
    const { readUnion, readInlineFieldUnion } = reader;

    it("expands a template member of a union instead of dropping it", () => {
      // `LandingWhy` ends in `ground_disabled:${KeyboardGround}`. Reading only quoted literals gives
      // 8 values where the vocabulary is 11 — a smaller number that looks like a complete one.
      const kb = `export type KeyboardGround = "a" | "b";`;
      const src = "export type LandingWhy =\n  | \"plain\"\n  | `ground_disabled:${KeyboardGround}`;";
      const ground = readUnion(kb, "KeyboardGround")!;
      expect(readUnion(src, "LandingWhy", (n) => (n === "KeyboardGround" ? ground : []))).toEqual([
        "ground_disabled:a",
        "ground_disabled:b",
        "plain",
      ]);
    });

    it("reports a union member it cannot read instead of returning a shorter union", () => {
      // A template whose union it cannot resolve, a backticked member with no interpolation, and a
      // `typeof ARR[number]` all used to come back as a shorter set — indistinguishable from a
      // complete one (gate 2 on #669).
      const problems: string[] = [];
      readUnion('export type X = "a" | `focus_lost:${Unknown}`;', "X", () => [], problems);
      readUnion('export type Y = "a" | `plain_backtick`;', "Y", () => [], problems);
      readUnion("export type Z = (typeof ARR)[number];", "Z", () => [], problems);
      // **A total is not a content.** `>= 3` stays green if one rule starts reporting twice while
      // another goes silent; the shapes are what the cell is about (gate 2 on #669, second pass).
      expect(problems).toEqual(reader.unreadable);
    });

    it("does not throw away the first member of a single-line union", () => {
      // `.slice(1)` was written for the leading-pipe style, where element 0 is the whitespace before
      // the first `|`. On one line it discards a REAL member, and `values.length === 0` does not fire
      // because the other member was read — one of two, coming back complete-looking, which is the
      // failure this parser exists to end (gate 2 on #669, second pass).
      const problems: string[] = [];
      expect(readUnion('export type K = OtherUnion | "uia";', "K", () => [], problems)).toEqual(["uia"]);
      expect(problems).toEqual(["K: member `OtherUnion` is not a quoted literal this parser reads"]);
    });

    it("reads a union written inline as a field, anchored on the type's whole name", () => {
      // `export type PointOwnerVia` sits above `export type PointOwner` in the same file: a substring
      // search reads the one-liner and answers one value where the vocabulary has four. And a type
      // can carry the field twice — reading only the first is the same defect one line over.
      const src = `export type OwnerVia = "a" | "b";
export type Owner =
  | { kind: "blocked"; why: "excluded_window"; via: OwnerVia }
  | { kind: "unknown"; why: "enumeration_failed" | "no_window_at_point"; via: OwnerVia };`;
      expect(readInlineFieldUnion(src, "Owner", "why")).toEqual([
        "enumeration_failed",
        "excluded_window",
        "no_window_at_point",
      ]);
    });

    it("reads a field union that was broken over lines, which is how a union grows", () => {
      // Stopping at the newline read one member of however many, silently. The real `Homing.why` is
      // written this way: the shipped extractor answered ONE of its nine with `problems` empty, and
      // the why axis was short by eight (gate 2 on #669, second pass — the count went 17 → 24).
      const problems: string[] = [];
      const src = `export type Owner =
  | { kind: "unknown";
      why:
        | "enumeration_failed"
        | "no_window_at_point"; };`;
      expect(readInlineFieldUnion(src, "Owner", "why", problems)).toEqual([
        "enumeration_failed",
        "no_window_at_point",
      ]);
      expect(problems).toEqual([]);
    });

    it("stops at the next declaration when TypeScript's optional `;` is absent", () => {
      // The fall-through used to be end-of-file, so one dropped semicolon pulled every `why:` from
      // every type BELOW into the axis — values nothing on the road can produce, which then inflate
      // the completion denominator once they are re-pinned (gate 2 on #669, second pass).
      const problems: string[] = [];
      const src = `export type Owner = { why: "a" }
export type Unrelated = { why: "leaked_from_below" };`;
      expect(readInlineFieldUnion(src, "Owner", "why", problems)).toEqual(["a"]);
      expect(problems).toEqual([]);
    });
  });

  it("reads the real executor's vocabulary", () => {
    // The numbers are the ones the extraction produced on 2026-09-17 and that the pinned file
    // carries; this cell is here so a change to the EXTRACTOR shows up next to a change to the code.
    const src = readFileSync(join(REPO, "src/tools/desktop-executor.ts"), "utf8");
    // The real executor writes three whys through a variable; the caller resolves the unions they
    // name (the check does it from the files). Unresolved, they are reported — which is the cell.
    expect(readRoadVocabulary(src).problems.join("")).toMatch(/could not be resolved/);
    const v = readRoadVocabulary(src, () => ["resolved"]);
    expect(v.problems).toEqual([]);
    expect(v.route).toContain("uia");
    expect(v.route).toContain("refusal");
    expect(v.route.length).toBeGreaterThanOrEqual(9);
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
      const out = execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { status: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  /** The smallest tree the check accepts: one road, one refusal, the four unions. */
  const fixture = (over: Record<string, string> = {}) => {
    const files: Record<string, string> = {
      "src/tools/desktop-executor.ts": `
probeRoute("uia", undefined, entity, { why: "uia_invoke" });
probeRoute("cdp", undefined, entity, { why: "cdp_click" });
probeRoute("terminal", undefined, entity, { why: "terminal_send" });
probeRoute("mouse", undefined, entity, { why: "visual_or_read_entity" });
probeRoute("keyboard", undefined, entity, { why: "keyboard_only_entity", landing: { confirmed: false, why: "receiver_unknown", referenceFrom: "none" } });
probeRoute("keyboard", undefined, entity, { why: "uia_set_value_failed", landing: { confirmed: true, why: verdict.why, referenceFrom: "x" } });
probeRefusal("mouse_press", "aim_occluded", entity, {});
function adr029Refusal(kind) {
  if (kind === "bounds") return "coordinate_outside_reachable_bounds";
  return "cursor_placement_blocked";
}
`,
      "src/engine/world-graph/guarded-touch.ts": `export type TouchFailReason =
  | "aim_occluded"
  | "coordinate_outside_reachable_bounds"
  | "cursor_placement_blocked";`,
      "src/engine/keyboard-target.ts": `export type KeyboardGround = "other_window" | "read_only";
export type LandingWhy =
  | "receiver_unknown"
  | \`ground_disabled:\${KeyboardGround}\`;`,
      "src/engine/world-graph/types.ts": `export type ExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard";`,
      "src/capabilities/registry.ts": `export type AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard";`,
    };
    for (const [path, body] of Object.entries({ ...files, ...over })) write(path, body);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "route-vocabulary-"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    cpSync(join(REPO, "scripts", "check-route-vocabulary.mjs"), join(root, "scripts", "check-route-vocabulary.mjs"));
    // **The whole `scripts/lib`, not a list of the files it needs today.** Each of these fixtures
    // used to name its imports one by one, and the list was a hand-written copy of the import
    // graph: the moment `result-vocabulary.mjs` imported `code-vocabulary.mjs` (round 3 of
    // internal#125, to stop keeping a second scanner), two fixtures could not start the gate at
    // all. The failure is loud, but a list that has to be edited by hand is wrong from the commit
    // that outgrows it until someone notices. Copying the directory removes the list.
    cpSync(join(REPO, "scripts", "lib"), join(root, "scripts", "lib"), { recursive: true });
    // **The gate needs the compiler now.** `scripts/lib/typescript-source.mjs` imports
    // `typescript`, and node resolves that by walking up from the script — which, in a temp
    // directory, walks past nothing. CI has it because `npm ci` runs before these gates; this
    // harness has to provide what CI provides, or it tests a tree the gate cannot run in.
    // `"junction"`, not `"dir"`: on Windows a symlink needs Developer Mode or elevation and this
    // threw EPERM on win2's machine, skipping every cell in the file; a junction needs neither.
    // The type is ignored off Windows, so there is no branch. (win2 measured all three there: both
    // symlink forms EPERM, junction created and resolving `typescript`.)
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "junction");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("is 0 when the pinned vocabulary matches the code", () => {
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    const { status, out } = run();
    expect(out).toMatch(/OK —/);
    expect(status).toBe(0);
  });

  it("is 1 when the code grows a road the grid does not count", () => {
    // The whole point: a road added in code is a slot nobody counted until someone decides it is
    // covered or waived.
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    write(
      "src/tools/desktop-executor.ts",
      `${readFileSync(join(root, "src/tools/desktop-executor.ts"))}\nprobeRoute("brand_new_road", undefined, entity, {});\n`,
    );
    const { status, out } = run();
    expect(out).toMatch(/brand_new_road/);
    expect(status).toBe(1);
  });

  it("is 1 when a road the grid counts stops being produced", () => {
    // The other direction: a cell the grid still counts that nothing can ever fill.
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    fixture({
      "src/tools/desktop-executor.ts": `
probeRoute("uia", undefined, entity, { why: "uia_invoke" });
probeRoute("cdp", undefined, entity, { why: "cdp_click" });
probeRoute("terminal", undefined, entity, { why: "terminal_send" });
probeRoute("mouse", undefined, entity, { why: "visual_or_read_entity" });
probeRefusal("mouse_press", "aim_occluded", entity, {});
function adr029Refusal(kind) {
  if (kind === "bounds") return "coordinate_outside_reachable_bounds";
  return "cursor_placement_blocked";
}
`,
    });
    const { status, out } = run();
    expect(out).toMatch(/no longer produces/);
    expect(status).toBe(1);
  });

  it("is 1 when the executor writes a refusal that is not a TouchFailReason", () => {
    // `refused` matches the reason union by convention, not by any type.
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    write(
      "src/tools/desktop-executor.ts",
      `${readFileSync(join(root, "src/tools/desktop-executor.ts"))}\nprobeRefusal("mouse_press", "not_a_reason", entity, {});\n`,
    );
    const { status, out } = run();
    expect(out).toMatch(/not a TouchFailReason/);
    expect(status).toBe(1);
  });

  it("is 1 when the two executor-kind unions diverge", () => {
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    write("src/capabilities/registry.ts", `export type AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse";`);
    const { status, out } = run();
    expect(out).toMatch(/diverged/);
    expect(status).toBe(1);
  });

  it.each([
    [
      "KeyboardGround",
      "src/engine/keyboard-target.ts",
      `export type KeyboardGround = "other_window" | "read_only" | "new_ground" | ExtraGround;
export type LandingWhy =
  | "receiver_unknown"
  | \`ground_disabled:\${KeyboardGround}\`;`,
    ],
    [
      "ExecutorKind",
      "src/engine/world-graph/types.ts",
      `export type ExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard" | "new_kind" | ExtraKind;`,
    ],
  ])("is 1 when %s gains a member the reader cannot read, and refuses to re-pin", (_name, path, body) => {
    // Gate 2 on #681: six of the nine type reads passed no `problems`, so the reader named this
    // member and the gate dropped what it said — OK, exit 0, and `--update` re-pinned the short
    // set. The pin cannot see it either: the readable members did not change.
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    write(path as string, body as string);
    const { status, out } = run();
    expect(out).toMatch(/is not a quoted literal this parser reads/);
    expect(status).toBe(1);
    // **Refused, not merely non-zero.** Gate 2's second pass: a gate that wrote the short pin and
    // THEN exited 1 passed the first version of this cell. The pin must be byte-identical after —
    // and the edit carries a READABLE new member beside the unreadable one, because otherwise the
    // short set equals the old pin and a write is invisible (the mutation survived that version).
    const pin = join(root, "tests", "fixtures", "adr-036-route-vocabulary.json");
    const before = readFileSync(pin, "utf8");
    let stderr = "";
    try {
      execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], { stdio: "pipe", encoding: "utf8" });
    } catch (e) {
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(stderr).toMatch(/REFUSING to re-pin/);
    expect(readFileSync(pin, "utf8")).toBe(before);
  });

  it("names the FILE that did not parse, of the five it reads unions from", () => {
    // Gate 2 on #681: no gate passed a file name, so a parse failure in any of them read
    // "source.ts did not parse", and this gate merges five files into one list.
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    write("src/engine/world-graph/types.ts", `export type ExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard";\nexport type Broken = {;`);
    const { status, out } = run();
    expect(out).toContain("src/engine/world-graph/types.ts did not parse");
    expect(status).toBe(1);
    // And ONCE for a file two unions are read from: the reason is one, however many reads meet it.
    fixture();
    write(
      "src/engine/keyboard-target.ts",
      `export type KeyboardGround = "other_window" | "read_only";
export type LandingWhy =
  | "receiver_unknown"
  | \`ground_disabled:\${KeyboardGround}\`;
export type Broken = {;`,
    );
    const twice = run();
    expect(twice.out.split("src/engine/keyboard-target.ts did not parse").length - 1).toBe(1);
    expect(twice.status).toBe(1);
  });

  it("is 1 when LandingWhy loses its template member", () => {
    // Eight values where the vocabulary is eleven — a shorter number that looks complete.
    fixture();
    execFileSync(process.execPath, [join(root, "scripts", "check-route-vocabulary.mjs"), "--update"], {
      stdio: "ignore",
    });
    write(
      "src/engine/keyboard-target.ts",
      `export type KeyboardGround = "other_window" | "read_only";
export type LandingWhy = "receiver_unknown";`,
    );
    const { status, out } = run();
    expect(out).toMatch(/ground_disabled/);
    expect(status).toBe(1);
  });
});
