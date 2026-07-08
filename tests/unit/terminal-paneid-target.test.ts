/**
 * terminal-paneid-target.test.ts — ADR-014 R3 OQ-W-16-bis Phase 1.
 *
 * The optional `paneId` (decimal hwnd) target on terminal read/send:
 *   - findTerminalWindowByHwnd: exact-hwnd, ConsoleWindowClass-only, live-or-null.
 *   - send resolves the window DIRECTLY by hwnd (survives a title change); malformed / gone → typed decline.
 *   - read resolves via resolveTitleByHwnd (title-keyed downstream), safe-declines on a non-unique title.
 *
 * Mock surface mirrors terminal-send-console-paste.test.ts.
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
  isBgAutoEnabled: vi.fn(() => true),
  injectViaForegroundFlash: vi.fn(),
  pasteIntoConsoleNoFocus: vi.fn(() => Promise.resolve({ ok: true })),
  TERMINAL_WINDOW_CLASSES: new Set<string>(["ConsoleWindowClass"]),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("dtmdogfood@host:~$ ")),
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

import {
  findTerminalWindowByHwnd,
  terminalSendHandler,
  terminalReadHandler,
} from "../../src/tools/terminal.js";
import * as win32 from "../../src/engine/win32.js";
import * as bgInput from "../../src/engine/bg-input.js";
import * as uia from "../../src/engine/uia-bridge.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockChars = vi.mocked(bgInput.postCharsToHwnd);
const mockUia = vi.mocked(uia.getTextViaTextPattern);

function fakeWindow(title: string, hwnd: bigint, className = "ConsoleWindowClass") {
  return {
    hwnd,
    title,
    className,
    isActive: true,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
    processName: "powershell.exe",
  } as unknown as win32.WindowZInfo;
}

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const sendArgs = (over: Record<string, unknown>) => ({
  windowTitle: "ignored", input: "echo hi", method: "background" as const, chunkSize: 100,
  pressEnter: false, focusFirst: false, restoreFocus: false, preferClipboard: false,
  pasteKey: "auto" as const, trackFocus: false, settleMs: 0, ...over,
});

const readArgs = (over: Record<string, unknown>) => ({
  windowTitle: "ignored", lines: 50, stripAnsi: true, source: "uia" as const, ...over,
});

beforeEach(() => {
  mockEnum.mockReset();
  mockChars.mockClear();
});

describe("findTerminalWindowByHwnd (Phase 1)", () => {
  it("returns the window with the EXACT hwnd when it is a ConsoleWindowClass", () => {
    mockEnum.mockReturnValue([fakeWindow("a", 10n), fakeWindow("b", 20n)]);
    expect(findTerminalWindowByHwnd(20n)?.hwnd).toBe(20n);
  });
  it("returns null when the hwnd is not present (vanished pane)", () => {
    mockEnum.mockReturnValue([fakeWindow("a", 10n)]);
    expect(findTerminalWindowByHwnd(99n)).toBeNull();
  });
  it("returns null when the hwnd exists but is NOT a ConsoleWindowClass (e.g. WT)", () => {
    mockEnum.mockReturnValue([fakeWindow("wt", 30n, "CASCADIA_HOSTING_WINDOW_CLASS")]);
    expect(findTerminalWindowByHwnd(30n)).toBeNull();
  });
});

describe("terminal send paneId (Phase 1 — hwnd-direct, survives title drift)", () => {
  it("routes the send to the EXACT hwnd, not a same-title sibling", async () => {
    // Two same-title consoles: a title-substring lookup would be ambiguous, but paneId binds by hwnd.
    // The test's purpose is the ROUTING (which hwnd the WM_CHAR reaches); the full delivery-verification
    // path (post-send echo read-back) is exercised by the live dogfood, not asserted here.
    mockEnum.mockReturnValue([fakeWindow("dtmdogfood@host: ~", 111n), fakeWindow("dtmdogfood@host: ~", 222n)]);
    mockUia.mockResolvedValue("dtmdogfood@host: ~ whoami");
    await terminalSendHandler(sendArgs({ paneId: "222", input: "whoami" }));
    // WM_CHAR (background) went to hwnd 222 — never the same-title sibling 111.
    expect(mockChars).toHaveBeenCalled();
    expect(mockChars.mock.calls[0][0]).toBe(222n);
  });
  it("declines a malformed paneId with a typed window-not-found", async () => {
    mockEnum.mockReturnValue([fakeWindow("x", 1n)]);
    const r = parseResult(await terminalSendHandler(sendArgs({ paneId: "not-a-number" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
  it("declines a vanished / non-console paneId", async () => {
    mockEnum.mockReturnValue([fakeWindow("x", 1n)]);
    const r = parseResult(await terminalSendHandler(sendArgs({ paneId: "999" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
});

describe("terminal read paneId (Phase 1 — safe-declines on a non-unique title)", () => {
  it("reads the pane when its title is still unique (happy path)", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-abc", 222n), fakeWindow("PowerShell", 111n)]);
    mockUia.mockResolvedValue("dtmdogfood@host:~$ ready");
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "222" })));
    expect(r.ok).not.toBe(false);
    expect(String(r.text)).toContain("ready");
  });
  it("declines (never wrong-reads) when the pane's title is no longer unique", async () => {
    // Same-title sibling ⇒ resolveTitleByHwnd cannot hand a unique title to the UIA read ⇒ decline.
    mockEnum.mockReturnValue([fakeWindow("dtmdogfood@host: ~", 111n), fakeWindow("dtmdogfood@host: ~", 222n)]);
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "222" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
  it("declines a malformed paneId", async () => {
    mockEnum.mockReturnValue([fakeWindow("x", 1n)]);
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "bad" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
});
