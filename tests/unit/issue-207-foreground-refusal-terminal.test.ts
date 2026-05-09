/**
 * issue-207-foreground-refusal-terminal.test.ts
 *
 * terminal:send foreground-refusal contract pin — issue #207, Phase 3 epic
 * #184 carry-over from PR #208.
 *
 * Pattern reference: `tests/unit/issue-184-foreground-refusal-pin.test.ts`
 * (keyboard:type representative). terminal:send uses an INLINE 5-retry +
 * AttachThreadInput auto-escalate ladder (terminal.ts:678-740) — no
 * shared helper. The mock surface differs from keyboard:type:
 *
 *   - keyboard:type pin: `enumWindowsInZOrder` + `restoreAndFocusWindow`
 *     + focusWindowForKeyboard (helper) sequencing
 *   - terminal:send pin (this file): `enumWindowsInZOrder` ×6 mocks
 *     (1 initial findTerminalWindow + 5 retry × 1 + 1 post-escalate),
 *     `restoreAndFocusWindow` for default + force, plus identity-tracker
 *     and BG-input subsystem stubs so the FG path is exercised in
 *     isolation.
 *
 * Two cases pinned (the success path is structurally identical to
 * keyboard:type's success pin and is documented as not duplicated):
 *   1. force=false: 5-retry default + AttachThreadInput auto-escalate
 *      both refused → ForegroundRestricted with attemptedForce:false +
 *      autoEscalated:true
 *   2. force=true: single AttachThreadInput refused → attemptedForce:true
 *      + autoEscalated:false, hint omits "5 SetForegroundWindow retries"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getProcessIdentityByPid: vi.fn(() => ({ processName: "test.exe", pid: 1234 })),
    getWindowProcessId: vi.fn(() => 1234),
    getWindowClassName: vi.fn(() => ""),
  };
});

vi.mock("../../src/engine/bg-input.js", () => ({
  canInjectViaPostMessage: vi.fn(() => ({ supported: false, reason: "class_unknown" })),
  postCharsToHwnd: vi.fn(),
  postEnterToHwnd: vi.fn(),
  isBgAutoEnabled: vi.fn(() => false),
  TERMINAL_WINDOW_CLASSES: new Set<string>(),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../src/engine/ocr-bridge.js", () => ({
  recognizeWindow: vi.fn(),
  ocrWordsToLines: vi.fn(),
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  observeTarget: vi.fn(() => ({ identity: {}, invalidatedBy: null, previousTarget: null })),
  buildCacheStateHints: vi.fn(() => ({})),
  toTargetHints: vi.fn(() => ({})),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
}));

vi.mock("../../src/tools/keyboard.js", () => ({
  typeViaClipboard: vi.fn(() => Promise.resolve()),
}));

import { terminalSendHandler } from "../../src/tools/terminal.js";
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

describe("issue #207: terminal:send foreground-refusal contract pin", () => {
  it("returns ok:false ForegroundRestricted when 5-retry default + AttachThreadInput auto-escalate both refused", async () => {
    // findTerminalWindow uses enumWindowsInZOrder() to locate the target.
    // Then the FG path enters the 5-retry default loop (5 enums) and on
    // failure auto-escalates via AttachThreadInput once more (1 enum).
    // We mock 7 enum returns total: 1 (find) + 5 (retry) + 1 (escalate
    // re-enum) — all return the sticky window as foreground so refusal
    // sticks across the entire ladder.
    const target = fakeWindow("PowerShell", false, 100n);
    const sticky = fakeWindow("Sticky Foreground", true, 200n);
    const refusalEnum = [target, sticky];

    // mockReturnValue (not Once) — every call returns the same refusal
    // state, sidestepping the need to count exact enum invocations.
    mockEnum.mockReturnValue(refusalEnum);

    const r = parseResult(await terminalSendHandler({
      windowTitle: "PowerShell",
      input: "echo hi",
      method: "foreground", // force FG path; BG would go through canInjectViaPostMessage
      pressEnter: false,
      focusFirst: true,
      restoreFocus: false,
      preferClipboard: false, // skip typeViaClipboard path; nutjs keyboard.type stubbed
      pasteKey: "auto",
      trackFocus: false,
      settleMs: 0,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(false);
    expect(r.context.autoEscalated).toBe(true);
    expect(typeof r.context.hint).toBe("string");
    expect(r.context.hint).toMatch(/5 SetForegroundWindow retries/);
    expect(r.context.hint).toMatch(/AttachThreadInput/);
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    // restoreAndFocusWindow: 5 default attempts + 1 escalate.
    expect(mockRestore).toHaveBeenCalledTimes(6);
    // Last call must be the auto-escalate with force:true.
    expect(mockRestore).toHaveBeenLastCalledWith(100n, { force: true });
  });

  it("hint文言が force:true caller では 5-retry skip を反映", async () => {
    const target = fakeWindow("PowerShell", false, 100n);
    const sticky = fakeWindow("Sticky", true, 200n);
    mockEnum.mockReturnValue([target, sticky]);

    const r = parseResult(await terminalSendHandler({
      windowTitle: "PowerShell",
      input: "echo hi",
      method: "foreground",
      pressEnter: false,
      focusFirst: true,
      restoreFocus: false,
      preferClipboard: false,
      pasteKey: "auto",
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(true);
    expect(r.context.autoEscalated).toBe(false);
    // Hint must NOT mention the 5-retry default (caller's force=true
    // skipped that path). It MUST mention AttachThreadInput escalation.
    expect(r.context.hint).not.toMatch(/5 SetForegroundWindow retries/);
    expect(r.context.hint).toMatch(/AttachThreadInput/);
    // Only one restoreAndFocusWindow call: the initial force=true attempt.
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: true });
  });
});
