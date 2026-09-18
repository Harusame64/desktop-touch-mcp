#!/usr/bin/env node
// ADR-036 — the completion grid's vocabulary, checked against the source.
//
// The gate's denominator is "the vocabulary extracted from the code × configuration × result"
// (the user's decision, 2026-09-11, recorded in the map). **Extracted, not hand-listed**: a road
// added in code must not quietly become a slot nobody counted. This script is the half that keeps
// the extraction honest — it re-derives the sets and fails when they differ from the pinned file
// the grid is built on.
//
// **Why a script and not only a cell.** The unit suite does not run in this repo's CI (the block is
// commented out in `ci.yml`), so a vocabulary that only a vitest cell guarded would drift on every
// merge until someone ran the suite by hand. The `check:*` scripts do run. The cells beside this
// one drive the script itself, which is the lesson #668 ended on: a guard nothing runs is a guard
// that is not there.
//
// What this does NOT do: it says nothing about whether a value is reachable, covered by a cell, or
// waived. It only answers "is the vocabulary still what the grid was built on".

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRoadVocabulary } from "./lib/route-vocabulary.mjs";
// **The two type readers come from the parser.** `readUnion` and `readInlineFieldUnion` used to
// find a declaration's end by counting braces on a masked copy and cut its members out with
// `[^;{}]`; both were defects (#679, and the re-read after it). A type alias is a node and its
// members are a list. `readRoadVocabulary` is still the hand-written one — it is the next axis,
// and keeping it here keeps the old module as the control the replacement is measured against.
import { readInlineFieldUnion, readUnion } from "./lib/typescript-source.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PINNED = join(ROOT, "tests", "fixtures", "adr-036-route-vocabulary.json");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
// The files a DYNAMIC why draws from are read only if one is present: a tree with no such call site
// (a fixture, a future executor that writes only literals) must not fail on a file it never needs.
const tryRead = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const executor = read("src/tools/desktop-executor.ts");
const guardedTouch = read("src/engine/world-graph/guarded-touch.ts");
const keyboardTarget = read("src/engine/keyboard-target.ts");
const worldTypes = read("src/engine/world-graph/types.ts");
const capabilities = read("src/capabilities/registry.ts");

const aim = tryRead("src/engine/aim.ts");
const pointOwner = tryRead("src/engine/point-owner.ts");
const unionProblems = [];
// **Every type read passes `problems` and its file name.** Six of the nine used to pass neither, so
// whatever the reader said — a member it could not read, a file that did not parse, a declaration
// it would not take — was dropped on the floor: `KeyboardGround` gaining `| ExtraGround` left this
// gate OK, and `--update` re-pinned the short set (gate 2 on #681). The reader's rule is that it
// never answers short in silence; that rule only holds if the caller keeps what it is told. Each
// union is read ONCE, so a problem is reported once however many derived fields draw on it.
const typeUnion = (source, file, name, resolve = () => []) => readUnion(source, name, resolve, unionProblems, file) ?? [];
const keyboardGround = typeUnion(keyboardTarget, "src/engine/keyboard-target.ts", "KeyboardGround");
const landingWhy = typeUnion(keyboardTarget, "src/engine/keyboard-target.ts", "LandingWhy", (n) => (n === "KeyboardGround" ? keyboardGround : []));
// The homing rung writes `homing.why` straight into the row, so `Homing.why`'s members are `why`
// values. The extractor names the union; resolving it is the caller's job because the caller has
// the files (gate 2 on #669: the why axis was 12 and the tree can write 9 more).
const road = readRoadVocabulary(executor, (name) =>
  name === "homing.why"
    ? readInlineFieldUnion(aim, "Homing", "why", unionProblems, "src/engine/aim.ts")
    : name === "landing.why"
      ? landingWhy
      : name === "owner.why"
        ? readInlineFieldUnion(pointOwner, "PointOwner", "why", unionProblems, "src/engine/point-owner.ts")
        : [],
);
const derived = {
  landingWhyOnTheRow: road.landingWhyOnTheRow,
  // **Pinned, not asserted.** The one dynamic spelling (`why: verdict.why`) is what lets the row
  // carry ANY LandingWhy member, so it is the difference between "the landing axis is one literal"
  // and "the landing axis is eleven". An executor that writes none is a legitimate tree, not a
  // failure, so this belongs in the grid rather than in an invariant — the day the spelling goes,
  // the comparison below says so in the same voice as every other drift.
  landingWhyFromTheUnion: road.landingWhyDrawsFromTheUnion ? ["verdict.why"] : [],
  route: road.route,
  rung: road.rung,
  refused: road.refused,
  why: road.why,
  touchFailReason: typeUnion(guardedTouch, "src/engine/world-graph/guarded-touch.ts", "TouchFailReason"),
  landingWhy,
  keyboardGround,
  executorKind: typeUnion(worldTypes, "src/engine/world-graph/types.ts", "ExecutorKind"),
  advertisedExecutorKind: typeUnion(capabilities, "src/capabilities/registry.ts", "AdvertisedExecutorKind"),
};

// A file that does not parse is reported once per union read from it; the reason is one.
const problems = [...road.problems, ...new Set(unionProblems)];

// ── Invariants the vocabulary must satisfy, whatever the pinned file says ────
//
// These are the claims the grid rests on. Each one has been true by hand and by nothing else.
for (const name of ["touchFailReason", "landingWhy", "executorKind", "advertisedExecutorKind"]) {
  if (derived[name].length === 0) problems.push(`could not read the ${name} union — has it moved or been renamed?`);
}
// **Containment, and read from two different places.** The row's landing whys come from the
// executor (the literals it spells inside `landing: { … }`); `LandingWhy` comes from
// `keyboard-target.ts`. The first version filled BOTH from the same `readUnion` call, so it
// compared a function to itself: gate 2 on #669 evaluated the two expressions over five mutations
// of `keyboard-target.ts` and got EQUAL every time, including the mutation that deletes a member.
// An invariant no mutant can kill lies to the reader about what is checked.
for (const value of road.landingWhyOnTheRow) {
  if (!derived.landingWhy.includes(value)) {
    problems.push(`the row writes landing.why:"${value}", which is not a LandingWhy (${derived.landingWhy.join(", ")})`);
  }
}


for (const value of derived.refused) {
  // `refused` is documented as "spelled the way guarded-touch spells the reason". A convention,
  // not a type: nothing in TS makes it hold.
  if (!derived.touchFailReason.includes(value)) {
    problems.push(`the executor writes refused:"${value}", which is not a TouchFailReason`);
  }
}
if (derived.executorKind.join(",") !== derived.advertisedExecutorKind.join(",")) {
  problems.push(
    `ExecutorKind (${derived.executorKind.join(", ")}) and AdvertisedExecutorKind ` +
      `(${derived.advertisedExecutorKind.join(", ")}) have diverged`,
  );
}
for (const kind of derived.executorKind) {
  // The five backends are also road values; the other four road values are ladder rungs. If a
  // backend stops being a road the grid's road column is wrong in a way no count would show.
  if (!derived.route.includes(kind)) problems.push(`ExecutorKind "${kind}" is not written as a route`);
}
if (!derived.landingWhy.some((w) => w.startsWith("ground_disabled:"))) {
  // The template member is a member. Losing it reads as a smaller, complete-looking vocabulary.
  problems.push("LandingWhy lost its `ground_disabled:${KeyboardGround}` members — 8 values is the short answer");
}

// ── The pinned file ──────────────────────────────────────────────────────────
const update = process.argv.includes("--update");
if (update) {
  // **A re-pin that prints nothing is a decision made with no evidence.** The FAIL message demands
  // one ("every added value is a hole until a cell fills it or the user waives it") and the first
  // version handed the reader a single "wrote <path>" line (gate 2 on #669).
  if (problems.length > 0) {
    console.error("\n[check-route-vocabulary] REFUSING to re-pin — the extraction reported problems:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\n  Fix the extraction first: pinning from a reading it has called unreliable pins the unreliability.\n");
    process.exit(1);
  }
  let previous = {};
  try {
    previous = JSON.parse(readFileSync(PINNED, "utf8"));
  } catch {
    console.log("[check-route-vocabulary] no previous pin — writing the first one");
  }
  for (const axis of new Set([...Object.keys(derived), ...Object.keys(previous)])) {
    const now = derived[axis] ?? [];
    const was = previous[axis] ?? [];
    const added = now.filter((v) => !was.includes(v));
    const gone = was.filter((v) => !now.includes(v));
    if (added.length > 0) console.log(`  + ${axis}: ${added.join(", ")}`);
    if (gone.length > 0) console.log(`  - ${axis}: ${gone.join(", ")}`);
  }
  mkdirSync(dirname(PINNED), { recursive: true });
  writeFileSync(PINNED, `${JSON.stringify(derived, null, 2)}\n`);
  console.log(`[check-route-vocabulary] wrote ${PINNED}`);
  process.exit(0);
}

let pinned;
try {
  pinned = JSON.parse(readFileSync(PINNED, "utf8"));
} catch (e) {
  console.error(`\n[check-route-vocabulary] FAIL — could not read the pinned vocabulary: ${e.message}`);
  console.error("  Run `npm run check:route-vocabulary -- --update` and read the diff before committing it.\n");
  process.exit(1);
}

// **Both key sets.** An axis that is in the pin and not in the extraction is a column the grid
// counts and nothing produces — the loop over `derived` alone never looked at it.
for (const axis of new Set([...Object.keys(derived), ...Object.keys(pinned)])) {
  const now = derived[axis] ?? [];
  const was = pinned[axis] ?? [];
  const added = now.filter((v) => !was.includes(v));
  const gone = was.filter((v) => !now.includes(v));
  // **Both directions.** A value that disappears is a cell the grid still counts and nothing can
  // ever fill; a value that appears is a slot nobody counted.
  for (const v of added) problems.push(`${axis}: the code now produces "${v}", which the grid does not count`);
  for (const v of gone) problems.push(`${axis}: the grid counts "${v}", which the code no longer produces`);
}

if (problems.length > 0) {
  console.error("\n[check-route-vocabulary] FAIL — the grid's vocabulary and the code's have diverged:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n  The grid is ADR-036's completion denominator. Re-pin with " +
      "`npm run check:route-vocabulary -- --update` ONLY together with the decision about the new " +
      "slots: every added value is a hole until a cell fills it or the user waives it.\n",
  );
  process.exit(1);
}

console.log(
  `[check-route-vocabulary] OK — ${derived.route.length} roads (${derived.executorKind.length} backends + ` +
    `${derived.route.length - derived.executorKind.length} ladder/negative), ${derived.rung.length} rungs, ` +
    `${derived.refused.length} of ${derived.touchFailReason.length} TouchFailReason values written by the executor, ` +
    `${derived.why.length} whys, ${derived.landingWhy.length} landing whys. ` +
    `These are the axes the completion grid counts; none of them is enumerated by a type.`,
);
