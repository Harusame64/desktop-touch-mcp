/**
 * internal #221 — terminal send does not bring a window on another virtual desktop forward.
 *
 * `terminal(send)` with the foreground method focuses its window before pasting; for a window on
 * another virtual desktop that switches the user's desktop. Harness from
 * `issue-207-foreground-refusal-terminal.test.ts`.
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
  detectOcrLanguage: () => "en",
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  observeTarget: vi.fn(() => ({ identity: {}, invalidatedBy: null, previousTarget: null })),
  buildCacheStateHints: vi.fn(() => ({})),
  toTargetHints: vi.fn(() => ({})),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
}));

// ADR-033 PR-2: `typeViaClipboard` reports what happened to the user's
// clipboard, and `terminal(action='send')` forwards that into hints.clipboard.
// Returning `undefined` here would skip that whole branch, so these tests
// would keep passing while the plumbing was broken. `importOriginal` keeps the
// real `clipboardPasteHints` formatting rather than a copy of it.
vi.mock(import("../../src/tools/keyboard.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  typeViaClipboard: vi.fn(() => Promise.resolve({ backend: "native", clipboardRestored: true })),
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

const offDesktop = (hwnd: bigint) => ({ ...fakeWindow("PowerShell", false, hwnd), isCloaked: true });
const onScreen = (hwnd: bigint) => ({ ...fakeWindow("PowerShell", false, hwnd), isCloaked: false });
const send = () => terminalSendHandler({
  windowTitle: "PowerShell", input: "echo hi", method: "foreground", pressEnter: false, focusFirst: true,
  restoreFocus: false, preferClipboard: false, pasteKey: "auto", trackFocus: false, settleMs: 0,
});

describe("internal #221 — terminal:send and a window on another virtual desktop", () => {
  it("refuses, before focusing, when the terminal is on another desktop", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await send());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(r.context).toMatchObject({ hwnd: "100", sameTitleOnScreen: true });
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("focuses the terminal when it is on this desktop (control)", async () => {
    mockEnum.mockReturnValue([onScreen(100n), offDesktop(200n)]);
    const r = parseResult(await send());
    expect(r.code).not.toBe("WindowOnOtherDesktop");
    expect(mockRestore).toHaveBeenCalledWith(100n);
  });
});
