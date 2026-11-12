/**
 * focus-window-handler.test.ts — Unit tests for focusWindowHandler
 * auto-escalation contract (issue #197).
 *
 * Verifies:
 *   1. Window not found → existing WindowNotFound contract preserved
 *   2. Default SetForegroundWindow succeeds → ok:true, no escalation hint
 *   3. Default fails → AttachThreadInput escalation succeeds → ok:true with
 *      hints.forceFocusEscalated:true
 *   4. Both default and force-focus paths fail → ok:false ForegroundRestricted
 *      with context.attemptedForce / autoEscalated / actualForeground populated
 *   5. Caller passes forceFocus:true → first attempt uses force directly,
 *      no auto-escalation (already at strongest path)
 *
 * Win32 / cdp / cache modules are intercepted via vi.mock so this runs
 * without a display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(),
  restoreAndFocusWindow: vi.fn(),
  getWindowTitleW: vi.fn(),
  isExcludedWindowHandle: vi.fn(() => false),
  windowIsAlive: vi.fn(() => true),
  getForegroundHwnd: vi.fn(() => null),
}));

vi.mock("../../src/engine/window-cache.js", () => ({
  updateWindowCache: vi.fn(),
}));

vi.mock("../../src/engine/cdp-bridge.js", () => ({
  listTabs: vi.fn(),
  activateTab: vi.fn(),
  DEFAULT_CDP_PORT: 9222,
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getVirtualDesktopStatus: vi.fn(),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  getActiveWindow: vi.fn(),
}));

import { focusWindowHandler } from "../../src/tools/window.js";
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
  // Make sure no stray env override leaks into tests.
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
});

describe("focusWindowHandler — issue #197 auto-escalate", () => {
  it("returns ok:false with WindowNotFound when no title matches", async () => {
    mockEnum.mockReturnValue([fakeWindow("Other App", false, 50n)]);

    const r = parseResult(await focusWindowHandler({
      title: "PowerShell",
      cdpPort: 9222,
    }));

    expect(r.ok).toBe(false);
    // failWith stringifies the message; assert presence of the canonical phrase.
    const blob = JSON.stringify(r);
    expect(blob).toContain("Window not found");
    // restoreAndFocusWindow must NOT run when no candidate matched.
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("returns ok:true without escalation when default attempt succeeds", async () => {
    const target = fakeWindow("PowerShell", false, 100n);
    mockEnum
      .mockReturnValueOnce([target]) // initial enum (target not foreground yet)
      .mockReturnValueOnce([{ ...target, isActive: true }]); // post-100ms re-enum

    const r = parseResult(await focusWindowHandler({
      title: "PowerShell",
      cdpPort: 9222,
    }));

    expect(r.ok).toBe(true);
    expect(r.focused).toBe("PowerShell");
    // No escalation hint should appear when default attempt was sufficient.
    expect(r.hints?.forceFocusEscalated).toBeUndefined();
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: false });
  });

  it("auto-escalates to force=true when default attempt fails", async () => {
    const target = fakeWindow("PowerShell", false, 100n);
    const otherActive = fakeWindow("Other", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, otherActive]) // initial enum
      .mockReturnValueOnce([target, otherActive]) // post-default re-enum (still other)
      .mockReturnValueOnce([{ ...target, isActive: true }, { ...otherActive, isActive: false }]); // post-force re-enum

    const r = parseResult(await focusWindowHandler({
      title: "PowerShell",
      cdpPort: 9222,
    }));

    expect(r.ok).toBe(true);
    expect(r.focused).toBe("PowerShell");
    expect(r.hints?.forceFocusEscalated).toBe(true);
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenNthCalledWith(1, 100n, { force: false });
    expect(mockRestore).toHaveBeenNthCalledWith(2, 100n, { force: true });
  });

  it("returns ok:false ForegroundRestricted when both default and force fail", async () => {
    const target = fakeWindow("PowerShell", false, 100n);
    const otherActive = fakeWindow("Sticky Foreground", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, otherActive]) // initial
      .mockReturnValueOnce([target, otherActive]) // post-default
      .mockReturnValueOnce([target, otherActive]); // post-force (still sticky)

    const r = parseResult(await focusWindowHandler({
      title: "PowerShell",
      cdpPort: 9222,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(false);
    expect(r.context.autoEscalated).toBe(true);
    expect(r.context.actualForeground).toBe("Sticky Foreground");
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    expect(mockRestore).toHaveBeenCalledTimes(2);
  });

  it("respects caller forceFocus:true and skips auto-escalation if it fails", async () => {
    const target = fakeWindow("PowerShell", false, 100n);
    const otherActive = fakeWindow("Sticky", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, otherActive]) // initial
      .mockReturnValueOnce([target, otherActive]); // post-force re-enum (still sticky)

    const r = parseResult(await focusWindowHandler({
      title: "PowerShell",
      forceFocus: true,
      cdpPort: 9222,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(true);
    expect(r.context.autoEscalated).toBe(false);
    // Only the initial force=true attempt; no second escalation since caller
    // already requested the strongest path.
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: true });
  });
});

// internal llm22 drive F5/F8 (win2, 2026-10-04): a minimised packaged app has its frame (shown,
// minimised) and its content (hidden, frozen) under one title, the content listed above — even at
// z 0. focus_window aimed at the content and failed.
describe("focus_window takes a shown window before a hidden one with the same title", () => {
  it("brings forward the shown (minimised) frame, not the hidden content listed above it", async () => {
    const content = { ...fakeWindow("電卓", false, 4131504n), isCloaked: true, zOrder: 0 };
    const frame = { ...fakeWindow("電卓", false, 656956n), isMinimized: true, zOrder: 12 };
    mockEnum.mockReturnValueOnce([content, frame]).mockReturnValue([{ ...frame, isActive: true, isMinimized: false }]);
    await focusWindowHandler({ title: "電卓" } as Parameters<typeof focusWindowHandler>[0]);
    expect(mockRestore.mock.calls[0]?.[0]).toBe(656956n);
  });

  it("still brings forward a hidden window when it is the only one (another virtual desktop)", async () => {
    const other = { ...fakeWindow("Remote", false, 77n), isCloaked: true };
    mockEnum.mockReturnValueOnce([other]).mockReturnValue([{ ...other, isActive: true }]);
    await focusWindowHandler({ title: "Remote" } as Parameters<typeof focusWindowHandler>[0]);
    expect(mockRestore.mock.calls[0]?.[0]).toBe(77n);
  });
});

describe("focus_window by hwnd (internal #401)", () => {
  const mockFront = vi.mocked(win32.getForegroundHwnd);
  const mockAlive = vi.mocked(win32.windowIsAlive);
  const mockExcluded = vi.mocked(win32.isExcludedWindowHandle);
  const mockTitle = vi.mocked(win32.getWindowTitleW);
  beforeEach(() => {
    mockAlive.mockReturnValue(true);
    mockExcluded.mockReturnValue(false);
    mockTitle.mockReturnValue("Shop - Google Chrome");
  });
  it("brings forward the window the hwnd names, without looking it up by title", async () => {
    // Two windows show the same title; the hwnd names the second. No enumeration is needed.
    mockEnum.mockReturnValue([fakeWindow("Shop - Google Chrome", true, 100n), fakeWindow("Shop - Google Chrome", false, 200n)]);
    mockFront.mockReturnValue(200n);
    const r = parseResult(await focusWindowHandler({ hwnd: "200", cdpPort: 9222 }) as never);
    expect(r).toMatchObject({ ok: true, hwnd: "200", focused: "Shop - Google Chrome" });
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore.mock.calls[0]![0]).toBe(200n);
  });
  it("a window with no title, which the window list leaves out, is reached by its hwnd", async () => {
    mockEnum.mockReturnValue([]);
    mockTitle.mockReturnValue("");
    mockFront.mockReturnValue(300n);
    const r = parseResult(await focusWindowHandler({ hwnd: "300", cdpPort: 9222 }) as never);
    expect(r.ok).toBe(true);
    expect(mockRestore.mock.calls[0]![0]).toBe(300n);
  });
  it("hex and decimal name the same window (the shared handle rule)", async () => {
    mockFront.mockReturnValue(0x1a2bn);
    expect(parseResult(await focusWindowHandler({ hwnd: "0x1A2B", cdpPort: 9222 }) as never).ok).toBe(true);
    expect(mockRestore.mock.calls[0]![0]).toBe(0x1a2bn);
  });
  it("not a handle: InvalidArgs, and nothing is focused", async () => {
    const r = parseResult(await focusWindowHandler({ hwnd: "abc", cdpPort: 9222 }) as never);
    expect(r.code).toBe("InvalidArgs");
    expect(mockRestore).not.toHaveBeenCalled();
  });
  it("an hwnd that names no window: not found, with the hwnd's own advice, and nothing is focused", async () => {
    mockAlive.mockReturnValue(false);
    const r = parseResult(await focusWindowHandler({ hwnd: "999", cdpPort: 9222 }) as never);
    expect(r.code).toBe("WindowNotFound");
    expect(r.error).toMatch(/hwnd 999 names no window/);
    expect(r.suggest.join(" ")).toMatch(/desktop_discover/);
    // Not the title lines of the catalogue (win2, H2).
    expect(r.suggest.join(" ")).not.toMatch(/partial title/);
    expect(mockRestore).not.toHaveBeenCalled();
  });
  it("Windows cannot be asked whether it is a window: it is tried", async () => {
    mockAlive.mockReturnValue(undefined);
    mockFront.mockReturnValue(400n);
    expect(parseResult(await focusWindowHandler({ hwnd: "400", cdpPort: 9222 }) as never).ok).toBe(true);
  });
  it("the key locker's window is refused by hwnd as by title", async () => {
    mockExcluded.mockReturnValue(true);
    const r = parseResult(await focusWindowHandler({ hwnd: "500", cdpPort: 9222 }) as never);
    expect(r.code).toBe("WindowExcluded");
    expect(mockRestore).not.toHaveBeenCalled();
  });
  it("hwnd with chromeTabUrlContains is refused before any tab is switched", async () => {
    const cdp = await import("../../src/engine/cdp-bridge.js");
    const r = parseResult(await focusWindowHandler({ hwnd: "200", chromeTabUrlContains: "mail", cdpPort: 9222 }) as never);
    expect(r.code).toBe("InvalidArgs");
    expect(vi.mocked(cdp.activateTab)).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
  });
  it("not brought forward: ForegroundRestricted, after the escalation", async () => {
    mockFront.mockReturnValue(100n);
    const r = parseResult(await focusWindowHandler({ hwnd: "200", cdpPort: 9222 }) as never);
    expect(r.code).toBe("ForegroundRestricted");
    expect(mockRestore).toHaveBeenCalledTimes(2);
  });
  it("hwnd wins over title, and an empty hwnd is no hwnd", async () => {
    mockFront.mockReturnValue(200n);
    await focusWindowHandler({ title: "Alpha", hwnd: "200", cdpPort: 9222 });
    expect(mockRestore.mock.calls[0]![0]).toBe(200n);
    mockRestore.mockClear();
    const a = fakeWindow("Alpha", false, 100n);
    mockEnum.mockReturnValueOnce([a]).mockReturnValue([{ ...a, isActive: true }]);
    expect(parseResult(await focusWindowHandler({ title: "Alpha", hwnd: "", cdpPort: 9222 }) as never).ok).toBe(true);
    expect(mockRestore.mock.calls[0]![0]).toBe(100n);
  });
  it("neither title nor hwnd: InvalidArgs, and nothing is focused", async () => {
    const r = parseResult(await focusWindowHandler({ cdpPort: 9222 }) as never);
    expect(r.code).toBe("InvalidArgs");
    expect(r.error).toMatch(/title .* or hwnd/);
    expect(mockRestore).not.toHaveBeenCalled();
  });
  it("by title, as before", async () => {
    const a = fakeWindow("Alpha", false, 100n);
    mockEnum.mockReturnValueOnce([a]).mockReturnValue([{ ...a, isActive: true }]);
    const r = parseResult(await focusWindowHandler({ title: "alp", cdpPort: 9222 }) as never);
    expect(r.ok).toBe(true);
    expect(mockRestore.mock.calls[0]![0]).toBe(100n);
  });
});
