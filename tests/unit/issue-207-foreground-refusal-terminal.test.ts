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
    // findTerminalWindow's first try (title-substring match on enum
    // result) hits the target directly when test setup uses
    // `target.title === windowTitle`. The process-identity fallback
    // (getProcessIdentityByPid / getWindowProcessId) is therefore not
    // exercised here — kept unmocked to avoid dead mock surface (Opus
    // PR #209 Round 1 P2-3); if a future test exercises an alias-style
    // `windowTitle: 'pwsh'` against a target titled differently, those
    // mocks will need to be re-added explicitly.
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
    // Production enum sequence (Opus PR #209 Round 1 P3-1): findTerminalWindow
    // (1) + allBefore capture for restoreFocus tracking (1) + 5-retry default
    // loop (5) + auto-escalate re-enum (1) = 8 total. We use mockReturnValue
    // (constant) and additionally pin the count below so a future ladder
    // change (e.g. retry count drift) is caught structurally — Opus PR #209
    // Round 1 P2-1 (test brittleness avoidance).
    const target = fakeWindow("PowerShell", false, 100n);
    const sticky = fakeWindow("Sticky Foreground", true, 200n);
    const refusalEnum = [target, sticky];

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
    // Opus PR #209 Round 1 P2-1: pin enum call count too — 1 find +
    // 1 allBefore (restoreFocus capture) + 5 retry + 1 escalate = 8.
    // A future ladder change (e.g. retry count drift) breaks this
    // structural pin, not just a vague "still refusing" mock.
    expect(mockEnum).toHaveBeenCalledTimes(8);
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
