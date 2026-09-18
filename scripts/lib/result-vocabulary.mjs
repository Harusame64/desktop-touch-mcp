// ADR-036 — the RESULT axis of the completion grid, read out of the source.
//
// The gate's denominator is "the vocabulary extracted from the code × configuration × result"
// (the user's decision, 2026-09-11). The road axis got its extractor in #669 and the configuration
// axis in #670. This is the third and last.
//
// **What makes this one hard is that the axis has a type for two thirds of itself.** The loop's
// failure arm is `reason: TouchFailReason` — eighteen values, enumerated, compile-checked. But the
// wrapper ABOVE it returns `CompatRawFailureShape`, whose `reason` is a plain `string`, and it does
// not write that string: it COMPUTES it from the name of the error that reached it.
//
//     const errorName = result.error.name;                 // _envelope.ts
//     reason: pascalToSnake(ifUnexp.most_likely_cause)     // most_likely_cause === errorName
//
// **The producer is `error.name`, and the first version of this file modelled it with `SUGGESTS`.**
// That table is the ADVICE lookup, keyed BY the name — downstream of the thing it was standing in
// for. Taking its 94 keys as the reason space was wrong in both directions at once: it counted 82
// values nothing can produce, and it missed `handler_error` (every un-typed throw collapses into
// `HandlerError` at `toResultErr`), `unknown` (the `if_unexpected` fallback) and the three lease
// codes, none of which are keys. Gate 2 on #672 caught it by adding a fifth lease code and watching
// the gate print OK. **The number went 101 to 26.**
//
// So this file reads the PRODUCER, which is `buildFailureEnvelope(name, …)`, and the routes that
// reach it:
//
//  1. a direct `buildFailureEnvelope("Name", …)` — the call is EXPORTED and the tree's own docs
//     describe it as a pattern that existed and was migrated away from;
//  2. `toFailureEnvelope(Err(new SomeClass(...)))`, whose name is the literal that class sets;
//  3. `toFailureEnvelope(Err(new CodedHandlerError(<literal or bound code>)))`;
//  4. `toFailureEnvelope(toResultErr(...))`, which is how an un-typed throw would arrive — at no
//     call site today, so `handler_error` is not in the axis;
//  5. the literal `code:` values `mapLeaseValidationToTypedReason` RETURNS, which reach (3)
//     through a variable;
//  6. the `if_unexpected` fallback, for an envelope that carries none.
//
// **Membership in the `HandlerError` family is not one of them.** It was, for one round, and two
// classes that extend it are thrown by the capture engine and handed to no presenter at all. The
// family read survives only to map a constructed class to the literal name it sets.
//
// `SUGGESTS` is still read — but as a COVERAGE check. A produced name that is not one of its keys
// reaches the caller with generic advice, and two do today.
//
// **Two further rules, both bought with defects:**
//
// **Do not sweep the field name.** `reason:` is worn by at least three other axes — `_truncation`
// (`ring_underflow` / `capacity_cap`), the lease validator and the background-input channel. A
// sweep for the spelling merges four axes on a shared word, which is the mistake this vocabulary
// exists to avoid.
//
// **Do not re-implement the conversion.** A port written from `pascalToSnake`'s name agrees with the
// real one for most inputs and differs on the four `…NUpperBoundExceeded` codes, because the
// implementation splits `([a-z])([A-Z])` and nothing else. Two implementations that agree most of
// the time are the worst kind of check, so the body is pinned and a changed one stops the
// derivation rather than guessing at its image.

import { quoteForRegExp } from "./route-vocabulary.mjs";
// **The one scanner, and the one depth-1 reader.** Both already exist in this tree; this file
// had grown its own copy of the first and no copy of the second. Importing them is the fix for
// two findings at once, because both findings are the same defect: a second reader.
import { maskLiteralContents } from "./route-vocabulary.mjs";
import { fieldsAtDepthOne, isShorthandAtDepthOne } from "./code-vocabulary.mjs";

/** Strip `//` and block comments, keeping every line's index — and leaving string literals alone. */
export function stripComments(source) {
  const text = source.replace(/\r\n/g, "\n");
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // **A block comment separates two tokens; deleting it joins them** — `foo/**/bar` came out
      // as `foobar` (gate 2 on #679, round 2). The separator is kept, and the newlines still land
      // where they did, because the contract here is the line index, not the column.
      out += " ";
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let j = i; j < end; j++) if (text[j] === "\n") out += "\n";
      i = end;
      continue;
    }
    // **After the comment checks, never before them.** Placed first, `// foo` parses as an empty
    // regex literal (`//` plus flags) and the comment is never stripped — 94 SUGGESTS keys became 20
    // the moment this was tried in the wrong order.
    //
    // **A regex literal is not a comment and is not a string, and it can contain both.**
    // `/^Exception calling "GetCurrentPattern" with "\d+" argument\(s\): ".*/` has five quotes;
    // once the walk over all of `src/` began (this file used to see five named files), that odd
    // quote opened a string state that never closed, and every comment BELOW it in that file
    // stopped being stripped. Gate 2 on #672 showed it live in two files by planting a
    // commented-out error class after the desync and watching it enter the axis, with the same
    // comment in a clean file changing nothing.
    if (ch === "/" && regexCanStartHere(out)) {
      const end = skipRegexLiteral(text, i);
      if (end > i) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** The body of a brace-delimited initialiser, from the `{` that follows `head`. */
function bodyAfter(text, head) {
  const at = text.indexOf(head);
  if (at === -1) return null;
  const open = text.indexOf("{", at + head.length - 1);
  if (open === -1) return null;
  let depth = 1;
  let i = open + 1;
  let quote = null;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    // **A brace inside a string is not a brace.** The advice table is dense with them —
    // `"Run {tool:list_window_titles}"`, `"browser_open({launch:{}})"`, `"until:{mode:'exit'}"` —
    // and today every one of them is balanced, so a counter that cannot see strings happens to
    // work. An unbalanced `{` would run off the end and be REPORTED; an unbalanced `}` would close
    // the table early and return a short key set with `problems` empty, and `--update` would then
    // write that short set into the grid (gate 2 on #672 ran it end to end). The asymmetry is what
    // makes it worth fixing before it happens rather than after.
    if (quote) {
      if (ch === "\\") i += 2;
      else {
        if (ch === quote) quote = null;
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? text.slice(open + 1, i - 1) : null;
}

/**
 * The keys of the `SUGGESTS` advice table — the PascalCase code space the computed reason is drawn
 * from.
 *
 * `problems` gets an entry when the table cannot be read at all, because an unreadable table comes
 * back as an empty set and an empty set is indistinguishable from "the wrapper produces nothing".
 */
export function readSuggestsKeys(source, problems = []) {
  const text = stripComments(source);
  const body = bodyAfter(text, "const SUGGESTS: Record<string, string[]> = {");
  if (body === null) {
    problems.push("SUGGESTS could not be read — the advice coverage of the reason axis is unknown, not empty");
    return [];
  }
  // **Read at depth 1 of the object, not at an indent.** The first version anchored on exactly two
  // spaces and an optional DOUBLE quote — so a single-quoted key, a computed `[CODE]:` key, a key
  // on the header line and a reformat to four spaces were each dropped with `problems` empty, and
  // a quoted advice STRING that happened to contain a colon was added as a key (gate 2 on #672
  // probed seven shapes; four were silent). Depth is the grammar; an indent is a spelling, and
  // enumerating spellings does not end.
  const keys = [];
  let depth = 0;
  let quote = null;
  let i = 0;
  let atKeyStart = true;
  while (i < body.length) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i += 2;
      else {
        if (ch === quote) quote = null;
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      if (depth === 0 && atKeyStart) {
        const m = body.slice(i).match(/^(["'])([A-Za-z_][\w]*)\1\s*:/);
        if (m) {
          keys.push(m[2]);
          i += m[0].length;
          atKeyStart = false;
          continue;
        }
      }
      quote = ch;
      i++;
      continue;
    }
    // **A computed key is reported, not dropped.** `[HANDLER_ERROR]: ["retry"]` entered the depth
    // branch and vanished, and the comment above claimed the shape was handled — so adding computed
    // advice for a name that has none today would change what the caller is told while
    // `withoutAdvice` stayed put and the gate stayed green (codex, #672).
    if (ch === "[" && depth === 0 && atKeyStart) {
      const computed = body.slice(i).match(/^\[[^\]]*\]\s*:/);
      if (computed) {
        problems.push("SUGGESTS has a computed key this parser cannot name — the advice coverage is a lower bound");
        i += computed[0].length;
        atKeyStart = false;
        continue;
      }
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ",") atKeyStart = depth === 0;
    else if (depth === 0 && atKeyStart && /[A-Za-z_]/.test(ch)) {
      const m = body.slice(i).match(/^([A-Za-z_][\w]*)\s*:/);
      if (m) {
        keys.push(m[1]);
        i += m[0].length;
        atKeyStart = false;
        continue;
      }
      atKeyStart = false;
    } else if (depth === 0 && !/\s/.test(ch)) atKeyStart = false;
    i++;
  }
  if (keys.length === 0) problems.push("SUGGESTS has no keys at depth 1 — has the table been reshaped?");
  return [...new Set(keys)].sort();
}

/**
 * Every error name that can reach the failure envelope, which is what the wrapper converts.
 *
 * **Only the `HandlerError` family arrives under its own name.** `toResultErr` wraps everything
 * else, so the twenty-odd engine error classes that extend plain `Error` all collapse into
 * `HandlerError` rather than each adding a reason — and `HandlerError` itself is therefore one of
 * the names, and one of the two that no catalogue mentions.
 *
 * `sources` is a list of `{ file, text }`. A dynamic `this.name = x` is reported unless it is the
 * one recognised case: `CodedHandlerError` assigns its `code` parameter, and the codes are read
 * separately below.
 */
export function readEnvelopeErrorNames(sources, problems = [], resolved = []) {
  const extendsOf = new Map();
  const nameOf = new Map();
  const declaredIn = new Map();
  for (const { file, text: raw } of sources) {
    const text = stripComments(raw);
    for (const m of text.matchAll(/\bclass\s+(\w+)\s+extends\s+([\w.]+)/g)) {
      // **To the class's own closing brace, not a fixed window.** The first version read 900
      // characters and gate 2 showed both ends of that: a constructor longer than the window left
      // its class NAMELESS with `problems` empty, and a class with no `this.name` took the LITERAL
      // OF THE NEXT CLASS — including from one explicitly outside the family, which put a reason
      // nothing can produce into the grid.
      const body = text.slice(m.index, classEnd(text, m.index));
      // **Keyed by file and class.** `AimOccludedError` is declared twice — `src/engine/aim.ts`
      // extends `Error`, `src/errors/typed-errors.ts` extends `HandlerError` — so a bare name means
      // last writer wins, and the axis was right only because of the order `readdirSync` returned.
      // Moving one file would have turned two real reasons into "the code no longer produces".
      const key = `${file}:${m[1]}`;
      extendsOf.set(key, m[2]);
      declaredIn.set(m[1], [...(declaredIn.get(m[1]) ?? []), key]);
      // **Both quote spellings.** The repository has no lint rule forcing double quotes, so
      // `this.name = 'NewFailure'` is valid and was read as neither a literal NOR a dynamic value:
      // the class contributed nothing and raised nothing, while the runtime exposed the name
      // (codex, #672). Enumerating spellings does not end — this one is closed by the alternation
      // the dynamic branch below already needed.
      const literal = body.match(/this\.name\s*=\s*["']([^"']+)["']/);
      if (literal) {
        nameOf.set(key, literal[1]);
        continue;
      }
      const dynamic = body.match(/this\.name\s*=\s*([A-Za-z_][\w.]*)\s*;/);
      if (!dynamic) continue;
      if (m[1] === "CodedHandlerError" && dynamic[1] === "code") continue;
      // The exemption carries the FILE as well as the class: one written-down entry must not
      // exempt a same-named class somewhere else.
      if (resolved.includes(`${file}:${m[1]}:${dynamic[1]}`)) continue;
      problems.push(`${file}: ${m[1]} sets this.name from \`${dynamic[1]}\`, a value this parser cannot enumerate`);
    }
  }
  const parentKeys = (name) => declaredIn.get(name) ?? [];
  const inFamily = (key) => {
    const seen = new Set();
    let stack = [key];
    for (let hops = 0; hops < 40 && stack.length > 0; hops++) {
      const next = [];
      for (const k of stack) {
        if (seen.has(k)) continue;
        seen.add(k);
        const parent = extendsOf.get(k);
        if (parent === undefined) continue;
        if (parent === "HandlerError") return true;
        next.push(...parentKeys(parent.split(".").pop()));
      }
      stack = next;
    }
    return false;
  };

  // **`HandlerError`'s own name is read, not seeded.** It was a string constant in this file, so
  // renaming `this.name = "HandlerError"` in the tree — which changes the value on the wire for
  // every un-typed throw — left the gate green and its own sentence still naming `handler_error`.
  const names = new Set();
  // **The bare-name collapse re-introduces the collision `nameOf` is keyed to avoid.** `nameOf` is
  // `file:class` because `AimOccludedError` is declared in two files with DIFFERENT `this.name`
  // values (`"AimOccludedError"` in `engine/aim.ts`, `"AimOccluded"` in `errors/typed-errors.ts`),
  // and both are presented. Collapsing is last-writer-wins over walk order — correct today only
  // because `engine/` sorts first — so a disagreement is REPORTED rather than silently resolved
  // (gate 2, #673).
  const nameOfClass = new Map();
  const collisions = [];
  for (const [key, literal] of nameOf) {
    const cls = key.split(":").pop();
    const seen = nameOfClass.get(cls);
    if (seen !== undefined && seen !== literal) {
      collisions.push(`${cls}: ${[seen, literal].sort().join(" / ")}`);
    }
    nameOfClass.set(cls, literal);
  }
  let root = null;
  for (const [key, literal] of nameOf) {
    if (key.endsWith(":HandlerError") && extendsOf.get(key) === "Error") root = literal;
  }
  if (root === null) problems.push("HandlerError's own name could not be read — every un-typed throw arrives under it");
  else names.add(root);

  for (const key of extendsOf.keys()) {
    if (!inFamily(key)) continue;
    const literal = nameOf.get(key);
    if (literal !== undefined) names.add(literal);
  }
  // `names` is the family; `nameOfClass` is what the presenter read needs, because a class that
  // reaches `toFailureEnvelope` is named by the literal it sets, not by its own identifier.
  return { names: [...names].sort(), nameOfClass, collisions: [...new Set(collisions)].sort() };
}

/**
 * Whether a `/` at this point opens a regular expression rather than being division.
 *
 * Decided by what came before it, which is the standard way and is not exact — but the inexactness
 * is one-sided here: treating a division as a regex loses at most the rest of a line, while
 * treating a regex as division desyncs the whole FILE.
 */
function regexCanStartHere(before) {
  const prev = before.replace(/\s+$/, "").slice(-1);
  if (prev === "") return true;
  if ("=(,:[!&|?{};+-*%^~<>".includes(prev)) return true;
  return /\b(return|typeof|instanceof|case|in|of|do|else|yield|await|new|delete|void)$/.test(before.replace(/\s+$/, ""));
}

/** The index just past a regex literal starting at `i`, or `i` if this is not one. */
function skipRegexLiteral(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\n") return i; // a regex literal does not span lines: this was division
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (j < text.length && /[dgimsuvy]/.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return i;
}

/** The index just past a class declaration's closing brace, counting from its `class` keyword. */
function classEnd(text, start) {
  const open = text.indexOf("{", start);
  if (open === -1) return text.length;
  let depth = 1;
  let i = open + 1;
  let quote = null;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 2;
      else {
        if (ch === quote) quote = null;
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

/**
 * The literal codes a named function RETURNS, which is where the lease reasons actually come from.
 *
 * **Gate 2 on #672, third round.** The rewrite claimed to read producers and then read
 * `LEASE_REASON_TO_TYPED_CODE` — a table `mapLeaseValidationToTypedReason` never consults. That
 * function hard-codes its returns, and the table is a name RESERVATION its own comment describes as
 * being there "so expansion can mechanically promote each branch". Two names in it are produced by
 * nothing, and adding a real branch to the function left the gate green: the same defect as the
 * round before, one level further in.
 *
 * The road axis already had this technique — it reads `adr029Refusal`'s body for the grounds that
 * reach `probeRefusal` through a variable — and it was not carried over.
 */
/**
 * A copy of `source` where every literal's CONTENTS are blanked, with the delimiters and the length
 * kept — **now the base module's `maskLiteralContents`, under the name this file's callers use.**
 *
 * Three rounds got it here. It began as a hand walk over quotes that did not know regex literals,
 * which silently dropped producers whenever one carried an odd number of quotes. Round 3 made it ask
 * `literalEnd` what a literal is. #678 made the loop around that question a view instead of a fourth
 * copy. This line is what is left: the base module owns the walk, and this name points at it.
 */
export const maskStringContents = maskLiteralContents;

/**
 * Every `return { … }` in a function body, as balanced spans.
 *
 * Balanced, not non-greedy: a returned object that itself contains an object (`tryNext: [{ … }]`)
 * ends at ITS OWN closing brace, and the previous pattern ended at the inner one. Returns both the
 * real text and the masked text for the same span, so a decision about SHAPE is never made on
 * string contents and a decision about VALUE is never made on a blank.
 */
export function returnObjectSpans(masked, original) {
  const spans = [];
  const opener = /\breturn\s*\{/g;
  let m;
  while ((m = opener.exec(masked)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the `{`
    for (; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unbalanced: say nothing rather than guess
    const start = m.index + m[0].length - 1;
    spans.push({ start, text: original.slice(start, i + 1), masked: masked.slice(start, i + 1) });
    opener.lastIndex = i + 1;
  }
  return spans;
}

/**
 * The discriminant literals of the `if (…)` that encloses a position in a function body.
 *
 * Used to answer "which names can THIS return produce" when the returned code is a table read
 * rather than a literal. Deliberately shallow: the last `if (` before the position, its condition
 * up to `) {`, and the `<ident> === "literal"` comparisons in it. A branch shaped any other way
 * yields nothing, and the caller reports that instead of guessing — an empty answer here must not
 * read as "produces nothing".
 */
export function reasonsGuarding(body, index) {
  // **THE BLOCK HAS TO CONTAIN THE POSITION.** The first version took the last `if (` before the
  // return and asked no further question, so a return AFTER a closed `if` block was attributed to
  // that block's discriminants — and a `switch`-guarded return took the discriminants of whatever
  // `if` happened to sit above it. Round 2 measured three such shapes and all three answered
  // CONFIDENTLY AND WRONGLY, with `problems: []`. That is the Round 1 defect run backwards: instead
  // of counting names nothing produces, it stops counting names something does produce, and in both
  // directions the caller is told nothing went unread.
  //
  // The candidate is searched from the end, its block is balanced on a string-masked copy, and the
  // position must land inside it. Nothing matching means the caller is TOLD, not guessed at.
  const masked = maskStringContents(body);
  let from = index;
  for (;;) {
    const at = masked.lastIndexOf("if", from - 1);
    if (at === -1) return [];
    const header = masked.slice(at).match(/^if\s*\(([\s\S]*?)\)\s*\{/);
    if (!header) { from = at; continue; }
    const openAt = at + header[0].length - 1;
    let depth = 0;
    let i = openAt;
    for (; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return []; // unbalanced: say nothing rather than guess
    if (index > openAt && index < i) {
      return [...new Set([...body.slice(at, at + header[0].length).matchAll(/===\s*"([A-Za-z_][\w]*)"/g)].map((m) => m[1]))];
    }
    from = at; // that block does not contain the position — keep looking outward
  }
}

/**
 * The key → code map of the lease reservation table, for resolving a table read at a return.
 *
 * `readLeaseCodes` answers the VALUES, which is what the coverage check needs; resolving a branch
 * needs the KEYS too, because the question is "which entry does this reason select".
 */
export function readLeaseTable(source, problems = []) {
  const text = stripComments(source);
  const body = bodyAfter(text, "LEASE_REASON_TO_TYPED_CODE = {");
  if (body === null) {
    problems.push("LEASE_REASON_TO_TYPED_CODE could not be read — the lease reasons are unknown, not absent");
    return {};
  }
  const table = {};
  for (const m of body.matchAll(/([A-Za-z_][\w]*)\s*:\s*"([A-Za-z_][\w]*)"/g)) table[m[1]] = m[2];
  if (Object.keys(table).length === 0) {
    problems.push("LEASE_REASON_TO_TYPED_CODE has no entries — has the table been reshaped?");
  }
  return table;
}

export function readReturnedCodes(source, functionName, problems = [], resolvable = null) {
  const text = stripComments(source);
  // **To a `}` in the first column, not to a balanced brace.** A function's signature can carry an
  // OBJECT RETURN TYPE — `): { code: string; tryNext: TryNextAction[] } {` — so the first `{` after
  // the name opens the annotation, and a brace-balancing scan reads the type instead of the body
  // and reports "returns no literal code" about a function full of them. The road axis reads
  // `adr029Refusal` this way for the same reason.
  const m = text.match(new RegExp(`function\\s+${quoteForRegExp(functionName)}\\b([\\s\\S]*?)\\n\\}`));
  if (!m) {
    problems.push(`${functionName} could not be found — the codes it returns are unknown, not absent`);
    return [];
  }
  const body = m[1];
  // **Inside a `return {…}`, not anywhere in the body.** The body this match captures starts at the
  // function's NAME, so it carries the signature — and `): { code: string; … }` then reads as a
  // returned code this parser cannot name. A false alarm on every run is a gate somebody silences.
  const codes = [];
  // **The object's boundaries are found on a copy where strings cannot contain punctuation.**
  // The previous pattern was `\breturn\s*\{([\s\S]*?)\}` — non-greedy, and therefore stopping at the
  // first `}` EVEN INSIDE A STRING. This repo's advice lines carry `{tool:reidentify_element}`, so a
  // return whose first property is such a string gets truncated mid-word, and everything decided
  // afterwards is decided about a fragment. The mask keeps the same LENGTH, so spans found on it
  // index the original exactly, and the value extraction still reads real text.
  //
  // Round 1 of the Opus review found the same class from the other end: the capture also consumed
  // `{` and `}`, so the shorthand detector below could not fire when `code` was the first property —
  // four of five shapes came back false, including the exact draft its own comment cites. A flag
  // that cannot fire is indistinguishable from a negative, so both are fixed here rather than
  // patched around.
  const masked = maskStringContents(body);
  for (const block of returnObjectSpans(masked, body)) {
    const objectText = block.text; // includes the braces
    // **THE KEY IS DECIDED BY WHERE IT SITS, NOT BY WHAT SPELLS IT.** Round 1 built the mask and
    // then searched the raw span with it sitting unused one line above — so a string whose
    // CONTENTS spell `code: "…"` was read as the produced name, and the real `code:` after it was
    // never reached. Measured in Round 2:
    //   return { hint: 'pass code: "Fabricated", or nothing', code: "Real" }
    //   → codes: ["Fabricated"], problems: []   ← a fabricated name, and silence
    // That is #674's gate-2 finding reproduced INSIDE the function written to end it, which is this
    // parser's recurring shape. The mask preserves length, so the offsets index the original exactly.
    // **THE KEY IS READ BY THE ONE SCANNER, AT DEPTH 1.** This was a regex over the masked span,
    // which asked neither question the two findings on this PR asked: `\bcode:` matches at ANY
    // depth, so `return { tryNext: [{ args: { code: "Nested" } }], code: "Real" }` was read as
    // producing `Nested` — measured on this branch: codes ["Nested"], problems []. Today's four
    // returns all carry `code` at the top, so the defect is one reordering away from firing, which
    // is the same kind of latency the window findings had.
    //
    // `fieldsAtDepthOne` is the reader this tree already has for exactly this question
    // (`code-vocabulary.mjs`), it is built on the one scanner, and it answers three things the
    // regex could not: depth, a conditional spread that gives `code` more than one value, and a
    // quoted string sitting in key position. Using it deletes a reader rather than teaching it.
    const expressions = fieldsAtDepthOne(objectText, "code");
    if (expressions.length === 0) {
      // No `code` at depth 1. Nothing to report: a `return` in this function may legitimately
      // carry none, and the `codes.length === 0` guard below speaks for the function as a whole.
      continue;
    }
    for (const expression of expressions) {
      // **A SHORTHAND `code` IS A PRODUCER THIS PARSER USED TO DROP IN SILENCE.** `return { code, … }`
      // carries no `code:`, so the old regex failed and the loop simply moved on — no name, no
      // problem, and a gate whose summary stayed byte-identical to the version without the branch.
      // Measured on internal#125's first draft, which was written that way by accident.
      // `fieldsAtDepthOne` reports a shorthand as the field's own name, and `{ code: code }` reads
      // the same way — both are names this parser cannot follow, and both say so here.
      if (expression === "code") {
        problems.push(
          isShorthandAtDepthOne(objectText, "code")
            ? `${functionName} returns a SHORTHAND \`code\` this parser cannot follow — spell it \`code: <expr>\` so the name is readable here`
            : `${functionName} returns \`code: code\`, a bare name this parser cannot follow — give it a literal or a read of a known table so the name is readable here`,
        );
        continue;
      }
      const literal = expression.match(/^"([A-Za-z_][\w]*)"$/);
      if (literal) {
        codes.push(literal[1]);
        continue;
      }
      // **A read of a known table resolves to the values THE BRANCH CAN REACH, not to every value in
      // it.** internal#125 promoted the two reserved lease names by READING
      // `LEASE_REASON_TO_TYPED_CODE` rather than copying its values into literals, which is what
      // makes the reservation a checked thing instead of a described one. The first version resolved
      // the read to the WHOLE table — and Round 1 of the Opus review measured what that costs: with
      // `reservedLeaseNames ⊆ producedNames` true by construction, adding a reserved name that no
      // branch returns left the extraction silent and the grid then ASSERTED a name nothing produces.
      // That is #672's defect back again, one layer further in, which is this parser's recurring
      // shape. So the guard around the return is read, and only the reasons it names are resolved.
      if (resolvable && expression.startsWith(`${resolvable.name}[`)) {
        const guarded = reasonsGuarding(body, block.start);
        if (guarded.length === 0) {
          problems.push(
            `${functionName} reads ${resolvable.name} inside a branch this parser cannot read — it cannot tell which names that return can produce`,
          );
          continue;
        }
        for (const reason of guarded) {
          const value = resolvable.table[reason];
          if (value === undefined) {
            problems.push(`${functionName} branches on "${reason}", which ${resolvable.name} has no entry for`);
            continue;
          }
          codes.push(value);
        }
        continue;
      }
      problems.push(`${functionName} returns a code this parser cannot name: ${expression.slice(0, 40)}`);
    }
  }
  if (codes.length === 0) problems.push(`${functionName} returns no literal code — has it been reshaped?`);
  return [...new Set(codes)].sort();
}

/**
 * The names that actually REACH the failure envelope, read at the presenter's own call sites.
 *
 * **Family membership was a proxy, and the proxy was wrong for two classes.**
 * `RegionOutsideCapturableBoundsError` and `CaptureBackendFailedError` extend `HandlerError` and are
 * thrown by the capture engine, but no `toFailureEnvelope(` site ever receives them — they reach a
 * caller through the flat `failWith` surface instead. So the axis carried two envelope cells that
 * cannot exist, and the report named only `HandlerError` as lacking a caller (codex, #672, P1).
 *
 * This is the fourth time today that the answer is the same: read the thing at the point it happens,
 * not something adjacent to it. The road axis reads `probeRoute` call sites; this reads
 * `toFailureEnvelope` call sites.
 *
 * `nameOfClass` maps a constructed class to the literal `this.name` it sets. `resolved` exempts a
 * coded name held in a variable, by the binding it comes from.
 */
export function readPresentedNames(sources, nameOfClass, problems = [], resolved = []) {
  const names = new Set();
  for (const { file, text: raw } of sources) {
    const text = stripComments(raw);
    // **Anchored on the shape, not on a character budget.** These calls wrap across lines
    // (`toFailureEnvelope(\n  Err(new CodedHandlerError("X")),\n  { optIn },\n)`), so a lazy scan to
    // the first `,` or `(` stops at `Err(` and reads the argument as the string "Err".
    // **`buildFailureEnvelope` is the producer; `toFailureEnvelope` is one of its callers.** Gate 2
    // on #673 found the fifth proxy in a row here: `most_likely_cause` is written by
    // `buildFailureEnvelope(name, …)`, which is EXPORTED, and the tree's own docs call the direct
    // call a pattern that existed and was migrated away from (`typed-errors.ts:357`,
    // `_errors.ts:1097`). A direct call with a fresh literal type-checks and the gate printed OK.
    for (const m of text.matchAll(/\bbuildFailureEnvelope\(\s*(["'])([A-Za-z_][\w]*)\1/g)) {
      names.add(m[2]);
    }
    for (const m of text.matchAll(/\bbuildFailureEnvelope\(\s*(?!["'][A-Za-z_])([^,)]*)/g)) {
      // The function's own declaration names its parameter; it is not a call site. (The road axis
      // learned the same thing about `probeRoute(route: string, …)`.)
      if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      const arg = m[1].trim();
      // The one call this parser follows rather than reports: `toFailureEnvelope` hands it
      // `result.error.name`, and the names that can reach THAT are read at its own sites below.
      if (arg === "errorName") continue;
      problems.push(`${file}: buildFailureEnvelope is given \`${arg.slice(0, 40)}\`, a name this parser cannot enumerate`);
    }
    for (const m of text.matchAll(/\btoFailureEnvelope\(\s*(Err\(\s*new\s+([A-Za-z_][\w]*)|toResultErr\b|[^\s)])/g)) {
      if (m[1] === "toResultErr") {
        // Everything not in the family arrives here, under `HandlerError`'s own name.
        const handler = nameOfClass.get("HandlerError");
        if (handler === undefined) problems.push(`${file}: toResultErr reaches the envelope but HandlerError's name could not be read`);
        else names.add(handler);
        continue;
      }
      const cls = m[2];
      if (cls === undefined) {
        problems.push(`${file}: toFailureEnvelope is given \`${m[1].slice(0, 40)}\`, a shape this parser cannot name`);
        continue;
      }
      if (cls === "CodedHandlerError") {
        const rest = text.slice(m.index + m[0].length);
        // **`CodedHandlerError(code, message?, options?)`** — the two-argument form is documented
        // and supported, and requiring `)` right after the string made a name-preserving edit go
        // red with two lines claiming the code "no longer produces" a name it produces unchanged
        // (gate 2, #673). `--update` refuses while problems exist, so that edit hard-blocked.
        const literal = rest.match(/^\(\s*["']([A-Za-z_][\w]*)["']\s*[,)]/);
        if (literal) {
          names.add(literal[1]);
          continue;
        }
        const ident = rest.match(/^\(\s*([A-Za-z_][\w$]*)\s*\)/);
        const exemption = ident && resolved.find((r) => r.file === file && r.identifier === ident[1]);
        if (exemption) {
          const bound = new RegExp(
            `(?:const|let)\\s*\\{[^}]*\\b${ident[1]}\\b[^}]*\\}\\s*=\\s*${exemption.from}\\(|(?:const|let)\\s+${ident[1]}\\s*=\\s*${exemption.from}\\(`,
          );
          if (bound.test(text)) continue;
          problems.push(`${file}: \`${ident[1]}\` is exempted as coming from ${exemption.from}, but nothing in this file binds it from there`);
          continue;
        }
        problems.push(`${file}: a coded failure reaches the envelope with a name this parser cannot enumerate: ${(ident?.[1] ?? rest.slice(0, 30)).trim()}`);
        continue;
      }
      const name = nameOfClass.get(cls);
      if (name === undefined) {
        problems.push(`${file}: ${cls} reaches the envelope and this parser cannot read the name it sets`);
        continue;
      }
      names.add(name);
    }
  }
  return [...names].sort();
}

/** The typed codes a lease validation maps to, which reach `CodedHandlerError` through a variable. */
export function readLeaseCodes(source, problems = []) {
  const text = stripComments(source);
  const body = bodyAfter(text, "LEASE_REASON_TO_TYPED_CODE = {");
  if (body === null) {
    problems.push("LEASE_REASON_TO_TYPED_CODE could not be read — the lease reasons are unknown, not absent");
    return [];
  }
  const values = [...body.matchAll(/:\s*"([A-Za-z_][\w]*)"/g)].map((m) => m[1]);
  if (values.length === 0) problems.push("LEASE_REASON_TO_TYPED_CODE has no code values — has the table been reshaped?");
  return [...new Set(values)].sort();
}

/**
 * The conversion the wrapper applies, extracted rather than re-implemented.
 *
 * Returns `{ body, apply }` where `apply` is the conversion **only if the body is the one pinned
 * below**. A changed body returns `apply: null`, and the caller reports it instead of computing an
 * image from a function it has not read — because an image computed from a stale port is a set that
 * looks complete and names values nothing produces.
 */
export const PINNED_PASCAL_TO_SNAKE = 'return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();';

export function readReasonConversion(source, problems = []) {
  const text = stripComments(source);
  const body = bodyAfter(text, "function pascalToSnake(");
  if (body === null) {
    problems.push("pascalToSnake could not be found — the computed reasons cannot be derived");
    return { body: null, apply: null };
  }
  const trimmed = body.trim();
  if (trimmed !== PINNED_PASCAL_TO_SNAKE) {
    problems.push(
      `pascalToSnake has changed — the computed reason set must be re-derived, not assumed:\n      pinned: ${PINNED_PASCAL_TO_SNAKE}\n      found:  ${trimmed.slice(0, 120)}`,
    );
    return { body: trimmed, apply: null };
  }
  return { body: trimmed, apply: (s) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() };
}

/**
 * The fallback the wrapper substitutes when an envelope carries no `if_unexpected`.
 *
 * It is a reason a caller can receive that is in no union, in neither catalogue, and — because it
 * is not a `SUGGESTS` key — carries no advice either. Read rather than assumed: the day the default
 * changes, the axis gains or loses a value and nothing else in the tree would say so.
 */
export function readUnexpectedFallback(source, problems = []) {
  const text = stripComments(source);
  const m = text.match(/if_unexpected\s*\?\?\s*\{\s*most_likely_cause:\s*"([A-Za-z_][\w]*)"/);
  if (!m) {
    problems.push("the `if_unexpected` fallback could not be read — the reason it produces is unknown, not absent");
    return null;
  }
  return m[1];
}

/**
 * The reasons a prose catalogue tells a caller to expect, as `<name> → <advice>` lines.
 *
 * Two of these exist — the server's instructions and the act tool's description — and the map's
 * reading says they disagree. Comparing them to each other, and both to what the code produces, is
 * the same check that found a documented-but-unread switch on the configuration axis.
 */
export function readReasonCatalogue(source) {
  const names = new Set();
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    // A catalogue entry is `"  a / b / c → …"` inside a quoted instruction line.
    // **`→` only.** The first version also accepted `->`, and no catalogue line in the tree spells
    // it that way — a branch no input can produce, which reads as coverage and is not (gate 2 on
    // #672). The bracketed shape (`executor_failed on terminal textbox (action=type) →`) IS live,
    // at `desktop-register.ts:1645`, so the class allows it.
    const m = line.match(/"\s{2}([a-z_][a-z0-9_ /()=]*?)\s*→/);
    if (!m) continue;
    for (const segment of m[1].split("/")) {
      // **A segment can carry a qualifier**, and the qualifier is not part of the name:
      // `"  executor_failed on terminal textbox (action=type) → …"` catalogues `executor_failed`,
      // not a reason nobody produces. Take the leading identifier and drop the prose after it.
      const name = segment.trim().match(/^[a-z_][a-z0-9_]*/);
      if (name) names.add(name[0]);
    }
  }
  return [...names].sort();
}
