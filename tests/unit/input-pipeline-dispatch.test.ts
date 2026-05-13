/**
 * ADR-018 Phase 1b — input pipeline dispatcher tests.
 *
 * Pins the Phase 1b contract:
 *   1. `resolveInputDestination` returns `{kind:'hwnd'}` when resolveWindowTarget
 *      resolves the window, and `{kind:'unresolved'}` when resolveWindowTarget
 *      returns null. The resolver is the SINGLE SSOT for dispatch destination
 *      (ADR §2.3 D3) — cursor / foreground / enum fallbacks live in
 *      scrollHandler for OBSERVATION HWND only, never for dispatch.
 *   2. `dispatchScrollWheel({kind:'hwnd'}, ...)` returns
 *      `{scrolled:true, channel:'uia', reason:'delivered_via_uia'}` when the
 *      native `uiaScrollByWheelAtHwnd` returns `ok:true, scrolled:true`.
 *   3. `dispatchScrollWheel` returns `null` when the native call returns
 *      `ok:false` or `scrolled:false`, or when the native binding is missing
 *      (so the caller falls through to Tier 4 SendInput).
 *   4. `assertTier4Reachable` throws for `'uia'` and `'cdp'`. Phase 1b accepts
 *      both `'hwnd'` (lenient form, see Phase 4 BREAKING CHANGE marker on the
 *      function) and `'unresolved'`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the native loader before importing the SUT so the dispatcher's
// static import of `../../index.js` resolves to our stub.
const uiaScrollByWheelAtHwndMock = vi.fn();
vi.mock("../../index.js", () => ({
  uiaScrollByWheelAtHwnd: uiaScrollByWheelAtHwndMock,
}));

// Mock window resolution dependency.
const resolveWindowTargetMock = vi.fn();
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: resolveWindowTargetMock,
}));

// Import after mocks are registered.
const {
  resolveInputDestination,
  dispatchScrollWheel,
  assertTier4Reachable,
} = await import("../../src/tools/_input-pipeline.js");

describe("ADR-018 §2.3 — resolveInputDestination (single SSOT via resolveWindowTarget)", () => {
  beforeEach(() => {
    resolveWindowTargetMock.mockReset();
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

  it("returns {kind:'unresolved'} when resolveWindowTarget returns null", async () => {
    // Case 3 (plain windowTitle top-level match): resolveWindowTarget returns
    // null to signal "caller handles". Phase 1b dispatcher reads that as
    // 'unresolved' so the caller falls through to Tier 4. The legacy nutjs
    // path then dispatches via cursor — this is the only place cursor-pixel
    // routing reaches the wheel, confined to Tier 4 per ADR §1.2.
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });

  it("returns {kind:'unresolved'} when neither hwnd nor windowTitle is given", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
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

  it("UIA call returns scrolled:false (no pre/post diff) → null (caller falls through)", async () => {
    // ADR §2.6.2: `delivered_via_uia` requires pre/post UIA percent to differ.
    // Rust returns `scrolled:false` when SetScrollPercent succeeded but
    // CurrentVerticalScrollPercent did not move (e.g. already at boundary, or
    // the element rejected the percent silently).
    uiaScrollByWheelAtHwndMock.mockResolvedValue({
      ok: true,
      scrolled: false,
      error: "SetScrollPercent returned Ok but pre/post percent unchanged",
    });
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x1234n },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
  });

  it("UIA call returns ok:false (view size unavailable / SetScrollPercent failed) → null", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({
      ok: false,
      scrolled: false,
      error: "CurrentVerticalViewSize unavailable: …",
    });
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

  it("wheel delta sign convention (UIA-internal): down/right positive, up/left negative — Tier 4/PostMessage MUST flip for Phase 4", async () => {
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

  it("kind='hwnd' → no throw (Phase 1b LENIENT FORM — Phase 4 inverts this assertion to .toThrow when Tier 3 PostMessage lands)", () => {
    // ⚠ Phase 4 BREAKING CHANGE marker ⚠
    // When Tier 3 PostMessage lands, this assertion inverts: resolved HWNDs
    // that exhausted Tiers 1/2/3 must NOT reach Tier 4 SendInput per
    // ADR §2.6.2 path-(b). The same PR that lands Tier 3 must update this
    // case to `.toThrow(/Tier 4 SendInput must not be reached/)`.
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
