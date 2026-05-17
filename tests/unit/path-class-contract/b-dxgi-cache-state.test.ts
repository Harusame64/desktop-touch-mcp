/**
 * tests/unit/path-class-contract/b-dxgi-cache-state.test.ts
 * ADR-020 Phase 2 PR-P2-3 — B 軸 contract test (property-based with fast-check).
 *
 * Contract (ADR-020 §4.2 B 行):
 *   ∀ (DXGI factory failure, elapsed).
 *     cacheState(state, elapsed) ∈ {
 *       hit-unavailable (elapsed ≤ unavailableTtl),
 *       re-validating (elapsed > unavailableTtl),
 *       hit-subscription, hit-negative-backoff, miss-init, miss-init-unavailable
 *     }
 *
 * Pins the 5-value state machine added in PR #333 (issue #327 item B
 * instrumentation): the cache state transitions are pure functions of (current
 * entry kind, factory outcome, elapsedMs). No timestamp / global clock leakage.
 *
 * Uses existing observable surface (DirtyRectSubscriptionCache.acquireWithState
 * + invalidate) — does NOT introduce new helper extraction (deferred to SR-4
 * DXGI broker per ADR-020 §5.1 SR-4 + sub-plan §1.1 E + §3.2 B bullet).
 *
 * @see docs/adr-020-phase-2-p2-3-contract-test-plan.md §1.1 C (B 軸)
 * @see src/engine/any-change.ts:148-285 (DirtyRectSubscriptionCache)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { DirtyRectSubscriptionCache } from "../../../src/engine/any-change.js";

interface FakeSub {
  isDisposed: boolean;
  dispose: () => void;
}

function makeFakeSub(): FakeSub {
  const sub: FakeSub = {
    isDisposed: false,
    dispose: () => { sub.isDisposed = true; },
  };
  return sub;
}

// DirtyRectSubscriptionCache's factory expects a SubscriptionLike (private
// type). Tests inject FakeSub via `as never` cast — same approach the
// existing internal test fixtures use (cache lifecycle is the contract
// surface; SubscriptionLike methods other than dispose/isDisposed are never
// reached on the cache's own state machine).
const fakeFactory = () => makeFakeSub() as never;
const throwingFactory = (message: string) => () => { throw new Error(message); };

describe("B contract — DXGI cacheState 5-value state machine", () => {
  it("first acquire on empty cache returns 'miss-init' when factory succeeds", () => {
    const cache = new DirtyRectSubscriptionCache(fakeFactory, () => 0);
    const r = cache.acquireWithState(0);
    expect(r.state).toBe("miss-init");
    expect(r.sub).not.toBeNull();
  });

  it("first acquire on empty cache returns 'miss-init-unavailable' when factory throws", () => {
    const cache = new DirtyRectSubscriptionCache(throwingFactory("DXGI factory failed"), () => 0);
    const r = cache.acquireWithState(0);
    expect(r.state).toBe("miss-init-unavailable");
    expect(r.sub).toBeNull();
  });

  it("subsequent acquire after successful init returns 'hit-subscription'", () => {
    const cache = new DirtyRectSubscriptionCache(fakeFactory, () => 0);
    cache.acquireWithState(0);
    const second = cache.acquireWithState(0);
    expect(second.state).toBe("hit-subscription");
  });

  it("after invalidate, next acquire returns 'hit-negative-backoff' within 2s", () => {
    let now = 0;
    const cache = new DirtyRectSubscriptionCache(fakeFactory, () => now);
    cache.acquireWithState(0);              // miss-init → subscription cached
    cache.invalidate(0);                     // negative-backoff marker set
    now = 1_000;                             // 1s elapsed < NEGATIVE_BACKOFF_MS (2s)
    const r = cache.acquireWithState(0);
    expect(r.state).toBe("hit-negative-backoff");
    expect(r.sub).toBeNull();
  });

  it("after factory failure, next acquire returns 'hit-unavailable' within 60s (Issue #327 item B)", () => {
    let now = 0;
    const cache = new DirtyRectSubscriptionCache(throwingFactory("E_DUP_UNSUPPORTED"), () => now);
    cache.acquireWithState(0);              // miss-init-unavailable → unavailable cached
    now = 30_000;                            // 30s elapsed < 60s STAGE5_UNAVAILABLE_TTL_MS
    const r = cache.acquireWithState(0);
    expect(r.state).toBe("hit-unavailable");
    expect(r.sub).toBeNull();
  });

  it("after factory failure + 60s elapsed, cache re-validates (miss-init-unavailable on retry)", () => {
    let now = 0;
    const cache = new DirtyRectSubscriptionCache(throwingFactory("permanent"), () => now);
    cache.acquireWithState(0);
    now = 61_000;                            // > 60s STAGE5_UNAVAILABLE_TTL_MS
    const r = cache.acquireWithState(0);
    expect(r.state).toBe("miss-init-unavailable");   // re-validated, factory threw again
  });

  it("state value cardinality is exactly 5 (auditability per JSDoc Opus R1 P2-1)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.boolean(),
        fc.boolean(),
        (elapsedMs, factorySucceeds, invalidateMidway) => {
          let now = 0;
          const cache = new DirtyRectSubscriptionCache(
            () => {
              if (!factorySucceeds) throw new Error("dxgi fail");
              return makeFakeSub() as never;
            },
            () => now,
          );
          cache.acquireWithState(0);          // first acquire
          if (invalidateMidway && factorySucceeds) cache.invalidate(0);
          now = elapsedMs;
          const r = cache.acquireWithState(0);
          expect([
            "hit-subscription", "hit-unavailable", "hit-negative-backoff",
            "miss-init", "miss-init-unavailable",
          ]).toContain(r.state);
        },
      ),
      { numRuns: 100 },
    );
  });
});
