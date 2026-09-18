#!/usr/bin/env node
// ADR-036 — the FOURTH denominator: the `code` a caller receives on a flat tool failure.
//
// Run: `npm run check:code-vocabulary` (add `--update` to re-pin, together with the decision).
//
// The grid's other three axes are the road (#669), the configuration (#670) and the result
// (#672 / #673). The result axis ended by naming this one and deliberately not counting it:
//
//     code                             PascalCase   toToolFailure — a handler that RETURNS a flat body
//     data.code                        PascalCase   the same body, once the envelope wraps it
//     reason                           snake_case   toFailureEnvelope's raw-compat projection
//     if_unexpected.most_likely_cause  PascalCase   toFailureEnvelope
//
// **Measured, and it corrected the reading this file was started on** (win2, 2026-09-18, internal
// `96d6e83`; 11 arms x 5 surfaces = 55 cells, no exception): **a cell that carries `code` carries no
// `reason`, and the reverse holds too — the two roads are disjoint.** `code` does NOT become
// `most_likely_cause` inside an envelope, because the wrapper's failure arm sends a RETURNED failure
// through `buildEnvelope` + `compatHoist`, and only a lease check or a THROWN handler error reaches
// `toFailureEnvelope`. Two presenters, chosen by how the failure left the handler.
//
// **`code` shares a producer and a spelling with `most_likely_cause`.** Matching the two by name
// collapses two axes into one, and the conclusion can be right off a rule that mis-sorts the next
// case. So this file counts `code` at ITS producers, and states the overlap with the third axis as
// a derived number rather than letting a name do the matching.
//
// **The MESSAGE road is bounded, and the bound is structural — but the axis as a whole is not.**
// Two arms of `classify` turn a producer's message into a code, and both require
// `Object.hasOwn(SUGGESTS, …)` — un-negated, not behind an `||` — so no message can invent a code.
// Remove or negate either guard and that road has no upper bound at all, which is why the guard is
// read for its POLARITY and not merely for its presence.
//
// **The call-site road is where the ceiling leaks, and one site leaks today.** `keyLockerFailure`
// takes `String(err.code)` off any thrown object and forwards it to `failCode`, so `LockerNotBound`
// and `SshFingerprintSetRequired` reach a caller's `code` without appearing in any set this file
// derives. The first version of this header called the whole count a ceiling and the gate printed it
// while exiting 0 (gate 2 on #674, round 2). Such a site is now NAMED — pinned, and the summary says
// "lower bound" for as long as the list is non-empty.
//
// **What it does NOT claim.** 26 of the dictionary's keys are written by no arm and named at no
// call site: they are reachable only when some producer spells the code into its own message —
// `KeyLockerDisabled: the key locker live wiring is not active` does, and `AimOccludedError`'s prose
// sentence ("The window this action was aimed at…") does not — so whether the flat surface can say
// `AimOccluded` at all is decided by text this file does not read. Which of the 26 are
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
    // **Tested against the entry's NAME.** The relative-path form could never match: `walk` is only
    // ever called on `src`, so the path it compared always began with `src/` and no entry in the set
    // could equal it — a filter that asserted a claim it did not make (gate 2 on #674, finding 8).
    if (SKIPPED.has(entry.name) || SKIPPED.has(relative(REPO, full).split(sep).join("/"))) continue;
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
const failCode = readFailCodeSites(sources);

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
//
// **A site whose code is COMPUTED does not contribute a code.** `toToolFailure` itself is one of
// these — it is the canonical presenter, and its `code` is the shorthand property holding
// `err.name`. Carrying the expression text into the count made the headline say a caller can
// receive a code called `err.name` (gate 2 on #674, finding 6): the overclaim the ceiling exists to
// prevent, one field further down. The site is still pinned, with its expression, so a new computed
// builder is a change the grid records — it is the VALUE that stays out of the count.
const handBuilt = readHandBuiltFlatFailures(sources).map((site) => ({
  // **The identity is the file, the enclosing scope and the code — not the line.** The line is the
  // precise location and it was pinned for exactly one mutation round: adding a COMMENT above a site
  // moved it, and the negative control that adds a comment went red. A gate that reddens for an
  // unrelated edit above a producer is a gate somebody turns off (#670). The scope name can be a
  // neighbour's when a declaration merely spans the site (gate 2, round 3), so it is carried as a
  // hint beside the file, and the line is printed in the summary rather than pinned.
  where: `${site.file}${site.fn === null ? "" : ` (${site.fn})`}`,
  line: site.line,
  code: site.code,
  expression: site.expression,
  // **An exported declaration is reachable by definition**, and an unidentifiable enclosing form is
  // UNKNOWN rather than unreachable — excluding a code from the count on a guess is the one error
  // whoever re-pins would make permanent (gate 2 on #674, round 2, finding 4).
  reached: site.exported ? true : site.fn === null ? null : isCalledOutside(sources, site.fn, site.file),
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
// nothing. Pinned rather than failed on: twelve do today, and one of them is the residual.
//
// **"With nothing" means the key is absent, not an empty array** — measured on the same round (win2,
// 2026-09-18): `getSuggestsForCode` returns `[]`, `renderAdviceWithFloor` turns that into
// `undefined`, and the presenter omits `suggest` entirely. The two states stay distinguishable on
// the wire, which is what that function was written for. On the OTHER road the advice arrives under
// a different key again (`if_unexpected.try_next`), so "does this code carry advice" has two answers
// wearing two names, and this file counts the flat one.
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
  // **Call sites that forward a value this extraction cannot enumerate.** One does today:
  // `keyLockerFailure` takes `String(err.code)` off any thrown object and hands it to `failCode`, so
  // `LockerNotBound` and `SshFingerprintSetRequired` reach a caller's `code` without appearing in
  // any set below. Pinned rather than failed on, like the result axis's `ToolFailureError:code` —
  // and the summary stops calling the count a ceiling while this list is non-empty, because it is
  // not one (gate 2 on #674, round 2).
  // Pinned WITHOUT the line number, for the reason `handBuilt` drops it: a comment added above the
  // site moved it and the gate failed in both directions for an edit that changed nothing (gate 2 on
  // #674, round 4, finding 4).
  // **Deduping after stripping the line hid a second site.** Two `String(err.code)` forwards in one
  // file collapsed to one pin entry, so adding another left the pin byte-identical and the gate
  // green — a new producer of unenumerable codes landing unnoticed (gate 2 on #674, round 5,
  // finding 4). The count survives the strip, so the set still changes when a site is added.
  unreadableCallSites: Object.entries(
    failCode.unreadable.reduce((acc, u) => {
      const key = u.replace(/^([^:]+):\d+: /, "$1: ");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([key, n]) => (n === 1 ? key : `${key} (x${n})`))
    .sort(),
  residual: arms.residual,
  dictionaryArms: arms.dictionaryArms.map((a) => a.identifier).sort(),
  dictionaryOnly,
  failCodeCodes: failCode.codes,
  failArgsCode,
  handBuilt: handBuilt
    .map(
      (h) =>
        `${h.where} \u2192 ${h.code === null ? `(computed: ${h.expression})` : h.code}` +
        `${h.reached === false ? " (no caller outside its file)" : ""}`,
    )
    .sort(),
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
const bounded = failCode.unreadable.length === 0;
// **The parts overlap, so they are not addends.** Nine `failCode` codes are also classifier
// literals, `InvalidArgs` is both `failArgs`' fixed code and one of the hand-built sites, and
// `TextPattern2ParseError` is both dictionary-only and hand-built — a reader who added the five
// numbers got 117 where the same sentence said 106 (gate 2 on #674, round 2, finding 3). The union
// is the number; each part is printed as a set it draws from, with the overlap stated.
console.log(
  `[check-code-vocabulary] OK — ${ceiling.length} distinct codes can reach a caller's flat \`code\`, ` +
    `drawn from overlapping producers (the parts below share ${arms.literals.length + dictionaryOnly.length + failCode.codes.length + 1 + reachableHandBuilt.filter((h) => h.code !== null).length - ceiling.length} members, so they do not add up to it): ` +
    `${arms.literals.length} written as literals in the classifier (residual "${arms.residual}"), ` +
    `${dictionaryOnly.length} dictionary keys no arm writes and no call site names — reachable only when a ` +
    `producer spells the code into its own message, ${failCode.codes.length} named at ` +
    // **Distinct locations.** `sites` holds one row per (site x resolved code), so a two-branch
    // ternary contributes two and a four-branch one contributes four: printing its length said 49
    // where there are 45 call sites (gate 2 on #674, round 3, finding 5). Same class as the parts
    // that summed to 117 — a number that names one thing and counts another.
    `${new Set(failCode.sites.map((x) => `${x.file}:${x.line}`)).size} ` +
    `failCode call sites, one fixed by failArgs ("${failArgsCode}"), and ` +
    `${reachableHandBuilt.filter((h) => h.code !== null).length} hand-built rather than rendered by the presenter ` +
    `(${handBuilt.filter((h) => h.code === null).length} more build the shape with a COMPUTED code, pinned but ` +
    `contributing no value). ${adviceLess.length} are in no SUGGESTS entry and reach the caller with whatever the ` +
    `call site passed.\n\n` +
    `  The MESSAGE road is bounded: the ${arms.dictionaryArms.length} classifier arms that read a code out of a ` +
    `message require \`Object.hasOwn(SUGGESTS, …)\`, un-negated and not behind an \`||\`, so no message can ` +
    `invent a code. ` +
    (bounded
      ? "No call site forwards a value this extraction cannot enumerate, so the number above is a CEILING."
      : `${failCode.unreadable.length} call site${failCode.unreadable.length === 1 ? "" : "s"} forward${failCode.unreadable.length === 1 ? "s" : ""} a computed value ` +
        `(${failCode.unreadable.join("; ")}), so the number above is a LOWER BOUND, not a total: those codes ` +
        `reach a caller without passing any producer this file can read.`) +
    `\n\n  ${envelopeWithinFlatCeiling.length} of the ${envelopeNames.length} names on the envelope surface fall inside ` +
    `this set; ${envelopeOutsideFlatCeiling.length} fall outside it` +
    // **A definitive negative cannot be read off a set that was just called a lower bound.** The
    // names of the two sets were corrected for exactly this overclaim in round 2; the sentence that
    // printed them kept it (gate 2 on #674, round 3, finding 4).
    (bounded
      ? ", so for those the flat surface cannot say the word the envelope says."
      : " — meaning this file found no flat road for them, which is not the same as there being none, because the set above is a lower bound.") +
    ` Which of the ${dictionaryOnly.length} are actually spelled by a producer's message is not ` +
    `answered here. ${embedded.length} further codes are spelled inside embedded PowerShell and are RECORDED, not ` +
    `counted — one of them is snake_case in a field named \`code\`.`,
);
