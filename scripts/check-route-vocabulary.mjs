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

import { readRoadVocabulary, readUnion } from "./lib/route-vocabulary.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PINNED = join(ROOT, "tests", "fixtures", "adr-036-route-vocabulary.json");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const executor = read("src/tools/desktop-executor.ts");
const guardedTouch = read("src/engine/world-graph/guarded-touch.ts");
const keyboardTarget = read("src/engine/keyboard-target.ts");
const worldTypes = read("src/engine/world-graph/types.ts");
const capabilities = read("src/capabilities/registry.ts");

const road = readRoadVocabulary(executor);
const keyboardGround = readUnion(keyboardTarget, "KeyboardGround") ?? [];
const derived = {
  route: road.route,
  rung: road.rung,
  refused: road.refused,
  why: road.why,
  touchFailReason: readUnion(guardedTouch, "TouchFailReason") ?? [],
  landingWhy: readUnion(keyboardTarget, "LandingWhy", (n) => (n === "KeyboardGround" ? keyboardGround : [])) ?? [],
  keyboardGround,
  executorKind: readUnion(worldTypes, "ExecutorKind") ?? [],
  advertisedExecutorKind: readUnion(capabilities, "AdvertisedExecutorKind") ?? [],
};

const problems = [...road.problems];

// ── Invariants the vocabulary must satisfy, whatever the pinned file says ────
//
// These are the claims the grid rests on. Each one has been true by hand and by nothing else.
for (const name of ["touchFailReason", "landingWhy", "executorKind", "advertisedExecutorKind"]) {
  if (derived[name].length === 0) problems.push(`could not read the ${name} union — has it moved or been renamed?`);
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
  mkdirSync(dirname(PINNED), { recursive: true });
  writeFileSync(PINNED, `${JSON.stringify(derived, null, 2)}\n`);
  console.log(`[check-route-vocabulary] wrote ${PINNED}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

let pinned;
try {
  pinned = JSON.parse(readFileSync(PINNED, "utf8"));
} catch (e) {
  console.error(`\n[check-route-vocabulary] FAIL — could not read the pinned vocabulary: ${e.message}`);
  console.error("  Run `npm run check:route-vocabulary -- --update` and read the diff before committing it.\n");
  process.exit(1);
}

for (const axis of Object.keys(derived)) {
  const now = derived[axis];
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
