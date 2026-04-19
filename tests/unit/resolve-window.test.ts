/**
 * tests/unit/resolve-window.test.ts
 *
 * Unit tests for resolveWindowTarget (src/tools/_resolve-window.ts).
 *
 * Cases:
 *   hwnd path (5 cases)
 *   @active path (3 cases)
 *   plain windowTitle / no-op path (2 cases)
 *   dock-window warning (2 cases)
 *   returned shape invariants (2 cases)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const { mockGetForegroundHwnd, mockGetWindowTitleW, mockGetWindowRectByHwnd } = vi.hoisted(() => ({
  mockGetForegroundHwnd: vi.fn<() => bigint | null>(),
  mockGetWindowTitleW: vi.fn<(hwnd: unknown) => string>(),
  mockGetWindowRectByHwnd: vi.fn<(hwnd: unknown) => { x: number; y: number; width: number; height: number } | null>(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  getForegroundHwnd: mockGetForegroundHwnd,
  getWindowTitleW: mockGetWindowTitleW,
  getWindowRectByHwnd: mockGetWindowRectByHwnd,
}));

import { resolveWindowTarget } from "../../src/tools/_resolve-window.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDefaultWin32() {
  mockGetWindowTitleW.mockReturnValue("Untitled - Notepad");
  mockGetWindowRectByHwnd.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
  mockGetForegroundHwnd.mockReturnValue(1234n);
}

beforeEach(() => {
  mockGetForegroundHwnd.mockReset();
  mockGetWindowTitleW.mockReset();
  mockGetWindowRectByHwnd.mockReset();
  delete process.env.DESKTOP_TOUCH_DOCK_TITLE;
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_DOCK_TITLE;
});

// ─── hwnd path ────────────────────────────────────────────────────────────────

describe("resolveWindowTarget — hwnd path", () => {
  it("resolves a valid hwnd to title and BigInt hwnd", async () => {
    mockGetWindowTitleW.mockReturnValue("Untitled - Notepad");
    const result = await resolveWindowTarget({ hwnd: "1000" });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Untitled - Notepad");
    expect(result!.hwnd).toBe(1000n);
  });

  it("returns empty title when getWindowTitleW returns empty but rect exists", async () => {
    mockGetWindowTitleW.mockReturnValue("");
    mockGetWindowRectByHwnd.mockReturnValue({ x: 0, y: 0, width: 100, height: 100 });
    const result = await resolveWindowTarget({ hwnd: "2000" });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("");
    expect(result!.hwnd).toBe(2000n);
  });

  it("throws WindowNotFound when hwnd string is not a valid integer", async () => {
    await expect(resolveWindowTarget({ hwnd: "not-a-number" })).rejects.toThrow(
      /WindowNotFound.*not a valid integer/
    );
  });

  it("throws WindowNotFound when no visible window with given hwnd (empty title + null rect)", async () => {
    mockGetWindowTitleW.mockReturnValue("");
    mockGetWindowRectByHwnd.mockReturnValue(null);
    await expect(resolveWindowTarget({ hwnd: "9999" })).rejects.toThrow(
      /WindowNotFound.*9999/
    );
  });

  it("returns empty warnings array when no dock title is set", async () => {
    mockGetWindowTitleW.mockReturnValue("Calculator");
    const result = await resolveWindowTarget({ hwnd: "3000" });
    expect(result!.warnings).toEqual([]);
  });
});

// ─── @active path ─────────────────────────────────────────────────────────────

describe("resolveWindowTarget — @active path", () => {
  it("resolves @active to foreground window hwnd and title", async () => {
    mockGetForegroundHwnd.mockReturnValue(5000n);
    mockGetWindowTitleW.mockReturnValue("Google Chrome");
    const result = await resolveWindowTarget({ windowTitle: "@active" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(5000n);
    expect(result!.title).toBe("Google Chrome");
  });

  it("throws WindowNotFound when getForegroundHwnd returns null", async () => {
    mockGetForegroundHwnd.mockReturnValue(null);
    await expect(resolveWindowTarget({ windowTitle: "@active" })).rejects.toThrow(
      /WindowNotFound.*@active/
    );
  });

  it("returns empty warnings when @active does not match dock title", async () => {
    mockGetForegroundHwnd.mockReturnValue(6000n);
    mockGetWindowTitleW.mockReturnValue("Notepad");
    process.env.DESKTOP_TOUCH_DOCK_TITLE = "Claude";
    const result = await resolveWindowTarget({ windowTitle: "@active" });
    expect(result!.warnings).toEqual([]);
  });
});

// ─── plain windowTitle / no-op ───────────────────────────────────────────────

describe("resolveWindowTarget — no-op path", () => {
  it("returns null for plain windowTitle", async () => {
    const result = await resolveWindowTarget({ windowTitle: "Notepad" });
    expect(result).toBeNull();
  });

  it("returns null when no params provided", async () => {
    const result = await resolveWindowTarget({});
    expect(result).toBeNull();
  });
});

// ─── dock-window warnings ────────────────────────────────────────────────────

describe("resolveWindowTarget — dock-window warnings", () => {
  it("emits HwndMatchesDockWindow warning when hwnd matches dock title", async () => {
    process.env.DESKTOP_TOUCH_DOCK_TITLE = "Claude";
    mockGetWindowTitleW.mockReturnValue("Claude CLI");
    const result = await resolveWindowTarget({ hwnd: "7000" });
    expect(result!.warnings.some(w => w.includes("HwndMatchesDockWindow"))).toBe(true);
  });

  it("emits dock warning when @active resolves to dock window", async () => {
    process.env.DESKTOP_TOUCH_DOCK_TITLE = "Claude";
    mockGetForegroundHwnd.mockReturnValue(8000n);
    mockGetWindowTitleW.mockReturnValue("Claude CLI");
    const result = await resolveWindowTarget({ windowTitle: "@active" });
    expect(result!.warnings.some(w => w.toLowerCase().includes("cli host"))).toBe(true);
  });
});

// ─── return shape invariants ──────────────────────────────────────────────────

describe("resolveWindowTarget — return shape", () => {
  it("always returns a warnings array (not undefined)", async () => {
    mockGetWindowTitleW.mockReturnValue("Paint");
    const result = await resolveWindowTarget({ hwnd: "1111" });
    expect(Array.isArray(result!.warnings)).toBe(true);
  });

  it("hwnd on resolved value is BigInt (not string or number)", async () => {
    mockGetWindowTitleW.mockReturnValue("Calc");
    const result = await resolveWindowTarget({ hwnd: "9876" });
    expect(typeof result!.hwnd).toBe("bigint");
  });
});
