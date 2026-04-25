/**
 * bench-runner.ts — Phase 4b-7 cold/warm/idle benchmark orchestrator.
 *
 * Wires `BenchmarkHarness` with `OnnxBackend` to produce `BenchmarkResult`
 * suitable for ADR-005 L1 (warm p99 ≤ 30ms) / L4 (GPU ≤ 25%) / L6 (vendor portability)
 * verification. Writes results to `~/.desktop-touch-mcp/bench.json`.
 *
 * Scope:
 *   - cold: first inference after warm-up (slow path)
 *   - warm: N consecutive inferences (steady state, target metric)
 *   - idle: time delta between frames (no work)
 *
 * Tier ∞ wiring is *not* benchmarked here — that's a separate dogfood scenario.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { OnnxBackend } from "./onnx-backend.js";
import { BenchmarkHarness, type BenchmarkResult, type BenchmarkTarget } from "./benchmark.js";
import { nativeVision } from "../native-engine.js";

export interface BenchRunOptions {
  /** Target identifier — recorded in metrics; also used as targetKey in recognizeRois. */
  target: BenchmarkTarget;
  /** Number of warm iterations (default 20). */
  warmFrames?: number;
  /** Synthesized frame width × height (default 1920×1080). */
  frameWidth?: number;
  frameHeight?: number;
  /** Output path for bench.json (default ~/.desktop-touch-mcp/bench.json). */
  outputPath?: string;
}

/**
 * Default bench output path. Per ADR-005 §3 D2': "bench.json" cache lives
 * under `~/.desktop-touch-mcp/` so it survives across npm reinstalls.
 */
export function defaultBenchPath(): string {
  return join(homedir(), ".desktop-touch-mcp", "bench.json");
}

export class BenchmarkRunner {
  private readonly harness = new BenchmarkHarness();

  async run(opts: BenchRunOptions): Promise<BenchmarkResult> {
    const w = opts.frameWidth ?? 1920;
    const h = opts.frameHeight ?? 1080;

    // Capture capability profile early so it's preserved even on backend failure.
    const profile = nativeVision?.detectCapability?.();

    // Map BenchmarkTarget ("chrome"|"terminal"|"game") to WarmTarget.kind
    // ("browser"|"terminal"|"game"). "chrome" → "browser" (WarmTarget uses generic "browser").
    const warmKind: "browser" | "terminal" | "game" =
      opts.target === "chrome" ? "browser" : opts.target;

    const backend = new OnnxBackend();
    const warmStart = performance.now();
    const state = await backend.ensureWarm({ kind: warmKind, id: `bench-${opts.target}` });
    const warmupMs = performance.now() - warmStart;

    if (state !== "warm") {
      // Artifact missing or backend not built — record skip and return.
      this.harness.record({
        target: opts.target,
        mode: "cold",
        latencyMs: warmupMs,
        timestampMs: Date.now(),
        notes: `evicted (state=${state}) — artifact likely missing`,
      });
      const result = this.harness.toResult();
      result.capabilityProfile = profile;
      return result;
    }

    // Synthesize a frame buffer (mid-grey RGBA) — real dogfood replaces this with DXGI capture.
    const frameBuffer = Buffer.alloc(w * h * 4, 0x80);
    const rois = [{ trackId: "bench-roi-0", rect: { x: 0, y: 0, width: w, height: h } }];

    // Cold: first inference (model warm-up + GPU pipeline init)
    await this.harness.measure(opts.target, "cold", async () => {
      await backend.recognizeRois(opts.target, rois, w, h, frameBuffer);
    });

    // Warm: N consecutive inferences (steady state)
    const warmFrames = opts.warmFrames ?? 20;
    for (let i = 0; i < warmFrames; i++) {
      await this.harness.measure(opts.target, "warm", async () => {
        await backend.recognizeRois(opts.target, rois, w, h, frameBuffer);
      });
    }

    // Idle: short pause to record timestamp (sentinel for downstream ratio analysis)
    await this.harness.measure(opts.target, "idle", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await backend.dispose();
    const result = this.harness.toResult();
    result.capabilityProfile = profile;
    return result;
  }
}

/**
 * Convenience: run + write to disk.
 * Returns the path written + the result.
 */
export async function runAndWrite(
  opts: BenchRunOptions,
): Promise<{ path: string; result: BenchmarkResult }> {
  const runner = new BenchmarkRunner();
  const result = await runner.run(opts);
  const path = opts.outputPath ?? defaultBenchPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2), "utf8");
  return { path, result };
}

/**
 * Compute warm-mode p99 latency from a result. Returns -1 if no warm metrics.
 */
export function warmP99(result: BenchmarkResult): number {
  const warm = result.metrics.filter((m) => m.mode === "warm").map((m) => m.latencyMs);
  if (warm.length === 0) return -1;
  warm.sort((a, b) => a - b);
  const idx = Math.min(warm.length - 1, Math.floor(warm.length * 0.99));
  return warm[idx]!;
}
