/**
 * dirty-rect-router.test.ts
 *
 * Unit tests for DirtyRectRouter (visual-gpu Phase 3) after ADR-020 SR-4
 * PR-SR4-3 broker migration. Pre-SR-4 the router owned an
 * `addon["DirtyRectSubscription"]` instance via an untyped escape hatch and
 * ran its own `_loop` + 100 ms AccessLost back-off; post-SR-4 it subscribes
 * to the shared `DirtyRectBroker` and receives fan-out batches via callback
 * (no `_loop`, no error inspection — broker folds mid-flight errors into
 * `invalidate()`).
 *
 * Tests inject a real `DirtyRectBroker` (`broker?` option) constructed with
 * a mock factory + fast `fanOutPollMs` so the fan-out loop drains quickly
 * without scheduling real DXGI timers.
 *
 * Test surface design (sub-plan §7.3 acceptance):
 *   1. recognize mode triggers onRois ✓
 *   2. empty rects → no onRois ✓
 *   3. broker invalidates mid-flight (AccessLost / Unsupported / Other) →
 *      callback silently stops; subsequent broker.subscribe within 2 s
 *      returns `hit-negative-backoff` (deferred to broker test suite —
 *      see `tests/unit/dxgi-broker.test.ts`)
 *   4. broker.subscribe returns `miss-init-unavailable` (factory threw) →
 *      onFallback
 *   5. broker=null (native addon absent) → onFallback
 *   6. stop() unsubscribes from broker
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DirtyRectRouter } from "../../src/engine/vision-gpu/dirty-rect-source.js";
import {
  BROKER_CONSTANTS,
  DirtyRectBroker,
  type SubscriptionLike,
} from "../../src/engine/dxgi-broker.js";

type MockRect = { x: number; y: number; width: number; height: number };

const RECT: MockRect = { x: 10, y: 20, width: 100, height: 50 };

/** Fast fan-out so the broker drains the mock subscription within a few
 *  microtask cycles. Real production cadence is 100 ms. */
const FAST_FANOUT_POLL_MS = 1;

/**
 * Build a mock `SubscriptionLike` that emits `responses` one-per-`next()`
 * call, then throws `E_DUP_DISPOSED` (so the broker's fan-out loop exits
 * cleanly via the uniform `invalidate()` path).
 */
function makeMockSub(responses: Array<MockRect[] | Error>): SubscriptionLike {
  let disposed = false;
  let callIdx = 0;
  return {
    get isDisposed() {
      return disposed;
    },
    async next(_timeoutMs: number) {
      if (disposed) throw new Error("E_DUP_DISPOSED: subscription disposed");
      if (callIdx >= responses.length) {
        throw new Error("E_DUP_DISPOSED: all responses consumed");
      }
      const r = responses[callIdx++];
      if (r instanceof Error) throw r;
      return r as MockRect[];
    },
    dispose() {
      disposed = true;
    },
  };
}

/**
 * Construct a real broker around a mock factory. Keeps Stage 5 SSOT
 * constants for TTL / back-off so test semantics line up with production,
 * but uses `FAST_FANOUT_POLL_MS` so the fan-out loop pumps the mock
 * subscription as fast as the microtask scheduler allows.
 */
function brokerFromFactory(
  factory: (outputIndex: number) => SubscriptionLike,
): DirtyRectBroker {
  return new DirtyRectBroker(
    factory,
    () => 0, // nowFn
    BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS,
    BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS,
    FAST_FANOUT_POLL_MS,
    BROKER_CONSTANTS.BROKER_NEGATIVE_BACKOFF_MS,
  );
}

/** Wait for all pending microtasks to drain. */
async function drain(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Case 1: onRois called on recognize ────────────────────────────────────────
describe("Case 1: recognize mode triggers onRois", () => {
  it("calls onRois when dirty rects are present and no cooldown", async () => {
    const onRois = vi.fn();
    const sub = makeMockSub([[RECT]]);
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois,
      broker,
    });
    router.start();
    await drain(40);

    expect(onRois).toHaveBeenCalledTimes(1);
    const [rois] = onRois.mock.calls[0] as [unknown[]];
    expect(Array.isArray(rois)).toBe(true);
    expect((rois as unknown[]).length).toBeGreaterThan(0);
    router.stop();
    broker.disposeAll();
  });
});

// ── Case 2: empty frame → continue (no onRois) ───────────────────────────────
describe("Case 2: empty dirty rect frame does not trigger onRois", () => {
  it("skips onRois when fan-out batch is empty (broker filters [] before fan-out)", async () => {
    const onRois = vi.fn();
    // Broker fan-out loop skips empty batches entirely — callbacks only
    // see non-empty arrays. Script a single empty batch to confirm.
    const sub = makeMockSub([[]]);
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois,
      broker,
    });
    router.start();
    await drain(40);

    expect(onRois).not.toHaveBeenCalled();
    router.stop();
    broker.disposeAll();
  });
});

// ── Case 3: broker invalidates mid-flight → router receives onInvalidate hook
describe("Case 3: broker invalidates after sub.next() throws — onInvalidate hook fires onFallback", () => {
  it("invokes onFallback when AccessLost folds via broker.invalidate (no silent zombie)", async () => {
    const onRois = vi.fn();
    const onFallback = vi.fn();
    const sub = makeMockSub([
      new Error("E_DUP_ACCESS_LOST: session lost"),
    ]);
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois,
      onFallback,
      broker,
    });
    router.start();
    await drain(40);

    // PR-SR4-3 Round 1 P1-1 fix: the broker's fan-out catches the throw,
    // calls `invalidate()`, and fires the registered `onInvalidate` hook.
    // The router surfaces this via `onFallback` so the caller chain
    // (`desktop-register.ts`) can decide whether to rebuild the router —
    // pre-fix the router would silently zombie with `running=true` and
    // a stale `unsubscribe` handle, with no signal that the broker had
    // torn down its callback registration.
    expect(onRois).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("broker invalidated"),
    );
    router.stop();
    broker.disposeAll();
  });

  it("any sub.next() throw (Unsupported / Other) folds uniformly through onInvalidate", async () => {
    const onRois = vi.fn();
    const onFallback = vi.fn();
    const sub = makeMockSub([new Error("E_DUP_OTHER: GPU crash")]);
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois,
      onFallback,
      broker,
    });
    router.start();
    await drain(40);

    // PR-SR4-3 Round 1 P1-1: pre-SR-4 the router string-matched E_DUP_OTHER
    // → onFallback. Post-SR-4 broker folds every mid-flight error uniformly
    // via invalidate() + onInvalidate hook → router surfaces onFallback
    // with a uniform "broker invalidated" message (no error-type leak).
    expect(onRois).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("broker invalidated"),
    );
    router.stop();
    broker.disposeAll();
  });

  it("broker.disposeAll() also fires onInvalidate (server shutdown path)", () => {
    const onFallback = vi.fn();
    // Long-running sub so the fan-out keeps the entry alive until we
    // explicitly tear down via disposeAll.
    const sub: SubscriptionLike = {
      isDisposed: false,
      next: () => new Promise(() => undefined),
      dispose: () => undefined,
    };
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      broker,
    });
    router.start();
    broker.disposeAll();

    // Server shutdown path: disposeAll() must fire the onInvalidate hook
    // for every live callback handle so consumers can release their state.
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("broker invalidated"),
    );
    router.stop();
  });

  it("onInvalidate after stop() is a no-op (no double onFallback)", () => {
    const onFallback = vi.fn();
    const sub: SubscriptionLike = {
      isDisposed: false,
      next: () => new Promise(() => undefined),
      dispose: () => undefined,
    };
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      broker,
    });
    router.start();
    router.stop(); // local teardown — sets running=false, broker still alive
    broker.disposeAll(); // would fire onInvalidate, but only on the live handle
    // After unsubscribe() (called by stop()), the handle is removed from
    // the broker's `callbackHandles` Set, so disposeAll() iteration finds
    // no live handle to fire onInvalidate on.
    expect(onFallback).not.toHaveBeenCalled();
  });
});

// ── Case 4: broker factory throws → subscribe returns miss-init-unavailable → onFallback
describe("Case 4: broker factory throws → onFallback", () => {
  it("calls onFallback when broker subscribe returns miss-init-unavailable", () => {
    const onFallback = vi.fn();
    const broker = brokerFromFactory(() => {
      throw new Error("E_DUP_UNSUPPORTED: RDP");
    });

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      broker,
    });
    router.start();

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("miss-init-unavailable"),
    );
    router.stop();
    broker.disposeAll();
  });

  it("calls onFallback when broker is in hit-unavailable state (within unavailableTtl)", () => {
    const onFallback = vi.fn();
    const broker = brokerFromFactory(() => {
      throw new Error("E_DUP_UNSUPPORTED");
    });
    // Prime the unavailable marker — first acquire sets it, second sees hit-unavailable.
    broker.acquire(0);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      broker,
    });
    router.start();

    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("hit-unavailable"),
    );
    router.stop();
    broker.disposeAll();
  });
});

// ── Case 5: broker=null (native addon absent) → onFallback ───────────────────
describe("Case 5: broker=null → onFallback", () => {
  it("calls onFallback when the shared broker is unavailable", () => {
    const onFallback = vi.fn();

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      broker: null,
    });
    router.start();

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("broker unavailable"),
    );
    router.stop();
  });
});

// ── Case 6: stop() unsubscribes from broker ─────────────────────────────────
describe("Case 6: stop() unsubscribes from broker", () => {
  it("removes the callback handle from the broker entry on stop", () => {
    // Long-running mock so the fan-out loop doesn't exit before we inspect
    // the entry. Inspection happens synchronously right after `start()` so
    // we don't even need to await the loop — only the synchronous side of
    // `broker.subscribe` (which registers the callback handle) needs to
    // complete.
    const sub: SubscriptionLike = {
      isDisposed: false,
      next: () => new Promise(() => undefined), // never resolves
      dispose: () => undefined,
    };
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      broker,
    });
    router.start();

    const entryBefore = broker._getEntryForTest(0);
    expect(entryBefore?.kind).toBe("subscription");
    if (entryBefore?.kind === "subscription") {
      expect(entryBefore.callbackHandles.size).toBe(1);
    }

    router.stop();

    const entryAfter = broker._getEntryForTest(0);
    if (entryAfter?.kind === "subscription") {
      expect(entryAfter.callbackHandles.size).toBe(0);
    }
    broker.disposeAll();
  });

  it("calling start() after stop() is safe (no double-subscribe leak)", async () => {
    const sub = makeMockSub([[RECT], [RECT]]);
    const broker = brokerFromFactory(() => sub);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      broker,
    });
    router.start();
    router.stop();
    router.start();
    await drain(20);
    router.stop();

    const entry = broker._getEntryForTest(0);
    if (entry?.kind === "subscription") {
      expect(entry.callbackHandles.size).toBe(0);
    }
    broker.disposeAll();
  });
});

// ── Case 7: outputIndex routing ──────────────────────────────────────────────
describe("Case 7: outputIndex is forwarded to broker.subscribe", () => {
  it("subscribes to the requested output index (not always 0)", () => {
    const subscribeSpy = vi.fn(() => ({
      unsubscribe: () => undefined,
      state: "miss-init" as const,
    }));
    const broker = {
      subscribe: subscribeSpy,
    } as unknown as DirtyRectBroker;

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      outputIndex: 2,
      broker,
    });
    router.start();

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy.mock.calls[0]?.[0]).toBe(2);
    router.stop();
  });

  it("defaults outputIndex to 0 when omitted", () => {
    const subscribeSpy = vi.fn(() => ({
      unsubscribe: () => undefined,
      state: "miss-init" as const,
    }));
    const broker = {
      subscribe: subscribeSpy,
    } as unknown as DirtyRectBroker;

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      broker,
    });
    router.start();

    expect(subscribeSpy.mock.calls[0]?.[0]).toBe(0);
    router.stop();
  });
});
