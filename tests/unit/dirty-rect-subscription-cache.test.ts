/**
 * ADR-019 Stage 5 — `DirtyRectSubscriptionCache` lifecycle unit tests.
 *
 * Sub-plan: `docs/adr-019-stage-5-plan.md` §3 SSOT row
 * `dirty-rect-subscription-cache.test.ts` (6 cases). Mocks
 * `DirtyRectSubscription` via the factory hook so no native addon is needed.
 */

import { describe, it, expect, vi } from "vitest";

import {
  DirtyRectSubscriptionCache,
  STAGE5_CONSTANTS,
  type SubscriptionLike,
} from "../../src/engine/any-change.js";

class StubSubscription implements SubscriptionLike {
  isDisposed = false;
  readonly disposeMock = vi.fn();
  // eslint-disable-next-line @typescript-eslint/require-await
  async next(_timeoutMs: number): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
    return [];
  }
  dispose(): void {
    this.disposeMock();
    this.isDisposed = true;
  }
}

describe("DirtyRectSubscriptionCache", () => {
  it("first acquire constructs a fresh subscription, second hits the cache", () => {
    const factory = vi.fn((idx: number) => {
      void idx;
      return new StubSubscription();
    });
    const cache = new DirtyRectSubscriptionCache(factory, () => 0);

    const first = cache.acquire(0);
    const second = cache.acquire(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("idle timeout disposes the cached subscription on next acquire", () => {
    let now = 0;
    const sub = new StubSubscription();
    const factory = vi.fn(() => sub);
    const cache = new DirtyRectSubscriptionCache(factory, () => now, 100);

    expect(cache.acquire(0)).toBe(sub);
    now = 200; // past idle timeout

    const fresh = new StubSubscription();
    factory.mockImplementationOnce(() => fresh);
    expect(cache.acquire(0)).toBe(fresh);
    expect(sub.disposeMock).toHaveBeenCalledOnce();
  });

  it("disposeAll releases every live subscription", () => {
    const a = new StubSubscription();
    const b = new StubSubscription();
    const queue: StubSubscription[] = [a, b];
    const factory = vi.fn(() => queue.shift()!);
    const cache = new DirtyRectSubscriptionCache(factory, () => 0);

    cache.acquire(0);
    cache.acquire(1);
    cache.disposeAll();

    expect(a.disposeMock).toHaveBeenCalledOnce();
    expect(b.disposeMock).toHaveBeenCalledOnce();
    expect(cache._getEntryForTest(0)).toBeUndefined();
    expect(cache._getEntryForTest(1)).toBeUndefined();
  });

  it("multi-output independence: output 0 and 1 are cached separately (PR #322 reinstated)", () => {
    const subs = [new StubSubscription(), new StubSubscription()];
    const factory = vi.fn((idx: number) => subs[idx]);
    const cache = new DirtyRectSubscriptionCache(factory, () => 0);

    const a = cache.acquire(0);
    const b = cache.acquire(1);
    expect(a).toBe(subs[0]);
    expect(b).toBe(subs[1]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("factory throw caches the failure as Unavailable for the unavailable-TTL window (#327 item B follow-up)", () => {
    let now = 0;
    const factory = vi.fn(() => {
      throw new Error("E_DUP_UNSUPPORTED");
    });
    // 4th constructor arg = unavailableTtlMs (was sharing the 3rd arg
    // `idleTimeoutMs` before #327 item B follow-up; now distinct so the
    // `unavailable` marker survives the 20 s subscription idle window).
    const cache = new DirtyRectSubscriptionCache(factory, () => now, 100, 500);

    expect(cache.acquire(0)).toBeNull();
    expect(cache.acquire(0)).toBeNull();
    // Factory should NOT have been re-tried within the unavailable-TTL window.
    expect(factory).toHaveBeenCalledTimes(1);

    // After the subscription-idle window (100 ms) but BEFORE the unavailable
    // TTL (500 ms), the marker must still be honoured — this is the #327
    // item B follow-up fix: the 20 s subscription idle no longer sweeps the
    // unavailable marker prematurely.
    now = 200;
    expect(cache.acquire(0)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);

    // After the unavailable TTL (501 ms), the marker is swept and a retry
    // is attempted.
    now = 501;
    expect(cache.acquire(0)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  // Issue #327 item B: `invalidate` now sets a 2 s `negative-backoff` marker
  // instead of deleting the entry outright. This prevents the 50 ms factory
  // re-init storm observed in the dogfood (back-to-back desktop_act calls
  // hitting the same DXGI failure mode were paying init cost every call).
  it("invalidate disposes the live subscription AND sets a negative-backoff marker (#327 item B)", () => {
    let counter = 0;
    let now = 0;
    const factory = vi.fn(() => {
      counter += 1;
      return new StubSubscription();
    });
    const cache = new DirtyRectSubscriptionCache(factory, () => now);

    const first = cache.acquire(0)!;
    cache.invalidate(0);
    expect(first.isDisposed).toBe(true);
    // Opus Round 1 P3-3: pin the internal contract mechanically — the
    // marker kind must be `negative-backoff`, not a delete-and-recreate.
    expect(cache._getEntryForTest(0)?.kind).toBe("negative-backoff");

    // Immediate re-acquire within the back-off window returns null fast
    // (no factory re-init — counter stays at 1).
    expect(cache.acquire(0)).toBeNull();
    expect(counter).toBe(1);

    // After NEGATIVE_BACKOFF_MS (2 s) elapses, the marker is swept and a
    // fresh factory call is permitted. Opus Round 1 P3-2: use 2_001 (= one
    // tick past the back-off window) instead of 2_000 (= boundary exactly)
    // for unambiguous past-window semantics matching the idleTimeout test's
    // 2x convention.
    now = 2_001;
    const second = cache.acquire(0)!;
    expect(second).not.toBe(first);
    expect(counter).toBe(2);
  });

  it("acquireWithState reports 'hit-subscription' on second acquire (cache fast-path)", () => {
    const factory = vi.fn(() => new StubSubscription());
    const cache = new DirtyRectSubscriptionCache(factory, () => 0);

    const first = cache.acquireWithState(0);
    expect(first.state).toBe("miss-init");

    const second = cache.acquireWithState(0);
    expect(second.state).toBe("hit-subscription");
    expect(second.sub).toBe(first.sub);
  });

  it("acquireWithState reports 'miss-init-unavailable' then 'hit-unavailable' (factory throw path)", () => {
    const factory = vi.fn(() => { throw new Error("factory cannot init"); });
    const cache = new DirtyRectSubscriptionCache(factory, () => 0);

    const first = cache.acquireWithState(0);
    expect(first.sub).toBeNull();
    expect(first.state).toBe("miss-init-unavailable");

    // Second acquire fast-paths on the cached unavailable marker.
    const second = cache.acquireWithState(0);
    expect(second.sub).toBeNull();
    expect(second.state).toBe("hit-unavailable");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("acquireWithState reports 'hit-negative-backoff' immediately after invalidate (#327 item B fast-path)", () => {
    const factory = vi.fn(() => new StubSubscription());
    const cache = new DirtyRectSubscriptionCache(factory, () => 0);

    cache.acquire(0);
    cache.invalidate(0);

    const result = cache.acquireWithState(0);
    expect(result.sub).toBeNull();
    expect(result.state).toBe("hit-negative-backoff");
    // Critical contract: invalidate must NOT trigger a 50 ms factory re-init
    // on the immediate next call. (Pre-#327B behaviour was counter === 2.)
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("STAGE5_CACHE_IDLE_TIMEOUT_MS default is 20 sec", () => {
    // Belt-and-braces: §2.4 constants table bump from 10→20 sec must remain
    // bit-equal across module + sub-plan + acceptance.
    expect(STAGE5_CONSTANTS.STAGE5_CACHE_IDLE_TIMEOUT_MS).toBe(20_000);
  });

  it("STAGE5_UNAVAILABLE_TTL_MS default is 60 sec (#327 item B follow-up)", () => {
    // Bit-equal pin: 60 s covers typical 10-30 s Claude Code round-trips so
    // the unavailable marker (vision-gpu coexistence / RDP) does not get
    // swept between back-to-back desktop_act calls.
    expect((STAGE5_CONSTANTS as { STAGE5_UNAVAILABLE_TTL_MS: number }).STAGE5_UNAVAILABLE_TTL_MS).toBe(60_000);
  });
});
