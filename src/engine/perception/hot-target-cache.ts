/**
 * hot-target-cache.ts — Phase B short-term target descriptor cache.
 *
 * Keyed by descriptor string (e.g. "window:notepad", "browserTab:abc123").
 * Hidden from model — not exposed by any tool, not in get_history.
 *
 * Design rules (v3 §6):
 *   - descriptor-bound, NOT identity-bound (same slot survives HWND change)
 *   - TTL extended only on model action touch, NOT background sensor activity
 *   - coordinate-only descriptors are NOT cached
 *   - does NOT consume manual lens budget (separate Map)
 *   - LRU eviction when > HOT_MAX_SLOTS
 */

import type { ActionTargetDescriptor } from "./action-target.js";
import type { WindowIdentity, BrowserTabIdentity } from "./types.js";
import { deriveTargetKey } from "./action-target.js";

// ─────────────────────────────────────────────────────────────────────────────
// TTL constants
// ─────────────────────────────────────────────────────────────────────────────

export const HOT_IDLE_TTL_MS  = 90_000;   // 90 seconds — covers ~3-5 agent turns
export const HOT_HARD_TTL_MS  = 600_000;  // 10 minutes — beyond this, always re-verify
export const HOT_BAD_TTL_MS   = 15_000;   // 15 seconds — cool-down after markBad
export const HOT_MAX_SLOTS    = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SlotAttention =
  | "ok"
  | "changed"
  | "dirty"
  | "stale"
  | "identity_changed"
  | "not_found"
  | "ambiguous";

export interface HotTargetSlot {
  key: string;
  kind: "window" | "browserTab";
  descriptor: ActionTargetDescriptor;
  identity: WindowIdentity | BrowserTabIdentity | null;
  lastRect?: { x: number; y: number; width: number; height: number };
  lastTitle?: string;
  lastUsedAtMs: number;
  createdAtMs: number;
  useCount: number;
  attention: SlotAttention;
  badUntilMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal store
// ─────────────────────────────────────────────────────────────────────────────

const _slots = new Map<string, HotTargetSlot>();

// ─────────────────────────────────────────────────────────────────────────────
// Key derivation
// ─────────────────────────────────────────────────────────────────────────────

// key derivation is now shared via deriveTargetKey from action-target.ts
const descriptorKey = deriveTargetKey;

// ─────────────────────────────────────────────────────────────────────────────
// TTL helpers
// ─────────────────────────────────────────────────────────────────────────────

function isExpired(slot: HotTargetSlot, nowMs: number): boolean {
  // Hard TTL: evict regardless of activity
  if (nowMs - slot.createdAtMs > HOT_HARD_TTL_MS) return true;
  // Idle TTL: evict if not touched recently
  if (nowMs - slot.lastUsedAtMs > HOT_IDLE_TTL_MS) return true;
  return false;
}

function isBad(slot: HotTargetSlot, nowMs: number): boolean {
  return slot.badUntilMs !== undefined && nowMs < slot.badUntilMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// LRU eviction
// ─────────────────────────────────────────────────────────────────────────────

function evictLRU(): void {
  if (_slots.size <= HOT_MAX_SLOTS) return;
  let oldestKey = "";
  let oldestTs = Infinity;
  for (const [k, slot] of _slots) {
    if (slot.lastUsedAtMs < oldestTs) {
      oldestTs = slot.lastUsedAtMs;
      oldestKey = k;
    }
  }
  if (oldestKey) _slots.delete(oldestKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get existing slot or create a new one for the given descriptor.
 * Returns null for coordinate-only descriptors (not cached).
 * Removes expired/bad slots before returning.
 */
export function getOrCreateSlot(
  descriptor: ActionTargetDescriptor,
  nowMs = Date.now()
): HotTargetSlot | null {
  const key = descriptorKey(descriptor);
  if (!key) return null;  // coordinate-only: not cached

  // Remove expired slots first (lightweight sweep)
  clearExpired(nowMs);

  const existing = _slots.get(key);
  if (existing && !isBad(existing, nowMs)) {
    return existing;
  }

  // Create new slot
  const kind: "window" | "browserTab" =
    descriptor.kind === "window" ? "window" : "browserTab";

  const slot: HotTargetSlot = {
    key,
    kind,
    descriptor,
    identity: null,
    lastUsedAtMs: nowMs,
    createdAtMs: nowMs,
    useCount: 0,
    attention: "ok",
  };
  _slots.set(key, slot);

  // Enforce capacity
  if (_slots.size > HOT_MAX_SLOTS) evictLRU();

  return _slots.get(key) ?? null;
}

/**
 * Update fields in an existing slot (model action touch — extends TTL).
 * Only call this from action paths, NOT from background sensor loops.
 */
export function updateSlot(
  key: string,
  patch: Partial<Omit<HotTargetSlot, "key" | "kind" | "createdAtMs">>,
  nowMs = Date.now()
): void {
  const slot = _slots.get(key);
  if (!slot) return;
  Object.assign(slot, patch);
  // Always refresh lastUsedAtMs on update (model action touch)
  slot.lastUsedAtMs = nowMs;
}

/**
 * Mark a slot as bad (e.g. resolution failed or guard blocked).
 * Bad slots are skipped for HOT_BAD_TTL_MS then recycled.
 */
export function markBad(key: string, reason: string, nowMs = Date.now()): void {
  const slot = _slots.get(key);
  if (!slot) return;
  slot.attention = "not_found";
  slot.badUntilMs = nowMs + HOT_BAD_TTL_MS;
  void reason; // for debugging — not stored to keep slot compact
}

/**
 * Remove all expired or bad-TTL-expired slots.
 * Cheap sweep: O(n) where n ≤ HOT_MAX_SLOTS (always ≤ 6).
 */
export function clearExpired(nowMs = Date.now()): void {
  for (const [key, slot] of _slots) {
    if (isExpired(slot, nowMs)) {
      _slots.delete(key);
    } else if (slot.badUntilMs !== undefined && nowMs >= slot.badUntilMs) {
      // Bad TTL expired — remove so it can be re-created fresh
      _slots.delete(key);
    }
  }
}

/**
 * Get a snapshot of all current slots (for debug / tests).
 * Does NOT update lastUsedAtMs.
 */
export function getSlotSnapshot(): readonly HotTargetSlot[] {
  return [..._slots.values()];
}

/**
 * Reset store for unit tests.
 * @internal
 */
export function _resetForTest(): void {
  _slots.clear();
}
