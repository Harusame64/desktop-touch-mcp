/**
 * window-cache.ts — Lightweight window position cache for homing correction
 *
 * Stores window positions as observed at the time of the last screenshot /
 * get_windows / workspace_snapshot call. At mouse action time, the cache
 * allows us to detect whether a window moved since the LLM last saw it and
 * apply a simple (dx, dy) offset correction — sub-millisecond cost.
 */

import type { WindowZInfo } from "./win32.js";
import { getWindowRectByHwnd, enumWindowsInZOrder } from "./win32.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CachedWindow {
  hwnd: bigint;
  title: string;
  region: { x: number; y: number; width: number; height: number };
  zOrder: number;
  timestamp: number;
}

export interface WindowDelta {
  dx: number;
  dy: number;
  /** true if the window's size changed — simple offset correction is unreliable */
  sizeChanged: boolean;
}

// ─── Cache store ──────────────────────────────────────────────────────────────

// keyed by hwnd (as string, since Map<bigint> works but string avoids coercion issues)
const cache = new Map<string, CachedWindow>();

/** Cache entries older than this are treated as stale — HWND may have been recycled. */
const CACHE_TTL_MS = 60_000;

/**
 * Snapshot cache: persists screenshot-time window positions by title.
 * Separate from the main cache — NOT mutated by updateWindowCache(),
 * focus_window(), or window_dock(). Only screenshot tools write to it,
 * and only applyHoming reads from it.
 *
 * This guarantees that mouse_click's homing correction always compares
 * against the position the LLM saw in the screenshot, even when other
 * tools have overwritten the main cache between screenshot and click.
 */
const snapshotCache = new Map<string, { region: { x: number; y: number; width: number; height: number }; timestamp: number }>();
// Intentionally LONGER than CACHE_TTL_MS (90s vs 60s). The two TTLs bound
// different things: CACHE_TTL_MS bounds HWND-recycle safety on the *live*
// lookup (applyHoming guards the cached HWND read with it), while
// SNAPSHOT_TTL_MS bounds how old a screenshot *position* we still trust as the
// homing reference. The snapshot stays useful in the 60-90s window precisely
// when the main-cache HWND entry was refreshed within 60s (e.g. by an
// intervening focus_window / window_dock) but the screenshot itself is older.
const SNAPSHOT_TTL_MS = 90_000;

export const WINDOW_CACHE_TTL_EXPORTED_MS = CACHE_TTL_MS;

/** Get the timestamp this hwnd was last cached, or null if not cached. */
export function getWindowCacheTimestamp(hwnd: bigint): number | null {
  return cache.get(String(hwnd))?.timestamp ?? null;
}

/**
 * Save a screenshot-time window position to the snapshot cache.
 * Call from screenshot tools after capturing a single-window screenshot.
 * The snapshot survives mutations to the main cache from focus/dock tools.
 */
export function saveSnapshot(title: string, region: { x: number; y: number; width: number; height: number }): void {
  const key = title.toLowerCase();
  snapshotCache.set(key, { region: { ...region }, timestamp: Date.now() });
}

/**
 * Read a saved screenshot-time position for a given window title.
 * Returns null if never saved or expired (TTL > 90s).
 *
 * Matching is an exact (case-insensitive) key lookup, NOT the substring match
 * used by getCachedWindowByTitle. A snapshot is keyed by the screenshot's
 * effectiveTitle and read back by the mouse_click windowTitle; these coincide
 * for the normal workflow (same title string passed to both), so a caller that
 * uses different title strings for the screenshot and the click simply misses
 * here and degrades to the main-cache path — no incorrect correction results.
 */
export function getSnapshot(title: string): { x: number; y: number; width: number; height: number } | null {
  const key = title.toLowerCase();
  const entry = snapshotCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SNAPSHOT_TTL_MS) {
    snapshotCache.delete(key);
    return null;
  }
  return entry.region;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Update the cache with the current window list.
 * Call this whenever any tool enumerates windows (screenshot, get_windows, etc.)
 */
export function updateWindowCache(windows: WindowZInfo[]): void {
  // Remove windows that are no longer visible
  const liveKeys = new Set(windows.map((w) => String(w.hwnd)));
  for (const key of cache.keys()) {
    if (!liveKeys.has(key)) cache.delete(key);
  }
  // Upsert live windows (skip minimized — their region is zeroed)
  for (const w of windows) {
    if (!w.isMinimized) {
      cache.set(String(w.hwnd), {
        hwnd: w.hwnd,
        title: w.title,
        region: { ...w.region },
        zOrder: w.zOrder,
        timestamp: Date.now(),
      });
    }
  }
}

/**
 * Drop one window from the cache.
 *
 * Called when a resolved HWND turns out to have no readable rect. This is NOT
 * an assertion that the window died — `getWindowRectByHwnd` returns null both
 * for "no such window" and for "the handle could not be read" and does not
 * distinguish them. It is a cache contract: **an entry that cannot be verified
 * stops being an aiming candidate.**
 *
 * The failure modes are asymmetric, which is why the unverifiable case is
 * evicted rather than kept. Evicting a window that was alive but momentarily
 * unreadable costs one explicit `target_not_found`, and the next enumerating
 * tool puts it back. Keeping an entry that cannot be verified costs a **silent
 * click on a stale rectangle** — a window that closed leaves its rectangle
 * behind, and the next click aimed anywhere inside it lands on whatever is
 * there now, with no warning at all.
 *
 * Returns whether an entry was actually removed.
 */
export function evictWindowFromCache(hwnd: bigint): boolean {
  return cache.delete(String(hwnd));
}

/**
 * Is this entry still young enough to aim with?
 *
 * The aiming lookups below used to ignore timestamps entirely — `CACHE_TTL_MS`
 * was applied only by `computeWindowDelta` and by `applyHoming`'s own checks —
 * so a rectangle left behind by a closed window kept catching clicks
 * **indefinitely**, until some tool happened to enumerate windows and prune it.
 * That is the mechanism behind "clicks start getting rejected and only
 * reconnecting fixes it": nothing in the click path expires a stale rectangle,
 * and reconnecting restarts the process, which is what actually clears it.
 */
function isFresh(w: CachedWindow, now: number): boolean {
  return now - w.timestamp <= CACHE_TTL_MS;
}

/**
 * Find the cached window that contains the given screen coordinate.
 * Searches in Z-order (lowest zOrder = frontmost) so overlapping windows
 * resolve to the topmost one — matching what the LLM saw in the screenshot.
 * Returns null if no cached window contains the point.
 *
 * Entries older than `CACHE_TTL_MS` are not candidates (see {@link isFresh}).
 */
export function findContainingWindow(x: number, y: number): CachedWindow | null {
  const now = Date.now();
  let best: CachedWindow | null = null;
  let bestZ = Infinity;
  for (const w of cache.values()) {
    if (!isFresh(w, now)) continue;
    const r = w.region;
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
      if (w.zOrder < bestZ) {
        best = w;
        bestZ = w.zOrder;
      }
    }
  }
  return best;
}

/**
 * `findContainingWindow`, re-enumerating once when nothing fresh answers.
 *
 * The staleness bound above is only half of the story. Expiring an entry has to
 * mean **"re-verify"**, not **"unclickable"** — otherwise a window that is alive
 * and has not moved becomes unclickable simply because no tool happened to
 * enumerate windows for a minute, and the caller is told the target was not
 * found. Worse, the recovery the guard suggests does not repopulate this cache
 * (only screenshot / window / workspace / browser / mouse tools write to it), so
 * a retry lands in exactly the same place: a refusal loop on a perfectly good
 * window.
 *
 * So a miss re-enumerates once and asks again. The enumeration is the same call
 * every window-listing tool already makes, and it is paid only when the cache
 * cannot answer — which, before the staleness bound existed, was the case where
 * it answered with a rectangle that might belong to a window that had closed.
 *
 * Briefly throttled, because some misses are permanent: a point over the
 * desktop background is inside no window and always will be, so without this
 * every such click would enumerate twice (here, and again in the sensor refresh
 * that follows). The window a caller just opened is still found — the throttle
 * is short enough to be invisible at the rate an agent issues clicks.
 *
 * **Answers from the enumeration without writing it back.** Refreshing the
 * cache here would look like the obvious thing and would quietly break the
 * other job this map does: several screenshot modes seed only this cache and no
 * snapshot, which makes the region stored here the reference `applyHoming`
 * measures a window's movement against. Overwriting every region with its
 * current one makes that comparison a window against itself — a zero delta —
 * so coordinates read off a screenshot stop being corrected after the window
 * moves. One map is serving two purposes with opposite freshness requirements;
 * until they are separated, the aiming question is answered from live data and
 * the stored regions are left alone.
 */
const REFRESH_ON_MISS_THROTTLE_MS = 250;
let _lastMissRefreshAtMs = 0;

export function findContainingWindowFresh(x: number, y: number): CachedWindow | null {
  const hit = findContainingWindow(x, y);
  if (hit) return hit;
  const now = Date.now();
  if (now - _lastMissRefreshAtMs <= REFRESH_ON_MISS_THROTTLE_MS) return null;
  _lastMissRefreshAtMs = now;
  let live: WindowZInfo[];
  try {
    live = enumWindowsInZOrder();
  } catch {
    // Enumeration unavailable (no native addon) — fall through with what we have.
    return null;
  }
  // Frontmost (lowest zOrder) live window containing the point. Minimized
  // windows are skipped for the same reason `updateWindowCache` refuses to
  // store them: their region is zeroed and would swallow the origin.
  let best: CachedWindow | null = null;
  let bestZ = Infinity;
  for (const w of live) {
    if (w.isMinimized) continue;
    const r = w.region;
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height && w.zOrder < bestZ) {
      best = { hwnd: w.hwnd, title: w.title, region: { ...r }, zOrder: w.zOrder, timestamp: now };
      bestZ = w.zOrder;
    }
  }
  return best;
}

/** @internal Test-only — forget the last refresh-on-miss so the throttle reopens. */
export function _resetRefreshThrottleForTest(): void {
  _lastMissRefreshAtMs = 0;
}

/**
 * Look up a cached window by partial title match (case-insensitive).
 * Returns the frontmost match (lowest zOrder).
 *
 * Entries older than `CACHE_TTL_MS` are not candidates (see {@link isFresh}).
 */
export function getCachedWindowByTitle(title: string): CachedWindow | null {
  const now = Date.now();
  const query = title.toLowerCase();
  let best: CachedWindow | null = null;
  let bestZ = Infinity;
  for (const w of cache.values()) {
    if (!isFresh(w, now)) continue;
    if (w.title.toLowerCase().includes(query) && w.zOrder < bestZ) {
      best = w;
      bestZ = w.zOrder;
    }
  }
  return best;
}

/**
 * Compute how much a window has moved since it was cached.
 * Calls GetWindowRect (one Win32 call, <1ms) to get the current position.
 * Returns null if the window no longer exists or the cache entry is stale.
 * Stale entries (>60s) are skipped to guard against HWND recycling.
 */
export function computeWindowDelta(hwnd: bigint): WindowDelta | null {
  const cached = cache.get(String(hwnd));
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;

  const current = getWindowRectByHwnd(hwnd);
  if (!current) return null; // window closed

  const dx = current.x - cached.region.x;
  const dy = current.y - cached.region.y;
  const sizeChanged =
    current.width !== cached.region.width || current.height !== cached.region.height;

  return { dx, dy, sizeChanged };
}
