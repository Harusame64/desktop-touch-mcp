/**
 * visual-ingress.ts — Manual invalidation source for visual GPU lane targets.
 *
 * Phase 2 implementation: a simple pending-set that external code can push
 * dirty keys into. When drain() is called, all pending keys that are also in
 * knownKeys are returned and the pending set is cleared.
 *
 * Phase 3 plan: replace or supplement with Desktop Duplication dirty-rect events.
 * The `markDirty()` entry point will remain — the GPU pipeline will call it when
 * a tracked ROI changes.
 *
 * Target isolation: only keys explicitly passed to markDirty() are ever returned.
 * No fan-out, no global dirty.
 *
 * idle cost: zero — no polling, no timers. Drain is a simple Set intersection.
 */

import type { IngressEventSource, IngressReason } from "./candidate-ingress.js";

export interface VisualIngressSource extends IngressEventSource {
  /**
   * Mark a target key as needing refresh.
   * Typically called by the GPU visual pipeline when a tracked ROI changes.
   * In Phase 2, callers invoke this manually to trigger a visual cache refresh.
   */
  markDirty(targetKey: string, reason?: IngressReason): void;
}

export function createVisualIngressSource(): VisualIngressSource {
  const pending = new Map<string, IngressReason>();

  return {
    markDirty(targetKey: string, reason: IngressReason = "dirty-rect"): void {
      pending.set(targetKey, reason);
    },

    async drain(knownKeys: ReadonlySet<string>): Promise<Iterable<{ key: string; reason: IngressReason }>> {
      if (pending.size === 0) return [];

      const result: Array<{ key: string; reason: IngressReason }> = [];
      for (const [key, reason] of pending) {
        if (knownKeys.has(key)) {
          result.push({ key, reason });
        }
      }
      pending.clear();
      return result;
    },

    dispose(): void {
      pending.clear();
    },
  };
}
