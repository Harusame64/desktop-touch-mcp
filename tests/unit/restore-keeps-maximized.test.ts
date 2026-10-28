/**
 * Internal #307 — restoreAndFocusWindow must not turn a maximized window to its normal size.
 *
 * SW_RESTORE on a maximized window un-maximizes it (win2, 2026-10-24: a maximized Chrome after
 * focus_window came back at 100,100,1000×700). It is sent only to a minimized window, or when the
 * caller asks for `unmaximize` (window_dock, which resizes next).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SW_SHOW = 5;
const SW_RESTORE = 9;
const native = vi.hoisted(() => ({
  win32IsIconic: vi.fn<(hwnd: bigint) => boolean>(),
  win32IsWindowVisible: vi.fn<(hwnd: bigint) => boolean>(),
  win32ShowWindow: vi.fn<(hwnd: bigint, cmd: number) => boolean>(() => true),
  win32SetForegroundWindow: vi.fn<(hwnd: bigint) => boolean>(() => true),
  win32ForceSetForegroundWindow: vi.fn(() => ({ ok: true, attached: true, fgBefore: 1n, fgAfter: 42n })),
  win32GetWindowRect: vi.fn(() => ({ left: 0, top: 0, right: 1920, bottom: 1040 })),
}));

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: native,
  nativeL1: null,
  nativeUia: null,
}));

const { restoreAndFocusWindow } = await import("../../src/engine/win32.js");

describe("internal #307: restoreAndFocusWindow restores only a minimized window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.win32IsWindowVisible.mockReturnValue(true);
  });

  it("does not send SW_RESTORE to a window that is not minimized (a maximized one stays maximized)", () => {
    native.win32IsIconic.mockReturnValue(false);
    restoreAndFocusWindow(42n);
    expect(native.win32ShowWindow).not.toHaveBeenCalled();
    expect(native.win32SetForegroundWindow).toHaveBeenCalledWith(42n);
  });

  it("does not send SW_RESTORE on the force path either", () => {
    native.win32IsIconic.mockReturnValue(false);
    restoreAndFocusWindow(42n, { force: true });
    expect(native.win32ShowWindow).not.toHaveBeenCalled();
    expect(native.win32ForceSetForegroundWindow).toHaveBeenCalledWith(42n);
  });

  it("sends SW_RESTORE to a minimized window before bringing it forward", () => {
    native.win32IsIconic.mockReturnValue(true);
    restoreAndFocusWindow(42n);
    expect(native.win32ShowWindow).toHaveBeenCalledWith(42n, SW_RESTORE);
    expect(native.win32ShowWindow.mock.invocationCallOrder[0])
      .toBeLessThan(native.win32SetForegroundWindow.mock.invocationCallOrder[0]);
  });

  it("shows a hidden window that is not minimized with SW_SHOW, which keeps its size", () => {
    native.win32IsIconic.mockReturnValue(false);
    native.win32IsWindowVisible.mockReturnValue(false);
    restoreAndFocusWindow(42n);
    expect(native.win32ShowWindow).toHaveBeenCalledWith(42n, SW_SHOW);
    expect(native.win32ShowWindow).not.toHaveBeenCalledWith(42n, SW_RESTORE);
  });

  it("without the IsIconic binding, restores as before rather than leave a minimized window minimized", () => {
    const isIconic = native.win32IsIconic;
    delete (native as { win32IsIconic?: unknown }).win32IsIconic;
    try {
      restoreAndFocusWindow(42n);
      expect(native.win32ShowWindow).toHaveBeenCalledWith(42n, SW_RESTORE);
    } finally {
      native.win32IsIconic = isIconic;
    }
  });

  it("with unmaximize, sends SW_RESTORE to a window that is not minimized (window_dock resizes it next)", () => {
    native.win32IsIconic.mockReturnValue(false);
    restoreAndFocusWindow(42n, { unmaximize: true });
    expect(native.win32ShowWindow).toHaveBeenCalledWith(42n, SW_RESTORE);
  });
});

describe("internal #307: window_dock still un-maximizes before it resizes", () => {
  it("passes unmaximize to restoreAndFocusWindow", () => {
    const dock = readFileSync(resolve(__dirname, "../../src/tools/dock.ts"), "utf8");
    expect(dock).toMatch(
      /if \(win\.isMinimized \|\| win\.isMaximized\) \{\s*restoreAndFocusWindow\(win\.hwnd, \{ unmaximize: true \}\);/,
    );
  });
});
