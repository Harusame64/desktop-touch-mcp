// ADR-036 — the vocabulary the completion grid counts, read out of the source.
//
// **The gate's denominator is "the vocabulary extracted from the code × configuration × result"**
// (the user's decision, 2026-09-11). Extracted, not hand-listed — so that a road added in code
// cannot quietly become a slot nobody counted. This module is the extraction; the pinned sets live
// beside it in `tests/fixtures/adr-036-route-vocabulary.json`, and `check:route-vocabulary` fails
// when the two disagree.
//
// **What makes this hard is that the axis has no type.** `probeRoute(route: string, …)` hands an
// untyped string into `probeAim(seam, data: Record<string, unknown>)`, so none of the road values
// appears in any union anywhere in the repo: a typo at a new call site compiles, ships, and writes
// a road nobody counted. This file is the first artefact that asserts a denominator for it.
//
// Two traps, both paid for already and both handled below:
//  - **Comments quote the literals they discuss.** `why: "uia_set_value"` appears in prose one
//    screen above the line that produces it. Comments are stripped first, line numbers preserved.
//  - **A template-literal union member is a member.** `LandingWhy` ends in
//    `` `ground_disabled:${KeyboardGround}` ``; reading only quoted literals gives 8 where the
//    vocabulary is 11.

/** Strip `//` and `/* … *​/` comments, keeping every line's index. */
export function stripComments(source) {
  const out = source.replace(/\r\n/g, "\n").split("\n");
  let inBlock = false;
  for (let i = 0; i < out.length; i++) {
    let line = out[i];
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out[i] = "";
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const open = line.indexOf("/*");
      if (open === -1) break;
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 2);
    }
    out[i] = line.replace(/\/\/.*$/, "");
  }
  return out.join("\n");
}

/**
 * Every quoted member of `export type <name> = …;`, expanding template members.
 *
 * `problems` (optional) collects members this parser cannot read — a template whose named union it
 * cannot resolve, a backticked member with no interpolation, a `typeof ARR[number]`. **Without it
 * the union simply comes back shorter**, and a shorter set is indistinguishable from a complete one
 * (gate 2 on #669).
 */
export function readUnion(source, name, resolve = () => [], problems = []) {
  const text = stripComments(source);
  const m = text.match(new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`));
  if (!m) return null;
  const body = m[1];
  const values = [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  // `` `ground_disabled:${KeyboardGround}` `` is a member, not decoration: expand it against the
  // union it names, or the count is short by however many that union has.
  for (const t of body.matchAll(/`([^`$]*)\$\{(\w+)\}`/g)) {
    const expanded = resolve(t[2]);
    if (expanded.length === 0) problems.push(`${name}: cannot resolve the template member \`${t[1]}\${${t[2]}}\``);
    for (const suffix of expanded) values.push(`${t[1]}${suffix}`);
  }
  // A backticked member this parser did not expand above, and anything that is not a quoted literal
  // at all (`typeof ARR[number]`, a referenced union, single quotes).
  for (const t of body.matchAll(/`([^`]*)`/g)) {
    if (!/\$\{\w+\}/.test(t[1])) problems.push(`${name}: member \`${t[1]}\` is not a quoted literal this parser reads`);
  }
  if (values.length === 0 && body.trim() !== "" && !/`/.test(body)) {
    // No quoted member at all: `(typeof ARR)[number]`, a referenced union, single quotes. Returning
    // an empty set silently is the same shape as returning a short one.
    problems.push(`${name}: no quoted members — \`${body.trim().slice(0, 60)}\` is not a union this parser reads`);
  }
  for (const member of body.split("|").slice(1)) {
    const t = member.trim().replace(/;$/, "");
    if (t === "" || t.startsWith('"') || t.startsWith("`")) continue;
    problems.push(`${name}: member \`${t}\` is not a quoted literal this parser reads`);
  }
  return [...new Set(values)].sort();
}

/**
 * A union written INLINE as a field of a type: `export type Homing = … | { … why: "a" | "b" … }`.
 *
 * The homing rung writes that field straight into the road row, so its members are part of the
 * `why` axis — and it is not an `export type` of its own, so `readUnion` cannot see it.
 */
export function readInlineFieldUnion(source, typeName, field, problems = []) {
  const text = stripComments(source);
  // **Anchored on a word boundary.** `export type PointOwnerVia` sits above `export type
  // PointOwner` in the same file, and a substring search reads the one-liner instead — one value
  // where the vocabulary has four, with nothing saying so.
  const start = text.search(new RegExp(`export type ${typeName}\\b`));
  if (start === -1) {
    problems.push(`${typeName} not found — the ${field} union it carries is not being read`);
    return [];
  }
  // To the declaration's terminating `;` **at brace depth 0**. Two cuts were wrong before this
  // one: the first blank line (comment-stripping leaves blanks inside a type) and the first `;`
  // (a member object separates its own fields with `;`). Both read part of a union as the whole.
  let depth = 0;
  let end = text.length;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) {
      end = i;
      break;
    }
  }
  const body = text.slice(start, end);
  // A type can carry the field more than once — `PointOwner` has a `why` on two of its members,
  // and reading only the first gives one value where the vocabulary has four.
  const values = [];
  let seen = false;
  for (const m of body.matchAll(new RegExp(`${field}:\\s*([^;\\n]*)`, "g"))) {
    seen = true;
    for (const v of m[1].matchAll(/"([^"]+)"/g)) values.push(v[1]);
  }
  if (!seen) {
    problems.push(`${typeName} has no ${field} field where one was expected`);
    return [];
  }
  if (values.length === 0) problems.push(`${typeName}.${field} read as empty — has it stopped being a union of literals?`);
  return [...new Set(values)].sort();
}

/**
 * The road vocabulary as the executor writes it: the `route` field, and the three fields a cell
 * needs if it is to fail red for the right reason (`rung`, `refused`, `why`).
 *
 * `problems` carries anything that would make the extraction lie — a `probeRoute` whose first
 * argument is not a literal, above all. A non-literal there means the set below is a lower bound
 * and nothing says so, which is the failure this whole gate exists to end.
 */
export function readRoadVocabulary(executorSource, resolveUnion = () => []) {
  const text = stripComments(executorSource);
  const problems = [];
  // Unions a `why` draws from at runtime, by name — expanded by the caller, which has the files.
  const dynamicWhy = new Set();
  const add = (set, re, group = 1) => {
    for (const m of text.matchAll(re)) set.add(m[group]);
  };

  const route = new Set();
  add(route, /\bprobeRoute\(\s*"([a-z0-9_]+)"/g);
  // `probeAim("act.route", { route: "x" })` written directly would be a second producer; the tree
  // routes everything through `probeRoute`, and a direct call now arrives as a reported non-literal
  // rather than as a rule that matches nothing (gate 2 on #669: three such rules were dead).
  add(route, /probeAim\(\s*"act\.route"\s*,\s*\{[\s\S]{0,400}?\broute:\s*"([a-z0-9_]+)"/g);

  // **Anything that is not a string literal, at any producer, is reported.** The first version
  // reported one shape out of six: a ternary, a `const` holding the value, a variable named
  // `route` (exempted by name — an exemption whose only effect was to open a hole named after the
  // field it guarded), a road with a digit, and a nested object before `route:` all under-counted
  // in SILENCE. The header promises the opposite, and gate 2 on #669 fed it all six.
  const literalFirstArg = /^\s*"[a-z0-9_]+"\s*[,)]/;
  // The helpers' own declarations name their parameters; they are not call sites.
  const isDeclaration = (index) => /\bfunction\s+\w+\s*\($/.test(text.slice(Math.max(0, index - 40), index + 1));
  const reportNonLiteral = (re, what) => {
    for (const m of text.matchAll(re)) {
      if (isDeclaration(m.index + m[0].indexOf("("))) continue;
      if (!literalFirstArg.test(m[1])) problems.push(`${what} is given a non-literal: ${m[1].trim().slice(0, 60)}`);
    }
  };
  reportNonLiteral(/\bprobeRoute\(([^)\n]*)/g, "probeRoute");
  // `probedStep(rung, …)` forwards its own parameters to `probeRefusal`; the values it can pass
  // are read from `adr029Refusal`'s body below. Recognised, not reported — and the recognition is
  // narrow, so any OTHER variable at this call site still surfaces.
  reportNonLiteral(/\bprobeRefusal\(((?!\s*rung,\s*refused\b)[^)\n]*)/g, "probeRefusal");
  for (const m of text.matchAll(/\bwhy:\s*([^,\n}]+)/g)) {
    const value = m[1].trim();
    if (/^"[a-z0-9_]+"$/.test(value)) continue;
    // A TYPE annotation, not a value: `why: "a" | "b"` in a signature. Its literals are already
    // collected by the rule above, at their producing call sites.
    if (value.includes("|")) continue;
    // **One dynamic `why` is legitimate and resolved by name**: the homing rung writes
    // `homing.applied ? null : homing.why`, so every `Homing.why` member is a `why` this axis can
    // carry. Resolved here rather than reported, because the union it draws from is named in the
    // expression — and pinned in the fixture, so the day it draws from somewhere else the count
    // moves. Anything else dynamic is still reported.
    if (/^[\w.]*\bhoming\.why$/.test(value.replace(/^.*\?\s*null\s*:\s*/, ""))) {
      dynamicWhy.add("homing.why");
      continue;
    }
    // **A different axis wearing the same field name.** `why: verdict.why` sits inside the
    // `landing` object, not on the road row, and it draws from `LandingWhy` — which this file
    // already extracts as its own axis. Folding it into `why` would merge two axes on a shared
    // spelling, which is the mistake this whole vocabulary exists to avoid.
    if (/\bverdict\.why$/.test(value)) {
      dynamicWhy.add("landing.why");
      continue;
    }
    // The containment rung writes the point owner's own reason through.
    if (/\bowner\.why$/.test(value)) {
      dynamicWhy.add("owner.why");
      continue;
    }
    problems.push(`a why is not a literal: ${value.slice(0, 60)}`);
  }

  const rung = new Set();
  add(rung, /\brefusal\(\s*"([a-z0-9_]+)"/g);
  add(rung, /\bprobeRefusal\(\s*"([a-z0-9_]+)"/g);
  add(rung, /\bprobedStep\(\s*"([a-z0-9_]+)"/g);
  add(rung, /\brung:\s*"([a-z0-9_]+)"/g);
  add(rung, /\brung:\s*[^,\n]*\?\s*"([a-z0-9_]+)"/g);

  const refused = new Set();
  add(refused, /\brefusal\(\s*"[a-z0-9_]+"\s*,\s*"([a-z0-9_]+)"/g);
  add(refused, /\bprobeRefusal\(\s*"[a-z0-9_]+"\s*,\s*"([a-z0-9_]+)"/g);
  add(refused, /\brefused:\s*[^,\n]*\?\s*"([a-z0-9_]+)"/g);
  // `probedStep` hands `probeRefusal` a VARIABLE, so three grounds live in the function that
  // produces it and in no call site. Read them, or the set is 8 of 11 with nothing saying so.
  const adr029 = text.match(/function adr029Refusal\(([\s\S]*?)\n\}/);
  if (adr029) {
    // **Scoped to that function's body.** A global `return "…"` scan over the executor pulls in
    // every unrelated string return — it added five backend names to the refusal set on the first
    // run here, which is exactly the "the number looked complete" failure this file is for.
    for (const m of adr029[1].matchAll(/return\s+"([a-z0-9_]+)"/g)) refused.add(m[1]);
  } else if (/\bprobedStep\(/.test(text)) {
    // Only when something actually routes through it. Reporting its absence for any source at all
    // makes every small extraction carry a false alarm, and an alarm that is always on is read as
    // noise — which is how a real one gets walked past.
    problems.push("adr029Refusal has moved: three refusal grounds are reachable only through it");
  }

  const why = new Set();
  add(why, /\bwhy:\s*"([a-z0-9_]+)"/g);

  const landingWhyOnTheRow = [];
  for (const name of dynamicWhy) {
    const members = resolveUnion(name);
    if (members.length === 0) problems.push(`a why draws from ${name}, which could not be resolved`);
    // `homing.why` really is a road `why`; `landing.why` is the landing axis, returned separately
    // so the caller can assert the two agree without merging them.
    if (name === "landing.why") landingWhyOnTheRow.push(...members);
    else for (const m of members) why.add(m);
  }

  return {
    landingWhyOnTheRow: [...new Set(landingWhyOnTheRow)].sort(),
    route: [...route].sort(),
    rung: [...rung].sort(),
    refused: [...refused].sort(),
    why: [...why].sort(),
    problems,
  };
}
