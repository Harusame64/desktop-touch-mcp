#!/usr/bin/env node
// ADR-008 D1-5 / D2-B-3 — TS baseline for `current_focused_element` view bench.
//
// Measures the latency of the **production read path** that the
// existing `desktop_state` MCP tool walks. Two modes:
//
//   default              — `uiaGetFocusedElement()`        (focus-only baseline)
//   --with-point-query   — `uiaGetFocusedAndPoint(0, 0)`   (focus + at-point query,
//                                                           production-equivalent)
//
// The view path (D1-3) replaces the focus part of this UIA walk with an
// in-memory `Arc<RwLock<HashMap>>` lookup; the Rust criterion harness
// (`crates/engine-perception/benches/d1_view_latency.rs`) measures the
// view side. The point-query baseline (D2-B-3) is the **production gap**
// reference: `desktop_state` actually calls `uiaGetFocusedAndPoint` (focus
// + element-at-cursor in one trip), so the view-replacement ratio against
// the with-point baseline is the honest one (followups §2.2).
//
// Acceptance from `docs/adr-008-d1-plan.md` §11 D1: view p99 < TS p99 / 10.
// For D2 acceptance see `docs/adr-008-d2-plan.md` §11.
//
// Usage:
//   node benches/d1_ts_baseline.mjs                          # 1000 iters, focus-only
//   node benches/d1_ts_baseline.mjs 5000                     # custom iter count
//   node benches/d1_ts_baseline.mjs --with-point-query       # 1000 iters, focus+point
//   node benches/d1_ts_baseline.mjs 5000 --with-point-query  # custom + point query
//
// Requirements:
//   - Windows session with at least one focused application
//   - Native addon built (`npm run build:rs`)
//
// Output: text report on stdout — count, mean, p50/p95/p99 in
// microseconds, plus the comparison ratio template.

import { performance } from "node:perf_hooks";

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

// ─── Arg parsing ─────────────────────────────────────────────────────────────
// Accept `--with-point-query` (or `--point`) as a flag in any position; the
// first arg that parses as a finite number is the iteration count. (Defending
// against future flags by `!startsWith("--")` would silently swallow typos
// like `5O0` — finite-number check fails them at the iteration guard below.)
const rawArgs = process.argv.slice(2);
const withPointQuery = rawArgs.some((a) => a === "--with-point-query" || a === "--point");
const numericArg = rawArgs.find((a) => Number.isFinite(Number(a)));
const iterations = numericArg !== undefined ? Number(numericArg) : DEFAULT_ITERATIONS;
if (!Number.isFinite(iterations) || iterations < 100) {
  console.error("usage: node d1_ts_baseline.mjs [iterations >= 100] [--with-point-query]");
  process.exit(2);
}

const addonModule = await import("../index.js");
const addon = addonModule.default ?? addonModule;
const requiredFn = withPointQuery ? "uiaGetFocusedAndPoint" : "uiaGetFocusedElement";
if (typeof addon[requiredFn] !== "function") {
  console.error(`native addon does not expose ${requiredFn} — rebuild with \`npm run build:rs\``);
  process.exit(2);
}

// One probe function per mode. Hoisted so the warmup + measurement loops
// share the exact same call shape (no per-iteration branch in the hot path).
const probe = withPointQuery
  ? () => addon.uiaGetFocusedAndPoint({ cursorX: 0, cursorY: 0 })
  : () => addon.uiaGetFocusedElement();
const modeLabel = withPointQuery ? "uiaGetFocusedAndPoint" : "uiaGetFocusedElement";

// Warmup: prime the UIA thread + COM apartment, page in any cold paths.
for (let i = 0; i < WARMUP_ITERATIONS; i++) {
  await probe();
}

const samplesUs = new Float64Array(iterations);
for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  await probe();
  const t1 = performance.now();
  samplesUs[i] = (t1 - t0) * 1000; // ms → µs (perf.now is double in ms)
}

// Sort for percentile extraction. (We avoid sort-in-place on the typed
// array to keep the original samples available for any debug print.)
const sorted = Array.from(samplesUs).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

const fmt = (us) => `${us.toFixed(2)} µs`;

console.log(`# d1_ts_baseline — ${modeLabel} (${iterations} iters)`);
console.log(`mean : ${fmt(mean)}`);
console.log(`p50  : ${fmt(pct(0.50))}`);
console.log(`p95  : ${fmt(pct(0.95))}`);
console.log(`p99  : ${fmt(pct(0.99))}`);
console.log(`max  : ${fmt(sorted[sorted.length - 1])}`);
console.log("");
console.log("# Acceptance gate (ADR-008 D1):");
console.log("#   view p99  <  TS p99 / 10");
console.log(`#   target   <  ${fmt(pct(0.99) / 10)}`);
console.log("");
console.log("# Run the view-side bench to compare:");
console.log("#   cargo bench -p engine-perception --bench d1_view_latency");
