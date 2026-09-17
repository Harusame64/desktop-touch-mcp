#!/usr/bin/env node
// ADR-036 — the result axis, compared against the grid's pinned vocabulary.
//
// Run: `npm run check:result-vocabulary` (add `--update` to re-pin, together with the decision).
//
// **There are two caller-visible surfaces, and a grid keyed on one never contains the other.**
//
// win2 measured it (2026-09-17, internal `d524953`): `desktop_state`'s memory-bound checks promote
// `optIn` implicitly, so asking for `working:51` turns envelope mode ON and the failure returns
// `{"_version":"1.0","data":null,…,"if_unexpected":{"most_likely_cause":
// "WorkingMemoryNUpperBoundExceeded"}}` — **PascalCase, with no `reason` field at all**. Only a
// caller that explicitly asks for `"raw"` sees `reason: "working_memory_nupper_bound_exceeded"`.
// One result, two spellings, both reaching callers. `desktop_act` is the other way round: its
// handler passes `optIn: false` at every site, so `reason` IS its surface. Both sets are pinned —
// `producedNames` is the PascalCase surface, `typed` + `computedOnly` the snake_case one.
//
// **So this file does not claim to count what `desktop_act` can return.** It counts what the shared
// machinery can produce. The four memory-bound codes are thrown in `desktop_state`'s handler and no
// act path reaches them; narrowing to one tool's reachable subset is a call-graph question this
// extraction does not answer, and saying so is cheaper than a number that reads as its answer.
//
// **The axis has a type for a fifth of itself.** The loop's failure arm is typed
// (`TouchFailReason`, eighteen values). The wrapper above it returns a `reason: string` it does not
// write but COMPUTES — `pascalToSnake(ifUnexp.most_likely_cause)` over a 94-key advice table with
// no union, defaulting to `"Unknown"`. So a caller can receive 101 distinct reasons, 18 of them
// enumerated anywhere, and grepping for `reason: "…"` finds the literals and misses all of it.
//
// **This file does not sweep the field name.** `reason:` is worn by at least three other axes —
// `_truncation`, the lease validator, the background-input channel — and a sweep for the spelling
// merges four axes on a shared word. The axis is defined by its producers instead.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readUnion } from "./lib/route-vocabulary.mjs";
import {
  readCodedNames,
  readReturnedCodes,
  readEnvelopeErrorNames,
  readLeaseCodes,
  readReasonCatalogue,
  readReasonConversion,
  readSuggestsKeys,
  readUnexpectedFallback,
} from "./lib/result-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "adr-036-result-vocabulary.json");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const problems = [];

// **The walk is part of the claim.** An error class outside it is one whose name can reach the
// caller without the grid noticing.
const SKIPPED = new Set([".git", ".github", "node_modules", "dist", "target", "temp", "tests", "docs", "site"]);
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIPPED.has(relative(REPO, full).split(sep).join("/"))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const sources = walk(join(REPO, "src")).map((file) => ({
  file: relative(REPO, file).split(sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

const typed = readUnion(read("src/engine/world-graph/guarded-touch.ts"), "TouchFailReason", () => [], problems) ?? [];
if (typed.length === 0) problems.push("TouchFailReason could not be read — the typed half of the axis is unknown, not empty");

const suggestsKeys = readSuggestsKeys(read("src/tools/_errors.ts"), problems);
const conversion = readReasonConversion(read("src/tools/_envelope.ts"), problems);
const fallbackCause = readUnexpectedFallback(read("src/tools/_envelope.ts"), problems);

// ── The producers, which is what the first version of this file got wrong ────
//
// It modelled the name space with `SUGGESTS` — the ADVICE table, keyed BY the name, downstream of
// the thing it stood in for. That counted 82 values nothing produces and missed `handler_error`,
// `unknown` and the lease codes. Gate 2 on #672 added a fifth lease code and watched the gate print
// OK. The number went 101 to 26.
const RESOLVED_CODED = ["src/tools/_envelope.ts:code"];
const RESOLVED_DYNAMIC_NAME = ["src/errors/typed-errors.ts:ToolFailureError:code"];
// **Produced is not the same as reachable, and this extraction only counts producers.**
// `HandlerError` is constructed twice, both inside `toResultErr` — an exported, documented, tested
// helper that NO production code calls (`git grep toResultErr -- src` is four lines, all its own
// declaration and prose). So `handler_error` is a reason the grid counts and no shipped path
// produces. Recorded rather than dropped: a name that becomes reachable the day somebody wires the
// documented handler pattern is one the grid should already know about, and a name silently
// removed is one nobody notices arriving. The same distinction as internal #122, one level up.
const KNOWN_WITHOUT_PRODUCTION_CALLER = [
  {
    name: "HandlerError",
    why: "constructed only inside toResultErr, which no production code calls",
    checked_on: "cf6d0063",
  },
];
// **A producer whose values this extraction cannot enumerate.** `ToolFailureError` takes its name
// from a `code` supplied at 183 `failWith` call sites across the tools; enumerating that space is
// `check:failwith-fixtures`'s subject, not this one. Listed here rather than silently skipped,
// because the consequence is that the axis is a LOWER BOUND — the same shape as the configuration
// axis's registry-supplied switch name (#670), and the summary says so in both.
const UNRESOLVABLE = [
  {
    producer: "ToolFailureError:code",
    why: "the code is supplied by the failWith call sites across the tools; this extraction does not enumerate them",
    counted_by: "npm run check:failwith-fixtures",
  },
];
const errorNames = readEnvelopeErrorNames(sources, problems, RESOLVED_DYNAMIC_NAME);
const codedNames = readCodedNames(sources, problems, RESOLVED_CODED);
// **The lease codes come from the function, not from the table beside it.** Gate 2's third round:
// `mapLeaseValidationToTypedReason` hard-codes its returns and never consults
// `LEASE_REASON_TO_TYPED_CODE`, whose own comment calls it a reservation for future expansion. Two
// of its four names are produced by nothing, and adding a real branch left the gate green.
const leaseCodes = readReturnedCodes(read("src/tools/_envelope.ts"), "mapLeaseValidationToTypedReason", problems);
// The table is kept as a COVERAGE check — the role `SUGGESTS` was correctly demoted to. A code the
// function returns with no reserved name is the shape the reservation exists to prevent.
const reservedLeaseNames = readLeaseCodes(read("src/tools/_envelope.ts"), problems);
const producedNames = [
  ...new Set([...errorNames, ...codedNames, ...leaseCodes, ...(fallbackCause === null ? [] : [fallbackCause])]),
].sort();

const computed = conversion.apply ? [...new Set(producedNames.map(conversion.apply))].sort() : [];
const fallbackReason = conversion.apply && fallbackCause !== null ? conversion.apply(fallbackCause) : null;

const serverCatalogue = readReasonCatalogue(read("src/server-windows.ts"));
const toolCatalogue = readReasonCatalogue(read("src/tools/desktop-register.ts"));

const receivable = [...new Set([...typed, ...computed])].sort();
const computedOnly = computed.filter((r) => !typed.includes(r));
const catalogued = new Set([...serverCatalogue, ...toolCatalogue]);
// **A produced name with no `SUGGESTS` key reaches the caller with generic advice.** Recorded
// rather than failed: five do today, and prose is what they carry.
const withoutAdvice = producedNames.filter((n) => !suggestsKeys.includes(n));

const derived = {
  typed,
  producedNames,
  computedOnly,
  fallbackReason,
  serverCatalogue,
  toolCatalogue,
  withoutAdvice,
  // The two catalogues disagree today by exactly one name. Pinned as a KNOWN difference rather than
  // failed on: a gate that is red the day it lands is a gate somebody turns off (#670). It fails
  // when the difference changes, which is the property that was actually wanted.
  unresolvable: UNRESOLVABLE.map((u) => u.producer),
  withoutProductionCaller: KNOWN_WITHOUT_PRODUCTION_CALLER.map((k) => k.name),
  reservedLeaseNames,
  cataloguesDifferBy: [
    ...serverCatalogue.filter((n) => !toolCatalogue.includes(n)),
    ...toolCatalogue.filter((n) => !serverCatalogue.includes(n)),
  ].sort(),
};

if (process.argv.includes("--update")) {
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ! ${p}`);
    console.error("\n[check-result-vocabulary] refusing to re-pin while the extraction cannot read the tree.");
    process.exit(1);
  }
  let previous = {};
  try {
    previous = JSON.parse(readFileSync(FIXTURE, "utf8"));
  } catch {
    console.log("  (no previous pin — writing the first one)");
  }
  for (const key of Object.keys(derived)) {
    const before = previous[key];
    if (!Array.isArray(derived[key]) || !Array.isArray(before)) continue;
    for (const n of derived[key].filter((x) => !before.includes(x))) console.log(`  + ${key}: ${n}`);
    for (const n of before.filter((x) => !derived[key].includes(x))) console.log(`  - ${key}: ${n}`);
  }
  writeFileSync(FIXTURE, `${JSON.stringify(derived, null, 2)}\n`);
  console.log(`[check-result-vocabulary] wrote ${FIXTURE}`);
  process.exit(0);
}

let pinned;
try {
  pinned = JSON.parse(readFileSync(FIXTURE, "utf8"));
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(`[check-result-vocabulary] no pinned vocabulary at ${FIXTURE}. Write the first one with --update.`);
  } else {
    console.error(`[check-result-vocabulary] ${FIXTURE} is not readable JSON (${err.message}). Re-pin it with --update.`);
  }
  process.exit(1);
}

// **When the derivation itself is broken, say THAT and stop.** A changed conversion empties the
// computed set, and comparing an empty set against the pin buries the one line that matters under
// 82 "no longer produces" entries — 96 problems where one is true and the rest are its shadow. The
// reader then fixes the loudest thing. (The same shape as an error message that names a symptom.)
if (conversion.apply === null || typed.length === 0 || suggestsKeys.length === 0 || producedNames.length === 0) {
  console.error("\n[check-result-vocabulary] FAIL — the extraction cannot derive the axis:\n");
  for (const p of problems.sort()) console.error(`  - ${p}`);
  console.error("\n  Everything below this depends on it, so nothing below was compared.\n");
  process.exit(1);
}

// ── The pin, in both directions ──────────────────────────────────────────────
for (const key of Object.keys(derived)) {
  const now = derived[key];
  const then = pinned[key];
  if (Array.isArray(now)) {
    for (const n of now) if (!(then ?? []).includes(n)) problems.push(`${key}: the code now produces "${n}", which the grid does not count`);
    for (const n of then ?? []) if (!now.includes(n)) problems.push(`${key}: the grid counts "${n}", which the code no longer produces`);
  } else if (now !== then) {
    problems.push(`${key} is ${JSON.stringify(now)}, where the grid says ${JSON.stringify(then)}`);
  }
}

// ── Invariants the axis rests on ─────────────────────────────────────────────

// **A name a catalogue tells the caller to expect must be one the code can produce.** The reverse
// is not required and is the interesting number: 82 of the receivable reasons are in neither.
for (const name of catalogued) {
  if (!receivable.includes(name)) problems.push(`a catalogue tells the caller to expect "${name}", which nothing produces`);
}

// **Every typed reason is catalogued somewhere.** These are the eighteen a caller is most likely to
// meet; an uncatalogued one is a recovery path nobody was told about.
for (const name of typed) {
  if (!catalogued.has(name)) problems.push(`${name} is a TouchFailReason no catalogue mentions`);
}

// **A name pinned as having no production caller must still BE a produced name.** If the class goes
// away the entry is stale, and a stale exemption is how a real value walks past later.
for (const { name } of KNOWN_WITHOUT_PRODUCTION_CALLER) {
  if (!producedNames.includes(name)) problems.push(`${name} is pinned as having no production caller, but nothing produces it at all any more`);
}

// **The fallback carries no advice, and that is a pinned fact.** `"Unknown"` is not a `SUGGESTS`
// key, so the reason it produces reaches the caller with an empty advice list. If it ever becomes a
// key the axis changes shape, and this line is where that shows.
if (fallbackCause !== null && suggestsKeys.includes(fallbackCause)) {
  problems.push(`the if_unexpected fallback "${fallbackCause}" is now a SUGGESTS key — the reason it produces is no longer advice-less`);
}

// **Every produced name should be a key, or the caller gets generic advice.** Not failed on — five
// are not today — but the SET is pinned above, so one more is a change the grid records.
for (const code of leaseCodes) {
  // The residual is not a lease name and is not reserved as one — the table's own comment says the
  // unpromoted reasons "collapse to `Unknown` at runtime". Everything else it returns should have a
  // reserved name, which is what the reservation is for.
  if (code === fallbackCause) continue;
  if (!reservedLeaseNames.includes(code)) {
    problems.push(`the lease mapping returns "${code}", which LEASE_REASON_TO_TYPED_CODE does not reserve`);
  }
}

if (problems.length > 0) {
  console.error("\n[check-result-vocabulary] FAIL — the grid's result axis and the code's have diverged:\n");
  for (const p of problems.sort()) console.error(`  - ${p}`);
  console.error(
    "\n  The axis is one of ADR-036's three denominators. Re-pin with " +
      "`npm run check:result-vocabulary -- --update` ONLY together with the decision about the new " +
      "slots: every added reason is one a caller can receive.\n",
  );
  process.exit(1);
}

console.log(
  `[check-result-vocabulary] OK — the failure-envelope machinery can produce ${receivable.length} reasons ` +
    `on the raw surface and ${producedNames.length} names on the envelope surface (PascalCase, in ` +
    `most_likely_cause, which carries no reason field at all): ${typed.length} typed ` +
    `(TouchFailReason), ${typed.filter((r) => computed.includes(r)).length} of which also arrive through the ` +
    `envelope, plus ${computedOnly.length} more COMPUTED from the name of the error that ` +
    `reached it — including "handler_error", which is every un-typed throw, and "${fallbackReason}", which is an ` +
    `envelope with no if_unexpected. ${[...catalogued].length} are catalogued for the caller, so ` +
    `${receivable.filter((r) => !catalogued.has(r)).length} are not; ${withoutAdvice.length} produced names have no ` +
    `SUGGESTS entry and reach the caller with generic advice. The two catalogues differ by ` +
    `${derived.cataloguesDifferBy.length}. ${UNRESOLVABLE.length} producer${UNRESOLVABLE.length === 1 ? " takes" : "s take"} ` +
    `a name this extraction cannot enumerate, so the count is a LOWER BOUND, not a total. ` +
    `${KNOWN_WITHOUT_PRODUCTION_CALLER.length} of the names (${KNOWN_WITHOUT_PRODUCTION_CALLER.map((k) => k.name).join(", ")}) ` +
    `${KNOWN_WITHOUT_PRODUCTION_CALLER.length === 1 ? "has" : "have"} no production caller, so counting a producer is not the same as counting a reachable cell.`,
);
