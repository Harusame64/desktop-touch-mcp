// ADR-036 — the FOURTH denominator: the `code` a caller receives on a flat tool failure.
//
// The completion grid's three axes are the road (#669), the configuration (#670) and the result
// (#672 / #673). The result axis ended by naming a fourth that it deliberately did not count:
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
// **`code` shares a producer AND a spelling with `most_likely_cause`, so matching the two by name
// collapses two axes into one.** This file counts the `code` surface at its own producers.
//
// **What makes this axis different from the other three: it is CLOSED ABOVE.** The other three end
// with "this is a lower bound" — a road can be spelled at a new call site, a switch name can come
// out of the registry, a `ToolFailureError` takes its name from 183 `failWith` sites. This one has
// a ceiling, and the ceiling is structural: the two arms of `classify` that turn a caller-supplied
// MESSAGE into a code both check `Object.hasOwn(SUGGESTS, …)` first, so a message cannot invent a
// code. Remove either guard and the axis stops being bounded — which is why `readClassifyArms`
// fails rather than counts when a `code:` it cannot read is not standing behind that check.
//
// The flat surface has exactly three entry points in `src/tools/_errors.ts`, and all three were
// read at the producer rather than at a table beside it (the lesson #672 cost five rounds):
//
//   failWith(err, tool, ctx)  → classify(message) → a literal arm, a dictionary arm, or the residual
//   failCode(code, …)         → the code the CALL SITE supplies
//   failArgs(message, tool)   → a fixed code, in a flat shape this file builds by hand
//
// …and two producers outside them, both of which this file finds by sweeping for the SHAPE:
//
//   a hand-built `{ ok:false, code, error }` that never goes through a presenter — the non-Windows
//   stub is one, and it is the shape every MCP directory sees;
//   a code spelled inside an embedded PowerShell script, where no TypeScript-level extraction can
//   see it. Those are RECORDED, not merged into the count: whether one reaches a caller's `code` is
//   a call-graph question this extraction does not answer, and a number that reads as its answer is
//   worse than the sentence saying so.
//
// **Do not sweep the field name.** `code:` is worn by at least four other axes in this tree — the
// key-locker injector's snake_case results (`no_secret`, `target_gone`), the terminal's
// `ExitModeRejectCode`, the console-paste reason, and `macro`'s forwarded inner code. The sweep
// below is keyed on the flat failure's SHAPE (`ok:false` + `code` + `error` at one depth), because
// the shape is the grammar and the field name is a spelling shared with four neighbours.

import { stripComments } from "./route-vocabulary.mjs";

/**
 * The body of a function whose `function` keyword is at `at`, skipping its RETURN TYPE.
 *
 * `function classify(message: string): { code: string; suggest: string[] } {` — the first `{` after
 * the name belongs to the annotation, not the body. Taking it read a type as a body and returned an
 * empty vocabulary with `problems` empty: the exact failure mode these files exist to end, and the
 * reason `readClassifyArms` now fails loudly when it finds no arms at all.
 */
function functionBody(text, at) {
  let from = at;
  for (let guard = 0; guard < 8; guard++) {
    const block = blockAt(text, from);
    if (block === null) return null;
    if (/\breturn\b/.test(block.body)) return block;
    from = block.end + 1;
  }
  return null;
}

/** The body of the brace-delimited block that starts at the first `{` at or after `from`. */
function blockAt(text, from) {
  const open = text.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(open, i + 1), start: open, end: i };
    }
  }
  return null;
}

/**
 * The value of `<field>:` at depth 1 of an object literal, as SOURCE TEXT.
 *
 * Depth is the grammar. Reading `code:` with a regex over the whole object picks up a `code:` in a
 * nested `context: { code: … }` — the same class of mistake as reading a dictionary key at an
 * indent (#672).
 */
export function fieldAtDepthOne(objectSource, field) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < objectSource.length; i++) {
    const ch = objectSource[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 1) {
      const m = new RegExp(`^${field}\\s*:`).exec(objectSource.slice(i));
      if (m && /[{,\s]/.test(objectSource[i - 1] ?? "")) {
        // Read to the comma or closing brace at THIS depth.
        let j = i + m[0].length;
        let d = 0;
        let q = null;
        for (; j < objectSource.length; j++) {
          const c = objectSource[j];
          if (q) {
            if (c === "\\") j++;
            else if (c === q) q = null;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "{" || c === "(" || c === "[") d++;
          else if (c === "]" || c === ")") d--;
          else if (c === "}") {
            if (d === 0) break;
            d--;
          } else if ((c === "," || c === ";") && d === 0) break;
        }
        return objectSource.slice(i + m[0].length, j).trim();
      }
    }
  }
  return null;
}

/**
 * Is this object literal a TYPE literal rather than a value?
 *
 * `export type ToolFailure = { ok: false; code: string; error: string }` wears the exact shape the
 * sweep below looks for. The discriminator is the separator: a value's members are comma-separated,
 * a type's are semicolon-separated, and a `;` cannot appear at depth 1 of an object literal. Keying
 * on that rather than on the file or the name means a second declaration somewhere else is excluded
 * by the same rule, without anybody remembering to add it.
 */
export function isTypeLiteral(objectSource) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < objectSource.length; i++) {
    const ch = objectSource[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 1) return true;
  }
  return false;
}

/** Every depth-1 key of an object literal, in source order. */
export function keysAtDepthOne(objectSource) {
  const keys = [];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < objectSource.length; i++) {
    const ch = objectSource[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(objectSource.slice(i));
      if (m && /[{,\s]/.test(objectSource[i - 1] ?? "")) keys.push(m[1]);
    }
  }
  return keys;
}

/** `"Literal"` → `Literal`; anything else → null. */
const literal = (expr) => /^"([^"\\]*)"$/.exec(expr ?? "")?.[1] ?? null;

/**
 * Both branches of `cond ? "A" : "B"`, or null when either side is not a literal.
 *
 * A ternary of two literals is a producer of TWO values, and the road axis learned the hard way
 * that treating it as "not a literal, therefore unreadable" and treating it as one value are both
 * wrong: the first is noise, the second under-counts in silence (#669).
 */
const ternaryLiterals = (expr) => {
  const m = /^[^?]*\?\s*"([^"\\]*)"\s*:\s*"([^"\\]*)"\s*$/.exec((expr ?? "").replace(/\s+/g, " "));
  return m === null ? null : [m[1], m[2]];
};

/**
 * The arms of `classify(message)`, which is the only place the flat road turns a message into a
 * code.
 *
 * Returns `{ literals, residual, dictionaryArms, unreadable }`:
 *   - `literals`     every code the cascade WRITES;
 *   - `residual`     the code the final `return` produces when nothing matched;
 *   - `dictionaryArms` one entry per arm that returns a code read out of the MESSAGE, each with the
 *     identifier it returns and whether it stands behind a `SUGGESTS` membership check;
 *   - `unreadable`   a `code:` this parser could not resolve to either.
 *
 * **The membership check is the ceiling.** With it, the set of codes a message can name is the
 * dictionary's key set; without it, a producer's message names the code and the axis has no upper
 * bound at all. `problems` gets a line for an arm that loses it, and the gate above refuses to
 * compare a denominator it can no longer bound.
 */
export function readClassifyArms(errorsSource, problems = []) {
  const text = stripComments(errorsSource);
  const at = text.indexOf("function classify(");
  if (at === -1) {
    problems.push("classify() could not be found — the flat road's code vocabulary is unknown, not empty");
    return { literals: [], residual: null, dictionaryArms: [], unreadable: [] };
  }
  const block = functionBody(text, at);
  if (block === null) {
    problems.push("classify()'s body could not be read — the flat road's code vocabulary is unknown, not empty");
    return { literals: [], residual: null, dictionaryArms: [], unreadable: [] };
  }
  const body = block.body;
  const literals = new Set();
  const dictionaryArms = [];
  const unreadable = [];
  let residual = null;

  for (const m of body.matchAll(/\breturn\s*\{/g)) {
    const obj = blockAt(body, m.index);
    if (obj === null) continue;
    const expr = fieldAtDepthOne(obj.body, "code");
    if (expr === null) continue;
    const lit = literal(expr);
    if (lit !== null) {
      literals.add(lit);
      // The LAST literal return in the body is the residual — the one every un-matched message
      // reaches. Read, not hard-coded: `"ToolError"` is a value the tree can change, and a gate
      // that knows the answer in advance stops being a measurement of the tree.
      residual = lit;
      continue;
    }
    // A code read out of the message. The arm is only bounded if it checked the dictionary first.
    const before = body.slice(Math.max(0, obj.start - 400), obj.start);
    const guarded = new RegExp(`Object\\.hasOwn\\(\\s*SUGGESTS\\s*,\\s*${expr.replace(/[$]/g, "\\$")}\\s*\\)`).test(before);
    dictionaryArms.push({ identifier: expr, guarded });
    if (!guarded) {
      unreadable.push(expr);
      problems.push(
        `classify returns \`code: ${expr}\` without checking \`Object.hasOwn(SUGGESTS, ${expr})\` first — ` +
          "a message can then name a code that is in no dictionary, and this axis has no upper bound",
      );
    }
  }
  if (dictionaryArms.length === 0) {
    problems.push(
      "classify has no arm that reads a code out of the message — either the cascade was rewritten " +
        "or this parser stopped matching it; the 30 codes reachable only that way are unaccounted for",
    );
  }
  return { literals: [...literals].sort(), residual, dictionaryArms, unreadable };
}

/**
 * The codes supplied at `failCode(…)` call sites — the entry point where the CALLER names the code
 * instead of a classifier deriving it.
 *
 * Resolution, in the order a reader would try it:
 *   1. a string literal;
 *   2. a ternary of two literals (`browserResolveStopToFailure` is one, and it is the only place
 *      `BrowserAmbiguousTarget` / `BrowserNoActionableTarget` exist);
 *   3. a local `const` bound to either of those;
 *   4. a ONE-LEVEL local wrapper — `function fail(code, message) { return failCode(code, …) }` in
 *      `key-locker-tool.ts` — resolved through its own call sites in the same file.
 *
 * Anything else is reported. A `failCode` whose code this parser cannot read is a value reaching
 * the caller that the grid does not count, and the whole point of the four denominators is that
 * such a value cannot exist quietly.
 */
export function readFailCodeSites(sources, problems = []) {
  const codes = new Set();
  const sites = [];
  for (const { file, text: raw } of sources) {
    const text = stripComments(raw);
    // The definition and its doc-comment siblings are not call sites.
    const wrappers = new Map();
    for (const m of text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*string[\s\S]{0,200}?\breturn\s+failCode\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
      if (m[2] === m[3]) wrappers.set(m[1], m[2]);
    }
    for (const m of text.matchAll(/\bfailCode\(/g)) {
      const open = m.index + m[0].length - 1;
      const args = readArgList(text, open);
      if (args === null) continue;
      const first = args[0] ?? "";
      const line = text.slice(0, m.index).split("\n").length;
      if (/^\s*code\s*:\s*string/.test(first)) continue; // the declaration itself
      const lit = literal(first.trim());
      const tern = ternaryLiterals(first.trim());
      let resolved = null;
      if (lit !== null) resolved = [lit];
      else if (tern !== null) resolved = tern;
      else if (/^[A-Za-z_$][\w$]*$/.test(first.trim())) {
        const bound = readLocalBinding(text, first.trim());
        if (bound !== null) resolved = bound;
        else if ([...wrappers.values()].includes(first.trim())) {
          // The wrapper's own parameter: resolved at ITS call sites, below.
          resolved = [];
        }
      }
      if (resolved === null) {
        problems.push(`${file}:${line}: failCode is given a code this parser cannot read: ${first.trim().slice(0, 60)}`);
        continue;
      }
      for (const c of resolved) {
        codes.add(c);
        sites.push({ file, line, code: c });
      }
    }
    // One level of wrapper: `fail("KeyLockerDisabled", …)` inside the same file.
    for (const name of wrappers.keys()) {
      for (const m of text.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
        const args = readArgList(text, m.index + m[0].length - 1);
        if (args === null) continue;
        const lit = literal((args[0] ?? "").trim());
        if (lit === null) continue; // its own declaration, and any call this parser cannot read
        codes.add(lit);
        sites.push({ file, line: text.slice(0, m.index).split("\n").length, code: lit, via: name });
      }
    }
  }
  return { codes: [...codes].sort(), sites };
}

/** `const X = "lit";` / `const X = a ? "A" : "B";` in the same file, or null. */
function readLocalBinding(text, identifier) {
  const m = new RegExp(`\\bconst\\s+${identifier}\\s*(?::[^=;]+)?=\\s*([^;]+);`).exec(text);
  if (m === undefined || m === null) return null;
  const expr = m[1].trim();
  const lit = literal(expr);
  if (lit !== null) return [lit];
  return ternaryLiterals(expr);
}

/**
 * The top-level arguments of a call whose `(` sits at `open`, as source text.
 *
 * String / template / comment aware, and it does NOT stop at a newline: a call wrapped across lines
 * is ordinary formatting, and the newline-stopping version of this in the road extractor reported
 * a reformat as a defect while printing an empty offender (gate 2 on #669).
 */
export function readArgList(text, open) {
  if (text[open] !== "(") return null;
  const args = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "\\") {
        cur += text[i + 1] ?? "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(cur);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  return null;
}

/**
 * Object literals that ARE the flat failure shape but never went through a presenter.
 *
 * Keyed on the shape — `ok: false` with `code` and `error` at the same depth — because the field
 * name alone is worn by four other axes in this tree. Type declarations (`code: string`) are not
 * values and are excluded by requiring `ok: false` rather than `ok: false`'s type-level twin.
 *
 * Each site carries the name of the function that returns it, so the caller above can ask the one
 * question that decides whether it belongs in the axis: is that function called anywhere?
 */
export function readHandBuiltFlatFailures(sources) {
  const found = [];
  for (const { file, text: raw } of sources) {
    const text = stripComments(raw);
    for (const m of text.matchAll(/\bok:\s*false\b/g)) {
      // Walk back to the enclosing `{`.
      let depth = 0;
      let i = m.index;
      for (; i >= 0; i--) {
        const c = text[i];
        if (c === "}") depth++;
        else if (c === "{") {
          if (depth === 0) break;
          depth--;
        }
      }
      if (i < 0) continue;
      const obj = blockAt(text, i);
      if (obj === null) continue;
      if (isTypeLiteral(obj.body)) continue;
      const keys = keysAtDepthOne(obj.body);
      if (!keys.includes("code") || !keys.includes("error")) continue;
      const expr = fieldAtDepthOne(obj.body, "code");
      const line = text.slice(0, m.index).split("\n").length;
      const before = text.slice(0, i);
      const fn = [...before.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].at(-1)?.[1] ?? null;
      found.push({ file, line, code: literal(expr ?? ""), expression: expr, fn });
    }
  }
  return found;
}

/** Is `name` called anywhere outside the file that defines it? */
export function isCalledOutside(sources, name, definingFile) {
  const call = new RegExp(`\\b${name}\\s*\\(`);
  return sources.some(({ file, text }) => file !== definingFile && call.test(stripComments(text)));
}

/**
 * Codes spelled inside an embedded PowerShell script.
 *
 * `Write-Output '{"ok":false,"code":"ElementNotFound"}'` is a producer no TypeScript-level
 * extraction can see: the value is inside a string in another language, and the TS side parses it
 * back out as JSON. Interpolated names (`${AIM_WINDOW_GONE}`) are resolved against the file's own
 * `const` declarations, because the alternative is to print the interpolation as if it were a code.
 *
 * These are RECORDED, never merged into the count. Whether one reaches a caller's `code` is a
 * call-graph question, and the configuration axis's registry-supplied switch name (#670) is the
 * precedent: say "lower bound" out loud rather than let a number answer a question it did not ask.
 */
export function readEmbeddedScriptCodes(sources) {
  const stripped = sources.map(({ file, text }) => ({ file, text: stripComments(text) }));
  // **The interpolated name is resolved across the whole tree, not in the file that spells it.**
  // `AIM_WINDOW_GONE` is declared in `engine/aim.ts` and interpolated in `engine/uia-bridge.ts`, so
  // a same-file lookup prints `${AIM_WINDOW_GONE}` as if that were the code — and the value it
  // actually holds is `"aim_window_gone"`, snake_case, which is the whole reason these are recorded
  // separately instead of being merged into a PascalCase axis.
  const constants = new Map();
  for (const { text } of stripped) {
    for (const m of text.matchAll(/\bexport\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*"([^"]*)"/g)) {
      constants.set(m[1], m[2]);
    }
  }
  const out = [];
  for (const { file, text } of stripped) {
    for (const m of text.matchAll(/"code"\s*:\s*"([^"]+)"/g)) {
      const interpolated = /^\$\{([A-Za-z_$][\w$]*)\}$/.exec(m[1]);
      const resolved = interpolated === null ? m[1] : constants.get(interpolated[1]) ?? null;
      out.push({
        file,
        line: text.slice(0, m.index).split("\n").length,
        code: resolved ?? m[1],
        ...(interpolated === null ? {} : { from: interpolated[1], resolved: resolved !== null }),
      });
    }
  }
  return out;
}

/** The fixed code `failArgs` builds by hand, read out of its body rather than assumed. */
export function readFailArgsCode(errorsSource, problems = []) {
  const text = stripComments(errorsSource);
  const at = text.indexOf("export function failArgs(");
  if (at === -1) {
    problems.push("failArgs() could not be found — one of the three flat entry points is unread");
    return null;
  }
  const block = functionBody(text, at);
  if (block === null) {
    problems.push("failArgs()'s body could not be read — one of the three flat entry points is unread");
    return null;
  }
  const obj = blockAt(block.body, block.body.indexOf("= {"));
  const code = obj === null ? null : literal(fieldAtDepthOne(obj.body, "code") ?? "");
  if (code === null) problems.push("failArgs no longer builds a literal `code` — its fixed value is unread");
  return code;
}
