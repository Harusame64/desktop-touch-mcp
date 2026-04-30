#!/usr/bin/env node
// Run `napi build` while preserving uncommitted edits to the hand-maintained
// `index.d.ts` / `index.js`.
//
// Why this script exists
// ──────────────────────
// `napi build` writes (or truncates) `index.d.ts` and `index.js`. The repo
// intentionally diverges from napi's output — `index.d.ts` is the hand-
// maintained source of truth alongside `src/engine/native-types.ts`, and
// `index.js` is hand-extended too.
//
// The previous one-liner did `git restore --source=HEAD -- index.d.ts index.js`
// after `napi build`, which discards napi's regen — but it ALSO discards any
// uncommitted edits a developer made before running the build (e.g. adding
// new `export declare function` entries for new Rust APIs that haven't been
// committed yet). That bit ADR-007 P1 mid-implementation: each new export
// added to index.d.ts vanished on the next `npm run build:rs`.
//
// What this script does instead
// ─────────────────────────────
//   1. Snapshot current contents of index.d.ts / index.js (HEAD content +
//      any uncommitted edits — this is the dev's "intent").
//   2. Run `napi build` (--release for prod, --debug for CI-fast).
//   3. Restore the snapshot, so the dev's edits AND the hand-maintained
//      override of napi's regen both survive the build.
//
// Drift detection (Rust #[napi] vs hand-maintained index.d.ts) lives in
// `scripts/check-native-types.mjs` and runs in CI; that is the meaningful
// safety net. napi 3.x's regen is empty, so a diff against it is no longer
// a useful signal.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath` decodes percent-encoded URL segments (so paths containing
// spaces or non-ASCII characters round-trip correctly) and normalises
// Windows drive prefixes — both of which `new URL(...).pathname` mangles.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const D_TS = join(ROOT, "index.d.ts");
const INDEX_JS = join(ROOT, "index.js");
const FILES = [D_TS, INDEX_JS];

// Detect the active rustup toolchain's target triple so we can pass
// `--target <triple>` to napi build. Without this, a gnu-default rustup
// setup emits artifacts to `target/x86_64-pc-windows-gnu/release/` while
// napi-cli's post-build copy looks under `target/release/`, which fails
// as "Failed to copy artifact" *after* the cargo build itself succeeds.
// Passing `--target` keeps both sides agreed on the same directory and
// makes the .node filename's platform suffix match the toolchain (gnu
// vs msvc), so the same script works for either rustup default and on
// CI runners that pin a host triple via `setup-rust`.
//
// Returns `undefined` when rustup isn't on PATH or its output shape is
// unfamiliar; the caller then falls back to napi-cli's default
// behaviour (host triple implicit), which already works for msvc-host
// runners and was the only path before this script was added.
function detectHostTriple() {
  let result;
  try {
    result = spawnSync("rustup", ["show", "active-toolchain"], {
      encoding: "utf8",
      cwd: ROOT,
    });
  } catch {
    return undefined;
  }
  if (result.status !== 0 || !result.stdout) return undefined;
  // Toolchain lines look like:
  //   "stable-x86_64-pc-windows-gnu (default)"
  //   "nightly-2025-12-01-x86_64-pc-windows-msvc (default)"
  // The first whitespace-separated token is the toolchain name; its last
  // 4 hyphen-separated pieces form the target triple
  // (`<arch>-<vendor>-<os>-<env>`) regardless of whether the channel is
  // dated.
  const toolchain = result.stdout.split(/\s/, 1)[0];
  if (!toolchain) return undefined;
  const pieces = toolchain.split("-");
  if (pieces.length < 4) return undefined;
  return pieces.slice(-4).join("-");
}

const args = process.argv.slice(2);
const release = args.includes("--release");
const passthrough = args.filter((a) => a !== "--release" && a !== "--debug");

// ── 1. Snapshot ─────────────────────────────────────────────────────────────
/** Read each file once. Defensive against fresh clones where the addon has
 *  never been built — the files always exist in this repo today, but we tag
 *  missing entries so `restore()` can decide what to do. */
const snapshot = new Map();
for (const f of FILES) {
  try {
    snapshot.set(f, readFileSync(f, "utf8"));
  } catch {
    snapshot.set(f, undefined);
  }
}

function restore() {
  for (const f of FILES) {
    const original = snapshot.get(f);
    if (original !== undefined) writeFileSync(f, original);
  }
}

// ── 2. Run `napi build` ─────────────────────────────────────────────────────
// Invoke the napi CLI's JS entry directly with `node`. Going through
// `npx`/`npx.cmd` requires `shell: true` (DEP0190 on Node ≥ 22), and the
// shell lookup is brittle across MSYS bash / pwsh / cmd / GitHub Actions
// runners. Calling node with an absolute path is portable and explicit.
const napiCli = join(ROOT, "node_modules", "@napi-rs", "cli", "dist", "cli.js");
const triple = detectHostTriple();
const targetArgs = triple ? ["--target", triple] : [];
if (triple) {
  console.log(`[build-rs] detected rustup toolchain triple: ${triple}`);
}
const napiArgs = [
  "build",
  "--platform",
  ...targetArgs,
  ...(release ? ["--release"] : []),
  ...passthrough,
];
console.log(`[build-rs] running: node ${napiCli} ${napiArgs.join(" ")}`);
const napiResult = spawnSync(process.execPath, [napiCli, ...napiArgs], {
  stdio: "inherit",
  cwd: ROOT,
});

// Always restore — including on failure — so a broken build never leaves the
// working tree in napi's auto-truncated state.
restore();

if (napiResult.status !== 0) {
  console.error(`[build-rs] napi build failed (exit ${napiResult.status}); snapshots restored.`);
  process.exit(napiResult.status ?? 1);
}

console.log(
  `[build-rs] napi build OK; restored hand-maintained index.d.ts / index.js ` +
  `(uncommitted edits preserved).`,
);
