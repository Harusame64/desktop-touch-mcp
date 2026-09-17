// ADR-036 — the RESULT axis of the completion grid, read out of the source.
//
// The gate's denominator is "the vocabulary extracted from the code × configuration × result"
// (the user's decision, 2026-09-11). The road axis got its extractor in #669 and the configuration
// axis in #670. This is the third and last.
//
// **What makes this one hard is that the axis has a type for a fifth of itself.** The loop's
// failure arm is `reason: TouchFailReason` — eighteen values, enumerated, compile-checked. But the
// wrapper ABOVE it returns `CompatRawFailureShape`, whose `reason` is a plain `string`, and it does
// not write that string: it COMPUTES it.
//
//     reason: pascalToSnake(ifUnexp.most_likely_cause)
//
// `most_likely_cause` is a PascalCase code looked up in `SUGGESTS`, a `Record<string, string[]>`
// with 94 keys and no union, defaulting to `"Unknown"`. So the reason space a caller can receive is
// the eighteen UNION the image of that conversion over 94 keys, plus `"unknown"` — and only the
// eighteen are typed. Grepping for `reason: "…"` finds the literals and misses all of it, which is
// the same shape as the other two axes: **the value is not written, it is produced**.
//
// **Two rules this file is built on:**
//
// **Do not sweep the field name.** `reason:` is worn by at least three other axes — `_truncation`
// (`ring_underflow` / `capacity_cap`), the lease validator (`expired` / `generation_mismatch` / …)
// and the background-input channel (`chromium` / `uwp_sandboxed` / …). A sweep for the spelling
// merges four axes on a shared word, which is the mistake this whole vocabulary exists to avoid.
// The axis is defined by its PRODUCERS instead: the union, and the conversion.
//
// **Do not re-implement the conversion.** A port of `pascalToSnake` written from its name agrees
// with the real one for 90 of the 94 keys and differs on four: the implementation only splits
// `([a-z])([A-Z])`, so `WorkingMemoryNUpperBoundExceeded` becomes `working_memory_nupper_bound_…`
// and not `…_n_upper_…`. Two implementations that agree most of the time are the worst kind of
// check — so this file extracts the body, pins it, and refuses to compute an image from a
// conversion it has not seen before.

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
  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
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
    problems.push("SUGGESTS could not be read — the computed half of the reason axis is unknown, not empty");
    return [];
  }
  // Keys at the table's own indent. A nested object's keys sit deeper and are advice, not codes.
  const keys = [...body.matchAll(/^ {2}"?([A-Za-z_][\w]*)"?\s*:/gm)].map((m) => m[1]);
  if (keys.length === 0) problems.push("SUGGESTS has no keys at its own indent — has the table been reshaped?");
  return [...new Set(keys)].sort();
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
    const m = line.match(/"\s{2}([a-z_][a-z0-9_ /]*?)\s*(?:→|->)/);
    if (!m) continue;
    for (const name of m[1].split("/")) {
      const t = name.trim();
      if (t !== "") names.add(t);
    }
  }
  return [...names].sort();
}
