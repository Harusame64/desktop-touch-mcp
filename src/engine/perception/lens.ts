/**
 * Lens compilation and binding resolution.
 * Pure functions — no OS imports. Callers inject window snapshots.
 */

import type {
  LensSpec,
  PerceptionLens,
  ResolvedBinding,
  WindowIdentity,
} from "./types.js";

export interface WindowSnapshot {
  hwnd: string;      // bigint as decimal
  title: string;
  zOrder: number;
  isActive: boolean;
  pid?: number;
  processName?: string;
  processStartTimeMs?: number;
}

let _lensCounter = 0;

/** Generate a stable lens ID. Use the injectable seed in tests. */
export function nextLensId(seed?: () => string): string {
  return seed ? seed() : `perc-${++_lensCounter}`;
}

export function resetLensCounter(): void { _lensCounter = 0; }

/**
 * Build the concrete fluent-store key for a given fluent kind on a bound window.
 * Format: "window:<hwnd>.<property>"
 */
export function fluentKeyFor(hwnd: string, property: string): string {
  return `window:${hwnd}.${property}`;
}

/**
 * Expand a lens's maintain list into concrete fluent-store keys using the resolved binding.
 */
export function expandFluentKeys(lens: Pick<PerceptionLens, "spec" | "binding">): string[] {
  const { hwnd } = lens.binding;
  return lens.spec.maintain.map(kind => fluentKeyFor(hwnd, kind));
}

/**
 * Find the best-matching window for a lens target spec from a live snapshot.
 *
 * Selection strategy:
 *   1. Foreground (isActive) window that matches titleIncludes — highest priority
 *   2. Any visible window with lowest zOrder (frontmost) that matches
 *
 * Returns null when no window matches.
 */
export function resolveBindingFromSnapshot(
  spec: LensSpec,
  windows: WindowSnapshot[]
): ResolvedBinding | null {
  const needle = spec.target.match.titleIncludes.toLowerCase();
  const candidates = windows.filter(w => w.title.toLowerCase().includes(needle));
  if (candidates.length === 0) return null;

  const foreground = candidates.find(w => w.isActive);
  const best = foreground ?? candidates.sort((a, b) => a.zOrder - b.zOrder)[0]!;
  return { hwnd: best.hwnd, windowTitle: best.title };
}

/**
 * Compile a raw lens spec and initial binding into a PerceptionLens.
 * Assumes binding has already been resolved (call resolveBindingFromSnapshot first).
 */
export function compileLens(
  spec: LensSpec,
  binding: ResolvedBinding,
  boundIdentity: WindowIdentity,
  seq: number,
  idSeed?: () => string
): PerceptionLens {
  const lensId = nextLensId(idSeed);
  const draft: Pick<PerceptionLens, "spec" | "binding"> = { spec, binding };
  return {
    lensId,
    spec,
    binding,
    boundIdentity,
    fluentKeys: expandFluentKeys(draft),
    registeredAtSeq: seq,
    registeredAtMs: Date.now(),
  };
}
