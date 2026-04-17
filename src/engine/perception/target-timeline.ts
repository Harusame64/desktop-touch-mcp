/**
 * target-timeline.ts — Phase D Target-Identity Timeline (v3 §6.3)
 *
 * Stores semantic facts about what happened to each target over its lifetime.
 * Two-layer structure:
 *   - _eventsByKey: Map<targetKey, ring[]>  (per-target ring, max TARGET_RING_MAX = 32)
 *   - _globalOrder: array                   (global FIFO cap, max GLOBAL_EVENTS_MAX = 256)
 *
 * Deduplication/debounce: sensor-sourced events are suppressed when the same
 * (targetKey, semantic) fired within DEBOUNCE_WINDOW_MS. action/post/manual_lens
 * sources are never debounced — they carry failure trace.
 *
 * Compaction: compactOlderThan() groups old events per key into a single
 * "compacted" summary event. startCompactionSweeper() runs this periodically.
 */

import { randomUUID } from "node:crypto";
import type { WindowIdentity, BrowserTabIdentity, PerceptionLens } from "./types.js";
import type { ActionTargetDescriptor } from "./action-target.js";
import { deriveTargetKey as _deriveTargetKey, normalizeTitle } from "./action-target.js";

// ─────────────────────────────────────────────────────────────────────────────
// Re-export deriveTargetKey so callers only need one import
// ─────────────────────────────────────────────────────────────────────────────

export { _deriveTargetKey as deriveTargetKey };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const TARGET_RING_MAX = 32;
export const GLOBAL_EVENTS_MAX = 256;
export const DEBOUNCE_WINDOW_MS = 200;
export const COMPACT_AFTER_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineSemantic =
  | "target_bound"
  | "action_attempted"
  | "action_succeeded"
  | "action_blocked"
  | "title_changed"
  | "rect_changed"
  | "foreground_changed"
  | "navigation"
  | "modal_appeared"
  | "modal_dismissed"
  | "identity_changed"
  | "target_closed"
  | "compacted";

export interface TargetIdentityTimelineEvent {
  eventId: string;
  tsMs: number;
  targetKey: string;
  identity: WindowIdentity | BrowserTabIdentity | null;
  descriptor?: ActionTargetDescriptor;
  source: "action_guard" | "manual_lens" | "post_check" | "sensor";
  semantic: TimelineSemantic;
  summary: string;
  tool?: string;
  result?: "ok" | "blocked" | "failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────────────────────

const _eventsByKey = new Map<string, TargetIdentityTimelineEvent[]>();
const _globalOrder: TargetIdentityTimelineEvent[] = [];
// Leading-edge debounce state: sensor-only, keyed by "${targetKey}:${semantic}"
const _lastEmitAt = new Map<string, number>();
// Subscription handles keyed by targetKey
const _subscribers = new Map<string, Set<(ev: TargetIdentityTimelineEvent) => void>>();
// Global listeners that receive every appended event (used by resource notifier)
const _globalListeners = new Set<(ev: TargetIdentityTimelineEvent) => void>();

// ─────────────────────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a timeline event. Returns the stored event, or null if suppressed by debounce.
 * Sensor-sourced events are debounced per (targetKey, semantic) with DEBOUNCE_WINDOW_MS.
 * All other sources (action_guard, post_check, manual_lens) are never debounced.
 */
export function appendEvent(
  partial: Omit<TargetIdentityTimelineEvent, "eventId" | "tsMs"> & { tsMs?: number }
): TargetIdentityTimelineEvent | null {
  const tsMs = partial.tsMs ?? Date.now();

  // Debounce sensor events only
  if (partial.source === "sensor") {
    const dbKey = `${partial.targetKey}:${partial.semantic}`;
    const last = _lastEmitAt.get(dbKey);
    if (last !== undefined && tsMs - last < DEBOUNCE_WINDOW_MS) {
      return null;  // suppressed
    }
    _lastEmitAt.set(dbKey, tsMs);
  }

  const ev: TargetIdentityTimelineEvent = {
    ...partial,
    eventId: `evt-${randomUUID()}`,
    tsMs,
  };

  // Per-key ring: append and trim to TARGET_RING_MAX
  let ring = _eventsByKey.get(ev.targetKey);
  if (!ring) {
    ring = [];
    _eventsByKey.set(ev.targetKey, ring);
  }
  ring.push(ev);
  if (ring.length > TARGET_RING_MAX) {
    ring.shift();
  }

  // Global FIFO: append and evict oldest when over cap
  _globalOrder.push(ev);
  if (_globalOrder.length > GLOBAL_EVENTS_MAX) {
    const dropped = _globalOrder.shift();
    if (dropped) {
      // Also remove from per-key ring to keep both structures consistent
      const dr = _eventsByKey.get(dropped.targetKey);
      if (dr) {
        const idx = dr.findIndex(e => e.eventId === dropped.eventId);
        if (idx >= 0) dr.splice(idx, 1);
        if (dr.length === 0) _eventsByKey.delete(dropped.targetKey);
      }
    }
  }

  // Notify per-key subscribers
  const subs = _subscribers.get(ev.targetKey);
  if (subs) {
    for (const fn of subs) {
      try { fn(ev); } catch { /* subscriber errors must not affect the store */ }
    }
  }

  // Notify global listeners
  for (const fn of _globalListeners) {
    try { fn(ev); } catch { /* non-fatal */ }
  }

  return ev;
}

/**
 * List up to n most-recent events for a given target key.
 */
export function listEventsForTarget(key: string, n = 10): TargetIdentityTimelineEvent[] {
  const ring = _eventsByKey.get(key);
  if (!ring) return [];
  return ring.slice(-n);
}

/**
 * List the n most recently active target keys (newest first).
 */
export function listRecentTargetKeys(n = 5): string[] {
  const seen = new Set<string>();
  for (let i = _globalOrder.length - 1; i >= 0 && seen.size < n; i--) {
    seen.add(_globalOrder[i].targetKey);
  }
  return [...seen];
}

/**
 * List the n most recent events across all targets.
 */
export function listAllRecent(n: number): TargetIdentityTimelineEvent[] {
  return _globalOrder.slice(-n);
}

/**
 * Subscribe to new events for a specific target key.
 * Returns an unsubscribe function.
 */
export function subscribe(
  targetKey: string,
  fn: (ev: TargetIdentityTimelineEvent) => void
): () => void {
  let set = _subscribers.get(targetKey);
  if (!set) {
    set = new Set();
    _subscribers.set(targetKey, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) _subscribers.delete(targetKey);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Target key helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a stable target key from a PerceptionLens.
 * Used by perception_read to correlate lens targets with timeline events.
 */
export function deriveLensTargetKey(lens: PerceptionLens): string {
  const spec = lens.spec;
  if (spec.target.kind === "window") {
    return `window:${normalizeTitle(spec.target.match.titleIncludes)}`;
  }
  if (spec.target.kind === "browserTab") {
    // Use the binding hwnd which stores the CDP tabId for browser tabs
    return `browserTab:${lens.binding.hwnd.toLowerCase()}`;
  }
  return `unknown:${lens.lensId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact events older than olderThanMs into a single "compacted" summary event
 * per target key. Idempotent: re-running on already-compacted data is a no-op.
 */
export function compactOlderThan(olderThanMs: number, nowMs = Date.now()): void {
  const cutoff = nowMs - olderThanMs;

  for (const [key, ring] of _eventsByKey) {
    const old = ring.filter(e => e.tsMs < cutoff && e.semantic !== "compacted");
    if (old.length <= 1) continue;  // nothing worth compacting

    // Count semantics
    const counts = new Map<TimelineSemantic, number>();
    for (const e of old) {
      counts.set(e.semantic, (counts.get(e.semantic) ?? 0) + 1);
    }
    const summary = [...counts]
      .map(([s, c]) => `${c} ${s}`)
      .join(", ")
      + ` (compacted over ${Math.round(olderThanMs / 60000)} min)`;

    const compactedEv: TargetIdentityTimelineEvent = {
      eventId: `evt-${randomUUID()}`,
      tsMs: old[0].tsMs,
      targetKey: key,
      identity: null,
      source: old[0].source,
      semantic: "compacted",
      summary,
    };

    // Replace old events in per-key ring
    const kept = ring.filter(e => !(e.tsMs < cutoff && e.semantic !== "compacted"));
    const newRing = [compactedEv, ...kept];
    _eventsByKey.set(key, newRing);

    // Remove old events from _globalOrder and append the compacted marker
    const oldIds = new Set(old.map(e => e.eventId));
    for (let i = _globalOrder.length - 1; i >= 0; i--) {
      if (oldIds.has(_globalOrder[i].eventId)) {
        _globalOrder.splice(i, 1);
      }
    }
    _globalOrder.push(compactedEv);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction sweeper
// ─────────────────────────────────────────────────────────────────────────────

let _compactionTimer: ReturnType<typeof setInterval> | null = null;

export function startCompactionSweeper(periodMs = 10 * 60 * 1000): void {
  if (_compactionTimer) return;
  _compactionTimer = setInterval(() => compactOlderThan(COMPACT_AFTER_MS), periodMs);
  if (_compactionTimer.unref) _compactionTimer.unref();
}

export function stopCompactionSweeper(): void {
  if (_compactionTimer) {
    clearInterval(_compactionTimer);
    _compactionTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to ALL timeline events regardless of target key.
 * Used by perception-resources.ts to drive MCP resource notifications.
 */
export function subscribeGlobal(fn: (ev: TargetIdentityTimelineEvent) => void): () => void {
  _globalListeners.add(fn);
  return () => _globalListeners.delete(fn);
}

export function _resetForTest(): void {
  _eventsByKey.clear();
  _globalOrder.length = 0;
  _lastEmitAt.clear();
  _subscribers.clear();
  _globalListeners.clear();
  stopCompactionSweeper();
}
