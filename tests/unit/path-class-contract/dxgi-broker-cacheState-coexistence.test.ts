/**
 * tests/unit/path-class-contract/dxgi-broker-cacheState-coexistence.test.ts
 * ADR-021 Phase 4 PR-P4-3 — deterministic regression: DXGI broker SSOT coexistence.
 *
 * `b-dxgi-cache-state.test.ts` already pins the single-consumer, single-output
 * 5-value state machine. This pins the ORTHOGONAL axis the SR-4 broker exists
 * for — multi-consumer / multi-output coexistence through ONE SSOT. Pre-SR-4,
 * vision-gpu / DirtyRectRouter / Stage5 each held their own cache (parallel
 * writers → cacheState drift, issue #327 item B). SR-4 (PR-SR4-1/2,
 * `DirtyRectBroker`) made the broker the single owner. This regression pins:
 *   1. **SSOT** — one native subscription per `outputIndex` regardless of how
 *      many consumers acquire it (the factory is called once, not once per
 *      consumer);
 *   2. **per-output isolation** — `outputIndex` entries do not contaminate each
 *      other (the secondary-monitor / output_index lesson, CLAUDE.md §3.2 / PR
 *      #102 monitor_index regression class);
 *   3. **invalidate is output-scoped** — invalidating one output does not leak
 *      into another output's cached subscription.
 *
 * Detection power vs b-dxgi: reverting SR-4 to per-consumer caches makes #1 fail
 * (factory called per consumer); b-dxgi stays green precisely because it never
 * asserts the factory call count (it only checks one consumer's state
 * transitions, which a per-consumer cache reproduces). #2/#3 pin the
 * per-`outputIndex` Map isolation that a single-output test never exercises.
 *
 * Out of scope (the other half of SR-4's "SSOT but independent cursor"): that
 * each consumer's polling handle drains its OWN queue cursor over the shared
 * native subscription. That is a separate axis (cursor non-interleaving, not a
 * past *drift* regression) — tracked in remaining-work.md, not pinned here.
 *
 * NOTE on the mock: ADR-021 §3.5.2 named ReplayBackend, but post-SR-4 the broker
 * consumes `factory: (outputIndex) => SubscriptionLike`, whereas ReplayBackend
 * implements `VisualBackend` (recognize/dispose) — a different abstraction, not a
 * subscription source. The correct mock is an instrumented `SubscriptionLike`
 * factory (the b-dxgi idiom), which also lets us count factory calls per output
 * = the direct SSOT assertion. Time is deterministic via an injected `nowFn`.
 *
 * @see docs/adr-021-result-migration-drift-prevention-plan.md §3.5.2 (PR-P4-3)
 * @see tests/unit/path-class-contract/b-dxgi-cache-state.test.ts (state machine axis)
 * @see src/engine/dxgi-broker.ts (DirtyRectBroker SSOT)
 */

import { describe, it, expect } from "vitest";
import {
  DirtyRectBroker,
  type SubscriptionLike,
} from "../../../src/engine/dxgi-broker.js";

function makeFakeSub(): SubscriptionLike {
  let disposed = false;
  return {
    get isDisposed() {
      return disposed;
    },
    next: async () => [],
    dispose: () => {
      disposed = true;
    },
  };
}

/** Factory that records how many native subscriptions it built per outputIndex.
 *  The call count is the direct SSOT proxy: one entry per output, shared across
 *  all consumers, means exactly one factory call per output. */
function countingFactory() {
  const callsPerOutput = new Map<number, number>();
  const factory = (outputIndex: number): SubscriptionLike => {
    callsPerOutput.set(outputIndex, (callsPerOutput.get(outputIndex) ?? 0) + 1);
    return makeFakeSub();
  };
  return { factory, callsPerOutput };
}

function makeBroker(
  factory: (outputIndex: number) => SubscriptionLike,
  nowFn: () => number,
): DirtyRectBroker {
  return new DirtyRectBroker(
    factory,
    nowFn,
    20_000, // idleTimeoutMs (Stage 5 SSOT)
    60_000, // unavailableTtlMs
    5, // fanOutPollMs
    2_000, // negativeBackoffMs
  );
}

describe("DXGI broker SSOT coexistence (ADR-021 Phase 4 PR-P4-3)", () => {
  it("N consumers acquiring the same outputIndex share ONE native subscription (factory called once)", () => {
    const { factory, callsPerOutput } = countingFactory();
    const broker = makeBroker(factory, () => 0);

    const a = broker.acquire(0); // consumer A
    const b = broker.acquire(0); // consumer B
    const c = broker.acquire(0); // consumer C

    expect(a.state).toBe("miss-init");
    expect(b.state).toBe("hit-subscription");
    expect(c.state).toBe("hit-subscription");
    // SSOT: one native subscription for three consumers. A per-consumer cache
    // (the pre-SR-4 drift) would call the factory 3×.
    expect(callsPerOutput.get(0)).toBe(1);
    // Each acquire still returns its own polling handle (per-consumer cursor).
    expect(a.sub).not.toBeNull();
    expect(b.sub).not.toBeNull();
    expect(c.sub).not.toBeNull();

    broker.disposeAll();
  });

  it("outputIndex entries are isolated — acquiring output 1 does not disturb output 0 (output_index, PR #102)", () => {
    const { factory, callsPerOutput } = countingFactory();
    const broker = makeBroker(factory, () => 0);

    const a0 = broker.acquire(0); // miss-init (output 0)
    const a1 = broker.acquire(1); // miss-init (output 1) — independent, NOT a hit
    const a0again = broker.acquire(0); // hit-subscription (output 0 untouched by output 1)

    expect(a0.state).toBe("miss-init");
    expect(a1.state).toBe("miss-init");
    expect(a0again.state).toBe("hit-subscription");
    // Handles are labelled with their own output — no cross-output mislabel.
    expect(a0.sub?.outputIndex).toBe(0);
    expect(a1.sub?.outputIndex).toBe(1);
    expect(callsPerOutput.get(0)).toBe(1);
    expect(callsPerOutput.get(1)).toBe(1);

    broker.disposeAll();
  });

  it("invalidate() is scoped to its outputIndex — it does not leak into other outputs", () => {
    let now = 0;
    const { factory } = countingFactory();
    const broker = makeBroker(factory, () => now);

    broker.acquire(0); // miss-init (output 0)
    broker.acquire(1); // miss-init (output 1)
    broker.invalidate(0); // invalidate output 0 ONLY
    now = 500; // < 2s negativeBackoffMs

    const r0 = broker.acquire(0); // output 0: negative-backoff fast-path → sub:null
    const r1 = broker.acquire(1); // output 1 is untouched → still hit-subscription

    expect(r0.state).toBe("hit-negative-backoff");
    expect(r0.sub).toBeNull();
    expect(r1.state).toBe("hit-subscription");
    expect(r1.sub).not.toBeNull();

    broker.disposeAll();
  });
});
