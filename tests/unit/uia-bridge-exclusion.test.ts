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

// uia-bridge imports isExcludedTitle, and the handle gate's two predicates, from win32.
vi.mock("../../src/engine/win32.js", () => ({
  isExcludedTitle: mockIsExcludedTitle,
  isExcludedWindowHandle: () => false,
  isWindowGone: () => false,
}));

import { getUiElements, clickElement, getTextViaTextPattern, getElementBounds, setElementValue } from "../../src/engine/uia-bridge.js";
import { WindowExcludedError, registerExcludedPid, _resetExcludedPidsForTest } from "../../src/engine/tool-exclusion.js";

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

describe("uia-bridge — an empty title with no handle while the locker is armed (internal #115 row 4)", () => {
  // "" is inside every title, so the native root search matches whatever UIA enumerates first — and
  // `isExcludedTitle("")` answers false by design ("" names nothing). While armed, the first window
  // can be the locker, and without a handle the handle gate never runs.
  beforeEach(() => { _resetExcludedPidsForTest(); mockIsExcludedTitle.mockReturnValue(false); });
  const settle = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("refuses the write before any UIA call", async () => {
    registerExcludedPid(2222);
    const err = await settle(setElementValue("", "text", "Field"));
    expect(err).toBeInstanceOf(WindowExcludedError);
    expect(String((err as Error).message)).toMatch(/empty title/);
  });

  it("refuses the read and the click too", async () => {
    registerExcludedPid(2222);
    expect(await settle(getUiElements(""))).toBeInstanceOf(WindowExcludedError);
    expect(await settle(clickElement("", "OK"))).toBeInstanceOf(WindowExcludedError);
  });

  it("leaves a call that carries a handle to the handle gate", async () => {
    registerExcludedPid(2222);
    const err = await settle(setElementValue("", "text", "Field", undefined, { hwnd: 4242n }));
    expect(err).not.toBeInstanceOf(WindowExcludedError);
  });

  it("does nothing while no locker is armed", async () => {
    const err = await settle(setElementValue("", "text", "Field"));
    expect(err).not.toBeInstanceOf(WindowExcludedError);
  });
});
