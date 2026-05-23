/**
 * tests/unit/bg-input.test.ts
 *
 * Unit tests for bg-input.ts — no real Win32 calls.
 * Mocks postMessageToHwnd, getWindowClassName, getWindowProcessId, etc.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock win32 helpers before importing bg-input
vi.mock("../../src/engine/win32.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/win32.js")>("../../src/engine/win32.js");
  return {
    ...actual,
    getWindowClassName: vi.fn().mockReturnValue("Notepad"),
    getWindowProcessId: vi.fn().mockReturnValue(1234),
    getProcessIdentityByPid: vi.fn().mockReturnValue({ pid: 1234, processName: "Notepad", processStartTimeMs: 0 }),
    getFocusedChildHwnd: vi.fn().mockReturnValue(null),
    postMessageToHwnd: vi.fn().mockReturnValue(true),
    vkToScanCode: vi.fn().mockReturnValue(0x1C),
    WM_CHAR: 0x0102,
    WM_KEYDOWN: 0x0100,
    WM_KEYUP: 0x0101,
    VK_RETURN: 0x0D,
    VK_CONTROL: 0x11,
    VK_SHIFT: 0x10,
    VK_MENU: 0x12,
  };
});

// Mock the native engine so pasteIntoConsoleNoFocus can be driven without a real
// `.node` build (issue #386: the conhost console-paste is delegated to native).
vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: {
    win32ConsolePasteNoFocus: vi.fn(),
  },
}));

import {
  canInjectViaPostMessage,
  postCharsToHwnd,
  postKeyToHwnd,
  postEnterToHwnd,
  postKeyComboToHwnd,
  isBgAutoEnabled,
  pasteIntoConsoleNoFocus,
} from "../../src/engine/bg-input.js";
import { postMessageToHwnd, getWindowClassName, getProcessIdentityByPid } from "../../src/engine/win32.js";
import { nativeWin32 } from "../../src/engine/native-engine.js";

const HWND = 0x1234n;

describe("canInjectViaPostMessage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns supported:true for standard Win32 app (Notepad)", () => {
    vi.mocked(getWindowClassName).mockReturnValue("Notepad");
    vi.mocked(getProcessIdentityByPid).mockReturnValue({ pid: 1, processName: "Notepad", processStartTimeMs: 0 });
    const result = canInjectViaPostMessage(HWND);
    expect(result.supported).toBe(true);
  });

  it("returns supported:false for Chrome_WidgetWin_1", () => {
    vi.mocked(getWindowClassName).mockReturnValue("Chrome_WidgetWin_1");
    const result = canInjectViaPostMessage(1n);  // different hwnd to bypass cache
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("chromium");
  });

  it("returns supported:false for process name 'chrome'", () => {
    vi.mocked(getWindowClassName).mockReturnValue("SomeClass");
    vi.mocked(getProcessIdentityByPid).mockReturnValue({ pid: 2, processName: "chrome", processStartTimeMs: 0 });
    const result = canInjectViaPostMessage(2n);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("chromium");
  });

  it("returns supported:false for ApplicationFrameWindow (UWP)", () => {
    vi.mocked(getWindowClassName).mockReturnValue("ApplicationFrameWindow");
    const result = canInjectViaPostMessage(3n);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("uwp_sandboxed");
  });
});

describe("postCharsToHwnd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends each ASCII character as WM_CHAR", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    const result = postCharsToHwnd(HWND, "abc");
    expect(result.sent).toBe(3);
    expect(result.full).toBe(true);
    expect(postMessageToHwnd).toHaveBeenCalledTimes(3);
  });

  it("normalises LF to CR (0x0D) for terminal compatibility", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    postCharsToHwnd(HWND, "\n");
    expect(postMessageToHwnd).toHaveBeenCalledWith(expect.anything(), 0x0102, 0x0D, 0);
  });

  it("sends surrogate pair as two consecutive WM_CHAR messages", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    // U+1F600 GRINNING FACE = 0xD83D 0xDE00
    const emoji = "\uD83D\uDE00";
    const result = postCharsToHwnd(HWND, emoji);
    expect(result.sent).toBe(2); // 2 UTF-16 code units
    expect(result.full).toBe(true);
    expect(postMessageToHwnd).toHaveBeenCalledTimes(2);
    expect(postMessageToHwnd).toHaveBeenNthCalledWith(1, expect.anything(), 0x0102, 0xD83D, 0);
    expect(postMessageToHwnd).toHaveBeenNthCalledWith(2, expect.anything(), 0x0102, 0xDE00, 0);
  });

  it("returns full:false and stops when PostMessage fails", () => {
    vi.mocked(postMessageToHwnd)
      .mockReturnValueOnce(true)  // 'a'
      .mockReturnValueOnce(false); // 'b' fails
    const result = postCharsToHwnd(HWND, "abc");
    expect(result.sent).toBe(1);
    expect(result.full).toBe(false);
  });

  it("sends Japanese BMP characters correctly", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    const result = postCharsToHwnd(HWND, "テスト");
    expect(result.sent).toBe(3);
    expect(result.full).toBe(true);
    expect(postMessageToHwnd).toHaveBeenCalledTimes(3);
    // テ = 0x30C6
    expect(postMessageToHwnd).toHaveBeenNthCalledWith(1, expect.anything(), 0x0102, 0x30C6, 0);
  });
});

describe("postKeyToHwnd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends KEYDOWN then KEYUP", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    const result = postKeyToHwnd(HWND, 0x41); // 'A'
    expect(result).toBe(true);
    expect(postMessageToHwnd).toHaveBeenCalledTimes(2);
    expect(postMessageToHwnd).toHaveBeenNthCalledWith(1, expect.anything(), 0x0100, 0x41, expect.any(Number));
    expect(postMessageToHwnd).toHaveBeenNthCalledWith(2, expect.anything(), 0x0101, 0x41, expect.any(Number));
  });
});

describe("postEnterToHwnd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends WM_CHAR with CR (0x0D)", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    postEnterToHwnd(HWND);
    expect(postMessageToHwnd).toHaveBeenCalledWith(expect.anything(), 0x0102, 0x0D, 0);
  });
});

describe("postKeyComboToHwnd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends ctrl+a: KEYDOWN ctrl, KEYDOWN/UP a, KEYUP ctrl", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    const result = postKeyComboToHwnd(HWND, "ctrl+a");
    expect(result).toBe(true);
    // ctrl down, a down, a up, ctrl up = 4 messages
    expect(postMessageToHwnd).toHaveBeenCalledTimes(4);
  });

  it("returns false for unknown key", () => {
    const result = postKeyComboToHwnd(HWND, "ctrl+xyz");
    expect(result).toBe(false);
  });

  it("sends escape (single key, no modifier)", () => {
    vi.mocked(postMessageToHwnd).mockReturnValue(true);
    const result = postKeyComboToHwnd(HWND, "escape");
    expect(result).toBe(true);
    expect(postMessageToHwnd).toHaveBeenCalledTimes(2); // KEYDOWN + KEYUP
  });
});

describe("canInjectViaPostMessage — terminal classification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns supported:false with reason 'wt_xaml_pipeline' for CASCADIA_HOSTING_WINDOW_CLASS (Windows Terminal)", () => {
    // Issue #173: WT's WinUI/XAML pipeline silently swallows WM_CHAR.
    // The fast-path that previously marked WT as supported was retracted.
    vi.mocked(getWindowClassName).mockReturnValue("CASCADIA_HOSTING_WINDOW_CLASS");
    const result = canInjectViaPostMessage(10n);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("wt_xaml_pipeline");
    expect(result.className).toBe("CASCADIA_HOSTING_WINDOW_CLASS");
  });

  it("returns supported:false for WindowsTerminal.exe process (class fallback)", () => {
    // Even when the class is not the documented WT class (e.g. WT updated and
    // exposes a new class name), the process-name guard catches it.
    vi.mocked(getWindowClassName).mockReturnValue("UnknownClass");
    vi.mocked(getProcessIdentityByPid).mockReturnValue({
      pid: 9, processName: "WindowsTerminal.exe", processStartTimeMs: 0,
    });
    const result = canInjectViaPostMessage(99n);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("wt_xaml_pipeline");
    expect(result.processName).toBe("WindowsTerminal.exe");
  });

  it("returns supported:true for ConsoleWindowClass (conhost/cmd)", () => {
    vi.mocked(getWindowClassName).mockReturnValue("ConsoleWindowClass");
    const result = canInjectViaPostMessage(11n);
    expect(result.supported).toBe(true);
  });
});

describe("pasteIntoConsoleNoFocus — native delegation + outcome mapping", () => {
  // issue #386: the conhost console-paste is delegated to the native engine
  // (win32ConsolePasteNoFocus). These tests drive the TS mapping layer with the
  // native call mocked — the real Win32 transaction is exercised by dogfood.
  const nativeFn = vi.mocked(nativeWin32!.win32ConsolePasteNoFocus!);
  beforeEach(() => nativeFn.mockReset());

  it("maps a native success to ok:true with no reason/hints, passing the resolved bigint hwnd", async () => {
    nativeFn.mockReturnValue({ ok: true, skippedFormats: [], restoreSkippedRace: false });
    const r = await pasteIntoConsoleNoFocus(HWND, "echo hi");
    expect(r).toEqual({ ok: true });
    // getFocusedChildHwnd mock returns null → resolveTarget(HWND) === HWND (bigint)
    expect(nativeFn).toHaveBeenCalledWith(HWND, "echo hi");
  });

  it("passes a native failure reason through unchanged", async () => {
    nativeFn.mockReturnValue({ ok: false, reason: "clipboard_lock_contention", skippedFormats: [], restoreSkippedRace: false });
    const r = await pasteIntoConsoleNoFocus(HWND, "x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("clipboard_lock_contention");
  });

  it("passes the console-paste-specific post_paste_failed reason through", async () => {
    nativeFn.mockReturnValue({ ok: false, reason: "post_paste_failed", skippedFormats: [], restoreSkippedRace: false });
    const r = await pasteIntoConsoleNoFocus(HWND, "x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("post_paste_failed");
  });

  it("surfaces skippedFormats (non-text formats not preserved)", async () => {
    nativeFn.mockReturnValue({ ok: true, skippedFormats: [{ formatId: 2, reason: "non_hglobal" }], restoreSkippedRace: false });
    const r = await pasteIntoConsoleNoFocus(HWND, "x");
    expect(r.ok).toBe(true);
    expect(r.skippedFormats).toEqual([{ formatId: 2, reason: "non_hglobal" }]);
  });

  it("surfaces restoreSkippedRace as a success-compatible flag", async () => {
    nativeFn.mockReturnValue({ ok: true, skippedFormats: [], restoreSkippedRace: true });
    const r = await pasteIntoConsoleNoFocus(HWND, "x");
    expect(r.ok).toBe(true);
    expect(r.restoreSkippedRace).toBe(true);
  });

  it("returns native_engine_unavailable when the addon lacks the function", async () => {
    const orig = nativeWin32!.win32ConsolePasteNoFocus;
    try {
      (nativeWin32 as { win32ConsolePasteNoFocus?: unknown }).win32ConsolePasteNoFocus = undefined;
      const r = await pasteIntoConsoleNoFocus(HWND, "x");
      expect(r).toEqual({ ok: false, reason: "native_engine_unavailable" });
    } finally {
      (nativeWin32 as { win32ConsolePasteNoFocus?: unknown }).win32ConsolePasteNoFocus = orig;
    }
  });
});

describe("isBgAutoEnabled", () => {
  it("returns false when DTM_BG_AUTO is not set", () => {
    delete process.env["DTM_BG_AUTO"];
    expect(isBgAutoEnabled()).toBe(false);
  });

  it("returns true when DTM_BG_AUTO=1", () => {
    process.env["DTM_BG_AUTO"] = "1";
    expect(isBgAutoEnabled()).toBe(true);
    delete process.env["DTM_BG_AUTO"];
  });
});
