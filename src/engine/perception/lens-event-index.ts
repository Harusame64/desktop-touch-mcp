/**
 * LensEventIndex — routes WinEvents to only the affected perception lenses.
 *
 * Without this index, every event would trigger a refresh of all lenses
 * (the current polling behavior). The index makes Phase 5 efficient:
 * a foreground event on hwnd X refreshes only lenses tracking X (or
 * all foreground-sensitive lenses, for the foreground notification case).
 *
 * Pure module — no OS imports.
 */

import type { PerceptionLens, WindowIdentity } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Index type
// ─────────────────────────────────────────────────────────────────────────────

export interface LensEventIndex {
  /** hwnd string → Set of lensIds tracking that specific window. */
  byHwnd: Map<string, Set<string>>;
  /** pid number → Set of lensIds tracking a window owned by that process. */
  byPid: Map<number, Set<string>>;
  /** lensIds that maintain `target.foreground` and must be notified on foreground events. */
  foregroundSensitive: Set<string>;
  /** lensIds that maintain `modal.above` and must be notified on z-order/modal events. */
  modalSensitive: Set<string>;
  /** lensIds that maintain `target.zOrder` and must be notified on reorder events. */
  zOrderSensitive: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function addToSet<K>(map: Map<K, Set<string>>, key: K, lensId: string): void {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(lensId);
}

function removeFromSet<K>(map: Map<K, Set<string>>, key: K, lensId: string): void {
  const s = map.get(key);
  if (!s) return;
  s.delete(lensId);
  if (s.size === 0) map.delete(key);
}

function isWindowIdentity(id: unknown): id is WindowIdentity {
  return typeof id === "object" && id !== null && "pid" in id && "hwnd" in id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Create an empty index. */
export function createLensEventIndex(): LensEventIndex {
  return {
    byHwnd: new Map(),
    byPid: new Map(),
    foregroundSensitive: new Set(),
    modalSensitive: new Set(),
    zOrderSensitive: new Set(),
  };
}

/** Add a lens to the index. */
export function addLensToIndex(index: LensEventIndex, lens: PerceptionLens): void {
  const { lensId } = lens;
  const hwnd = lens.binding.hwnd;

  // All lenses go into byHwnd
  addToSet(index.byHwnd, hwnd, lensId);

  // Window lenses also indexed by pid
  if (isWindowIdentity(lens.boundIdentity)) {
    addToSet(index.byPid, lens.boundIdentity.pid, lensId);
  }

  // Sensitivity flags based on maintained fluents
  const maintained = new Set(lens.spec.maintain);
  if (maintained.has("target.foreground")) index.foregroundSensitive.add(lensId);
  if (maintained.has("modal.above"))       index.modalSensitive.add(lensId);
  if (maintained.has("target.zOrder"))     index.zOrderSensitive.add(lensId);
}

/** Remove a lens from the index. */
export function removeLensFromIndex(index: LensEventIndex, lens: PerceptionLens): void {
  const { lensId } = lens;
  const hwnd = lens.binding.hwnd;

  removeFromSet(index.byHwnd, hwnd, lensId);

  if (isWindowIdentity(lens.boundIdentity)) {
    removeFromSet(index.byPid, lens.boundIdentity.pid, lensId);
  }

  index.foregroundSensitive.delete(lensId);
  index.modalSensitive.delete(lensId);
  index.zOrderSensitive.delete(lensId);
}

/** Rebuild the entire index from the current lens collection. */
export function rebuildLensEventIndex(lenses: Iterable<PerceptionLens>): LensEventIndex {
  const index = createLensEventIndex();
  for (const lens of lenses) {
    addLensToIndex(index, lens);
  }
  return index;
}

/**
 * Look up all lensIds that should be refreshed for a hwnd-specific event.
 * Returns lenses bound to the given hwnd.
 */
export function lensesForHwnd(index: LensEventIndex, hwnd: string): Set<string> {
  return index.byHwnd.get(hwnd) ?? new Set();
}

/**
 * Look up all lensIds that should be notified for a foreground change.
 * Includes both the specific hwnd's lenses and all foreground-sensitive lenses
 * (because a foreground change to ANY window affects every lens's `foreground` fluent).
 */
export function lensesForForegroundEvent(
  index: LensEventIndex,
  hwnd: string
): Set<string> {
  const result = new Set<string>();
  // Direct hwnd matches
  for (const id of (index.byHwnd.get(hwnd) ?? [])) result.add(id);
  // All foreground-sensitive lenses (their own foreground state may have changed)
  for (const id of index.foregroundSensitive) result.add(id);
  return result;
}
