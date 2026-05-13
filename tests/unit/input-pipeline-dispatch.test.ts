/**
 * ADR-018 Phase 1b — input pipeline dispatcher tests.
 *
 * Pins the Phase 1b contract:
 *   1. `resolveInputDestination` returns `{kind:'hwnd'}` when resolveWindowTarget
 *      resolves the window, and `{kind:'unresolved'}` when every fallback fails.
 *   2. `dispatchScrollWheel({kind:'hwnd'}, ...)` returns
 *      `{scrolled:true, channel:'uia', reason:'delivered_via_uia'}` when the
 *      native `uiaScrollByWheelAtHwnd` returns `ok:true, scrolled:true`.
 *   3. `dispatchScrollWheel` returns `null` when the native call returns
 *      `ok:false` or `scrolled:false`, or when the native binding is missing
 *      (so the caller falls through to Tier 4 SendInput).
 *   4. `assertTier4Reachable` throws for `'uia'` and `'cdp'`, accepts `'hwnd'`
 *      (Phase 1b lenient form) and `'unresolved'`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the native loader before importing the SUT so the dispatcher's
// `await import('../../index.js')` resolves to our stub.
const uiaScrollByWheelAtHwndMock = vi.fn();
vi.mock("../../index.js", () => ({
  uiaScrollByWheelAtHwnd: uiaScrollByWheelAtHwndMock,
}));

// Mock window resolution dependencies.
const resolveWindowTargetMock = vi.fn();
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: resolveWindowTargetMock,
}));

const getForegroundHwndMock = vi.fn();
const enumWindowsInZOrderMock = vi.fn();
vi.mock("../../src/engine/win32.js", () => ({
  getForegroundHwnd: getForegroundHwndMock,
  enumWindowsInZOrder: enumWindowsInZOrderMock,
}));

const findContainingWindowMock = vi.fn();
vi.mock("../../src/engine/window-cache.js", () => ({
  findContainingWindow: findContainingWindowMock,
}));

// Import after mocks are registered.
const {
  resolveInputDestination,
  dispatchScrollWheel,
  assertTier4Reachable,
} = await import("../../src/tools/_input-pipeline.js");

describe("ADR-018 §2.3 — resolveInputDestination", () => {
  beforeEach(() => {
    resolveWindowTargetMock.mockReset();
    getForegroundHwndMock.mockReset();
    enumWindowsInZOrderMock.mockReset();
    findContainingWindowMock.mockReset();
  });

  it("returns {kind:'hwnd'} when resolveWindowTarget resolves", async () => {
    resolveWindowTargetMock.mockResolvedValue({
      title: "Test",
      hwnd: 0xABCDn,
      warnings: [],
    });
    const dest = await resolveInputDestination({ windowTitle: "Test" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0xABCDn });
  });

  it("falls back to enumWindowsInZOrder when resolveWindowTarget returns null with plain title", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0xFEEDn, title: "MyApp - Notepad", isMinimized: false, className: "Notepad", ownerHwnd: null },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0xFEEDn });
  });

  it("falls back to findContainingWindow when cursor coords supplied", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([]);
    findContainingWindowMock.mockReturnValue({ hwnd: 0xC0DEn });
    const dest = await resolveInputDestination({ cursor: { x: 100, y: 200 } });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0xC0DEn });
  });

  it("falls back to getForegroundHwnd as last resort", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([]);
    findContainingWindowMock.mockReturnValue(null);
    getForegroundHwndMock.mockReturnValue(0xFEAFn);
    const dest = await resolveInputDestination({});
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0xFEAFn });
  });

  it("returns {kind:'unresolved'} when every fallback yields null", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([]);
    findContainingWindowMock.mockReturnValue(null);
    getForegroundHwndMock.mockReturnValue(null);
    const dest = await resolveInputDestination({});
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });
});

describe("ADR-018 §2.6 — dispatchScrollWheel (Tier 1 UIA path)", () => {
  beforeEach(() => {
    uiaScrollByWheelAtHwndMock.mockReset();
  });

  it("UIA call returns scrolled:true → DispatchOutcome {channel:'uia', reason:'delivered_via_uia'}", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: true, scrolled: true });
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x1234n },
      { direction: "down", notch: 3 },
    );
    expect(result).toEqual({
      scrolled: true,
      channel: "uia",
      reason: "delivered_via_uia",
    });
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenCalledWith({
      hwnd: "4660",
      wheelDeltaY: 360,
      wheelDeltaX: 0,
    });
  });

  it("UIA call returns scrolled:false → null (caller falls through)", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: true, scrolled: false, error: "No ScrollPattern ancestor found" });
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x1234n },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
  });

  it("UIA call returns ok:false → null (caller falls through)", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: false, scrolled: false });
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x1234n },
      { direction: "up", notch: 2 },
    );
    expect(result).toBeNull();
  });

  it("UIA call throws → null (graceful fall-through, no propagation)", async () => {
    uiaScrollByWheelAtHwndMock.mockRejectedValue(new Error("native crash"));
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x1234n },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
  });

  it("kind='unresolved' → null (Tier 4 SendInput is caller's responsibility)", async () => {
    const result = await dispatchScrollWheel(
      { kind: "unresolved", reason: "no_target_window" },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
    expect(uiaScrollByWheelAtHwndMock).not.toHaveBeenCalled();
  });

  it("kind='cdp' → null (Phase 3 stub, caller falls through)", async () => {
    const result = await dispatchScrollWheel(
      { kind: "cdp", tabId: "abc123" },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
    expect(uiaScrollByWheelAtHwndMock).not.toHaveBeenCalled();
  });

  it("wheel delta sign convention: down=positive, up=negative, right=positive, left=negative", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: true, scrolled: true });

    await dispatchScrollWheel({ kind: "hwnd", hwnd: 1n }, { direction: "down", notch: 1 });
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenLastCalledWith(expect.objectContaining({ wheelDeltaY: 120, wheelDeltaX: 0 }));

    await dispatchScrollWheel({ kind: "hwnd", hwnd: 1n }, { direction: "up", notch: 1 });
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenLastCalledWith(expect.objectContaining({ wheelDeltaY: -120, wheelDeltaX: 0 }));

    await dispatchScrollWheel({ kind: "hwnd", hwnd: 1n }, { direction: "right", notch: 2 });
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenLastCalledWith(expect.objectContaining({ wheelDeltaX: 240, wheelDeltaY: 0 }));

    await dispatchScrollWheel({ kind: "hwnd", hwnd: 1n }, { direction: "left", notch: 2 });
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenLastCalledWith(expect.objectContaining({ wheelDeltaX: -240, wheelDeltaY: 0 }));
  });
});

describe("ADR-018 §4 Phase 1 runtime guard — assertTier4Reachable", () => {
  it("kind='unresolved' → no throw (canonical Tier 4 destination)", () => {
    expect(() =>
      assertTier4Reachable({ kind: "unresolved", reason: "no_target_window" }),
    ).not.toThrow();
  });

  it("kind='hwnd' → no throw (Phase 1b lenient form)", () => {
    expect(() => assertTier4Reachable({ kind: "hwnd", hwnd: 0n })).not.toThrow();
  });

  it("kind='uia' → throws (Tier 1 must dispatch via UIA, never via SendInput)", () => {
    expect(() => assertTier4Reachable({ kind: "uia", hwnd: 0n })).toThrow(
      /Tier 4 SendInput must not be reached/,
    );
  });

  it("kind='cdp' → throws (Tier 2 must dispatch via CDP, never via SendInput)", () => {
    expect(() => assertTier4Reachable({ kind: "cdp", tabId: "x" })).toThrow(
      /Tier 4 SendInput must not be reached/,
    );
  });
});
