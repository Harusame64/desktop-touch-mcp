/**
 * ADR-029 Phase 2a — mouse_drag must release the button even when the move fails.
 *
 * The old nut.js calls could not throw: libnut clamped a bad coordinate and
 * returned. The native path reports a cursor it could not place, so the move
 * between `pressButton` and `releaseButton` CAN throw — and an escape there
 * leaves the left button held down at OS level, which breaks every subsequent
 * input on the machine until something releases it.
 *
 * Pinned at the handler, not at the helper: the `try/finally` lives in
 * `mouseDragHandler`, and an E2E that presses and releases by hand would pass
 * whatever the handler does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowIdentity: vi.fn(() => ({ processName: "test.exe", processId: 1234, windowClass: "TestClass" })),
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
  WINDOW_CACHE_TTL_EXPORTED_MS: 60_000,
}));

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: vi.fn(),
  isAutoGuardEnabled: vi.fn(() => false),
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(),
}));

vi.mock("../../src/engine/perception/tab-drag-heuristic.js", () => ({
  detectTabDragRisk: vi.fn(() => ({ shouldBlock: false, risk: false })),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: vi.fn(() => null),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    click: vi.fn(),
    doubleClick: vi.fn(),
    setPosition: vi.fn(),
    pressButton: vi.fn(),
    releaseButton: vi.fn(),
    drag: vi.fn(),
    config: { mouseSpeed: 1000 },
  },
  Button: { LEFT: "left", RIGHT: "right", MIDDLE: "middle" },
  Point: vi.fn((x, y) => ({ x, y })),
  straightTo: vi.fn((p) => p),
  DEFAULT_MOUSE_SPEED: 1000,
}));

// The cursor choke point is the thing under test's dependency here: the drag
// handler must survive it throwing.
vi.mock("../../src/engine/cursor.js", () => ({
  moveCursorTo: vi.fn(),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/tools/_mouse-verify.js", () => ({
  snapshotForVerify: vi.fn(() => Promise.resolve(null)),
  classifyDelivery: vi.fn(() => "unverifiable"),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }) => ({ title: windowTitle, warnings: [] })),
}));

import { mouseDragHandler } from "../../src/tools/mouse.js";
import * as nutjs from "../../src/engine/nutjs.js";
import * as cursor from "../../src/engine/cursor.js";
import { CursorPlacementBlockedError } from "../../src/errors/typed-errors.js";

const mockPress = vi.mocked(nutjs.mouse.pressButton);
const mockRelease = vi.mocked(nutjs.mouse.releaseButton);
const mockMove = vi.mocked(cursor.moveCursorTo);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ADR-029 Phase 2a — mouse_drag button release", () => {
  it("releases the button when the destination move throws", async () => {
    mockMove.mockImplementation(async (_x: number, _y: number) => {
      // The start-point move (before the press) succeeds; the destination one
      // fails, which is where the button is already down.
      if (mockPress.mock.calls.length > 0) {
        throw new CursorPlacementBlockedError("CursorPlacementBlocked: could not place the pointer");
      }
    });

    const r = await mouseDragHandler({
      startX: 100,
      startY: 100,
      endX: 300,
      endY: 300,
    } as Parameters<typeof mouseDragHandler>[0]);

    expect(mockPress).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("CursorPlacementBlocked");
  });

  it("releases the button on a successful drag too", async () => {
    mockMove.mockResolvedValue(undefined);
    await mouseDragHandler({
      startX: 100,
      startY: 100,
      endX: 300,
      endY: 300,
    } as Parameters<typeof mouseDragHandler>[0]);
    expect(mockPress).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
