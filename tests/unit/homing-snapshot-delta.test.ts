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
 * surface mocked, and assert the FINAL cursor position (moveTo → moveCursorTo)
 * reflects the screenshot-time → live delta.
 *
 * Assertion point: moveTo() hands the final coordinate to moveCursorTo(x, y,
 * speed), so the arguments there are the post-homing click coordinate.
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
  getElementBounds: vi.fn(() => ({ found: null, why: "element_not_found", via: "powershell" })),
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

// ADR-029 Phase 2a: the cursor is moved by `engine/cursor.ts`, not by
// nut.js directly. Mocked here both to read the post-homing coordinate and
// so a unit test never moves the real pointer through the native path.
vi.mock("../../src/engine/cursor.js", () => ({ moveCursorTo: vi.fn() }));

import { mouseClickHandler } from "../../src/tools/mouse.js";
import * as cursor from "../../src/engine/cursor.js";
import * as win32 from "../../src/engine/win32.js";
import * as cache from "../../src/engine/window-cache.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockGetRect = vi.mocked(win32.getWindowRectByHwnd);
const mockGetSnapshot = vi.mocked(cache.getSnapshot);
const mockGetCachedByTitle = vi.mocked(cache.getCachedWindowByTitle);
const mockComputeDelta = vi.mocked(cache.computeWindowDelta);
const mockMove = vi.mocked(cursor.moveCursorTo);

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
    expect(mockMove).toHaveBeenCalledWith(250, 380, 0);
  });

  it("falls back to a fresh main-cache entry when no snapshot exists", async () => {
    mockGetSnapshot.mockReturnValue(null);
    // Fresh cache entry (timestamp now) holds the screenshot-time position.
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 100, y: 100, width: 800, height: 600 }, Date.now()));
    mockGetRect.mockReturnValue({ x: 130, y: 160, width: 800, height: 600 });

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    // delta = live(130,160) - cached(100,100) = (+30,+60) → (330, 460)
    expect(mockMove).toHaveBeenCalledWith(330, 460, 0);
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

    expect(mockMove).toHaveBeenCalledWith(300, 400, 0);
  });

  it("says which client resolved the tier-3 re-query it is about to press", async () => {
    // FOUND BY MUTATION (gate 2): deleting the `[via…]` suffix from the tier-3 note kills nothing,
    // because the FOUND branch of that re-query has no cell anywhere — every mouse and homing mock
    // in this suite answers `found: null`. So the one place a caller could see that a press was
    // aimed by a different UIA client than the one that named the element was unpinned.
    //
    // Why it matters (internal #136, measured): the two clients name some controls differently, so
    // a re-query that fell back resolved a name in the other one's vocabulary — and then a click
    // goes to whatever it resolved.
    const { getElementBounds } = await import("../../src/engine/uia-bridge.js");
    vi.mocked(getElementBounds).mockResolvedValue({
      found: { name: "Save", controlType: "Button", automationId: "", boundingRect: { x: 700, y: 300, width: 100, height: 40 }, value: null },
      via: "powershell",
      nativeFailed: "UIA operation timed out after 8000ms",
    } as Awaited<ReturnType<typeof getElementBounds>>);
    // The window moved far since the screenshot, which is what sends the ladder to its third tier.
    mockGetSnapshot.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 0, y: 0, width: 800, height: 600 }, Date.now()));
    mockGetRect.mockReturnValue({ x: 600, y: 400, width: 800, height: 600 });

    const result = await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400, elementName: "Save" });
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/re-queried \\"Save\\" via UIA/);
    expect(text).toMatch(/\[powershell, after native failed: UIA operation timed out after 8000ms\]/);
  });

  it("says why a tier-3 re-query answered nothing, and who said so", async () => {
    // FOUND BY MUTATION (gate 2): the MISS branch printed "found no element" for all five
    // silences, including a read that never finished and a window that was not there — and a
    // re-query that fell back AND missed is the vocabulary trap (#136), which left no trace here
    // at all while the found branch names its client.
    const { getElementBounds } = await import("../../src/engine/uia-bridge.js");
    vi.mocked(getElementBounds).mockResolvedValue({
      found: null, why: "read_unfinished", via: "none",
      nativeFailed: "UIA operation timed out after 8000ms",
    } as Awaited<ReturnType<typeof getElementBounds>>);
    mockGetSnapshot.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 0, y: 0, width: 800, height: 600 }, Date.now()));
    mockGetRect.mockReturnValue({ x: 600, y: 400, width: 800, height: 600 });

    const result = await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400, elementName: "Save" });
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/answered nothing \(read_unfinished\)/);
    expect(text).toMatch(/\[none, after native failed: UIA operation timed out after 8000ms\]/);
  });

  it("names the client on the found-but-rectless note too, which no cell reached", async () => {
    // FOUND BY MUTATION (gate 2): the tier-3 note has THREE shapes — found with a rectangle, found
    // without one, and nothing at all — and only two had cells. Deleting the client from the
    // middle one killed nothing.
    const { getElementBounds } = await import("../../src/engine/uia-bridge.js");
    vi.mocked(getElementBounds).mockResolvedValue({
      found: { name: "Save", controlType: "Button", automationId: "", boundingRect: null, value: null },
      via: "powershell",
      nativeFailed: "UIA operation timed out after 8000ms",
    } as Awaited<ReturnType<typeof getElementBounds>>);
    mockGetSnapshot.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    mockGetCachedByTitle.mockReturnValue(cachedEntry({ x: 0, y: 0, width: 800, height: 600 }, Date.now()));
    mockGetRect.mockReturnValue({ x: 600, y: 400, width: 800, height: 600 });

    const result = await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400, elementName: "Save" });
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/with no rectangle \[powershell, after native failed: UIA operation timed out after 8000ms\]/);
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
    expect(mockMove).toHaveBeenCalledWith(300, 400, 0);
  });
});
