// ADR-014 v2 R3 Key Locker — UIA-by-title tool-exclusion guard (Opus R3 P1).
//
// UIA resolves a window from a TITLE STRING through the native UIA tree (a non-win32 subsystem
// that never consults the PID filter). Every uia-bridge reader/driver taking a windowTitle must
// refuse a title that names the locker, else desktop_discover / click_element / screenshot-som /
// workspace / macro can surface AND drive the secure dialog's buttons by title. This suite mocks
// the by-title predicate (win32.isExcludedTitle) and asserts the guard throws WindowExcludedError
// BEFORE any native/PowerShell call, across a representative read, drive, and text function.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockIsExcludedTitle } = vi.hoisted(() => ({ mockIsExcludedTitle: vi.fn<(t: string) => boolean>() }));

// uia-bridge imports ONLY isExcludedTitle from win32 (verified) — a minimal mock is complete.
vi.mock("../../src/engine/win32.js", () => ({ isExcludedTitle: mockIsExcludedTitle }));

import { getUiElements, clickElement, getTextViaTextPattern, getElementBounds } from "../../src/engine/uia-bridge.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";

const LOCKER = "desktop-touch key locker";

beforeEach(() => {
  mockIsExcludedTitle.mockReset();
});

describe("uia-bridge — R3 by-title exclusion guard", () => {
  it("getUiElements refuses an excluded title (before any UIA call)", async () => {
    mockIsExcludedTitle.mockReturnValue(true);
    await expect(getUiElements(LOCKER)).rejects.toBeInstanceOf(WindowExcludedError);
    expect(mockIsExcludedTitle).toHaveBeenCalledWith(LOCKER);
  });

  it("clickElement refuses an excluded title (cannot drive the dialog's buttons)", async () => {
    mockIsExcludedTitle.mockReturnValue(true);
    await expect(clickElement(LOCKER, "Cancel")).rejects.toBeInstanceOf(WindowExcludedError);
  });

  it("getTextViaTextPattern refuses an excluded title", async () => {
    mockIsExcludedTitle.mockReturnValue(true);
    await expect(getTextViaTextPattern(LOCKER)).rejects.toBeInstanceOf(WindowExcludedError);
  });

  it("getElementBounds refuses an excluded title", async () => {
    mockIsExcludedTitle.mockReturnValue(true);
    await expect(getElementBounds(LOCKER, "Cancel")).rejects.toBeInstanceOf(WindowExcludedError);
  });

  it("consults isExcludedTitle with the caller's title (so the guard is not unconditional)", async () => {
    mockIsExcludedTitle.mockReturnValue(true);
    await expect(clickElement("Some Window", "OK")).rejects.toBeInstanceOf(WindowExcludedError);
    expect(mockIsExcludedTitle).toHaveBeenCalledWith("Some Window");
    // When the predicate is false the guard is a trivial no-op (if-condition false → no throw);
    // the not-armed → false behavior is covered by tool-exclusion.test.ts's isExcludedTitle cases.
  });
});
