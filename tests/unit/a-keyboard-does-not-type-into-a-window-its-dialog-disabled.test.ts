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
    postCharsToHwnd: vi.fn(() => ({ sent: 4, full: true })),
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

// The blocker is found by desktop_act's finder (`_window-blocker.ts`, its own cells); here it answers.
const { blocker } = vi.hoisted(() => ({ blocker: { answer: null as null | { name: string; hwnd: bigint } | "throw" } }));
vi.mock("../../src/tools/_window-blocker.js", () => ({
  liveBlockerOf: vi.fn(() => {
    if (blocker.answer === "throw") throw new Error("read tore");
    return blocker.answer;
  }),
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
import * as guard from "../../src/tools/_action-guard.js";
import * as resolver from "../../src/tools/_resolve-window.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockPost = vi.mocked(win32.postCharsToHwnd);

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
  blocker.answer = { name: "名前を付けて保存", hwnd: DIALOG };
}
beforeEach(() => {
  blocker.answer = null;
  vi.mocked(resolver.resolveWindowTarget).mockImplementation((async ({ windowTitle }: { windowTitle?: string }) => ({ title: windowTitle, warnings: [] })) as never);
});

describe("internal #380 — keyboard and a window its dialog has disabled", () => {
  it("type is refused, nothing is focused, and the dialog is named", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardTypeHandler({ text: "k953", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 } as never));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context).toMatchObject({ hwnd: "100", dialogHwnd: "555", dialogTitle: "名前を付けて保存" });
    expect(r.suggest.join(" ")).toMatch(/context\.dialogHwnd as hwnd/);
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
    expect(r.context.method).toBe("foreground_flash");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("foreground_flash with a fixId refuses before the fix is spent", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    vi.mocked(guard.validateAndPrepareFix).mockReturnValueOnce({ ok: true, fix: { args: { windowTitle: "無題 - メモ帳" } } } as never);
    const r = parseResult(await keyboardTypeHandler({ text: "x", windowTitle: "無題 - メモ帳", method: "foreground_flash", fixId: "fix-1", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(guard.consumeFix).not.toHaveBeenCalled();
  });

  it("is refused when the disabled window is already the active one", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled(true)]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowBlockedByDialog");
  });

  it("WM_CHAR roads are refused too: method:'background' type (keys went into the dialog's field, win2)", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardTypeHandler({ text: "b954", windowTitle: "無題 - メモ帳", method: "background", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context).toMatchObject({ method: "background", dialogHwnd: "555" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("method:'background' press is refused", async () => {
    withDialog();
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "background", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context.method).toBe("background");
  });

  it("disabled with no dialog showing (a minimized owner, win2 E3) is refused, with no dialog named", async () => {
    blocker.answer = null;
    mockEnum.mockReturnValue([{ ...disabled(), isMinimized: true }]);
    const r = parseResult(await keyboardTypeHandler({ text: "m954", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context.dialogHwnd).toBeUndefined();
    expect(r.error).toMatch(/no dialog of its is showing/);
    expect(r.suggest.join(" ")).toMatch(/focus_window/);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("a blocker read that throws still refuses the disabled window, naming no dialog", async () => {
    blocker.answer = "throw";
    mockEnum.mockReturnValue([disabled()]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowBlockedByDialog");
    expect(r.context.dialogHwnd).toBeUndefined();
  });

  describe("an explicit hwnd the resolver moved onto the dialog (H3 case 5; win2 D4 typed into the dialog's field)", () => {
    const redirect = () => vi.mocked(resolver.resolveWindowTarget).mockImplementation(async ({ hwnd, windowTitle }) =>
      hwnd === "100"
        ? { title: "名前を付けて保存", hwnd: DIALOG, warnings: ["parent_disabled_prefer_popup"] }
        : { title: windowTitle!, warnings: [] }) as never;
    for (const [name, call] of [
      ["type", () => keyboardTypeHandler({ text: "w954", hwnd: "100", method: "foreground", trackFocus: false, settleMs: 0 } as never)],
      ["press", () => keyboardPressHandler({ keys: "a", hwnd: "100", method: "foreground", trackFocus: false, settleMs: 0 } as never)],
      ["sequence", () => keyboardSequenceHandler({ steps: [{ keys: "shift" }], hwnd: "100", trackFocus: false, settleMs: 0 } as never)],
    ] as const) {
      it(`${name} is refused, naming the owner and the dialog`, async () => {
        redirect();
        mockEnum.mockReturnValue([enabled()]);
        const r = parseResult(await call());
        expect(r.code).toBe("WindowBlockedByDialog");
        expect(r.context).toMatchObject({ hwnd: "100", dialogHwnd: "555", dialogTitle: "名前を付けて保存" });
        expect(mockRestore).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
      });
    }
  });

  it("on another virtual desktop as well, the desktop is what is said (as on the flash road)", async () => {
    withDialog();
    mockEnum.mockReturnValue([{ ...disabled(), isCloaked: true }]);
    const r = parseResult(await keyboardPressHandler({ keys: "a", windowTitle: "無題 - メモ帳", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowOnOtherDesktop");
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

});
