#!/usr/bin/env node
// ADR-036 — the FOURTH denominator: the `code` a caller receives on a flat tool failure.
//
// Run: `npm run check:code-vocabulary` (add `--update` to re-pin, together with the decision).
//
// The grid's other three axes are the road (#669), the configuration (#670) and the result
// (#672 / #673). The result axis ended by naming this one and deliberately not counting it:
//
//     reason             snake_case    toFailureEnvelope's raw projection
//     most_likely_cause  PascalCase    toFailureEnvelope's envelope
//     code               PascalCase    toToolFailure (`const code = err.name`), enveloped or not
//
// **`code` shares a producer and a spelling with `most_likely_cause`.** Matching the two by name
// collapses two axes into one, and the conclusion can be right off a rule that mis-sorts the next
// case. So this file counts `code` at ITS producers, and states the overlap with the third axis as
// a derived number rather than letting a name do the matching.
//
// **This axis is the only one of the four that is CLOSED ABOVE, and the ceiling is structural.**
// Two arms of `classify` turn a producer's MESSAGE into a code, and both ask
// `Object.hasOwn(SUGGESTS, …)` first — so a message cannot invent a code, and the reachable set is
// bounded by the dictionary plus what the call sites name. Remove either guard and the axis has no
// upper bound at all; the extraction fails rather than counts when that happens, because a
// denominator that cannot be bounded is not a denominator.
//
// **What it does NOT claim.** 24 of the dictionary's keys are written by no arm and named at no
// call site: they are reachable only when some producer spells the code into its own message —
// `KeyLockerDisabled: the key locker live wiring is not active` does, and `AimOccludedError`'s prose
// sentence ("The window this action was aimed at…") does not — so whether the flat surface can say
// `AimOccluded` at all is decided by text this file does not read. Which of the 24 are
// spelled is a question about message TEXT across the tree, and this file counts the ceiling and
// says so instead of answering it with a number. The measurement that can answer it is a round
// on the real machine (win2, 2026-09-18).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/route-vocabulary.mjs";
import { readSuggestsKeys } from "./lib/result-vocabulary.mjs";
import {
  isCalledOutside,
  readClassifyArms,
  readEmbeddedScriptCodes,
  readFailArgsCode,
  readFailCodeSites,
  readHandBuiltFlatFailures,
} from "./lib/code-vocabulary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "adr-036-code-vocabulary.json");
const RESULT_FIXTURE = join(REPO, "tests", "fixtures", "adr-036-result-vocabulary.json");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const problems = [];

// **The walk is part of the claim.** A file outside it is a file whose failures can carry a code
// the grid does not count. Same skip list as the result axis, for the same reason.
const SKIPPED = new Set([".git", ".github", "node_modules", "dist", "target", "temp", "tests", "docs", "site"]);
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIPPED.has(relative(REPO, full).split(sep).join("/"))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
const sources = walk(join(REPO, "src")).map((file) => ({
  file: relative(REPO, file).split(sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

const errors = read("src/tools/_errors.ts");
const suggestsKeys = readSuggestsKeys(errors, problems);
const arms = readClassifyArms(errors, problems);
const failArgsCode = readFailArgsCode(errors, problems);
const failCode = readFailCodeSites(sources, problems);

// ── The producers outside the three entry points ─────────────────────────────
//
// Found by sweeping for the SHAPE, not the field name: `code:` is worn by the key-locker injector's
// snake_case results, the terminal's `ExitModeRejectCode`, the console-paste reason and `macro`'s
// forwarded inner code. `ok:false` + `code` + `error` at one depth is the flat failure and nothing
// else is.
//
// **Reachability is derived, not pinned.** `insertTextViaTextPattern2` builds one of these, and the
// first read of this tree recorded it as dead on a grep for the wrong name. Asking whether the
// enclosing function is called from another file answers it structurally, and answered the opposite
// (`ui-elements.ts:670`).
const handBuilt = readHandBuiltFlatFailures(sources).map((site) => ({
  where: `${site.file}:${site.fn ?? "(top level)"}`,
  code: site.code ?? site.expression,
  reached: site.fn === null ? null : isCalledOutside(sources, site.fn, site.file),
}));

// **Codes spelled inside an embedded PowerShell script.** Recorded, never merged: whether one
// reaches a caller's `code` is a call-graph question this extraction does not answer, and one of
// them resolves to `aim_window_gone` — snake_case, in a field named `code`, on an object the TS
// side parses back out of stdout. That single value is the whole argument for counting axes at
// their producers instead of matching them by the name of the key they ride on.
const embedded = [...new Set(readEmbeddedScriptCodes(sources).map((e) => e.code))].sort();

// ── The axis ─────────────────────────────────────────────────────────────────
const ceiling = [...new Set([...arms.literals, ...failCode.codes, ...suggestsKeys, ...(failArgsCode === null ? [] : [failArgsCode]), ...handBuilt.filter((h) => h.reached !== false && h.code !== null).map((h) => h.code)])].sort();
// The keys no arm writes: reachable only when a producer spells the code into its own message.
const dictionaryOnly = suggestsKeys.filter((k) => !arms.literals.includes(k) && !failCode.codes.includes(k)).sort();
// A code with no dictionary entry reaches the caller with whatever the call site passed, or with
// nothing. Pinned rather than failed on: eleven do today, and one of them is the residual.
const adviceLess = ceiling.filter((c) => !suggestsKeys.includes(c)).sort();

// **The overlap with the third axis, stated as a number instead of assumed by spelling.** Both
// surfaces are PascalCase and both take their value from `err.name`, so the interesting fact is not
// that they overlap but WHERE they do not: a name on the envelope surface with no flat road is a
// failure whose two surfaces disagree about what happened.
let envelopeNames = [];
try {
  envelopeNames = JSON.parse(readFileSync(RESULT_FIXTURE, "utf8")).producedNames ?? [];
} catch {
  problems.push("the result axis's pin could not be read — the overlap between the third and fourth denominators is unknown, not empty");
}
// **"Within the ceiling" is not "has a flat road".** A name that is a dictionary key is inside the
// bound, and whether any producer's message spells it is the question this file does not answer —
// so the two sets are named for what they actually say. Writing them as "has a flat road" would be
// the same overclaim the ceiling exists to avoid, one field further down.
const envelopeWithinFlatCeiling = envelopeNames.filter((n) => ceiling.includes(n)).sort();
const envelopeOutsideFlatCeiling = envelopeNames.filter((n) => !ceiling.includes(n)).sort();

const derived = {
  classifyLiterals: arms.literals,
  residual: arms.residual,
  dictionaryArms: arms.dictionaryArms.map((a) => a.identifier).sort(),
  dictionaryOnly,
  failCodeCodes: failCode.codes,
  failArgsCode,
  handBuilt: handBuilt.map((h) => `${h.where} → ${h.code}${h.reached === false ? " (no caller outside its file)" : ""}`).sort(),
  embeddedScriptCodes: embedded,
  adviceLess,
  envelopeWithinFlatCeiling,
  envelopeOutsideFlatCeiling,
};

if (process.argv.includes("--update")) {
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ! ${p}`);
    console.error("\n[check-code-vocabulary] refusing to re-pin while the extraction cannot read the tree.");
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
  console.log(`[check-code-vocabulary] wrote ${FIXTURE}`);
  process.exit(0);
}

let pinned;
try {
  pinned = JSON.parse(readFileSync(FIXTURE, "utf8"));
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(`[check-code-vocabulary] no pinned vocabulary at ${FIXTURE}. Write the first one with --update.`);
  } else {
    console.error(`[check-code-vocabulary] ${FIXTURE} is not readable JSON (${err.message}). Re-pin it with --update.`);
  }
  process.exit(1);
}

// **When the derivation itself is broken, say THAT and stop.** A classifier this parser can no
// longer read empties the literal set, and comparing an empty set against the pin buries the one
// true line under 65 shadows of it — the reader then fixes the loudest thing (#672).
if (arms.literals.length === 0 || suggestsKeys.length === 0 || arms.residual === null) {
  console.error("\n[check-code-vocabulary] FAIL — the extraction cannot derive the axis:\n");
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

// **The ceiling.** Both message-reading arms must stand behind the dictionary check. `problems`
// already carries the line when one does not; this is the statement of WHY it is fatal.
if (arms.dictionaryArms.some((a) => !a.guarded)) {
  problems.push("a classify arm now takes its code from the message without a dictionary check — this axis is no longer bounded above, and the pinned sets below are a lower bound wearing a total's clothes");
}

// **One presenter, and it is not called from anywhere else.** `toToolFailure` renders every flat
// failure that is not hand-built; a call site outside `_errors.ts` is a fourth entry point, and its
// code would enter the axis without passing any of the three readings above.
for (const { file, text } of sources) {
  if (file === "src/tools/_errors.ts") continue;
  if (/\btoToolFailure\s*\(/.test(stripComments(text))) {
    problems.push(`${file} calls toToolFailure directly — a fourth flat-failure entry point the extraction does not read`);
  }
}

// **Every produced code is either a dictionary key or pinned as advice-less.** The set is compared
// above; this line is the one that names the consequence, because the two halves are easy to read
// as bookkeeping: a code with no entry reaches the caller with an empty `suggest`, and `failCode`
// sites that pass advice inline are the reason eleven of them are deliberate.
for (const code of arms.literals) {
  if (!suggestsKeys.includes(code) && code !== arms.residual && !pinned.adviceLess?.includes(code)) {
    problems.push(`classify writes "${code}", which is in no dictionary and is not pinned as advice-less`);
  }
}

if (problems.length > 0) {
  console.error("\n[check-code-vocabulary] FAIL — the grid's code axis and the code's have diverged:\n");
  for (const p of problems.sort()) console.error(`  - ${p}`);
  console.error(
    "\n  This is ADR-036's fourth denominator. Re-pin with `npm run check:code-vocabulary -- --update` " +
      "ONLY together with the decision about the new slots: every added code is one a caller can " +
      "receive on the flat surface.\n",
  );
  process.exit(1);
}

const reachableHandBuilt = handBuilt.filter((h) => h.reached !== false);
console.log(
  `[check-code-vocabulary] OK — a caller can receive at most ${ceiling.length} codes on the flat ` +
    `surface: ${arms.literals.length} written as literals in the classifier (residual "${arms.residual}"), ` +
    `${dictionaryOnly.length} more reachable only when a producer spells the code into its own message, ` +
    `${failCode.codes.length} supplied at failCode call sites (${failCode.sites.length} sites), ` +
    `one fixed by failArgs ("${failArgsCode}"), and ${reachableHandBuilt.length} hand-built rather than rendered by ` +
    `the presenter. ${adviceLess.length} of them are in no SUGGESTS entry and reach the caller with whatever ` +
    `the call site passed. **This is a CEILING, not a lower bound** — the ${arms.dictionaryArms.length} arms that ` +
    `read a code out of a message both check the dictionary first, so a message cannot invent one. ` +
    `${envelopeWithinFlatCeiling.length} of the ${envelopeNames.length} names on the envelope surface fall inside this ` +
    `ceiling; ${envelopeOutsideFlatCeiling.length} fall outside it, so for those the flat surface CANNOT say the word the ` +
    `envelope says. Which of the ones inside are actually spelled by a producer's message is not answered here. ` +
    `${embedded.length} further codes are spelled inside embedded PowerShell and are RECORDED, not counted — ` +
    `one of them is snake_case in a field named \`code\`.`,
);
