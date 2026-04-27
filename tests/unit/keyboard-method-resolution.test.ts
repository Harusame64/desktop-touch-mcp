/**
 * tests/unit/keyboard-method-resolution.test.ts
 *
 * Unit tests for resolveEffectiveInputMethod (Focus Leash Phase A).
 *
 * Verifies that:
 *  - Explicit `background` / `foreground` values are passed through unchanged.
 *  - `auto` + DTM_BG_AUTO=1 → `background-auto` (existing global toggle).
 *  - `auto` + target window class in TERMINAL_WINDOW_CLASSES → `background-auto`
 *    (Phase A: HWND-targeted WM_CHAR delivery for terminals).
 *  - `auto` + non-terminal class / no window / window not found → `auto`
 *    (so downstream BG entry condition fails and execution falls through to the
 *    foreground path unchanged).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock win32 — control enumWindowsInZOrder + getWindowClassName per test.
// Other win32 exports (used elsewhere in keyboard.ts and indirectly via bg-input)
// are preserved via importActual.
vi.mock("../../src/engine/win32.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/engine/win32.js")>(
      "../../src/engine/win32.js",
    );
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn().mockReturnValue([]),
    getWindowClassName: vi.fn().mockReturnValue(""),
  };
});

// Mock bg-input.isBgAutoEnabled. TERMINAL_WINDOW_CLASSES (a Set) is preserved
// via importActual, so the helper compares against the real allowlist.
vi.mock("../../src/engine/bg-input.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/engine/bg-input.js")>(
      "../../src/engine/bg-input.js",
    );
  return {
    ...actual,
    isBgAutoEnabled: vi.fn().mockReturnValue(false),
  };
});

import { resolveEffectiveInputMethod } from "../../src/tools/keyboard.js";
import {
  enumWindowsInZOrder,
  getWindowClassName,
  type WindowZInfo,
} from "../../src/engine/win32.js";
import { isBgAutoEnabled } from "../../src/engine/bg-input.js";

function fakeWindow(title: string, hwnd: bigint = 0x100n): WindowZInfo {
  return {
    hwnd,
    title,
    region: { x: 0, y: 0, width: 800, height: 600 },
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    isActive: true,
  };
}

describe("resolveEffectiveInputMethod (Focus Leash Phase A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isBgAutoEnabled).mockReturnValue(false);
    vi.mocked(enumWindowsInZOrder).mockReturnValue([]);
    vi.mocked(getWindowClassName).mockReturnValue("");
  });

  describe("explicit method values (no auto-pick)", () => {
    it("returns 'background' as-is regardless of state", () => {
      expect(resolveEffectiveInputMethod("background", undefined)).toBe(
        "background",
      );
      expect(resolveEffectiveInputMethod("background", "Notepad")).toBe(
        "background",
      );
      vi.mocked(isBgAutoEnabled).mockReturnValue(true);
      expect(resolveEffectiveInputMethod("background", "Notepad")).toBe(
        "background",
      );
    });

    it("returns 'foreground' as-is regardless of state", () => {
      expect(resolveEffectiveInputMethod("foreground", undefined)).toBe(
        "foreground",
      );
      vi.mocked(isBgAutoEnabled).mockReturnValue(true);
      vi.mocked(enumWindowsInZOrder).mockReturnValue([
        fakeWindow("Windows Terminal"),
      ]);
      vi.mocked(getWindowClassName).mockReturnValue(
        "CASCADIA_HOSTING_WINDOW_CLASS",
      );
      expect(resolveEffectiveInputMethod("foreground", "Windows Terminal")).toBe(
        "foreground",
      );
    });
  });

  describe("auto + DTM_BG_AUTO precedence", () => {
    it("DTM_BG_AUTO=1 wins (returns 'background-auto') without consulting class", () => {
      vi.mocked(isBgAutoEnabled).mockReturnValue(true);
      const result = resolveEffectiveInputMethod("auto", "Notepad");
      expect(result).toBe("background-auto");
      expect(enumWindowsInZOrder).not.toHaveBeenCalled();
      expect(getWindowClassName).not.toHaveBeenCalled();
    });

    it("DTM_BG_AUTO=1 + no windowTitle still returns 'background-auto'", () => {
      vi.mocked(isBgAutoEnabled).mockReturnValue(true);
      expect(resolveEffectiveInputMethod("auto", undefined)).toBe(
        "background-auto",
      );
    });
  });

  describe("auto + class-aware auto-pick (Phase A)", () => {
    it("Windows Terminal (CASCADIA_HOSTING_WINDOW_CLASS) → 'background-auto'", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([
        fakeWindow("PowerShell - Windows Terminal"),
      ]);
      vi.mocked(getWindowClassName).mockReturnValue(
        "CASCADIA_HOSTING_WINDOW_CLASS",
      );
      expect(resolveEffectiveInputMethod("auto", "PowerShell")).toBe(
        "background-auto",
      );
    });

    it("conhost / cmd / pwsh (ConsoleWindowClass) → 'background-auto'", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([
        fakeWindow("Command Prompt"),
      ]);
      vi.mocked(getWindowClassName).mockReturnValue("ConsoleWindowClass");
      expect(resolveEffectiveInputMethod("auto", "Command")).toBe(
        "background-auto",
      );
    });

    it("non-terminal class (Notepad) → 'auto' (foreground fallthrough)", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([fakeWindow("Notepad")]);
      vi.mocked(getWindowClassName).mockReturnValue("Notepad");
      expect(resolveEffectiveInputMethod("auto", "Notepad")).toBe("auto");
    });

    it("windowTitle case-insensitive match still works", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([
        fakeWindow("Windows PowerShell - 7.3"),
      ]);
      vi.mocked(getWindowClassName).mockReturnValue(
        "CASCADIA_HOSTING_WINDOW_CLASS",
      );
      expect(resolveEffectiveInputMethod("auto", "powershell")).toBe(
        "background-auto",
      );
    });

    it("Mintty (not in allowlist) → 'auto' — Phase A scope keeps allowlist tight", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([fakeWindow("MINGW64")]);
      vi.mocked(getWindowClassName).mockReturnValue("mintty");
      expect(resolveEffectiveInputMethod("auto", "MINGW64")).toBe("auto");
    });
  });

  describe("auto + degraded inputs", () => {
    it("missing windowTitle → 'auto', no enumeration", () => {
      const result = resolveEffectiveInputMethod("auto", undefined);
      expect(result).toBe("auto");
      expect(enumWindowsInZOrder).not.toHaveBeenCalled();
    });

    it("empty windowTitle string → 'auto', no enumeration", () => {
      // Empty string is falsy, helper short-circuits the lookup.
      const result = resolveEffectiveInputMethod("auto", "");
      expect(result).toBe("auto");
      expect(enumWindowsInZOrder).not.toHaveBeenCalled();
    });

    it("window not found → 'auto'", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([
        fakeWindow("Some Other Window"),
      ]);
      expect(resolveEffectiveInputMethod("auto", "PowerShell")).toBe("auto");
    });

    it("getWindowClassName returns empty string → 'auto'", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([
        fakeWindow("Mystery Window"),
      ]);
      vi.mocked(getWindowClassName).mockReturnValue("");
      expect(resolveEffectiveInputMethod("auto", "Mystery")).toBe("auto");
    });

    it("getWindowClassName throws → 'auto' (no crash)", () => {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([fakeWindow("Bad")]);
      vi.mocked(getWindowClassName).mockImplementation(() => {
        throw new Error("boom");
      });
      expect(resolveEffectiveInputMethod("auto", "Bad")).toBe("auto");
    });

    it("enumWindowsInZOrder throws → 'auto' (no crash)", () => {
      vi.mocked(enumWindowsInZOrder).mockImplementation(() => {
        throw new Error("enum failed");
      });
      expect(resolveEffectiveInputMethod("auto", "PowerShell")).toBe("auto");
    });
  });
});
