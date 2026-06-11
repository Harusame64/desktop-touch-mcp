/**
 * terminal-send-console-paste.test.ts
 *
 * Pins the conhost `action=send` → native console-paste routing
 * (plan: desktop-touch-mcp-internal/docs/terminal-send-conhost-console-paste-plan.md).
 *
 * Two layers:
 *   1. shouldUseConsolePasteForSend (pure) — the static §3.1 matrix.
 *   2. terminalSendHandler (mocked) — the runtime gate: secret carve-out,
 *      paste-failure fall-through, pressEnter:false, trailing-newline strip,
 *      and method:'background' staying on WM_CHAR.
 *
 * Mock surface mirrors issue-207-foreground-refusal-terminal.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => "ConsoleWindowClass"),
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

vi.mock("../../src/tools/keyboard.js", () => ({
  typeViaClipboard: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

import { terminalSendHandler, shouldUseConsolePasteForSend } from "../../src/tools/terminal.js";
import * as win32 from "../../src/engine/win32.js";
import * as bgInput from "../../src/engine/bg-input.js";
import * as uia from "../../src/engine/uia-bridge.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockClass = vi.mocked(win32.getWindowClassName);
const mockPaste = vi.mocked(bgInput.pasteIntoConsoleNoFocus);
const mockChars = vi.mocked(bgInput.postCharsToHwnd);
const mockBaseline = vi.mocked(uia.getTextViaTextPattern);

function fakeWindow(title: string, hwnd = 100n) {
  return {
    hwnd,
    title,
    isActive: true,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
    processName: "pwsh.exe",
  };
}

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

const baseArgs = {
  windowTitle: "bash",
  input: "echo hi",
  method: "auto" as const,
  chunkSize: 100,
  pressEnter: true,
  focusFirst: true,
  restoreFocus: false,
  preferClipboard: true,
  pasteKey: "auto" as const,
  trackFocus: false,
  settleMs: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnum.mockReturnValue([fakeWindow("bash")]);
  mockClass.mockReturnValue("ConsoleWindowClass");
  mockPaste.mockResolvedValue({ ok: true });
  mockChars.mockImplementation((_hwnd: unknown, chunk: string) => ({ sent: chunk.length, full: true }));
  mockBaseline.mockResolvedValue("user@host:~$ "); // non-secret prompt
});

describe("shouldUseConsolePasteForSend (pure §3.1 matrix)", () => {
  it("auto + conhost + pressEnter → true", () => {
    expect(shouldUseConsolePasteForSend("auto", "ConsoleWindowClass", true)).toBe(true);
  });
  it("auto + conhost + pressEnter:false → false (native always Enters)", () => {
    expect(shouldUseConsolePasteForSend("auto", "ConsoleWindowClass", false)).toBe(false);
  });
  it("background + conhost → false (keeps WM_CHAR / #183)", () => {
    expect(shouldUseConsolePasteForSend("background", "ConsoleWindowClass", true)).toBe(false);
  });
  it("foreground + conhost → false (Ctrl+V path / OQ-1)", () => {
    expect(shouldUseConsolePasteForSend("foreground", "ConsoleWindowClass", true)).toBe(false);
  });
  it("auto + non-conhost (WT) → false", () => {
    expect(shouldUseConsolePasteForSend("auto", "CASCADIA_HOSTING_WINDOW_CLASS", true)).toBe(false);
  });
});

describe("terminalSendHandler — conhost console-paste routing", () => {
  it("(a) auto + conhost + non-secret → console-paste, channel:'console_paste', no WM_CHAR", async () => {
    const r = parseResult(await terminalSendHandler({ ...baseArgs }));
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("console_paste");
    expect(r.method).toBe("background");
    expect(r.pressedEnter).toBe(true);
    expect(mockPaste).toHaveBeenCalledTimes(1);
    expect(mockChars).not.toHaveBeenCalled();
  });

  it("(b) console-paste ok:false → falls through to WM_CHAR (channel:'wm_char')", async () => {
    mockPaste.mockResolvedValue({ ok: false, reason: "post_paste_failed" });
    const r = parseResult(await terminalSendHandler({ ...baseArgs }));
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("wm_char");
    expect(mockPaste).toHaveBeenCalledTimes(1);
    expect(mockChars).toHaveBeenCalled(); // WM_CHAR fall-through delivered
  });

  it("(c) pressEnter:false → never calls console-paste, uses WM_CHAR", async () => {
    const r = parseResult(await terminalSendHandler({ ...baseArgs, pressEnter: false }));
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("wm_char");
    expect(mockPaste).not.toHaveBeenCalled();
    expect(mockChars).toHaveBeenCalled();
  });

  it("(d) ONE trailing newline stripped before console-paste (native adds the Enter)", async () => {
    await terminalSendHandler({ ...baseArgs, input: "ls -la\n" });
    expect(mockPaste).toHaveBeenCalledTimes(1);
    expect(mockPaste).toHaveBeenCalledWith(expect.anything(), "ls -la");
  });

  it("(d2) only ONE trailing newline stripped — N>=2 preserved (REPL blank-line terminator)", async () => {
    // Native console-paste always appends exactly one Enter, so to deliver N
    // trailing Enters (e.g. a Python def whose blank line terminates the block)
    // we strip exactly one and let the native Enter re-add it: N-1 survive in the
    // pasted text + 1 native Enter = N. Stripping all (the previous bug) would
    // collapse this to a single Enter and leave the REPL mid-block.
    await terminalSendHandler({ ...baseArgs, input: "def f():\n  return 1\n\n" });
    expect(mockPaste).toHaveBeenCalledWith(expect.anything(), "def f():\n  return 1\n");
  });

  it("(d3) trailing CRLF treated as one line break (stripped whole, not half)", async () => {
    await terminalSendHandler({ ...baseArgs, input: "whoami\r\n" });
    expect(mockPaste).toHaveBeenCalledWith(expect.anything(), "whoami");
  });

  it("(e) secret prompt baseline → carve-out skips console-paste, uses WM_CHAR (no clipboard)", async () => {
    mockBaseline.mockResolvedValue("[sudo] password for alice: ");
    const r = parseResult(await terminalSendHandler({ ...baseArgs }));
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("wm_char");
    expect(mockPaste).not.toHaveBeenCalled();
    expect(mockChars).toHaveBeenCalled();
  });

  it("(e2) bash PS2 bare-'>' is NOT treated as secret → console-paste still used", async () => {
    mockBaseline.mockResolvedValue("> ");
    const r = parseResult(await terminalSendHandler({ ...baseArgs }));
    expect(r.channel).toBe("console_paste");
    expect(mockPaste).toHaveBeenCalledTimes(1);
  });

  it("(e3) unreadable baseline (null) → safe default keeps WM_CHAR", async () => {
    mockBaseline.mockResolvedValue(null);
    const r = parseResult(await terminalSendHandler({ ...baseArgs }));
    expect(r.channel).toBe("wm_char");
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("(f) method:'background' → WM_CHAR, console-paste never called (channel:'wm_char')", async () => {
    mockBaseline.mockResolvedValue(null); // skip background's post-send verify
    const r = parseResult(await terminalSendHandler({ ...baseArgs, method: "background" }));
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("wm_char");
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("(g) console-paste surfaces skippedFormats/restoreSkippedRace as warnings", async () => {
    mockPaste.mockResolvedValue({
      ok: true,
      skippedFormats: [{ formatId: 2, reason: "non_hglobal" }],
      restoreSkippedRace: true,
    });
    const r = parseResult(await terminalSendHandler({ ...baseArgs }));
    expect(r.channel).toBe("console_paste");
    expect(r.hints.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("2(non_hglobal)"),
        expect.stringContaining("clipboard restore skipped"),
      ]),
    );
  });
});
