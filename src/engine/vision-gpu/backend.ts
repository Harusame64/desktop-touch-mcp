/**
 * backend.ts — VisualBackend interface: the boundary between TS control plane
 * and the native/sidecar data plane for the GPU visual lane.
 *
 * Implementations:
 *   MockVisualBackend  — in-process mock for testing and P3-A boundary validation
 *   PocVisualBackend   — Phase 3 fallback (snapshot store, no detector)
 *   OnnxBackend        — Phase 4a (ADR-005): Rust-internal ort backend via napi
 *
 * The TS facade never imports detector/recognizer internals. It only sees this interface.
 */

import type { WarmTarget, WarmState, UiEntityCandidate, RoiInput } from "./types.js";

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
   * desktop_discover call triggers a fresh fetch — this is the "event-first" path.
   */
  onDirty(cb: (targetKey: string) => void): () => void;

  /**
   * Recognise UI elements inside the given ROIs (ADR-005 D1' Phase 4a+).
   *
   * Optional because pre-Phase-4 backends (PocVisualBackend, MockVisualBackend)
   * have no detector — they receive candidates pushed via updateSnapshot()
   * instead. Phase 4 backends (OnnxBackend) implement this to perform actual
   * inference. Callers must check for presence with `if (backend.recognizeRois)`
   * before invoking.
   *
   * Phase 4a: returns dummy candidates (one per input ROI, empty label).
   * Phase 4b: real ort::Session inference via Rust napi binding.
   *
   * Always non-throwing: backend errors / inference panics surface as an empty
   * array, never as a rejected Promise. The MCP server stays alive (L5).
   */
  recognizeRois?(
    targetKey: string,
    rois: RoiInput[],
    frameWidth?: number,
    frameHeight?: number,
    frameBuffer?: Buffer,  // Phase 4b-5a-1 addition (optional, backward-compat)
  ): Promise<UiEntityCandidate[]>;

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
