/**
 * internal #221 — `keyboard` with a plain title focuses a window on the screen.
 *
 * Harness copied from `issue-207-foreground-refusal-press.test.ts`, which drives the same
 * `focusWindowForKeyboard` ladder.
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
  // ADR-038: this file replaces the whole `_action-guard` module (no
  // `importOriginal`), so every export the handler reaches must be stubbed or
  // the call throws before the foreground ladder it pins is exercised. The
  // fixtures below all pass `windowTitle`, so the real helper would answer
  // `{ok:true}` here too.
  assertKeyboardDestination: vi.fn(() => ({ ok: true })),
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

describe("internal #221 — keyboard focuses the same-titled window on the screen", () => {
  it("brings forward the visible window, not the cloaked one ahead of it in Z-order", async () => {
    // win2 cell a: the cloaked window (another virtual desktop) came first and was brought
    // forward, which switched the user's desktop.
    const offDesktop = { ...fakeWindow("QV221", false, 100n), isCloaked: true };
    const onScreen = { ...fakeWindow("QV221", false, 200n), isCloaked: false };
    mockEnum
      .mockReturnValueOnce([offDesktop, onScreen])
      .mockReturnValueOnce([offDesktop, { ...onScreen, isActive: true }]);

    await keyboardPressHandler({ keys: "ctrl+n", windowTitle: "QV221", method: "foreground", trackFocus: false, settleMs: 0 });

    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(200n, { force: false });
  });

  it("brings forward the first one when neither is cloaked (control)", async () => {
    const first = { ...fakeWindow("QV221", false, 100n), isCloaked: false };
    const second = { ...fakeWindow("QV221", false, 200n), isCloaked: false };
    mockEnum
      .mockReturnValueOnce([first, second])
      .mockReturnValueOnce([{ ...first, isActive: true }, second]);

    await keyboardPressHandler({ keys: "ctrl+n", windowTitle: "QV221", method: "foreground", trackFocus: false, settleMs: 0 });

    expect(mockRestore).toHaveBeenCalledWith(100n, { force: false });
  });
});
