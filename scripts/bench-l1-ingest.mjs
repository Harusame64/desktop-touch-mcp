#!/usr/bin/env node
// ADR-007 P5a acceptance bench: event ingest 10k/s @ p99 < 1ms
//
// Measures the per-push latency of l1PushHwInputPostMessage (minimum payload:
// bincode ~28B) using process.hrtime.bigint() and prints p50/p95/p99/max.
// After the hot loop, verifies that drop_count == 0 and push_count == 10_000.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const candidates = [
  "desktop-touch-engine.win32-x64-msvc.node",
  "desktop-touch-engine.win32-x64-gnu.node",
];
let addon = null;
for (const name of candidates) {
  const p = join(here, "..", name);
  try { addon = _require(p); break; } catch { /* try next */ }
}

if (!addon || typeof addon.l1PushHwInputPostMessage !== "function") {
  console.error(
    "[bench-l1-ingest] ERROR: native addon not found or l1PushHwInputPostMessage missing.\n" +
    "  Run 'npm run build:rs' first.",
  );
  process.exit(1);
}

const N = 10_000;
const latencies = new BigInt64Array(N); // nanoseconds per push

// Warm up: 100 pushes (JIT + cache warm).
for (let i = 0; i < 100; i++) {
  addon.l1PushHwInputPostMessage(0n, 0, 0n, 0n);
}

// Drain warm-up events.
addon.l1PollEvents(0n, 200_000);

// Snapshot baseline stats.
const statsBefore = addon.l1GetCaptureStats();
const baselinePush = statsBefore.pushCount;
const baselineDrop = statsBefore.dropCount;

// Hot loop.
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  addon.l1PushHwInputPostMessage(0n, 0, 0n, BigInt(i));
  const t1 = process.hrtime.bigint();
  latencies[i] = t1 - t0;
}

// Stats after.
const statsAfter = addon.l1GetCaptureStats();
const actualPush = Number(statsAfter.pushCount - baselinePush);
const actualDrop = Number(statsAfter.dropCount - baselineDrop);

// Sort latencies for percentile calculation.
const sorted = Array.from(latencies).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function pct(arr, p) {
  const idx = Math.ceil(arr.length * p / 100) - 1;
  return arr[Math.max(0, idx)];
}

function nsToMs(ns) {
  return (Number(ns) / 1_000_000).toFixed(3);
}

console.log("\n[bench-l1-ingest] ADR-007 P5a — l1PushHwInputPostMessage latency");
console.log(`  Samples : ${N}`);
console.log(`  p50     : ${nsToMs(pct(sorted, 50))} ms`);
console.log(`  p95     : ${nsToMs(pct(sorted, 95))} ms`);
console.log(`  p99     : ${nsToMs(pct(sorted, 99))} ms`);
console.log(`  max     : ${nsToMs(sorted[sorted.length - 1])} ms`);
console.log(`  push_count delta : ${actualPush} (expected ${N})`);
console.log(`  drop_count delta : ${actualDrop} (expected 0)`);

const p99ms = Number(pct(sorted, 99)) / 1_000_000;
let ok = true;

if (p99ms >= 1.0) {
  console.error(`\n[bench-l1-ingest] FAIL — p99 ${p99ms.toFixed(3)} ms >= 1 ms target`);
  ok = false;
} else {
  console.log(`\n[bench-l1-ingest] PASS — p99 ${p99ms.toFixed(3)} ms < 1 ms target`);
}

if (actualPush !== N) {
  console.error(`[bench-l1-ingest] FAIL — push_count delta ${actualPush} != ${N}`);
  ok = false;
}
if (actualDrop !== 0) {
  console.error(`[bench-l1-ingest] FAIL — drop_count delta ${actualDrop} != 0`);
  ok = false;
}

addon.l1ShutdownForTest();

process.exit(ok ? 0 : 1);
