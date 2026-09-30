/**
 * internal #221 — keyboard does not bring a window on another virtual desktop forward.
 *
 * win2 (2026-09-30): with a same-titled window on another virtual desktop first in Z-order,
 * `keyboard(windowTitle)` brought it forward, which switched the user's desktop, and typed nothing.
 * Which window the title picks is unchanged; bringing it forward is refused.
 * Harness from `issue-207-foreground-refusal-press.test.ts` (same `focusWindowForKeyboard` ladder).
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

const offDesktop = (hwnd: bigint, title = "QV221") => ({ ...fakeWindow(title, false, hwnd), isCloaked: true });
const onScreen = (hwnd: bigint, title = "QV221") => ({ ...fakeWindow(title, false, hwnd), isCloaked: false });

describe("internal #221 — keyboard and a window on another virtual desktop", () => {
  it("refuses a title whose first window is on another desktop, and says one with that title is here", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await keyboardPressHandler({ keys: "ctrl+n", windowTitle: "QV221", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(r.context).toMatchObject({ hwnd: "100", sameTitleOnScreen: true });
    expect(r.suggest.join(" ")).toMatch(/name that one exactly/);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("refuses with sameTitleOnScreen:false when no window with the title is here", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(300n, "Other")]);
    const r = parseResult(await keyboardPressHandler({ keys: "ctrl+n", windowTitle: "QV221", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(r.context.sameTitleOnScreen).toBe(false);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("brings the first window forward when it is on this desktop (control)", async () => {
    mockEnum
      .mockReturnValueOnce([onScreen(100n), offDesktop(200n)])
      .mockReturnValueOnce([{ ...onScreen(100n), isActive: true }, offDesktop(200n)]);
    const r = parseResult(await keyboardPressHandler({ keys: "ctrl+n", windowTitle: "QV221", method: "foreground", trackFocus: false, settleMs: 0 }));
    expect(r.code).not.toBe("WindowOnOtherDesktop");
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: false });
  });

  it("refuses method:'foreground_flash' to a window on another desktop", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await keyboardTypeHandler({ text: "x", windowTitle: "QV221", method: "foreground_flash", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(r.context).toMatchObject({ hwnd: "100", method: "foreground_flash" });
  });

  it("refuses keyboard:type (foreground) the same way", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await keyboardTypeHandler({ text: "x", windowTitle: "QV221", method: "foreground", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("refuses keyboard:sequence the same way", async () => {
    mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
    const r = parseResult(await keyboardSequenceHandler({ steps: [{ keys: "ctrl+n" }], windowTitle: "QV221", trackFocus: false, settleMs: 0 } as never));
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("does not refuse foreground_flash when the channel is wm_char, which does not take the foreground", async () => {
    flashChannel.kind = "wm_char";
    try {
      mockEnum.mockReturnValue([offDesktop(100n), onScreen(200n)]);
      const r = parseResult(await keyboardTypeHandler({ text: "x", windowTitle: "QV221", method: "foreground_flash", trackFocus: false, settleMs: 0 } as never));
      expect(r.code).not.toBe("WindowOnOtherDesktop");
    } finally {
      flashChannel.kind = "clipboard_flash";
    }
  });
});
