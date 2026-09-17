#!/usr/bin/env node
// Detect drift between Rust `#[napi]` exports (under src/) and the manually
// maintained `index.d.ts`. The `npm run build:rs` workflow restores the
// hand-written index.d.ts after each build, so a Rust developer who adds a
// new `#[napi]` without updating index.d.ts gets no compile error — TS
// imports from `../../index.js` opaquely. This guard plugs that gap.
//
// Scope: (1) scan source for `#[napi] pub fn <name>` and confirm a
// corresponding `export declare function <name>` exists in index.d.ts;
// (2) index.d.ts ⇄ index.js parity for those names; (3) `#[napi(object)]`
// struct FIELDS against index.d.ts and src/engine/native-types.ts — names
// and optionality, never types. A `bigint` declared as `number` passes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseNapiFunctions,
  parseNapiObjectStructs,
  parseTsFunctionParams,
  parseTsInterfaces,
} from "./lib/napi-shapes.mjs";

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

const rustExports = new Set();
const debugOnlyExports = new Set();
const rustFunctions = new Map();
const scanProblems = [];

for (const file of rsFiles(SRC_DIR)) {
  const rel = file.slice(ROOT.length).split(sep).join("/");
  const { functions, problems } = parseNapiFunctions(readFileSync(file, "utf8"), rel);
  scanProblems.push(...problems);
  for (const [name, def] of functions) {
    rustExports.add(name);
    if (def.debugOnly) debugOnlyExports.add(name);
    rustFunctions.set(name, def);
  }
}

const dts = readFileSync(INDEX_DTS, "utf8");
const dtsExports = new Set(
  Array.from(dts.matchAll(/^export declare function (\w+)\s*\(/gm), (m) => m[1]),
);

// Deliberately off the published surface. `native-engine.ts` reaches these through the raw napi
// binding (the default export) rather than the named re-exports, so they are callable from TS
// without `index.d.ts` describing them — which is the point: a debug-only panic trigger has no
// business in the typings a consumer reads.
const EXPORT_EXEMPT = new Set(["l1TestForcePanic"]);

// **The exemption is spent only where its reason holds.** Delete the `#[cfg(debug_assertions)]`
// above `l1_test_force_panic` and it compiles into release builds — at which point it is an
// ordinary undeclared export and this check says so, instead of staying quiet on the strength of a
// sentence about a gate it never read (gate 2, second pass).
const exempt = (n) => EXPORT_EXEMPT.has(n) && debugOnlyExports.has(n);

const missing = [...rustExports].filter((n) => !dtsExports.has(n) && !exempt(n));
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

// ── `#[napi(object)]` struct shapes ⇄ the two TS declarations ───────────────
//
// Everything above compares FUNCTIONS. The shapes those functions return are mirrored by hand in
// two more places — `index.d.ts` (published with the release artifact) and
// `src/engine/native-types.ts` (the internal source of truth) — and until this section nothing
// compared a single FIELD. #667 paid for that gap directly: `src/uia/types.rs` gained
// `native_window_handle_read`, `native-types.ts` followed, `index.d.ts` did not, and every check
// was green.
//
// **What is compared: field NAMES and OPTIONALITY. Not types.** A `bigint` declared as `number`
// passes here, and the OK line says so rather than claiming the shapes "agree" (gate 2 on #668:
// the word asserted more than the code checks).
//
// **Optionality is checked in ONE direction, and the asymmetry is the point.** napi OMITS the key
// for `Option::None` (index.d.ts documents this on `NativeFocusedElementWithWallclock.focused`),
// so a Rust `Option<T>` declared non-optional in TS promises a key that can be absent. The reverse
// — required in Rust, `?` in TS — is DELIBERATE: it is how an addon built before a field expresses
// that it does not send it (#667, and measured on 2026-09-17: the v1.16.0 addon carries no such
// key at all). Flattening the two would rebuild, in this guard, the collapse that PR removed from
// the product.
//
// **Known limit, carried in `internal#119`**: a field kept in TS as `field?:` for older addons
// AFTER its Rust counterpart is removed fails the reverse check below. Nothing in the tree is in
// that state today; when one is, it needs a reason written next to it, not a looser rule.
//
// The parsing lives in `lib/napi-shapes.mjs` so it can be fed spellings this repo does not contain
// yet, and everything it cannot read arrives here as a problem rather than as a smaller count.
// Shapes `native-types.ts` deliberately does not mirror, with the place they live instead.
const NATIVE_TYPES_ABSENT = new Set([
  // Declared in `src/engine/native-engine.ts`, next to the only function that returns it.
  "NativeUiaEvidence",
]);

const STRUCT_EXEMPT = new Set([
  // Empty today. An entry here needs a reason: a struct that no TS consumer ever receives, not a
  // struct someone did not get round to declaring.
]);

const shapeProblems = [];
const rustStructs = new Map();
for (const file of rsFiles(SRC_DIR)) {
  // **`/` on both machines.** win2 reads these lines on Windows, where `sep` is `\\`, and a
  // finding line that cannot be compared byte for byte between the two records is a record that
  // cannot be diffed (win2, 2026-09-17).
  const rel = file.slice(ROOT.length).split(sep).join("/");
  const { structs, problems } = parseNapiObjectStructs(readFileSync(file, "utf8"), rel);
  shapeProblems.push(...problems);
  for (const [name, def] of structs) {
    const clash = rustStructs.get(name);
    if (clash) {
      shapeProblems.push(`${def.at}: \`${name}\` is also declared at ${clash.at} — two structs cannot share one JS name`);
      continue;
    }
    rustStructs.set(name, def);
  }
}

const TS_SHAPE_FILES = [["index.d.ts", dts]];
try {
  TS_SHAPE_FILES.push([
    "src/engine/native-types.ts",
    readFileSync(join(SRC_DIR, "engine", "native-types.ts"), "utf8"),
  ]);
} catch (e) {
  // Its own diagnostic, not a node traceback out of the top level: this runs in CI
  // (`.github/workflows/ci.yml`), where a stack trace reads as a broken runner rather than as a
  // moved file.
  shapeProblems.push(`src/engine/native-types.ts could not be read: ${e.message}`);
}

const tsFunctionParams = parseTsFunctionParams(dts);
const argumentOnly = new Set();
let comparedFields = 0;
const pairedPerFile = new Map();
for (const [label, source] of TS_SHAPE_FILES) {
  const { interfaces, problems } = parseTsInterfaces(source);
  shapeProblems.push(...problems.map((p) => `${label}: ${p}`));
  let paired = 0;
  for (const [name, { fields, at }] of rustStructs) {
    if (STRUCT_EXEMPT.has(name)) continue;
    const tried = [name, `Native${name}`, name.replace(/^Native/, "")].filter(
      (c, i, all) => all.indexOf(c) === i,
    );
    // **Exactly one, not the first.** Adding a decoy declaration used to retire a real comparison
    // in silence: `tried` is [name, Native+name, name-without-Native], and an unused
    // `export interface BoundingRect` shadowed the `NativeBoundingRect` the addon actually returns
    // (gate 2, fourth pass).
    const matches = tried.filter((c) => interfaces.has(c));
    if (matches.length > 1) {
      shapeProblems.push(
        `${label}: \`${name}\` (${at}) matches ${matches.length} declarations — ${matches.join(", ")}; one struct may pair with one`,
      );
      continue;
    }
    const alias = matches[0];
    if (alias === undefined) {
      // The two files have different duties. `index.d.ts` is the addon's published surface: a
      // struct a caller can receive and cannot name is the #667 defect, so an unpaired struct
      // fails there. `native-types.ts` is a curated internal mirror — `NativeUiaEvidence` lives in
      // `native-engine.ts` instead — so it is checked for AGREEMENT where it declares a shape.
      // **An argument shape has no named interface, by design: it is written INLINE on the
      // function that takes it** (`uiaClickElement(opts: { windowTitle: string; … })`). Compare it
      // through that function rather than exempting it — 13 structs arrived here the moment the
      // recogniser learned `#[napi_derive::napi(object)]`, and every one of them is a shape a
      // caller must get right that nothing checked (gate 2, third pass).
      // **Every function that takes it, not the first one found.** A struct used by two exports had
      // one callsite compared and the other unchecked, with `comparedFields` not moving at all
      // (gate 2, fourth pass).
      const takenBy = [...rustFunctions].filter(([, def]) => def.paramType === name);
      if (takenBy.length > 0 && label === "index.d.ts") {
        for (const [fn] of takenBy) {
          const inline = tsFunctionParams.get(fn);
          if (!inline) {
            shapeProblems.push(`${label}: \`${fn}\` does not declare its parameter inline, and \`${name}\` has no interface (${at})`);
            continue;
          }
          for (const [field, def] of fields) {
            comparedFields++;
            if (!inline.has(field)) {
              shapeProblems.push(`${label}: \`${fn}(opts)\` is missing \`${field}\`, which \`${name}\` declares at ${def.at}`);
              continue;
            }
            if (def.optional && inline.get(field).optional === false) {
              shapeProblems.push(
                `${label}: \`${fn}(opts).${field}\` is declared required, but Rust has it as \`Option<..>\` ` +
                  `and napi omits the key for \`None\` — declare it \`${field}?:\``,
              );
            }
          }
          for (const field of inline.keys()) {
            if (!fields.has(field)) {
              shapeProblems.push(`${label}: \`${fn}(opts).${field}\` is declared, but \`${name}\` has no such field (${at})`);
            }
          }
        }
        paired++;
        continue;
      }
      // **Argument-only shapes are not expected in `native-types.ts`** — nothing in TS holds one,
      // it is written at the call. **But a shape that is also RETURNED belongs there**, and
      // skipping on "some function takes it" hid a returned struct's whole comparison behind a
      // number (gate 2, fourth pass). The test is read from the tree on both sides: taken by a
      // function AND returned by none.
      const returnedBySome = [...rustFunctions].some(([, def]) => def.returns?.includes(name));
      if (takenBy.length > 0 && !returnedBySome) {
        argumentOnly.add(name);
        continue;
      }
      // `index.d.ts` is the addon's published surface: a struct a caller can receive and cannot
      // name is the #667 defect. `native-types.ts` is a curated internal mirror — but "curated"
      // was indistinguishable from "misspelled": renaming an interface there removed a struct from
      // that half of the comparison and the only trace was a number in the OK line (gate 2, second
      // pass). Absences there are now a list with a reason.
      if (label === "index.d.ts" || !NATIVE_TYPES_ABSENT.has(name)) {
        shapeProblems.push(`${label}: no interface for \`${name}\` (${at}) — tried ${tried.join(", ")}`);
      }
      continue;
    }
    paired++;
    const declared = interfaces.get(alias);
    for (const [field, def] of fields) {
      comparedFields++;
      if (!declared.has(field)) {
        // **The field's own line, not the struct's.** win2 read a finding on Windows and found it
        // anchored 25 lines above the field it was about (2026-09-17).
        shapeProblems.push(`${label}: \`${alias}\` is missing \`${field}\`, which \`${name}\` sends at ${def.at}`);
        continue;
      }
      if (def.optional && declared.get(field).optional === false) {
        shapeProblems.push(
          `${label}: \`${alias}.${field}\` (${declared.get(field).at}) is declared required, but Rust has it as ` +
            `\`Option<..>\` at ${def.at} and napi omits the key for \`None\` — declare it \`${field}?:\``,
        );
      }
    }
    for (const field of declared.keys()) {
      if (!fields.has(field)) {
        shapeProblems.push(`${label}: \`${alias}.${field}\` is declared, but \`${name}\` has no such field (${at})`);
      }
    }
  }
  pairedPerFile.set(label, paired);
}

if (shapeProblems.length > 0) {
  failed = true;
  console.error("\n[check-native-types] FAIL — napi struct shapes disagree with the TS declarations:\n");
  for (const p of shapeProblems) console.error(`  - ${p}`);
}

if (failed) {
  // Only when a NAME is missing. A shape problem is already told how to fix itself,
  // and a closing line that advises adding a function declaration for a field that is
  // one character short of correct sends the reader to the wrong file.
  if (missing.length > 0 || notInJs.length > 0 || notInDts.length > 0) {
    console.error("\nAdd the missing `export declare function <name>(...)` lines to index.d.ts.");
  }
  console.error("Source of truth for shared types: src/engine/native-types.ts.\n");
  process.exit(1);
}

console.log(
  // **Two different sets used to print the same number and read as one.** `rustExports` is 97 and
  // `index.d.ts` declares 96 functions plus one class; the missing function is the exempt
  // `l1TestForcePanic`, so "all 97 are declared" was false by exactly the exemption (gate 2,
  // fourth pass).
  `[check-native-types] OK — ${rustExports.size} Rust exports, ${rustExports.size - [...rustExports].filter((n) => exempt(n)).length} of them declared in index.d.ts ` +
    `(${[...rustExports].filter((n) => exempt(n)).length} exempt by name), and all ${dtsDeclared.size} index.d.ts declarations are exported from index.js. ` +
    `${rustStructs.size} napi object structs, paired ` +
    [...pairedPerFile].map(([f, n]) => `${n} against ${f}`).join(" and ") +
    `, agree on field NAMES and OPTIONALITY (not types) across ${comparedFields} comparisons` +
    (argumentOnly.size > 0
      ? `; ${argumentOnly.size} argument-only shapes are compared at their callsites and not mirrored in native-types.ts (${[...argumentOnly].sort().join(", ")}).`
      : "."),
);
