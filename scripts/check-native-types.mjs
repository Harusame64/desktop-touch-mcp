#!/usr/bin/env node
// Detect drift between Rust `#[napi]` exports (under src/) and the manually
// maintained `index.d.ts`. The `npm run build:rs` workflow restores the
// hand-written index.d.ts after each build, so a Rust developer who adds a
// new `#[napi]` without updating index.d.ts gets no compile error — TS
// imports from `../../index.js` opaquely. This guard plugs that gap.
//
// Scope today: scan source for `#[napi] pub fn <name>` and confirm a
// corresponding `export declare function <name>` exists in index.d.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath` decodes percent-encoded URL segments (paths with spaces or
// non-ASCII characters) and normalises Windows drive prefixes — both of
// which `new URL(...).pathname` mangles.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(ROOT, "src");
const INDEX_DTS = join(ROOT, "index.d.ts");

// Source subtrees whose entire module is feature-gated at the `mod`
// declaration level (so individual `#[napi]` functions inside have no
// per-fn `#[cfg(...)]` attribute even though they only compile when the
// feature is on). Exports in these dirs are intentionally absent from the
// always-on index.d.ts and are accessed at runtime via interface probes
// in src/engine/native-engine.ts (e.g. NativeVision).
const FEATURE_GATED_DIRS = [
  // src/vision_backend/ — `#[cfg(feature = "vision-gpu")] pub mod vision_backend;`
  // declared at src/lib.rs.
  join(SRC_DIR, "vision_backend"),
];

/** Recursively collect *.rs files under `dir`, skipping feature-gated subtrees. */
function rsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (FEATURE_GATED_DIRS.some((g) => p === g || p.startsWith(g + sep))) {
      continue;
    }
    const st = statSync(p);
    if (st.isDirectory()) out.push(...rsFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** snake_case → camelCase (matches napi-rs default rename). */
function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

const rustExports = new Set();

for (const file of rsFiles(SRC_DIR)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[napi\]\s*$/.test(lines[i])) continue;

    // Walk backward over preceding attrs/comments to detect a `#[cfg(...)]`
    // gate (e.g. `#[cfg(feature = "vision-gpu")]`). Feature-gated exports
    // are intentionally absent from the always-on index.d.ts surface; they
    // are checked at runtime via NativeVision / NativeWin32 interface
    // probes in src/engine/native-engine.ts.
    let isFeatureGated = false;
    for (let k = i - 1; k >= 0; k--) {
      const t = lines[k].trim();
      if (t === "" || t.startsWith("//")) continue;
      if (t.startsWith("#[cfg(")) {
        isFeatureGated = true;
        break;
      }
      if (t.startsWith("#[")) continue; // unrelated attribute, keep scanning
      break;
    }
    if (isFeatureGated) continue;

    // Skip the rest of the attribute/comment block to reach the fn line.
    // Blank lines must be skipped too — without that, a blank between
    // `#[napi]` and `pub fn` would zero out `sig` and the export would
    // be missed from `rustExports`, weakening the drift check (Codex
    // review on PR #74).
    let j = i + 1;
    while (j < lines.length && /^(\s*$|\s*(#\[|\/\/))/.test(lines[j])) j++;
    const sig = lines[j] ?? "";

    // Free functions only — struct methods (`pub fn xxx(&self, ...)` or
    // `&mut self`) are exposed as napi class methods, not free exports.
    if (/\bpub\s+fn\s+\w+\s*\(\s*&(?:mut\s+)?self\b/.test(sig)) continue;

    const m = sig.match(/\bpub\s+fn\s+(\w+)/);
    if (m) rustExports.add(snakeToCamel(m[1]));
  }
}

const dts = readFileSync(INDEX_DTS, "utf8");
const dtsExports = new Set(
  Array.from(dts.matchAll(/^export declare function (\w+)\s*\(/gm), (m) => m[1]),
);

const missing = [...rustExports].filter((n) => !dtsExports.has(n));
const stale = [...dtsExports].filter((n) => !rustExports.has(n));

let failed = false;
if (missing.length > 0) {
  failed = true;
  console.error("\n[check-native-types] FAIL — Rust #[napi] exports missing from index.d.ts:\n");
  for (const n of missing) console.error(`  - ${n}`);
}
if (stale.length > 0) {
  // Stale entries are a soft warning (index.d.ts may declare hand-written
  // types whose Rust source lives in a build-feature-gated module). Report
  // but don't fail.
  console.warn("\n[check-native-types] warn — index.d.ts entries with no matching Rust export (may be feature-gated):\n");
  for (const n of stale) console.warn(`  - ${n}`);
}

// ── index.d.ts ⇄ index.js parity ────────────────────────────────────────────
//
// The two files are hand-maintained in lockstep and `npm run build:rs`
// restores both, so nothing forces them to agree. A name declared in
// index.d.ts but never re-exported from index.js type-checks perfectly and
// then fails at MODULE LINK time for any consumer writing
// `import { thatName } from "./index.js"` — the native binding exists, the
// wrapper simply never surfaced it. The reverse (exported, undeclared) hands
// TS consumers an untyped export. Both directions are drift, so both fail.
//
// Declarations are matched for functions AND classes: `DirtyRectSubscription`
// is a class, and matching functions alone would report it as a phantom
// index.js-only export.
//
// Relationship to the `stale` set above, so the two rules cannot contradict
// each other: `stale` names are declared in index.d.ts with no matching Rust
// export, which is only a soft warning because they may be feature-gated. It
// would be incoherent to soft-warn that a declaration might not correspond to
// anything and simultaneously hard-fail because index.js does not re-export
// it, so `stale` names are excluded from the missing-in-index.js check. They
// are still checked in the other direction.
const INDEX_JS = join(ROOT, "index.js");
const js = readFileSync(INDEX_JS, "utf8");

// Export forms this parser understands. Anything else is reported rather than
// silently skipped: an unparsed `export` line would drop a name out of BOTH
// sets and read as parity while proving nothing.
//   index.d.ts — `export declare function|class` are the runtime surface;
//                `export interface|type` are type-only and have no index.js
//                counterpart by design.
//   index.js   — `export const|function|class` are the named re-exports;
//                `export default` is the whole binding object, not a name.
const DTS_VALUE = /^export declare (?:function|class) (\w+)/;
const DTS_TYPE_ONLY = /^export (?:interface|type) \w+/;
const JS_NAMED = /^export (?:const|function|class) (\w+)/;
const JS_DEFAULT = /^export default\b/;

/** Names captured by `valuePat`, plus any `export` line matching nothing. */
function scanExports(source, valuePat, ignorePat) {
  const names = new Set();
  const unrecognized = [];
  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    if (!/^export\b/.test(line)) continue;
    const m = line.match(valuePat);
    if (m) {
      names.add(m[1]);
      continue;
    }
    if (ignorePat.test(line)) continue;
    unrecognized.push(line.trim());
  }
  return { names, unrecognized };
}

const dtsScan = scanExports(dts, DTS_VALUE, DTS_TYPE_ONLY);
const jsScan = scanExports(js, JS_NAMED, JS_DEFAULT);

for (const [file, scan] of [["index.d.ts", dtsScan], ["index.js", jsScan]]) {
  if (scan.unrecognized.length === 0) continue;
  failed = true;
  console.error(
    `\n[check-native-types] FAIL — unrecognized export form in ${file} — extend the parser:\n`,
  );
  for (const l of scan.unrecognized) console.error(`  ${l}`);
  console.error(
    "\n  This guard compares names it can parse. An export shape it does not" +
      "\n  recognise is invisible to BOTH directions of the parity check, so it" +
      "\n  is failed loudly instead of being skipped.",
  );
}

const dtsDeclared = dtsScan.names;
const jsExported = jsScan.names;
const staleSet = new Set(stale);

const notInJs = [...dtsDeclared].filter((n) => !jsExported.has(n) && !staleSet.has(n));
const notInDts = [...jsExported].filter((n) => !dtsDeclared.has(n));

if (notInJs.length > 0) {
  failed = true;
  console.error(
    "\n[check-native-types] FAIL — declared in index.d.ts but NOT exported from index.js:\n",
  );
  for (const n of notInJs) console.error(`  - ${n}`);
  console.error(
    "\n  A named import of these throws at module link time. Add" +
      "\n  `export const <name> = nativeBinding.<name>;` to index.js.",
  );
}
if (notInDts.length > 0) {
  failed = true;
  console.error(
    "\n[check-native-types] FAIL — exported from index.js but NOT declared in index.d.ts:\n",
  );
  for (const n of notInDts) console.error(`  - ${n}`);
  console.error("\n  TS consumers get an untyped export. Add the declaration to index.d.ts.");
}

if (failed) {
  console.error("\nAdd the missing `export declare function <name>(...)` lines to index.d.ts.");
  console.error("Source of truth for shared types: src/engine/native-types.ts.\n");
  process.exit(1);
}

console.log(
  `[check-native-types] OK — ${rustExports.size} Rust exports all declared in index.d.ts, ` +
    `and all ${dtsDeclared.size} declarations are exported from index.js.`,
);
