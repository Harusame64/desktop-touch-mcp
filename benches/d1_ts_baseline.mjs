#!/usr/bin/env node
// ADR-008 D1-5 — TS baseline for `current_focused_element` view bench.
//
// Measures the latency of the **production read path** that the
// existing `desktop_state` MCP tool walks: a synchronous-from-the-
// caller's-perspective UIA tree query via the napi `uiaGetFocusedElement`
// addon export. The view path (D1-3) replaces this UIA walk with an
// in-memory `Arc<RwLock<HashMap>>` lookup; the Rust criterion harness
// (`crates/engine-perception/benches/d1_view_latency.rs`) measures the
// view side.
//
// Acceptance from `docs/adr-008-d1-plan.md` §11 D1: view p99 < TS p99 / 10.
//
// Usage:
//   node benches/d1_ts_baseline.mjs            # 1000 iterations (default)
//   node benches/d1_ts_baseline.mjs 5000       # custom iteration count
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

const iterations = Number(process.argv[2] ?? DEFAULT_ITERATIONS);
if (!Number.isFinite(iterations) || iterations < 100) {
  console.error("usage: node d1_ts_baseline.mjs [iterations >= 100]");
  process.exit(2);
}

const addonModule = await import("../index.js");
const addon = addonModule.default ?? addonModule;
if (typeof addon.uiaGetFocusedElement !== "function") {
  console.error("native addon does not expose uiaGetFocusedElement — rebuild with `npm run build:rs`");
  process.exit(2);
}

// Warmup: prime the UIA thread + COM apartment, page in any cold paths.
for (let i = 0; i < WARMUP_ITERATIONS; i++) {
  await addon.uiaGetFocusedElement();
}

const samplesNs = new Float64Array(iterations);
for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  await addon.uiaGetFocusedElement();
  const t1 = performance.now();
  samplesNs[i] = (t1 - t0) * 1000; // ms → µs (perf.now is double in ms)
}

// Sort for percentile extraction. (We avoid sort-in-place on the typed
// array to keep the original samples available for any debug print.)
const sorted = Array.from(samplesNs).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

const fmt = (us) => `${us.toFixed(2)} µs`;

console.log(`# d1_ts_baseline — uiaGetFocusedElement (${iterations} iters)`);
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
