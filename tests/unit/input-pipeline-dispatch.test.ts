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
// ADR-018 Phase 6: structural hit-test fallback, tried only after a class-table
// miss. Default impl returns `null` (no retarget) so every pre-Phase-6 test
// stays bit-equal. Without this mock entry the `typeof` guard in
// `postWheelToHwnd` skips the branch entirely and the new path is never
// exercised — the Phase 6 tests below would pass against an implementation
// that sets the chain-trust flag, which is the exact defect Round 1 found.
const win32FindWheelLeafByHittestMock = vi.fn<[bigint], bigint | null>(() => null);
// ADR-018 Phase 6: parent walk for the observation chain. Default impl returns
// null (walk cannot proceed), which degrades to watching the two endpoints —
// the behaviour every pre-parent-walk test expects.
const win32GetAncestorMock = vi.fn<[bigint, number], bigint | null>(() => null);
const nativeWin32Mock: {
  win32PostMessage?: unknown;
  win32GetScrollInfo?: unknown;
  win32FindScrollLeafForTopLevel?: unknown;
  win32FindWheelLeafByHittest?: unknown;
  win32GetAncestor?: unknown;
} = {
  win32PostMessage: win32PostMessageMock,
  win32GetScrollInfo: win32GetScrollInfoMock,
  win32FindScrollLeafForTopLevel: win32FindScrollLeafForTopLevelMock,
  win32FindWheelLeafByHittest: win32FindWheelLeafByHittestMock,
  win32GetAncestor: win32GetAncestorMock,
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
//
// ADR-035 Phase 1: the dispatcher now calls the ARRAY-returning
// `findPlainTopLevelWindowsByTitle` — it needs the match count a second time,
// for the "N windows match" advisory. The singular helper is still exported
// (and still what other call sites use), so both are stubbed here. Every
// behavioural assertion below is unchanged; only the stub the dispatcher
// reaches for moved.
// ADR-035 Phase 1: the tier events are asserted below, so the log is captured
// here and re-enabled (the unit setup disables it process-wide so no test writes
// to the developer's real diagnostic log).
const mockLogDiagnostic = vi.fn();
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return {
    ...actual,
    logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])),
    isDiagnosticLogEnabled: () => true,
  };
});

const resolveWindowTargetMock = vi.fn();
const findPlainTopLevelWindowByTitleMock = vi.fn();
const findPlainTopLevelWindowsByTitleMock = vi.fn();
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: resolveWindowTargetMock,
  findPlainTopLevelWindowByTitle: findPlainTopLevelWindowByTitleMock,
  findPlainTopLevelWindowsByTitle: findPlainTopLevelWindowsByTitleMock,
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
// `getForegroundHwnd` / `getWindowTitleW` / `getWindowIdentity` are reached by
// the ADR-035 Phase 1 dispatch-sink observer, which runs on every tier dispatch.
// Stubbed to fixed values — the observer is write-only, so nothing below
// depends on what they return.
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: enumWindowsInZOrderMock,
  getWindowRectByHwnd: getWindowRectByHwndMock,
  getForegroundHwnd: () => null,
  getWindowTitleW: () => "",
  getWindowIdentity: () => ({ pid: 0, processName: "", processStartTimeMs: 0 }),
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
    findPlainTopLevelWindowsByTitleMock.mockReset();
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([]);
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
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([{
      hwnd: 0x111n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false,
    }]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x111n });
    // Phase 5 contract: helper called with both flags TRUE (strict dispatcher
    // predicate per sub-plan §2.1#2 table).
    expect(findPlainTopLevelWindowsByTitleMock).toHaveBeenCalledWith("Notepad", {
      excludeMinimized: true,
      excludeDialogsAndOwned: true,
      logAs: "inputPipelineCase3",
    });
  });

  it("Case 3 recovery matches case-insensitively on a title substring (helper-internal contract)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([{
      hwnd: 0x333n, title: "メモ帳", className: "Notepad", ownerHwnd: null, isMinimized: false,
    }]);
    const dest = await resolveInputDestination({ windowTitle: "メモ帳" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x333n });
  });

  it("Case 3 recovery EXCLUDES #32770 dialogs and owned windows — flag excludeDialogsAndOwned: true (Codex PR #288 Round 3 P2)", async () => {
    // The dispatcher calls the helper with excludeDialogsAndOwned:true; the
    // per-flag predicate behavior is pinned by find-plain-top-level-window.test.ts.
    // Here we only verify the dispatcher passes the correct flag combination.
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([{
      hwnd: 0x503n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false,
    }]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x503n });
    expect(findPlainTopLevelWindowsByTitleMock).toHaveBeenCalledWith("Notepad",
      expect.objectContaining({ excludeDialogsAndOwned: true }));
  });

  it("Case 3 recovery EXCLUDES minimized windows — flag excludeMinimized: true (Codex PR #288 Round 4 P1)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([{
      hwnd: 0x702n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false,
    }]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x702n });
    expect(findPlainTopLevelWindowsByTitleMock).toHaveBeenCalledWith("Notepad",
      expect.objectContaining({ excludeMinimized: true }));
  });

  it("returns {kind:'unresolved'} when helper returns null (no recoverable top-level)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
  });

  it("returns {kind:'unresolved'} when neither hwnd nor windowTitle is given (helper not called)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({});
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
    expect(findPlainTopLevelWindowsByTitleMock).not.toHaveBeenCalled();
  });

  // ── ADR-035 §6.3 — the Case 3 multi-match advisory ────────────────────────
  //
  // Phase 1 is observation + warning only: the destination is still the
  // frontmost match. What these pin is that the caller is TOLD when the title
  // was ambiguous, in the same wording `action-target.ts` already uses, and
  // that a single match stays silent (an advisory on every scroll would be
  // noise, and the LLM would learn to ignore it).
  it("Case 3 with 2+ matches appends a non-blocking 'N windows match' advisory", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([
      { hwnd: 0x901n, title: "notes - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 0x902n, title: "todo - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const warnings: string[] = [];
    const dest = await resolveInputDestination({ windowTitle: "Notepad" }, warnings);
    // Destination is UNCHANGED — frontmost wins, exactly as before.
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x901n });
    expect(warnings).toEqual(['2 windows match "Notepad"; using the frontmost']);
  });

  it("Case 3 with a single match warns about nothing", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([
      { hwnd: 0x903n, title: "notes - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const warnings: string[] = [];
    await resolveInputDestination({ windowTitle: "Notepad" }, warnings);
    expect(warnings).toEqual([]);
  });

  it("works without a collector — the advisory is additive, never required", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([
      { hwnd: 0x904n, title: "a - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 0x905n, title: "b - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const dest = await resolveInputDestination({ windowTitle: "Notepad" });
    expect(dest).toEqual({ kind: "hwnd", hwnd: 0x904n });
  });

  it("does not attempt helper lookup for windowTitle '@active' (resolveWindowTarget owns @active)", async () => {
    resolveWindowTargetMock.mockResolvedValue(null);
    const dest = await resolveInputDestination({ windowTitle: "@active" });
    expect(dest).toEqual({ kind: "unresolved", reason: "no_target_window" });
    expect(findPlainTopLevelWindowsByTitleMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-035 Phase 1 — a tier event means that tier performed a write
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — scroll tier dispatch events", () => {
  function sinks(): Array<Record<string, any>> {
    return mockLogDiagnostic.mock.calls
      .map((c) => c[0] as Record<string, any>)
      .filter((e) => e.kind === "dispatch_sink");
  }

  beforeEach(() => {
    mockLogDiagnostic.mockClear();
    uiaScrollByWheelAtHwndMock.mockReset();
    win32PostMessageMock.mockReset();
    win32GetScrollInfoMock.mockReset();
  });

  it("Tier 1 that never reaches SetScrollPercent records NO uia event", async () => {
    // `ok:false` is the native side saying it found no usable ScrollPattern and
    // returned before writing. The caller then falls through to Tier 3, so an
    // event here would put two dispatches in the log for one write
    // (Codex Round 2).
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: false, scrolled: false });
    win32PostMessageMock.mockReturnValue(false);
    await dispatchScrollWheel({ kind: "hwnd", hwnd: 0x1n }, { direction: "down", notch: 1 });
    expect(sinks().filter((e) => e.sink === "uia")).toHaveLength(0);
  });

  it("Tier 1 that reaches it records one uia event, boundary no-op included", async () => {
    // `ok:true, scrolled:false` DID call SetScrollPercent — a page-boundary
    // no-op is still a dispatch.
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: true, scrolled: false });
    win32PostMessageMock.mockReturnValue(false);
    await dispatchScrollWheel({ kind: "hwnd", hwnd: 0x1n }, { direction: "down", notch: 1 });
    expect(sinks().filter((e) => e.sink === "uia")).toHaveLength(1);
    expect(sinks().find((e) => e.sink === "uia")).toMatchObject({ tier: "1", targetHwnd: "1" });
  });

  it("Tier 3 records nothing when the native PostMessage binding is absent", async () => {
    uiaScrollByWheelAtHwndMock.mockResolvedValue({ ok: false, scrolled: false });
    win32PostMessageMock.mockReturnValue(false);
    await dispatchScrollWheel({ kind: "hwnd", hwnd: 0x1n }, { direction: "down", notch: 1 });
    // The stub returns false on the first post, so the loop breaks with nothing
    // delivered — but the message WAS handed to the OS, which is what the event
    // records. What must not appear is a second one.
    expect(sinks().filter((e) => e.sink === "postmessage").length).toBeLessThanOrEqual(1);
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
    findPlainTopLevelWindowsByTitleMock.mockReset();
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([]);
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
    findPlainTopLevelWindowsByTitleMock.mockReturnValue([{
      hwnd: 0xBBBn, title: "Google Chrome", className: "Chrome_WidgetWin_1", ownerHwnd: null, isMinimized: false,
    }]);
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
    win32FindWheelLeafByHittestMock.mockReset();
    win32FindWheelLeafByHittestMock.mockReturnValue(null);
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
    nativeWin32Mock.win32FindWheelLeafByHittest = win32FindWheelLeafByHittestMock;
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

  it("ADR-019 MVP-1 (Stage 1) — pre-snapshot UIA read EXCEEDS UIA_PRE_READ_TIMEOUT_MS (slow / hung provider) → chain_trust_unverified (Codex Round 1 P2 + Round 2 P2 — bounded await, dispatch not stalled, pre value not stale)", async () => {
    // The pre-snapshot UIA read is raced against UIA_PRE_READ_TIMEOUT_MS
    // (100 ms). When the read hangs longer than that, the dispatcher
    // treats it as a null pre-sample and falls back to chain-trust. This
    // test simulates a provider that never resolves; the Promise.race
    // timeout wins, dispatch proceeds, and observation lands as
    // chain_trust_unverified.
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
    // Pre-read hangs (never resolves) — the race timer fires at 100 ms.
    uiaReadScrollPercentAtHwndMock.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const tStart = performance.now();
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    const elapsed = performance.now() - tStart;
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
    // Wall-clock bound: <= UIA_PRE_READ_TIMEOUT_MS (100 ms) + chunking +
    // settle + observer ms + scheduling jitter. 500 ms is a generous
    // upper bound that still catches a regression where the timeout
    // wasn't wired (which would block until the 8 s Rust thread timeout).
    expect(elapsed).toBeLessThan(500);
  });

  it("ADR-019 MVP-1 (Stage 1) — Case 3 (getScrollInfo returns non-null Win32 scrollbar info) → UIA pre-read is NOT issued (Codex Round 4 P2 — skip UIA when Win32 scroll info is available, avoid up-to-100ms latency for unused value)", async () => {
    // When `getScrollInfo` returns a valid pre-snapshot, the dispatcher
    // takes the standard Tier 3 path (Case 3) and never consumes a UIA
    // percent value. Issuing the UIA RPC anyway would only pay the
    // 100 ms timeout ceiling for nothing AND load the native UIA worker
    // queue unnecessarily. The gate at the pre-read site
    // (`pre === null && retargetedByLeafWalker && getScrollInfoAvailable`)
    // skips the RPC for Case 1 / Case 3 — this test pins that gate.
    const TOP = 0xACE5n;
    const LEAF = 0xCE117n;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(LEAF);
    getWindowRectByHwndMock.mockReturnValue({
      x: 53,
      y: 240,
      width: 1424,
      height: 598,
    });
    // Case 3: Win32 scrollbar present, pre/post differ → standard Tier 3.
    win32GetScrollInfoMock
      .mockReturnValueOnce(scrollInfo(50))
      .mockReturnValueOnce(scrollInfo(80));
    // Mock UIA so we can assert it was NOT called.
    uiaReadScrollPercentAtHwndMock.mockResolvedValue(42.0);
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    expect(result).toMatchObject({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    });
    // Case 3 path: NO observation field attached (TMOL chain-trust
    // observation is Case 2a only).
    expect((result as { observation?: unknown }).observation).toBeUndefined();
    // The UIA pre-read MUST NOT have been issued.
    expect(uiaReadScrollPercentAtHwndMock).not.toHaveBeenCalled();
  });

  it("ADR-019 MVP-1 (Stage 1) — post-snapshot UIA read EXCEEDS UIA_POST_READ_TIMEOUT_MS (slow / hung provider after dispatch) → chain_trust_unverified (Codex Round 3 P2 — post-read symmetrical bounded await)", async () => {
    // Mirrors the pre-read timeout test, applied to the post-snapshot
    // path inside `observeViaUiaOrChainTrust`. Pre-read resolves cleanly
    // (so the dispatcher enters the chain-trust branch with a valid
    // pre-percent), but the post-read hangs indefinitely. The internal
    // 100 ms Promise.race fires; the helper treats post as null and
    // returns chain_trust_unverified. Wall-clock < 500 ms regression
    // guard against the timeout being silently un-wired.
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
    uiaReadScrollPercentAtHwndMock
      // pre resolves immediately
      .mockResolvedValueOnce(10.0)
      // post hangs forever
      .mockImplementationOnce(() => new Promise(() => {}));
    const tStart = performance.now();
    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });
    const elapsed = performance.now() - tStart;
    expect(result).toMatchObject({
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
      observation: {
        motion: "indeterminate",
        source: "chain_trust_unverified",
      },
    });
    expect(elapsed).toBeLessThan(500);
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-018 Phase 6 §2.2 — structural hit-test retarget (WebView hosts)
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-018 Phase 6 — postWheelToHwnd hit-test retarget (Tauri / Electron / CEF)", () => {
  // The class-chain table only covers shapes we have already hit. WebView hosts
  // put the wheel receiver several levels down and across a process boundary,
  // so a structural descent resolves it instead. Two contract points matter,
  // and both were defects caught in review rather than hypotheticals:
  //
  //   1. A hit-test result must NOT be treated as chain-trust. That flag means
  //      "the post target is a documented scroll leaf, so a queued post counts
  //      as delivered without reading a scrollbar". A structural guess carries
  //      no such guarantee: letting it assert delivery would have made every
  //      child-hosted window claim success with nothing observed.
  //   2. Observation must not blindly follow the retarget. WM_MOUSEWHEEL
  //      propagates UP, so the scrollbar that moves may belong to the window we
  //      were asked to scroll, not to the leaf.

  beforeEach(() => {
    win32PostMessageMock.mockReset();
    win32GetScrollInfoMock.mockReset();
    getWindowRectByHwndMock.mockReset();
    win32FindScrollLeafForTopLevelMock.mockReset();
    win32FindScrollLeafForTopLevelMock.mockReturnValue(null); // class-table miss
    win32FindWheelLeafByHittestMock.mockReset();
    win32GetAncestorMock.mockReset();
    win32GetAncestorMock.mockReturnValue(null);
    uiaReadScrollPercentAtHwndMock.mockReset();
    uiaReadScrollPercentAtHwndMock.mockImplementation(async () => null);
    nativeWin32Mock.win32PostMessage = win32PostMessageMock;
    nativeWin32Mock.win32GetScrollInfo = win32GetScrollInfoMock;
    nativeWin32Mock.win32FindScrollLeafForTopLevel =
      win32FindScrollLeafForTopLevelMock;
    nativeWin32Mock.win32FindWheelLeafByHittest = win32FindWheelLeafByHittestMock;
    nativeWin32Mock.win32GetAncestor = win32GetAncestorMock;
    nativeUiaMock.uiaReadScrollPercentAtHwnd = uiaReadScrollPercentAtHwndMock;
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

  const TOP = 0xB00Bn;  // fake "Tauri Window"
  const LEAF = 0xC0DEn; // fake "Chrome_WidgetWin_1"

  it("hit-test leaf receives the post, but a scrollbar-less leaf does NOT assert delivery", async () => {
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    // Neither window exposes a Win32 scrollbar — the WebView case.
    win32GetScrollInfoMock.mockReturnValue(null);

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    // The post goes to the leaf: that is the whole point of the retarget.
    expect(win32PostMessageMock).toHaveBeenCalled();
    expect(win32PostMessageMock.mock.calls[0]![0]).toBe(LEAF);
    // But with no observation behind it, the dispatcher must return null so the
    // caller falls through to its own evidence (the Phase 6 pixel comparison)
    // instead of claiming `delivered_via_postmessage` on chain-trust.
    expect(result).toBeNull();
  });

  it("a class-table miss followed by a hit-test miss leaves the top-level HWND as the target", async () => {
    win32FindWheelLeafByHittestMock.mockReturnValue(null);
    win32GetScrollInfoMock.mockImplementation(() => scrollInfo(0));

    await postWheelToHwnd(TOP, { direction: "down", notch: 1 });

    expect(win32PostMessageMock.mock.calls[0]![0]).toBe(TOP);
  });

  it("observation falls back to the input HWND when the hit-test leaf exposes no scrollbar", async () => {
    // The regression this pins: a window that owns a Win32 scrollbar and has a
    // visible child over its centre. The wheel is posted to the child, bubbles
    // up, and the TOP-LEVEL scroll position moves. Reading only the leaf would
    // see null and report the scroll as undelivered — a working scroll turned
    // into a hard error by the caller.
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    let posted = false;
    win32PostMessageMock.mockImplementation(() => {
      posted = true;
      return true;
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return null;            // the child has no scrollbar
      return scrollInfo(posted ? 400 : 100);  // the top-level's position moves
    });

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    expect(win32PostMessageMock.mock.calls[0]![0]).toBe(LEAF);
    expect(result).not.toBeNull();
    expect(result!.scrolled).toBe(true);
    expect(result!.reason).toBe("delivered_via_postmessage");
  });

  it("motion on the input HWND counts even when the leaf owns a scrollbar of its own", async () => {
    // The shape a one-directional fallback misses: the leaf carries a vestigial
    // WS_VSCROLL, so reading it succeeds and a "prefer the leaf, fall back on
    // null" rule never looks further — while the ancestor is what actually
    // scrolls. Watching only the leaf reports a working scroll as undelivered.
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    let posted = false;
    win32PostMessageMock.mockImplementation(() => {
      posted = true;
      return true;
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return scrollInfo(50); // readable, but never moves
      return scrollInfo(posted ? 700 : 100); // the ancestor is what scrolls
    });

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    expect(result).not.toBeNull();
    expect(result!.scrolled).toBe(true);
  });

  it("both ends of the chain are read before the dispatch, in order", async () => {
    // Guards against a future edit that reads `post` from the dispatch target
    // while `pre` came from somewhere else: the delta would then be computed
    // across two different windows and could report either way at random.
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    // The leaf scrolls, so observation succeeds on the first pass and the
    // retry path stays out of the call sequence being asserted here.
    let posted = false;
    win32PostMessageMock.mockImplementation(() => {
      posted = true;
      return true;
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return scrollInfo(posted ? 400 : 100);
      return scrollInfo(100);
    });

    await postWheelToHwnd(TOP, { direction: "down", notch: 1 });

    const reads = win32GetScrollInfoMock.mock.calls
      .filter((c) => c[1] === "vertical")
      .map((c) => c[0]);
    // Both ends of the propagation chain are read before the dispatch, in
    // order. That each candidate's post is read from ITS OWN hwnd is pinned by
    // the two tests above, which only pass when the delta is computed per
    // window (a static leaf plus a moving ancestor, and the reverse); this one
    // pins the chain composition and ordering, which those cannot see.
    // (`some` short-circuits on the leaf here, so one post-read follows.)
    expect(reads.slice(0, 2)).toEqual([LEAF, TOP]);
    expect(reads[2]).toBe(LEAF);
  });

  it("a child that swallows the wheel gets a retry at the window the caller named", async () => {
    // Upward propagation is what makes posting to a descendant safe, and it
    // only holds when that descendant defers to DefWindowProc. A child that
    // consumes WM_MOUSEWHEEL without scrolling and without forwarding breaks
    // it, and the top-level handler that used to do the scrolling never sees
    // the wheel — a regression against the pre-hit-test behaviour.
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    let postedToTop = false;
    win32PostMessageMock.mockImplementation((h: bigint) => {
      if (h === TOP) postedToTop = true;
      return true; // the child accepts the message and silently eats it
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return scrollInfo(50); // never moves
      return scrollInfo(postedToTop ? 600 : 100); // only the retry scrolls it
    });

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    expect(win32PostMessageMock.mock.calls[0]![0]).toBe(LEAF);
    expect(postedToTop).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.scrolled).toBe(true);
  });

  it("no retry when nothing is observable — an unmeasurable host must not be scrolled twice", async () => {
    // The WebView case this retarget exists for: the leaf really is the
    // receiver and no scrollbar can be read anywhere. "No motion seen" is then
    // indistinguishable from "motion we cannot measure", so a retry would
    // scroll such a host a second time. It stays single-shot and the caller
    // falls back to its own pixel evidence.
    //
    // This case is caught twice over: the unobservable-`pre` branch returns
    // before the retry is reached, and the retry's own gate requires the retry
    // target to be readable. The test pins the user-visible invariant — an
    // unmeasurable host is posted to exactly once — rather than either line.
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    win32GetScrollInfoMock.mockReturnValue(null);

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    const targets = win32PostMessageMock.mock.calls.map((c) => c[0]);
    expect(targets.every((t) => t === LEAF)).toBe(true);
    expect(result).toBeNull();
  });

  it("no retry when the hit-test leaf did scroll", async () => {
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    let posted = false;
    win32PostMessageMock.mockImplementation(() => {
      posted = true;
      return true;
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return scrollInfo(posted ? 500 : 100);
      return scrollInfo(100);
    });

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    const targets = win32PostMessageMock.mock.calls.map((c) => c[0]);
    expect(targets.every((t) => t === LEAF)).toBe(true);
    expect(result!.scrolled).toBe(true);
  });

  it("an intermediate ancestor that owns the scrollbar is watched, not just the two ends", async () => {
    // Post target and caller-named window are only the ends of the chain. A
    // scrollable container in the middle — a panel between a WebView host and
    // its render widget — is where the scroll position can actually live, and
    // watching only the endpoints reports that scroll as undelivered.
    const MIDDLE = 0xA11Dn; // a scrollable container between LEAF and TOP
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    win32GetAncestorMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return MIDDLE;
      if (h === MIDDLE) return TOP;
      return null;
    });
    let posted = false;
    win32PostMessageMock.mockImplementation(() => {
      posted = true;
      return true;
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) => {
      if (h === MIDDLE) return scrollInfo(posted ? 800 : 100); // only this moves
      return scrollInfo(100); // both ends sit still
    });

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    expect(win32GetScrollInfoMock.mock.calls.map((c) => c[0])).toContain(MIDDLE);
    expect(result).not.toBeNull();
    expect(result!.scrolled).toBe(true);
    // The middle scrolled, so nothing needed a second dispatch.
    expect(win32PostMessageMock.mock.calls.every((c) => c[0] === LEAF)).toBe(true);
  });

  it("no retry when the retry target itself is unobservable, even if something else on the chain is readable", async () => {
    // The shape a "something on the chain is readable" gate gets wrong, and it
    // is the same shape that motivated watching the chain in the first place:
    //   leaf   — custom-painted scrollbars, unreadable
    //   middle — vestigial WS_VSCROLL, readable, never moves
    //   top    — custom-paint, unreadable, and where the wheel actually lands
    // The first post bubbles up and scrolls the top level. We cannot see that,
    // so "no motion observed" must NOT be read as "nothing happened": posting
    // again would scroll it a second time.
    const MIDDLE = 0xA11Dn;
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    win32GetAncestorMock.mockImplementation((h: bigint) => {
      if (h === LEAF) return MIDDLE;
      if (h === MIDDLE) return TOP;
      return null;
    });
    win32GetScrollInfoMock.mockImplementation((h: bigint) =>
      h === MIDDLE ? scrollInfo(100) : null,
    );

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 3 });

    const targets = win32PostMessageMock.mock.calls.map((c) => c[0]);
    expect(targets.every((t) => t === LEAF)).toBe(true);
    expect(result).toBeNull();
  });

  it("an older .node without the hit-test export degrades to the top-level post", async () => {
    // Mixed-version builds are a supported state (the launcher can start a
    // runtime older than the JS). Every other native call in this path is
    // optional-chained for that reason; the hit test must be too.
    delete nativeWin32Mock.win32FindWheelLeafByHittest;
    win32GetScrollInfoMock.mockImplementation(() => scrollInfo(0));

    await postWheelToHwnd(TOP, { direction: "down", notch: 1 });

    expect(win32PostMessageMock.mock.calls[0]![0]).toBe(TOP);
    // Restore for the remaining tests in this block.
    nativeWin32Mock.win32FindWheelLeafByHittest = win32FindWheelLeafByHittestMock;
  });

  it("the class table wins: a chain-table hit is never overridden by the hit test", async () => {
    const CHAIN_LEAF = 0xFEEDn;
    win32FindScrollLeafForTopLevelMock.mockReturnValue(CHAIN_LEAF);
    win32FindWheelLeafByHittestMock.mockReturnValue(LEAF);
    win32GetScrollInfoMock.mockReturnValue(null);

    const result = await postWheelToHwnd(TOP, { direction: "down", notch: 1 });

    expect(win32PostMessageMock.mock.calls[0]![0]).toBe(CHAIN_LEAF);
    expect(win32FindWheelLeafByHittestMock).not.toHaveBeenCalled();
    // Chain-trust still applies to table members with no readable scrollbar.
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("delivered_via_postmessage");
  });
});
