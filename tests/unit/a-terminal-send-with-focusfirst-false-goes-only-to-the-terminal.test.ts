/**
 * internal #387 — terminal send with focusFirst:false does not paste into another app.
 *
 * win2 (internal dev/380-design-spike b7a8bbee, ab2cece9 control): `terminal send` method:'foreground',
 * focusFirst:false, naming a conhost while a Notepad was in front answered ok:true ×3 with hints.target
 * naming the console, and the text went into the Notepad each time. focusFirst:false sends to the window
 * already in front, so that window must be the terminal. Harness from
 * `a-terminal-send-does-not-switch-the-desktop.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** What the foreground read answers: a handle, null (no window in front), undefined (could not ask). */
const { front } = vi.hoisted(() => ({ front: { hwnd: 100n as bigint | null | undefined } }));

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
    // internal #286: a readable class that is not Windows Terminal ("" is a failed read, checked as WT).
    getWindowClassName: vi.fn(() => "TestTerminalClass"),
    readForegroundHwnd: vi.fn(() => front.hwnd),
    isExcludedWindowHandle: vi.fn((h: unknown) => h === 666n),
    getWindowTitleW: vi.fn((h: bigint) => (h === 200n ? "無題 - メモ帳" : h === 666n ? "SECRET LOCKER" : "PowerShell")),
  };
});

vi.mock("../../src/engine/bg-input.js", () => ({
  // internal #340
  ctrlCNotAlone: (t: string) => t.includes("\u0003") && t !== "\u0003",
  CTRL_C_ALONE_HINT: "send U+0003 alone",
  // internal #286: a read class that is neither a classic console nor Windows Terminal (class_unknown is a
  // failed read, which is checked as Windows Terminal).
  canInjectViaPostMessage: vi.fn(() => ({ supported: false, reason: "chromium", className: "TestTerminalClass" })),
  postCharsToHwnd: vi.fn(),
  postEnterToHwnd: vi.fn(),
  injectViaForegroundFlash: vi.fn(() => ({ ok: true, result: {} })),
  isBgAutoEnabled: vi.fn(() => false),
  TERMINAL_WINDOW_CLASSES: new Set<string>(),
}));

vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn((hwnd: bigint) => ({ kind: "clipboard_flash", hwnd, pid: 42 })),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve(null)),
  // internal #221: the desktop manager says the fixture's cloaked windows are on another desktop.
  getVirtualDesktopStatus: vi.fn(async (hs: string[]) => Object.fromEntries(hs.map((h) => [h, false]))),
}));

vi.mock("../../src/engine/ocr-bridge.js", () => ({
  recognizeWindow: vi.fn(),
  ocrWordsToLines: vi.fn(),
  detectOcrLanguage: () => "en",
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  handleObservationKey: (hwnd: bigint) => `hwnd:${hwnd}`,
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
import * as nut from "../../src/engine/nutjs.js";

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

const terminal = (isActive: boolean) => fakeWindow("PowerShell", isActive, 100n);
const send = () => terminalSendHandler({
  windowTitle: "PowerShell", input: "c1x", method: "foreground", pressEnter: false, focusFirst: false,
  restoreFocus: false, preferClipboard: false, pasteKey: "auto", trackFocus: false, settleMs: 0,
});

const typed = () => vi.mocked(nut.keyboard.type);

describe("internal #387 — focusFirst:false and the window in front", () => {
  beforeEach(() => { front.hwnd = 100n; });

  it("another app in front: refused, nothing typed, and the reply names the window in front", async () => {
    front.hwnd = 200n;
    mockEnum.mockReturnValue([terminal(false), { ...fakeWindow("無題 - メモ帳", true, 200n) }]);
    const r = parseResult(await send());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TerminalNotInFront");
    expect(r.context).toMatchObject({ hwnd: "100", inFront: { hwnd: "200", title: "無題 - メモ帳" } });
    expect(typed()).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("the terminal's own dialog in front (it would take the keys): refused", async () => {
    front.hwnd = 300n;
    mockEnum.mockReturnValue([terminal(false)]);
    const r = parseResult(await send());
    expect(r.code).toBe("TerminalNotInFront");
    expect(typed()).not.toHaveBeenCalled();
  });

  it("no window in front (locked, secure desktop): refused, inFront null", async () => {
    front.hwnd = null;
    mockEnum.mockReturnValue([terminal(false)]);
    const r = parseResult(await send());
    expect(r.code).toBe("TerminalNotInFront");
    expect(r.context.inFront).toBeNull();
    expect(typed()).not.toHaveBeenCalled();
  });

  it("the key locker's secure dialog in front: refused without naming it", async () => {
    front.hwnd = 666n;
    mockEnum.mockReturnValue([terminal(false)]);
    const r = parseResult(await send());
    expect(r.code).toBe("TerminalNotInFront");
    expect(r.context.inFront).toEqual({ excluded: true });
    expect(JSON.stringify(r)).not.toContain("SECRET LOCKER");
    expect(JSON.stringify(r)).not.toContain("666");
  });

  it("the terminal in front: sent as before (control)", async () => {
    mockEnum.mockReturnValue([terminal(true)]);
    const r = parseResult(await send());
    expect(r.code).not.toBe("TerminalNotInFront");
    expect(typed()).toHaveBeenCalled();
  });

  it("the OS cannot be asked: sent as before (it may be the terminal)", async () => {
    front.hwnd = undefined;
    mockEnum.mockReturnValue([terminal(true)]);
    const r = parseResult(await send());
    expect(r.code).not.toBe("TerminalNotInFront");
    expect(typed()).toHaveBeenCalled();
  });

  it("a sign-extended handle of the terminal counts as the terminal", async () => {
    front.hwnd = 0xffffffff00000064n; // the upper half set, low 32 bits = 100
    mockEnum.mockReturnValue([terminal(true)]);
    const r = parseResult(await send());
    expect(r.code).not.toBe("TerminalNotInFront");
    expect(typed()).toHaveBeenCalled();
  });

  it("focusFirst:true is not asked (it brings the terminal in front itself)", async () => {
    front.hwnd = 200n;
    mockEnum
      .mockReturnValueOnce([terminal(false), { ...fakeWindow("無題 - メモ帳", true, 200n) }])
      .mockReturnValue([terminal(true)]);
    const r = parseResult(await terminalSendHandler({
      windowTitle: "PowerShell", input: "c1x", method: "foreground", pressEnter: false, focusFirst: true,
      restoreFocus: false, preferClipboard: false, pasteKey: "auto", trackFocus: false, settleMs: 0,
    }));
    expect(r.code).not.toBe("TerminalNotInFront");
    expect(typed()).toHaveBeenCalled();
  });
});
