/**
 * ADR-018 Phase 1b + Phase 3 + Phase 4 — input pipeline dispatcher tests.
 *
 * Pins the cumulative dispatcher contract across phases:
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
 *   3. Phase 4: when Tier 1 UIA returns null (no ScrollPattern, or scrolled:false),
 *      dispatcher falls through to Tier 3 `postWheelToHwnd`. Tier 3 returns
 *      `{channel:'postmessage', reason:'delivered_via_postmessage'}` on observable
 *      `win32_get_scroll_info` pre/post diff; null on no observable diff
 *      (Word `_WwG` MFC custom-paint case → caller emits `target_unreachable`).
 *   4. `assertTier4Reachable` STRICT form (Phase 4): throws for `'uia' | 'cdp' | 'hwnd'`.
 *      Only `'unresolved'` passes. The dispatcher covers resolved destinations
 *      via Tier 1/2/3 so SendInput is unreachable for any resolved kind.
 *
 * Phase 4 changes are described in `docs/adr-018-phase-4-subplan.md`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the native loader before importing the SUT. The dispatcher reads the
// Tier 1 native call via the tolerant `native-engine.ts` loader (NOT a direct
// `index.js` import — Codex PR #288 Round 6 P1). `nativeUiaMock` is a mutable
// holder so a test can simulate a missing native export by clearing the
// `uiaScrollByWheelAtHwnd` property. `nativeWin32Mock` is the Phase 4 Tier 3
// PostMessage surface (`win32PostMessage` + `win32GetScrollInfo`).
const uiaScrollByWheelAtHwndMock = vi.fn();
// ADR-019 MVP-1 (Stage 1) — read-only ScrollPercent observation mock.
// Default impl returns `null` (no UIA pattern exposed) so existing tests
// stay bit-equal with the chain-trust fall-through path (observation.source:
// "chain_trust_unverified"). Stage 1 tests override to return numeric
// pre/post percents and exercise the `uia_scroll_percent` observation path.
const uiaReadScrollPercentAtHwndMock = vi.fn<
  [{ hwnd: string; axis: "vertical" | "horizontal" }],
  Promise<number | null>
>(async () => null);
const nativeUiaMock: {
  uiaScrollByWheelAtHwnd?: unknown;
  uiaReadScrollPercentAtHwnd?: unknown;
} = {
  uiaScrollByWheelAtHwnd: uiaScrollByWheelAtHwndMock,
  uiaReadScrollPercentAtHwnd: uiaReadScrollPercentAtHwndMock,
};
const win32PostMessageMock = vi.fn<[bigint, number, bigint, bigint], boolean>();
const win32GetScrollInfoMock = vi.fn<
  [bigint, string],
  { nMin: number; nMax: number; nPage: number; nPos: number; pageRatio: number } | null
>();
// ADR-018 Phase 5+N: scroll-leaf walker mock. Default impl returns `null`
// (no retarget) so existing Phase 4 tests stay bit-equal; the dedicated
// leaf-walker describe block below overrides per-test.
const win32FindScrollLeafForTopLevelMock = vi.fn<[bigint], bigint | null>(() => null);
const nativeWin32Mock: {
  win32PostMessage?: unknown;
  win32GetScrollInfo?: unknown;
  win32FindScrollLeafForTopLevel?: unknown;
} = {
  win32PostMessage: win32PostMessageMock,
  win32GetScrollInfo: win32GetScrollInfoMock,
  win32FindScrollLeafForTopLevel: win32FindScrollLeafForTopLevelMock,
};
vi.mock("../../src/engine/native-engine.js", () => ({
  nativeUia: nativeUiaMock,
  nativeWin32: nativeWin32Mock,
  // `nativeL1` is set to null so `postWheelToHwnd`'s optional-chain L1 push
  // (`nativeL1?.l1PushHwInputPostMessage?.(...)`) becomes a no-op in tests.
  // The ADR-007 P5a observability contract is exercised by the L1 integration
  // tests; here we only need the dispatcher logic to remain pure.
  nativeL1: null,
}));

// Mock window resolution dependency. `DIALOG_CLASSNAMES` is re-exported from
// the real module so `resolveInputDestination`'s Case 3 predicate can mirror
// `_resolve-window.ts` Case 3 (non-dialog class + no owner). Phase 5:
// `findPlainTopLevelWindowByTitle` is the shared helper that replaced the
// inline predicate — see `docs/adr-018-phase-5-subplan.md` §2.1#2.
const resolveWindowTargetMock = vi.fn();
const findPlainTopLevelWindowByTitleMock = vi.fn();
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: resolveWindowTargetMock,
  findPlainTopLevelWindowByTitle: findPlainTopLevelWindowByTitleMock,
  DIALOG_CLASSNAMES: new Set(["#32770"]),
}));

// Mock window enumeration is no longer needed by `resolveInputDestination`
// directly (the Phase 5 helper extraction routes through
// `findPlainTopLevelWindowByTitle` instead). `enumWindowsInZOrderMock` is
// retained for legacy test scaffolding compatibility. `getWindowRectByHwnd`
// is mocked because Phase 4 Tier 3 `postWheelToHwnd` uses it for
// `MAKELPARAM(screenCx, screenCy)` encoding.
const enumWindowsInZOrderMock = vi.fn();
const getWindowRectByHwndMock = vi.fn<
  [bigint],
  { x: number; y: number; width: number; height: number } | null
>();
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: enumWindowsInZOrderMock,
  getWindowRectByHwnd: getWindowRectByHwndMock,
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
  postWheelToHwnd,
} = await import("../../src/tools/_input-pipeline.js");

describe("ADR-018 §2.3 — resolveInputDestination (single SSOT via resolveWindowTarget)", () => {
  beforeEach(() => {
    resolveWindowTargetMock.mockReset();
    findPlainTopLevelWindowByTitleMock.mockReset();
    findPlainTopLevelWindowByTitleMock.mockReturnValue(null);
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

  it("Case 3 recovery: resolveWindowTarget null + plain windowTitle matches a top-level window → {kind:'hwnd'} via findPlainTopLevelWindowByTitle (keeps Tier 1 UIA reachable, ADR §4 G1)", async () => {
    // resolveWindowTarget returns null for a plain-windowTitle top-level match
    // BY DESIGN (_resolve-window.ts Case 3 discards the HWND to keep legacy
    // title-based callers unchanged). resolveInputDestination must recover the
    // HWND via the shared findPlainTopLevelWindowByTitle helper (Phase 5
    // §2.1#2 extraction) — otherwise G1 acceptance can never pass.
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowByTitleMock.mockReturnValue({
      hwnd: 0x111n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false,
    });
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x111n });
    // Phase 5 contract: helper called with both flags TRUE (strict dispatcher
    // predicate per sub-plan §2.1#2 table).
    expect(findPlainTopLevelWindowByTitleMock).toHaveBeenCalledWith("Notepad", {
      excludeMinimized: true,
      excludeDialogsAndOwned: true,
    });
  });

  it("Case 3 recovery matches case-insensitively on a title substring (helper-internal contract)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowByTitleMock.mockReturnValue({
      hwnd: 0x333n, title: "メモ帳", className: "Notepad", ownerHwnd: null, isMinimized: false,
    });
    const dest = await resolveInputDestination({ windowTitle: "メモ帳" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x333n });
  });

  it("Case 3 recovery EXCLUDES #32770 dialogs and owned windows — flag excludeDialogsAndOwned: true (Codex PR #288 Round 3 P2)", async () => {
    // The dispatcher calls the helper with excludeDialogsAndOwned:true; the
    // per-flag predicate behavior is pinned by find-plain-top-level-window.test.ts.
    // Here we only verify the dispatcher passes the correct flag combination.
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowByTitleMock.mockReturnValue({
      hwnd: 0x503n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false,
    });
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x503n });
    expect(findPlainTopLevelWindowByTitleMock).toHaveBeenCalledWith("Notepad",
      expect.objectContaining({ excludeDialogsAndOwned: true }));
  });

  it("Case 3 recovery EXCLUDES minimized windows — flag excludeMinimized: true (Codex PR #288 Round 4 P1)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowByTitleMock.mockReturnValue({
      hwnd: 0x702n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false,
    });
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x702n });
    expect(findPlainTopLevelWindowByTitleMock).toHaveBeenCalledWith("Notepad",
      expect.objectContaining({ excludeMinimized: true }));
  });

  it("returns {kind:'unresolved'} when helper returns null (no recoverable top-level)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowByTitleMock.mockReturnValue(null);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });

  it("returns {kind:'unresolved'} when neither hwnd nor windowTitle is given (helper not called)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({});
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
    expect(findPlainTopLevelWindowByTitleMock).not.toHaveBeenCalled();
  });

  it("does not attempt helper lookup for windowTitle '@active' (resolveWindowTarget owns @active)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({ windowTitle: "@active" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
    expect(findPlainTopLevelWindowByTitleMock).not.toHaveBeenCalled();
  });
});

describe("ADR-018 §2.6 — dispatchScrollWheel (Tier 1 UIA path)", () => {
  beforeEach(() => {
    uiaScrollByWheelAtHwndMock.mockReset();
    win32PostMessageMock.mockReset();
    win32GetScrollInfoMock.mockReset();
    getWindowRectByHwndMock.mockReset();
    // Restore the native exports in case a prior test cleared them.
    nativeUiaMock.uiaScrollByWheelAtHwnd = uiaScrollByWheelAtHwndMock;
    nativeWin32Mock.win32PostMessage = win32PostMessageMock;
    nativeWin32Mock.win32GetScrollInfo = win32GetScrollInfoMock;
    // Phase 4 default: Tier 3 PostMessage returns null (no observable diff).
    // Tier 1 UIA-only tests below leave these defaults so the dispatcher's
    // Tier 1 → Tier 3 fall-through still produces null when Tier 1 returns
    // null. Phase 4 Tier 3 tests override these per-case.
    win32PostMessageMock.mockReturnValue(true);
    win32GetScrollInfoMock.mockReturnValue(null);
    getWindowRectByHwndMock.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
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

describe("ADR-018 Phase 3 — resolveCdpDestinationForHwnd (top-level class gate + listTabsLight probe)", () => {
  // Phase 3 R1 (Opus P2): the gate is now a strict class equality on
  // `Chrome_WidgetWin_1` (the top-level class shared by Chrome and Edge),
  // and the className is **passed in by the caller** (already known from
  // ResolvedWindow.className / enumWindowsInZOrder), so this function does
  // NOT re-enumerate windows. The mock setup reflects that — no
  // enumWindowsInZOrderMock for these cases.
  beforeEach(() => {
    listTabsLightMock.mockReset();
    getCdpPortMock.mockReturnValue(9222);
  });

  it("non-Chromium className ('Notepad'): null (gate misses, listTabsLight NOT called — zero CDP latency for native windows)", async () => {
    const dest = await resolveCdpDestinationForHwnd(0x111n, "Notepad");
    expect(dest).toBeNull();
    expect(listTabsLightMock).not.toHaveBeenCalled();
  });

  it("Chromium top-level class + listTabsLight returns tabs: {kind:'cdp', tabId}", async () => {
    listTabsLightMock.mockResolvedValue([
      { id: "TAB-AAA", title: "Google", url: "https://google.com/" },
      { id: "TAB-BBB", title: "Bing", url: "https://bing.com/" },
    ]);
    const dest = await resolveCdpDestinationForHwnd(0x222n, "Chrome_WidgetWin_1");
    expect(dest).toEqual({ kind: "cdp", tabId: "TAB-AAA" });
  });

  it("Chromium top-level class + listTabsLight rejects (CDP unreachable): null (graceful fallback to Tier 1)", async () => {
    listTabsLightMock.mockRejectedValue(new Error("CDP unreachable on 127.0.0.1:9222"));
    const dest = await resolveCdpDestinationForHwnd(0x333n, "Chrome_WidgetWin_1");
    expect(dest).toBeNull();
  });

  it("Chromium top-level class + listTabsLight returns empty array: null", async () => {
    listTabsLightMock.mockResolvedValue([]);
    const dest = await resolveCdpDestinationForHwnd(0x444n, "Chrome_WidgetWin_1");
    expect(dest).toBeNull();
  });

  it("className null (race with window destruction): null (no CDP probe)", async () => {
    const dest = await resolveCdpDestinationForHwnd(0x555n, null);
    expect(dest).toBeNull();
    expect(listTabsLightMock).not.toHaveBeenCalled();
  });

  it("Chromium SUB-window class ('Chrome_WidgetWin_0' — internal popups / dropdowns) is rejected by the strict gate (Phase 3 R1 Opus P2)", async () => {
    // The earlier `startsWith("Chrome_WidgetWin")` shape over-matched the
    // sub-window class which can never be a scroll destination. The strict
    // equality on `Chrome_WidgetWin_1` rejects it.
    const dest = await resolveCdpDestinationForHwnd(0x666n, "Chrome_WidgetWin_0");
    expect(dest).toBeNull();
    expect(listTabsLightMock).not.toHaveBeenCalled();
  });
});

describe("ADR-018 Phase 3 — resolveInputDestination CDP promotion integration", () => {
  beforeEach(() => {
    resolveWindowTargetMock.mockReset();
    findPlainTopLevelWindowByTitleMock.mockReset();
    findPlainTopLevelWindowByTitleMock.mockReturnValue(null);
    enumWindowsInZOrderMock.mockReset();
    enumWindowsInZOrderMock.mockReturnValue([]);
    listTabsLightMock.mockReset();
    getCdpPortMock.mockReturnValue(9222);
  });

  it("resolveWindowTarget succeeds + Chromium HWND + CDP reachable: promotes to {kind:'cdp'} (G3 path)", async () => {
    // Phase 3 R1: `ResolvedWindow.className` is what the gate consults — no
    // longer a second `enumWindowsInZOrder` call inside the resolver.
    resolveWindowTargetMock.mockResolvedValue({
      title: "X - Chrome",
      hwnd: 0xAAAn,
      warnings: [],
      className: "Chrome_WidgetWin_1",
    });
    listTabsLightMock.mockResolvedValue([
      { id: "TAB-X", title: "X", url: "https://x.com/" },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Chrome" });
    expect(dest).toEqual({ kind: "cdp", tabId: "TAB-X" });
  });

  it("Case 3 recovery for Chromium HWND also promotes to {kind:'cdp'} (plain windowTitle on Chrome)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowByTitleMock.mockReturnValue({
      hwnd: 0xBBBn, title: "Google Chrome", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false,
    });
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
      className: "Chrome_WidgetWin_1",
    });
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

describe("ADR-018 §4 Phase 4 runtime guard — assertTier4Reachable (strict form)", () => {
  it("kind='unresolved' → no throw (the ONLY canonical Tier 4 destination after Phase 4)", () => {
    expect(() =>
      assertTier4Reachable({ kind: "unresolved", reason: "no_target_window" }),
    ).not.toThrow();
  });

  it("kind='hwnd' → throws (Phase 4 STRICT FORM — Tier 3 PostMessage covers resolved-but-non-UIA destinations; SendInput would re-introduce cursor-pixel routing per ADR §1.2)", () => {
    // Phase 4 inverted from Phase 1b lenient form. Resolved HWNDs that exhaust
    // Tier 1 UIA + Tier 3 PostMessage must surface `target_unreachable` via
    // the typed envelope at the caller (mouse.ts:scrollHandler), NOT silently
    // fall through to cursor-pixel SendInput.
    expect(() => assertTier4Reachable({ kind: "hwnd", hwnd: 0n })).toThrow(
      /Tier 4 SendInput must not be reached/,
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-018 Phase 4 — Tier 3 PostMessage (WM_MOUSEWHEEL / WM_MOUSEHWHEEL)
//
// Pins the sub-plan `docs/adr-018-phase-4-subplan.md` §2.3 sign-convention
// matrix (load-bearing — a second flip on the horizontal axis would silently
// reverse left/right scrolling) and §2.4 lParam encoding (screen-center via
// getWindowRectByHwnd, sign-bit-preserved packing for negative multi-monitor
// coordinates).
// ─────────────────────────────────────────────────────────────────────────────

const WM_MOUSEWHEEL = 0x020a;
const WM_MOUSEHWHEEL = 0x020e;

describe("ADR-018 Phase 4 — postWheelToHwnd (Tier 3 PostMessage path)", () => {
  beforeEach(() => {
    win32PostMessageMock.mockReset();
    win32GetScrollInfoMock.mockReset();
    getWindowRectByHwndMock.mockReset();
    nativeWin32Mock.win32PostMessage = win32PostMessageMock;
    nativeWin32Mock.win32GetScrollInfo = win32GetScrollInfoMock;
    win32PostMessageMock.mockReturnValue(true);
    getWindowRectByHwndMock.mockReturnValue({ x: 100, y: 200, width: 800, height: 600 });
  });

  const scrollInfo = (nPos: number) => ({
    nMin: 0,
    nMax: 1000,
    nPage: 100,
    nPos,
    pageRatio: nPos / 1000,
  });

  // Window rect (100,200,800,600) → center (500, 500).
  const expectedLParam = BigInt((500 << 16) | 500);

  // BigInt-safe pack of signed 16-bit wParam HIWORD with LOWORD=0. The impl
  // masks to unsigned u32 (`& 0xffffffffn`) so the on-wire WPARAM bits match
  // a real mouse driver (top 32 bits zero on x64). JS `<<` is signed 32-bit
  // so we round-trip through `& 0xffff` then mask the BigInt to u32.
  const wParamFromSignedHigh = (signedHigh: number): bigint => {
    const hi = signedHigh & 0xffff;
    return BigInt((hi << 16) | 0) & 0xffffffffn;
  };

  it("vertical DOWN: posts WM_MOUSEWHEEL with FLIPPED wParam HIWORD (UIA down=+ → Win32 -120 = scroll down), observable scrollbar diff → delivered_via_postmessage", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await postWheelToHwnd(0xABCDn, { direction: "down", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      0xABCDn,
      WM_MOUSEWHEEL,
      wParamFromSignedHigh(-120),
      expectedLParam,
    );
  });

  it("vertical UP: posts WM_MOUSEWHEEL with POSITIVE wParam HIWORD (+120 = scroll up per Win32 convention)", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(80))
      .mockReturnValueOnce(scrollInfo(50));
    const result = await postWheelToHwnd(0x1234n, { direction: "up", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      0x1234n,
      WM_MOUSEWHEEL,
      wParamFromSignedHigh(120),
      expectedLParam,
    );
  });

  it("horizontal RIGHT: posts WM_MOUSEHWHEEL with POSITIVE wParam HIWORD (NO flip — UIA right=+ matches WM_MOUSEHWHEEL right=+)", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(40))
      .mockReturnValueOnce(scrollInfo(70));
    const result = await postWheelToHwnd(0x5678n, { direction: "right", notch: 2 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      0x5678n,
      WM_MOUSEHWHEEL,
      wParamFromSignedHigh(240),
      expectedLParam,
    );
  });

  it("horizontal LEFT: posts WM_MOUSEHWHEEL with NEGATIVE wParam HIWORD (NO flip — UIA left=- matches WM_MOUSEHWHEEL left=-)", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(70))
      .mockReturnValueOnce(scrollInfo(40));
    const result = await postWheelToHwnd(0x9ABCn, { direction: "left", notch: 2 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      0x9ABCn,
      WM_MOUSEHWHEEL,
      wParamFromSignedHigh(-240),
      expectedLParam,
    );
  });

  it("pre-snapshot is null (Word _WwG MFC custom-paint, no observable Win32 scrollbar) → null (caller emits target_unreachable)", async () => {
    win32GetScrollInfoMock.mockReturnValueOnce(null);
    const result = await postWheelToHwnd(0x1n, { direction: "down", notch: 1 });
    expect(result).toBeNull();
    // PostMessage WAS dispatched (best-effort) but the lack of observable
    // diff means we cannot claim delivered_via_postmessage.
    expect(win32PostMessageMock).toHaveBeenCalled();
  });

  it("post-snapshot returns null (race / scrollbar destroyed mid-scroll) → null", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(null);
    const result = await postWheelToHwnd(0x2n, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("pre/post nPos unchanged (message posted but no scroll happened) → null", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(50));
    const result = await postWheelToHwnd(0x3n, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("win32PostMessage returns false (target HWND invalid / message pump rejected) → null (no observation attempted)", async () => {
    win32PostMessageMock.mockReturnValue(false);
    win32GetScrollInfoMock.mockReturnValue(scrollInfo(50));
    const result = await postWheelToHwnd(0x4n, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("getWindowRectByHwnd returns null → lParam falls back to 0 (best-effort; apps that ignore lParam still scroll)", async () => {
    getWindowRectByHwndMock.mockReturnValue(null);
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await postWheelToHwnd(0x5n, { direction: "down", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      0x5n,
      WM_MOUSEWHEEL,
      expect.any(BigInt),
      0n, // lParam fallback when rect unavailable
    );
  });

  it("multi-monitor secondary display (negative screen coords): lParam preserves sign bits via (& 0xFFFF) packing (sub-plan §2.4 / R2)", async () => {
    // Window on a secondary monitor positioned left-of-primary: x=-1920, y=0.
    // Center is (-1920 + 1920/2, 0 + 1080/2) = (-960, 540).
    getWindowRectByHwndMock.mockReturnValue({ x: -1920, y: 0, width: 1920, height: 1080 });
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    await postWheelToHwnd(0x6n, { direction: "down", notch: 1 });
    // LOWORD = -960 & 0xFFFF, HIWORD = 540. Same u32-masked encoding as wParam.
    const expectedLParamNeg = BigInt(((540 << 16) | ((-960) & 0xffff)) | 0) & 0xffffffffn;
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      0x6n,
      WM_MOUSEWHEEL,
      expect.any(BigInt),
      expectedLParamNeg,
    );
  });

  it("win32PostMessage native binding missing → null (no throw)", async () => {
    nativeWin32Mock.win32PostMessage = undefined;
    const result = await postWheelToHwnd(0x7n, { direction: "down", notch: 1 });
    expect(result).toBeNull();
    expect(win32GetScrollInfoMock).not.toHaveBeenCalled();
  });

  it("win32PostMessage throws → null (graceful fall-through, no propagation)", async () => {
    win32PostMessageMock.mockImplementation(() => {
      throw new Error("native crash");
    });
    win32GetScrollInfoMock.mockReturnValue(scrollInfo(50));
    const result = await postWheelToHwnd(0x8n, { direction: "down", notch: 1 });
    expect(result).toBeNull();
  });

  it("win32GetScrollInfo native binding UNAVAILABLE → presumed delivered_via_postmessage (mixed-version regression guard, Codex P2-A)", async () => {
    // When the .node binary lacks the win32GetScrollInfo export (older build,
    // partial Phase 1 rollout), the dispatcher cannot distinguish "scrolled"
    // from "target_unreachable" via Win32 observation. Returning null would
    // make scrollHandler emit target_unreachable for every resolved scroll —
    // a regression vs the legacy Tier 4 fall-back behaviour. Instead the
    // dispatcher presumes delivered and lets the caller's own dHash + Win32
    // observation (`captureScrollSnapshot` in mouse.ts) catch a true no-op.
    nativeWin32Mock.win32GetScrollInfo = undefined;
    const result = await postWheelToHwnd(0x9n, { direction: "down", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalled();
  });

  it("large notch (>= 274) is chunked into multiple ≤ 16-bit signed messages — sign bit MUST NOT wrap (Codex P2-B)", async () => {
    // notch=300 × WHEEL_DELTA(120) = 36000 raw units, exceeding the 16-bit
    // signed maximum (0x7FFF = 32767). Without chunking, the single-message
    // path packs HIWORD = (36000 & 0xFFFF) = 0x8CA0 = -29728 (signed short),
    // which the receiver reads as "scroll UP by 29728" instead of "scroll DOWN
    // by 36000". Chunking emits two PostMessages: 32767 + 3233 = 36000, each
    // with a safely-in-range signed HIWORD.
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(200));
    const result = await postWheelToHwnd(0xAn, { direction: "down", notch: 300 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    // Expect 2 chunks for vertical down: -32767 (sign-flipped), -(36000-32767)=-3233.
    expect(win32PostMessageMock).toHaveBeenCalledTimes(2);
    const calls = win32PostMessageMock.mock.calls;
    // Each wParam HIWORD must be in signed 16-bit range and negative (vertical
    // down sign-flipped). Extract HIWORD via shift+mask, then sign-extend.
    for (const [, , wParam] of calls) {
      const hiword = Number((wParam >> 16n) & 0xffffn);
      const signed = hiword >= 0x8000 ? hiword - 0x10000 : hiword;
      expect(signed).toBeLessThan(0); // vertical down: scroll down = negative
      expect(signed).toBeGreaterThanOrEqual(-0x8000); // within signed 16-bit
      expect(signed).toBeLessThanOrEqual(0x7fff); // within signed 16-bit
    }
    // Total magnitude across chunks must equal requested 36000.
    const totalMag = calls.reduce((sum, [, , wParam]) => {
      const hiword = Number((wParam >> 16n) & 0xffffn);
      const signed = hiword >= 0x8000 ? hiword - 0x10000 : hiword;
      return sum + Math.abs(signed);
    }, 0);
    expect(totalMag).toBe(36000);
  });

  it("notch at the chunk boundary (notch=273 → magnitude=32760, single message) does NOT chunk", async () => {
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(200));
    await postWheelToHwnd(0xBn, { direction: "down", notch: 273 });
    expect(win32PostMessageMock).toHaveBeenCalledTimes(1);
  });

  it("notch=0 (zero magnitude) → null with NO PostMessage dispatched, even when getScrollInfo is unavailable (Opus Round 3 P2-1 regression guard)", async () => {
    // Without this guard, the post-Codex-fix mixed-version branch (Case 1
    // "API genuinely missing → presume delivered") would falsely claim
    // `delivered_via_postmessage` for a zero-magnitude call where no
    // PostMessage was ever dispatched (the chunking loop runs 0 times).
    nativeWin32Mock.win32GetScrollInfo = undefined;
    const result = await postWheelToHwnd(0xCn, { direction: "down", notch: 0 });
    expect(result).toBeNull();
    expect(win32PostMessageMock).not.toHaveBeenCalled();
  });
});

describe("ADR-018 Phase 5+N — postWheelToHwnd scroll-leaf walker (Excel / Word MDI retarget)", () => {
  // `WM_MOUSEWHEEL` propagates upward only (Microsoft Learn / DefWindowProc),
  // so MDI apps whose scroll surface is a deep child (Excel:
  // XLMAIN→XLDESK→EXCEL7; Word: OpusApp→_WwF→_WwG) need the POST retargeted
  // to the leaf. The leaf walker (`win32FindScrollLeafForTopLevel`) returns
  // the leaf HWND when the top-level class is in the chain table, or `null`
  // for non-MDI apps. These tests pin the four contract points:
  //   1. Leaf returned → postMessage / getScrollInfo / L1 push all use the leaf
  //   2. Leaf null → bit-equal to pre-PR behaviour (top-level HWND used)
  //   3. Native binding undefined (mixed-version `.node`) → graceful fall-through
  //   4. Leaf's window rect differs from top → lParam centres on the leaf,
  //      NOT the top-level (some Excel versions reject lParam outside the
  //      recipient's client area — web research 2026-05-15)

  beforeEach(() => {
    win32PostMessageMock.mockReset();
    win32GetScrollInfoMock.mockReset();
    getWindowRectByHwndMock.mockReset();
    win32FindScrollLeafForTopLevelMock.mockReset();
    // ADR-019 MVP-1 (Stage 1) — reset UIA percent mock; default impl returns
    // null (no pattern exposed) so the chain-trust fall-through is the
    // baseline observation. Tests that exercise the UIA observation path
    // override per-call (`mockResolvedValueOnce`).
    uiaReadScrollPercentAtHwndMock.mockReset();
    uiaReadScrollPercentAtHwndMock.mockImplementation(async () => null);
    nativeWin32Mock.win32PostMessage = win32PostMessageMock;
    nativeWin32Mock.win32GetScrollInfo = win32GetScrollInfoMock;
    nativeWin32Mock.win32FindScrollLeafForTopLevel =
      win32FindScrollLeafForTopLevelMock;
    nativeUiaMock.uiaReadScrollPercentAtHwnd = uiaReadScrollPercentAtHwndMock;
    win32PostMessageMock.mockReturnValue(true);
  });

  const scrollInfo = (nPos: number) => ({
    nMin: 0,
    nMax: 1000,
    nPage: 100,
    nPos,
    pageRatio: nPos / 1000,
  });

  it("leaf returned → postMessage + getScrollInfo + L1 push all target the leaf HWND, NOT the input top-level", async () => {
    const TOP = 0xACE5n; // fake "XLMAIN" top-level
    const LEAF = 0xCE117n; // fake "EXCEL7" cell grid leaf (cell≈CE11 mnemonic)
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    // Leaf has a different rect from top-level — used to verify lParam.
    getWindowRectByHwndMock.mockImplementation((h: bigint) =>
      h === LEAF
        ? { x: 0, y: 100, width: 400, height: 300 } // leaf center (200, 250)
        : { x: 1000, y: 1000, width: 800, height: 600 }, // top-level center elsewhere
    );
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    // All native calls target the leaf, not the top-level.
    expect(win32FindScrollLeafForTopLevelMock).toHaveBeenCalledWith(TOP);
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      LEAF,
      expect.any(Number),
      expect.any(BigInt),
      expect.any(BigInt),
    );
    expect(win32PostMessageMock).not.toHaveBeenCalledWith(
      TOP,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(win32GetScrollInfoMock).toHaveBeenCalledWith(LEAF, "vertical");
    expect(win32GetScrollInfoMock).not.toHaveBeenCalledWith(TOP, "vertical");
  });

  it("leaf null (non-MDI app) → bit-equal pre-PR behaviour (top-level HWND used everywhere)", async () => {
    const TOP = 0xDEF0n; // fake non-MDI top-level
    win32FindScrollLeafForTopLevelMock.mockReturnValue(null);
    getWindowRectByHwndMock.mockReturnValue({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    });
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    // Walker consulted exactly once, then bypassed (null).
    expect(win32FindScrollLeafForTopLevelMock).toHaveBeenCalledWith(TOP);
    // postMessage targets the input top-level HWND.
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      TOP,
      expect.any(Number),
      expect.any(BigInt),
      expect.any(BigInt),
    );
    expect(win32GetScrollInfoMock).toHaveBeenCalledWith(TOP, "vertical");
  });

  it("native binding undefined (mixed-version older `.node`) → graceful fall-through, top-level HWND used", async () => {
    const TOP = 0xABCDn;
    // Simulate the older binary that lacks the walker export entirely.
    nativeWin32Mock.win32FindScrollLeafForTopLevel = undefined;
    getWindowRectByHwndMock.mockReturnValue({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    });
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32FindScrollLeafForTopLevelMock).not.toHaveBeenCalled();
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      TOP,
      expect.any(Number),
      expect.any(BigInt),
      expect.any(BigInt),
    );
  });

  it("leaf with different rect → lParam centres on LEAF's rect, not top-level's (some Excel versions reject lParam outside recipient's client area)", async () => {
    const TOP = 0xFFEEn;
    const LEAF = 0x7777n;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    // Leaf rect: (10, 20, 200, 100) → screen center (110, 70). Top-level rect
    // is intentionally placed far away — if the impl regressed to using the
    // top-level rect, lParam would carry a centre of (1500, 1500).
    getWindowRectByHwndMock.mockImplementation((h: bigint) =>
      h === LEAF
        ? { x: 10, y: 20, width: 200, height: 100 }
        : { x: 1000, y: 1000, width: 1000, height: 1000 },
    );
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(0))
      .mockReturnValueOnce(scrollInfo(5));
    await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    // Expected lParam = MAKELPARAM(110, 70) = (70 << 16) | 110 = 0x0046006En
    const expectedLeafLParam = BigInt((70 << 16) | 110);
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      LEAF,
      expect.any(Number),
      expect.any(BigInt),
      expectedLeafLParam,
    );
  });

  it("leaf retargeted AND getScrollInfo(leaf, axis) returns null AND UIA pattern not exposed → trust the chain table, emit delivered_via_postmessage with observation.source 'chain_trust_unverified' (Case 2a, dogfood 2026-05-16; ADR-019 MVP-1)", async () => {
    // Excel EXCEL7 (and similar MDI scroll-leaves) use custom-painted
    // scrollbars (`NUIScrollbar` etc.) that GetScrollInfo(SB_VERT) cannot
    // observe — `pre === null` here is the "no SB_VERT" signal, NOT the
    // "wheel was rejected" signal. The chain-table assertion (leaf is a
    // documented scroll receiver) means we trust PostMessage success.
    // **ADR-019 MVP-1 (Stage 1) addendum**: the dispatcher now also tries
    // `uiaReadScrollPercentAtHwnd` for pre/post percent observation. When
    // that returns null (UIA pattern not exposed on the leaf — the test
    // here doesn't mock the napi), the chain-trust assertion fall-through
    // emits `observation.source: "chain_trust_unverified"`, signalling to
    // the LLM caller that the delivery is unverified at the observation
    // layer (honest signal — Codex PR #308 P1 trade-off).
    const TOP = 0xACE5n; // fake XLMAIN
    const LEAF = 0xCE117n; // fake EXCEL7
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    getWindowRectByHwndMock.mockReturnValue({
      x: 53,
      y: 240,
      width: 1424,
      height: 598,
    });
    // EXCEL7 has no SB_VERT → GetScrollInfo returns null for both pre and post.
    win32GetScrollInfoMock.mockReturnValue(null);
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    // Chain-table trust: PostMessage succeeded to a documented scroll
    // receiver → delivered, even though observation channel returned null.
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
      observation: {
        motion: "indeterminate",
        source: "chain_trust_unverified",
        framesSampled: 0,
        totalElapsedMs: 0,
      },
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      LEAF,
      expect.any(Number),
      expect.any(BigInt),
      expect.any(BigInt),
    );
  });

  it("ADR-019 MVP-1 (Stage 1) — leaf retargeted AND UIA pattern exposed AND percent moved → observation.source 'uia_scroll_percent', motion 'translation'", async () => {
    const TOP = 0xACE5n;
    const LEAF = 0xCE117n;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    getWindowRectByHwndMock.mockReturnValue({
      x: 53,
      y: 240,
      width: 1424,
      height: 598,
    });
    win32GetScrollInfoMock.mockReturnValue(null);
    // UIA pre/post percent differ — observation upgrade fires.
    uiaReadScrollPercentAtHwndMock
      .mockResolvedValueOnce(10.0) // pre
      .mockResolvedValueOnce(15.0); // post (post - pre = 5.0 ≥ epsilon)
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    // totalElapsedMs is `performance.now()` delta — non-deterministic;
    // match the rest of the shape exactly and assert the field is a
    // finite non-negative number separately (Opus PR #309 Round 1 P2-2:
    // emit real wallclock instead of the misleading `0` placeholder).
    expect(result).toMatchObject({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
      observation: {
        motion: "translation",
        source: "uia_scroll_percent",
        framesSampled: 2,
        totalElapsedMs: expect.any(Number),
      },
    });
    expect(result?.observation?.totalElapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result?.observation?.totalElapsedMs ?? NaN)).toBe(true);
    expect(uiaReadScrollPercentAtHwndMock).toHaveBeenCalledTimes(2);
  });

  it("ADR-019 MVP-1 (Stage 1) — leaf retargeted AND UIA pattern exposed AND percent unchanged (boundary / no-op) → observation.source 'uia_scroll_percent', motion 'no_change' (honest signal, Codex PR #308 P1 trade-off)", async () => {
    const TOP = 0xACE5n;
    const LEAF = 0xCE117n;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    getWindowRectByHwndMock.mockReturnValue({
      x: 53,
      y: 240,
      width: 1424,
      height: 598,
    });
    win32GetScrollInfoMock.mockReturnValue(null);
    // UIA pre/post percent IDENTICAL — receiver at boundary or non-scrollable.
    // The dispatcher still emits delivered_via_postmessage (chain-trust trusts
    // the queue), but the observation field carries motion='no_change' so the
    // LLM caller can disambiguate "actually moved" vs "reached but no-op."
    uiaReadScrollPercentAtHwndMock
      .mockResolvedValueOnce(0.0)
      .mockResolvedValueOnce(0.0);
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    // totalElapsedMs is `performance.now()` delta — non-deterministic;
    // see the translation test above for the rationale (Opus P2-2).
    expect(result).toMatchObject({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
      observation: {
        motion: "no_change",
        source: "uia_scroll_percent",
        framesSampled: 2,
        totalElapsedMs: expect.any(Number),
      },
    });
    expect(result?.observation?.totalElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("ADR-019 MVP-1 (Stage 1) — pre-snapshot UIA read REJECTS (slow / hung provider, native crash) → chain_trust_unverified (Codex Round 1 P2 `.catch` shim regression guard)", async () => {
    // The fire-and-forget `preUiaPromise` in `postWheelToHwnd` wraps the
    // pre-read in `.catch(() => null)` so a rejection does not propagate
    // through the dispatch path. Without this, a slow / hung UIA provider
    // would unhandled-reject inside the chain-trust branch and break the
    // delivered_via_postmessage contract silently. This test locks the
    // shim in place — a future refactor that drops the `.catch` will fail
    // this assertion before the contract regresses.
    const TOP = 0xACE5n;
    const LEAF = 0xCE117n;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    getWindowRectByHwndMock.mockReturnValue({
      x: 53,
      y: 240,
      width: 1424,
      height: 598,
    });
    win32GetScrollInfoMock.mockReturnValue(null);
    uiaReadScrollPercentAtHwndMock.mockRejectedValueOnce(
      new Error("simulated UIA provider crash"),
    );
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    expect(result).toMatchObject({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
      observation: {
        motion: "indeterminate",
        source: "chain_trust_unverified",
        framesSampled: 0,
        totalElapsedMs: 0,
      },
    });
  });

  it("NOT retargeted AND getScrollInfo returns null (input HWND is not in the chain table) → return null (Case 2b — caller emits target_unreachable)", async () => {
    const TOP = 0xBEEFn;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(null); // no retarget
    getWindowRectByHwndMock.mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    win32GetScrollInfoMock.mockReturnValue(null);
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    // Without retarget we have no trust signal — emit null so the caller
    // surfaces target_unreachable per ADR §2.6.2 path-(b).
    expect(result).toBeNull();
  });

  it("leaf walker throws → graceful fall-through, top-level HWND used", async () => {
    const TOP = 0xDEAD_BEEFn;
    win32FindScrollLeafForTopLevelMock.mockImplementation(() => {
      throw new Error("native crash");
    });
    getWindowRectByHwndMock.mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(0))
      .mockReturnValueOnce(scrollInfo(50));
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    // Throw must NOT propagate; top-level POST proceeds.
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalledWith(
      TOP,
      expect.any(Number),
      expect.any(BigInt),
      expect.any(BigInt),
    );
  });
});

describe("ADR-018 Phase 4 — dispatchScrollWheel (Tier 1 UIA → Tier 3 PostMessage fall-through)", () => {
  beforeEach(() => {
    uiaScrollByWheelAtHwndMock.mockReset();
    win32PostMessageMock.mockReset();
    win32GetScrollInfoMock.mockReset();
    getWindowRectByHwndMock.mockReset();
    nativeUiaMock.uiaScrollByWheelAtHwnd = uiaScrollByWheelAtHwndMock;
    nativeWin32Mock.win32PostMessage = win32PostMessageMock;
    nativeWin32Mock.win32GetScrollInfo = win32GetScrollInfoMock;
    win32PostMessageMock.mockReturnValue(true);
    getWindowRectByHwndMock.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
  });

  const scrollInfo = (nPos: number) => ({
    nMin: 0,
    nMax: 1000,
    nPage: 100,
    nPos,
    pageRatio: nPos / 1000,
  });

  it("Tier 1 UIA returns ok:false → dispatcher tries Tier 3 PostMessage; Tier 3 delivers → {channel:'postmessage', reason:'delivered_via_postmessage'}", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: false, scrolled: false });
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x100n },
      { direction: "down", notch: 1 },
    );
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenCalled();
    expect(win32PostMessageMock).toHaveBeenCalled();
  });

  it("Tier 1 UIA returns scrolled:false (already at boundary) → dispatcher tries Tier 3; Tier 3 also exhausts → null (caller emits target_unreachable)", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: true, scrolled: false });
    win32GetScrollInfoMock.mockReturnValue(null); // Word _WwG case
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x200n },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
    expect(uiaScrollByWheelAtHwndMock).toHaveBeenCalled();
    expect(win32PostMessageMock).toHaveBeenCalled();
  });

  it("Tier 1 UIA succeeds → Tier 3 PostMessage is NOT invoked (short-circuit on success)", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: true, scrolled: true });
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x300n },
      { direction: "down", notch: 1 },
    );
    expect(result).toEqual({
      scrolled: true,
      channel: "uia",
      reason: "delivered_via_uia",
    });
    expect(win32PostMessageMock).not.toHaveBeenCalled();
  });

  it("Tier 1 UIA throws → dispatcher still tries Tier 3 (graceful Tier 1 fall-through preserved)", async () => {
    uiaScrollByWheelAtHwndMock.mockRejectedValue(new Error("UIA crash"));
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    const result = await dispatchScrollWheel(
      { kind: "hwnd", hwnd: 0x400n },
      { direction: "down", notch: 1 },
    );
    expect(result).toEqual({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    expect(win32PostMessageMock).toHaveBeenCalled();
  });

  it("kind='unresolved' → null (Tier 4 SendInput is caller's responsibility; Tier 3 NOT invoked because dest has no HWND)", async () => {
    const result = await dispatchScrollWheel(
      { kind: "unresolved", reason: "no_target_window" },
      { direction: "down", notch: 1 },
    );
    expect(result).toBeNull();
    expect(uiaScrollByWheelAtHwndMock).not.toHaveBeenCalled();
    expect(win32PostMessageMock).not.toHaveBeenCalled();
  });
});
