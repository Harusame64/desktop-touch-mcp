import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { NativeCapabilityProfile } from "../native-types.js";

export type BenchmarkTarget = "chrome" | "terminal" | "game";
export type BenchmarkMode = "cold" | "warm" | "idle";

export interface BenchmarkMetrics {
  target: BenchmarkTarget;
  mode: BenchmarkMode;
  latencyMs: number;
  cpuPct?: number;
  gpuPct?: number;
  vramMb?: number;
  gameFrameImpactMs?: number;
  textRecall?: number;
  textPrecision?: number;
  touchSuccessRate?: number;
  timestampMs: number;
  notes?: string;
}

export interface BenchmarkResult {
  runId: string;
  startedAtMs: number;
  metrics: BenchmarkMetrics[];
  /** Phase 4b-7: capability profile snapshot at run start (used by 4b-8 vendor matrix). */
  capabilityProfile?: NativeCapabilityProfile;
}

export class BenchmarkHarness {
  private readonly runId: string;
  private readonly startedAtMs: number;
  private metrics: BenchmarkMetrics[] = [];

  constructor() {
    this.runId = randomUUID();
    this.startedAtMs = Date.now();
  }

  async measure(
    target: BenchmarkTarget,
    mode: BenchmarkMode,
    fn: () => Promise<void>,
    extras?: Partial<Omit<BenchmarkMetrics, "target" | "mode" | "latencyMs" | "timestampMs">>
  ): Promise<BenchmarkMetrics> {
    const t0 = performance.now();
    await fn();
    const latencyMs = performance.now() - t0;
    const m: BenchmarkMetrics = { target, mode, latencyMs, timestampMs: Date.now(), ...extras };
    this.metrics.push(m);
    return m;
  }

  record(metrics: BenchmarkMetrics): void {
    this.metrics.push(metrics);
  }

  getMetrics(): BenchmarkMetrics[] {
    return [...this.metrics];
  }

  toResult(): BenchmarkResult {
    return {
      runId: this.runId,
      startedAtMs: this.startedAtMs,
      metrics: [...this.metrics],
    };
  }
}
