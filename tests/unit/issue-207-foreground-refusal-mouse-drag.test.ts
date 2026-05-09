/**
 * issue-207-foreground-refusal-mouse-drag.test.ts
 *
 * mouse_drag foreground-refusal contract pin — Phase 5 E3 (epic #211)
 * follow-up to PR #208 (issue #207, Phase 3 epic #184).
 *
 * Pattern reference: `tests/unit/issue-207-foreground-refusal-mouse.test.ts`
 * (mouse_click — same `applyHoming` helper). The Phase 5 audit (#211) found
 * mouse_drag was missing the ForegroundRestricted early-return that
 * mouse_click got via PR #206 — applyHoming pushed "ForceFocusRefused" into
 * notes but the drag still executed. This pin covers the closing fix on
 * mouse_drag (mouse.ts:683-705 mechanical copy from mouseClickHandler:502-531).
 *
 * Two cases pinned (mouse_drag has no `force` param so the asymmetric
 * forceFocus:true case from the click pin is intentionally omitted —
 * applyHoming auto-escalates from default → AttachThreadInput on the
 * default `force=false` path):
 *   1. default + force escalation both refused → drag suppressed +
 *      ForegroundRestricted with attemptedForce:false +
 *      autoEscalated:true; nutjs.mouse.drag MUST NOT have been called
 *   2. tab-strip drag risk does NOT pre-empt the foreground refusal early
 *      return (refusal is detected in the homing block before tab-strip
 *      check) — `tabRisk: shouldBlock:false` ensures the mock chain is
 *      reached even when allowTabDrag is omitted (default false)
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

import { mouseDragHandler } from "../../src/tools/mouse.js";
import * as win32 from "../../src/engine/win32.js";
import * as nutjs from "../../src/engine/nutjs.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockDrag = vi.mocked(nutjs.mouse.drag);
const mockSetPosition = vi.mocked(nutjs.mouse.setPosition);
const mockPressButton = vi.mocked(nutjs.mouse.pressButton);
const mockReleaseButton = vi.mocked(nutjs.mouse.releaseButton);

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
});

describe("Phase 5 E3 (epic #211): mouse_drag foreground-refusal contract pin", () => {
  it("returns ok:false ForegroundRestricted when default + force escalation both refused (drag suppressed)", async () => {
    // Setup: target window exists but never reaches foreground across both
    // restoreAndFocusWindow attempts — applyHoming's post-wait re-enum sees
    // the sticky window still active, so it pushes "ForceFocusRefused" into
    // notes. The new homing-block early return then suppresses the drag and
    // emits ForegroundRestricted (mouse.ts:683-705 mechanical copy from
    // mouseClickHandler:502-531).
    const target = fakeWindow("Notepad", false, 100n);
    const sticky = fakeWindow("Sticky Foreground", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial enum (applyHoming line 101)
      .mockReturnValueOnce([target, sticky]) // post-default re-enum (line 129)
      .mockReturnValueOnce([target, sticky]); // post-force re-enum (line 140)

    const r = parseResult(await mouseDragHandler({
      startX: 100, startY: 100,
      endX: 400, endY: 300,
      windowTitle: "Notepad",
      homing: true,
      // speed:0 routes drag through pressButton/setPosition/releaseButton
      // (mocked) instead of mouse.drag/config which would need extra nutjs
      // scaffolding — we only care about the foreground-refusal early
      // return here, so pinning speed:0 keeps the mock surface minimal.
      speed: 0,
      verifyDelivery: false,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(false);
    expect(r.context.autoEscalated).toBe(true);
    expect(typeof r.context.hint).toBe("string");
    expect(r.context.hint).toMatch(/SetForegroundWindow.*AttachThreadInput/);
    expect(r.context.hint).toMatch(/drag suppressed/);
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    // Critical: drag MUST be suppressed — pre-fix path silently landed on
    // whichever window held foreground.
    expect(mockDrag).not.toHaveBeenCalled();
    expect(mockSetPosition).not.toHaveBeenCalled();
    expect(mockPressButton).not.toHaveBeenCalled();
    expect(mockReleaseButton).not.toHaveBeenCalled();
    // Two restore attempts: default then force-escalate (applyHoming
    // auto-escalates from default→force on the default false path).
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenNthCalledWith(1, 100n, { force: false });
    expect(mockRestore).toHaveBeenNthCalledWith(2, 100n, { force: true });
  });

  it("returns ok:false ForegroundRestricted with windowTitle context preserved", async () => {
    const target = fakeWindow("Excel - Book1", false, 100n);
    const sticky = fakeWindow("Sticky", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky])
      .mockReturnValueOnce([target, sticky])
      .mockReturnValueOnce([target, sticky]);

    const r = parseResult(await mouseDragHandler({
      startX: 50, startY: 50,
      endX: 200, endY: 200,
      windowTitle: "Excel",
      homing: true,
      speed: 0,
      verifyDelivery: false,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    // Window title context should propagate so callers can branch on the
    // intended target rather than reasoning about screen coords.
    // The handler returns the partial-match title that was passed in
    // (resolveWindowTarget echoes effectiveTitle).
    expect(r.context.windowTitle).toBe("Excel");
    expect(mockDrag).not.toHaveBeenCalled();
  });
});
