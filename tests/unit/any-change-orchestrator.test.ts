/**
 * ADR-019 Stage 5 — `verifyAnyChange` orchestrator unit tests.
 *
 * Sub-plan: `docs/adr-019-stage-5-plan.md` §3 SSOT row
 * `any-change-orchestrator.test.ts` (8-12 cases). Drives every §2.1 decision
 * branch via mocked `SubscriptionLike` instances + an injected cache and
 * `enumerate` provider so no native binding is touched.
 */

import { describe, it, expect, vi } from "vitest";

import {
  DirtyRectSubscriptionCache,
  STAGE5_CONSTANTS,
  verifyAnyChange,
  type SubscriptionLike,
} from "../../src/engine/any-change.js";

const WINDOW_RECT = { x: 0, y: 0, width: 800, height: 600 };
const PRIMARY_MONITOR = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

function buildSub(
  next: (timeoutMs: number) => Promise<Array<{ x: number; y: number; width: number; height: number }>>,
): SubscriptionLike {
  return {
    isDisposed: false,
    next,
    dispose: vi.fn(),
  };
}

function cacheReturning(sub: SubscriptionLike | null): DirtyRectSubscriptionCache {
  // Factory is unused when `sub` is non-null — we hand the cache a
  // pre-built subscription via the standard factory contract.
  const factory = vi.fn(() => {
    if (sub === null) throw new Error("E_DUP_UNSUPPORTED");
    return sub;
  });
  return new DirtyRectSubscriptionCache(factory, () => 0);
}

describe("verifyAnyChange orchestrator", () => {
  it("empty rects → motion: no_change, residual omitted", async () => {
    const sub = buildSub(async () => []);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      cache: cacheReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
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
      cache: cacheReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
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
      cache: cacheReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
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
      cache: cacheReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
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
      cache: cacheReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
    });
    expect(obs.motion).toBe("any_change");
    expect(obs.residual?.totalIntersectedAreaPx).toBe(2500);
  });

  it("DXGI Unsupported error → motion: indeterminate, source: dxgi_dirty_rect_unavailable", async () => {
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      cache: cacheReturning(null), // factory throws E_DUP_UNSUPPORTED
      enumerate: () => [PRIMARY_MONITOR],
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
    expect(obs.residual).toBeUndefined();
  });

  it("AccessLost mid-flight → motion: indeterminate with source dxgi_dirty_rect + cache invalidated", async () => {
    const sub = buildSub(async () => {
      throw new Error("E_DUP_ACCESS_LOST: session lost, resubscribe");
    });
    const cache = cacheReturning(sub);
    const invalidateSpy = vi.spyOn(cache, "invalidate");

    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      cache,
      enumerate: () => [PRIMARY_MONITOR],
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect");
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("subscription.next throws E_DUP_UNSUPPORTED → degrade to unavailable + invalidate", async () => {
    const sub = buildSub(async () => {
      throw new Error("E_DUP_UNSUPPORTED: RDP or unsupported driver");
    });
    const cache = cacheReturning(sub);
    const invalidateSpy = vi.spyOn(cache, "invalidate");

    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      cache,
      enumerate: () => [PRIMARY_MONITOR],
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("off-screen window → motion: indeterminate, source: dxgi_dirty_rect_unavailable", async () => {
    const sub = buildSub(async () => []);
    const obs = await verifyAnyChange({
      hwnd: 1n,
      // Window centred at (-3200, -1200) — outside the primary monitor.
      windowRect: { x: -3600, y: -1600, width: 800, height: 800 },
      cache: cacheReturning(sub),
      enumerate: () => [PRIMARY_MONITOR],
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
  });

  it("null cache (native addon absent) → motion: indeterminate, source: dxgi_dirty_rect_unavailable", async () => {
    const obs = await verifyAnyChange({
      hwnd: 1n,
      windowRect: WINDOW_RECT,
      cache: null,
      enumerate: () => [PRIMARY_MONITOR],
    });
    expect(obs.motion).toBe("indeterminate");
    expect(obs.source).toBe("dxgi_dirty_rect_unavailable");
  });

  it("STAGE5_MIN_INTERSECTED_AREA_RATIO default is 0.005 (Round 1 P2-5 lock)", () => {
    expect(STAGE5_CONSTANTS.STAGE5_MIN_INTERSECTED_AREA_RATIO).toBe(0.005);
  });
});
