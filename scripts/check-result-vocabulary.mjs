#!/usr/bin/env node
// ADR-036 — the result axis, compared against the grid's pinned vocabulary.
//
// Run: `npm run check:result-vocabulary` (add `--update` to re-pin, together with the decision).
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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readUnion } from "./lib/route-vocabulary.mjs";
import {
  readReasonCatalogue,
  readReasonConversion,
  readSuggestsKeys,
  readUnexpectedFallback,
} from "./lib/result-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "adr-036-result-vocabulary.json");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const problems = [];

const typed = readUnion(read("src/engine/world-graph/guarded-touch.ts"), "TouchFailReason", () => [], problems) ?? [];
if (typed.length === 0) problems.push("TouchFailReason could not be read — the typed half of the axis is unknown, not empty");

const suggestsKeys = readSuggestsKeys(read("src/tools/_errors.ts"), problems);
const conversion = readReasonConversion(read("src/tools/_envelope.ts"), problems);
const fallbackCause = readUnexpectedFallback(read("src/tools/_envelope.ts"), problems);

// **Derived only from a conversion this file has seen.** A port written from the function's NAME
// agrees with the real one for 90 of the 94 keys and differs on four, because the implementation
// splits `([a-z])([A-Z])` and nothing else. Two implementations that agree most of the time are the
// worst kind of check, so a changed body stops the derivation rather than guessing at it.
const computed = conversion.apply ? [...new Set(suggestsKeys.map(conversion.apply))].sort() : [];
const fallbackReason = conversion.apply && fallbackCause !== null ? conversion.apply(fallbackCause) : null;

const serverCatalogue = readReasonCatalogue(read("src/server-windows.ts"));
const toolCatalogue = readReasonCatalogue(read("src/tools/desktop-register.ts"));

const receivable = [...new Set([...typed, ...computed, ...(fallbackReason === null ? [] : [fallbackReason])])].sort();
const computedOnly = computed.filter((r) => !typed.includes(r));
const catalogued = new Set([...serverCatalogue, ...toolCatalogue]);
// A typed reason with no `SUGGESTS` key gets no machine-readable advice — only whatever the prose
// catalogues say. Recorded rather than failed: prose IS the shipped advice for these today.
const withoutSuggests = typed.filter((r) => !computed.includes(r));

const derived = {
  typed,
  computedOnly,
  fallbackReason,
  serverCatalogue,
  toolCatalogue,
  withoutSuggests,
  // The two catalogues disagree today by exactly one name. Pinned as a KNOWN difference rather than
  // failed on: a gate that is red the day it lands is a gate somebody turns off (#670). It fails
  // when the difference changes, which is the property that was actually wanted.
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
if (conversion.apply === null || typed.length === 0) {
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

// **The fallback carries no advice, and that is a pinned fact.** `"Unknown"` is not a `SUGGESTS`
// key, so the reason it produces reaches the caller with an empty advice list. If it ever becomes a
// key the axis changes shape, and this line is where that shows.
if (fallbackCause !== null && suggestsKeys.includes(fallbackCause)) {
  problems.push(`the if_unexpected fallback "${fallbackCause}" is now a SUGGESTS key — the reason it produces is no longer advice-less`);
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
  `[check-result-vocabulary] OK — a caller can receive ${receivable.length} reasons: ${typed.length} typed ` +
    `(TouchFailReason) and ${computedOnly.length} more COMPUTED by the wrapper from ${suggestsKeys.length} ` +
    `advice-table keys, plus "${fallbackReason}" when an envelope carries no if_unexpected. ` +
    `${[...catalogued].length} are catalogued for the caller, so ${receivable.length - [...catalogued].length} ` +
    `are not; ${withoutSuggests.length} typed reasons have no SUGGESTS entry and carry only prose advice. ` +
    `The two catalogues differ by ${derived.cataloguesDifferBy.length}.`,
);
