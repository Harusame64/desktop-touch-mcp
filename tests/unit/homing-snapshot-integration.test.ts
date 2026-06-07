/**
 * tests/unit/homing-snapshot-integration.test.ts
 *
 * Integration-level regression pin for issue #443 (follow-up R1).
 *
 * Unlike homing-snapshot-delta.test.ts, this test does NOT mock the
 * window-cache module — it drives the REAL cache (updateWindowCache /
 * saveSnapshot / getSnapshot / getCachedWindowByTitle / computeWindowDelta)
 * and mocks only the win32 boundary (enumWindowsInZOrder / restoreAndFocusWindow
 * / getWindowRectByHwnd). That lets it reproduce the ORIGINAL defect's
 * interaction: Tier 2's focus path calls updateWindowCache(), which overwrites
 * the main cache's screenshot-time region with the *current* position — the
 * exact overwrite that used to collapse the delta to (0,0). The fix survives it
 * because the snapshot cache (written by screenshot tools) is never mutated by
 * updateWindowCache.
 *
 * If someone reverts the fix so the delta is computed from the main-cache region
 * instead of the snapshot, this test fails: after the Tier 2 overwrite the main
 * cache holds the moved position, so a main-cache delta would be (0,0).
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

// NOTE: window-cache is intentionally NOT mocked — the real store is exercised.

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
import * as nutjs from "../../src/engine/nutjs.js";
import { updateWindowCache, saveSnapshot } from "../../src/engine/window-cache.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockGetRect = vi.mocked(win32.getWindowRectByHwnd);
const mockSetPosition = vi.mocked(nutjs.mouse.setPosition);

const TITLE = "IntegApp";
const HWND = 7777n;
const OTHER = 9999n;

function win(opts: {
  hwnd: bigint;
  title: string;
  isActive: boolean;
  region: { x: number; y: number; width: number; height: number };
  zOrder?: number;
}) {
  return {
    hwnd: opts.hwnd,
    title: opts.title,
    isActive: opts.isActive,
    zOrder: opts.zOrder ?? 0,
    isMinimized: false,
    isMaximized: false,
    region: opts.region,
    processName: "integ.exe",
  };
}

const SCREENSHOT_REGION = { x: 100, y: 100, width: 800, height: 600 };
const MOVED_REGION = { x: 50, y: 80, width: 800, height: 600 };

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
  // Reset the real main cache (no dedicated reset export; an empty update
  // prunes every entry). The snapshot cache is overwritten per-test by key.
  updateWindowCache([]);
});

describe("issue #443 (integration): snapshot survives a real Tier 2 cache overwrite", () => {
  it("applies the screenshot→live delta even after focus overwrites the main cache", async () => {
    // Screenshot time: cache + snapshot both record (100,100).
    updateWindowCache([win({ hwnd: HWND, title: TITLE, isActive: true, region: SCREENSHOT_REGION })]);
    saveSnapshot(TITLE, SCREENSHOT_REGION);

    // The window has since moved to (50,80) and dropped behind another window.
    mockGetRect.mockReturnValue(MOVED_REGION);
    // Tier 2 enumerations: first sees the target inactive (focus needed), then
    // active after restoreAndFocusWindow. The post-focus enum carries the MOVED
    // region, so updateWindowCache() overwrites the main cache to (50,80) — the
    // exact overwrite that used to nullify the delta.
    mockEnum
      .mockReturnValueOnce([
        win({ hwnd: OTHER, title: "Another", isActive: true, region: { x: 0, y: 0, width: 400, height: 300 }, zOrder: 0 }),
        win({ hwnd: HWND, title: TITLE, isActive: false, region: MOVED_REGION, zOrder: 1 }),
      ])
      .mockReturnValueOnce([
        win({ hwnd: HWND, title: TITLE, isActive: true, region: MOVED_REGION, zOrder: 0 }),
        win({ hwnd: OTHER, title: "Another", isActive: false, region: { x: 0, y: 0, width: 400, height: 300 }, zOrder: 1 }),
      ]);

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    // delta = live(50,80) - snapshot(100,100) = (-50,-20) → (250, 380).
    // A regression that read the (now overwritten) main-cache region would get
    // (50,80)-(50,80)=(0,0) → (300,400) and fail here.
    expect(mockSetPosition).toHaveBeenCalledWith({ x: 250, y: 380 });
  });

  it("applies the delta with no focus needed (window already active)", async () => {
    updateWindowCache([win({ hwnd: HWND, title: TITLE, isActive: true, region: SCREENSHOT_REGION })]);
    saveSnapshot(TITLE, SCREENSHOT_REGION);
    mockGetRect.mockReturnValue(MOVED_REGION);
    // Already active → Tier 2 performs no focus and no cache mutation.
    mockEnum.mockReturnValue([
      win({ hwnd: HWND, title: TITLE, isActive: true, region: SCREENSHOT_REGION }),
    ]);

    await mouseClickHandler({ ...BASE_ARGS, x: 300, y: 400 });

    expect(mockSetPosition).toHaveBeenCalledWith({ x: 250, y: 380 });
  });
});
