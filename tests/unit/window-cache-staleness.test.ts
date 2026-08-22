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
  findContainingWindowFresh,
  _resetRefreshThrottleForTest,
  WINDOW_CACHE_TTL_EXPORTED_MS,
} from "../../src/engine/window-cache.js";
import type { WindowZInfo } from "../../src/engine/win32.js";

const mockEnum = vi.fn<() => WindowZInfo[]>(() => []);
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, enumWindowsInZOrder: () => mockEnum() };
});

afterEach(() => {
  vi.useRealTimers();
  mockEnum.mockReset();
  mockEnum.mockReturnValue([]);
  // The cache is module state. Left seeded, it makes the next test's "miss"
  // a hit and the assertion passes or fails for the wrong reason.
  updateWindowCache([]);
  // The refresh-on-miss throttle is module state; without this a test that
  // refreshed would silently disarm the next one's refresh.
  _resetRefreshThrottleForTest();
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

describe("findContainingWindowFresh — expiry means re-verify, not unclickable", () => {
  it("re-enumerates on a miss and finds a window that is still open", () => {
    // The regression the staleness bound created on its own: a live, unmoved
    // window becomes unreachable simply because nothing enumerated for a
    // minute. `mouse_click({x,y})` with no windowTitle has no other path back
    // into the cache, so without this the caller is told the target was not
    // found — for a window sitting right there.
    updateWindowCache([APP]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WINDOW_CACHE_TTL_EXPORTED_MS + 1_000);

    expect(findContainingWindow(200, 200)).toBeNull();

    mockEnum.mockReturnValue([APP]);
    expect(findContainingWindowFresh(200, 200)?.hwnd).toBe(0xa1n);
    expect(mockEnum).toHaveBeenCalledTimes(1);
  });

  it("does not re-enumerate when the cache can already answer", () => {
    updateWindowCache([APP]);
    mockEnum.mockClear();

    expect(findContainingWindowFresh(200, 200)?.hwnd).toBe(0xa1n);
    expect(mockEnum).not.toHaveBeenCalled();
  });

  it("reports nothing when the window really is gone", () => {
    // The point of re-verifying is that the answer is now trustworthy: the
    // window was asked about and is not there.
    updateWindowCache([APP]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WINDOW_CACHE_TTL_EXPORTED_MS + 1_000);

    mockEnum.mockReturnValue([]);
    expect(findContainingWindowFresh(200, 200)).toBeNull();
  });

  it("survives an enumeration that throws", () => {
    mockEnum.mockImplementation(() => { throw new Error("no native addon"); });
    expect(findContainingWindowFresh(200, 200)).toBeNull();
  });

  it("does not overwrite the stored regions the movement correction measures against", () => {
    // Several screenshot modes seed only this cache and no snapshot, which makes
    // the region stored here the reference `applyHoming` compares a window's
    // current position against. Writing the enumeration back would replace that
    // reference with the current position — the same window compared against
    // itself, a zero delta, and coordinates read off a screenshot silently left
    // uncorrected after the window moved.
    updateWindowCache([APP]);                       // screenshot-era position
    const MOVED = win(0xa1n, "MyApp — Editor", { x: 700, y: 700, width: 400, height: 300 });
    mockEnum.mockReturnValue([MOVED]);

    // A miss somewhere else entirely — the window moved, so the old region no
    // longer contains the point.
    expect(findContainingWindowFresh(800, 800)?.hwnd).toBe(0xa1n);

    // The answer came from live data; the stored reference is untouched.
    expect(findContainingWindow(200, 200)?.region).toEqual({
      x: 100, y: 100, width: 400, height: 300,
    });
  });

  it("skips a minimized window when answering from live data", () => {
    // Their region is zeroed, which would otherwise swallow the origin.
    const minimized = {
      ...win(0xc3n, "Minimized", { x: 0, y: 0, width: 0, height: 0 }),
      isMinimized: true,
    } as unknown as WindowZInfo;
    mockEnum.mockReturnValue([minimized]);
    expect(findContainingWindowFresh(0, 0)).toBeNull();
  });
});

describe("findContainingWindowFresh — the throttle", () => {
  it("does not re-enumerate again immediately for a point that is inside nothing", () => {
    // A click on the desktop background misses forever. Without a throttle each
    // one would enumerate here AND again in the sensor refresh that follows.
    mockEnum.mockReturnValue([]);

    expect(findContainingWindowFresh(5000, 5000)).toBeNull();
    expect(mockEnum).toHaveBeenCalledTimes(1);

    expect(findContainingWindowFresh(5000, 5000)).toBeNull();
    expect(findContainingWindowFresh(5000, 5000)).toBeNull();
    expect(mockEnum).toHaveBeenCalledTimes(1);
  });

  it("re-enumerates again once the throttle window has passed", () => {
    // A window the caller has just opened must still be findable — the throttle
    // is a rate limit, not a negative cache.
    mockEnum.mockReturnValue([]);
    expect(findContainingWindowFresh(200, 200)).toBeNull();
    expect(mockEnum).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 500);
    mockEnum.mockReturnValue([APP]);

    expect(findContainingWindowFresh(200, 200)?.hwnd).toBe(0xa1n);
    expect(mockEnum).toHaveBeenCalledTimes(2);
  });
});
