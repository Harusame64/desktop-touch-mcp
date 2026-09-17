#!/usr/bin/env node
// ADR-036 — the configuration axis, compared against the grid's pinned vocabulary.
//
// Run: `npm run check:config-vocabulary` (add `--update` to re-pin, together with the decision).
//
// **The point is the denominator, not the list.** A switch added in code is a dimension the
// completion grid does not know about, and nothing else in this repo would say so: switches have
// no type, no registry and no single reading site. Counted on `06a66999`, they are read from FOUR
// roots (`src`, `bin`, `crates`, `benches`) in six syntactic shapes, and the obvious sweep
// (`process.env.NAME` under `src/`) sees fewer than two thirds of them.
import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readSwitchesFromTypeScript, readSwitchesFromRust, readDocumentedSwitches } from "./lib/config-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "adr-036-config-vocabulary.json");

// **The walk is part of the claim.** Every directory left out here is a place a switch can be read
// without the grid noticing, so the exclusions are the ones that hold no product code: vendored or
// built output, and the trees that TALK about switches rather than read them (`tests` sets them to
// drive cells; `docs` and `site` quote them in prose).
const SKIPPED_DIRS = new Set([".git", ".github", "node_modules", "dist", "target", "temp", "tests", "docs", "site"]);
const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs|rs)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

const problems = [];
/**
 * name -> the set of places that read it, as `<root>:<language>`.
 *
 * **The language is half the fact.** `src/` holds both the TypeScript server and the addon's Rust,
 * so a root on its own cannot say whether a switch is reachable in a build with no addon — and
 * that is the one lattice constraint this axis carries.
 */
const readIn = new Map();

for (const file of walk(REPO)) {
  const rel = relative(REPO, file);
  const root = rel.split(sep)[0];
  const rust = file.endsWith(".rs");
  const source = readFileSync(file, "utf8");
  const found = rust
    ? readSwitchesFromRust(source, rel, problems)
    : readSwitchesFromTypeScript(source, rel, problems).names;
  for (const name of found) {
    if (!readIn.has(name)) readIn.set(name, new Set());
    readIn.get(name).add(`${root}:${rust ? "rs" : "ts"}`);
  }
}

const derived = {};
for (const [name, roots] of [...readIn].sort()) derived[name] = [...roots].sort();

const { documented, tombstoned } = readDocumentedSwitches(readFileSync(join(REPO, "README.md"), "utf8"));

if (process.argv.includes("--update")) {
  const previous = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const roles = { ...previous.roles };
  for (const name of Object.keys(derived)) if (roles[name] === undefined) roles[name] = "unclassified";
  for (const name of Object.keys(roles)) if (derived[name] === undefined && roles[name] !== "removed") delete roles[name];
  const added = Object.keys(derived).filter((n) => previous.readIn[n] === undefined);
  const removed = Object.keys(previous.readIn).filter((n) => derived[n] === undefined);
  for (const n of added) console.log(`  + ${n}`);
  for (const n of removed) console.log(`  - ${n}`);
  if (problems.length > 0) {
    // **Re-pinning over an unreadable tree writes the short set into the grid**, and the grid is
    // then the thing everyone trusts. Same refusal as the road axis.
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\n[check-config-vocabulary] refusing to re-pin while the extraction cannot read the tree.");
    process.exit(1);
  }
  writeFileSync(FIXTURE, `${JSON.stringify({ readIn: derived, roles, documented, tombstoned }, null, 2)}\n`);
  console.log(`[check-config-vocabulary] wrote ${FIXTURE}`);
  process.exit(0);
}

const pinned = JSON.parse(readFileSync(FIXTURE, "utf8"));

// ── The pin, in both directions ──────────────────────────────────────────────
for (const name of new Set([...Object.keys(derived), ...Object.keys(pinned.readIn)])) {
  const now = derived[name];
  const then = pinned.readIn[name];
  if (now === undefined) {
    problems.push(`the grid counts ${name}, which nothing reads any more`);
  } else if (then === undefined) {
    problems.push(`the code now reads ${name}, which the grid does not count`);
  } else if (now.join(",") !== then.join(",")) {
    problems.push(`${name} is read from ${now.join(", ")}, where the grid says ${then.join(", ")}`);
  }
}

// ── Invariants the axis rests on ─────────────────────────────────────────────

// **Every switch has a role, or the axis is not built.** `unclassified` is a legitimate value and
// the summary prints how many there are: a hole that is COUNTED is the thing this gate is for, and
// a hole that fails the build on day one is a gate somebody turns off.
const unclassified = Object.keys(derived).filter((n) => (pinned.roles[n] ?? "unclassified") === "unclassified");
for (const name of Object.keys(derived)) {
  if (pinned.roles[name] === undefined) problems.push(`${name} has no role in the grid — not even "unclassified"`);
}

// **A switch only the addon reads cannot be exercised in a build with no addon.** That is a lattice
// constraint, not a product of two axes, and it is invisible unless the root is part of the pin.
for (const [name, sites] of Object.entries(derived)) {
  const nativeOnly = sites.every((site) => site.endsWith(":rs"));
  const role = pinned.roles[name];
  if (role === undefined || role === "unclassified") continue;
  if (nativeOnly && role !== "native") {
    problems.push(`${name} is read only by the addon (${sites.join(", ")}), so its role should be "native", not "${role}"`);
  }
  if (!nativeOnly && role === "native") {
    problems.push(`${name} has the role "native" but is read outside the addon (${sites.join(", ")})`);
  }
}

// **A tombstone is a promise to a user whose config still sets the name.** Removing the read
// without leaving one turns a switch that did something into a switch that silently does nothing.
for (const [name, role] of Object.entries(pinned.roles)) {
  if (role !== "removed") continue;
  if (derived[name] !== undefined) problems.push(`${name} is marked removed, but the code reads it`);
  else if (!tombstoned.includes(name)) problems.push(`${name} was removed with no tombstone in README.md`);
}

// **Documented but unread** is how a user is told to set something that does nothing.
for (const name of documented) {
  if (derived[name] === undefined && !tombstoned.includes(name)) {
    problems.push(`README.md documents ${name}, which nothing reads`);
  }
}

if (problems.length > 0) {
  console.error("\n[check-config-vocabulary] FAIL — the grid's configuration axis and the code's have diverged:\n");
  for (const p of problems.sort()) console.error(`  - ${p}`);
  console.error(
    "\n  The axis is one of ADR-036's three denominators. Re-pin with " +
      "`npm run check:config-vocabulary -- --update` ONLY together with the decision about the new " +
      "slots: every added switch is a dimension until it has a role.\n",
  );
  process.exit(1);
}

const sites = new Set(Object.values(derived).flat());
console.log(
  `[check-config-vocabulary] OK — ${Object.keys(derived).length} switches read from ${sites.size} places ` +
    `(${[...sites].sort().join(", ")}), ${documented.length} documented, ${tombstoned.length} tombstoned, ` +
    `${unclassified.length} still unclassified. A switch with no role is a dimension the grid cannot count.`,
);
