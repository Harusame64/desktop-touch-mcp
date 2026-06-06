/**
 * tests/unit/homing-snapshot-delta.test.ts
 *
 * Regression pin for issue #443 / PR #444: mouse_click homing delta was
 * silently nullified because applyHoming's Tier 2 (focus) ran
 * updateWindowCache() before Tier 1 computed the delta, overwriting the
 * screenshot-time position so computeWindowDelta() always returned (0,0).
 *
 * The fix computes the delta from the screenshot-time position — taken from the
 * snapshot cache (set by screenshot tools, immune to focus/dock mutations) or,
 * failing that, from a *fresh* main-cache entry — against the live GetWindowRect.
 *
 * These tests drive the real mouseClickHandler with the window-cache / win32
 * surface mocked, and assert the FINAL cursor position (moveTo → setPosition)
 * reflects the screenshot-time → live delta.
 *
 * Assertion point: with speed:0, moveTo() teleports via mouse.setPosition(Point),
 * so the Point passed there is the post-homing click coordinate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowIdentity: vi.fn(() => null),
    readScrollInfo: vi.fn(() => null),
    getForegroundHwnd: vi.fn(() => null),
    getWindowRectByHwnd: vi.fn(() => null),
  };
});

vi.mock("../../src/engine/window-cache.js", () => ({
  updateWindowCache: vi.fn(),
  findContainingWindow: vi.fn(() => null),
  getCachedWindowByTitle: vi.fn(() => null),
  computeWindowDelta: vi.fn(() => null),
  getSnapshot: vi.fn(() => null),
  // mouse.ts reads this constant for the stale-cache TTL guard; provide the
  // real value so the guard arithmetic behaves as in production.
  WINDOW_CACHE_TTL_EXPORTED_MS: 60_000,
}));

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: vi.fn(),
  isAutoGuardEnabled: vi.fn(() => false),
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(() => null),
}));

vi.mock("../../src/engine/perception/tab-drag-heuristic.js", () => ({
  detectTabDragRisk: vi.fn(() => ({ shouldBlock: false })),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: vi.fn(() => null),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    click: vi.fn(),
    doubleClick: vi.fn(),
    setPosition: vi.fn(),
    move: vi.fn(),
    config: { mouseSpeed: 1000 },
  },
  Button: { LEFT: "left", RIGHT: "right", MIDDLE: "middle" },
  // Real constructor: applyHoming → moveTo does `new Point(x, y)`, which an
  // arrow-function mock cannot satisfy.
  Point: class { constructor(public x: number, public y: number) {} },
  straightTo: vi.fn((p) => p),
  DEFAULT_MOUSE_SPEED: 1000,
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/tools/_mouse-verify.js", () => ({
  snapshotForVerify: vi.fn(() => Promise.resolve(null)),
  classifyDelivery: vi.fn(() => "unverifiable"),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }: { windowTitle?: string }) => ({
    title: windowTitle,
    warnings: [],
  })),
}));

import { mouseClickHandler } from "../../src/tools/mouse.js";
import * as win32 from "../../src/engine/win32.js";
import * as cache from "../../src/engine/window-cache.js";
import * as nutjs from "../../src/engine/nutjs.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockGetRect = vi.mocked(win32.getWindowRectByHwnd);
const mockGetSnapshot = vi.mocked(cache.getSnapshot);
const mockGetCachedByTitle = vi.mocked(cache.getCachedWindowByTitle);
const mockComputeDelta = vi.mocked(cache.computeWindowDelta);
const mockSetPosition = vi.mocked(nutjs.mouse.setPosition);

const TITLE = "Doubao";
const HWND = 4242n;

/** Target window present and already active → Tier 2 focus path is a no-op. */
function activeTargetWindow() {
  return [{
    hwnd: HWND,
    title: TITLE,
    isActive: true,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
    processName: "doubao.exe",
  }];
}

function cachedEntry(region: { x: number; y: number; width: number; height: number }, timestamp: number) {
  return { hwnd: HWND, title: TITLE, region, zOrder: 0, timestamp };
}

const BASE_ARGS = {
  button: "left" as const,
  doubleClick: false,
  tripleClick: false,
  homing: true,
  windowTitle: TITLE,
  speed: 0,
  trackFocus: false,
  settleMs: 0,
  verifyDelivery: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnum.mockReturnValue(activeTargetWindow());
});

describe("issue #443: homing delta uses screenshot-time position", () => {
  it("applies the snapshot→live delta from the snapshot cache", async () => {
    // Screenshot-time window was at (100,100); it has since moved to (50,80).
    mockGetSnapshot.mockReturnValue({ x: 100, y: 100, width: 800, height: 600 });
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 50, y: 80, width: 800, height: 600 }, Date.now()));
    mockGetRect.mockReturnValue({ x: 50, y: 80, width: 800, height: 600 });

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    // delta = live(50,80) - snapshot(100,100) = (-50,-20)
    // corrected = (300-50, 400-20) = (250, 380)
    expect(mockSetPosition).toHaveBeenCalledWith({ x: 250, y: 380 });
  });

  it("falls back to a fresh main-cache entry when no snapshot exists", async () => {
    mockGetSnapshot.mockReturnValue(null);
    // Fresh cache entry (timestamp now) holds the screenshot-time position.
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 100, y: 100, width: 800, height: 600 }, Date.now()));
    mockGetRect.mockReturnValue({ x: 130, y: 160, width: 800, height: 600 });

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    // delta = live(130,160) - cached(100,100) = (+30,+60) → (330, 460)
    expect(mockSetPosition).toHaveBeenCalledWith({ x: 330, y: 460 });
  });

  it("skips the snapshot delta when the cached HWND entry is stale (recycle guard)", async () => {
    // Snapshot region is fresh, but the main-cache HWND entry used to read the
    // live rect is older than the 60s cache TTL → the HWND may have been
    // recycled, so the snapshot delta path must NOT trust GetWindowRect on it.
    mockGetSnapshot.mockReturnValue({ x: 100, y: 100, width: 800, height: 600 });
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 100, y: 100, width: 800, height: 600 }, Date.now() - 120_000));
    // If the recycle guard were missing, the snapshot path would apply
    // live(130,160) - snapshot(100,100) = (+30,+60). The guard skips it; the
    // fallback computeWindowDelta() (mocked → no movement) governs instead.
    mockGetRect.mockReturnValue({ x: 130, y: 160, width: 800, height: 600 });
    mockComputeDelta.mockReturnValue({ dx: 0, dy: 0, sizeChanged: false });

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    expect(mockSetPosition).toHaveBeenCalledWith({ x: 300, y: 400 });
  });

  it("ignores a stale main-cache entry (TTL guard) instead of applying a bogus offset", async () => {
    mockGetSnapshot.mockReturnValue(null);
    // Stale entry (older than the 60s cache TTL) — must NOT seed screenshotRegion.
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 100, y: 100, width: 800, height: 600 }, Date.now() - 120_000));
    // If the TTL guard were broken, the snapshot path would compute
    // live(130,160) - stale(100,100) = (+30,+60). The guard skips it, so the
    // fallback computeWindowDelta() (mocked → no movement) governs instead.
    mockGetRect.mockReturnValue({ x: 130, y: 160, width: 800, height: 600 });
    mockComputeDelta.mockReturnValue({ dx: 0, dy: 0, sizeChanged: false });

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    // No correction from the stale region → original coords.
    expect(mockSetPosition).toHaveBeenCalledWith({ x: 300, y: 400 });
  });
});
