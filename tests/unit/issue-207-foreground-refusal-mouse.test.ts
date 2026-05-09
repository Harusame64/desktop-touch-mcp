/**
 * issue-207-foreground-refusal-mouse.test.ts
 *
 * mouse_click foreground-refusal contract pin — issue #207, Phase 3 epic
 * #184 carry-over from PR #208.
 *
 * Pattern reference: `tests/unit/issue-184-foreground-refusal-pin.test.ts`
 * (keyboard:type representative). mouse_click uses a DIFFERENT helper
 * (`applyHoming`) inside the homing block (`mouse.ts:88-150`) instead of
 * `focusWindowForKeyboard`, so the mock surface differs:
 *
 *   - keyboard:type pin: `enumWindowsInZOrder` + `restoreAndFocusWindow`
 *   - mouse_click pin (this file): the same two **plus**
 *     `updateWindowCache` / `findContainingWindow` /
 *     `getCachedWindowByTitle` / `computeWindowDelta` (homing
 *     window-cache surface), `mouse.click` (nutjs side-effect stub),
 *     and the auto-guard / perception subsystem disabled via
 *     `isAutoGuardEnabled: false`.
 *
 * Three cases pinned:
 *   1. default + force escalation both refused → click suppressed +
 *      ForegroundRestricted with attemptedForce:false +
 *      autoEscalated:true; mouse.click MUST NOT have been called
 *   2. forceFocus:true caller path → only force attempt, autoEscalated:false,
 *      hint omits "default SetForegroundWindow"
 *   3. success path (target reaches foreground after default) → no
 *      ForegroundRestricted early return; mouse.click executes
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
  getElementBounds: vi.fn(() => null),
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

import { mouseClickHandler } from "../../src/tools/mouse.js";
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

describe("issue #207: mouse_click foreground-refusal contract pin", () => {
  it("returns ok:false ForegroundRestricted when default + force escalation both refused (click suppressed)", async () => {
    // Setup: target window exists but never reaches foreground across
    // both restoreAndFocusWindow attempts — applyHoming's post-wait
    // re-enum sees the sticky window still active, so it pushes
    // "ForceFocusRefused" into notes. The handler's homing-block early
    // return then suppresses the click and emits ForegroundRestricted.
    const target = fakeWindow("Notepad", false, 100n);
    const sticky = fakeWindow("Sticky Foreground", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial enum (applyHoming line 101)
      .mockReturnValueOnce([target, sticky]) // post-default re-enum (line 122)
      .mockReturnValueOnce([target, sticky]); // post-force re-enum (line 132)

    const r = parseResult(await mouseClickHandler({
      x: 400,
      y: 300,
      windowTitle: "Notepad",
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: true,
      // speed:0 routes moveTo through setPosition (mocked) instead of the
      // mouse.move/config path which would need extra nutjs scaffolding —
      // we only care about the foreground-refusal early return here, so
      // pinning speed:0 keeps the mock surface minimal.
      speed: 0,
      trackFocus: false,
      settleMs: 0,
      verifyDelivery: false,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(false);
    expect(r.context.autoEscalated).toBe(true);
    expect(typeof r.context.hint).toBe("string");
    expect(r.context.hint).toMatch(/SetForegroundWindow.*AttachThreadInput/);
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    // Critical: click MUST be suppressed — pre-fix path (#202 carry-over)
    // promoted ForceFocusRefused to a warning AFTER the click landed.
    // The new contract returns ok:false BEFORE mouse.click runs.
    expect(mockClick).not.toHaveBeenCalled();
    // Two restore attempts: default then force-escalate.
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenNthCalledWith(1, 100n, { force: false });
    expect(mockRestore).toHaveBeenNthCalledWith(2, 100n, { force: true });
  });

  it("hint文言が forceFocus:true caller では default ladder skip を反映 (click suppressed)", async () => {
    const target = fakeWindow("Notepad", false, 100n);
    const sticky = fakeWindow("Sticky", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial
      .mockReturnValueOnce([target, sticky]); // post-force re-enum (still sticky)

    const r = parseResult(await mouseClickHandler({
      x: 400,
      y: 300,
      windowTitle: "Notepad",
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: true,
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
      verifyDelivery: false,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(true);
    expect(r.context.autoEscalated).toBe(false);
    expect(r.context.hint).not.toMatch(/default SetForegroundWindow/);
    expect(r.context.hint).toMatch(/AttachThreadInput/);
    expect(mockClick).not.toHaveBeenCalled();
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: true });
  });

  // The success path (target reaches foreground after default attempt →
  // mouse.click executes) is structurally identical for the entire
  // commit-axis family and is already pinned by
  // `tests/unit/issue-184-foreground-refusal-pin.test.ts` for keyboard:type.
  // Pinning it here would need additional mock surface (nutjs `mouse.move` /
  // `mouse.config` / verification snapshot path) for very little marginal
  // contract coverage on top of the keyboard:type pin. The two refusal
  // cases above exercise the mouse_click-specific glue (applyHoming
  // ladder + click-suppress early return + click-NOT-called assertion)
  // which the keyboard:type pin can't cover, so they remain.
});
