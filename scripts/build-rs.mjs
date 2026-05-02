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
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

// On Windows MSVC, `build.rs` emits `cargo:rustc-link-search=<repo root>` +
// `cargo:rustc-link-lib=node` so the linker looks for `node.lib` at the repo
// root — but napi-build does NOT download the lib itself, and the @napi-rs/cli
// download path can silently no-op on a fresh clone (empty
// %LOCALAPPDATA%\node-gyp\Cache, no `node.lib` in repo root). The result is
// `LNK1181: 入力ファイル 'node.lib' を開けません` deep inside the link stage.
// Populate `node.lib` from the node-gyp cache, running `npx node-gyp install`
// first if the cache is empty.
//
// GNU host is intentionally skipped: `build.rs` requires `libnode.a` (generated
// from node.exe exports via dlltool) on gnu, not `node.lib`. Auto-populating
// `node.lib` there would produce a "silent miss-rescue" — file appears, but
// link still fails. CI/release flows are MSVC-only; gnu is a developer
// preference and out of scope here.
function ensureNodeLibOnWindows(triple) {
  if (process.platform !== "win32") return;
  if (triple?.endsWith("-gnu")) {
    console.warn(
      "[build-rs] gnu host detected; preflight handles MSVC node.lib only. " +
        "GNU target needs libnode.a generated separately (see build.rs).",
    );
    return;
  }
  const repoNodeLib = join(ROOT, "node.lib");
  if (existsSync(repoNodeLib)) return;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    console.error("[build-rs] LOCALAPPDATA env not set; cannot locate node-gyp cache.");
    process.exit(1);
  }
  const arch = archFromTriple(triple);
  const nodeVer = process.versions.node;
  const cachedNodeLib = join(
    localAppData,
    "node-gyp",
    "Cache",
    nodeVer,
    arch,
    "node.lib",
  );
  if (!existsSync(cachedNodeLib)) {
    console.log(
      `[build-rs] node.lib missing from repo root and node-gyp cache; running 'npx --yes node-gyp install --target=${nodeVer}'`,
    );
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    // `--target=<ver>` pins the download to the running Node's version so the
    // post-install lookup at `<ver>/<arch>/node.lib` finds it. Without it,
    // node-gyp picks its own default (often a different version), the cache
    // path mismatches, and we'd false-positive the "did not produce" branch.
    // CI does the same (.github/workflows/ci.yml).
    const r = spawnSync(npx, ["--yes", "node-gyp", "install", `--target=${nodeVer}`], {
      stdio: "inherit",
      cwd: ROOT,
    });
    if (r.status !== 0 || !existsSync(cachedNodeLib)) {
      console.error(`[build-rs] node-gyp install did not produce ${cachedNodeLib}`);
      process.exit(1);
    }
  }
  copyFileSync(cachedNodeLib, repoNodeLib);
  console.log(`[build-rs] populated ${repoNodeLib} from node-gyp cache`);
}

// node-gyp Cache layout: <ver>/<arch>/node.lib where arch ∈ {x64, ia32, arm64}.
// Prefer the rustup target triple (cross-compile aware); fall back to host arch.
// Only meaningful when the caller has already confirmed Windows + non-gnu;
// `ensureNodeLibOnWindows` is the only caller and gates both checks.
function archFromTriple(triple) {
  if (triple?.startsWith("x86_64")) return "x64";
  if (triple?.startsWith("aarch64")) return "arm64";
  if (triple?.startsWith("i686")) return "ia32";
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "ia32") return "ia32";
  return "x64";
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

// ── 2. Preflight (Windows only) ─────────────────────────────────────────────
const triple = detectHostTriple();
ensureNodeLibOnWindows(triple);

// ── 3. Run `napi build` ─────────────────────────────────────────────────────
// Invoke the napi CLI's JS entry directly with `node`. Going through
// `npx`/`npx.cmd` requires `shell: true` (DEP0190 on Node ≥ 22), and the
// shell lookup is brittle across MSYS bash / pwsh / cmd / GitHub Actions
// runners. Calling node with an absolute path is portable and explicit.
const napiCli = join(ROOT, "node_modules", "@napi-rs", "cli", "dist", "cli.js");
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
