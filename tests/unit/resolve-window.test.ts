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

const {
  mockGetForegroundHwnd, mockGetWindowTitleW, mockGetWindowRectByHwnd,
  // H3 additions
  mockEnumWindowsInZOrder, mockGetWindowOwner, mockGetWindowClassName,
  mockIsWindowEnabled, mockGetLastActivePopup,
} = vi.hoisted(() => ({
  mockGetForegroundHwnd:    vi.fn<() => bigint | null>(),
  mockGetWindowTitleW:      vi.fn<(hwnd: unknown) => string>(),
  mockGetWindowRectByHwnd:  vi.fn<(hwnd: unknown) => { x: number; y: number; width: number; height: number } | null>(),
  mockEnumWindowsInZOrder:  vi.fn(),
  mockGetWindowOwner:       vi.fn<(hwnd: unknown) => bigint | null>(),
  mockGetWindowClassName:   vi.fn<(hwnd: unknown) => string>(),
  mockIsWindowEnabled:      vi.fn<(hwnd: unknown) => boolean>(),
  mockGetLastActivePopup:   vi.fn<(hwnd: unknown) => bigint | null>(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  getForegroundHwnd:    mockGetForegroundHwnd,
  getWindowTitleW:      mockGetWindowTitleW,
  getWindowRectByHwnd:  mockGetWindowRectByHwnd,
  enumWindowsInZOrder:  mockEnumWindowsInZOrder,
  getWindowOwner:       mockGetWindowOwner,
  getWindowClassName:   mockGetWindowClassName,
  isWindowEnabled:      mockIsWindowEnabled,
  getLastActivePopup:   mockGetLastActivePopup,
}));

import { resolveWindowTarget } from "../../src/tools/_resolve-window.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetForegroundHwnd.mockReset();
  mockGetWindowTitleW.mockReset();
  mockGetWindowRectByHwnd.mockReset();
  // H3 defaults: enabled windows, no popup, no dialog in enum
  mockEnumWindowsInZOrder.mockReturnValue([]);
  mockGetWindowOwner.mockReturnValue(null);
  mockGetWindowClassName.mockReturnValue("");
  mockIsWindowEnabled.mockReturnValue(true);
  mockGetLastActivePopup.mockReturnValue(null);
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

// ─── H3: common dialog resolution ───────────────────────────────────────────

describe("resolveWindowTarget — common dialog (H3 case 4)", () => {
  it("falls back to #32770 dialog when plain title has no top-level match", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 200n, title: "名前を付けて保存",    className: "#32770",  ownerHwnd: 100n, isMinimized: false },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(200n);
    expect(result!.warnings).toContain("dialog_resolved_via_owner_chain");
  });

  it("falls back to owned popup when plain title has no top-level match and no #32770", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 300n, title: "Open File",  className: "DirectUIHWND", ownerHwnd: 100n, isMinimized: false },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "Open File" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(300n);
    expect(result!.warnings).toContain("dialog_resolved_via_owner_chain");
  });

  it("returns null (defers to caller) when a plain top-level window matches", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 400n, title: "名前を付けて保存 - App", className: "AppClass", ownerHwnd: null, isMinimized: false },
    ]);
    // Plain top-level match exists → existing behaviour: return null
    const result = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    expect(result).toBeNull();
  });

  it("returns null when no match found (no top-level, no dialog)", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 500n, title: "Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "Does Not Exist" });
    expect(result).toBeNull();
  });
});

describe("resolveWindowTarget — disabled-owner popup prefer (H3 case 5)", () => {
  it("prefers active popup when owner is disabled and popup is owned by it", async () => {
    mockGetWindowTitleW.mockImplementation((h) =>
      h === 100n ? "Untitled - Notepad" : h === 200n ? "名前を付けて保存" : ""
    );
    mockIsWindowEnabled.mockImplementation((h) => h !== 100n);  // 100 = disabled
    mockGetLastActivePopup.mockReturnValue(200n);
    mockGetWindowOwner.mockReturnValue(100n);   // popup is owned by 100
    mockGetWindowClassName.mockReturnValue("SomeClass");

    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(200n);
    expect(result!.title).toBe("名前を付けて保存");
    expect(result!.warnings).toContain("parent_disabled_prefer_popup");
  });

  it("prefers active popup when popup is #32770 class (regardless of owner chain)", async () => {
    mockGetWindowTitleW.mockImplementation((h) =>
      h === 100n ? "Notepad" : h === 200n ? "Save" : ""
    );
    mockIsWindowEnabled.mockImplementation((h) => h !== 100n);
    mockGetLastActivePopup.mockReturnValue(200n);
    mockGetWindowOwner.mockReturnValue(null);   // no explicit owner
    mockGetWindowClassName.mockReturnValue("#32770");  // but it's a dialog class

    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(200n);
    expect(result!.warnings).toContain("parent_disabled_prefer_popup");
  });

  it("does NOT prefer popup when owner window is enabled", async () => {
    mockGetWindowTitleW.mockReturnValue("Notepad");
    mockIsWindowEnabled.mockReturnValue(true);  // owner is enabled → no modal
    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(100n);
    expect(result!.warnings).not.toContain("parent_disabled_prefer_popup");
  });

  it("does NOT prefer popup when popup is same hwnd as owner (GetLastActivePopup self)", async () => {
    mockGetWindowTitleW.mockReturnValue("Notepad");
    mockIsWindowEnabled.mockReturnValue(false);
    mockGetLastActivePopup.mockReturnValue(100n);  // returns self = no popup
    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(100n);
    expect(result!.warnings).not.toContain("parent_disabled_prefer_popup");
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
