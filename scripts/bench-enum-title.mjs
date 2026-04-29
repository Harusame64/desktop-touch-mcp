#!/usr/bin/env node
// ADR-007 P1 baseline bench. Measures `win32EnumTopLevelWindows()` plus
// `win32GetWindowText()` for every returned HWND, repeated 1000 times.
// The full bench harness (criterion-based) lands in P5a per benches/README.md
// §7; this script gives us a dev-mode regression baseline today.
//
// Usage: node scripts/bench-enum-title.mjs

import { win32EnumTopLevelWindows, win32GetWindowText } from "../index.js";

const ITERATIONS = 1000;
// Warm-up to amortize JIT and DLL load cost.
for (let i = 0; i < 10; i++) {
  const hs = win32EnumTopLevelWindows();
  for (const h of hs) win32GetWindowText(h);
}

const samples = new Float64Array(ITERATIONS);
for (let i = 0; i < ITERATIONS; i++) {
  const start = process.hrtime.bigint();
  const hwnds = win32EnumTopLevelWindows();
  for (const h of hwnds) {
    win32GetWindowText(h);
  }
  const end = process.hrtime.bigint();
  samples[i] = Number(end - start) / 1e6; // ms
}

samples.sort();
const p50 = samples[Math.floor(ITERATIONS * 0.5)];
const p95 = samples[Math.floor(ITERATIONS * 0.95)];
const p99 = samples[Math.floor(ITERATIONS * 0.99)];
const min = samples[0];
const max = samples[ITERATIONS - 1];
const sum = samples.reduce((a, b) => a + b, 0);
const mean = sum / ITERATIONS;

const rep = win32EnumTopLevelWindows();
const reportRows = [
  ["Iterations", String(ITERATIONS)],
  ["Windows enumerated per iteration (sample)", String(rep.length)],
  ["min (ms)", min.toFixed(3)],
  ["p50 (ms)", p50.toFixed(3)],
  ["p95 (ms)", p95.toFixed(3)],
  ["p99 (ms)", p99.toFixed(3)],
  ["max (ms)", max.toFixed(3)],
  ["mean (ms)", mean.toFixed(3)],
];

console.log("\nADR-007 P1 baseline: enum + title 1000 iterations\n");
const w = Math.max(...reportRows.map(([k]) => k.length));
for (const [k, v] of reportRows) {
  console.log("  " + k.padEnd(w + 2) + v);
}
console.log("");
