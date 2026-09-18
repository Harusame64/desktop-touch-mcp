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
// **One of this axis's two roads is bounded, and that is worth saying precisely.** The MESSAGE road
// is: the two arms of `classify` that turn a caller-supplied message into a code both REQUIRE
// `Object.hasOwn(SUGGESTS, …)` — un-negated, not behind an `||` — so a message cannot invent a code.
// The guard is therefore read for its polarity, not for its presence: `!Object.hasOwn(…)` contains
// the same call and means the opposite (gate 2 on #674, round 2).
//
// **The CALL-SITE road is not bounded, and the first version of this file said it was.**
// `keyLockerFailure` forwards `String(err.code)` — an arbitrary runtime string off a thrown object —
// into `failCode`, so codes like `LockerNotBound` reach a caller without appearing in any set
// derived here. Such a site is named in `unreadable` and the summary says "lower bound" while it is
// there. The other three axes end the same way (a switch name from the registry, a
// `ToolFailureError` name from 183 `failWith` sites), and saying so is the whole discipline.
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

import { quoteForRegExp, stripComments } from "./route-vocabulary.mjs";


/**
 * If a literal starts at `i`, the index just past it; otherwise `-1`.
 *
 * **One scanner, because there were eight.** Round 2 taught `stripComments` that a regex literal is
 * not a comment; round 3 found that every scanner BELOW it still read a regex's `'` or `"` as a
 * string delimiter — so `error: s.replace(/'/g, "''")` left the parse with an unbalanced quote and
 * the producer beside it vanished, silently, from a function with no `problems` channel at all.
 * Five files in `src` already parse with an unbalanced brace model under the old rule.
 *
 * The lesson the three rounds share is not about regexes. **A grammar rule learned in one scanner
 * has to be learned by all of them**, and the way to make that true is to have one.
 */
export function literalEnd(text, i, previous) {
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    let j = i + 1;
    while (j < text.length) {
      const c = text[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      j++;
      if (c === ch) break;
      // A single- or double-quoted run cannot cross a newline; a stray quote must not swallow the
      // rest of the file.
      if (c === "\n" && ch !== "`") break;
    }
    return j;
  }
  if (ch !== "/") return -1;
  // A regex only starts where a value may begin — `previous` is the last significant character
  // before `i`. A `/` after an identifier, a number or a closing bracket is division.
  if (!/[=(,[!&|?:;{}+\-*%^~<>]/.test(previous ?? "(") && !/^(?:return|typeof|case|in|of|do|else|void|delete|instanceof|new|yield|await)$/.test(previous ?? "")) {
    return -1;
  }
  if (text[i + 1] === "/" || text[i + 1] === "*") return -1; // a comment, not a regex
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    j++;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
    else if (c === "\n") break;
  }
  return j;
}

/**
 * The last significant character (or word) before `i`, for deciding whether a `/` opens a regex.
 */
export function significantBefore(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return "(";
  if (!/\w/.test(text[j])) return text[j];
  // **Bounded.** Slicing from the start of the file to read the word behind the cursor made this
  // O(n²) over a 2 MB tree — the scan took minutes instead of milliseconds. The longest keyword that
  // can precede a regex is `instanceof`; sixteen characters is more than the grammar needs.
  let k = j;
  while (k >= 0 && j - k < 16 && /\w/.test(text[k])) k--;
  return text.slice(k + 1, j + 1);
}

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
  for (let i = open; i < text.length; i++) {
    const skip = literalEnd(text, i, significantBefore(text, i));
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(open, i + 1), start: open, end: i };
    }
  }
  return null;
}

/**
 * Walk an object literal's depth-1 properties, calling `visit(name, valueStart)` for each.
 *
 * **Three spellings name one property**: `code:`, `"code":` and the shorthand `code` with no colon
 * at all. The first version of this file read only the first, and the shorthand form is exactly how
 * `toToolFailure` builds the flat failure — so a hand-built copy of the tree's own house style was
 * skipped with nothing reported, and a JSON-shaped one (`{"ok":false,"code":…}`) was skipped twice
 * over, because the quoted key was consumed as a string (gate 2 on #674, findings 4 and 7).
 *
 * Depth is the grammar: a `code:` nested inside `context: { … }` is not this object's property.
 */
function eachDepthOneProperty(objectSource, visit) {
  let depth = 0;
  let i = 0;
  while (i < objectSource.length) {
    const prev = objectSource[i - 1] ?? "";
    if (depth === 1 && /[{,\s]/.test(prev)) {
      // **A spread carries this object's properties too.** `{ ok:false, ...(c ? {code:"A"} : {code:"B"}), … }`
      // is the tree's own idiom, and counting brackets uniformly buried the key two levels down
      // where the depth-1 walk could not see it (gate 2 on #674, round 3, finding 6).
      if (objectSource.startsWith("...", i)) {
        const span = valueSpan(objectSource, i + 3);
        for (const inner of objectLiteralsIn(span.text)) {
          // **The index belongs to the inner source.** Handing the visitor an inner offset while it
          // read from the outer text produced `code` values spliced out of the wrong string
          // (`macro.ts` came back with the expression `step: i`).
          const stop = eachDepthOneProperty(inner, visit);
          if (stop !== undefined) return stop;
        }
        i = span.end;
        continue;
      }
      const key = /^(?:"([A-Za-z_$][\w$]*)"\s*:|'([A-Za-z_$][\w$]*)'\s*:|([A-Za-z_$][\w$]*)\s*([:,}]))/.exec(objectSource.slice(i));
      // **A quoted STRING is not a shorthand key.** `{ "ok": false, "note": "code", … }` put the
      // VALUE `"code"` in key position and the walker read it as a property named `code` — the
      // mutation round caught it as a negative control that went red (2026-09-18). Shorthand is a
      // bare identifier by grammar, so only the unquoted alternative may omit its colon.
      if (key !== null) {
        const name = key[1] ?? key[2] ?? key[3];
        const shorthand = key[3] !== undefined && key[4] !== ":";
        const valueStart = shorthand ? null : i + key[0].length;
        const stop = visit(name, valueStart, objectSource);
        if (stop !== undefined) return stop;
        i = shorthand ? i + key[0].length - 1 : valueSpan(objectSource, valueStart).end;
        continue;
      }
    }
    const skip = literalEnd(objectSource, i, significantBefore(objectSource, i));
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const ch = objectSource[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    i++;
  }
  return undefined;
}

/**
 * Whether `field` at depth 1 is written as a SHORTHAND (`{ code }`) rather than `code: <expr>`.
 *
 * Asked here rather than by the caller because the caller would have to walk the object again to
 * answer it — and a second walk is how this tree keeps growing scanners that fall behind the one.
 * `{ code }` and `{ code: code }` both leave the produced name unreadable, but only the first can
 * be fixed by spelling it out, so they are told apart and advised differently.
 */
export function isShorthandAtDepthOne(objectSource, field) {
  let shorthand = false;
  eachDepthOneProperty(objectSource, (name, valueStart) => {
    if (name === field && valueStart === null) shorthand = true;
    return undefined;
  });
  return shorthand;
}

/** Every top-level object literal inside an expression, as source text. */
function objectLiteralsIn(expression) {
  const out = [];
  for (let i = 0; i < expression.length; i++) {
    const skip = literalEnd(expression, i, significantBefore(expression, i));
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    if (expression[i] !== "{") continue;
    const block = blockAt(expression, i);
    if (block === null) continue;
    out.push(block.body);
    i = block.end;
  }
  return out;
}

/** The value that starts at `from`: its trimmed text and the index just past it. */
function valueSpan(objectSource, from) {
  let d = 0;
  let j = from;
  for (; j < objectSource.length; j++) {
    const skip = literalEnd(objectSource, j, significantBefore(objectSource, j));
    if (skip !== -1) {
      j = skip - 1;
      continue;
    }
    const c = objectSource[j];
    if (c === "{" || c === "(" || c === "[") d++;
    else if (c === "]" || c === ")") d--;
    else if (c === "}") {
      if (d === 0) break;
      d--;
    } else if ((c === "," || c === ";") && d === 0) break;
  }
  return { text: objectSource.slice(from, j).trim(), end: j };
}

/** The value text that starts at `from`, ending at this depth's `,`, `;` or `}`. */
function valueAt(objectSource, from) {
  return valueSpan(objectSource, from).text;
}

/**
 * The value of `<field>:` at depth 1 of an object literal, as SOURCE TEXT.
 *
 * A shorthand property (`{ ok: false, code, error }`) has no value text; the field NAME comes back,
 * which is what it is — an identifier the caller must resolve or report.
 */
export function fieldAtDepthOne(objectSource, field) {
  const values = fieldsAtDepthOne(objectSource, field);
  return values.length === 0 ? null : values[0];
}

/**
 * EVERY value `field` takes at depth 1 — a conditional spread gives it more than one.
 *
 * `{ ok:false, ...(c ? { code:"AAA" } : { code:"BBB" }), … }` produces two codes, and stopping at the
 * first left `BBB` out of the axis with nothing in `problems` and nothing in `unreadable`: a caller
 * can receive it and the grid does not count it (gate 2 on #674, round 4, finding 5).
 */
export function fieldsAtDepthOne(objectSource, field) {
  const values = [];
  eachDepthOneProperty(objectSource, (name, valueStart, source) => {
    if (name !== field) return undefined;
    values.push(valueStart === null ? field : valueAt(source, valueStart));
    return undefined;
  });
  return values;
}

/** Every depth-1 key of an object literal, in source order. */
export function keysAtDepthOne(objectSource) {
  const keys = [];
  eachDepthOneProperty(objectSource, (name) => {
    keys.push(name);
    return undefined;
  });
  return keys;
}

/**
 * Is this object literal a TYPE literal rather than a value?
 *
 * `export interface ToolFailure { ok: false; code: string; error: string }` wears the exact shape
 * the sweep looks for. The discriminator is the separator: a value's members are comma-separated,
 * a type's are semicolon-separated, and a `;` cannot appear at depth 1 of an object literal. Keying
 * on that rather than on the file or the name means a second declaration somewhere else is excluded
 * by the same rule, without anybody remembering to add it.
 */
export function isTypeLiteral(objectSource) {
  let depth = 0;
  for (let i = 0; i < objectSource.length; i++) {
    const skip = literalEnd(objectSource, i, significantBefore(objectSource, i));
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    const ch = objectSource[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 1) return true;
  }
  return false;
}

/** `"Literal"` → `Literal`; anything else → null. */
const literal = (expr) => /^"([^"\\]*)"$/.exec(expr ?? "")?.[1] ?? null;

/**
 * Every branch of a conditional expression whose leaves are all string literals, or null.
 *
 * A ternary is a producer of as many values as it has branches, and the road axis learned that
 * treating one as "not a literal, therefore unreadable" and treating it as one value are both wrong:
 * the first is noise, the second under-counts in silence (#669).
 *
 * **The chain is parsed, not matched.** The first version read exactly two branches with a regex,
 * so `browser.ts:2708`'s four-way chain came back as unreadable — and, because the binding was also
 * resolved from the top of the file, that unreadable result was masked by another site's two codes
 * (gate 2 on #674, finding 2). Splitting at the top-level `?` and its matching `:` also keeps a
 * literal that appears in a CONDITION (`r.__error === "ScopeNotFound" ? …`) out of the result: a
 * condition is not a branch, and counting its literals would put a comparison's right-hand side into
 * the caller-visible vocabulary.
 */
const ternaryLiterals = (expr) => {
  const text = (expr ?? "").trim();
  if (text === "") return null;
  const lit = literal(text);
  if (lit !== null) return [lit];
  // Find the top-level `?` (not `?.`, not `??`) and its matching `:`.
  let depth = 0;
  let question = -1;
  let ternaries = 0;
  for (let i = 0; i < text.length; i++) {
    const skip = literalEnd(text, i, significantBefore(text, i));
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === "?") {
      if (text[i + 1] === "." || text[i + 1] === "?") {
        i++;
        continue;
      }
      if (question === -1) question = i;
      else ternaries++;
    } else if (depth === 0 && ch === ":" && question !== -1) {
      if (ternaries > 0) {
        ternaries--;
        continue;
      }
      const left = ternaryLiterals(text.slice(question + 1, i));
      const right = ternaryLiterals(text.slice(i + 1));
      if (left === null || right === null) return null;
      return [...new Set([...left, ...right])];
    }
  }
  return null;
};

/**
 * The condition of the `if` that guards the statement starting at `at`, or null.
 *
 * **Resolved against the enclosing `if`, not a byte window.** The first version searched the 400
 * characters before the arm for `Object.hasOwn(SUGGESTS, …)`, and it was wrong in both directions
 * (gate 2 on #674, finding 3): a SECOND, unguarded arm placed within 400 characters after a guarded
 * one read as guarded — the false negative on the one structural invariant this whole axis rests on
 * — while a guarded arm with a long body ahead of it read as unbounded and would redden CI for
 * nothing. A window is a spelling; the enclosing statement is the grammar.
 */
function enclosingCondition(body, at) {
  const skipBack = (i) => {
    while (i >= 0 && /\s/.test(body[i])) i--;
    return i;
  };
  // **The literal ranges are computed once, forward, and every backward walk below consults them.**
  // This was the one scanner that had not learned the shared grammar: a `"}"` or a `"("` inside a
  // string — three behaviour-preserving edits inside a guarded arm — flipped `guarded` to false and
  // turned CI red claiming the axis was unbounded (gate 2 on #674, round 4, finding 3).
  const masked = new Set();
  for (let i = 0; i < body.length; i++) {
    const end = literalEnd(body, i, significantBefore(body, i));
    if (end === -1) continue;
    for (let j = i; j < end; j++) masked.add(j);
    i = end - 1;
  }
  const code = (i) => !masked.has(i);
  const matchParen = (i) => {
    let depth = 0;
    for (; i >= 0; i--) {
      if (!code(i)) continue;
      if (body[i] === ")") depth++;
      else if (body[i] === "(") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  };
  const conditionEndingAt = (closeParen) => {
    const open = matchParen(closeParen);
    if (open < 0) return null;
    const before = skipBack(open - 1);
    const keyword = /(\w+)\s*$/.exec(body.slice(0, before + 1));
    if (keyword === null || keyword[1] !== "if") return null;
    return body.slice(open + 1, closeParen);
  };

  // `if (cond) return { … }` — the arm IS the statement, with no block of its own.
  let i = skipBack(at - 1);
  const word = /(\w+)\s*$/.exec(body.slice(0, i + 1));
  if (word !== null && word[1] === "return") i = skipBack(i - word[1].length);
  if (body[i] === ")") return conditionEndingAt(i);

  // Otherwise the arm sits somewhere inside a block: find the block that encloses it — it may be
  // preceded by any number of statements, which is why walking back token by token was wrong (it
  // read a guarded arm with one line ahead of it as unbounded, and would have reddened CI for a
  // refactor that changed nothing).
  let depth = 0;
  for (let j = at - 1; j >= 0; j--) {
    if (!code(j)) continue;
    if (body[j] === "}") depth++;
    else if (body[j] === "{") {
      if (depth === 0) {
        const before = skipBack(j - 1);
        return body[before] === ")" ? conditionEndingAt(before) : null;
      }
      depth--;
    }
  }
  return null;
}

/**
 * Does taking this branch REQUIRE `Object.hasOwn(SUGGESTS, expr)` to hold?
 *
 * **Parsed, not matched — because enumerating spellings does not terminate.** Three rounds of gate 2
 * were spent adding one spelling at a time and each round found the next: first the adjacent `!`,
 * then `!(…)` and `=== false`, then `!(a && …)`, `!!x`, `=== true` and `!== false`. Two of those
 * left the axis unbounded with the gate at exit 0 and two reddened CI for a behaviour-preserving
 * edit. **The polarity is a property of the expression's structure, so it is read from the
 * structure**: split at the top-level `||`, and a branch requires membership only when EVERY
 * disjunct does; inside a disjunct, split at `&&` and ask whether any conjunct is the call in
 * positive polarity, following `!` and parentheses down.
 *
 * Bracket depth is counted over the MASKED text, so a `(` or a `||` inside a string literal is
 * neither a bracket nor an operator — the rule `enclosingCondition` learned, which its own
 * top-level-`||` scan three lines below had not (gate 2 on #674, round 5).
 */
function dictionaryMembershipRequired(condition, expr) {
  const masked = maskLiterals(condition);
  return requiresTerm(condition, masked, 0, condition.length, new RegExp(`^Object\\.hasOwn\\(\\s*SUGGESTS\\s*,\\s*${quoteForRegExp(expr)}\\s*\\)$`), true);
}

/** Positions covered by a string, template or regex literal. */
function maskLiterals(text) {
  const masked = new Set();
  for (let i = 0; i < text.length; i++) {
    const end = literalEnd(text, i, significantBefore(text, i));
    if (end === -1) continue;
    for (let j = i; j < end; j++) masked.add(j);
    i = end - 1;
  }
  return masked;
}

/** Split `[from, to)` at a top-level operator, over masked text. */
function splitTopLevel(text, masked, from, to, op) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (masked.has(i)) continue;
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === op[0] && text[i + 1] === op[1] && i + 1 < to) {
      parts.push([start, i]);
      i++;
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

const trimSpan = (text, from, to) => {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return [from, to];
};

/**
 * Does the expression in `[from, to)` require the term (matched by `term`) to be TRUE, under
 * `wanted` polarity?
 */
function requiresTerm(text, masked, from, to, term, wanted) {
  [from, to] = trimSpan(text, from, to);
  if (from >= to) return false;

  // `a || b` — required only if BOTH sides require it. `a && b` — required if EITHER does.
  for (const [op, everyBranch] of [["||", true], ["&&", false]]) {
    const parts = splitTopLevel(text, masked, from, to, op);
    if (parts.length > 1) {
      const answers = parts.map(([a, b]) => requiresTerm(text, masked, a, b, term, wanted));
      return everyBranch ? answers.every(Boolean) : answers.some(Boolean);
    }
  }

  // `!x` — the same question with the polarity flipped.
  if (text[from] === "!" && !masked.has(from)) {
    return requiresTerm(text, masked, from + 1, to, term, !wanted);
  }

  // `(x)` — unwrap only when the parentheses span the whole expression.
  if (text[from] === "(" && !masked.has(from)) {
    let depth = 0;
    for (let i = from; i < to; i++) {
      if (masked.has(i)) continue;
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) return i === to - 1 && requiresTerm(text, masked, from + 1, i, term, wanted);
      }
    }
    return false;
  }

  // `x === true` / `x !== false` keep the polarity; `=== false` / `!== true` flip it.
  const comparison = /^([\s\S]*?)\s*(===?|!==?)\s*(true|false)\s*$/.exec(text.slice(from, to));
  if (comparison !== null) {
    const negating = (comparison[2].startsWith("!") ? 1 : 0) ^ (comparison[3] === "false" ? 1 : 0);
    return requiresTerm(text, masked, from, from + comparison[1].length, term, negating ? !wanted : wanted);
  }

  return wanted && term.test(text.slice(from, to).trim());
}

/**
 * The arms of `classify(message)`, which is the only place the flat road turns a message into a
 * code.
 *
 * Returns `{ literals, residual, dictionaryArms, unreadable }`:
 *   - `literals`     every code the cascade WRITES;
 *   - `residual`     the code the last arm produces when nothing matched;
 *   - `dictionaryArms` one entry per arm that returns a code read out of the MESSAGE, each with the
 *     identifier it returns and whether it stands behind a `SUGGESTS` membership check;
 *   - `unreadable`   a `code:` this parser could not resolve to either.
 *
 * **Every object literal in the body that has a `code` property is an arm** — not only the ones
 * spelled `return {`. Matching the `return` kept a literal out of the denominator in silence when
 * the arm built its object in a local first (`const out = { code: "HiddenArm" }; return out;`), and
 * because the dictionary arms were still found, nothing said the cascade had become unreadable
 * (gate 2 on #674, finding 5).
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

  const seen = new Set();
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue;
    const obj = blockAt(body, i);
    if (obj === null || seen.has(obj.start)) continue;
    seen.add(obj.start);
    if (isTypeLiteral(obj.body)) continue;
    const expr = fieldAtDepthOne(obj.body, "code");
    if (expr === null) continue;
    const lit = literal(expr);
    if (lit !== null) {
      literals.add(lit);
      // The LAST arm in source order is the residual — the one every un-matched message reaches.
      // Read, not hard-coded: `"ToolError"` is a value the tree can change, and a gate that knows
      // the answer in advance has stopped measuring the tree.
      residual = lit;
      continue;
    }
    // A code read out of the message. The arm is only bounded if it checked the dictionary first.
    const cond = enclosingCondition(body, obj.start);
    const guarded = cond !== null && dictionaryMembershipRequired(cond, expr);
    dictionaryArms.push({ identifier: expr, guarded });
    if (!guarded) {
      unreadable.push(expr);
      problems.push(
        `classify returns \`code: ${expr}\` without checking \`Object.hasOwn(SUGGESTS, ${expr})\` in the ` +
          "condition that guards it — a message can then name a code that is in no dictionary, and this " +
          "axis has no upper bound",
      );
    }
  }
  if (dictionaryArms.length === 0) {
    problems.push(
      "classify has no arm that reads a code out of the message — either the cascade was rewritten " +
        "or this parser stopped matching it; the codes reachable only that way are unaccounted for",
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
 * Anything else is RECORDED in `unreadable` — a call site that forwards a computed value is a
 * producer whose values cannot be enumerated, not a parser failure, and it is pinned beside the
 * codes so the summary can stop calling the count a ceiling. Dropping such a site silently is what
 * let `keyLockerFailure`'s `String(err.code)` sit outside the count while the headline claimed a
 * bound (gate 2 on #674, round 2, finding 1).
 */
// **No `problems` channel, because it was never written to.** It was declared, threaded through
// from the gate, and four cells asserted it was empty — cells that were empty by construction and
// could not go red (gate 2 on #674, round 3, finding 7). Everything this reader cannot resolve goes
// to `unreadable`, which is pinned and compared in both directions.
export function readFailCodeSites(sources) {
  const codes = new Set();
  const sites = [];
  // **A call site whose code this parser cannot read is not a problem with the parser — it is a
  // producer whose values cannot be enumerated**, which is a fact about the tree and belongs in the
  // pin beside the others (the result axis carries `ToolFailureError:code` the same way). Pushing it
  // to `problems` would make the gate red on the day it lands, and a gate that is red on arrival is
  // a gate somebody turns off (#670).
  const unreadable = [];
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
      // `failCode`'s own declaration, whatever it names its first parameter.
      if (/^\s*[A-Za-z_$][\w$]*\s*:\s*string/.test(first)) continue;
      const lit = literal(first.trim());
      const tern = ternaryLiterals(first.trim());
      let resolved = null;
      if (lit !== null) resolved = [lit];
      else if (tern !== null) resolved = tern;
      else if (/^[A-Za-z_$][\w$]*$/.test(first.trim())) {
        const bound = readLocalBinding(text, first.trim(), m.index);
        if (bound?.codes !== undefined) resolved = bound.codes;
        else if (bound?.unreadable !== undefined) {
          unreadable.push(
            `${file}:${line}: \`${first.trim()}\` = ${bound.unreadable.replace(/\s+/g, " ").slice(0, 80)}`,
          );
          continue;
        } else if ([...wrappers.values()].includes(first.trim())) {
          // The wrapper's own parameter: resolved at ITS call sites, below.
          resolved = [];
        }
      }
      if (resolved === null) {
        unreadable.push(`${file}:${line}: ${first.trim().replace(/\s+/g, " ").slice(0, 80)}`);
        continue;
      }
      for (const c of resolved) {
        codes.add(c);
        sites.push({ file, line, code: c });
      }
    }
    // One level of wrapper: `fail("KeyLockerDisabled", …)` inside the same file.
    for (const name of wrappers.keys()) {
      for (const m of text.matchAll(new RegExp(`\\b${quoteForRegExp(name)}\\(`, "g"))) {
        const args = readArgList(text, m.index + m[0].length - 1);
        if (args === null) continue;
        const lit = literal((args[0] ?? "").trim());
        if (lit === null) {
          // **The wrapper's OWN declaration is not a call site**; anything else that reaches the
          // wrapper with a non-literal forwards an unenumerable value onto the caller's `code`, and
          // dropping it silently is what let `keyLockerFailure` — `String(err.code)`, an arbitrary
          // runtime string — sit outside the count while the headline said "CEILING" (gate 2 on
          // #674, round 2, finding 1).
          const arg = (args[0] ?? "").trim();
          const line = text.slice(0, m.index).split("\n").length;
          // **The wrapper's own declaration, by the parameter name it actually binds.** Hard-coding
          // `code: string` made a behaviour-neutral rename of that parameter add a phantom entry to
          // `unreadableCallSites` (gate 2 on #674, round 4, finding 9).
          if (!new RegExp(`^\\s*${quoteForRegExp(wrappers.get(name) ?? "code")}\\s*:\\s*string`).test(arg) && arg !== "") {
            unreadable.push(`${file}:${line}: ${name}(${arg.replace(/\s+/g, " ").slice(0, 60)})`);
          }
          continue;
        }
        codes.add(lit);
        sites.push({ file, line: text.slice(0, m.index).split("\n").length, code: lit, via: name });
      }
    }
  }
  return { codes: [...codes].sort(), sites, unreadable: [...new Set(unreadable)].sort() };
}

/**
 * The binding of `identifier` that is in force AT `before` — the NEAREST preceding `const`, not the
 * first one in the file.
 *
 * **One site's codes were being attributed to another's.** `browser.ts` binds `const code` twice —
 * at 1295 (a two-way ternary, `BrowserAmbiguousTarget` / `BrowserNoActionableTarget`) and at 2708 (a
 * four-way ternary over `r.__error`). Resolving from the top of the file gave BOTH `failCode(code, …)`
 * sites the first binding's two codes, with `problems` empty — and the four codes the second site
 * really names were only in the pin because other call sites happened to name them too. Adding a
 * fifth branch there left the gate green (gate 2 on #674, finding 2).
 *
 * Returns `{ codes }` when it can read the expression, `{ unreadable }` when a binding is in force
 * but this parser cannot read it, and `null` when there is no binding at all. The middle case is the
 * one the old shape could not express, and it is the four-way ternary.
 */
function readLocalBinding(text, identifier, before = text.length) {
  // **The expression ends at a `;` that is not inside a literal.** `[^;]+` stopped at the semicolon
  // in `const code = cond ? "a;b" : "Second";`, and the truncated text was then reported as
  // unreadable — an under-read wearing an honest answer's clothes. win2 found the same class in
  // their own extraction on 2026-09-18 (a non-greedy `}` stopping inside `{tool:reidentify_element}`)
  // and the user's new rule is to chase the root rather than the site, so it is fixed here too
  // rather than waited for.
  const re = new RegExp(`\\bconst\\s+${quoteForRegExp(identifier)}\\s*(?::[^=;]+)?=\\s*`, "g");
  let nearest = null;
  for (const m of text.matchAll(re)) {
    if (m.index > before) break;
    nearest = m;
  }
  if (nearest === null) return null;
  const from = nearest.index + nearest[0].length;
  let depth = 0;
  let end = text.length;
  for (let i = from; i < text.length; i++) {
    const skip = literalEnd(text, i, significantBefore(text, i));
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth <= 0) {
      end = i;
      break;
    }
  }
  const expr = text.slice(from, end).trim();
  const lit = literal(expr);
  if (lit !== null) return { codes: [lit] };
  const tern = ternaryLiterals(expr);
  if (tern !== null) return { codes: tern };
  return { unreadable: expr };
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
  for (let i = open; i < text.length; i++) {
    const skip = literalEnd(text, i, significantBefore(text, i));
    if (skip !== -1) {
      cur += text.slice(i, skip);
      i = skip - 1;
      continue;
    }
    const ch = text[i];
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
    const inString = stringRanges(text);
    // **Forward, with a stack — not backwards from the anchor.** The backward walk counted braces
    // with no literal awareness, so `{ error: "}", ok: false, code: … }` balanced its own object
    // against a brace inside a string and the site vanished (gate 2 on #674, round 3, finding 2).
    // A single forward pass that knows what a literal is gives the enclosing object directly.
    const open = [];
    for (let i = 0; i < text.length; i++) {
      // **The anchor is tested before the literal skip.** `"ok": false` BEGINS with a quote, so
      // skipping literals first stepped straight over the JSON-styled form the round-1 fix had just
      // taught the walker to read.
      const anchored =
        open.length > 0 &&
        /[{,\s]/.test(text[i - 1] ?? "") &&
        /^["']?\bok["']?:\s*false\b/.test(text.slice(i, i + 16)) &&
        // A sentence that DESCRIBES the shape is not a site that builds it.
        !inString.some(([a, b]) => i > a && i < b);
      // **Resume past the KEY, not one character into it.** Testing the anchor before the literal
      // skip is what lets `"ok": false` be seen; advancing by one then handed the closing `"` of
      // `"ok"` to `literalEnd` as an OPENING quote, inverting quote parity for the rest of the line
      // (gate 2 on #674, round 4, finding 8 — latent in `src` today, and latent is how the last
      // three of these started).
      const skip = anchored ? -1 : literalEnd(text, i, significantBefore(text, i));
      if (skip !== -1) {
        i = skip - 1;
        continue;
      }
      const ch = text[i];
      if (!anchored) {
        if (ch === "{") {
          open.push(i);
          continue;
        }
        if (ch === "}") {
          open.pop();
          continue;
        }
      }
      if (!anchored) continue;
      const keyEnd = literalEnd(text, i, significantBefore(text, i));
      if (keyEnd !== -1) i = keyEnd - 1;
      const start = open[open.length - 1];
      const obj = blockAt(text, start);
      if (obj === null || isTypeLiteral(obj.body)) continue;
      const keys = keysAtDepthOne(obj.body);
      if (!keys.includes("code") || !keys.includes("error")) continue;
      const exprs = fieldsAtDepthOne(obj.body, "code");
      const line = text.slice(0, i).split("\n").length;
      const before = text.slice(0, start);
      const decl = [
        ...before.matchAll(
          // A FUNCTION-LIKE declaration only: `const failure: ToolFailure = { … }` is a local, and
          // taking it as the enclosing declaration answers the reachability question about a
          // variable. The const form must be followed by a function or an arrow's parameter list.
          // **`= (` is not enough, and "no parentheses inside" is too much.** The bare form matched
          // any parenthesised expression (`const trimmed = (s ?? "").trim()`) and the reachability
          // answer was then about the wrong name (round 4, finding 1); requiring a paren-FREE
          // parameter list then lost `(a, b = f())` and `(cb: (n) => void)`, which the bare form had
          // got right (round 5, finding 5). One level of nesting is what a parameter list needs, and
          // the `=>` still has to be there.
          /\b(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b|\((?:[^()]|\([^()]*\))*\)\s*(?::[^;{]*?)?=>|[A-Za-z_$][\w$]*\s*=>))/g,
        ),
      ].at(-1);
      let fn = decl === undefined ? null : (decl[2] ?? decl[3] ?? null);
      let exported = decl !== undefined && decl[1] !== undefined;
      // **And it has to actually enclose the site.** The nearest preceding function-like binding is
      // often a helper that has already closed, and answering reachability about a neighbour is how
      // a code gets excluded from the count on a guess.
      if (decl !== undefined && !declarationEncloses(text, decl.index, start)) {
        fn = null;
        exported = false;
      }
      for (const expr of exprs) {
        found.push({ file, line, code: literal(expr ?? ""), expression: expr, fn, exported });
      }
    }
  }
  return found;
}

/**
 * The index ranges covered by string and template literals.
 *
 * **Prose quotes the shape it describes.** `wait-until.ts`'s own `caveats:` sentence contains
 * `{ok:false, code:'WaitTimeout', error, suggest:[...]}`, and the generated catalogue copies it — so
 * the shape sweep, which reads the tree after comments are stripped but with strings intact, found
 * two "hand-built failures" that are documentation (gate 2's findings 4 and 7 uncovered them by
 * teaching the sweep two more spellings; the same widening that found a real producer found these).
 * Same class as the comment that quotes a road literal, one quote character over.
 */
function stringRanges(text) {
  const ranges = [];
  for (let i = 0; i < text.length; i++) {
    const end = literalEnd(text, i, significantBefore(text, i));
    if (end === -1) continue;
    ranges.push([i, end]);
    i = end - 1;
  }
  return ranges;
}

/**
 * Does the declaration starting at `declStart` have a block that contains `index`?
 *
 * The first `{` after a declaration is often not its body — a parameter's object type, or
 * `Promise<{ … }>` in the return type. So the candidates are walked in order until one spans the
 * site; eight is more than any declaration in this tree needs, and stopping is what keeps the answer
 * "unknown" instead of "somebody else's".
 */
function declarationEncloses(text, declStart, index) {
  let from = declStart;
  for (let guard = 0; guard < 8; guard++) {
    const block = blockAt(text, from);
    if (block === null) return false;
    if (block.start <= index && index <= block.end) return true;
    if (block.end > index) return false;
    from = block.end + 1;
  }
  return false;
}

/** Is `name` called anywhere outside the file that defines it? */
export function isCalledOutside(sources, name, definingFile) {
  // **`Object.keys(o)` is not a call to a function named `keys`.** The bare `\b` boundary answered
  // reachability by coincidence for any producer whose enclosing name collides with a common method
  // — `keys`, `list`, `get`, `send`, `parse` (gate 2 on #674, round 4, finding 7).
  //
  // **But excluding the property form cannot answer "no".** A producer reached through a dispatch
  // table or a re-export (`api.insertText(…)`) is called, and `false` is the one answer that REMOVES
  // a code from the count. So a property call of the same name returns `null` — unknown — and the
  // caller keeps the code (gate 2, round 5, finding 6: a narrowing that reduces detection is the
  // direction that needs its control re-fired).
  const free = new RegExp(`(^|[^.\\w$])${quoteForRegExp(name)}\\s*\\(`);
  const property = new RegExp(`\\.\\s*${quoteForRegExp(name)}\\s*\\(`);
  let viaProperty = false;
  for (const { file, text } of sources) {
    if (file === definingFile) continue;
    const stripped = stripComments(text);
    if (free.test(stripped)) return true;
    if (property.test(stripped)) viaProperty = true;
  }
  return viaProperty ? null : false;
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
    // **Not only the exported ones.** A module-private constant interpolated into a script would be
    // printed as `${NAME}` as if that were the code (gate 2 on #674, round 2, finding 5).
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*"([^"]*)"/g)) {
      constants.set(m[1], m[2]);
    }
  }
  const out = [];
  for (const { file, text } of stripped) {
    // **Inside a string, or it is not "spelled inside a script".** A TypeScript object literal
    // written JSON-style wears the same characters, and the hand-built sweep already reads those —
    // the two sets would record the same site twice, each calling it something different.
    const inString = stringRanges(text);
    for (const m of text.matchAll(/"code"\s*:\s*"([^"]+)"/g)) {
      if (!inString.some(([a, b]) => m.index > a && m.index < b)) continue;
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
