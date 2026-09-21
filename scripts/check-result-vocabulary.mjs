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
// The type reader comes from the parser — see the note in `check-route-vocabulary.mjs`.
import { readUnion } from "./lib/typescript-source.mjs";
import {
  readPresentedNames,
  readReturnedCodes,
  readEnvelopeErrorNames,
  readLeaseCodes,
  readLeaseTable,
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
    // **Tested against the entry's NAME.** The relative-path form could never match: `walk` is only
    // ever called on `src`, so the path it compared always began with `src/` and no entry in the set
    // could equal it — a filter that asserted a claim it did not make (gate 2 on #674, finding 8).
    if (SKIPPED.has(entry.name) || SKIPPED.has(relative(REPO, full).split(sep).join("/"))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const sources = walk(join(REPO, "src")).map((file) => ({
  file: relative(REPO, file).split(sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

const typed = readUnion(read("src/engine/world-graph/guarded-touch.ts"), "TouchFailReason", () => [], problems, "src/engine/world-graph/guarded-touch.ts") ?? [];
if (typed.length === 0) problems.push("TouchFailReason could not be read — the typed half of the axis is unknown, not empty");

const suggestsKeys = readSuggestsKeys(read("src/tools/_errors.ts"), problems);
const conversion = readReasonConversion(read("src/tools/_envelope.ts"), problems);
const fallbackCause = readUnexpectedFallback(read("src/tools/_envelope.ts"), problems);

// ── The producers, which is what the first version of this file got wrong ────
//
// It modelled the name space with `SUGGESTS` — the ADVICE table, keyed BY the name, downstream of
// the thing it stood in for. That counted 82 values nothing produces and missed `handler_error`,
// `unknown` and the lease codes. Gate 2 on #672 added a fifth lease code and watched the gate print
// OK. The number went 101 to 26, and to 23 when arrival replaced membership (#673).
const RESOLVED_CODED = [{ file: "src/tools/_envelope.ts", identifier: "code", from: "mapLeaseValidationToTypedReason" }];
const RESOLVED_DYNAMIC_NAME = ["src/errors/typed-errors.ts:ToolFailureError:code"];
// **Reachability is derived now, not pinned by hand.** `handler_error` used to be carried here as
// "produced but with no production caller", maintained as a written-down list. Reading the
// presenter's own call sites answers it structurally: `toResultErr` never appears at one, so the
// name never enters the set and there is nothing to keep in step. A derived fact beats an exemption
// somebody has to remember to update.
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
// **Read at the presenter's call sites, not by family membership.** Membership was a proxy, and it
// was wrong for two classes: `RegionOutsideCapturableBoundsError` and `CaptureBackendFailedError`
// extend `HandlerError` and are thrown by the capture engine, but no `toFailureEnvelope(` site ever
// receives them (codex, #672, P1). The family read stays, but only to map a constructed class to
// the literal name it sets.
//
// **It is NOT that those two never reach an envelope.** win2 measured it (2026-09-17, internal
// `4ef46b4`): ask for a region off every monitor and the envelope is there — it just carries a
// different shape.
//
//   toFailureEnvelope path : data: null                      → if_unexpected.most_likely_cause
//   the engine's path      : data: { ok:false, code: … }     → data.code, and no if_unexpected
//
// So the distinction is not "does it reach the envelope" but **which key inside carries the cause**,
// and `err.name` reaches a caller on THREE of them:
//
//   reason             snake_case    toFailureEnvelope's raw projection
//   most_likely_cause  PascalCase    toFailureEnvelope's envelope
//   code               PascalCase    `toToolFailure` (`const code = err.name`), enveloped or not
//
// **This file counts the `toFailureEnvelope` path only.** `code` is a DIFFERENT axis that shares a
// producer and a spelling with `most_likely_cause`, so matching the two by name would collapse them
// into one. Getting the conclusion right off a wrong rule is how the next case is mis-sorted.
const family = readEnvelopeErrorNames(sources, problems, RESOLVED_DYNAMIC_NAME);
const errorNames = readPresentedNames(sources, family.nameOfClass, problems, RESOLVED_CODED);
// **The lease codes come from the function, not from the table beside it.** Gate 2's third round
// (#672): `mapLeaseValidationToTypedReason` hard-coded its returns and never consulted
// `LEASE_REASON_TO_TYPED_CODE`, whose own comment called it a reservation for future expansion. Two
// of its four names were produced by nothing, and adding a real branch left the gate green.
// **internal#125 gave those two branches, and the function now READS the table** — so the read is
// resolved through the branch's own discriminants, not to the whole table. Resolving it to the
// whole table would make "a reserved name nothing produces" true by construction, which is the
// #672 defect wearing the fix's clothes (Opus review Round 1 measured exactly that).
// The table is kept as a COVERAGE check — the role `SUGGESTS` was correctly demoted to. A code the
// function returns with no reserved name is the shape the reservation exists to prevent.
const reservedLeaseNames = readLeaseCodes(read("src/tools/_envelope.ts"), problems);
// internal#125 — the function now READS the table for two of its four reasons, so the table is
// handed in as the one expression this parser may resolve. Read before the function, because the
// function's codes depend on it now; the comment above about "the function, not the table" still
// holds as the RULE — what changed is that the function consults the table, so following it there
// is reading the producer rather than reading something adjacent to it.
const leaseCodes = readReturnedCodes(
  read("src/tools/_envelope.ts"),
  "mapLeaseValidationToTypedReason",
  problems,
  { name: "LEASE_REASON_TO_TYPED_CODE", table: readLeaseTable(read("src/tools/_envelope.ts"), problems) },
);
const producedNames = [
  ...new Set([...errorNames, ...leaseCodes, ...(fallbackCause === null ? [] : [fallbackCause])]),
].sort();

const computed = conversion.apply ? [...new Set(producedNames.map(conversion.apply))].sort() : [];
const fallbackReason = conversion.apply && fallbackCause !== null ? conversion.apply(fallbackCause) : null;

const serverCatalogue = readReasonCatalogue(read("src/server-windows.ts"), problems, "the server instructions' catalogue");
const toolCatalogue = readReasonCatalogue(read("src/tools/desktop-register.ts"), problems, "the desktop_act description's catalogue");

const receivable = [...new Set([...typed, ...computed])].sort();
const computedOnly = computed.filter((r) => !typed.includes(r));
const catalogued = new Set([...serverCatalogue, ...toolCatalogue]);
// **A produced name with no `SUGGESTS` key reaches the caller with generic advice.** Recorded
// rather than failed: two do today, and prose is what they carry.
const withoutAdvice = producedNames.filter((n) => !suggestsKeys.includes(n));

const derived = {
  typed,
  producedNames,
  computedOnly,
  fallbackReason,
  serverCatalogue,
  toolCatalogue,
  withoutAdvice,
  // **The two catalogues agreed on 2026-09-21 (internal #121), and the set is EMPTY now.** It used
  // to hold `aim_blocked_by_excluded_window`, pinned as a known difference rather than failed on,
  // because a gate that is red the day it lands is a gate somebody turns off (#670). That reason no
  // longer applies once the set is empty, so the promotion to a hard failure is below — and this is
  // the only moment it can be made without landing red.
  //
  // **The wording is NOT unified and is not meant to be.** Measured on this tree: both surfaces
  // carry **16** rows, **ONE** is byte-identical and **15** differ. (A row = one `"  name → …"`
  // element; the lease line naming four reasons is one row. On `main` it was 14 / 1 / 13.)
  //
  // **THE FIRST VERSION SAID 13 / 1 / 12, WHICH WAS TRUE OF NO TREE** (gate 2). It came from a scan
  // over a fixed LINE RANGE, which missed the `keyboard_target_unsafe` row — that one is a
  // concatenation spanning two lines. The instrument's scope was written down as the code's. The
  // counting method is stated above so the next reader can reproduce the number instead of
  // trusting it.
  //
  // They differ because they address different readers: the tool description says "V1" beside the
  // v2 surface and the server instructions do not. And **the description is kept short on purpose**
  // — `desktop-register.ts` records the measurement beside it: **the landing paragraph's long form**
  // cost ~667 tokens per session with v2 on and ~336 under the kill switch (win2, `2406b98`). That
  // number is about THAT paragraph, not about the whole description; it is quoted here with its
  // subject because a measurement copied without one becomes a budget somebody spends.
  //
  // What is canonical is the VOCABULARY: which reasons a caller is told about at all. Each surface
  // words its own row.
  unresolvable: UNRESOLVABLE.map((u) => u.producer),
  reservedLeaseNames,
  // **Two classes are declared twice with different names**, and both are presented. Which one a
  // presented class means depends on the walk order, so it is pinned as a fact rather than failed
  // on — a gate that is red the day it lands is a gate somebody turns off (#670). A THIRD collision,
  // or either of these two changing, is a change the grid records.
  classNameCollisions: family.collisions,
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
//
// **THE CATALOGUES ARE IN THIS LIST SINCE internal #121** (2026-09-21, gate 2). They were not, and
// the omission was load-bearing for the wrong side: `cataloguesDifferBy` is a SYMMETRIC DIFFERENCE,
// so two unread catalogues are empty, equal, and "agree". Measured before the fix — break the
// extraction and the new agreement check stays silent while 34 unrelated "the grid counts X, which
// the code no longer produces" lines shout, which is exactly the drowning this bail exists to stop.
// An empty read is now a problem in its own right, and it stops the run here.
if (conversion.apply === null || typed.length === 0 || suggestsKeys.length === 0 || producedNames.length === 0
    || serverCatalogue.length === 0 || toolCatalogue.length === 0) {
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

// **The two catalogues must name the same reasons** (internal #121, 2026-09-21). Before that day
// this was a pinned set with one member; the pin caught a CHANGE to the difference and accepted the
// difference itself. Now that the set is empty, the stronger statement costs nothing and says what
// was always wanted: a caller must not be told by one artefact about a recovery the other omits.
//
// It is the vocabulary that is pinned, never the prose — `cataloguesDifferBy` is derived from the
// reason NAMES each surface documents, and the two surfaces word their rows for their own readers.
//
// **WHAT THIS DOES NOT HOLD, said here because the summary line does not say it** (gate 2, P3-5):
// agreement is symmetric, so it catches a name present on one side and absent on the other — not a
// name dropped from BOTH. `unknown` is not a `TouchFailReason`, so the typed-coverage invariant
// below does not reach it either: what keeps it catalogued is the pinned set plus one cell naming
// it by hand (`adr-036-the-result-cell-counts-the-reasons`). Measured: remove the row from both
// surfaces and re-pin, and this file prints OK.
if (derived.cataloguesDifferBy.length > 0) {
  problems.push(
    `the two catalogues no longer name the same reasons: ${derived.cataloguesDifferBy.join(", ")} — ` +
      "one surface tells a caller about a recovery the other omits (internal #121)",
  );
}

// **The fallback CARRIES advice, and that is the pinned fact now.** This line used to assert the
// opposite — "`Unknown` is not a `SUGGESTS` key, so the reason it produces reaches the caller with
// an empty advice list" — and ended with the prediction "if it ever becomes a key the axis changes
// shape, and this line is where that shows". It showed, on 2026-09-21, when internal #121 gave the
// handler-throw fallback a next step.
//
// SO THE LINE IS TURNED AROUND RATHER THAN DELETED. An invariant that has become false is not the
// same as an invariant that has become uninteresting: what made it worth pinning — that the ONE
// reason a caller cannot interpret has its advice decided somewhere far from the callsite — is
// exactly as true pointing this way. Deleting it would leave the axis with no line to go red when
// the entry is removed again.
//
// **WHAT THIS LINE WATCHES, AND WHAT IT DOES NOT** (gate 2, F3 — the first wording claimed both).
// `fallbackCause` is read from `compatFailureRaw`'s default (`_envelope.ts`), NOT from the
// handler-throw callsite. Membership in `SUGGESTS` is shared by both roads, so this is a proxy:
// it fires when the NAME leaves the dictionary, and it is blind to a callsite that overrides
// `tryNext` with an explicit `[]`. Measured: restoring that override leaves this gate green and
// its summary byte-identical. That road is held by cells, and the cells are named here so the
// next reader does not mistake a green gate for a checked road.
//
// And the consequence it should name is not "advice-less". `toFailureEnvelope` substitutes its own
// generic line when a code has no entry, so removing the entry ships "inspect the underlying error
// and retry with adjusted args" — the one sentence internal #121 established must never appear on
// this road, because the error is deliberately unpublished and a throw can land after the side
// effect. The summary below already words it that way; only this message disagreed with it.
if (fallbackCause !== null && !suggestsKeys.includes(fallbackCause)) {
  problems.push(`the if_unexpected fallback "${fallbackCause}" is no longer a SUGGESTS key — the shared dictionary entry is gone, so every road that derives advice from this name now ships the converter's generic "inspect the underlying error and retry" line (internal #121). This line does not watch the handler-throw callsite's own \`tryNext\` override; cells do.`);
}

// **Every produced name should be a key, or the caller gets generic advice.** Not failed on — five
// are not today — but the SET is pinned above, so one more is a change the grid records.
for (const code of leaseCodes) {
  // The residual is not a lease name and is not reserved as one — the table's own comment says the
  // unpromoted reasons "collapse to `Unknown` at runtime" — a sentence internal#125 removed when it
  // gave those reasons branches, so the quotation is kept here as history rather than as a citation.
  // Everything else it returns should have a
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
    `reached it${computedOnly.includes(fallbackReason) ? `, including "${fallbackReason}"` : ""}. ${[...catalogued].length} are catalogued for the caller, so ` +
    `${receivable.filter((r) => !catalogued.has(r)).length} are not; ${withoutAdvice.length} produced names have no ` +
    `SUGGESTS entry and reach the caller with generic advice. The two catalogues differ by ` +
    `${derived.cataloguesDifferBy.length}. ${UNRESOLVABLE.length} producer${UNRESOLVABLE.length === 1 ? " takes" : "s take"} ` +
    `a name this extraction cannot enumerate, so the count is a LOWER BOUND, not a total. ` +
    `The names are read at the presenter's own call sites, so a class thrown but never handed to ` +
    `\`toFailureEnvelope\` is not counted here — it reaches the caller on \`code\`, which is its own ` +
    `axis sharing this one's spellings.`,
);
