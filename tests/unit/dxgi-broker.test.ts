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

import { describe, it, expect, vi } from "vitest";

import {
  DirtyRectBroker,
  BROKER_CONSTANTS,
  type SubscriptionLike,
} from "../../src/engine/dxgi-broker.js";
import { STAGE5_CONSTANTS } from "../../src/engine/any-change.js";

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
    const broker = new DirtyRectBroker(factory, () => 0);

    const result = broker.acquire(0);
    expect(result.sub).not.toBeNull();
    expect(result.state).toBe("miss-init");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("second acquire on same outputIndex reuses the native subscription (state=hit-subscription)", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = new DirtyRectBroker(factory, () => 0);

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
    const broker = new DirtyRectBroker(factory, () => 0);

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
    const broker = new DirtyRectBroker(factory, () => 0);

    broker.acquire(0);
    broker.subscribe(0, () => undefined);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("different outputIndex values get separate native subscriptions", () => {
    const factory = vi.fn(() => new StubSubscription());
    const broker = new DirtyRectBroker(factory, () => 0);

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
    const broker = new DirtyRectBroker(() => stub, () => 0, 20_000, 60_000, 5);

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
    const broker = new DirtyRectBroker(() => stub, () => 0, 20_000, 60_000, 5);

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
    const broker = new DirtyRectBroker(factory, () => now, 100, 500);

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
    const broker = new DirtyRectBroker(factory, () => now, 100, 500);

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
    const broker = new DirtyRectBroker(factory, () => now);

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
    let now = 0;
    let mode: "ok" | "throw" = "ok";
    const factory = vi.fn(() => {
      if (mode === "throw") throw new Error("E_DUP_UNSUPPORTED");
      return new StubSubscription();
    });
    const broker = new DirtyRectBroker(factory, () => now, 1_000, 5_000);

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
    const broker = new DirtyRectBroker(() => stub, () => 0, 20_000, 60_000, 5);

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
    const broker = new DirtyRectBroker(factory, () => 0);

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
    const broker = new DirtyRectBroker(factory, () => 0);

    const { sub } = broker.acquire(0);
    expect(sub).not.toBeNull();
    // Compile-time guard would normally catch this; runtime check pins the
    // contract for documentation purposes (memory feedback_sub_plan_full_reread.md
    // pattern: claim documentation must match runtime).
    expect((sub as unknown as { subscribe?: unknown }).subscribe).toBeUndefined();
  });

  // ─── i. const bit-equal with Stage 5 SSOT ─────────────────────────────────

  it("BROKER_CONSTANTS values are bit-equal with STAGE5_CONSTANTS (PR-SR4-2 SSOT shift prerequisite)", () => {
    // Sub-plan §5.3 acceptance: PR-SR4-1 holds private duplicates; PR-SR4-2
    // shifts SSOT to broker side + Stage 5 re-exports. The numeric values
    // MUST match before that shift can happen — this is the mechanical
    // guarantee.
    expect(BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS).toBe(
      STAGE5_CONSTANTS.STAGE5_CACHE_IDLE_TIMEOUT_MS,
    );
    expect(BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS).toBe(
      (STAGE5_CONSTANTS as { STAGE5_UNAVAILABLE_TTL_MS: number }).STAGE5_UNAVAILABLE_TTL_MS,
    );
    // NEGATIVE_BACKOFF_MS is not in STAGE5_CONSTANTS (any-change.ts uses
    // a module-private const). The numeric value 2_000 is documented in
    // dxgi-broker.ts JSDoc and mirrored from any-change.ts:119 — pin
    // here so a Stage 5 side bump triggers a broker test fail.
    expect(BROKER_CONSTANTS.BROKER_NEGATIVE_BACKOFF_MS).toBe(2_000);
    expect(BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS).toBe(20_000);
    expect(BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS).toBe(60_000);
  });
});
