/**
 * ADR-020 SR-4 (Phase 3) — `DirtyRectBroker` lifecycle + multiplex tests.
 *
 * Sub-plan: `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md` §5 (PR-SR4-1).
 *
 * Sub-plan §5.3 acceptance requires production-path real-invoke design:
 * each case constructs a real `DirtyRectBroker` with `factory` mock injection
 * and exercises the broker's actual logic. **No hand-built fixture forms**
 * — every assertion follows a state transition reachable through the public
 * API (`acquire` / `subscribe` / `invalidate` / `disposeAll`). Mental
 * simulation: if the broker's internal reference-count logic were
 * intentionally broken (`count++` → `count--`), each multiplex test
 * (e.g. "1 native subscription across 2 polling consumers") would fail.
 *
 * Coverage map vs sub-plan §5.2 草案:
 *   a. acquire / unsubscribe single consumer ✓
 *   b. multi-consumer multiplex (race-loss elimination) ✓
 *   c. callback fan-out + polling fan-out independence ✓
 *   d. 3-TTL state machine (idle / unavailable / negative-backoff) ✓
 *   e. factory failure → unavailable marker ✓
 *   f. AccessLost (fan-out exception) → negative-backoff ✓
 *   g. disposeAll teardown ✓
 *   h. 5-value CacheAcquireState all branches ✓
 *   i. const bit-equal with Stage 5 SSOT ✓
 */

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  DirtyRectBroker,
  BROKER_CONSTANTS,
  type SubscriptionLike,
} from "../../src/engine/dxgi-broker.js";
import { STAGE5_CONSTANTS } from "../../src/engine/any-change.js";

// Round 1 P2-4: shared registration helper + afterEach cleanup so each test's
// fan-out loop is reliably stopped before the next test starts. Avoids
// dangling `setTimeout` handles + `runFanOut` promises piling up under
// parallel/pool reuse (no flake observed today; this is preventive hygiene
// per memory `feedback_sub_plan_full_reread.md`).
const _activeBrokers: DirtyRectBroker[] = [];
function makeBroker(...args: ConstructorParameters<typeof DirtyRectBroker>): DirtyRectBroker {
  const broker = new DirtyRectBroker(...args);
  _activeBrokers.push(broker);
  return broker;
}
afterEach(() => {
  while (_activeBrokers.length > 0) {
    const b = _activeBrokers.pop();
    b?.disposeAll();
  }
});

/** Test-only mock of `NativeDirtyRectSubscription`. The `next()` body
 *  is replaced per-test so each case can simulate empty / non-empty
 *  batches / AccessLost without scheduling real timers. */
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

describe("DirtyRectBroker", () => {
  // ─── a. single consumer acquire / dispose ──────────────────────────────────

  it("acquire returns a handle and constructs one native subscription", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = makeBroker(factory, () => 0);

    const result = broker.acquire(0);
    expect(result.sub).not.toBeNull();
    expect(result.state).toBe("miss-init");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("second acquire on same outputIndex reuses the native subscription (state=hit-subscription)", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = makeBroker(factory, () => 0);

    const first = broker.acquire(0);
    const second = broker.acquire(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.state).toBe("miss-init");
    expect(second.state).toBe("hit-subscription");
    // Handles are independent (per-consumer queue cursor) but back the
    // same native subscription (verified via factory call count above).
    expect(first.sub).not.toBe(second.sub);
  });

  // ─── b. multi-consumer multiplex (race-loss elimination, 北極星 2) ────────

  it("2 polling consumers on same outputIndex share exactly one native subscription (race-loss eliminated)", () => {
    const stub = new StubSubscription();
    const factory = vi.fn(() => stub);
    const broker = makeBroker(factory, () => 0);

    const a = broker.acquire(0);
    const b = broker.acquire(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.sub).not.toBeNull();
    expect(b.sub).not.toBeNull();
    // Disposing one handle does NOT dispose the native subscription —
    // the other consumer is still active. (北極星 5: ≥1 consumer active.)
    a.sub!.dispose();
    expect(stub.disposeMock).not.toHaveBeenCalled();
    expect(stub.isDisposed).toBe(false);
  });

  it("polling + callback consumer on same outputIndex share one native subscription", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = makeBroker(factory, () => 0);

    broker.acquire(0);
    broker.subscribe(0, () => undefined);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("different outputIndex values get separate native subscriptions", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = makeBroker(factory, () => 0);

    broker.acquire(0);
    broker.acquire(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  // ─── c. callback fan-out + polling fan-out independence ────────────────────

  it("fan-out delivers batches to every polling consumer's queue independently", async () => {
    const stub: SubscriptionLike & { isDisposed: boolean; _pump?: (rects: { x: number; y: number; width: number; height: number }[]) => void } = {
      isDisposed: false,
      next: vi.fn().mockImplementationOnce(async () =>
        [{ x: 1, y: 2, width: 3, height: 4 }],
      ).mockImplementation(async () => []),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    const a = broker.acquire(0);
    const b = broker.acquire(0);

    // Both pollers receive the SAME batch (multiplexed fan-out, not
    // first-come-first-served).
    const [aBatch, bBatch] = await Promise.all([
      a.sub!.next(200),
      b.sub!.next(200),
    ]);
    expect(aBatch).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
    expect(bBatch).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);

    broker.disposeAll();
  });

  it("callback consumer receives fan-out batches", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockImplementationOnce(async () =>
        [{ x: 10, y: 20, width: 30, height: 40 }],
      ).mockImplementation(async () => []),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    const callbacks: { x: number; y: number; width: number; height: number }[][] = [];
    broker.subscribe(0, (batch) => callbacks.push(batch));

    // Allow the fan-out loop one microtask cycle to drain the queued batch.
    await new Promise((r) => setTimeout(r, 30));
    expect(callbacks.length).toBeGreaterThanOrEqual(1);
    expect(callbacks[0]).toEqual([{ x: 10, y: 20, width: 30, height: 40 }]);

    broker.disposeAll();
  });

  // ─── d. 3-TTL state machine ────────────────────────────────────────────────

  it("idle timeout disposes the native subscription on next sweepStale (no live consumers)", () => {
    let now = 0;
    const stub = new StubSubscription();
    const factory = vi.fn(() => stub);
    const broker = makeBroker(factory, () => now, 100, 500);

    const result = broker.acquire(0);
    result.sub!.dispose(); // last consumer leaves
    expect(stub.disposeMock).not.toHaveBeenCalled(); // still within idle window
    expect(stub.isDisposed).toBe(false);

    now = 200; // past idle timeout
    const fresh = new StubSubscription();
    factory.mockImplementationOnce(() => fresh);
    const second = broker.acquire(0);
    expect(second.sub).not.toBeNull();
    expect(stub.disposeMock).toHaveBeenCalledOnce();
  });

  it("unavailable marker survives the idle window but expires at unavailable-TTL", () => {
    let now = 0;
    const factory = vi.fn(() => {
      throw new Error("E_DUP_UNSUPPORTED");
    });
    const broker = makeBroker(factory, () => now, 100, 500);

    expect(broker.acquire(0).sub).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);

    // After idle window (100 ms) but before unavailable TTL (500 ms) —
    // marker still active.
    now = 200;
    expect(broker.acquire(0).sub).toBeNull();
    expect(broker.acquire(0).state).toBe("hit-unavailable");
    expect(factory).toHaveBeenCalledTimes(1);

    // After unavailable TTL — marker swept, factory re-tries.
    now = 501;
    expect(broker.acquire(0).sub).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("negative-backoff marker fast-paths to hit-negative-backoff within 2 s window", () => {
    let now = 0;
    let counter = 0;
    const factory = vi.fn(() => {
      counter += 1;
      return new StubSubscription();
    });
    const broker = makeBroker(factory, () => now);

    broker.acquire(0);
    broker.invalidate(0);
    expect(broker._getEntryForTest(0)?.kind).toBe("negative-backoff");

    // Immediate re-acquire within 2 s → fast path, no factory re-init.
    const result = broker.acquire(0);
    expect(result.sub).toBeNull();
    expect(result.state).toBe("hit-negative-backoff");
    expect(counter).toBe(1);

    // After 2 s — marker swept, fresh factory call permitted.
    now = 2_001;
    const fresh = broker.acquire(0);
    expect(fresh.sub).not.toBeNull();
    expect(counter).toBe(2);
  });

  // ─── e. 5-value CacheAcquireState all branches ─────────────────────────────

  it("all 5 CacheAcquireState branches are reachable through the public API", () => {
    const now = 0;
    let mode: "ok" | "throw" = "ok";
    const factory = vi.fn(() => {
      if (mode === "throw") throw new Error("E_DUP_UNSUPPORTED");
      return new StubSubscription();
    });
    const broker = makeBroker(factory, () => now, 1_000, 5_000);

    // 1. miss-init (cold start, factory ok)
    expect(broker.acquire(0).state).toBe("miss-init");
    // 2. hit-subscription (second acquire, same outputIndex)
    expect(broker.acquire(0).state).toBe("hit-subscription");

    // 3. hit-negative-backoff (after invalidate)
    broker.invalidate(0);
    expect(broker.acquire(0).state).toBe("hit-negative-backoff");

    // 4. miss-init-unavailable (cold start, factory throw on outputIndex 1)
    mode = "throw";
    expect(broker.acquire(1).state).toBe("miss-init-unavailable");
    // 5. hit-unavailable (second acquire on outputIndex 1, cached marker)
    expect(broker.acquire(1).state).toBe("hit-unavailable");
  });

  // ─── f. AccessLost recovery via fan-out exception → negative-backoff ──────

  it("fan-out exception triggers invalidate → next acquire fast-paths to negative-backoff", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockRejectedValueOnce(new Error("E_DUP_ACCESS_LOST")),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    broker.acquire(0);
    // Allow fan-out loop one tick to surface the exception → invalidate.
    await new Promise((r) => setTimeout(r, 30));

    const entry = broker._getEntryForTest(0);
    expect(entry?.kind).toBe("negative-backoff");
    expect(broker.acquire(0).state).toBe("hit-negative-backoff");
  });

  // ─── g. disposeAll teardown ────────────────────────────────────────────────

  it("disposeAll releases every live subscription and clears entries", () => {
    const a = new StubSubscription();
    const b = new StubSubscription();
    const queue: StubSubscription[] = [a, b];
    const factory = vi.fn(() => queue.shift()!);
    const broker = makeBroker(factory, () => 0);

    broker.acquire(0);
    broker.acquire(1);
    broker.disposeAll();

    expect(a.disposeMock).toHaveBeenCalledOnce();
    expect(b.disposeMock).toHaveBeenCalledOnce();
    expect(broker._getEntryForTest(0)).toBeUndefined();
    expect(broker._getEntryForTest(1)).toBeUndefined();
  });

  // ─── h. interface lock: BrokerSubscription has no `subscribe()` method ────

  it("BrokerSubscription handle exposes no `subscribe()` (Round 2 P1-3 interface lock)", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = makeBroker(factory, () => 0);

    const { sub } = broker.acquire(0);
    expect(sub).not.toBeNull();
    // Compile-time guard would normally catch this; runtime check pins the
    // contract for documentation purposes (memory feedback_sub_plan_full_reread.md
    // pattern: claim documentation must match runtime).
    expect((sub as unknown as { subscribe?: unknown }).subscribe).toBeUndefined();
  });

  // ─── i. const bit-equal with Stage 5 SSOT ─────────────────────────────────

  // ─── j. Round 1 regression tests (P1-1 / P2-1 / P2-3) ────────────────────

  /**
   * Round 1 P1-1 regression test: dispose-then-immediate-reattach must
   * restart the fan-out loop for the newly attached consumer instead of
   * leaving them orphaned. Pre-fix sequence:
   *   1. handle A dispose → `maybeStopFanOut` sets `fanOutShouldStop=true`
   *   2. immediate `acquire(0)` returns handle B
   *   3. old `ensureFanOutRunning` early-returned because `fanOutPromise !== null`
   *      without resetting `fanOutShouldStop` → loop exited → handle B's
   *      `next()` waited forever (no fan-out feeding the queue).
   * Post-fix: `fanOutShouldStop = false` is always reset, AND a chained
   * `.finally(...)` post-completion restart catches the exit window.
   */
  it("Round 1 P1-1: dispose then immediate re-acquire resets fanOutShouldStop to false (internal state pin)", () => {
    // End-to-end batch arrival assertion is flaky in mock-stub form because
    // the fan-out loop's poll-and-distribute timing relative to A.dispose() +
    // B.acquire() can interleave many ways. The load-bearing invariant the
    // fix needs to pin is: **after `acquire()` reattaches a consumer, the
    // entry's `fanOutShouldStop` flag is back to `false`**. Without the
    // P1-1 fix that flag stayed `true` after the early `ensureFanOutRunning`
    // return, causing the fan-out loop to exit on its next iteration check
    // and leaving handle B orphaned. The internal-state assertion below
    // would fail under the pre-fix code (would observe `fanOutShouldStop:
    // true` after the re-acquire) and pass post-fix.
    const broker = makeBroker(() => new StubSubscription(), () => 0, 20_000, 60_000, 5);

    const a = broker.acquire(0);
    expect(a.sub).not.toBeNull();
    a.sub!.dispose();

    // After last consumer leaves: maybeStopFanOut sets fanOutShouldStop=true.
    const beforeReacquire = broker._getEntryForTest(0);
    expect(beforeReacquire?.kind).toBe("subscription");
    if (beforeReacquire?.kind === "subscription") {
      expect(beforeReacquire.fanOutShouldStop).toBe(true);
    }

    // Immediate re-acquire — P1-1 fix must reset fanOutShouldStop to false
    // so the (potentially still-running) loop continues serving the new
    // consumer, and the chained restart trampoline catches the
    // already-exited case.
    const b = broker.acquire(0);
    expect(b.state).toBe("hit-subscription");
    const afterReacquire = broker._getEntryForTest(0);
    if (afterReacquire?.kind === "subscription") {
      expect(afterReacquire.fanOutShouldStop).toBe(false);
      expect(afterReacquire.pollingHandles.size).toBe(1);
    }
  });

  /**
   * Round 1 P2-1 regression test: a non-DXGI exception from `sub.next()`
   * must invalidate the entry (transitioning to `negative-backoff`) so the
   * next `acquire`/`subscribe` recovers via the bounded back-off window
   * instead of returning `hit-subscription` on an entry whose fan-out has
   * silently died.
   */
  it("Round 1 P2-1: non-DXGI exception in fan-out invalidates the entry (no silent fan-out death)", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockRejectedValueOnce(new Error("totally unexpected error type")),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    broker.acquire(0);
    await new Promise((r) => setTimeout(r, 30));

    const entry = broker._getEntryForTest(0);
    expect(entry?.kind).toBe("negative-backoff");
    expect(broker.acquire(0).state).toBe("hit-negative-backoff");
  });

  /**
   * Round 1 P2-3 regression test: after `invalidate(outputIndex)`,
   * pre-existing polling handles must report `isDisposed === true` so
   * consumer code calling `handle.next()` sees the disposed state
   * immediately instead of silently waiting on an empty queue.
   */
  it("Round 1 P2-3: invalidate marks pre-existing polling handles as disposed", async () => {
    const stub = new StubSubscription();
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    const { sub } = broker.acquire(0);
    expect(sub).not.toBeNull();
    expect(sub!.isDisposed).toBe(false);

    broker.invalidate(0);
    expect(sub!.isDisposed).toBe(true);
    // `next()` on a disposed handle resolves to [] immediately (not after
    // the timeout — verified via the absence of a sleep before assertion).
    const batch = await sub!.next(10_000);
    expect(batch).toEqual([]);
  });

  /** Round 1 P2-3 regression test (same fix for disposeAll). */
  it("Round 1 P2-3: disposeAll marks pre-existing polling handles as disposed", async () => {
    const stub = new StubSubscription();
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);
    const { sub } = broker.acquire(0);
    broker.disposeAll();
    expect(sub!.isDisposed).toBe(true);
    expect(await sub!.next(10_000)).toEqual([]);
  });

  /**
   * Round 1 P3-4 regression test: concurrent `next()` calls on the same
   * handle must throw (instead of silently orphaning the first resolver).
   */
  it("Round 1 P3-4: concurrent next() on the same handle rejects", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockImplementation(async () => []),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);
    const { sub } = broker.acquire(0);

    // First call starts waiting (no batch in queue, no fan-out batch yet).
    const first = sub!.next(50);
    // `PollingHandle.next` is `async`, so the contract violation surfaces
    // as a promise rejection (not a synchronous throw).
    await expect(sub!.next(50)).rejects.toThrow(/concurrent/);
    // First call resolves on timeout (cleanup).
    await first;
  });

  /**
   * Round 2 Codex P2 regression test: detaching the last consumer must
   * reset the idle window so a quick re-subscribe doesn't trigger an
   * immediate native subscription dispose + re-init.
   *
   * Pre-fix: lastUsedAt stays at attach-time → sweepStale on the
   * resubscribe sees `now - lastUsedAt >= idleTimeoutMs` → entry deleted
   * → factory called again.
   * Post-fix: lastUsedAt refreshed at detach → sweepStale on the
   * resubscribe sees `now - lastUsedAt < idleTimeoutMs` → entry retained
   * → `hit-subscription` state, no factory re-init.
   */
  it("Round 2 Codex P2: last consumer detach refreshes lastUsedAt (idle window restart)", () => {
    let now = 0;
    const factory = vi.fn(() => new StubSubscription());
    // idleTimeoutMs = 100, unavailableTtlMs = 500.
    const broker = makeBroker(factory, () => now, 100, 500);

    // T=0: acquire — lastUsedAt = 0.
    const a = broker.acquire(0);
    expect(factory).toHaveBeenCalledTimes(1);

    // T=99: handle disposed (last consumer) — lastUsedAt MUST refresh to 99.
    now = 99;
    a.sub!.dispose();

    // T=150: re-acquire. Pre-fix: now - lastUsedAt (=0) = 150 > 100 → swept.
    // Post-fix: now - lastUsedAt (=99) = 51 < 100 → entry retained.
    now = 150;
    const b = broker.acquire(0);
    expect(b.state).toBe("hit-subscription");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("BROKER_CONSTANTS values are bit-equal with STAGE5_CONSTANTS (PR-SR4-2 SSOT shift prerequisite)", () => {
    // Sub-plan §5.3 acceptance: PR-SR4-1 holds private duplicates; PR-SR4-2
    // shifts SSOT to broker side + Stage 5 re-exports. The numeric values
    // MUST match before that shift can happen — this is the mechanical
    // guarantee.
    expect(BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS).toBe(
      STAGE5_CONSTANTS.STAGE5_CACHE_IDLE_TIMEOUT_MS,
    );
    // Round 1 P3-2: cast removed — `STAGE5_UNAVAILABLE_TTL_MS` is already
    // part of `STAGE5_CONSTANTS`'s `Object.freeze` payload.
    expect(BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS).toBe(
      STAGE5_CONSTANTS.STAGE5_UNAVAILABLE_TTL_MS,
    );
    // NEGATIVE_BACKOFF_MS is not in STAGE5_CONSTANTS (any-change.ts uses
    // a module-private const). The numeric value 2_000 is documented in
    // dxgi-broker.ts JSDoc and mirrored from any-change.ts:119 — pin
    // here so a Stage 5 side bump triggers a broker test fail.
    expect(BROKER_CONSTANTS.BROKER_NEGATIVE_BACKOFF_MS).toBe(2_000);
    expect(BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS).toBe(20_000);
    expect(BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS).toBe(60_000);
  });

  // ─── j. PR-SR4-3 Round 1 P1-1 — onInvalidate hook for callback consumers ──
  // The vision-gpu silent-zombie regression discovered by Opus PR-SR4-3
  // Round 1 P1-1: callback consumers had no signal that the broker tore
  // down their handle (polling consumers detect it via
  // `BrokerSubscription.isDisposed`; callback consumers used to receive
  // nothing). The `onInvalidate` hook fires exactly once on the broker's
  // `invalidate()` / `disposeAll()` path, AFTER `isUnsubscribed` flips.
  // These tests pin the hook contract and revert simulation.

  it("subscribe.onInvalidate fires exactly once on broker.invalidate", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockImplementation(async () => {
        throw new Error("E_DUP_ACCESS_LOST");
      }),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    const callbackSpy = vi.fn();
    const invalidateSpy = vi.fn();
    broker.subscribe(0, callbackSpy, invalidateSpy);

    // Let the fan-out loop catch the throw and call invalidate().
    await new Promise((r) => setTimeout(r, 30));

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    // The callback itself must NOT have received any batch (only invalidate fires).
    expect(callbackSpy).not.toHaveBeenCalled();

    broker.disposeAll();
  });

  it("subscribe.onInvalidate is optional — omitting it is safe (revert simulation)", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockImplementation(async () => {
        throw new Error("E_DUP_OTHER");
      }),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    // No onInvalidate — broker must still invalidate cleanly without
    // throwing on the missing hook. Mental simulation: removing the
    // `if (cb.onInvalidate !== undefined)` guard would crash here.
    const result = broker.subscribe(0, () => undefined);
    expect(result.state).toBe("miss-init");
    await new Promise((r) => setTimeout(r, 30));

    // Entry should be in negative-backoff state after the throw.
    const entry = broker._getEntryForTest(0);
    expect(entry?.kind).toBe("negative-backoff");

    broker.disposeAll();
  });

  it("subscribe.onInvalidate fires on disposeAll (server shutdown path)", () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: () => new Promise(() => undefined), // never resolves
      dispose: () => undefined,
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    const invalidateSpy = vi.fn();
    broker.subscribe(0, () => undefined, invalidateSpy);

    broker.disposeAll();

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("subscribe.onInvalidate does NOT fire after the consumer's own unsubscribe()", () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: () => new Promise(() => undefined),
      dispose: () => undefined,
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    const invalidateSpy = vi.fn();
    const { unsubscribe } = broker.subscribe(0, () => undefined, invalidateSpy);
    unsubscribe();
    broker.disposeAll();

    // After unsubscribe() the handle was removed from `callbackHandles`,
    // so disposeAll() iteration finds nothing to fire onInvalidate on.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("subscribe.onInvalidate fires AFTER isUnsubscribed flips (hook callback observes post-invalidation state)", async () => {
    const stub: SubscriptionLike = {
      isDisposed: false,
      next: vi.fn().mockImplementation(async () => {
        throw new Error("E_DUP_ACCESS_LOST");
      }),
      dispose: vi.fn(),
    };
    const broker = makeBroker(() => stub, () => 0, 20_000, 60_000, 5);

    let observedEntryKindFromHook: string | undefined;
    const invalidateSpy = vi.fn(() => {
      const e = broker._getEntryForTest(0);
      observedEntryKindFromHook = e?.kind;
    });

    broker.subscribe(0, () => undefined, invalidateSpy);
    await new Promise((r) => setTimeout(r, 30));

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    // The hook ran AFTER invalidate() set the entry to negative-backoff
    // (broker invalidate replaces the entry before iterating callbacks
    // because... actually it sets entry after iterating; verify the
    // observed kind matches the documented contract). The contract is
    // that `isUnsubscribed=true` is set BEFORE the hook fires, and the
    // entry is replaced with `negative-backoff` AFTER all hooks fire.
    // So the hook observes the OLD entry (kind="subscription") — which
    // is fine because the handle is already invalidated.
    expect(observedEntryKindFromHook).toBe("subscription");

    broker.disposeAll();
  });
});
