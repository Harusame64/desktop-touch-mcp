/**
 * internal #286 — terminal send to Windows Terminal takes the foreground without asking, and checks
 * the destination the way desktop_act does around its question: not the window in front, a readable
 * selected tab with exactly one pane, and the same tab once the window is in front.
 *
 * Harness from `a-terminal-send-does-not-switch-the-desktop.test.ts`.
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
    getWindowClassName: vi.fn(() => "CASCADIA_HOSTING_WINDOW_CLASS"),
    getForegroundHwnd: vi.fn(() => 900n),
    getWindowRoot: vi.fn((h: bigint) => h),
  };
});

vi.mock("../../src/engine/bg-input.js", () => ({
  // internal #340
  ctrlCNotAlone: (t: string) => t.includes("\u0003") && t !== "\u0003",
  CTRL_C_ALONE_HINT: "send U+0003 alone",
  canInjectViaPostMessage: vi.fn(() => ({ supported: false, reason: "class_unknown" })),
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
  getSelectedTab: vi.fn(),
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
import * as uia from "../../src/engine/uia-bridge.js";
import * as bg from "../../src/engine/bg-input.js";
import * as kb from "../../src/tools/keyboard.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockFg = vi.mocked(win32.getForegroundHwnd);
const mockRoot = vi.mocked(win32.getWindowRoot);
const mockClass = vi.mocked(win32.getWindowClassName);
const mockTab = vi.mocked(uia.getSelectedTab);
const mockPaste = vi.mocked(kb.typeViaClipboard);
const mockFlash = vi.mocked(bg.injectViaForegroundFlash);

const WT = 100n;
const OTHER = 900n;

function win(hwnd: bigint, title: string, isActive: boolean) {
  return {
    hwnd, title, isActive, zOrder: isActive ? 0 : 1, isMinimized: false, isMaximized: false, isCloaked: false,
    region: { x: 0, y: 0, width: 800, height: 600 }, processName: "test.exe",
  };
}

/** Before the focus: the user's window is in front. After it: WT is (as the focus loop reads it). */
let wtInFront = false;
function screen() {
  return [win(WT, "PowerShell", wtInFront), win(OTHER, "Editor", !wtInFront)];
}

const tab = (runtimeId: string, paneCount = 1) => ({ name: "PowerShell", runtimeId, paneCount });

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

const send = (over: Record<string, unknown> = {}) => terminalSendHandler({
  windowTitle: "PowerShell", input: "echo hi", method: "auto", pressEnter: false, focusFirst: true,
  restoreFocus: true, preferClipboard: true, pasteKey: "auto", trackFocus: false, settleMs: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  wtInFront = false;
  mockEnum.mockImplementation(() => screen());
  mockRestore.mockImplementation((h: unknown) => {
    if (h === WT) wtInFront = true;
    if (h === OTHER) wtInFront = false;
    return { x: 0, y: 0, width: 800, height: 600 };
  });
  mockFg.mockImplementation(() => (wtInFront ? WT : OTHER));
  mockRoot.mockImplementation((h: bigint) => h);
  mockClass.mockReturnValue("CASCADIA_HOSTING_WINDOW_CLASS");
  mockTab.mockResolvedValue(tab("rt-1"));
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
});

describe("internal #286 — terminal:send to Windows Terminal through the foreground", () => {
  it("pastes when WT is behind and its tab is one terminal pane, and the tab is the same after the focus", async () => {
    const r = parseResult(await send());
    expect(r.ok).toBe(true);
    expect(mockPaste).toHaveBeenCalledTimes(1);
    // Read once before the focus and once after it.
    expect(mockTab).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenCalledWith(WT);
  });

  it("refuses, before focusing, when WT is the window in front", async () => {
    wtInFront = true;
    const r = parseResult(await send());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail: "in_front" });
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("counts a child of WT in front as WT in front", async () => {
    mockFg.mockReturnValue(555n);
    mockRoot.mockImplementation((h: bigint) => (h === 555n ? WT : h));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "in_front" });
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("fails closed when the foreground cannot be read", async () => {
    mockFg.mockReturnValue(null);
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "in_front" });
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it.each([
    ["tab_split", tab("rt-1", 2)],
    ["tab_not_terminal", tab("rt-1", 0)],
    ["tab_unreadable", undefined],
    ["tab_unreadable", null],
  ] as const)("refuses %s before focusing", async (detail, t) => {
    mockTab.mockResolvedValue(t as never);
    const r = parseResult(await send());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail });
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("refuses when the selected tab changed while WT came forward, and puts the user's window back", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    const r = parseResult(await send());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail: "tab_changed" });
    expect(r.error).toContain('(it was "PowerShell")');
    expect(mockPaste).not.toHaveBeenCalled();
    expect(mockRestore).toHaveBeenLastCalledWith(OTHER);
  });

  it("refuses when the tab became split while WT came forward", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-1", 2));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_split" });
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("checks the same way on method:'foreground' and on a run's exit-mode send (which forces it)", async () => {
    wtInFront = true;
    const r = parseResult(await send({ method: "foreground" }));
    expect(r.context).toMatchObject({ detail: "in_front" });
  });

  it("does not check with focusFirst:false: the caller types into the window in front on purpose", async () => {
    wtInFront = true;
    const r = parseResult(await send({ focusFirst: false }));
    expect(r.ok).toBe(true);
    expect(mockTab).not.toHaveBeenCalled();
  });

  it("does not check a classic console (control)", async () => {
    mockClass.mockReturnValue("ConsoleWindowClass");
    wtInFront = true;
    const r = parseResult(await send({ method: "foreground" }));
    expect(r.ok).toBe(true);
    expect(mockTab).not.toHaveBeenCalled();
  });
});

describe("internal #286 — terminal:send method:'foreground_flash' to Windows Terminal", () => {
  const flash = () => send({ method: "foreground_flash" });

  it("refuses when WT is the window in front, and does not flash", async () => {
    wtInFront = true;
    const r = parseResult(await flash());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail: "in_front", method: "foreground_flash" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("refuses a split tab, and does not flash", async () => {
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "tab_split" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("hands the flash the tab to hold to and asks it to focus the terminal pane", async () => {
    const r = parseResult(await flash());
    expect(r.ok).toBe(true);
    expect(mockFlash).toHaveBeenCalledWith(WT, 42, "echo hi",
      expect.objectContaining({ focusTerminalPane: true, expectedTabRuntimeId: "rt-1" }));
  });
});
