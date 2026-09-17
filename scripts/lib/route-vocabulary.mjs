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

/** Every quoted member of `export type <name> = …;`, expanding template members. */
export function readUnion(source, name, resolve = () => []) {
  const text = stripComments(source);
  const m = text.match(new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`));
  if (!m) return null;
  const body = m[1];
  const values = [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  // `` `ground_disabled:${KeyboardGround}` `` is a member, not decoration: expand it against the
  // union it names, or the count is short by however many that union has.
  for (const t of body.matchAll(/`([^`$]*)\$\{(\w+)\}`/g)) {
    for (const suffix of resolve(t[2])) values.push(`${t[1]}${suffix}`);
  }
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
export function readRoadVocabulary(executorSource) {
  const text = stripComments(executorSource);
  const problems = [];
  const add = (set, re, group = 1) => {
    for (const m of text.matchAll(re)) set.add(m[group]);
  };

  const route = new Set();
  add(route, /\bprobeRoute\(\s*"([a-z_]+)"/g);
  add(route, /probeAim\(\s*"act\.route"\s*,\s*\{[^}]*?\broute:\s*"([a-z_]+)"/g);
  add(route, /^\s*route:\s*"([a-z_]+)"/gm);
  if (/\bprobeRefusal\(/.test(text)) route.add("refusal");

  // A `probeRoute(someVariable, …)` would silently shrink the set.
  for (const m of text.matchAll(/\bprobeRoute\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    if (m[1] !== "route") problems.push(`probeRoute is called with a non-literal road: ${m[1]}`);
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
  add(refused, /\brefused:\s*"([a-z0-9_]+)"/g);
  add(refused, /\brefused:\s*[^,\n]*\?\s*"([a-z0-9_]+)"/g);
  // `probedStep` hands `probeRefusal` a VARIABLE, so three grounds live in the function that
  // produces it and in no call site. Read them, or the set is 8 of 11 with nothing saying so.
  const adr029 = text.match(/function adr029Refusal\(([\s\S]*?)\n\}/);
  if (adr029) {
    // **Scoped to that function's body.** A global `return "…"` scan over the executor pulls in
    // every unrelated string return — it added five backend names to the refusal set on the first
    // run here, which is exactly the "the number looked complete" failure this file is for.
    for (const m of adr029[1].matchAll(/return\s+"([a-z0-9_]+)"/g)) refused.add(m[1]);
  } else {
    problems.push("adr029Refusal has moved: three refusal grounds are reachable only through it");
  }

  const why = new Set();
  add(why, /\bwhy:\s*"([a-z0-9_]+)"/g);

  return {
    route: [...route].sort(),
    rung: [...rung].sort(),
    refused: [...refused].sort(),
    why: [...why].sort(),
    problems,
  };
}
