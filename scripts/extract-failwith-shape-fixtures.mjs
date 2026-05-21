#!/usr/bin/env node
// ADR-021 Phase 2 PR-P2-2 — codemod fixture extractor (Plan §3.3.2 PR-P2-2).
//
// Statically scans every `failWith(...)` callsite under src/tools/** and emits a
// representative, deterministic catalogue of their argument SHAPES to
// tests/fixtures/failwith-callsite-shapes.json. Two consumers:
//
//   1. CI gate `npm run check:failwith-fixtures` regenerates this file and
//      `git diff --exit-code`s it (same idiom as check:stub-catalog). A callsite
//      added/removed/reshaped without regenerating fails CI — so the catalogue
//      can never silently drift from source.
//   2. The PR-P2-2 unit test asserts the set of context-SHAPES discovered here is
//      a subset of the shapes its frozen-golden matrix pins, making the sampling
//      exhaustive-over-shapes (a novel shape fails the test until a golden is
//      added). This is how "176 callsites bit-equal" is replaced by
//      "representative matrix + codemod-driven sampling" (plan §2.2 / §2.1.1).
//
// The extractor does NOT evaluate callsite arguments (they reference locals);
// it captures the static shape. Bit-equality of the runtime output is pinned by
// the frozen golden in failwith-thin-wrapper.test.ts, not here.
//
// Sampling is reproducible: a seeded PRNG (default seed MIGRATION_FIXTURE_SEED =
// "2026-05-19") shuffles each tool bucket, then we take >= 2 per bucket and top
// up across buckets until the sample is > 10% of all callsites.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLS_DIR = join(ROOT, "src", "tools");
const OUT_FILE = join(ROOT, "tests", "fixtures", "failwith-callsite-shapes.json");
const SEED = process.env.MIGRATION_FIXTURE_SEED ?? "2026-05-19";
const ROOT_HOISTED_KEYS = new Set(["_perceptionForPost", "_richForPost", "hints"]);

// ── source scanning (string / template / comment aware) ───────────────────────

/** Collect *.ts files under dir (skips *.test.ts and .d.ts). */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * Read the argument list of a call whose '(' is at `open`. Returns the trimmed
 * top-level argument source strings and the index just past the matching ')'.
 * String / template-literal / comment aware so commas and parens inside them do
 * not confuse the split.
 */
function readArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = "";
  let i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    // comments
    if (c === "/" && c2 === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++; // land on '/'
      continue;
    }
    // strings + template literals
    if (c === '"' || c === "'" || c === "`") {
      const { text, end } = readString(src, i);
      cur += text;
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      if (depth === 1) continue; // opening '(' of failWith — don't record
      cur += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        // closing ')' of the call
        if (cur.trim().length > 0) args.push(cur.trim());
        return { args, end: i + 1 };
      }
      cur += c;
      continue;
    }
    if (c === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  return { args: null, end: i }; // unbalanced (should not happen)
}

/** Read a string/template literal starting at `i`; returns its source + end index. */
function readString(src, i) {
  const quote = src[i];
  let out = quote;
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    out += c;
    if (c === "\\") {
      out += src[j + 1] ?? "";
      j++;
      continue;
    }
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      // template expression — recurse on the braced region
      let depth = 1;
      out += "{";
      j += 2;
      for (; j < src.length && depth > 0; j++) {
        const d = src[j];
        if (d === "{") depth++;
        else if (d === "}") depth--;
        if (depth === 0) {
          out += "}";
          break;
        }
        out += d;
      }
      continue;
    }
    if (c === quote) return { text: out, end: j };
  }
  return { text: out, end: j };
}

/** Top-level keys of an object-literal source `{ ... }` (string/comment aware). */
function topLevelKeys(objSrc) {
  const inner = objSrc.slice(objSrc.indexOf("{") + 1, objSrc.lastIndexOf("}"));
  const keys = [];
  let depth = 0;
  let i = 0;
  let atKeyPos = true; // we're at a position where a key could begin
  for (; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      const { text, end } = readString(inner, i);
      if (depth === 0 && atKeyPos) {
        // quoted key — peek for ':'
        let k = end + 1;
        while (k < inner.length && /\s/.test(inner[k])) k++;
        if (inner[k] === ":") keys.push(text.slice(1, -1));
      }
      i = end;
      atKeyPos = false;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      atKeyPos = false;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      continue;
    }
    if (c === "," && depth === 0) {
      atKeyPos = true;
      continue;
    }
    if (depth === 0 && atKeyPos && /[A-Za-z_$]/.test(c)) {
      let id = c;
      let k = i + 1;
      while (k < inner.length && /[A-Za-z0-9_$]/.test(inner[k])) id += inner[k++];
      let p = k;
      while (p < inner.length && /\s/.test(inner[p])) p++;
      if (inner[p] === ":") keys.push(id); // `key:` — skip shorthand / `...spread`
      i = k - 1;
      atKeyPos = false;
      continue;
    }
    if (!/\s/.test(c)) atKeyPos = false;
  }
  return keys;
}

function classifyErrArg(arg) {
  if (/^new\s+Error\b/.test(arg)) return "new-error";
  if (/^['"`]/.test(arg)) return "string-literal";
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) return "identifier";
  if (/[.[]/.test(arg) && !/[(]/.test(arg)) return "member";
  return "expression";
}

function classifyContextArg(arg) {
  if (arg === undefined) return "none";
  if (arg.startsWith("{")) {
    const keys = topLevelKeys(arg);
    return keys.some((k) => ROOT_HOISTED_KEYS.has(k)) ? "object-hoisted" : "object-plain";
  }
  return "dynamic";
}

/** Unquote a simple string-literal 2nd arg into the tool name; else null. */
function toolNameOf(arg) {
  const m = arg && arg.match(/^(['"`])(.*)\1$/s);
  return m ? m[2] : null;
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// ── deterministic PRNG (mulberry32 seeded from the seed string) ───────────────

function hashSeed(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── main ──────────────────────────────────────────────────────────────────────

const callsites = [];
const reCall = /\bfailWith\s*\(/g;
for (const file of tsFiles(TOOLS_DIR).sort()) {
  // `_errors.ts` DEFINES failWith (+ its own doc/test references); skip the module.
  if (file.endsWith(`${sep}_errors.ts`)) continue;
  const src = readFileSync(file, "utf8");
  reCall.lastIndex = 0;
  let m;
  while ((m = reCall.exec(src))) {
    const open = m.index + m[0].length - 1;
    const { args, end } = readArgs(src, open);
    if (!args) continue;
    reCall.lastIndex = end;
    const tool = toolNameOf(args[1]) ?? "(dynamic)";
    callsites.push({
      file: relative(ROOT, file).split(sep).join("/"),
      line: lineAt(src, m.index),
      tool,
      errKind: classifyErrArg(args[0] ?? ""),
      contextShape: classifyContextArg(args[2]),
    });
  }
}

callsites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

// bucket by tool
const buckets = new Map();
for (const cs of callsites) {
  if (!buckets.has(cs.tool)) buckets.set(cs.tool, []);
  buckets.get(cs.tool).push(cs);
}

// deterministic sampling: >=2 per bucket, then top up to > 10% overall
const rng = mulberry32(hashSeed(SEED));
const target = Math.floor(callsites.length * 0.1) + 1;
const sampled = [];
const remainder = [];
for (const tool of [...buckets.keys()].sort()) {
  const shuffled = seededShuffle(buckets.get(tool), rng);
  const take = Math.min(2, shuffled.length);
  sampled.push(...shuffled.slice(0, take));
  remainder.push(...shuffled.slice(take));
}
const remShuffled = seededShuffle(remainder, rng);
let ri = 0;
while (sampled.length < target && ri < remShuffled.length) sampled.push(remShuffled[ri++]);
sampled.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const fixture = {
  $note:
    "GENERATED by scripts/extract-failwith-shape-fixtures.mjs — do not edit by hand. " +
    "Regenerate via `npm run check:failwith-fixtures` (ADR-021 PR-P2-2).",
  seed: SEED,
  totalCallsites: callsites.length,
  sampleCount: sampled.length,
  buckets: Object.fromEntries([...buckets.keys()].sort().map((t) => [t, buckets.get(t).length])),
  contextShapes: [...new Set(callsites.map((c) => c.contextShape))].sort(),
  errKinds: [...new Set(callsites.map((c) => c.errKind))].sort(),
  samples: sampled,
};

writeFileSync(OUT_FILE, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(
  `[extract-failwith-shape-fixtures] ${callsites.length} callsites across ${buckets.size} tools → ` +
    `${sampled.length} sampled (>${target - 1} = 10%), shapes: ${fixture.contextShapes.join(", ")}`,
);
