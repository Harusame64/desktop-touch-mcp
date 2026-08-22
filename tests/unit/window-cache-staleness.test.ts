/**
 * tests/unit/window-cache-staleness.test.ts
 *
 * The "afterimage" fixes: a window that has gone away must stop catching
 * clicks.
 *
 * Two mechanisms let a dead window keep aiming, and both are pinned here:
 *
 *   1. **No expiry on the aiming lookups.** `findContainingWindow` and
 *      `getCachedWindowByTitle` used to walk the cache without looking at
 *      timestamps at all — `CACHE_TTL_MS` was applied only by
 *      `computeWindowDelta` and by `applyHoming`'s own guards. So a rectangle
 *      left behind by a closed window kept catching clicks indefinitely, until
 *      some tool happened to enumerate windows and prune it. That is what makes
 *      the symptom persist until the server is restarted: reconnecting drops
 *      the whole in-process cache, which is the only thing that reliably
 *      cleared it.
 *   2. **No eviction when a handle stops answering.** Nothing removed an entry
 *      at the moment its rectangle became unreadable.
 *
 * The deliberate asymmetry, worth stating because it is what the tests encode:
 * evicting a window that was alive but momentarily unreadable costs one
 * explicit `target_not_found`, and the next enumerating tool puts it back.
 * Keeping it costs a silent click on whatever now occupies that rectangle.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  updateWindowCache,
  findContainingWindow,
  getCachedWindowByTitle,
  evictWindowFromCache,
  WINDOW_CACHE_TTL_EXPORTED_MS,
} from "../../src/engine/window-cache.js";
import type { WindowZInfo } from "../../src/engine/win32.js";

afterEach(() => {
  vi.useRealTimers();
});

function win(hwnd: bigint, title: string, region: { x: number; y: number; width: number; height: number }, zOrder = 0): WindowZInfo {
  return {
    hwnd,
    title,
    region,
    zOrder,
    isMinimized: false,
    isMaximized: false,
    isActive: false,
  } as unknown as WindowZInfo;
}

const APP = win(0xa1n, "MyApp — Editor", { x: 100, y: 100, width: 400, height: 300 });

describe("aiming lookups expire stale entries", () => {
  it("stops resolving a point into a window whose entry has aged out", () => {
    updateWindowCache([APP]);
    expect(findContainingWindow(200, 200)?.hwnd).toBe(0xa1n);

    // The app closed. Nothing enumerated windows since, so the entry is still
    // sitting there — which is exactly the state the symptom describes.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WINDOW_CACHE_TTL_EXPORTED_MS + 1_000);

    expect(findContainingWindow(200, 200)).toBeNull();
  });

  it("stops matching a stale entry by title", () => {
    updateWindowCache([APP]);
    expect(getCachedWindowByTitle("myapp")?.hwnd).toBe(0xa1n);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WINDOW_CACHE_TTL_EXPORTED_MS + 1_000);

    expect(getCachedWindowByTitle("myapp")).toBeNull();
  });

  it("still resolves an entry inside the window", () => {
    // The negative control: expiry must not break ordinary aiming.
    updateWindowCache([APP]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WINDOW_CACHE_TTL_EXPORTED_MS - 1_000);

    expect(findContainingWindow(200, 200)?.hwnd).toBe(0xa1n);
    expect(getCachedWindowByTitle("myapp")?.hwnd).toBe(0xa1n);
  });

  it("hands the point to a live window instead of a stale one on top of it", () => {
    // The stale entry is frontmost, so before the fix it won the z-order race
    // and the click went to a window that is no longer there.
    const live = win(0xb2n, "Other", { x: 0, y: 0, width: 1000, height: 1000 }, 5);
    updateWindowCache([APP, live]);

    vi.useFakeTimers();
    // Age both, then re-observe only the live one — as an enumerating tool would.
    vi.setSystemTime(Date.now() + WINDOW_CACHE_TTL_EXPORTED_MS + 1_000);
    expect(findContainingWindow(200, 200)).toBeNull();

    updateWindowCache([live]);
    expect(findContainingWindow(200, 200)?.hwnd).toBe(0xb2n);
  });
});

describe("evictWindowFromCache", () => {
  it("removes the entry so it stops aiming, and reports whether it removed one", () => {
    updateWindowCache([APP]);
    expect(findContainingWindow(200, 200)?.hwnd).toBe(0xa1n);

    expect(evictWindowFromCache(0xa1n)).toBe(true);
    expect(findContainingWindow(200, 200)).toBeNull();
    expect(getCachedWindowByTitle("myapp")).toBeNull();

    // Idempotent — a second evict has nothing to remove.
    expect(evictWindowFromCache(0xa1n)).toBe(false);
  });

  it("leaves every other window alone", () => {
    const other = win(0xb2n, "Other", { x: 600, y: 100, width: 200, height: 200 });
    updateWindowCache([APP, other]);

    evictWindowFromCache(0xa1n);

    expect(findContainingWindow(200, 200)).toBeNull();
    expect(findContainingWindow(650, 150)?.hwnd).toBe(0xb2n);
  });
});
