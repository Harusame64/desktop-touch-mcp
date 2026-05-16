#!/usr/bin/env node
// ADR-019 Stage 4 — `compute_ssim_residual` unit latency bench.
//
// Measures p50 / p90 / p99 / max of `computeSsimResidual` over a 400×400
// synthetic frame pair. Sub-plan §3 row 16 / §5 G4-6 acceptance:
//   p99 ≤ 15 ms compute-only on a 400×400 RGBA frame pair.
//
// If the scalar P1 path misses the 15 ms unit budget on AVX2-class hosts,
// §4 P12 (AVX2 + SSE2 runtime dispatch) lands as a follow-up optimisation
// pass. The bench output below identifies the SIMD path via
// `nativeEngine.computeChangeFraction` being available (same dispatch
// gate as the SSE2 path in src/pixel_diff.rs).
//
// Usage:
//   node benches/ssim_residual.mjs           # default: 1000 iterations
//   node benches/ssim_residual.mjs 5000      # 5000 iterations for tighter p99
//
// Requirements:
//   - Native engine built (`npm run build:rs`)
//   - `dist/` produced by `npm run build` (the script imports the
//     ESM-built native loader)

import { performance } from "node:perf_hooks";

// Import the native engine the same way production code does — through the
// dist/ loader so the bench measures the actual deployed code path.
const { nativeEngine } = await import("../dist/engine/native-engine.js");

if (!nativeEngine?.computeSsimResidual) {
  console.error(
    "[ssim-bench] FAIL: nativeEngine.computeSsimResidual is unavailable.",
  );
  console.error(
    "             Run `npm run build:rs` to build the Rust addon with the P1 export.",
  );
  process.exit(1);
}

const iterations = Number(process.argv[2] ?? 1000) | 0;
if (iterations < 10) {
  console.error("[ssim-bench] iterations must be >= 10");
  process.exit(1);
}

// ─── Build the 400×400 synthetic frame pair ─────────────────────────────────
//
// Sub-plan G4-6 specifies 400×400 (matches the typical focused-element rect
// size for keyboard / mouse_click feedback). We use a deterministic pair:
// - `pre`: 400×400 RGBA, fill 200 with a 40×40 darker patch at (180, 180)
// - `post`: same canvas with the patch shifted to (200, 200) (local repaint)
// This gives roughly 5-15 % of windows above the residual threshold, which
// is a representative bench input.

const W = 400;
const H = 400;
const CH = 4;
const pre = Buffer.alloc(W * H * CH, 200);
const post = Buffer.alloc(W * H * CH, 200);

function drawRect(buf, x0, y0, w, h, byte) {
  const stride = W * CH;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = y * stride + x * CH;
      buf[i] = byte;
      buf[i + 1] = byte;
      buf[i + 2] = byte;
    }
  }
}

drawRect(pre, 180, 180, 40, 40, 60); // dark patch in pre
drawRect(post, 200, 200, 40, 40, 60); // patch shifted in post

// ─── Warm-up + measure ──────────────────────────────────────────────────────

console.log(
  `[ssim-bench] frame: ${W}×${H}×${CH} RGBA, iterations: ${iterations}`,
);

// Warm-up to stabilise JIT / branch predictors.
for (let i = 0; i < 50; i++) {
  nativeEngine.computeSsimResidual(pre, post, W, H, CH, null);
}

const samples = new Float64Array(iterations);
for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  nativeEngine.computeSsimResidual(pre, post, W, H, CH, null);
  const elapsed = performance.now() - t0;
  samples[i] = elapsed;
}

// One reference run for the diagnostic output.
const ref = nativeEngine.computeSsimResidual(pre, post, W, H, CH, null);

// ─── Percentiles ────────────────────────────────────────────────────────────

const sorted = Array.from(samples).sort((a, b) => a - b);
function pct(p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
const p50 = pct(0.5);
const p90 = pct(0.9);
const p99 = pct(0.99);
const max = sorted[sorted.length - 1];
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

// ─── Output ─────────────────────────────────────────────────────────────────

console.log(
  `[ssim-bench] result: fractionChanged=${ref.fractionChanged.toFixed(4)}, meanSsim=${ref.meanSsim.toFixed(4)}`,
);
if (ref.centroid) {
  console.log(
    `[ssim-bench] centroid: (${ref.centroid.x.toFixed(1)}, ${ref.centroid.y.toFixed(1)})`,
  );
}
console.log("");
console.log("  metric    ms");
console.log("  ──────    ────");
console.log(`  mean      ${mean.toFixed(3)}`);
console.log(`  p50       ${p50.toFixed(3)}`);
console.log(`  p90       ${p90.toFixed(3)}`);
console.log(`  p99       ${p99.toFixed(3)}`);
console.log(`  max       ${max.toFixed(3)}`);
console.log("");

// G4-6 acceptance gate. We exit 0 only when p99 ≤ 15 ms.
const G4_6_BUDGET_MS = 15;
if (p99 <= G4_6_BUDGET_MS) {
  console.log(
    `[ssim-bench] PASS: p99 ${p99.toFixed(3)} ms ≤ ${G4_6_BUDGET_MS} ms (G4-6 unit budget).`,
  );
  process.exit(0);
} else {
  console.error(
    `[ssim-bench] FAIL: p99 ${p99.toFixed(3)} ms > ${G4_6_BUDGET_MS} ms (G4-6 unit budget).`,
  );
  console.error(
    `             Consider §4 P12 — AVX2 + SSE2 runtime dispatch (sub-plan §4.5 SIMD plan).`,
  );
  process.exit(1);
}
