/**
 * internal #221 — mouse tools do not bring a window on another virtual desktop forward.
 *
 * `applyHoming` brings the named window forward before a click; for a window on another virtual
 * desktop that switches the user's desktop. Harness from `issue-207-foreground-refusal-mouse.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The cursor is a REAL device: `mouse.ts::moveTo` delegates to
// `engine/cursor.ts::moveCursorTo`, which calls the Win32 mover directly — it
// does NOT go through the mocked `engine/nutjs.js`. Unmocked, this test walks
// the developer's pointer across the screen and parks it wherever the fixture
// coordinates land (for the top-left fixtures, on the desktop's first icon).
// Nothing here asserts on cursor motion, so stub it out.
vi.mock("../../src/engine/cursor.js", () => ({
  moveCursorTo: vi.fn(async () => undefined),
}));

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
  },
  Button: { LEFT: "left", RIGHT: "right", MIDDLE: "middle" },
  Point: vi.fn((x, y) => ({ x, y })),
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
  resolveWindowTarget: vi.fn(async ({ windowTitle }) => ({
    title: windowTitle,
    warnings: [],
  })),
}));

import { mouseClickHandler, mouseMoveHandler, mouseDragHandler, scrollHandler } from "../../src/tools/mouse.js";
import * as win32 from "../../src/engine/win32.js";
import * as nutjs from "../../src/engine/nutjs.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockClick = vi.mocked(nutjs.mouse.click);

function fakeWindow(title: string, isActive: boolean, hwnd = 100n) {
  return {
    hwnd,
    title,
    isActive,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
    processName: "test.exe",
  };
}

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRestore.mockReturnValue({ x: 100, y: 100, width: 800, height: 600 });
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
});

const offDesktop = (hwnd: bigint) => ({ ...fakeWindow("QV221", false, hwnd), isCloaked: true });
const onScreen = (hwnd: bigint) => ({ ...fakeWindow("QV221", false, hwnd), isCloaked: false });
const click = () => mouseClickHandler({
  x: 400, y: 300, windowTitle: "QV221", button: "left", doubleClick: false, tripleClick: false,
  homing: true, speed: 0, trackFocus: false, settleMs: 0, verifyDelivery: false,
});

describe("internal #221 — mouse_click and a window on another virtual desktop", () => {
  it("refuses, and does not click, when the named window is on another desktop", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await click());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(r.context).toMatchObject({ hwnd: "100", sameTitleOnScreen: true });
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockClick).not.toHaveBeenCalled();
  });

  it("brings the window forward and clicks when it is on this desktop (control)", async () => {
    mockEnum
      .mockReturnValueOnce([onScreen(100n), offDesktop(200n)])
      .mockReturnValue([{ ...onScreen(100n), isActive: true }, offDesktop(200n)]);
    const r = parseResult(await click());
    expect(r.code).not.toBe("WindowOnOtherDesktop");
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: false });
  });

  it.each([
    ["mouse_move", () => mouseMoveHandler({ x: 400, y: 300, speed: 0, homing: true, windowTitle: "QV221" })],
    ["mouse_drag", () => mouseDragHandler({ startX: 400, startY: 300, endX: 500, endY: 300, speed: 0, homing: true, windowTitle: "QV221" })],
    ["scroll", () => scrollHandler({ direction: "down", amount: 1, x: 400, y: 300, speed: 0, homing: true, windowTitle: "QV221" })],
  ])("%s refuses the same way", async (_name, call) => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await call());
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(mockRestore).not.toHaveBeenCalled();
  });
});
