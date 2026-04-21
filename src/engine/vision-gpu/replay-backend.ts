/**
 * replay-backend.ts — Fixture-based replay VisualBackend for P3-D.
 *
 * A ReplayBackend reads UiEntityCandidate fixtures from a JSON file
 * and returns them on demand. Warm latency is simulated via an explicit
 * warmup delay; cold vs warm paths are measurable.
 *
 * Purpose: replace simulated (GpuWarmupManager delay-based) with a
 * fixture-driven backend that can represent real recognition output.
 *
 * Fixture format:
 * {
 *   "window:hwnd-game": [
 *     { "source": "visual_gpu", "label": "Start Match", "role": "button", ... },
 *     ...
 *   ]
 * }
 *
 * Usage:
 *   const backend = await ReplayBackend.fromFile("tests/fixtures/benchmark/game/candidates.json");
 *   await getVisualRuntime().attach(backend);
 *
 * Phase 3-D → real backend migration:
 *   Replace ReplayBackend with SidecarBackend or OnnxBackend.
 *   The VisualBackend interface is identical.
 */

import { readFile } from "node:fs/promises";
import type { UiEntityCandidate, WarmTarget, WarmState } from "./types.js";
import type { VisualBackend } from "./backend.js";

export interface ReplayBackendOptions {
  /** Simulated cold warmup latency in ms (default: 200 — models time to load model). */
  coldWarmupMs?: number;
  /** Simulated warm candidate fetch latency in ms (default: 20). */
  warmFetchMs?: number;
}

export class ReplayBackend implements VisualBackend {
  private state: WarmState = "cold";
  private warmingPromise: Promise<WarmState> | null = null;
  private readonly listeners = new Set<(targetKey: string) => void>();
  private readonly coldWarmupMs: number;
  private readonly warmFetchMs: number;

  constructor(
    private readonly fixtures: ReadonlyMap<string, UiEntityCandidate[]>,
    opts: ReplayBackendOptions = {}
  ) {
    this.coldWarmupMs = opts.coldWarmupMs ?? 200;
    this.warmFetchMs  = opts.warmFetchMs  ?? 20;
  }

  /** Load fixtures from a JSON file. Throws if file is missing or malformed. */
  static async fromFile(
    path: string,
    opts: ReplayBackendOptions = {}
  ): Promise<ReplayBackend> {
    const raw  = await readFile(path, "utf8");
    const data = JSON.parse(raw) as Record<string, UiEntityCandidate[]>;
    const map  = new Map(Object.entries(data));
    return new ReplayBackend(map, opts);
  }

  /** Build from an in-memory record (for tests without fixture files). */
  static fromRecord(
    fixtures: Record<string, UiEntityCandidate[]>,
    opts: ReplayBackendOptions = {}
  ): ReplayBackend {
    return new ReplayBackend(new Map(Object.entries(fixtures)), opts);
  }

  async ensureWarm(_target: WarmTarget): Promise<WarmState> {
    if (this.state === "warm") return "warm";
    if (this.warmingPromise)   return this.warmingPromise;

    this.state = "warming";
    this.warmingPromise = (async () => {
      await new Promise<void>((r) => setTimeout(r, this.coldWarmupMs));
      this.state = "warm";
      this.warmingPromise = null;
      return this.state;
    })();
    return this.warmingPromise;
  }

  async getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]> {
    if (this.state !== "warm") return [];
    // Simulate warm fetch latency.
    if (this.warmFetchMs > 0) {
      await new Promise<void>((r) => setTimeout(r, this.warmFetchMs));
    }
    return [...(this.fixtures.get(targetKey) ?? [])];
  }

  onDirty(cb: (targetKey: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Trigger a dirty signal (for replay-driven update simulation). */
  triggerDirty(targetKey: string): void {
    for (const cb of this.listeners) cb(targetKey);
  }

  getWarmState(): WarmState { return this.state; }

  /** List all target keys with fixture data. */
  getFixtureKeys(): string[] {
    return [...this.fixtures.keys()];
  }

  async dispose(): Promise<void> {
    this.state = "evicted";
    this.warmingPromise = null;
    this.listeners.clear();
  }
}
