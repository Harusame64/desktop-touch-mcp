/**
 * resolve-log-terminal-sink.test.ts — ADR-035 Phase 1, terminal end.
 *
 * Same contract as the keyboard sink test: the `dispatch_sink` event has to be
 * emitted by the REAL handler on the REAL branch, and it must describe a write
 * that actually left the process.
 *
 * The case that motivated this file: `terminal(action='send')`'s `input` has no
 * minimum length, so `input: ""` runs the chunked WM_CHAR loop zero times. An
 * event emitted before the loop would record a send that never happened (Opus
 * Round 2 P1). The mock surface mirrors `terminal-send-console-paste.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => "ConsoleWindowClass"),
    getForegroundHwnd: vi.fn(() => 100n),
    getWindowTitleW: vi.fn(() => "bash"),
    getWindowIdentity: vi.fn(() => ({ pid: 5, processName: "pwsh.exe", processStartTimeMs: 0 })),
  };
});

vi.mock("../../src/engine/bg-input.js", () => ({
  canInjectViaPostMessage: vi.fn(() => ({ supported: true })),
  postCharsToHwnd: vi.fn((_hwnd: unknown, chunk: string) => ({ sent: chunk.length, full: true })),
  postEnterToHwnd: vi.fn(),
  isBgAutoEnabled: vi.fn(() => false),
  injectViaForegroundFlash: vi.fn(),
  pasteIntoConsoleNoFocus: vi.fn(() => Promise.resolve({ ok: true })),
  TERMINAL_WINDOW_CLASSES: new Set<string>(["ConsoleWindowClass"]),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("user@host:~$ ")),
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

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

// Defence in depth: these fixtures never take the clipboard branch
// (`preferClipboard: false`), but the real `typeViaClipboard` writes the real
// clipboard and sends a real Ctrl+V, so it must not be reachable from a unit
// run at all. Same stub the sibling terminal suites use.
vi.mock(import("../../src/tools/keyboard.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  typeViaClipboard: vi.fn(() => Promise.resolve({ backend: "native", clipboardRestored: true })),
}));

// See `tests/unit/setup-diagnostic-log.ts`: the log is disabled process-wide for
// unit runs, so a test that wants to OBSERVE events re-enables it here and
// captures them through the mock.
const mockLogDiagnostic = vi.fn();
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return {
    ...actual,
    logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])),
    isDiagnosticLogEnabled: () => true,
  };
});

import { terminalSendHandler } from "../../src/tools/terminal.js";
import * as win32 from "../../src/engine/win32.js";
import * as bgInput from "../../src/engine/bg-input.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockClass = vi.mocked(win32.getWindowClassName);
const mockChars = vi.mocked(bgInput.postCharsToHwnd);
const mockPaste = vi.mocked(bgInput.pasteIntoConsoleNoFocus);

function fakeWindow(title: string, hwnd = 100n) {
  return {
    hwnd, title,
    isActive: true, zOrder: 0, isMinimized: false, isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
  };
}

function sinks(): Array<Record<string, any>> {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, any>)
    .filter((e) => e.kind === "dispatch_sink");
}

const baseArgs = {
  windowTitle: "bash",
  input: "echo hi",
  // `background` keeps the send on the chunked WM_CHAR loop rather than the
  // console-paste route (`shouldUseConsolePasteForSend` returns false).
  method: "background" as const,
  chunkSize: 100,
  pressEnter: false,
  focusFirst: false,
  restoreFocus: false,
  preferClipboard: false,
  pasteKey: "auto" as const,
  trackFocus: false,
  settleMs: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnum.mockReturnValue([fakeWindow("bash")]);
  mockClass.mockReturnValue("ConsoleWindowClass");
  mockChars.mockImplementation((_hwnd: unknown, chunk: string) => ({ sent: chunk.length, full: true }));
  mockPaste.mockResolvedValue({ ok: true });
});

describe("ADR-035 Phase 1 — terminal:send dispatch sink (real handler)", () => {
  it("records one wm_char event against the resolved handle for a chunked send", async () => {
    await terminalSendHandler({ ...baseArgs });
    expect(mockChars).toHaveBeenCalled();
    expect(sinks()).toHaveLength(1);
    expect(sinks()[0]).toMatchObject({
      sink: "wm_char",
      tool: "terminal:send",
      targetHwnd: "100",
    });
  });

  it("records ONE event for a multi-chunk send, not one per chunk", async () => {
    await terminalSendHandler({ ...baseArgs, input: "abcdefghij", chunkSize: 2 });
    expect(mockChars.mock.calls.length).toBeGreaterThan(1);
    expect(sinks()).toHaveLength(1);
  });

  it("records NOTHING for an empty input — the loop runs zero times", async () => {
    await terminalSendHandler({ ...baseArgs, input: "" });
    expect(mockChars).not.toHaveBeenCalled();
    expect(sinks()).toHaveLength(0);
  });

  it("logs the resolution that chose the window, with its process identity", async () => {
    await terminalSendHandler({ ...baseArgs });
    const resolves = mockLogDiagnostic.mock.calls
      .map((c) => c[0] as Record<string, any>)
      .filter((e) => e.kind === "resolve" && e.resolver === "findTerminalWindow");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({
      matchCount: 1,
      chosen: { hwnd: "100", pid: 5, processName: "pwsh.exe" },
    });
    expect(resolves[0]!.fallback).toBeUndefined();
  });
});
