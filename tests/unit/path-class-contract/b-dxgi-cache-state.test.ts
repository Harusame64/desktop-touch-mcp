/**
 * tests/unit/path-class-contract/b-dxgi-cache-state.test.ts
 * ADR-020 Phase 2 PR-P2-3 — B 軸 contract test (property-based with fast-check).
 *
 * Contract (ADR-020 §4.2 B 行, post-SR-4):
 *   ∀ (DXGI factory failure, elapsed).
 *     cacheState(state, elapsed) ∈ {
 *       hit-unavailable (elapsed ≤ unavailableTtl),
 *       re-validating (elapsed > unavailableTtl),
 *       hit-subscription, hit-negative-backoff, miss-init, miss-init-unavailable
 *     }
 *
 * Pins the 5-value state machine. PR-P2-3 originally landed against
 * `DirtyRectSubscriptionCache`; ADR-020 SR-4 PR-SR4-2 migrated the state
 * machine into `DirtyRectBroker` (the cache class was deleted). The contract
 * is unchanged — same 5 enum values, same TTL semantics — and this test
 * now pins it on the broker directly. Same observable surface
 * (`broker.acquire(outputIndex)` + `broker.invalidate(outputIndex)`).
 *
 * @see docs/adr-020-phase-2-p2-3-contract-test-plan.md §1.1 C (B 軸)
 * @see docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md §5.3 (broker SSOT shift)
 * @see src/engine/dxgi-broker.ts (DirtyRectBroker)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  DirtyRectBroker,
  type SubscriptionLike,
} from "../../../src/engine/dxgi-broker.js";

function makeFakeSub(): SubscriptionLike {
  // Minimal SubscriptionLike — the broker's STATE-MACHINE contract only
  // exercises `dispose` + `isDisposed`. The fan-out loop calls `next()` on
  // a separate microtask which is irrelevant to acquire/invalidate state
  // transitions; the broker entry's `kind` field flips synchronously.
  let disposed = false;
  return {
    get isDisposed() { return disposed; },
    next: async () => [],
    dispose: () => { disposed = true; },
  };
}

const fakeFactory = (): SubscriptionLike => makeFakeSub();
const throwingFactory = (message: string) => (): SubscriptionLike => {
  throw new Error(message);
};

/** Construct a broker with shrunken windows so fast-check property iterations
 *  stay cheap. Defaults match Stage 5 SSOT for value-equivalence tests. */
function makeBroker(
  factory: () => SubscriptionLike,
  nowFn: () => number,
): DirtyRectBroker {
  return new DirtyRectBroker(
    factory,
    nowFn,
    20_000, // idleTimeoutMs (Stage 5 SSOT)
    60_000, // unavailableTtlMs (Stage 5 SSOT)
    5,      // fanOutPollMs (fast for tests)
    2_000,  // negativeBackoffMs (Stage 5 SSOT)
  );
}

describe("B contract — DXGI cacheState 5-value state machine (broker SSOT)", () => {
  it("first acquire on empty broker returns 'miss-init' when factory succeeds", () => {
    const broker = makeBroker(fakeFactory, () => 0);
    const r = broker.acquire(0);
    expect(r.state).toBe("miss-init");
    expect(r.sub).not.toBeNull();
    broker.disposeAll();
  });

  it("first acquire on empty broker returns 'miss-init-unavailable' when factory throws", () => {
    const broker = makeBroker(throwingFactory("DXGI factory failed"), () => 0);
    const r = broker.acquire(0);
    expect(r.state).toBe("miss-init-unavailable");
    expect(r.sub).toBeNull();
    broker.disposeAll();
  });

  it("subsequent acquire after successful init returns 'hit-subscription'", () => {
    const broker = makeBroker(fakeFactory, () => 0);
    broker.acquire(0);
    const second = broker.acquire(0);
    expect(second.state).toBe("hit-subscription");
    broker.disposeAll();
  });

  it("after invalidate, next acquire returns 'hit-negative-backoff' within 2s", () => {
    let now = 0;
    const broker = makeBroker(fakeFactory, () => now);
    broker.acquire(0);          // miss-init → subscription entry
    broker.invalidate(0);        // negative-backoff marker set
    now = 1_000;                 // 1s elapsed < negativeBackoffMs (2s)
    const r = broker.acquire(0);
    expect(r.state).toBe("hit-negative-backoff");
    expect(r.sub).toBeNull();
    broker.disposeAll();
  });

  it("after factory failure, next acquire returns 'hit-unavailable' within 60s (Issue #327 item B)", () => {
    let now = 0;
    const broker = makeBroker(throwingFactory("E_DUP_UNSUPPORTED"), () => now);
    broker.acquire(0);          // miss-init-unavailable → unavailable marker
    now = 30_000;                // 30s elapsed < 60s unavailableTtlMs
    const r = broker.acquire(0);
    expect(r.state).toBe("hit-unavailable");
    expect(r.sub).toBeNull();
    broker.disposeAll();
  });

  it("after factory failure + 60s elapsed, broker re-validates (miss-init-unavailable on retry)", () => {
    let now = 0;
    const broker = makeBroker(throwingFactory("permanent"), () => now);
    broker.acquire(0);
    now = 61_000;                // > 60s unavailableTtlMs
    const r = broker.acquire(0);
    expect(r.state).toBe("miss-init-unavailable");   // re-validated, factory threw again
    broker.disposeAll();
  });

  it("state value cardinality is exactly 5 (auditability per JSDoc Opus R1 P2-1)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.boolean(),
        fc.boolean(),
        (elapsedMs, factorySucceeds, invalidateMidway) => {
          let now = 0;
          const broker = makeBroker(
            () => {
              if (!factorySucceeds) throw new Error("dxgi fail");
              return makeFakeSub();
            },
            () => now,
          );
          broker.acquire(0);          // first acquire
          if (invalidateMidway && factorySucceeds) broker.invalidate(0);
          now = elapsedMs;
          const r = broker.acquire(0);
          expect([
            "hit-subscription", "hit-unavailable", "hit-negative-backoff",
            "miss-init", "miss-init-unavailable",
          ]).toContain(r.state);
          broker.disposeAll();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Round 2 P2-3 fix: semantic mapping property — pins the (state, factory,
  // elapsed, invalidated) tuple to expected cacheState, not just cardinality.
  // Catches a regression where the state machine returns a valid-but-wrong
  // value (e.g. miss-init when hit-subscription was expected).
  it("semantic mapping: (factorySucceeds, !invalidated, elapsed < 20s) → 'hit-subscription'", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 19_999 }),    // < 20s idleTimeoutMs
        (elapsedMs) => {
          let now = 0;
          const broker = makeBroker(fakeFactory, () => now);
          broker.acquire(0);                // miss-init → subscription entry
          now = elapsedMs;
          const r = broker.acquire(0);
          expect(r.state).toBe("hit-subscription");
          broker.disposeAll();
        },
      ),
      { numRuns: 50 },
    );
  });

  it("semantic mapping: (factory throws, elapsed ≤ 60s) → 'hit-unavailable'", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59_999 }),    // ≤ 60s unavailableTtlMs
        (elapsedMs) => {
          let now = 0;
          const broker = makeBroker(throwingFactory("dxgi fail"), () => now);
          broker.acquire(0);                // miss-init-unavailable → marker cached
          now = elapsedMs;
          const r = broker.acquire(0);
          expect(r.state).toBe("hit-unavailable");
          broker.disposeAll();
        },
      ),
      { numRuns: 50 },
    );
  });

  it("semantic mapping: (invalidated, elapsed < 2s) → 'hit-negative-backoff'", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_999 }),     // < 2s negativeBackoffMs
        (elapsedMs) => {
          let now = 0;
          const broker = makeBroker(fakeFactory, () => now);
          broker.acquire(0);                // miss-init → subscription entry
          broker.invalidate(0);              // negative-backoff marker set
          now = elapsedMs;
          const r = broker.acquire(0);
          expect(r.state).toBe("hit-negative-backoff");
          broker.disposeAll();
        },
      ),
      { numRuns: 50 },
    );
  });
});
