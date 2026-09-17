#!/usr/bin/env node
// ADR-036 — the configuration axis, compared against the grid's pinned vocabulary.
//
// Run: `npm run check:config-vocabulary` (add `--update` to re-pin, together with the decision).
//
// **The point is the denominator, not the list.** A switch added in code is a dimension the
// completion grid does not know about, and nothing else in this repo would say so: switches have no
// type, no registry and no single reading site. Counted on `06a66999` they are read from SIX places
// in FOUR LANGUAGES (TypeScript, JavaScript, Rust, C#), and `process.env.NAME` under `src/` — the
// sweep anybody would write first — finds 41 of the 79.
//
// **The axis cannot be complete, and that is pinned too.** `src/utils/launch.ts:193` expands `%VAR%`
// tokens out of a registry value, so the name it reads comes from the REGISTRY at run time and no
// sweep can enumerate it (win2, 2026-09-17). An extraction that reported a number without saying so
// would be making the grid's own mistake one level up — "N matched" read as "N exist". The hole is
// carried in the fixture as a hole, it is named in the summary, and it is deliberately OUTSIDE the
// ratchet: a gate whose colour depends on the machine's registry is a gate nobody can act on.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDocumentedSwitches,
  readSwitchesFromCSharp,
  readSwitchesFromRust,
  readSwitchesFromScript,
} from "./lib/config-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "adr-036-config-vocabulary.json");

// **The walk is part of the claim**, and it is by REPO-RELATIVE PATH, not by basename. The first
// version tested `SKIPPED_DIRS.has(entry.name)` at every depth, so `crates/engine-perception/tests`
// was skipped silently — and so would `src/docs/` be, had anyone made one. Every path left out is a
// place a switch can be read without the grid noticing, which is the whole failure this file ends.
const SKIPPED_PATHS = new Set([".git", ".github", "node_modules", "dist", "target", "temp", "tests", "docs", "site"]);
// **`.cs` is here because leaving it out cost two dimensions.** `tools/key-askpass/Program.cs`
// ships as an executable the server spawns and reads three switches; two of them were in no set at
// all, and the third was pinned at a TypeScript site that only writes it.
const SOURCE_FILE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|rs|cs)$/;
const GENERATED = /(^|[\\/])(obj|bin)[\\/].*\.(g|AssemblyInfo|AssemblyAttributes)\.cs$|[\\/]obj[\\/]/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(REPO, full).split(sep).join("/");
    if (SKIPPED_PATHS.has(rel)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(entry.name) && !GENERATED.test(rel)) out.push(full);
  }
  return out;
}

const pinned = (() => {
  try {
    return JSON.parse(readFileSync(FIXTURE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      if (process.argv.includes("--update")) return { readIn: {}, written: {}, roles: {}, platform: [], allowDynamic: [], unresolvable: [], maxUnclassified: Infinity, documented: [], tombstoned: [] };
      console.error(`[check-config-vocabulary] no pinned vocabulary at ${FIXTURE}. Write the first one with --update.`);
      process.exit(1);
    }
    console.error(`[check-config-vocabulary] ${FIXTURE} is not readable JSON (${err.message}). Re-pin it with --update.`);
    process.exit(1);
  }
})();

const problems = [];
const readIn = new Map();
const writtenIn = new Map();

for (const file of walk(REPO)) {
  const rel = relative(REPO, file).split(sep).join("/");
  const source = readFileSync(file, "utf8");
  let found = [];
  let wrote = [];
  let lang = "ts";
  if (file.endsWith(".rs")) {
    lang = "rs";
    found = readSwitchesFromRust(source, rel, problems);
  } else if (file.endsWith(".cs")) {
    lang = "cs";
    found = readSwitchesFromCSharp(source, rel, problems);
  } else {
    const r = readSwitchesFromScript(source, rel, problems, pinned.allowDynamic ?? []);
    found = r.read;
    wrote = r.written;
  }
  const root = rel.split("/")[0];
  for (const name of found) {
    if (!readIn.has(name)) readIn.set(name, new Set());
    readIn.get(name).add(`${root}:${lang}`);
  }
  for (const name of wrote) {
    if (!writtenIn.has(name)) writtenIn.set(name, new Set());
    writtenIn.get(name).add(`${root}:${lang}`);
  }
}

const platform = new Set(pinned.platform ?? []);
const derived = {};
const derivedWritten = {};
for (const [name, sites] of [...readIn].sort()) if (!platform.has(name)) derived[name] = [...sites].sort();
for (const [name, sites] of [...writtenIn].sort()) if (!platform.has(name)) derivedWritten[name] = [...sites].sort();

const english = readDocumentedSwitches(readFileSync(join(REPO, "README.md"), "utf8"));
// **A fix found in one language does not propagate.** The ja page writes its tombstones `削除済み:`,
// so with only the English spelling a switch buried there could never match one.
const japanese = readDocumentedSwitches(readFileSync(join(REPO, "README.ja.md"), "utf8"));
const documented = [...new Set([...english.documented, ...japanese.documented])].sort();
const tombstoned = [...new Set([...english.tombstoned, ...japanese.tombstoned])].sort();
for (const name of tombstoned) {
  const at = documented.indexOf(name);
  if (at !== -1) documented.splice(at, 1);
}

const LEGAL_ROLES = new Set(["axis", "premise", "nested", "instrument", "native", "tuning", "removed", "unclassified"]);

if (process.argv.includes("--update")) {
  const roles = { ...pinned.roles };
  for (const name of Object.keys(derived)) if (roles[name] === undefined) roles[name] = "unclassified";
  // **A role is a human decision, and `--update` does not get to discard one.** The first version
  // deleted the role of any name that stopped being read — which is exactly the path the tombstone
  // invariant exists for, so that invariant could never fire on the workflow a person takes
  // (delete the read, re-pin). A switch that stops being read keeps its role and the check then
  // asks for a decision: mark it `removed` and leave a tombstone, or put the read back.
  const added = Object.keys(derived).filter((n) => pinned.readIn[n] === undefined);
  const gone = Object.keys(pinned.readIn ?? {}).filter((n) => derived[n] === undefined);
  for (const n of added) console.log(`  + ${n}`);
  for (const n of gone) console.log(`  - ${n}  (its role "${roles[n]}" is kept — mark it "removed" and leave a tombstone, or put the read back)`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ! ${p}`);
    console.error("\n[check-config-vocabulary] refusing to re-pin while the extraction cannot read the tree.");
    process.exit(1);
  }
  const unclassifiedNow = Object.keys(derived).filter((n) => (roles[n] ?? "unclassified") === "unclassified").length;
  writeFileSync(
    FIXTURE,
    `${JSON.stringify(
      {
        readIn: derived,
        written: derivedWritten,
        platform: [...platform].sort(),
        roles,
        allowDynamic: pinned.allowDynamic ?? [],
        unresolvable: pinned.unresolvable ?? [],
        maxUnclassified: Math.min(pinned.maxUnclassified ?? Infinity, unclassifiedNow),
        documented,
        tombstoned,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[check-config-vocabulary] wrote ${FIXTURE}`);
  process.exit(0);
}

// ── The pin, in both directions ──────────────────────────────────────────────
for (const [what, verb, now, then] of [
  ["read", "reads", derived, pinned.readIn ?? {}],
  ["written", "writes", derivedWritten, pinned.written ?? {}],
]) {
  for (const name of new Set([...Object.keys(now), ...Object.keys(then)])) {
    if (now[name] === undefined) problems.push(`the grid counts ${name} as ${what}, which nothing ${verb} any more`);
    else if (then[name] === undefined) problems.push(`the code now ${verb} ${name}, which the grid does not count`);
    else if (now[name].join(",") !== then[name].join(",")) {
      problems.push(`${name} is ${what} at ${now[name].join(", ")}, where the grid says ${then[name].join(", ")}`);
    }
  }
}

// **The README's own sets are pinned too.** They were written into the fixture and read by nobody,
// so the product could stop documenting all 32 switches and the pin would say nothing.
for (const [what, now, then] of [
  ["documented", documented, pinned.documented ?? []],
  ["tombstoned", tombstoned, pinned.tombstoned ?? []],
]) {
  for (const name of now) if (!then.includes(name)) problems.push(`the READMEs now list ${name} as ${what}, which the grid does not count`);
  for (const name of then) if (!now.includes(name)) problems.push(`the grid counts ${name} as ${what}, which the READMEs no longer list`);
}

// ── Invariants the axis rests on ─────────────────────────────────────────────

// **Every role is a word the grid knows.** Nothing validated the value before, so `"banana"` passed
// — and, worse, a one-character typo of `"removed"` disarmed the tombstone promise permanently with
// no output. The test of a one-character criterion is not "would anyone do it on purpose" but
// "would the gate notice if it vanished".
for (const [name, role] of Object.entries(pinned.roles ?? {})) {
  if (!LEGAL_ROLES.has(role)) problems.push(`${name} has the role "${role}", which is not one of ${[...LEGAL_ROLES].join(", ")}`);
}
for (const name of Object.keys(derived)) {
  if (pinned.roles?.[name] === undefined) problems.push(`${name} has no role in the grid — not even "unclassified"`);
}

// **A switch only the addon reads cannot be exercised in a build with no addon.** A lattice
// constraint, not a product of two axes, and invisible unless the language is part of the pin.
for (const [name, sites] of Object.entries(derived)) {
  const nativeOnly = sites.every((site) => site.endsWith(":rs"));
  const role = pinned.roles?.[name];
  if (role === undefined || role === "unclassified") continue;
  if (nativeOnly && role !== "native") problems.push(`${name} is read only by the addon (${sites.join(", ")}), so its role should be "native", not "${role}"`);
  if (!nativeOnly && role === "native") problems.push(`${name} has the role "native" but is read outside the addon (${sites.join(", ")})`);
}

// **A tombstone is a promise to a user whose config still sets the name.**
for (const [name, role] of Object.entries(pinned.roles ?? {})) {
  if (role !== "removed") continue;
  if (derived[name] !== undefined) problems.push(`${name} is marked removed, but the code reads it`);
  else if (!tombstoned.includes(name)) problems.push(`${name} was removed with no tombstone in either README`);
}

// **Documented but unread** is how a user is told to set something that does nothing.
for (const name of documented) {
  if (derived[name] === undefined && !tombstoned.includes(name)) problems.push(`the READMEs document ${name}, which nothing reads`);
}

// **The ratchet.** Printing the count is not enough: a yellow gate nobody looks at stays yellow
// (win2, 2026-09-17). The number may hold or fall, never rise — so a new switch costs a decision,
// which is what the FAIL message has always claimed and what the code did not do.
const unclassified = Object.keys(derived).filter((n) => (pinned.roles?.[n] ?? "unclassified") === "unclassified");
const ceiling = pinned.maxUnclassified ?? 0;
if (unclassified.length > ceiling) {
  problems.push(
    `${unclassified.length} switches are unclassified, where the grid allows ${ceiling}: ` +
      `${unclassified.filter((n) => (pinned.readIn?.[n] === undefined)).join(", ") || unclassified.slice(0, 3).join(", ")}`,
  );
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
const holes = (pinned.unresolvable ?? []).length;
console.log(
  `[check-config-vocabulary] OK — ${Object.keys(derived).length} switches read from ${sites.size} places ` +
    `(${[...sites].sort().join(", ")}), ${Object.keys(derivedWritten).length} written for a child process, ` +
    `${documented.length} documented, ${tombstoned.length} tombstoned, ${unclassified.length}/${ceiling} unclassified. ` +
    `${holes} reader${holes === 1 ? " takes" : "s take"} a name this extraction cannot enumerate, so the axis is a ` +
    `LOWER BOUND, not a count.`,
);
