#!/usr/bin/env node
// ADR-008 D2-B-4 / D2-B-5 — MCP transport bench for `desktop_state`.
//
// Spawns the production server (`dist/index.js`) over **stdio MCP
// transport**, opens a real `@modelcontextprotocol/sdk` Client, and
// measures the latency of `tools/call desktop_state` end-to-end:
//
//   client → JSON-RPC stringify → stdio pipe → server router →
//   desktop_state handler (view-first focus path, D2-B-2) →
//   JSON-RPC stringify back → stdio pipe → client parse
//
// This is the production read latency that an agent observes — the
// previous bench (`d1_ts_baseline.mjs`) measures only the napi UIA call
// in-process, which is the lower bound, not the production gap.
//
// ## Modes
//
// **D2-B-5 auto-induce mode (default)**: warmup phase emits two alt+tab
// keystrokes via `@nut-tree-fork/nut-js` so `latest_focus` view gets
// populated by `focus_pump`. Subsequent measure-phase iterations exercise
// the view path (`hints.focusedElementSource === "view"`), which is the
// real production hot path after a focus change.
//
// **D2-B-4 manual mode (`--manual` / `--no-induce`)**: skip auto-induction.
// Reproduces the original D2-B-4 baseline (focus held in terminal, view
// path not populated, every iter falls through to UIA fallback). Use this
// to compare against PR #98 numbers or in environments where
// programmatic alt+tab is blocked (RDP / locked-down policy).
//
// ## Output (D2-B-5 metric 3-decomposition)
//
// - `overall`   — all iters (D2-B-4 互換、regression 0 確認用)
// - `view-hit`  — iters with `focusedElementSource === "view"` (OQ #2/#16
//                 SLO confirmation の根拠数値)
// - `non-view`  — iters with `uia` / `cdp` / `(unset)` fallback
//
// Acceptance gate (auto-induce mode): view-hit counter > 0 — exit code 1
// otherwise. Manual mode tolerates 0 view-hits as expected.
//
// ## Usage
//
//   node benches/d2_desktop_state_roundtrip.mjs                  # 1000 iters, auto-induce (D2-B-5)
//   node benches/d2_desktop_state_roundtrip.mjs 5000             # custom iter count, auto-induce
//   node benches/d2_desktop_state_roundtrip.mjs --manual         # 1000 iters, manual (D2-B-4 reproduction)
//   node benches/d2_desktop_state_roundtrip.mjs 1000 --no-induce # alias of --manual
//
// ## Requirements
//
//   - Windows session with at least one focused application + GUI input rights
//     (RDP / locked-down sessions may need `--manual`)
//   - `npm run build` (TS) and `npm run build:rs` (native addon) completed
//   - `dist/index.js` present
//
// Output: text report on stdout — count, mean, p50/p95/p99 in
// microseconds for each of overall / view-hit / non-view, plus the
// `hints.focusedElementSource` distribution.

import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

// D2-B-5 induction schedule: alt+tab at warmup iter 30 (focus → other window)
// and 50 (focus → back to terminal). Two events ensure focus_pump observes
// at least one transition that lands in the bench-process foreground, so
// `latest_focus` view's foreground-match gate (`shouldAcceptViewFocus` 3
// ladder, PR #97) can hit during measure phase.
const INDUCE_AT_WARMUP_ITERS = new Set([30, 50]);
// 200ms wait after each alt+tab covers shift_ms=100ms (default) × 2 cycles
// for the watermark to release through idle-advance projection. Smaller
// values risk view path miss in the measure phase due to release floor.
const POST_INDUCE_WAIT_MS = 200;

// ─── Arg parsing ─────────────────────────────────────────────────────────────
// `--manual` / `--no-induce` disables auto-induction (= D2-B-4 mode).
// `--induce-focus-change` is the explicit form of the default ON behaviour;
// kept for documentation symmetry. First arg that parses as a finite number
// is the iteration count.
const rawArgs = process.argv.slice(2);
const manualMode = rawArgs.some((a) => a === "--manual" || a === "--no-induce");
const numericArg = rawArgs.find((a) => Number.isFinite(Number(a)));
const iterations = numericArg !== undefined ? Number(numericArg) : DEFAULT_ITERATIONS;
if (!Number.isFinite(iterations) || iterations < 100) {
  console.error(
    "usage: node d2_desktop_state_roundtrip.mjs [iterations >= 100] [--manual | --induce-focus-change]"
  );
  process.exit(2);
}

const induceEnabled = !manualMode;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
// Spawn `dist/index.js` (the platform-dispatching entry, matching what the
// production launcher boots) rather than `dist/server-windows.js` directly.
// On Windows the dispatch is a single extra `await import("./server-windows.js")`
// that's amortised across warmup, so it doesn't perturb steady-state numbers
// — but it keeps the bench honest about the real cold-start surface.
const serverPath = resolve(repoRoot, "dist", "index.js");
if (!existsSync(serverPath)) {
  console.error(`server entry not found: ${serverPath} — run \`npm run build\``);
  process.exit(2);
}

// ─── nutjs import (auto-induce mode only) ───────────────────────────────────
// Dynamic import so manual mode doesn't pay the nutjs load cost (it pulls in
// node-gyp-built native bindings for input simulation). On import failure we
// degrade to manual mode + warning rather than crashing — RDP / sandboxed
// env may legitimately lack nutjs's prerequisites.
let nutKeyboard = null;
let nutKey = null;
if (induceEnabled) {
  try {
    const nutMod = await import("@nut-tree-fork/nut-js");
    nutKeyboard = nutMod.keyboard ?? nutMod.default?.keyboard ?? null;
    nutKey = nutMod.Key ?? nutMod.default?.Key ?? null;
    if (!nutKeyboard || !nutKey || nutKey.LeftAlt === undefined || nutKey.Tab === undefined) {
      throw new Error("nutjs keyboard/Key.LeftAlt/Key.Tab exports not found");
    }
  } catch (e) {
    console.warn(
      `# WARNING: nutjs import failed (${e?.message ?? e}). Falling back to manual mode.`
    );
    nutKeyboard = null;
    nutKey = null;
  }
}

// AUTO_GUARD=0 disables the lensId precondition on action tools — `desktop_state`
// itself doesn't need it but the production server logs a startup banner under
// guard mode that adds noise to the cold-start hop. (See feedback memory
// `pre_v0_12_e2e_autoguard.md`.)
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_TOUCH_AUTO_GUARD: "0" },
  stderr: "pipe",
});

const client = new Client({ name: "d2-bench", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const callDesktopState = async () => {
  const result = await client.callTool({ name: "desktop_state", arguments: {} });
  return result;
};

const sendAltTab = async () => {
  if (!nutKeyboard || !nutKey) return false;
  try {
    // Press LeftAlt + Tab, release Tab + LeftAlt. nutjs handles the
    // up-down ordering internally for `pressKey` / `releaseKey` —
    // releasing in reverse order keeps the modifier semantics correct.
    await nutKeyboard.pressKey(nutKey.LeftAlt, nutKey.Tab);
    await nutKeyboard.releaseKey(nutKey.Tab, nutKey.LeftAlt);
    return true;
  } catch (e) {
    console.warn(`# WARNING: alt+tab send failed (${e?.message ?? e})`);
    return false;
  }
};

let inductionAttempts = 0;
let inductionFailures = 0;

// ─── Warmup ──────────────────────────────────────────────────────────────────
// Prime the UIA thread, populate the latest_focus view via focus_pump,
// page in cold paths on both the client and server side. With auto-induce
// enabled, also emit alt+tab at the scheduled iters.
for (let i = 0; i < WARMUP_ITERATIONS; i++) {
  await callDesktopState();
  if (induceEnabled && nutKeyboard && INDUCE_AT_WARMUP_ITERS.has(i)) {
    inductionAttempts++;
    const ok = await sendAltTab();
    if (!ok) inductionFailures++;
    await sleep(POST_INDUCE_WAIT_MS);
  }
}

// ─── Measure ─────────────────────────────────────────────────────────────────
const samplesUs = new Float64Array(iterations);
const perIterSource = new Array(iterations);
const sourceCounts = new Map(); // hints.focusedElementSource → count
let parseErrors = 0;

for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  const result = await callDesktopState();
  const t1 = performance.now();
  samplesUs[i] = (t1 - t0) * 1000; // ms → µs

  // Diagnose which focus path each iteration took. Server returns
  // structured content (newer SDK) or a content[0].text JSON blob
  // (older SDK / fallback) — handle both.
  let payload = result?.structuredContent;
  if (!payload && Array.isArray(result?.content)) {
    const text = result.content.find((c) => c?.type === "text")?.text;
    if (typeof text === "string") {
      try {
        payload = JSON.parse(text);
      } catch {
        parseErrors++;
      }
    }
  }
  const source = payload?.hints?.focusedElementSource ?? "(unset)";
  perIterSource[i] = source;
  sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
}

await client.close();

// ─── Stats ───────────────────────────────────────────────────────────────────
const computeStats = (samples) => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    mean,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
  };
};

const viewHitSamples = [];
const nonViewSamples = [];
for (let i = 0; i < iterations; i++) {
  if (perIterSource[i] === "view") viewHitSamples.push(samplesUs[i]);
  else nonViewSamples.push(samplesUs[i]);
}

const overallStats = computeStats(Array.from(samplesUs));
const viewHitStats = computeStats(viewHitSamples);
const nonViewStats = computeStats(nonViewSamples);

const fmt = (us) => `${us.toFixed(2)} µs`;

// ─── Output ──────────────────────────────────────────────────────────────────
const modeLabel = induceEnabled
  ? nutKeyboard
    ? "auto-induce"
    : "manual (nutjs unavailable, degraded)"
  : "manual";
console.log(
  `# d2_desktop_state_roundtrip — MCP stdio transport (${iterations} iters, mode=${modeLabel})`
);
if (induceEnabled && nutKeyboard) {
  console.log(`# induction: alt+tab × ${inductionAttempts} attempted, ${inductionFailures} failed`);
}
console.log("");

console.log("## overall");
console.log(`mean : ${fmt(overallStats.mean)}`);
console.log(`p50  : ${fmt(overallStats.p50)}`);
console.log(`p95  : ${fmt(overallStats.p95)}`);
console.log(`p99  : ${fmt(overallStats.p99)}`);
console.log(`max  : ${fmt(overallStats.max)}`);
console.log("");

if (viewHitStats) {
  console.log(`## view-hit (focusedElementSource = "view", N=${viewHitStats.n})`);
  console.log(`mean : ${fmt(viewHitStats.mean)}`);
  console.log(`p50  : ${fmt(viewHitStats.p50)}`);
  console.log(`p95  : ${fmt(viewHitStats.p95)}`);
  console.log(`p99  : ${fmt(viewHitStats.p99)}`);
  console.log(`max  : ${fmt(viewHitStats.max)}`);
  console.log("");
} else {
  console.log("## view-hit: 0 iters observed");
  console.log("");
}

if (nonViewStats) {
  console.log(`## non-view (uia/cdp fallback, N=${nonViewStats.n})`);
  console.log(`mean : ${fmt(nonViewStats.mean)}`);
  console.log(`p99  : ${fmt(nonViewStats.p99)}`);
  console.log("");
}

console.log("## focusedElementSource distribution");
for (const [source, count] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const pctOfTotal = ((count / iterations) * 100).toFixed(1);
  console.log(`#   ${source.padEnd(10)} : ${count} (${pctOfTotal}%)`);
}
if (parseErrors > 0) {
  console.log(`#   parse errors: ${parseErrors}`);
}
console.log("");

// ─── Acceptance gate (D2-B-5) ────────────────────────────────────────────────
const viewHitCount = sourceCounts.get("view") ?? 0;
let exitCode = 0;
if (induceEnabled && viewHitCount === 0) {
  console.log("# OPERATOR NOTE: view path was NOT exercised in this run.");
  console.log("#   Auto-induction failed to populate latest_focus view.");
  console.log("#   Possible causes:");
  console.log(
    "#     - RDP / multi-monitor / group policy blocks programmatic alt+tab"
  );
  console.log("#     - bench process lacks input rights (UAC-elevated foreground app)");
  console.log("#     - focus_pump cycle outpaced 200ms wait (raise POST_INDUCE_WAIT_MS)");
  console.log("#     - nutjs failed to load (see WARNING above if any)");
  console.log("#   Manual fallback:");
  console.log("#     1. Re-run with --manual to skip auto-induction");
  console.log("#     2. While warmup is running, alt+tab manually to a different window and back");
  console.log("");
  console.log(
    "# ACCEPTANCE FAIL (D2-B-5): view-hit counter == 0 with auto-induction enabled"
  );
  exitCode = 1;
} else if (!induceEnabled && viewHitCount === 0) {
  console.log("# NOTE (manual mode): view path was NOT exercised.");
  console.log("#   In manual mode, view path requires operator alt+tab during warmup.");
  console.log("#   This matches the D2-B-4 baseline (PR #98).");
  console.log("");
}

console.log("# Acceptance gate (ADR-008 D2 §11, OQ #16):");
console.log(
  "#   D2-B-5 view-hit p99 vs TS with-point baseline p99 — feeds SLO 4-種分解 (PR-2)"
);
console.log("#");
console.log("# Compare against:");
console.log("#   node benches/d1_ts_baseline.mjs --with-point-query");

process.exit(exitCode);
