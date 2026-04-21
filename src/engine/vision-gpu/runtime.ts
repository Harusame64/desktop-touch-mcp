/**
 * runtime.ts — VisualRuntime: process-level coordinator for the GPU visual lane.
 *
 * Wraps a VisualBackend and exposes a stable API to the TS control plane
 * (visual-provider, visual-ingress) without leaking backend internals.
 *
 * The runtime is a process singleton. One backend is attached at server startup
 * (or during test setup). Multiple targets share the same backend.
 *
 * Lifecycle:
 *   getVisualRuntime()        — always returns the singleton (creates if needed)
 *   runtime.attach(backend)   — wire in a backend (MockVisualBackend for P3-A/B/C,
 *                               SidecarBackend for P3-D)
 *   runtime.dispose()         — detach backend, reset to unavailable
 *   _resetVisualRuntimeForTest() — for test isolation
 */

import type { WarmTarget, WarmState, UiEntityCandidate } from "./types.js";
import type { VisualBackend } from "./backend.js";

// ── VisualRuntime ─────────────────────────────────────────────────────────────

export class VisualRuntime {
  private _backend: VisualBackend | null = null;

  /**
   * Attach a backend, disposing the previous one first.
   * Must be awaited — the old backend may hold OS-level resources (sidecar process, GPU handles).
   */
  async attach(backend: VisualBackend): Promise<void> {
    const old = this._backend;
    this._backend = backend;
    if (old) await old.dispose();
  }

  /** Detach the backend without disposing it. */
  detach(): void {
    this._backend = null;
  }

  /** True when a backend is attached and ready to serve requests. */
  isAvailable(): boolean {
    return this._backend !== null;
  }

  async ensureWarm(target: WarmTarget): Promise<WarmState> {
    if (!this._backend) return "cold";
    return this._backend.ensureWarm(target);
  }

  async getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]> {
    if (!this._backend) return [];
    return this._backend.getStableCandidates(targetKey);
  }

  /**
   * Subscribe to dirty signals from the backend.
   * Returns unsubscribe function. No-op when no backend is attached.
   */
  onDirty(cb: (targetKey: string) => void): () => void {
    if (!this._backend) return () => {};
    return this._backend.onDirty(cb);
  }

  /** Dispose the backend and detach. */
  async dispose(): Promise<void> {
    const b = this._backend;
    this._backend = null;
    await b?.dispose();
  }
}

// ── Process-level singleton ───────────────────────────────────────────────────

let _instance: VisualRuntime | undefined;

/**
 * Return the process-level VisualRuntime.
 * The runtime is unavailable (isAvailable() === false) until attach() is called.
 */
export function getVisualRuntime(): VisualRuntime {
  if (!_instance) _instance = new VisualRuntime();
  return _instance;
}

/** Reset the singleton (for test isolation only). */
export function _resetVisualRuntimeForTest(): void {
  _instance = undefined;
}

// ── Target key → WarmTarget conversion ───────────────────────────────────────

/**
 * Convert a TargetSessionKey to a WarmTarget for backend warmup calls.
 *
 * Mapping:
 *   tab:{tabId}    → { kind: "browser",  id: tabId }
 *   window:{hwnd}  → { kind: "game",     id: hwnd }   — "game" = generic native window
 *   title:{title}  → { kind: "game",     id: title }
 *
 * NOTE: `WarmTarget.kind === "game"` does NOT exclusively mean a 3D game. It means
 * "a native window target that the visual lane will treat via the GPU/ROI pipeline".
 * Terminal windows routed via HWND also receive kind="game" for now.
 *
 * TODO (P3-D): add terminal detection and emit kind="terminal" for terminal windows.
 * The SidecarBackend can then apply a lighter warmup path for terminal targets.
 */
export function targetKeyToWarmTarget(targetKey: string): WarmTarget {
  if (targetKey.startsWith("tab:")) {
    return { kind: "browser", id: targetKey.slice(4) };
  }
  if (targetKey.startsWith("title:")) {
    return { kind: "game", id: targetKey.slice(6) };
  }
  if (targetKey.startsWith("window:")) {
    return { kind: "game", id: targetKey.slice(7) };
  }
  return { kind: "game", id: targetKey };
}
