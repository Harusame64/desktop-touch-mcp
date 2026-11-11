/**
 * internal #380 — keyboard does not type into a window that its own dialog has disabled.
 *
 * win2 (dev/953-hw, 5ccdf33a): with Notepad's Save As open, `keyboard({action:'type',
 * windowTitle:'無題 - メモ帳'})` brought the disabled Notepad in front of its dialog and answered
 * ok:true, typed:4 — plain, forceFocus and clipboard alike — with the keys in neither window, and the
 * focus moved off the dialog. Refused before anything is focused; the dialog is named.
 * Harness from `a-keyboard-does-not-switch-the-desktop.test.ts` (the same focus ladder).
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
    getLastActivePopup: vi.fn(() => null),
    getWindowTitleW: vi.fn(() => ""),
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
  // internal #221: the desktop manager says the fixture's cloaked windows are on another desktop.
  getVirtualDesktopStatus: vi.fn(async (hs: string[]) => Object.fromEntries(hs.map((h) => [h, false]))),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { pressKey: vi.fn(), releaseKey: vi.fn() },
}));

/** Which channel `foreground_flash` resolves to; wm_char posts without taking the foreground. */
const { flashChannel } = vi.hoisted(() => ({ flashChannel: { kind: "clipboard_flash" as string } }));
vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn((hwnd: bigint) => ({ kind: flashChannel.kind, hwnd, pid: 42 })),
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

import { keyboardPressHandler, keyboardTypeHandler, keyboardSequenceHandler } from "../../src/tools/keyboard.js";
import * as win32 from "../../src/engine/win32.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockPopup = vi.mocked(win32.getLastActivePopup);
const mockTitleW = vi.mocked(win32.getWindowTitleW);

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

const NOTEPAD = 100n;
const DIALOG = 555n;
const disabled = (isActive = false) => ({ ...fakeWindow("無題 - メモ帳", isActive, NOTEPAD), isEnabled: false });
const enabled = (isActive = false) => ({ ...fakeWindow("無題 - メモ帳", isActive, NOTEPAD), isEnabled: true });

function withDialog() {
  mockPopup.mockImplementation((h) => (h === NOTEPAD ? DIALOG : null));
  mockTitleW.mockImplementation((h) => (h === DIALOG ? "名前を付けて保存" : ""));
}

describe("internal #380 — keyboard and a window its dialog has disabled", () => {
  it("type is refused, nothing is focused, and the dialog is named", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardTypeHandler({ text: "k953", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 } as never));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context).toMatchObject({ hwnd: "100", dialogHwnd: "555", dialogTitle: "名前を付けて保存" });
    expect(r.suggest.join(" ")).toMatch(/context\.dialogTitle as windowTitle/);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("type with use_clipboard is refused the same way", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardTypeHandler({ text: "c953", windowTitle: "無題 - メモ帳", use_clipboard: true, method: "foreground", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("press is refused", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("sequence is refused", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardSequenceHandler({ steps: [{ keys: "shift" }], windowTitle: "無題 - メモ帳", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("method:'foreground_flash' is refused", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardTypeHandler({ text: "x", windowTitle: "無題 - メモ帳", method: "foreground_flash", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowBlockedByDialog");
  });

  it("is refused when the disabled window is already the active one", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled(true)]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowBlockedByDialog");
  });

  it("without a popup to name, the refusal still holds and names no dialog", async () => {
    mockPopup.mockImplementation(() => null);
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context.dialogTitle).toBeUndefined();
  });

  it("an enabled window is brought forward as before (control)", async () => {
    withDialog();
    mockEnum
      .mockReturnValueOnce([enabled()])
      .mockReturnValueOnce([enabled(true)]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).not.toBe("WindowBlockedByDialog");
    expect(mockRestore).toHaveBeenCalledWith(NOTEPAD, { force: false });
  });

  it("a window whose enabled state was not read is brought forward (control)", async () => {
    mockEnum
      .mockReturnValueOnce([fakeWindow("無題 - メモ帳", false, NOTEPAD)])
      .mockReturnValueOnce([fakeWindow("無題 - メモ帳", true, NOTEPAD)]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).not.toBe("WindowBlockedByDialog");
    expect(mockRestore).toHaveBeenCalled();
  });
});
