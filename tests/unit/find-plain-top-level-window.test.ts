/**
 * find-plain-top-level-window.test.ts — ADR-018 Phase 5 §3 G5#2
 *
 * Pins the per-call-site flag preservation of the shared
 * `findPlainTopLevelWindowByTitle` helper extracted from 3 drifted
 * copies of the same predicate (Phase 1b §2.2 / Phase 4 §2.2 carry-over):
 *
 * | Call site | excludeMinimized | excludeDialogsAndOwned |
 * |---|---|---|
 * | `_resolve-window.ts` Case 3 | false (legacy tolerant) | true |
 * | `_input-pipeline.ts` Case 3 recovery | true (Codex PR #288 Round 4 P1) | true (Codex Round 3 P2) |
 * | `mouse.ts` observation ladder | true | false (observation tolerates dialogs) |
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const enumWindowsInZOrderMock = vi.fn();
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: enumWindowsInZOrderMock,
  // The helper module also re-exports several win32 utilities used by
  // `_resolve-window.ts`'s other code paths; stub them so the import does
  // not break when vitest resolves the module graph.
  getForegroundHwnd: vi.fn(),
  getWindowTitleW: vi.fn(),
  getWindowRectByHwnd: vi.fn(),
  getWindowOwner: vi.fn(),
  getWindowClassName: vi.fn(),
  isWindowEnabled: vi.fn(),
  getLastActivePopup: vi.fn(),
}));

const { findPlainTopLevelWindowByTitle } = await import(
  "../../src/tools/_resolve-window.js"
);

describe("findPlainTopLevelWindowByTitle — Phase 5 shared helper", () => {
  beforeEach(() => {
    enumWindowsInZOrderMock.mockReset();
  });

  it("empty title → null (no enumeration attempted)", () => {
    const result = findPlainTopLevelWindowByTitle("");
    expect(result).toBeNull();
    expect(enumWindowsInZOrderMock).not.toHaveBeenCalled();
  });

  it("case-insensitive substring match (default flags both false) → first match", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x1n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const result = findPlainTopLevelWindowByTitle("notepad");
    expect(result?.hwnd).toBe(0x1n);
  });

  it("excludeMinimized: false (default) — minimized windows STILL match (legacy _resolve-window.ts Case 3 tolerance)", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x1n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: true },
    ]);
    const result = findPlainTopLevelWindowByTitle("Notepad");
    expect(result?.hwnd).toBe(0x1n);
  });

  it("excludeMinimized: true — minimized windows are skipped (Codex PR #288 Round 4 P1 — _input-pipeline.ts / mouse.ts observation ladder)", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x1n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: true },
      { hwnd: 0x2n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const result = findPlainTopLevelWindowByTitle("Notepad", { excludeMinimized: true });
    expect(result?.hwnd).toBe(0x2n);
  });

  it("excludeDialogsAndOwned: true — #32770 dialogs AND owned windows are skipped (Codex PR #288 Round 3 P2 — _resolve-window.ts Case 3 / _input-pipeline.ts)", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x501n, title: "Notepad — Save As", className: "#32770", ownerHwnd: 0x999n, isMinimized: false },
      { hwnd: 0x502n, title: "Notepad popup", className: "Tooltip", ownerHwnd: 0x999n, isMinimized: false },
      { hwnd: 0x503n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const result = findPlainTopLevelWindowByTitle("Notepad", { excludeDialogsAndOwned: true });
    expect(result?.hwnd).toBe(0x503n);
  });

  it("excludeDialogsAndOwned: false (observation ladder) — dialog matches are tolerated", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x501n, title: "Notepad — Save As", className: "#32770", ownerHwnd: 0x999n, isMinimized: false },
    ]);
    const result = findPlainTopLevelWindowByTitle("Notepad", { excludeDialogsAndOwned: false });
    expect(result?.hwnd).toBe(0x501n);
  });

  it("both flags true (_input-pipeline.ts Case 3 recovery exact predicate) — recovers the true top-level only", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x701n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: true },
      { hwnd: 0x702n, title: "Notepad — Save As", className: "#32770", ownerHwnd: 0x999n, isMinimized: false },
      { hwnd: 0x703n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const result = findPlainTopLevelWindowByTitle("Notepad", {
      excludeMinimized: true,
      excludeDialogsAndOwned: true,
    });
    expect(result?.hwnd).toBe(0x703n);
  });

  it("enumWindowsInZOrder throws → null (graceful fall-through)", () => {
    enumWindowsInZOrderMock.mockImplementation(() => {
      throw new Error("enumeration unavailable");
    });
    const result = findPlainTopLevelWindowByTitle("Notepad", { excludeMinimized: true });
    expect(result).toBeNull();
  });

  it("no match → null (callers fall through to their own unresolved path)", () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x1n, title: "Calculator", className: "Calc", ownerHwnd: null, isMinimized: false },
    ]);
    const result = findPlainTopLevelWindowByTitle("Notepad");
    expect(result).toBeNull();
  });
});
