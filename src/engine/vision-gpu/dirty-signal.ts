/**
 * dirty-signal.ts — Utility for the GPU pipeline to push dirty signals to the ingress.
 *
 * Phase 3-C: the visual lane needs a way to say "target X changed, refresh its candidates"
 * without knowing about the ingress architecture. This module provides a lightweight
 * process-global push API that the ROI tracker / CandidateProducer can call.
 *
 * Usage (P3-D integration):
 *   import { pushDirtySignal } from "./dirty-signal.js";
 *   // After CandidateProducer produces new stable candidates for a window:
 *   pushDirtySignal("window:hwnd-game");
 *
 * Internally this calls PocVisualBackend.updateSnapshot() — the backend then fires
 * its dirty listeners which are wired to VisualIngressSource.markDirty().
 *
 * Target isolation:
 *   Only the specified targetKey is marked dirty. Unrelated targets are unaffected.
 *   The targetKey must match the TargetSessionKey format (window:/tab:/title:).
 *
 * Idle cost: zero. pushDirtySignal() is a synchronous Map write. No background polling.
 */

import type { UiEntityCandidate } from "./types.js";

export type DirtySignalHandler = (targetKey: string, candidates: UiEntityCandidate[]) => void;

/** Process-level dirty signal receivers. */
const handlers = new Set<DirtySignalHandler>();

/**
 * Register a handler to receive dirty signals.
 * Returns an unsubscribe function.
 *
 * Called by desktop-register.ts to wire PocVisualBackend.updateSnapshot().
 */
export function onDirtySignal(handler: DirtySignalHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Push a dirty signal for a target key, optionally with updated candidates.
 *
 * Called by the GPU pipeline (P3-D: ROI tracker → CandidateProducer → here).
 * When candidates are provided, the registered handler updates the snapshot and
 * fires the ingress invalidation. When empty, only the dirty mark is sent.
 */
export function pushDirtySignal(targetKey: string, candidates: UiEntityCandidate[] = []): void {
  for (const handler of handlers) {
    try {
      handler(targetKey, candidates);
    } catch {
      /* best-effort: one failing handler doesn't block others */
    }
  }
}

/** Clear all handlers (for test isolation). */
export function _clearDirtySignalHandlersForTest(): void {
  handlers.clear();
}
