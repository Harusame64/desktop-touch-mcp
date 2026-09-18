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
 * Quote every regex metacharacter in a name read out of the source.
 *
 * All four extractions build patterns out of names they PARSED — a union's name, a holder's name, a
 * function's name, an identifier an arm returns. When the parse is wrong the string is not an
 * identifier at all, and an unescaped interpolation then builds a pattern that matches something
 * other than what it names: the extraction's own failure mode, inside the tool that detects it.
 * (CodeQL flagged the partial `$`-only escaping on #674; the class is the reason, not the alert.)
 */
export function quoteForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  // Templates currently open, innermost last. A `{ template: true }` entry means the walk is in
  // quoted text; `{ template: false, depth }` means it is in that template's `${…}`, which is code.
  const stack = [];
  while (i < src.length) {
    const top = stack[stack.length - 1];
    if (top !== undefined && top.template) {
      const c = src[i];
      if (c === "\\") {
        out += c + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        out += "${";
        stack.push({ template: false, depth: 0 });
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    const ch = src[i];
    const next = src[i + 1];
    // Comments first — the specification agrees: `//` is never an empty regex, `/*` never a regex.
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      // **A block comment separates two tokens, and deleting it joins them.** `foo/**/bar` came out
      // as `foobar`, `return/**/x;` as `returnx;`, and `x+/**/+ /re/` as `x++ /re/` — which the
      // operator-run rule then reads as a postfix increment, so the regex after it is called
      // division and its quotes are counted (gate 2 on #679, round 2). Every reader in this tree
      // did this, and has since before #674; it is one character to fix, in each of the three
      // strippers, and the shape it breaks is one nobody has written yet.
      //
      // The space goes in FIRST so the line's newlines still land where they did: this function's
      // contract is that every line keeps its index, not its width.
      out += " ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    // **A template's `${…}` is code, so the walk leaves the literal there.** Taking the whole
    // template as quoted text left a `/* … */` inside an interpolation UNSTRIPPED — harmless while
    // nothing looked inside, and not harmless once `literalSpans` did: the closing `/` of `*/` sits
    // after a `*`, which is in the "a value may begin here" class, so it opened a regex that ate the
    // rest of the line and a `probeAim` after it vanished with `problems` empty (gate 2 on #679,
    // round 3). The stripper is a reader, and this is the rule every reader in this tree has to
    // learn at the same time.
    if (ch === "`") {
      out += ch;
      stack.push({ template: true, depth: 0 });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
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
    if (top !== undefined) {
      if (ch === "{") top.depth++;
      else if (ch === "}") {
        if (top.depth === 0) {
          out += ch;
          stack.pop();
          i++;
          continue;
        }
        top.depth--;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * ## The literal reader, and why it lives in this file
 *
 * `stripComments` above is this tree's oldest grammar reader, and every defect it has paid for was
 * the same one: **a scanner that did not know a rule another scanner had already learned.** #672
 * taught it that a regex literal is not a comment. #674 found that eight scanners below it still
 * read a regex's quote as a string delimiter. #677 found the rule had been copied into a reader for
 * a language that has no regex literals at all, where it sat inert. internal#125 grew a ninth
 * scanner sixty lines below the comment that says not to.
 *
 * `literalEnd` was written to end that, and it did — for the two modules that could reach it.
 * **This one could not.** `code-vocabulary.mjs` imports from here, so a reader living there is
 * unreachable from the base module, and the road axis has been parsing without a literal reader
 * ever since. It is the only module with no answer to "is this a literal", which is why its
 * bounded windows are the ones that have to guess.
 *
 * So the reader moves down to the module everything else imports. Nothing about it changes.
 */

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
  // **Anchored.** `.test` on an unanchored class asks "does this string CONTAIN one of these", and
  // `previous` is not always one character: `significantBefore` answers `++` for a postfix increment,
  // and `"++".includes("+")` is true, so the very distinction that answer exists to draw was
  // swallowed by the test that read it. A keyword answer is already anchored on the right-hand side.
  // `if` / `while` / `for` are here because `significantBefore` answers with the KEYWORD when the
  // `)` before the slash is the one that closes their header — see the note there. They can never
  // be the significant character in their own right (`if /re/` is not a program), so adding them
  // widens nothing else.
  if (!/^[=(,[!&|?:;{}+\-*%^~<>]$/.test(previous ?? "(") && !/^(?:return|typeof|case|in|of|do|else|void|delete|instanceof|new|yield|await|if|while|for)$/.test(previous ?? "")) {
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
    else if (c === "/" && !inClass) {
      // **The flags belong to the literal.** They are letters, so leaving them out changed no
      // reader's answer — but it was the ONLY thing TypeScript's own scanner and this one disagreed
      // about across `src/`: 82 characters in 2,124,147, all of them flags. Taking them in makes the
      // agreement exact, and an invariant with no permitted exceptions is one that cannot rot into
      // a list nobody re-reads.
      while (j < text.length && /[dgimsuvy]/.test(text[j])) j++;
      break;
    } else if (c === "\n") break;
  }
  return j;
}

/**
 * For each `)` that closes an `if` / `while` / `for` HEADER, that keyword — the whole file at once.
 *
 * **Computed on a mask, and re-entrant.** Parentheses inside a literal are not parentheses, so the
 * walk needs to know what a literal is — and deciding that calls `significantBefore`, which calls
 * this. The flag breaks the cycle: while the mask is being built, a `)` reads as a value, which is
 * the answer this module gave everywhere until now. The only position where the two answers differ
 * is a `/` immediately after a header's `)`, and a regex THERE cannot change which `(` a `)` closes
 * unless it carries an unbalanced parenthesis of its own — `if (a) /)/ .test(b)` is the shape, and
 * it is recorded rather than handled.
 *
 * **The memo is load-bearing, not an optimisation.** `significantBefore` is called once per
 * character, so rebuilding the map on each `)` makes the reader quadratic: measured on
 * `src/tools/desktop-executor.ts` (50,279 characters), 36 ms with the memo and 9,449 ms without —
 * the same answer, 262 times slower, and the unit suite times out rather than failing. This module
 * has been here before: the first `significantBefore` sliced from the start of the file to read the
 * word behind the cursor, and the scan took minutes over a 2 MB tree.
 *
 * It is keyed by REFERENCE, because every caller walks one file to the end before moving to the
 * next, and comparing the strings by value would put the cost back.
 *
 * No timing cell pins this. A timing assertion is flaky on a loaded machine, and the failure it
 * would catch announces itself anyway — a gate that took 36 ms takes minutes. It is written down
 * here instead, with the measurement, which is what a bound whose grounds are recorded looks like.
 */
let parenText = null;
let parenMap = null;
let buildingParenMap = false;
function controlHeaderParens(text) {
  if (parenText === text) return parenMap;
  if (buildingParenMap) return EMPTY_PARENS;
  buildingParenMap = true;
  let masked;
  try {
    masked = maskLiteralContents(text);
  } finally {
    buildingParenMap = false;
  }
  const map = new Map();
  const stack = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") {
      let w = i - 1;
      while (w >= 0 && /\s/.test(masked[w])) w--;
      const end = w;
      while (w >= 0 && /\w/.test(masked[w])) w--;
      const word = masked.slice(w + 1, end + 1);
      stack.push(/^(?:if|while|for)$/.test(word) ? word : null);
    } else if (ch === ")") {
      const word = stack.pop();
      if (word) map.set(i, word);
    }
  }
  parenText = text;
  parenMap = map;
  return map;
}
const EMPTY_PARENS = new Map();

/**
 * The last significant character (or word) before `i`, for deciding whether a `/` opens a regex.
 */
export function significantBefore(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return "(";
  // **A `)` is not always a value.** After the one that closes an `if` / `while` / `for` HEADER a
  // statement begins, and a statement may begin with a regular expression: `if (r) /"/.test(x);`.
  // Reading the character alone answered "value", so the slash was division, the quote inside the
  // regex opened a string, and everything after it on the line was blanked out of the mask — the
  // producer sitting there left the axis in silence. Found by gate 2 on internal#125 (round 4) and
  // pinned as it behaved until now; unreachable in this tree, which is why only a shape fired on
  // purpose could say so.
  //
  // Which `)` that is cannot be read from the `)`: it has to be matched back to its `(` and the
  // word before it. The answer is a property of the TEXT, so it is computed once for the whole file
  // and looked up — a per-position backward walk would make this function quadratic, and this
  // function is called once per character.
  if (text[j] === ")") {
    const keyword = controlHeaderParens(text).get(j);
    if (keyword !== undefined) return keyword;
  }
  // **A postfix `++` or `--` ends a VALUE, so what follows is division.** The character class below
  // holds `+` and `-` because a regex may follow a binary one (`x + /re/.test(s)`), and reading only
  // the last character cannot tell `x + /` from `x++ /`. It answered "regex" for both, so
  // `x++ / 2; keep;` had everything to the end of the line read as a literal and blanked out of the
  // masked copy — a producer sitting there would leave the axis in silence.
  //
  // This was spelled three times in this tree (`opensValue` here, this table, and
  // `regexCanStartHere` in `result-vocabulary.mjs`) and all three agreed on being wrong; #678 made
  // them one, so this is one line instead of three. A PREFIX `++x` needs no rule — its significant
  // character is the identifier, which already reads as a value.
  if (text[j] === "+" || text[j] === "-") {
    // **The RUN is counted, because the last two characters are not the last token.** `x+++/re/`
    // tokenises as `x++ + /re/` — a postfix increment and then a BINARY plus, after which a regex
    // may begin. Reading the two characters nearest the slash sees `++` and answers division, so the
    // regex's quotes were counted and everything after it on the line was blanked (round 1 on #679;
    // reproduced here with a sentinel in live code after the construct — a sentinel INSIDE the regex
    // cannot tell the two readings apart, because it is blanked either way).
    //
    // An even run ends in `++`, which closes a value; an odd run ends in a single `+`, which opens
    // one. This is the same mistake the bound it replaced made, one level in: a fixed amount of
    // context standing in for the token boundary.
    const op = text[j];
    let run = 0;
    for (let k = j; k >= 0 && text[k] === op; k--) run++;
    return run % 2 === 0 ? `${op}${op}` : op;
  }
  if (!/\w/.test(text[j])) return text[j];
  // **Bounded.** Slicing from the start of the file to read the word behind the cursor made this
  // O(n²) over a 2 MB tree — the scan took minutes instead of milliseconds. The longest keyword that
  // can precede a regex is `instanceof`; sixteen characters is more than the grammar needs.
  let k = j;
  while (k >= 0 && j - k < 16 && /\w/.test(text[k])) k--;
  return text.slice(k + 1, j + 1);
}

/**
 * Every literal in `text`, as `[start, end)` spans — **the one walk**.
 *
 * `maskLiterals` (a set of covered positions), `stringRanges` (the same spans as an array) and
 * `maskStringContents` (a length-preserving blanked copy) were three functions in two files running
 * this identical loop. They are views now, not walks. Three views of one answer can disagree only
 * about presentation; three walks can disagree about the grammar, and two of them did.
 */
/**
 * `source` with every literal's INTERIOR blanked, delimiters and length kept — a view of
 * `literalSpans`.
 *
 * Lived in `result-vocabulary.mjs`, which cannot be imported from here (this is the base module).
 * It is used by anything that has to balance brackets on a copy where a `{` inside a string or a
 * regex is not a bracket, so it belongs where every reader can reach it.
 *
 * **The length is the contract** — a span found on the copy indexes the original exactly. A newline
 * inside a template literal survives so line structure does.
 */
export function maskLiteralContents(source) {
  let out = "";
  let at = 0;
  for (const [start, end] of literalSpans(source)) {
    out += source.slice(at, start);
    out += source[start];
    for (let j = start + 1; j < end - 1; j++) out += source[j] === "\n" ? "\n" : " ";
    if (end - 1 > start) out += source[end - 1];
    at = end;
  }
  return out + source.slice(at);
}

/**
 * Does a top-level declaration begin at `at`? `export`-prefixed or not, with any whitespace between.
 */
function declarationStartsAt(text, at) {
  DECLARATION.lastIndex = at;
  return DECLARATION.test(text);
}
const DECLARATION = /(?:export\s+)?(?:type|interface|const|function|class)\b/y;

export function literalSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") {
      i = walkTemplate(text, i, spans) - 1;
      continue;
    }
    const end = literalEnd(text, i, significantBefore(text, i));
    if (end === -1) continue;
    spans.push([i, end]);
    i = end - 1;
  }
  return spans;
}

/**
 * A template literal's TEXT chunks, with its `${…}` interpolations left as code.
 *
 * **`literalEnd` and this function answer different questions, on purpose.** `literalEnd` answers
 * "where does the literal token starting here end", which is what a scanner stepping over tokens
 * needs. `literalSpans` answers "which regions of this text are not code", and the inside of a
 * `${…}` IS code — a producer written there is as real as one written anywhere else. Treating the
 * whole template as quoted prose made `` `${probeAim("act.route", { route: "x" })}` `` invisible to
 * the road axis, with no road and no problem reported (gate 2 on #679, round 2). The window this PR
 * removed found that call, because a window does not know what a literal is; the mask that replaced
 * it knew too much.
 *
 * Each chunk keeps a real delimiter at both ends — the backtick or the `{` of `${`, and the `}` or
 * the closing backtick — so a copy with the interiors blanked still balances its braces.
 *
 * Returns the index just past the closing backtick.
 */
function walkTemplate(text, start, spans) {
  let chunkStart = start;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      spans.push([chunkStart, i + 1]);
      return i + 1;
    }
    if (ch === "$" && text[i + 1] === "{") {
      spans.push([chunkStart, i + 2]);
      const close = walkInterpolation(text, i + 2, spans);
      chunkStart = close;
      i = close + 1;
      continue;
    }
    i++;
  }
  // Unterminated: say the rest is text rather than guess where it ends. An empty span is not
  // pushed — `maskLiteralContents` reads `source[start]` as a delimiter, and a start at the end of
  // the input gave it `undefined`, which it appended to the mask as the word "undefined" and broke
  // the length contract in silence (seen while measuring round 3's finding).
  if (chunkStart < text.length) spans.push([chunkStart, text.length]);
  return text.length;
}

/** From just past a `${`, the index of its matching `}`, collecting the literals inside on the way. */
function walkInterpolation(text, from, spans) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "`") {
      i = walkTemplate(text, i, spans) - 1;
      continue;
    }
    const end = literalEnd(text, i, significantBefore(text, i));
    if (end !== -1) {
      spans.push([i, end]);
      i = end - 1;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return text.length;
}

/** The body of the brace-delimited block that starts at the first `{` at or after `from`. */
export function blockAt(text, from) {
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
 * ## The depth-1 reader, down here for the same reason the literal reader is
 *
 * "Is this property THIS object's, or one nested inside it?" is a grammar question, and it was
 * answerable only in `code-vocabulary.mjs` — which imports from here, so the road axis could not
 * ask it. That is why the road axis read `route:` out of a fixed-length window instead: not because
 * a window is the right tool, but because it was the only one in reach.
 *
 * Moved, unchanged, so there is one answer rather than a fourth copy of the question.
 */

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
 * Every quoted member of `export type <name> = …;`, expanding template members.
 *
 * `problems` (optional) collects members this parser cannot read — a template whose named union it
 * cannot resolve, a backticked member with no interpolation, a `typeof ARR[number]`. **Without it
 * the union simply comes back shorter**, and a shorter set is indistinguishable from a complete one
 * (gate 2 on #669).
 */
export function readUnion(source, name, resolve = () => [], problems = []) {
  const text = stripComments(source);
  const m = text.match(new RegExp(`export type ${quoteForRegExp(name)}\\s*=([\\s\\S]*?);`));
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
  const start = text.search(new RegExp(`export type ${quoteForRegExp(typeName)}\\b`));
  if (start === -1) {
    problems.push(`${typeName} not found — the ${field} union it carries is not being read`);
    return [];
  }
  // To the declaration's terminating `;` **at brace depth 0**. Two cuts were wrong before this
  // one: the first blank line (comment-stripping leaves blanks inside a type) and the first `;`
  // (a member object separates its own fields with `;`). Both read part of a union as the whole.
  // **The depth is counted on the mask, because a brace inside a literal is not a brace.** This
  // scan read `text` directly, so a literal type whose value carries one threw the count off:
  //
  //     export type T = { why: "a" | "{tool:x}" };   →  ["a"], problems: []   ← a value gone, silent
  //     export type T = { why: "a" | "}" };          →  ["a", "not_mine"]     ← the next type's, loud
  //
  // This tree's advice strings are full of `{tool:…}`, so the shape is not exotic here. Found on a
  // re-read of this function AFTER five review rounds, none of which reached it — they were anchored
  // on the lines this branch changed, and this one sits two lines above them.
  const masked = maskLiteralContents(text);
  let depth = 0;
  let end = -1;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
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
    //
    // **Anchored, because the whitespace between two tokens has no length.** That test was a
    // thirty-nine character slice, and the grounds recorded for the bound were "the longest spelling
    // is `export interface`, sixteen characters" — which measures the longest MINIMAL spelling, not
    // the longest legal one. TypeScript allows any amount of whitespace between `export` and `type`,
    // so thirty spaces walk the window out, this type never ends, and every `why:` in the type BELOW
    // it joins the axis. `problems` stays empty, because the next declaration's `;` is found at
    // depth 0 and the "read to the end of the file" guard never fires. Measured at the arithmetic
    // edge: 29 spaces reads two values, 30 reads three (win2 found the misclassification; mac had
    // put this window in the "guaranteed by the grammar" column).
    else if (depth === 0 && ch === "\n" && declarationStartsAt(masked, i + 1)) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    problems.push(`${typeName} has no terminating \`;\` and nothing follows it — the ${field} union was read to the end of the file`);
    end = text.length;
  }
  const body = text.slice(start, end);
  const maskedBody = masked.slice(start, end);
  // A type can carry the field more than once — `PointOwner` has a `why` on two of its members,
  // and reading only the first gives one value where the vocabulary has four.
  const values = [];
  let seen = false;
  // **Not `[^;\n]*`.** A union grows past the line limit by breaking onto continuation lines —
  // which is how a union usually grows — and stopping at the newline read one member of however
  // many (gate 2 on #669, second pass). Run to the field's own terminator instead: a `;`, a brace,
  // or the next `name:` field on the same object.
  //
  // **The terminator is found on the MASK, and the values are read from the real text at its
  // offsets.** `[^;{}]` on the raw body stops at a brace inside a LITERAL: `why: "a" | "{tool:x}"`
  // ended at the `{` and the second member was dropped with `problems` empty. The same defect as
  // the depth count above, one layer in — the one that survived fixing the other.
  for (const m of maskedBody.matchAll(new RegExp(`\\b${quoteForRegExp(field)}:\\s*([^;{}]*)`, "g"))) {
    seen = true;
    const from = m.index + m[0].length - m[1].length;
    const real = body.slice(from, from + m[1].length);
    const value = real.split(/,\s*\w+\s*:/)[0];
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
  // The same text with every literal's interior blanked, at the same indices. Anything that has to
  // find punctuation — a brace that opens an object, a `probeAim(` that is a call rather than a
  // sentence quoting one — asks this copy, and reads the value back out of `text`.
  const masked = maskLiteralContents(text);
  const problems = [];
  // **`probeRoute`'s own body, found from its parameter list — not the first block that happens to
  // contain the position.** The first version walked up to eight `{…}` candidates after the
  // `function` keyword until one spanned the call, which reads past the helper entirely: a direct
  // `probeAim("act.route", { route })` in a LATER function landed inside that function's block, the
  // walk accepted it, and the shorthand exemption then swallowed a dynamic producer with neither a
  // road nor a problem (gate 2 on #679, round 4). Eight was also one more arbitrary bound in a PR
  // about removing them.
  //
  // The body is the first `{` after the parameter list's closing `)`. A return-type annotation can
  // carry braces of its own (`): { a: string } {`), and this reader cannot tell that `{` from the
  // body's — so when the text between the two holds a `<` or a `{` it says so and exempts nothing,
  // which is the loud direction.
  const helperAt = text.search(/\bfunction\s+probeRoute\s*\(/);
  const helperBody = (() => {
    if (helperAt === -1) return null;
    const open = masked.indexOf("(", helperAt);
    if (open === -1) return null;
    let depth = 0;
    let i = open;
    for (; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;
    const brace = masked.indexOf("{", i);
    if (brace === -1) return null;
    // **Is a block after the parameter list the BODY, or part of an object return type?** Told apart
    // by what follows it: a type CONTINUES, and a body does not. `): { ok } {` continues with
    // another brace; `): Promise<{ ok }> {` with `>`; `): { ok } | null {` with `|`. Only checking
    // for an immediately following `{` took the type literal as the body in the wrapped forms, and
    // the helper's own forwarding call was then reported — loud, and wrong (gate 2 on #679, round 5).
    //
    // The continuation has to START with a type character, not merely contain one: after a real
    // body, `}\nexport { probeRoute };` also has an identifier and then a brace, and matching that
    // would walk out of the function into the export.
    let block = blockAt(text, brace);
    for (;;) {
      if (block === null) return null;
      const rest = masked.slice(block.end + 1);
      const continues = /^\s*\{/.test(rest) || /^\s*[>|&[\],.][\s\w>|&[\],.]*\{/.test(rest);
      if (!continues) return block;
      const next = rest.indexOf("{");
      block = blockAt(text, block.end + 1 + next);
    }
  })();
  const insideProbeRoute = (at) => helperBody !== null && at > helperBody.start && at < helperBody.end;
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
  // **The object is read, not windowed.** This was `\{[\s\S]{0,400}?\broute:` — four hundred
  // characters from the brace to the key, and a road written past that simply leaves the axis, with
  // `problems` empty. Measured at the edge: the road survives a gap of 400 and is gone at 401, the
  // gate's output byte-identical on both sides.
  //
  // Reading it properly needs two things the road module did not have until #678 and this PR: a
  // literal reader (so a `{` inside a string is not a brace) and a depth-1 reader (so a `route:`
  // nested in some other property is not this call's road). It has both now, and the window is
  // simply gone — an object of any size is read, and a shape that CANNOT be read says so.
  for (const m of text.matchAll(/\bprobeAim\(\s*"act\.route"\s*,\s*(?=\{)/g)) {
    // **Matched on the text, checked against the mask.** The mask blanks a literal's CONTENTS, so
    // `"act.route"` is not there to match — searching the masked copy for this call finds nothing at
    // all, which is the shape of a rule that matches nothing while looking like a rule. What the
    // mask answers is the other question: is this occurrence CODE, or a sentence quoting it? Prose
    // in this tree does quote the shapes it describes (gate 2 on #669), and inside a literal the
    // characters are blanked, so they differ from `text` here.
    if (!masked.startsWith("probeAim", m.index)) continue;
    const obj = blockAt(text, m.index + m[0].length);
    if (obj === null) {
      problems.push(`probeAim("act.route", …) at ${m.index} has an object this parser cannot balance — its road is unknown, not absent`);
      continue;
    }
    // **`probeRoute`'s own forwarding call, recognised by WHERE it is, not by what it is called.**
    // The helper's body ends with `probeAim("act.route", { route, … })`, forwarding the parameter it
    // was given — so this site names no road, and the roads that reach it are exactly the literals
    // the `probeRoute("…")` rule above already reads. Reporting it would make the gate red on
    // arrival about a producer that is fully enumerated one rule up.
    //
    // The test is containment in `probeRoute`'s block, because this file has been bitten by the
    // other kind: its first version exempted an argument that was NAMED `route`, and gate 2 on #669
    // called that an exemption whose only effect was to open a hole named after the field it
    // guarded. A shorthand ANYWHERE ELSE is still reported.
    if (insideProbeRoute(m.index) && isShorthandAtDepthOne(obj.body, "route")) continue;
    const value = fieldAtDepthOne(obj.body, "route");
    if (value === null) {
      problems.push(`probeAim("act.route", …) at ${m.index} carries no \`route\` of its own — a nested one is not this call's road`);
      continue;
    }
    const literal = value.trim().match(/^"([a-z0-9_]+)"$/);
    if (literal) route.add(literal[1]);
    else problems.push(`probeAim("act.route", …) is given a non-literal road: ${value.trim().slice(0, 60)}`);
  }

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
