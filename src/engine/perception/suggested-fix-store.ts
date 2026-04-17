/**
 * suggested-fix-store.ts — Phase C one-shot SuggestedFix approval store.
 *
 * When runActionGuard detects recoverable drift (e.g. safe.clickCoordinates fails
 * because the window moved), it stores a corrected set of args here as a SuggestedFix.
 * The LLM can approve it by calling mouse_click({ fixId }) within FIX_TTL_MS.
 *
 * Design rules (v3 §7):
 *   - one-shot: consuming a fix marks it consumed; subsequent resolve returns null
 *   - TTL 15s: fixId expires quickly to prevent stale approvals
 *   - targetFingerprint: revalidated at consumption time to prevent applying fix to wrong target
 *   - capacity: max 8 slots; LRU eviction on overflow
 */

import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const FIX_TTL_MS  = 15_000;
export const FIX_MAX_SLOTS = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetFingerprint {
  kind: "window" | "browserTab";
  descriptorKey: string;
  hwnd?: string;
  pid?: number;
  processStartTimeMs?: number;
  tabId?: string;
  url?: string;
}

export interface SuggestedFix {
  fixId: string;
  /** v3 §7.1: all 4 supported tool kinds */
  tool: "mouse_click" | "keyboard_type" | "browser_click_element" | "click_element";
  args: Record<string, unknown>;
  targetFingerprint: TargetFingerprint;
  createdAtMs: number;
  expiresAtMs: number;
  reason: string;
  consumed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal store
// ─────────────────────────────────────────────────────────────────────────────

const _fixes = new Map<string, SuggestedFix>();

// ─────────────────────────────────────────────────────────────────────────────
// LRU eviction
// ─────────────────────────────────────────────────────────────────────────────

function evictOldest(): void {
  if (_fixes.size <= FIX_MAX_SLOTS) return;
  let oldestKey = "";
  let oldestMs = Infinity;
  for (const [k, fix] of _fixes) {
    if (fix.createdAtMs < oldestMs) {
      oldestMs = fix.createdAtMs;
      oldestKey = k;
    }
  }
  if (oldestKey) _fixes.delete(oldestKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store a new SuggestedFix. Returns the stored fix (with generated fixId).
 */
export function storeFix(
  partial: Omit<SuggestedFix, "fixId" | "createdAtMs" | "expiresAtMs" | "consumed">,
  nowMs = Date.now()
): SuggestedFix {
  clearExpiredFixes(nowMs);

  const fix: SuggestedFix = {
    ...partial,
    fixId: `fix-${randomUUID()}`,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + FIX_TTL_MS,
    consumed: false,
  };
  _fixes.set(fix.fixId, fix);

  if (_fixes.size > FIX_MAX_SLOTS) evictOldest();

  return fix;
}

/**
 * Resolve a fixId. Returns null if not found, expired, or consumed.
 */
export function resolveFix(fixId: string, nowMs = Date.now()): SuggestedFix | null {
  const fix = _fixes.get(fixId);
  if (!fix) return null;
  if (nowMs >= fix.expiresAtMs) {
    _fixes.delete(fixId);
    return null;
  }
  if (fix.consumed) return null;
  return fix;
}

/**
 * Mark a fix as consumed. One-shot: cannot be resolved again.
 */
export function consumeFix(fixId: string): void {
  const fix = _fixes.get(fixId);
  if (!fix) return;
  fix.consumed = true;
}

/**
 * Remove expired fixes from the store.
 */
export function clearExpiredFixes(nowMs = Date.now()): void {
  for (const [key, fix] of _fixes) {
    if (nowMs >= fix.expiresAtMs) {
      _fixes.delete(key);
    }
  }
}

/**
 * Get snapshot of all fixes (for debug / tests).
 * @internal
 */
export function getFixSnapshot(): readonly SuggestedFix[] {
  return [..._fixes.values()];
}

/**
 * Reset store for unit tests.
 * @internal
 */
export function _resetFixStoreForTest(): void {
  _fixes.clear();
}
