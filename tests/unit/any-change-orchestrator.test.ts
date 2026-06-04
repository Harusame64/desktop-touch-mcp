/**
 * ADR-019 Stage 5 — `verifyAnyChange` orchestrator unit tests.
 *
 * Sub-plan: `docs/adr-019-stage-5-plan.md` §3 SSOT row
 * `any-change-orchestrator.test.ts`. Drives every §2.1 decision branch via
 * mocked `SubscriptionLike` instances + an injected `DirtyRectBroker`
 * (ADR-020 SR-4 PR-SR4-2; previously `DirtyRectSubscriptionCache`) and
 * `enumerate` provider so no native binding is touched.
 *
 * Mid-flight failure semantics shift (PR-SR4-2): the broker's fan-out loop
 * catches every `sub.next()` exception uniformly and calls `invalidate()`,
 * so the orchestrator no longer string-matches `E_DUP_*` markers. A
 * `sub.next()` throw (any cause) surfaces to the orchestrator as
 * `handle.isDisposed === true` after `await sub.next()` resolves with `[]`
 * — emitting `motion: indeterminate` + `source: dxgi_dirty_rect` on the
 * current call, then `source: dxgi_dirty_rect_unavailable` +
 * `cacheState: hit-negative-backoff` on the next call within 2 s.
 */

import { describe, it, expect, vi } from "vitest";

import {
  STAGE5_CONSTANTS,
  verifyAnyChange,
} from "../../src/engine/any-change.js";
import {
  BROKER_CONSTANTS,
  DirtyRectBroker,
  type SubscriptionLike,
} from "../../src/engine/dxgi-broker.js";

const WINDOW_RECT = { x: 0, y: 0, width: 800, height: 600 };
const PRIMARY_MONITOR = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

/** Short broker budget so the orchestrator's `handle.next(timeoutMs)` resolves
 *  fast in tests (the fan-out loop still polls the mock sub at this cadence). */
const FAST_FANOUT_POLL_MS = 5;

/** Short orchestrator budget so the empty-rects path returns within a single
 *  vitest tick. The mock sub.next() resolves synchronously, so the only wait
 *  is the handle's timeout drain. */
const FAST_BUDGET_MS = 30;

function buildSub(
  next: (timeoutMs: number) => Promise<Array<{ x: number; y: number; width: number; height: number }>>,
): SubscriptionLike {
  return {
    isDisposed: false,
    next,
    dispose: vi.fn(),
  };
}

/**
 * Construct a broker whose factory always returns `sub` (or throws when
 * `sub` is null) — the exact analogue of the pre-SR-4 `cacheReturning`
 * helper. The fan-out cadence is shrunk so tests run quickly without
 * scheduling real DXGI polling.
 */
function brokerReturning(sub: SubscriptionLike | null): DirtyRectBroker {
  const factory = vi.fn(() => {
    if (sub === null) throw new Error("E_DUP_UNSUPPORTED");
    return sub;
  });
  return new DirtyRectBroker(
    factory,
    () => 0,                                          // nowFn
    BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS,    // idleTimeoutMs (broker SSOT)
    BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS,       // unavailableTtlMs (broker SSOT)
    FAST_FANOUT_POLL_MS,                              // fanOutPollMs — fast for tests
    BROKER_CONSTANTS.BROKER_NEGATIVE_BACKOFF_MS,      // negativeBackoffMs (broker SSOT)
  );
}

/** Like `brokerReturning` but also hands back the factory spy so a test can
 *  assert the DXGI subscription was acquired exactly once — substantiating the
 *  S3a "+0 extra acquire" acceptance with a measurement, not just structure. */
function brokerWithFactorySpy(
  sub: SubscriptionLike,
): { broker: DirtyRectBroker; factory: ReturnType<typeof vi.fn> } {
  const factory = vi.fn(() => sub);
  const broker = new DirtyRectBroker(
    factory,
    () => 0,
    BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS,
    BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS,
    FAST_FANOUT_POLL_MS,
    BROKER_CONSTANTS.BROKER_NEGATIVE_BACKOFF_MS,
  );
  return { broker, factory };
}

describe("verifyAnyChange orchestrator", () => {
  it("empty rects → motion: no_change, residual omitted", async () => {
    const sub = buildSub(async () => []);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("no_change");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(obs.residual).toBeUndefined();
  });

  it("rects entirely outside the target → motion: no_change with totalIntersectedAreaPx 0", async () => {
    const sub = buildSub(async () => [
      { x: 2000, y: 100, width: 100, height: 100 },
    ]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("no_change");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(obs.residual?.totalIntersectedAreaPx).toBe(0);
    expect(obs.residual?.dirtyRectCount).toBe(1);
  });

  it("rect overlap at the ratio gate boundary just above 0.005 → motion: any_change", async () => {
    // 800 * 600 = 480000 px; 0.005 ratio = 2400 px. Use a 50x60 = 3000 px
    // overlap to comfortably clear the gate.
    const sub = buildSub(async () => [
      { x: 10, y: 10, width: 50, height: 60 },
    ]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("any_change");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(obs.residual?.dirtyRectCount).toBe(1);
    expect(obs.residual?.totalIntersectedAreaPx).toBe(3000);
    expect(obs.residual?.ratioOfTargetArea).toBeCloseTo(3000 / 480000, 6);
    expect(obs.residual!.ratioOfTargetArea!).toBeGreaterThanOrEqual(
      STAGE5_CONSTANTS.STAGE5_MIN_INTERSECTED_AREA_RATIO,
    );
  });

  it("rect overlap just below 0.005 → motion: no_change with sub-threshold residual populated", async () => {
    // 480000 * 0.005 = 2400 px gate; use 30x70 = 2100 px to fall short.
    const sub = buildSub(async () => [
      { x: 5, y: 5, width: 30, height: 70 },
    ]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("no_change");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(obs.residual?.totalIntersectedAreaPx).toBe(2100);
    expect(obs.residual!.ratioOfTargetArea!).toBeLessThan(
      STAGE5_CONSTANTS.STAGE5_MIN_INTERSECTED_AREA_RATIO,
    );
  });

  it("region (sub-rect of windowRect) is honoured for the intersection target", async () => {
    // Constrain target to a 100x100 region; a 50x50 rect inside it qualifies
    // as ratio = 2500 / 10000 = 0.25, comfortably above the gate.
    const sub = buildSub(async () => [
      { x: 220, y: 220, width: 50, height: 50 },
    ]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      region: { x: 200, y: 200, width: 100, height: 100 },
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("any_change");
    expect(obs.residual?.totalIntersectedAreaPx).toBe(2500);
  });

  // ── ADR-024 Seed-2 S3a — opt-in dirty-rect surface ────────────────────────
  // The visual-only ROI-capture path reuses the SAME poll that produces
  // `motion` to also surface the raw dirty `Rect[]` (sub-plan §2 S3a). These
  // tests pin: (a) opt-in → rects surfaced from a single poll; (b) default →
  // field absent (byte-equal for existing callers); (c) the rects are the raw
  // per-output rects, NOT yet window-rect filtered.

  it("S3a: includeDirtyRects surfaces the raw rects on any_change from the same observation", async () => {
    const sub = buildSub(async () => [{ x: 10, y: 10, width: 50, height: 60 }]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
      includeDirtyRects: true,
    });
    // A SINGLE verifyAnyChange call (= one broker acquire + drain) yields BOTH
    // the motion verdict and the rect[]. The ROI path never makes a second
    // verifyAnyChange call, so the rects cost zero extra DXGI acquires
    // (sub-plan §2 S3a — "single-poll で motion + rect[] 両取り").
    expect(obs.motion).toBe("any_change");
    expect(obs.dirtyRects).toEqual([{ x: 10, y: 10, width: 50, height: 60 }]);
    // The scalar residual is unchanged (additive — both populated together).
    expect(obs.residual?.dirtyRectCount).toBe(1);
  });

  it("S3a: includeDirtyRects acquires the DXGI subscription exactly once (+0 extra acquire)", async () => {
    // Acceptance ① "DXGI poll 回数が現状 +0" — surfacing the rects must NOT
    // trigger a second broker acquire. The factory is invoked once per
    // first-touch acquire of an output; reusing the drained `rects` keeps it
    // at one even with the opt-in on.
    const { broker, factory } = brokerWithFactorySpy(
      buildSub(async () => [{ x: 10, y: 10, width: 50, height: 60 }]),
    );
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
      includeDirtyRects: true,
    });
    expect(obs.dirtyRects).toEqual([{ x: 10, y: 10, width: 50, height: 60 }]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("S3a: includeDirtyRects surfaces sub-threshold rects on no_change too", async () => {
    // 30x70 = 2100 px < 2400 px gate → no_change, but the rect is still real
    // dirty pixels the ROI path may want to crop.
    const sub = buildSub(async () => [{ x: 5, y: 5, width: 30, height: 70 }]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
      includeDirtyRects: true,
    });
    expect(obs.motion).toBe("no_change");
    expect(obs.dirtyRects).toEqual([{ x: 5, y: 5, width: 30, height: 70 }]);
  });

  it("S3a: includeDirtyRects surfaces RAW per-output rects (not window-rect filtered)", async () => {
    // One rect inside the window, one entirely outside it. S3a is the surface
    // phase — BOTH must come through verbatim; the window-rect intersection
    // filter is S3b, not here.
    const inside = { x: 10, y: 10, width: 50, height: 60 };
    const outside = { x: 2000, y: 100, width: 100, height: 100 };
    const sub = buildSub(async () => [inside, outside]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
      includeDirtyRects: true,
    });
    expect(obs.dirtyRects).toEqual([inside, outside]);
    // The returned array is a fresh copy, not the native poll array reference.
    expect(obs.dirtyRects?.[0]).not.toBe(inside);
  });

  it("S3a: default (no includeDirtyRects) omits dirtyRects → byte-equal for existing callers", async () => {
    const sub = buildSub(async () => [{ x: 10, y: 10, width: 50, height: 60 }]);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("any_change");
    expect(obs.dirtyRects).toBeUndefined();
    expect("dirtyRects" in obs).toBe(false);
  });

  it("S3a: empty rects omit dirtyRects even when opted in (nothing to surface)", async () => {
    const sub = buildSub(async () => []);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
      includeDirtyRects: true,
    });
    expect(obs.motion).toBe("no_change");
    expect(obs.dirtyRects).toBeUndefined();
  });

  it("DXGI Unsupported at acquire → motion: indeterminate, source: dxgi_dirty_rect_unavailable", async () => {
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: brokerReturning(null), // factory throws E_DUP_UNSUPPORTED
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
    expect(obs.residual).toBeUndefined();
  });

  // ADR-020 SR-4 PR-SR4-2 semantics: any mid-flight `sub.next()` exception
  // (AccessLost OR Unsupported OR Other) is folded by the broker's fan-out
  // loop into a uniform `invalidate()` transition. The orchestrator emits
  // `source: dxgi_dirty_rect` on THIS call (handle.isDisposed signal) and
  // `source: dxgi_dirty_rect_unavailable` + `cacheState: hit-negative-backoff`
  // on the next call within 2 s. Tests below pin both calls.
  it("AccessLost mid-flight → motion: indeterminate, source: dxgi_dirty_rect, broker.invalidate fires", async () => {
    const sub = buildSub(async () => {
      throw new Error("E_DUP_ACCESS_LOST: session lost, resubscribe");
    });
    const broker = brokerReturning(sub);
    const invalidateSpy = vi.spyOn(broker, "invalidate");

    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(invalidateSpy).toHaveBeenCalledWith(0);
  });

  it("subscription.next throws E_DUP_UNSUPPORTED → broker.invalidate fires, source: dxgi_dirty_rect (PR-SR4-2 semantics shift)", async () => {
    // PR-SR4-2 semantics shift: previously the orchestrator string-matched
    // `E_DUP_UNSUPPORTED` to emit `dxgi_dirty_rect_unavailable` directly.
    // Now the broker folds both AccessLost and Unsupported mid-flight errors
    // into a uniform invalidate(), so the FIRST call surfaces
    // `dxgi_dirty_rect` (handle disposed) and the NEXT call within 2 s
    // surfaces `dxgi_dirty_rect_unavailable` + `cacheState=hit-negative-backoff`
    // (covered by the dedicated negative-backoff test below).
    const sub = buildSub(async () => {
      throw new Error("E_DUP_UNSUPPORTED: RDP or unsupported driver");
    });
    const broker = brokerReturning(sub);
    const invalidateSpy = vi.spyOn(broker, "invalidate");

    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(invalidateSpy).toHaveBeenCalledWith(0);
  });

  // Issue #327 item B instrumentation: cacheState should be populated on all
  // observation paths that consulted the DXGI broker, so back-to-back
  // desktop_act calls can be audited for hit/miss ratio in dogfood logs.
  it("cacheState='miss-init' on cold acquire, 'hit-subscription' on warm acquire (#327 item B)", async () => {
    const sub = buildSub(async () => []);
    const broker = brokerReturning(sub);

    const first = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(first.cacheState).toBe("miss-init");

    const second = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(second.cacheState).toBe("hit-subscription");
  });

  it("cacheState='hit-unavailable' after the factory has thrown once (#327 item B)", async () => {
    const broker = brokerReturning(null); // factory throws E_DUP_UNSUPPORTED

    const first = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(first.cacheState).toBe("miss-init-unavailable");

    const second = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    // Back-to-back call must NOT re-pay the 50 ms factory init —
    // the unavailable marker fast-paths it.
    expect(second.cacheState).toBe("hit-unavailable");
  });

  it("cacheState='hit-negative-backoff' after sub.next() failure prevents 50ms re-init (#327 item B)", async () => {
    const sub = buildSub(async () => {
      throw new Error("E_DUP_UNSUPPORTED: vision-gpu coexistence");
    });
    const broker = brokerReturning(sub);

    // First call: paid the factory init (miss-init), sub.next threw inside
    // the broker fan-out loop, broker.invalidate set the negative-backoff
    // marker.
    const first = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(first.cacheState).toBe("miss-init");

    // Second call: the negative-backoff marker fast-paths the acquire so no
    // factory re-init is paid. THIS is the #327 item B fix — the dogfood
    // "50ms constant" symptom is closed. PR-SR4-2 preserves this contract
    // through the broker.
    const second = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(second.cacheState).toBe("hit-negative-backoff");
    expect(second.source).toBe("dxgi_dirty_rect_unavailable");
  });

  it("off-screen window → motion: indeterminate, source: dxgi_dirty_rect_unavailable", async () => {
    const sub = buildSub(async () => []);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      // Window centred at (-3200, -1200) — outside the primary monitor.
      windowRect: { x: -3600, y: -1600, width: 800, height: 800 },
      broker: brokerReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
  });

  it("null broker (native addon absent) → motion: indeterminate, source: dxgi_dirty_rect_unavailable", async () => {
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker: null,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
  });

  it("STAGE5_MIN_INTERSECTED_AREA_RATIO default is 0.005 (Round 1 P2-5 lock)", () => {
    expect(STAGE5_CONSTANTS.STAGE5_MIN_INTERSECTED_AREA_RATIO).toBe(0.005);
  });

  // ADR-020 SR-4 PR-SR4-2 — broker SSOT pin. The Stage 5 numeric values must
  // re-export from the broker so the two consumers (Stage 5 + future
  // vision-gpu in PR-SR4-3) stay bit-equal by construction.
  it("STAGE5_CACHE_IDLE_TIMEOUT_MS / STAGE5_UNAVAILABLE_TTL_MS re-export from BROKER_CONSTANTS", async () => {
    const { BROKER_CONSTANTS } = await import("../../src/engine/dxgi-broker.js");
    expect(STAGE5_CONSTANTS.STAGE5_CACHE_IDLE_TIMEOUT_MS).toBe(
      BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS,
    );
    expect(STAGE5_CONSTANTS.STAGE5_UNAVAILABLE_TTL_MS).toBe(
      BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS,
    );
  });

  it("verifyAnyChange disposes the broker polling handle after each call (no per-call cursor leak)", async () => {
    // Two sequential verify calls on the same broker. After both calls the
    // broker entry's `pollingHandles` set should be empty — the orchestrator
    // disposes its per-call handle in the `try/finally` block. Without this
    // dispose the handles would accumulate across chained `desktop_act` calls
    // and the fan-out loop would push to every leaked cursor's queue.
    const sub = buildSub(async () => []);
    const broker = brokerReturning(sub);

    await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });
    await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      broker,
      enumerate: () => [PRIMARY_MONITOR],
      budgetMs: FAST_BUDGET_MS,
    });

    const entry = broker._getEntryForTest(0);
    expect(entry?.kind).toBe("subscription");
    if (entry?.kind === "subscription") {
      expect(entry.pollingHandles.size).toBe(0);
      expect(entry.callbackHandles.size).toBe(0);
    }
    broker.disposeAll();
  });
});
