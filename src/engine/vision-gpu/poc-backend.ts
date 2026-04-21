/**
 * poc-backend.ts — Phase 3-B VisualBackend implementation.
 *
 * Connects the PoC GpuWarmupManager (Batch 1) with a candidate snapshot store.
 * The warm state comes from the real warmup manager; candidate data is fed via
 * updateSnapshot() — which P3-D's ROI→TrackStore→TemporalFusion→CandidateProducer
 * pipeline will call once recognition results arrive.
 *
 * Design choices:
 * - No background polling. Snapshot updates are push-based: external code (P3-D)
 *   calls updateSnapshot() when the GPU pipeline produces new stable candidates.
 * - Per-targetKey snapshot store. Each window/tab gets its own candidate list.
 * - dirty listeners fire synchronously on updateSnapshot() so the ingress marks
 *   the target dirty before the next see() call arrives.
 *
 * P3-D migration:
 *   Replace updateSnapshot() call-site with CandidateProducer.ingest() output.
 *   The backend interface stays unchanged.
 */

import { GpuWarmupManager } from "./warmup.js";
import type { WarmTarget, WarmState, UiEntityCandidate } from "./types.js";
import type { VisualBackend } from "./backend.js";

export class PocVisualBackend implements VisualBackend {
  private readonly warmup: GpuWarmupManager;
  private readonly snapshots = new Map<string, UiEntityCandidate[]>();
  private readonly listeners = new Set<(targetKey: string) => void>();

  constructor(opts: { coldWarmupMs?: number } = {}) {
    // Default 50ms simulated warmup — replace with real model load time in P3-D.
    this.warmup = new GpuWarmupManager({ coldWarmupMs: opts.coldWarmupMs ?? 50 });
  }

  async ensureWarm(target: WarmTarget): Promise<WarmState> {
    return this.warmup.ensureWarm(target);
  }

  async getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]> {
    return this.snapshots.get(targetKey) ?? [];
  }

  onDirty(cb: (targetKey: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Feed a fresh candidate snapshot for a target key.
   *
   * P3-D: call this from the CandidateProducer.ingest() output path.
   * Firing dirty listeners immediately ensures the ingress marks the target
   * dirty so the next see() call gets a fresh snapshot.
   */
  updateSnapshot(targetKey: string, candidates: UiEntityCandidate[]): void {
    this.snapshots.set(targetKey, candidates);
    for (const cb of this.listeners) {
      try {
        cb(targetKey);
      } catch {
        // One failing listener (e.g. visualSource.markDirty) must not block others.
      }
    }
  }

  /** Return current warm state (for diagnostics). */
  getWarmState(): WarmState {
    return this.warmup.getState();
  }

  async dispose(): Promise<void> {
    await this.warmup.dispose();
    this.snapshots.clear();
    this.listeners.clear();
  }
}
