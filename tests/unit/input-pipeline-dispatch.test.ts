/**
 * ADR-018 Phase 1b — input pipeline dispatcher tests.
 *
 * Pins the Phase 1b contract:
 *   1. `resolveInputDestination` returns `{kind:'hwnd'}` when resolveWindowTarget
 *      resolves the window. When resolveWindowTarget returns null but a plain
 *      *top-level* window (non-dialog class, no owner — `_resolve-window.ts`
 *      Case 3's constraints — plus a minimized-window exclusion: a minimized
 *      HWND is not a usable dispatch/observation target) matches the
 *      `windowTitle`, it recovers that HWND via an `enumWindowsInZOrder` lookup
 *      (Case 3 recovery — keeps Tier 1 UIA reachable for windowTitle-only calls
 *      per ADR §4 G1). It returns `{kind:'unresolved'}` only when no such
 *      window matches. The recovery is title-based, NOT cursor/foreground —
 *      dispatch routing never touches cursor coordinates (ADR §1.2 confinement).
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

// Mock the native loader before importing the SUT. The dispatcher reads the
// Tier 1 native call via the tolerant `native-engine.ts` loader (NOT a direct
// `index.js` import — Codex PR #288 Round 6 P1). `nativeUiaMock` is a mutable
// holder so a test can simulate a missing native export by clearing the
// `uiaScrollByWheelAtHwnd` property.
const uiaScrollByWheelAtHwndMock = vi.fn();
const nativeUiaMock: { uiaScrollByWheelAtHwnd?: unknown } = {
  uiaScrollByWheelAtHwnd: uiaScrollByWheelAtHwndMock,
};
vi.mock("../../src/engine/native-engine.js", () => ({
  nativeUia: nativeUiaMock,
}));

// Mock window resolution dependency. `DIALOG_CLASSNAMES` is re-exported from
// the real module so `resolveInputDestination`'s Case 3 predicate can mirror
// `_resolve-window.ts` Case 3 (non-dialog class + no owner).
const resolveWindowTargetMock = vi.fn();
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: resolveWindowTargetMock,
  DIALOG_CLASSNAMES: new Set(["#32770"]),
}));

// Mock window enumeration — `resolveInputDestination` falls back to
// `enumWindowsInZOrder` to recover the HWND for a plain-windowTitle Case 3
// match (resolveWindowTarget returns null in that case by design), and Phase 3
// also consults it for the Chromium-class gate in `resolveCdpDestinationForHwnd`.
const enumWindowsInZOrderMock = vi.fn();
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: enumWindowsInZOrderMock,
}));

// Phase 3 Tier 2 CDP — mock the cdp-bridge surface used by the dispatcher.
const listTabsLightMock = vi.fn();
const dispatchWheelInTabMock = vi.fn();
const readScrollPositionInTabMock = vi.fn();
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  listTabsLight: listTabsLightMock,
  dispatchWheelInTab: dispatchWheelInTabMock,
  readScrollPositionInTab: readScrollPositionInTabMock,
}));

// Mock CDP port lookup — keeps `resolveCdpDestinationForHwnd` deterministic.
const getCdpPortMock = vi.fn(() => 9222);
vi.mock("../../src/utils/desktop-config.js", () => ({
  getCdpPort: getCdpPortMock,
}));

// Import after mocks are registered.
const {
  resolveInputDestination,
  resolveCdpDestinationForHwnd,
  dispatchScrollWheel,
  assertTier4Reachable,
} = await import("../../src/tools/_input-pipeline.js");

describe("ADR-018 §2.3 — resolveInputDestination (single SSOT via resolveWindowTarget)", () => {
  beforeEach(() => {
    resolveWindowTargetMock.mockReset();
    enumWindowsInZOrderMock.mockReset();
    enumWindowsInZOrderMock.mockReturnValue([]);
    listTabsLightMock.mockReset();
    dispatchWheelInTabMock.mockReset();
    readScrollPositionInTabMock.mockReset();
    getCdpPortMock.mockReturnValue(9222);
  });

  it("returns {kind:'hwnd'} when resolveWindowTarget resolves and the HWND is not Chromium (CDP gate misses, no CDP probe)", async () => {
    // Phase 3 consults `enumWindowsInZOrder` for the Chromium-class gate. With
    // the default empty enumeration the gate misses → no CDP promotion → the
    // resolver returns `{kind:'hwnd'}`. `listTabsLight` is NOT called because
    // the class gate fails before the HTTP probe.
    resolveWindowTargetMock.mockResolvedValue({
      title: "Test",
      hwnd: 0xABCDn,
      warnings: [],
    });
    const dest = await resolveInputDestination({ windowTitle: "Test" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0xABCDn });
    expect(listTabsLightMock).not.toHaveBeenCalled();
  });

  it("Case 3 recovery: resolveWindowTarget null + plain windowTitle matches a top-level window → {kind:'hwnd'} via enumWindowsInZOrder (keeps Tier 1 UIA reachable, ADR §4 G1)", async () => {
    // resolveWindowTarget returns null for a plain-windowTitle top-level match
    // BY DESIGN (_resolve-window.ts Case 3 discards the HWND to keep legacy
    // title-based callers unchanged). resolveInputDestination must recover the
    // HWND via the same top-level enumeration — otherwise G1 acceptance
    // (scroll(windowTitle:'メモ帳') → channel:'uia') can never pass.
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x111n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x111n });
  });

  it("Case 3 recovery matches case-insensitively on a title substring", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x333n, title: "メモ帳", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "メモ帳" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x333n });
  });

  it("Case 3 recovery EXCLUDES #32770 dialogs and owned windows — recovers the true top-level even when a dialog/owned window matches the same title (Codex Round 3 P2)", async () => {
    // The predicate applies _resolve-window.ts Case 3's constraints (`!#32770`
    // + `ownerHwnd == null`) so dispatch targets a true top-level window, not
    // an owned/modal dialog with a coincidentally-overlapping title substring.
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x501n, title: "Notepad — Save As", className: "#32770", ownerHwnd: 0x999n, isMinimized: false },
      { hwnd: 0x502n, title: "Notepad helper", className: "Tooltip", ownerHwnd: 0x999n, isMinimized: false },
      { hwnd: 0x503n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x503n });
  });

  it("Case 3 recovery EXCLUDES minimized windows — recovers the non-minimized top-level match (Codex Round 4 P1)", async () => {
    // A minimized HWND is not a usable dispatch target (UIA scroll on an
    // off-screen window) and would pin observation to an unobservable window.
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x701n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: true },
      { hwnd: 0x702n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x702n });
  });

  it("returns {kind:'unresolved'} when the only title match is minimized", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x711n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: true },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });

  it("returns {kind:'unresolved'} when only a dialog / owned window matches the title (no true top-level)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x601n, title: "Notepad — Save As", className: "#32770", ownerHwnd: 0x999n },
      { hwnd: 0x602n, title: "Notepad popup", className: "Notepad", ownerHwnd: 0x999n },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });

  it("returns {kind:'unresolved'} when resolveWindowTarget null AND no enumeration match", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x444n, title: "Some Other Window", className: "Window", ownerHwnd: null },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });

  it("returns {kind:'unresolved'} when neither hwnd nor windowTitle is given (no enumeration attempted)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({});
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
    expect(enumWindowsInZOrderMock).not.toHaveBeenCalled();
  });

  it("does not attempt enumeration for windowTitle '@active' (resolveWindowTarget owns @active)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({ windowTitle: "@active" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
    expect(enumWindowsInZOrderMock).not.toHaveBeenCalled();
  });

  it("returns {kind:'unresolved'} when enumWindowsInZOrder throws (graceful fall-through)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockImplementation(() => {
      throw new Error("enumeration unavailable");
    });
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });
});

describe("ADR-018 §2.6 — dispatchScrollWheel (Tier 1 UIA path)", () => {
  beforeEach(() => {
    uiaScrollByWheelAtHwndMock.mockReset();
    // Restore the native export in case a prior test cleared it.
    nativeUiaMock.uiaScrollByWheelAtHwnd = uiaScrollByWheelAtHwndMock;
  });

  it("native binding missing (nativeUia.uiaScrollByWheelAtHwnd undefined) → null (caller falls through to Tier 4)", async () => {
    // Codex PR #288 Round 6 P1: when the addon is absent the tolerant
    // native-engine loader yields `nativeUia === null` (or an older `.node`
    // build leaves `uiaScrollByWheelAtHwnd` undefined). Either way the
    // `typeof !== "function"` guard returns null so the caller falls through
    // to Tier 4 SendInput — the dispatcher must NOT throw at import or call.
    nativeUiaMock.uiaScrollByWheelAtHwnd = undefined;
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x1234n },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
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

  it("kind='cdp' → does NOT invoke Tier 1 UIA (handled by Tier 2 CDP branch — see Phase 3 describe block below)", async () => {
    // Phase 3 implemented the kind:'cdp' branch (Tier 2 CDP). The Phase 1b
    // expectation "Tier 1 UIA is not invoked for CDP destinations" still
    // stands; the actual CDP dispatch is exercised in the separate
    // Phase 3 describe block which mocks `cdp-bridge.js`.
    readScrollPositionInTabMock.mockResolvedValueOnce(null); // pre-snapshot fails → null
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-018 Phase 3 — Tier 2 CDP path + auto-promotion
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-018 Phase 3 — resolveCdpDestinationForHwnd (Chromium-class gate + listTabsLight probe)", () => {
  beforeEach(() => {
    enumWindowsInZOrderMock.mockReset();
    listTabsLightMock.mockReset();
    getCdpPortMock.mockReturnValue(9222);
  });

  it("non-Chromium HWND (className='Notepad'): null (gate misses, listTabsLight NOT called — zero CDP latency for native windows)", async () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x111n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const dest = await resolveCdpDestinationForHwnd(0x111n);
    expect(dest).toBeNull();
    expect(listTabsLightMock).not.toHaveBeenCalled();
  });

  it("Chromium HWND ('Chrome_WidgetWin_1') + listTabsLight returns tabs: {kind:'cdp', tabId}", async () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x222n, title: "Google - Chrome", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false },
    ]);
    listTabsLightMock.mockResolvedValue([
      { id: "TAB-AAA", title: "Google", url: "https://google.com/" },
      { id: "TAB-BBB", title: "Bing", url: "https://bing.com/" },
    ]);
    const dest = await resolveCdpDestinationForHwnd(0x222n);
    expect(dest).toEqual({ kind: "cdp", tabId: "TAB-AAA" });
  });

  it("Chromium HWND + listTabsLight rejects (CDP unreachable): null (graceful fallback to Tier 1)", async () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x333n, title: "Edge", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false },
    ]);
    listTabsLightMock.mockRejectedValue(new Error("CDP unreachable on 127.0.0.1:9222"));
    const dest = await resolveCdpDestinationForHwnd(0x333n);
    expect(dest).toBeNull();
  });

  it("Chromium HWND + listTabsLight returns empty array: null", async () => {
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0x444n, title: "Edge", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false },
    ]);
    listTabsLightMock.mockResolvedValue([]);
    const dest = await resolveCdpDestinationForHwnd(0x444n);
    expect(dest).toBeNull();
  });

  it("HWND not in enumeration: null", async () => {
    enumWindowsInZOrderMock.mockReturnValue([]);
    const dest = await resolveCdpDestinationForHwnd(0x555n);
    expect(dest).toBeNull();
    expect(listTabsLightMock).not.toHaveBeenCalled();
  });

  it("enumWindowsInZOrder throws: null (graceful — no exception propagation)", async () => {
    enumWindowsInZOrderMock.mockImplementation(() => {
      throw new Error("win32 dlopen failed");
    });
    const dest = await resolveCdpDestinationForHwnd(0x666n);
    expect(dest).toBeNull();
  });
});

describe("ADR-018 Phase 3 — resolveInputDestination CDP promotion integration", () => {
  beforeEach(() => {
    resolveWindowTargetMock.mockReset();
    enumWindowsInZOrderMock.mockReset();
    enumWindowsInZOrderMock.mockReturnValue([]);
    listTabsLightMock.mockReset();
    getCdpPortMock.mockReturnValue(9222);
  });

  it("resolveWindowTarget succeeds + Chromium HWND + CDP reachable: promotes to {kind:'cdp'} (G3 path)", async () => {
    resolveWindowTargetMock.mockResolvedValue({
      title: "X - Chrome",
      hwnd: 0xAAAn,
      warnings: [],
    });
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0xAAAn, title: "X - Chrome", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false },
    ]);
    listTabsLightMock.mockResolvedValue([
      { id: "TAB-X", title: "X", url: "https://x.com/" },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Chrome" });
    expect(dest).toEqual({ kind: "cdp", tabId: "TAB-X" });
  });

  it("Case 3 recovery for Chromium HWND also promotes to {kind:'cdp'} (plain windowTitle on Chrome)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0xBBBn, title: "Google Chrome", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false },
    ]);
    listTabsLightMock.mockResolvedValue([
      { id: "TAB-Y", title: "X", url: "https://x.com/" },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Chrome" });
    expect(dest).toEqual({ kind: "cdp", tabId: "TAB-Y" });
  });

  it("Chromium HWND + CDP unreachable: falls back to {kind:'hwnd'} (Tier 1 UIA path remains available)", async () => {
    resolveWindowTargetMock.mockResolvedValue({
      title: "Chrome",
      hwnd: 0xCCCn,
      warnings: [],
    });
    enumWindowsInZOrderMock.mockReturnValue([
      { hwnd: 0xCCCn, title: "Chrome", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false },
    ]);
    listTabsLightMock.mockRejectedValue(new Error("Connection refused"));
    const dest = await resolveInputDestination({ windowTitle: "Chrome" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0xCCCn });
  });
});

describe("ADR-018 Phase 3 — dispatchScrollWheel (Tier 2 CDP path)", () => {
  beforeEach(() => {
    listTabsLightMock.mockReset();
    dispatchWheelInTabMock.mockReset();
    readScrollPositionInTabMock.mockReset();
    getCdpPortMock.mockReturnValue(9222);
  });

  const cdpDest = { kind: "cdp" as const, tabId: "TAB-X" };
  const snap = (top: number, left: number) => ({
    scrollTop: top,
    scrollLeft: left,
    scrollHeight: 5000,
    scrollWidth: 1280,
    clientHeight: 800,
    clientWidth: 1280,
  });

  it("vertical down: pre/post scrollTop differs by ≥ epsilon → {channel:'cdp', reason:'delivered_via_cdp'}", async () => {
    readScrollPositionInTabMock
      .mockResolvedValueOnce(snap(100, 0))
      .mockResolvedValueOnce(snap(260, 0));
    dispatchWheelInTabMock.mockResolvedValue(undefined);
    const result = await dispatchScrollWheel(cdpDest, { direction: "down", notch: 3 });
    expect(result).toEqual({
      scrolled: true,
      channel: "cdp",
      reason: "delivered_via_cdp",
    });
    // 3 notches × 120 = 360, down direction = positive deltaY.
    expect(dispatchWheelInTabMock).toHaveBeenCalledWith(
      0, 360,
      expect.any(Number), expect.any(Number),
      "TAB-X", 9222,
    );
  });

  it("vertical down: pre/post scrollTop unchanged → null (caller emits target_unreachable)", async () => {
    readScrollPositionInTabMock
      .mockResolvedValueOnce(snap(200, 0))
      .mockResolvedValueOnce(snap(200, 0));
    dispatchWheelInTabMock.mockResolvedValue(undefined);
    const result = await dispatchScrollWheel(cdpDest, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("pre-snapshot returns null (no CDP session): null (no wheel dispatched)", async () => {
    readScrollPositionInTabMock.mockResolvedValueOnce(null);
    const result = await dispatchScrollWheel(cdpDest, { direction: "down", notch: 1 });
    expect(result).toBeNull();
    expect(dispatchWheelInTabMock).not.toHaveBeenCalled();
  });

  it("dispatchWheelInTab throws → null (no propagation)", async () => {
    readScrollPositionInTabMock.mockResolvedValueOnce(snap(0, 0));
    dispatchWheelInTabMock.mockRejectedValue(new Error("CDP socket closed mid-dispatch"));
    const result = await dispatchScrollWheel(cdpDest, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("post-snapshot returns null after dispatch: null", async () => {
    readScrollPositionInTabMock
      .mockResolvedValueOnce(snap(0, 0))
      .mockResolvedValueOnce(null);
    dispatchWheelInTabMock.mockResolvedValue(undefined);
    const result = await dispatchScrollWheel(cdpDest, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("horizontal right: observes scrollLeft (not scrollTop) and dispatches deltaX positive", async () => {
    readScrollPositionInTabMock
      .mockResolvedValueOnce(snap(0, 50))
      .mockResolvedValueOnce(snap(0, 290));
    dispatchWheelInTabMock.mockResolvedValue(undefined);
    const result = await dispatchScrollWheel(cdpDest, { direction: "right", notch: 2 });
    expect(result).toEqual({
      scrolled: true,
      channel: "cdp",
      reason: "delivered_via_cdp",
    });
    expect(dispatchWheelInTabMock).toHaveBeenCalledWith(
      240, 0,
      expect.any(Number), expect.any(Number),
      "TAB-X", 9222,
    );
  });

  it("vertical up: deltaY negative (UIA-internal sign convention — CDP/CSS positive-down matches)", async () => {
    readScrollPositionInTabMock
      .mockResolvedValueOnce(snap(500, 0))
      .mockResolvedValueOnce(snap(380, 0));
    dispatchWheelInTabMock.mockResolvedValue(undefined);
    const result = await dispatchScrollWheel(cdpDest, { direction: "up", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "cdp",
      reason: "delivered_via_cdp",
    });
    expect(dispatchWheelInTabMock).toHaveBeenCalledWith(
      0, -120,
      expect.any(Number), expect.any(Number),
      "TAB-X", 9222,
    );
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
