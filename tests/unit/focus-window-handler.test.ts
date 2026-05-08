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
