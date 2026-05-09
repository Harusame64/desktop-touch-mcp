/**
 * issue-207-foreground-refusal-press.test.ts
 *
 * keyboard:press foreground-refusal contract pin — issue #207, Phase 3
 * epic #184 carry-over from PR #208.
 *
 * Pattern reference: `tests/unit/issue-184-foreground-refusal-pin.test.ts`
 * (keyboard:type representative). keyboard:press shares the *same* helper
 * (`focusWindowForKeyboard`) as keyboard:type, so the structural pattern
 * (vi.mock + restoreAndFocusWindow ladder + ForegroundRestricted
 * assertions) is reusable as a near-mechanical copy. The only
 * differences here vs the keyboard:type pin: handler name and the
 * `keys` argument shape (vs `text`).
 *
 * Three cases pinned:
 *   1. default + force escalation both refused → ForegroundRestricted
 *      with attemptedForce:false + autoEscalated:true
 *   2. forceFocus:true caller path → only force attempt, no auto-escalation
 *      (autoEscalated:false), hint omits "default SetForegroundWindow"
 *   3. success path → no early return ForegroundRestricted, single restore
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial mock — keep constants live so transitive imports through
// bg-input.ts continue to resolve.
vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => ""),
  };
});

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: vi.fn(),
  isAutoGuardEnabled: vi.fn(() => false),
  validateAndPrepareFix: vi.fn(() => null),
  consumeFix: vi.fn(),
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("")),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { pressKey: vi.fn(), releaseKey: vi.fn() },
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
  checkForegroundOnce: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }) => ({
    title: windowTitle,
    warnings: [],
  })),
}));

import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import * as win32 from "../../src/engine/win32.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);

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

describe("issue #207: keyboard:press foreground-refusal contract pin", () => {
  it("returns ok:false ForegroundRestricted when default + force escalation both refused", async () => {
    const target = fakeWindow("Outlook", false, 100n);
    const sticky = fakeWindow("Sticky Foreground", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial enum
      .mockReturnValueOnce([target, sticky]) // post-default re-enum
      .mockReturnValueOnce([target, sticky]); // post-force re-enum

    const r = parseResult(await keyboardPressHandler({
      keys: "ctrl+n",
      windowTitle: "Outlook",
      method: "foreground",
      trackFocus: false,
      settleMs: 0,
      // forceFocus omitted → focusWindowForKeyboard does default first
      // then auto-escalates to force=true; both refused → forceRefused.
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(false);
    expect(r.context.autoEscalated).toBe(true);
    expect(typeof r.context.hint).toBe("string");
    expect(r.context.hint).toMatch(/SetForegroundWindow.*AttachThreadInput/);
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenNthCalledWith(1, 100n, { force: false });
    expect(mockRestore).toHaveBeenNthCalledWith(2, 100n, { force: true });
  });

  it("hint文言が force:true caller では default ladder skip を反映", async () => {
    const target = fakeWindow("Outlook", false, 100n);
    const sticky = fakeWindow("Sticky", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial
      .mockReturnValueOnce([target, sticky]); // post-force re-enum (still sticky)

    const r = parseResult(await keyboardPressHandler({
      keys: "ctrl+n",
      windowTitle: "Outlook",
      method: "foreground",
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(true);
    expect(r.context.autoEscalated).toBe(false);
    // The hint must NOT claim default SetForegroundWindow was tried —
    // forceFocus:true caller skipped the default attempt.
    expect(r.context.hint).not.toMatch(/default SetForegroundWindow/);
    expect(r.context.hint).toMatch(/AttachThreadInput/);
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: true });
  });

  it("does NOT early-return when the target reaches foreground after the default attempt", async () => {
    const target = fakeWindow("Outlook", false, 100n);
    mockEnum
      .mockReturnValueOnce([target]) // initial enum
      .mockReturnValueOnce([{ ...target, isActive: true }]); // post-default re-enum (now foreground)

    const r = parseResult(await keyboardPressHandler({
      keys: "ctrl+n",
      windowTitle: "Outlook",
      method: "foreground",
      trackFocus: false,
      settleMs: 0,
    }));

    // Whatever happens downstream (nutjs key combo emit success/fail),
    // the early-return ForegroundRestricted MUST NOT fire.
    expect(r.code).not.toBe("ForegroundRestricted");
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: false });
  });
});
