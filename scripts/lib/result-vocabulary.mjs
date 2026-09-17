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
// So this file reads the PRODUCERS, the way the road axis reads `probeRoute` call sites:
//
//  1. every class that reaches `HandlerError` by inheritance, and the literal `this.name` it sets —
//     anything NOT in that family is wrapped by `toResultErr` and arrives as `HandlerError`;
//  2. `HandlerError` itself, which is how every ordinary throw reaches the caller;
//  3. the literal codes handed to `new CodedHandlerError(...)`, whose constructor assigns
//     `this.name = code`;
//  4. the values of `LEASE_REASON_TO_TYPED_CODE`, which reach that constructor through a variable;
//  5. the `if_unexpected` fallback, for an envelope that carries none.
//
// `SUGGESTS` is still read — but as a COVERAGE check. A produced name that is not one of its keys
// reaches the caller with generic advice, and five do today.
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
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let j = i; j < end; j++) if (text[j] === "\n") out += "\n";
      i = end;
      continue;
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
  for (const { file, text: raw } of sources) {
    const text = stripComments(raw);
    for (const m of text.matchAll(/\bclass\s+(\w+)\s+extends\s+(\w+)/g)) {
      const body = text.slice(m.index, m.index + 900);
      extendsOf.set(m[1], m[2]);
      const literal = body.match(/this\.name\s*=\s*"([^"]+)"/);
      if (literal) {
        nameOf.set(m[1], literal[1]);
        continue;
      }
      const dynamic = body.match(/this\.name\s*=\s*([A-Za-z_][\w.]*)\s*;/);
      // `CodedHandlerError` is the recognised dynamic one; its codes are read at the call sites.
      if (!dynamic) continue;
      // `CodedHandlerError` assigns its `code` parameter and the codes are read at its call sites.
      if (m[1] === "CodedHandlerError" && dynamic[1] === "code") continue;
      // Anything else is pinned as an UNRESOLVABLE producer or reported. The exemption is a
      // written-down list, never a pattern (#670) — and a producer on it does not disappear: it
      // makes the axis a lower bound, and the summary says so.
      if (resolved.includes(`${m[1]}:${dynamic[1]}`)) continue;
      problems.push(`${file}: ${m[1]} sets this.name from \`${dynamic[1]}\`, a value this parser cannot enumerate`);
    }
  }
  const inFamily = (name) => {
    let cur = name;
    for (let hops = 0; hops < 30; hops++) {
      const parent = extendsOf.get(cur);
      if (parent === undefined) return false;
      if (parent === "HandlerError") return true;
      cur = parent;
    }
    problems.push(`the class hierarchy above ${name} does not terminate — the reason axis cannot be derived`);
    return false;
  };
  const names = new Set(["HandlerError"]);
  for (const [cls, parent] of extendsOf) {
    if (parent === "HandlerError" || inFamily(cls)) {
      const literal = nameOf.get(cls);
      if (literal !== undefined) names.add(literal);
    }
  }
  return [...names].sort();
}

/** The literal codes handed to `new CodedHandlerError(...)`, whose constructor makes them the name. */
export function readCodedNames(sources, problems = [], resolved = []) {
  const names = new Set();
  for (const { file, text: raw } of sources) {
    const text = stripComments(raw);
    for (const m of text.matchAll(/new CodedHandlerError\(\s*([^),]*)/g)) {
      const arg = m[1].trim();
      const literal = arg.match(/^"([A-Za-z_][\w]*)"$/);
      if (literal) {
        names.add(literal[1]);
        continue;
      }
      // A code held in a variable. Its value space is read from the table it comes from, named in
      // the fixture — the exemption is a written-down list, not a pattern (#670).
      if (resolved.includes(`${file}:${arg}`)) continue;
      problems.push(`${file}: a coded failure takes its name from \`${arg}\`, a value this parser cannot enumerate`);
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
    const m = line.match(/"\s{2}([a-z_][a-z0-9_ /()='=]*?)\s*→/);
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
