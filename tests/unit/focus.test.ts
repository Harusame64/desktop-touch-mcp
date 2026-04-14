/**
 * focus.test.ts — Unit tests for detectFocusLoss
 *
 * Win32 calls are intercepted via module mocking so these run without a display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock win32 bindings ────────────────────────────────────────────────────────
// Factory must not reference top-level variables (hoisting constraint).
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(),
  getWindowProcessId: vi.fn(),
  getProcessIdentityByPid: vi.fn(),
}));

import { detectFocusLoss } from "../../src/tools/_focus.js";
import * as win32 from "../../src/engine/win32.js";

const mockEnumWindowsInZOrder = vi.mocked(win32.enumWindowsInZOrder);
const mockGetWindowProcessId = vi.mocked(win32.getWindowProcessId);
const mockGetProcessIdentityByPid = vi.mocked(win32.getProcessIdentityByPid);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeWindow(title: string, isActive: boolean, hwnd = 1n) {
  return {
    hwnd,
    title,
    isActive,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWindowProcessId.mockReturnValue(1234);
  mockGetProcessIdentityByPid.mockReturnValue({
    pid: 1234,
    processName: "thief",
    processStartTimeMs: 0,
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("detectFocusLoss", () => {
  it("returns null when no target and no homingNotes (no-op path)", async () => {
    const result = await detectFocusLoss({ settleMs: 0 });
    expect(result).toBeNull();
  });

  it("returns null when target window is still focused", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Google Chrome", true),
    ]);
    const result = await detectFocusLoss({
      target: "Google Chrome",
      settleMs: 0,
    });
    expect(result).toBeNull();
  });

  it("returns FocusLost when a different window is in the foreground", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Claude Code", true, 2n),
    ]);
    const result = await detectFocusLoss({
      target: "Google Chrome",
      settleMs: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.expected).toBe("Google Chrome");
    expect(result!.stolenBy).toBe("Claude Code");
    expect(result!.stolenByProcessName).toBe("thief");
    expect(result!.afterMs).toBeGreaterThanOrEqual(0);
  });

  it("returns null when no foreground window found", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Google Chrome", false),
    ]);
    const result = await detectFocusLoss({
      target: "Google Chrome",
      settleMs: 0,
    });
    expect(result).toBeNull();
  });

  it("extracts target from brought-to-front homing note when target is unset", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Claude Code", true, 2n),
    ]);
    const result = await detectFocusLoss({
      homingNotes: ['brought "Notepad" to front'],
      settleMs: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.expected).toBe("Notepad");
  });

  it("returns null when homing note target matches fg window", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Notepad - test.txt", true),
    ]);
    const result = await detectFocusLoss({
      homingNotes: ['brought "Notepad" to front'],
      settleMs: 0,
    });
    expect(result).toBeNull();
  });

  it("uses case-insensitive substring match for target", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Chrome - AWS Console", true),
    ]);
    const result = await detectFocusLoss({
      target: "chrome",
      settleMs: 0,
    });
    expect(result).toBeNull();
  });

  it("includes afterMs that reflects settleMs wait", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      fakeWindow("Thief Window", true, 2n),
    ]);
    const before = Date.now();
    const result = await detectFocusLoss({
      target: "Target App",
      settleMs: 50,
    });
    const after = Date.now();
    expect(result).not.toBeNull();
    // afterMs should reflect the settle wait (at least 40ms to account for timer resolution)
    expect(result!.afterMs).toBeGreaterThanOrEqual(40);
    expect(result!.afterMs).toBeLessThanOrEqual(after - before + 50);
  });
});
