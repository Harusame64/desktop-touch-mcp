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

/**
 * Strip `//` and block comments, keeping every line's index — **without reading inside a string, and
 * without mistaking a regular expression for a comment**.
 *
 * Two defects paid for this function, one on each side of the same line:
 *
 * The line-at-a-time version was not string-aware, so a `//` inside a string truncated the line:
 * `"See https://github.com/…"` became `"See https:`. What that leaves is not a missing comment but
 * an UNBALANCED QUOTE, after which every brace-matching parser downstream walks into the wrong
 * block and returns less than it should with `problems` empty. The non-Windows stub's hand-built
 * failure vanished from a sweep that had listed it minutes before (2026-09-18).
 *
 * The first character-scanning rewrite fixed that and reintroduced it one construct over: the `\/`
 * and the closing `/` of `/^https?:\/\//i` read as a line comment, and the rest of the line — the
 * `{` that opens the `if` — was dropped. Live on two files (`engine/cdp-bridge.ts:582`,
 * `engine/key-locker/command-derivation.ts:348`), measured as a brace balance of -1 (gate 2 on
 * #674). **The same silent under-read, one grammar rule further in.** So a regular-expression
 * literal is now a state of its own, entered only where a regex can legally begin.
 *
 * A stray quote that this scanner takes for an opener would swallow the rest of the file just as
 * quietly, so a single- or double-quoted run and a regex both end at the newline: TypeScript's do
 * too, and a template literal is the only one that may cross one.
 */
export function stripComments(source) {
  const src = source.replace(/\r\n/g, "\n");
  // A `/` opens a regex only where a value may begin. Reading the last emitted non-space character
  // answers that for every shape this tree writes (`(`, `,`, `=`, `[`, `!`, `&&`, `return`, …); a
  // division follows an identifier, a number, or a closing bracket, and those are the else.
  const opensValue = /(?:[=(,[!&|?:;{}+\-*%^~<>]|\breturn|\btypeof|\bcase|\bin|\bof|\bdo|\belse|\bvoid|\bdelete|\binstanceof|\bnew|\byield|\bawait)\s*$/;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // Comments first — the specification agrees: `//` is never an empty regex, `/*` never a regex.
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        out += c;
        i++;
        if (c === "\\") {
          out += src[i] ?? "";
          i++;
          continue;
        }
        if (c === quote) break;
        if (c === "\n" && quote !== "`") break;
      }
      continue;
    }
    if (ch === "/" && opensValue.test(out)) {
      out += ch;
      i++;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        out += c;
        i++;
        if (c === "\\") {
          out += src[i] ?? "";
          i++;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
  // **Not `.slice(1)`.** That was written for the leading-pipe style, where element 0 is the
  // whitespace before the first `|` — and it threw away a REAL member of every single-line union
  // (`export type K = OtherUnion | "uia"` read as complete with one of two). The empty/whitespace
  // element the slice was there to skip is skipped by the `t === ""` guard, which is the property
  // that was actually wanted (gate 2 on #669, second pass).
  for (const member of body.split("|")) {
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
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) {
      end = i;
      break;
    }
    // **TypeScript's terminating `;` is optional**, and the fall-through used to be `text.length`
    // — one dropped semicolon and every `why:` in every type BELOW this one joined the axis, in
    // silence, until the pin failed against values nothing can produce (gate 2 on #669, second
    // pass). A declaration that starts at depth 0 ends the one above it just as well.
    else if (depth === 0 && ch === "\n" && /^(export\s+)?(type|interface|const|function|class)\b/.test(text.slice(i + 1, i + 40))) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    problems.push(`${typeName} has no terminating \`;\` and nothing follows it — the ${field} union was read to the end of the file`);
    end = text.length;
  }
  const body = text.slice(start, end);
  // A type can carry the field more than once — `PointOwner` has a `why` on two of its members,
  // and reading only the first gives one value where the vocabulary has four.
  const values = [];
  let seen = false;
  // **Not `[^;\n]*`.** A union grows past the line limit by breaking onto continuation lines —
  // which is how a union usually grows — and stopping at the newline read one member of however
  // many (gate 2 on #669, second pass). Run to the field's own terminator instead: a `;`, a brace,
  // or the next `name:` field on the same object.
  for (const m of body.matchAll(new RegExp(`\\b${field}:\\s*([^;{}]*)`, "g"))) {
    seen = true;
    const value = m[1].split(/,\s*\w+\s*:/)[0];
    for (const v of value.matchAll(/"([^"]+)"/g)) values.push(v[1]);
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
  // Whys spelled only in a producer's parameter annotation, because the call site uses a shorthand.
  const annotatedWhy = new Set();
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
  const reportNonLiteral = (re, what, recognised = () => false) => {
    for (const m of text.matchAll(re)) {
      if (isDeclaration(m.index + m[0].indexOf("("))) continue;
      if (recognised(m[1])) continue;
      if (literalFirstArg.test(m[1])) continue;
      const shown = m[1].trim().replace(/\s+/g, " ").slice(0, 60);
      problems.push(`${what} is given a non-literal: ${shown === "" ? "(no first argument on this line)" : shown}`);
    }
  };
  // **`[^)]`, not `[^)\n]`.** Wrapping a long call so its first argument sits on the next line is
  // ordinary formatting, and the newline-stopping capture reported it as a non-literal while
  // printing an EMPTY offender — a gate that goes red for a reformat, saying nothing about what it
  // objected to, is a gate somebody loosens next month (gate 2 on #669, second pass).
  reportNonLiteral(/\bprobeRoute\(([^)]{0,200})/g, "probeRoute");
  reportNonLiteral(/\bprobedStep\(([^)]{0,200})/g, "probedStep");
  reportNonLiteral(/\brefusal\(([^)]{0,200})/g, "refusal");

  // **An exemption keyed on a SPELLING is a hole named after the field it guards.**
  //
  // `probedStep` forwards its own `rung` and the `refused` it just computed, so that one call site
  // cannot be a literal and the grounds are read out of `adr029Refusal`'s body instead. The first
  // version of this file exempted `probeRoute`'s first argument when it was *named* `route`; gate 2
  // closed that — and this line was then written in the same shape for `probeRefusal`, in the same
  // commit that closed it. win2 shot it on 2026-09-17 (internal `790e43a`): keeping the two names
  // and changing what `refused` HOLDS —
  //
  //     const refused = adr029Refusal(err) ?? "smuggled_ground";
  //
  // — walked a refusal ground that reaches the row past the gate, which printed `OK` and exited 0.
  // **That is the exact failure this whole file exists to end.**
  //
  // So the exemption is keyed on the BINDING it forwards, not on the identifiers: the file must
  // bind `refused` to `adr029Refusal(…)` and nothing else. Append a `??`, a `||`, a ternary or a
  // second assignment and the binding stops matching, the exemption lifts, and the call site is
  // reported as what it then is — a road field this parser cannot read.
  //
  // **A type annotation is not a change of binding.** win2 measured the cost of tightening
  // (2026-09-17, internal `f493bad`): of four meaning-preserving edits, wrapping, whitespace and a
  // trailing comment are free, and `const refused: string | undefined = adr029Refusal(err);` went
  // red. What this test is about is what the binding HOLDS, and an annotation changes nothing
  // about that — so it is allowed, while `??`, `||`, a ternary and a second assignment all still
  // lift the exemption, because the `)` must be followed by the statement's `;`.
  const forwardsTheReadBinding = /\bconst\s+refused\s*(?::[^=;]+)?=\s*adr029Refusal\([A-Za-z_$][\w$]*\)\s*;/.test(text);
  if (/\bprobedStep\(/.test(text) && !forwardsTheReadBinding) {
    problems.push(
      "probedStep no longer forwards `const refused = adr029Refusal(err);` — the grounds read out of " +
        "that function are not the grounds written",
    );
  }
  reportNonLiteral(
    /\bprobeRefusal\(([^)]{0,200})/g,
    "probeRefusal",
    (args) => forwardsTheReadBinding && /^\s*rung,\s*refused\s*[,)]/.test(args),
  );
  // **The landing why is a different axis wearing the same field name**, and the separation has to
  // be made on the SPELLING OF THE ROW, not on the shape of the value. The dynamic spelling
  // (`why: verdict.why`) was routed away below from the first version; the LITERAL one —
  // `landing: { confirmed: false, why: "receiver_unknown", … }` at the keyboard rung's "cannot say"
  // return — fell straight through into the road axis, so `receiver_unknown` was pinned on three
  // axes at once and the comment below claimed a separation that held for one spelling out of two
  // (gate 2 on #669, second pass). Both are collected here, and both are subtracted from `why`.
  const landingLiteralWhy = new Set();
  let landingDrawsFromTheUnion = false;
  for (const m of text.matchAll(/\blanding:\s*\{([^{}]*)\}/g)) {
    for (const v of m[1].matchAll(/\bwhy:\s*"([a-z0-9_]+)"/g)) landingLiteralWhy.add(v[1]);
    if (/\bwhy:\s*[\w.]*\bverdict\.why\b/.test(m[1])) landingDrawsFromTheUnion = true;
  }

  for (const m of text.matchAll(/\bwhy:\s*([^,\n}]+)/g)) {
    // The capture stops at `,` `\n` `}` — so a `why:` that is the LAST parameter of a signature
    // brings the signature's own `)` with it. Give back the brackets that were never ours, or the
    // annotation below reads as an unrecognised shape and the values in it are lost again.
    const value = m[1].trim().replace(/[\s){;]+$/, "");
    if (/^"[a-z0-9_]+"$/.test(value)) continue;
    // **A TYPE annotation is where a shorthand's values are written.** The keyboard rung passes
    // `{ why, verdict: … }` — an ES6 shorthand, which carries no `why:` for the literal rule to
    // find — so the only place those two values are spelled is the parameter's annotation. The
    // first version skipped the annotation outright with a comment saying the literals "are already
    // collected at their producing call sites"; they were not, and `keyboard_only_entity` was a why
    // the row demonstrably writes, missing from the axis and from the pin, with `problems` empty
    // (gate 2 on #669, second pass). **A union of literals here IS the producer's vocabulary.**
    if (value.includes("|")) {
      // **Every member, or none of them.** `"a" | SomeUnion` starts with a literal and would look
      // readable to a prefix test while losing whatever `SomeUnion` holds — the same "a shorter set
      // is indistinguishable from a complete one" shape this whole file is against.
      const parts = value.split("|").map((x) => x.trim());
      if (parts.every((x) => /^"[a-z0-9_]+"$/.test(x))) {
        for (const v of value.matchAll(/"([a-z0-9_]+)"/g)) annotatedWhy.add(v[1]);
      } else {
        problems.push(`a why union is not all quoted literals: ${value.slice(0, 60)}`);
      }
      continue;
    }
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
  // **A row can write `refused:` directly**, and two do — the `aim_check` row and the `probeAim`
  // spelling. This line was DELETED in the commit that took gate 2's first pass, which made the
  // guard strictly weaker than the head it replaced: a brand-new refusal ground on an
  // already-pinned rung was collected by neither this rule nor `reportNonLiteral` (which reads
  // first arguments only), so the script printed `OK` and exited 0 on a ground that reaches the
  // row and is in no set anywhere (gate 2 on #669, second pass). **Do not delete it again.**
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
  } else if (/\bprobedStep\(/.test(text)) {
    // Only when something actually routes through it. Reporting its absence for any source at all
    // makes every small extraction carry a false alarm, and an alarm that is always on is read as
    // noise — which is how a real one gets walked past.
    problems.push("adr029Refusal has moved: three refusal grounds are reachable only through it");
  }

  const why = new Set();
  add(why, /\bwhy:\s*"([a-z0-9_]+)"/g);
  for (const v of annotatedWhy) why.add(v);

  for (const name of dynamicWhy) {
    if (name === "landing.why") continue;
    const members = resolveUnion(name);
    if (members.length === 0) problems.push(`a why draws from ${name}, which could not be resolved`);
    for (const m of members) why.add(m);
  }
  // The landing object's whys are not road whys. Subtracting them here rather than never adding
  // them keeps the literal rule above simple — and the subtraction is what makes the three axes
  // disjoint, which is the property the fixture is supposed to pin.
  for (const v of landingLiteralWhy) why.delete(v);

  return {
    // **What the ROW writes**, which is not the same fact as what `LandingWhy` declares. The first
    // version filled this from `resolveUnion("landing.why")` — the very same call the caller uses
    // for the `landingWhy` axis — so the checker's "the two must be the same set" invariant
    // compared a function to itself and could not fail, and the fixture carried eleven values twice
    // (gate 2 on #669, second pass, which evaluated both sides over five mutations: EQUAL in all
    // five). Now it is the literals the row actually spells, plus a flag for the one dynamic
    // spelling — and the caller asserts CONTAINMENT in `LandingWhy`, which can fail.
    landingWhyOnTheRow: [...landingLiteralWhy].sort(),
    landingWhyDrawsFromTheUnion: landingDrawsFromTheUnion,
    route: [...route].sort(),
    rung: [...rung].sort(),
    refused: [...refused].sort(),
    why: [...why].sort(),
    problems,
  };
}
