/**
 * backend.ts — VisualBackend interface: the boundary between TS control plane
 * and the native/sidecar data plane for the GPU visual lane.
 *
 * Implementations:
 *   MockVisualBackend   — in-process mock for testing and P3-A boundary validation
 *   SidecarBackend      — P3-D: delegates to a native sidecar process
 *   OnnxBackend         — P3-D alternative: ONNX Runtime inline backend
 *
 * The TS facade never imports detector/recognizer internals. It only sees this interface.
 */

import type { WarmTarget, WarmState, UiEntityCandidate } from "./types.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface VisualBackend {
  /**
   * Ensure the GPU pipeline is warm for the given target.
   * Returns the resulting warm state. Idempotent — safe to call before every fetch.
   */
  ensureWarm(target: WarmTarget): Promise<WarmState>;

  /**
   * Return a stable candidate snapshot for a target key.
   * Returns [] when warm but no stable tracks yet — NOT an error.
   * The backend is responsible for maintaining track state between calls.
   */
  getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]>;

  /**
   * Subscribe to dirty signals from the backend (e.g. ROI changed, new track stable).
   * Returns an unsubscribe function. Multiple listeners are allowed.
   *
   * Dirty signals cause the ingress to invalidate the target's cache so the next
   * desktop_see call triggers a fresh fetch — this is the "event-first" path.
   */
  onDirty(cb: (targetKey: string) => void): () => void;

  dispose(): Promise<void>;
}

// ── MockVisualBackend ─────────────────────────────────────────────────────────

/**
 * In-process mock backend for tests and P3-A boundary validation.
 *
 * Behavior:
 * - ensureWarm: transitions cold → warm immediately (simulated)
 * - getStableCandidates: returns injected candidates (via setCandidates)
 * - onDirty: listeners are called when triggerDirty() is invoked
 *
 * For P3-D, replace with SidecarBackend or OnnxBackend. The interface is identical.
 */
export class MockVisualBackend implements VisualBackend {
  private state: WarmState = "cold";
  private readonly listeners = new Set<(key: string) => void>();
  private readonly candidateStore = new Map<string, UiEntityCandidate[]>();
  /** Call log — inspect in tests to verify correct WarmTarget is forwarded. */
  readonly warmCalls: WarmTarget[] = [];

  async ensureWarm(target: WarmTarget): Promise<WarmState> {
    this.warmCalls.push(target);
    if (this.state === "cold") this.state = "warm";
    return this.state;
  }

  /** Force the warmup state (for testing evicted/warming paths). */
  forceState(state: WarmState): void { this.state = state; }

  getWarmState(): WarmState { return this.state; }

  async getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]> {
    return this.candidateStore.get(targetKey) ?? [];
  }

  /** Inject candidates for a target key (for test setup). */
  setCandidates(targetKey: string, candidates: UiEntityCandidate[]): void {
    this.candidateStore.set(targetKey, candidates);
  }

  onDirty(cb: (targetKey: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Test helper: fire a dirty signal for a specific target key. */
  triggerDirty(targetKey: string): void {
    for (const cb of this.listeners) cb(targetKey);
  }

  async dispose(): Promise<void> {
    this.state = "evicted";
    this.listeners.clear();
    this.candidateStore.clear();
  }
}
