/**
 * internal #221 — a title names the windows on the screen, not a same-titled window on another
 * virtual desktop.
 *
 * win2 (2026-09-30): with a cloaked "QV221" first in Z-order and a visible one behind it,
 * `keyboard(windowTitle:"QV221")` picked the cloaked one, switched the user to its desktop, and
 * typed nothing. The title search now leaves cloaked windows out, and when the title is worn only
 * by them the resolver refuses and says why, rather than switching or saying "not found".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const enumWindowsInZOrderMock = vi.fn();
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: enumWindowsInZOrderMock,
    isExcludedTitle: vi.fn(() => false),
    getWindowClassName: vi.fn(() => "WindowsForms10.Window"),
  };
});

const { findPlainTopLevelWindowByTitle, resolveWindowTarget } = await import("../../src/tools/_resolve-window.js");
const { windowsTitled, titleIsOnlyOffScreen } = await import("../../src/engine/title-match.js");

const win = (hwnd: bigint, title: string, isCloaked: boolean, extra: Record<string, unknown> = {}) => ({
  hwnd, title, isCloaked, className: "WindowsForms10.Window", ownerHwnd: null, isMinimized: false,
  isActive: false, zOrder: 0, isMaximized: false, region: { x: 0, y: 0, width: 400, height: 300 }, ...extra,
});

const H = win(0x1n, "QV221", true);    // another virtual desktop, first in Z-order (win2)
const V = win(0x2n, "QV221", false);   // on the screen

beforeEach(() => enumWindowsInZOrderMock.mockReset());

describe("internal #221 — which window a title names", () => {
  it("picks the window on the screen when a cloaked one comes first in Z-order", () => {
    enumWindowsInZOrderMock.mockReturnValue([H, V]);
    expect(findPlainTopLevelWindowByTitle("qv221")?.hwnd).toBe(0x2n);
  });

  it("picks the first one when neither is cloaked (control)", () => {
    enumWindowsInZOrderMock.mockReturnValue([{ ...H, isCloaked: false }, V]);
    expect(findPlainTopLevelWindowByTitle("qv221")?.hwnd).toBe(0x1n);
  });

  it("keeps a window whose cloak could not be read, as the enumeration does", () => {
    const { isCloaked: _drop, ...unread } = H;
    expect(windowsTitled([unread, V], "QV221").map((w) => w.hwnd)).toEqual([0x1n, 0x2n]);
  });

  it("titleIsOnlyOffScreen is true only when every window wearing the title is cloaked", () => {
    expect(titleIsOnlyOffScreen([H], "QV221")).toBe(true);
    expect(titleIsOnlyOffScreen([H, V], "QV221")).toBe(false);
    expect(titleIsOnlyOffScreen([], "QV221")).toBe(false);
    expect(titleIsOnlyOffScreen([win(0x3n, "Other", true)], "QV221")).toBe(false);
  });
});

describe("internal #221 — resolveWindowTarget with a plain title", () => {
  it("refuses, and says why, when the title is worn only on another virtual desktop", async () => {
    enumWindowsInZOrderMock.mockReturnValue([H]);
    await expect(resolveWindowTarget({ windowTitle: "QV221" })).rejects.toThrow(
      /^WindowNotFound: no window titled "QV221" is on the screen — the ones with that title are on another virtual desktop/,
    );
  });

  it("does not hand back a cloaked dialog through the owner-chain rescue", async () => {
    enumWindowsInZOrderMock.mockReturnValue([win(0x4n, "QV221", true, { className: "#32770" })]);
    await expect(resolveWindowTarget({ windowTitle: "QV221" })).rejects.toThrow(/another virtual desktop/);
  });

  it("passes through (null) when one window on the screen wears it", async () => {
    enumWindowsInZOrderMock.mockReturnValue([H, V]);
    await expect(resolveWindowTarget({ windowTitle: "QV221" })).resolves.toBeNull();
  });

  it("passes through (null) when no window wears it at all — a plain miss, not this refusal", async () => {
    enumWindowsInZOrderMock.mockReturnValue([win(0x3n, "Other", true)]);
    await expect(resolveWindowTarget({ windowTitle: "QV221" })).resolves.toBeNull();
  });
});
