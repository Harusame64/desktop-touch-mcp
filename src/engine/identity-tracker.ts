/**
 * identity-tracker.ts
 *
 * Tracks the identity of windows the LLM has interacted with so we can
 * surface "what changed" in tool responses:
 *   - Same HWND but different pid     → hwnd_reused (warning)
 *   - Same title but different pid     → process_restarted
 *   - HWND no longer in EnumWindows    → hwnd_vanished
 *
 * Used by screenshot/click/get_ui_elements responses to populate
 * `hints.target` and `hints.caches.diffBaseline.invalidatedBy`.
 */

import { getProcessIdentityByPid, getWindowProcessId, enumWindowsInZOrder, type ProcessIdentity } from "./win32.js";
import {
  getBaselineTimestamp,
  getUiaCacheTimestamp,
  hasBuffer,
  LAYER_TTL_EXPORTED_MS,
  UIA_CACHE_TTL_EXPORTED_MS,
} from "./layer-buffer.js";
import { getWindowCacheTimestamp, WINDOW_CACHE_TTL_EXPORTED_MS } from "./window-cache.js";

function isHwndStillVisible(hwndStr: string): boolean {
  try {
    return enumWindowsInZOrder().some((w) => String(w.hwnd) === hwndStr);
  } catch {
    return false;
  }
}

export interface TargetIdentity {
  hwnd: string;                  // bigint as decimal string
  pid: number;
  processName: string;
  processStartTimeMs: number;
  titleResolved: string;
  /** ms since epoch when this identity was last observed. */
  lastSeenMs: number;
}

export type InvalidationReason =
  | "ttl"
  | "workspace_snapshot"
  | "manual_clear"
  | "hwnd_vanished"
  | "hwnd_reused"
  | "process_restarted";

export interface CacheStateHints {
  diffBaseline?: {
    exists: boolean;
    ageMs?: number;
    expiresInMs?: number;
    degradedToFull?: boolean;
    invalidatedBy?: InvalidationReason | null;
    previousTarget?: { pid: number; processName: string };
  };
  uiaCache?: { exists: boolean; ageMs?: number; expiresInMs?: number };
  windowLayout?: { ageMs: number; expiresInMs: number };
}

// Per-target-key (lowercase title substring) → last identity observed.
const lastByKey = new Map<string, TargetIdentity>();
// Per-hwnd → last identity observed (for HWND-keyed checks).
const lastByHwnd = new Map<string, TargetIdentity>();

let lastInvalidation: { reason: InvalidationReason; previousTarget?: { pid: number; processName: string } } | null = null;

/**
 * Record an observation of a target. Returns invalidation info if the new
 * observation differs from the previous one for this key/hwnd.
 *
 * @param keyTitle  user-provided partial title (lowercased used as key)
 * @param hwnd      bigint HWND
 * @param resolved  fully resolved window title
 */
export function observeTarget(
  keyTitle: string,
  hwnd: bigint,
  resolved: string
): { identity: TargetIdentity; invalidatedBy: InvalidationReason | null; previousTarget?: { pid: number; processName: string } } {
  const key = keyTitle.toLowerCase();
  const hwndStr = String(hwnd);
  const pid = getWindowProcessId(hwnd);
  const procIdent: ProcessIdentity = getProcessIdentityByPid(pid);

  const ident: TargetIdentity = {
    hwnd: hwndStr,
    pid: procIdent.pid,
    processName: procIdent.processName,
    processStartTimeMs: procIdent.processStartTimeMs,
    titleResolved: resolved,
    lastSeenMs: Date.now(),
  };

  const prevByKey = lastByKey.get(key);
  const prevByHwnd = lastByHwnd.get(hwndStr);

  let invalidatedBy: InvalidationReason | null = null;
  let previousTarget: { pid: number; processName: string } | undefined;

  if (prevByHwnd && prevByHwnd.pid !== ident.pid) {
    invalidatedBy = "hwnd_reused";
    previousTarget = { pid: prevByHwnd.pid, processName: prevByHwnd.processName };
  } else if (prevByKey && prevByKey.hwnd !== hwndStr) {
    // Different HWND for the same title-key. Distinguish concurrent instance
    // vs. process restart by checking whether the previous HWND is still alive.
    const prevHwndStillAlive = isHwndStillVisible(prevByKey.hwnd);
    if (!prevHwndStillAlive && prevByKey.pid !== ident.pid) {
      invalidatedBy = "process_restarted";
      previousTarget = { pid: prevByKey.pid, processName: prevByKey.processName };
    }
    // If prev HWND is still alive: this is a concurrent instance — don't fire
    // process_restarted; just record the new identity silently.
  } else if (
    prevByKey &&
    prevByKey.hwnd === hwndStr &&
    prevByKey.processStartTimeMs !== 0 &&
    ident.processStartTimeMs !== 0 &&
    prevByKey.processStartTimeMs !== ident.processStartTimeMs
  ) {
    // Same HWND key but different process start time = restarted into the same handle.
    invalidatedBy = "process_restarted";
    previousTarget = { pid: prevByKey.pid, processName: prevByKey.processName };
  }

  lastByKey.set(key, ident);
  lastByHwnd.set(hwndStr, ident);

  if (invalidatedBy) {
    lastInvalidation = { reason: invalidatedBy, previousTarget };
  }

  return { identity: ident, invalidatedBy, previousTarget };
}

/** Mark all entries as invalidated by a global event (workspace_snapshot, manual clear). */
export function noteInvalidation(reason: InvalidationReason): void {
  lastInvalidation = { reason };
}

/** Pop the most recent invalidation event (consume). */
export function takeLastInvalidation(): { reason: InvalidationReason; previousTarget?: { pid: number; processName: string } } | null {
  const r = lastInvalidation;
  lastInvalidation = null;
  return r;
}

/** Drop a specific HWND from tracking (e.g. when hwnd_vanished is detected). */
export function dropHwnd(hwnd: bigint): void {
  lastByHwnd.delete(String(hwnd));
}

/** Reset all identity tracking (test helper / explicit clear). */
export function clearIdentities(): void {
  lastByKey.clear();
  lastByHwnd.clear();
  lastInvalidation = null;
}

/**
 * Build the hints.caches block for a tool response.
 * Combines layer-buffer baseline state, UIA cache state, and window-layout cache.
 */
export function buildCacheStateHints(
  hwnd: bigint | null,
  invalidation?: { reason: InvalidationReason; previousTarget?: { pid: number; processName: string } } | null
): CacheStateHints {
  const now = Date.now();
  const out: CacheStateHints = {};

  if (hwnd !== null) {
    const baselineTs = getBaselineTimestamp(hwnd);
    if (baselineTs !== null) {
      const ageMs = now - baselineTs;
      out.diffBaseline = {
        exists: true,
        ageMs,
        expiresInMs: Math.max(0, LAYER_TTL_EXPORTED_MS - ageMs),
      };
    } else {
      out.diffBaseline = { exists: hasBuffer() };
    }

    const uiaTs = getUiaCacheTimestamp(hwnd);
    if (uiaTs !== null) {
      const ageMs = now - uiaTs;
      out.uiaCache = {
        exists: true,
        ageMs,
        expiresInMs: Math.max(0, UIA_CACHE_TTL_EXPORTED_MS - ageMs),
      };
    } else {
      out.uiaCache = { exists: false };
    }

    const layoutTs = getWindowCacheTimestamp(hwnd);
    if (layoutTs !== null) {
      const ageMs = now - layoutTs;
      out.windowLayout = {
        ageMs,
        expiresInMs: Math.max(0, WINDOW_CACHE_TTL_EXPORTED_MS - ageMs),
      };
    }
  }

  if (invalidation && out.diffBaseline) {
    out.diffBaseline.invalidatedBy = invalidation.reason;
    if (invalidation.previousTarget) {
      out.diffBaseline.previousTarget = invalidation.previousTarget;
    }
  }

  return out;
}

/** Public-facing target hints for tool responses (omits lastSeenMs). */
export interface TargetHints {
  hwnd: string;
  pid: number;
  processName: string;
  processStartTimeMs: number;
  titleResolved: string;
}

export function toTargetHints(ident: TargetIdentity): TargetHints {
  return {
    hwnd: ident.hwnd,
    pid: ident.pid,
    processName: ident.processName,
    processStartTimeMs: ident.processStartTimeMs,
    titleResolved: ident.titleResolved,
  };
}

/**
 * One-stop helper for tools that need both target identity and cache hints.
 * Resolves the partial title to an HWND, observes identity, and builds the hints block.
 *
 * Returns null when no window matches — caller should leave hints empty in that case.
 */
export function buildHintsForTitle(partialTitle: string): {
  target: TargetHints;
  caches: CacheStateHints;
  hwnd: bigint;
} | null {
  let resolved: { hwnd: bigint; title: string } | null = null;
  try {
    const wins = enumWindowsInZOrder();
    const q = partialTitle.toLowerCase();
    const found = wins.find((w) => w.title.toLowerCase().includes(q));
    if (found) resolved = { hwnd: found.hwnd, title: found.title };
  } catch { /* ignore */ }
  if (!resolved) return null;
  const obs = observeTarget(partialTitle, resolved.hwnd, resolved.title);
  return {
    target: toTargetHints(obs.identity),
    caches: buildCacheStateHints(
      resolved.hwnd,
      obs.invalidatedBy ? { reason: obs.invalidatedBy, previousTarget: obs.previousTarget } : null
    ),
    hwnd: resolved.hwnd,
  };
}
