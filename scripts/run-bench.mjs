#!/usr/bin/env node
/**
 * run-bench.mjs — Phase 4b-7 CLI for benchmark dogfood.
 *
 * Usage: node scripts/run-bench.mjs [--target=chrome|terminal|game]
 *                                    [--frames=N]
 *                                    [--output=path/to/bench.json]
 *                                    [--width=W --height=H]
 *
 * Requires: real Florence-2 / OmniParser-v2 / PaddleOCR-v4 ONNX artifacts in
 * ~/.desktop-touch-mcp/models/ + ORT_DYLIB_PATH set. Without artifacts, the
 * runner records an "evicted" cold metric and exits 0 with a clear message.
 *
 * Exit codes:
 *   0 = bench completed (regardless of warm vs evicted)
 *   1 = invalid arguments / file write failure
 */

import { runAndWrite, warmP99 } from "../dist/engine/vision-gpu/bench-runner.js";

function parseArg(name, fallback) {
  const idx = process.argv.findIndex((a) => a.startsWith(`--${name}=`));
  return idx === -1 ? fallback : process.argv[idx].slice(name.length + 3);
}

const target = parseArg("target", "chrome");
const framesStr = parseArg("frames", "20");
const widthStr = parseArg("width", "1920");
const heightStr = parseArg("height", "1080");
const outputPath = parseArg("output", undefined);

const warmFrames = Number.parseInt(framesStr, 10);
const frameWidth = Number.parseInt(widthStr, 10);
const frameHeight = Number.parseInt(heightStr, 10);

if (!["chrome", "terminal", "game"].includes(target)) {
  console.error(`ERROR: unknown target "${target}" (allowed: chrome, terminal, game)`);
  process.exit(1);
}
if (!Number.isFinite(warmFrames) || warmFrames < 1) {
  console.error(`ERROR: invalid --frames=${framesStr}`);
  process.exit(1);
}

console.log(`[bench] target=${target} frames=${warmFrames} ${frameWidth}x${frameHeight}`);

try {
  const { path, result } = await runAndWrite({
    target, warmFrames, frameWidth, frameHeight, outputPath,
  });
  const p99 = warmP99(result);
  console.log(`[bench] wrote ${path}`);
  console.log(`[bench] runId=${result.runId}`);
  console.log(`[bench] capability=${result.capabilityProfile?.gpuVendor ?? "?"} ${result.capabilityProfile?.gpuArch ?? "?"}`);
  console.log(`[bench] metrics=${result.metrics.length}`);
  if (p99 >= 0) {
    console.log(`[bench] warm p99 = ${p99.toFixed(2)}ms (target ≤ 30ms)`);
  } else {
    console.log("[bench] no warm metrics (likely evicted — see notes in bench.json)");
  }
  process.exit(0);
} catch (err) {
  console.error("[bench] failed:", err);
  process.exit(1);
}
