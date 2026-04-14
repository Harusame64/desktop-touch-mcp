/**
 * window-cache.ts — Lightweight window position cache for homing correction
 *
 * Stores window positions as observed at the time of the last screenshot /
 * get_windows / workspace_snapshot call. At mouse action time, the cache
 * allows us to detect whether a window moved since the LLM last saw it and
 * apply a simple (dx, dy) offset correction — sub-millisecond cost.
 */

import type { WindowZInfo } from "./win32.js";
import { getWindowRectByHwnd } from "./win32.js";

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
export const WINDOW_CACHE_TTL_EXPORTED_MS = CACHE_TTL_MS;

/** Get the timestamp this hwnd was last cached, or null if not cached. */
export function getWindowCacheTimestamp(hwnd: bigint): number | null {
  return cache.get(String(hwnd))?.timestamp ?? null;
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
 * Find the cached window that contains the given screen coordinate.
 * Searches in Z-order (lowest zOrder = frontmost) so overlapping windows
 * resolve to the topmost one — matching what the LLM saw in the screenshot.
 * Returns null if no cached window contains the point.
 */
export function findContainingWindow(x: number, y: number): CachedWindow | null {
  let best: CachedWindow | null = null;
  let bestZ = Infinity;
  for (const w of cache.values()) {
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
 * Look up a cached window by partial title match (case-insensitive).
 * Returns the frontmost match (lowest zOrder).
 */
export function getCachedWindowByTitle(title: string): CachedWindow | null {
  const query = title.toLowerCase();
  let best: CachedWindow | null = null;
  let bestZ = Infinity;
  for (const w of cache.values()) {
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
