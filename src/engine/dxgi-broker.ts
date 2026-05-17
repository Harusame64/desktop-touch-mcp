/**
 * dxgi-broker.ts — ADR-020 SR-4 (Phase 3) DXGI subscription multiplex broker.
 *
 * 1 native `DirtyRectSubscription` per `outputIndex` is held by the broker;
 * consumer 2 件 (ADR-019 Stage 5 `any-change.ts` polling + ADR-005 vision-gpu
 * `dirty-rect-source.ts` callback、本 PR では未 migrate、PR-SR4-2 / PR-SR4-3 で
 * 順次 migrate) は broker subscribe API 経由でぶら下がる。これで race-loss
 * (`NotCurrentlyAvailable` 軸) を構造的に消滅させる。
 *
 * Sub-plan: `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md`
 *
 * Design lock (sub-plan §5.2, Round 2 P1-3):
 * - `BrokerSubscription` interface は `next(timeoutMs)` / `dispose()` /
 *   `isDisposed` / `outputIndex` のみ (subscribe method なし、二重 fan-out
 *   経路を構造的に禁止)。
 * - `DirtyRectBroker` class が `acquire(outputIndex)` (polling consumer) +
 *   `subscribe(outputIndex, callback)` (callback consumer) の 2 上位 API
 *   を提供、内部で 1 native subscription を multiplex。
 * - polling consumer は per-consumer queue cursor (OQ-SR4-1 候補 (c)、
 *   consumer ごとに別 buffer enqueue) で独立 drain、後発 acquire でも
 *   先発 cursor に影響しない。
 *
 * Invariant (sub-plan §2 北極星 1+2): broker は `DirtyRectSubscription`
 * の唯一 constructor caller、race-loss 軸 (`NotCurrentlyAvailable`) は
 * 構造的に発生不能。
 *
 * Dormant land (sub-plan §5.1): 本 PR では broker は caller ゼロ
 * (Stage 5 + vision-gpu は未 migrate)。既存 vitest suite 全 pass + broker
 * 単独 test ~15-20 case で動作実証、consumer migration は PR-SR4-2 / -3 で。
 */

import type { NativeDirtyRect } from "./native-types.js";
import { nativeDuplication } from "./native-engine.js";

// ─── Constants (sub-plan §5.3、broker 側私的複製、PR-SR4-2 で SSOT shift) ───

/**
 * Idle timeout for an active subscription. After 20s of no `acquire` /
 * `subscribe` / `next()` activity, the broker disposes the native
 * subscription and frees the DXGI session. Mirrors
 * `STAGE5_CACHE_IDLE_TIMEOUT_MS` (`src/engine/any-change.ts:44`) verbatim
 * — PR-SR4-2 で broker SSOT 化 + Stage 5 const を broker re-export に
 * 切替時、両定数が同 numeric 値であることを test で機械保証。
 */
const BROKER_CACHE_IDLE_TIMEOUT_MS = 20_000;

/**
 * TTL for the cached `unavailable` marker (factory throw / DXGI unsupported).
 * Mirrors `STAGE5_UNAVAILABLE_TTL_MS` (`any-change.ts:67`) — see that JSDoc
 * for the 60s tuning rationale (covers 15s lease TTL × 4 + 10-30s LLM
 * reasoning latency, avoids 50ms factory re-init storm on RDP / vision-gpu
 * permanent unavailability).
 */
const BROKER_UNAVAILABLE_TTL_MS = 60_000;

/**
 * Short-lived back-off after a `sub.next()` failure (E_DUP_ACCESS_LOST
 * recovery). Mirrors `NEGATIVE_BACKOFF_MS` (`any-change.ts:119`) — 2s is
 * long enough to absorb a chained `desktop_act` × 5 sequence and short
 * enough that AccessLost recovery surfaces within a single user turn.
 */
const BROKER_NEGATIVE_BACKOFF_MS = 2_000;

// ─── Public types ────────────────────────────────────────────────────────────

/** Minimal native subscription contract — used for test injection without
 *  the native addon. Mirrors `NativeDirtyRectSubscription` (`native-types.ts:435`). */
export interface SubscriptionLike {
  readonly isDisposed: boolean;
  next(timeoutMs: number): Promise<NativeDirtyRect[]>;
  dispose(): void;
}

/**
 * Per-consumer polling handle. **Round 2 P1-3 lock**: no `subscribe()`
 * method on this interface — fan-out is exclusively a `DirtyRectBroker`
 * upper-level API responsibility.
 *
 * Each `acquire()` call returns an independent handle whose `next()` drains
 * the handle's own per-consumer queue cursor. Disposing one handle does NOT
 * dispose the underlying native subscription; the broker dereferences the
 * native subscription once all polling handles AND callback handles for the
 * `outputIndex` are disposed AND the idle timeout has elapsed.
 */
export interface BrokerSubscription {
  readonly outputIndex: number;
  readonly isDisposed: boolean;
  next(timeoutMs: number): Promise<NativeDirtyRect[]>;
  dispose(): void;
}

/**
 * `acquire` / `subscribe` cache hit/miss telemetry. Five-value enum kept
 * bit-equal with `src/engine/any-change.ts:127` (`CacheAcquireState`) —
 * PR-SR4-2 で Stage 5 が broker から re-export に切替時、両 enum 値が
 * bit-equal であることを test で機械保証。Sub-plan §5.3 acceptance.
 */
export type CacheAcquireState =
  | "hit-subscription"
  | "hit-unavailable"
  | "hit-negative-backoff"
  | "miss-init"
  | "miss-init-unavailable";

// ─── Internal types ──────────────────────────────────────────────────────────

/**
 * Per-output entry. The `subscription` variant carries the native
 * subscription, per-consumer polling cursors, registered callbacks, and a
 * single fan-out loop that pumps `next()` results to both polling queues
 * and callback handlers.
 */
type CacheEntry =
  | {
      kind: "subscription";
      sub: SubscriptionLike;
      lastUsedAt: number;
      pollingHandles: Set<PollingHandle>;
      callbackHandles: Set<CallbackHandle>;
      /** Fan-out loop is running iff at least one polling/callback handle
       *  is registered. `null` when paused (no consumer). */
      fanOutPromise: Promise<void> | null;
      /** Set to `true` on `invalidate()` or last-consumer disposal to stop
       *  the fan-out loop on its next iteration. */
      fanOutShouldStop: boolean;
    }
  | { kind: "unavailable"; recordedAt: number }
  | { kind: "negative-backoff"; recordedAt: number };

/**
 * Per-consumer queue cursor. Each polling consumer pushes/pops on its own
 * `queue` array; `pendingResolver` is the resolver waiting on `next()`
 * (only one outstanding `next()` per handle, enforced by the public
 * contract).
 */
class PollingHandle implements BrokerSubscription {
  readonly outputIndex: number;
  isDisposed = false;
  // Per-consumer FIFO queue of dirty rect batches. Fan-out loop pushes
  // each `next()` batch onto every polling handle's queue independently.
  readonly queue: Array<NativeDirtyRect[]> = [];
  pendingResolver: ((rects: NativeDirtyRect[]) => void) | null = null;
  pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    outputIndex: number,
    private readonly onDispose: () => void,
  ) {
    this.outputIndex = outputIndex;
  }

  async next(timeoutMs: number): Promise<NativeDirtyRect[]> {
    if (this.isDisposed) return [];
    // Drain any queued batch first (fan-out loop pre-pumped these).
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    // Otherwise wait up to `timeoutMs` for the next fan-out batch.
    return new Promise<NativeDirtyRect[]>((resolve) => {
      this.pendingResolver = resolve;
      this.pendingTimer = setTimeout(() => {
        if (this.pendingResolver === resolve) {
          this.pendingResolver = null;
          this.pendingTimer = null;
          resolve([]);
        }
      }, timeoutMs);
    });
  }

  /** Called by the broker's fan-out loop when a new batch arrives. */
  _pushBatch(rects: NativeDirtyRect[]): void {
    if (this.isDisposed) return;
    if (this.pendingResolver !== null) {
      const resolver = this.pendingResolver;
      this.pendingResolver = null;
      if (this.pendingTimer !== null) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      resolver(rects);
    } else {
      this.queue.push(rects);
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.pendingResolver !== null) {
      const resolver = this.pendingResolver;
      this.pendingResolver = null;
      if (this.pendingTimer !== null) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      resolver([]);
    }
    this.queue.length = 0;
    this.onDispose();
  }
}

/** Callback consumer handle returned by `DirtyRectBroker.subscribe`. */
class CallbackHandle {
  readonly outputIndex: number;
  readonly callback: (rects: NativeDirtyRect[]) => void;
  isUnsubscribed = false;

  constructor(
    outputIndex: number,
    callback: (rects: NativeDirtyRect[]) => void,
  ) {
    this.outputIndex = outputIndex;
    this.callback = callback;
  }
}

// ─── Broker ──────────────────────────────────────────────────────────────────

/**
 * DXGI subscription multiplex broker. Sub-plan §5.2 lock.
 *
 * Lifecycle:
 * - First `acquire(0)` / `subscribe(0, ...)` constructs a native
 *   subscription (~50-100 ms DXGI init).
 * - Subsequent calls on the same `outputIndex` reuse the existing native
 *   subscription; per-consumer cursors / callback handlers are independent.
 * - 20s idle (no consumer activity) → fan-out loop drains, native
 *   subscription disposed, cache entry deleted.
 * - Last consumer dispose + idle timeout → same path.
 * - Server shutdown → `disposeAll()` releases everything.
 *
 * Coexistence (sub-plan §1.2): when 2 consumers `subscribe(0, ...)` /
 * `acquire(0)` concurrently, only one native `DirtyRectSubscription` is
 * constructed. The race-loss `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` window
 * is structurally eliminated.
 */
export class DirtyRectBroker {
  private readonly entries = new Map<number, CacheEntry>();

  constructor(
    private readonly factory: (outputIndex: number) => SubscriptionLike,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly idleTimeoutMs: number = BROKER_CACHE_IDLE_TIMEOUT_MS,
    private readonly unavailableTtlMs: number = BROKER_UNAVAILABLE_TTL_MS,
    /** Fan-out polling budget for `sub.next(timeoutMs)` calls inside the
     *  broker loop. Independent from each consumer's `next(timeoutMs)`. */
    private readonly fanOutPollMs: number = 100,
  ) {}

  /**
   * Polling consumer API (ADR-019 Stage 5 後継、PR-SR4-2 で migrate)。
   * Returns a per-consumer handle whose `next()` drains its own queue
   * cursor; concurrent polling consumers on the same `outputIndex` each
   * receive every fan-out batch independently.
   */
  acquire(outputIndex: number): {
    sub: BrokerSubscription | null;
    state: CacheAcquireState;
  } {
    this.sweepStale();
    const cached = this.entries.get(outputIndex);

    if (cached?.kind === "subscription") {
      if (!cached.sub.isDisposed) {
        cached.lastUsedAt = this.nowFn();
        const handle = this.attachPollingHandle(outputIndex, cached);
        return { sub: handle, state: "hit-subscription" };
      }
      // Disposed externally (AccessLost recovery) — drop and re-init.
      this.entries.delete(outputIndex);
    } else if (cached?.kind === "unavailable") {
      return { sub: null, state: "hit-unavailable" };
    } else if (cached?.kind === "negative-backoff") {
      return { sub: null, state: "hit-negative-backoff" };
    }

    try {
      const sub = this.factory(outputIndex);
      const entry: CacheEntry = {
        kind: "subscription",
        sub,
        lastUsedAt: this.nowFn(),
        pollingHandles: new Set(),
        callbackHandles: new Set(),
        fanOutPromise: null,
        fanOutShouldStop: false,
      };
      this.entries.set(outputIndex, entry);
      const handle = this.attachPollingHandle(outputIndex, entry);
      return { sub: handle, state: "miss-init" };
    } catch {
      this.entries.set(outputIndex, {
        kind: "unavailable",
        recordedAt: this.nowFn(),
      });
      return { sub: null, state: "miss-init-unavailable" };
    }
  }

  /**
   * Callback consumer API (ADR-005 vision-gpu 後継、PR-SR4-3 で migrate)。
   * Registers a callback to be invoked on every fan-out batch; returns an
   * unsubscribe handle.
   */
  subscribe(
    outputIndex: number,
    callback: (rects: NativeDirtyRect[]) => void,
  ): { unsubscribe: () => void; state: CacheAcquireState } {
    this.sweepStale();
    const cached = this.entries.get(outputIndex);

    if (cached?.kind === "subscription") {
      if (!cached.sub.isDisposed) {
        cached.lastUsedAt = this.nowFn();
        const unsubscribe = this.attachCallbackHandle(outputIndex, cached, callback);
        return { unsubscribe, state: "hit-subscription" };
      }
      this.entries.delete(outputIndex);
    } else if (cached?.kind === "unavailable") {
      return { unsubscribe: () => undefined, state: "hit-unavailable" };
    } else if (cached?.kind === "negative-backoff") {
      return { unsubscribe: () => undefined, state: "hit-negative-backoff" };
    }

    try {
      const sub = this.factory(outputIndex);
      const entry: CacheEntry = {
        kind: "subscription",
        sub,
        lastUsedAt: this.nowFn(),
        pollingHandles: new Set(),
        callbackHandles: new Set(),
        fanOutPromise: null,
        fanOutShouldStop: false,
      };
      this.entries.set(outputIndex, entry);
      const unsubscribe = this.attachCallbackHandle(outputIndex, entry, callback);
      return { unsubscribe, state: "miss-init" };
    } catch {
      this.entries.set(outputIndex, {
        kind: "unavailable",
        recordedAt: this.nowFn(),
      });
      return { unsubscribe: () => undefined, state: "miss-init-unavailable" };
    }
  }

  /**
   * Mark `outputIndex` for short-lived back-off after a `sub.next()` failure
   * (E_DUP_ACCESS_LOST recovery). Disposes the native subscription so the
   * next `acquire` / `subscribe` call fast-paths to `hit-negative-backoff`
   * within `BROKER_NEGATIVE_BACKOFF_MS`, then re-inits cleanly.
   */
  invalidate(outputIndex: number): void {
    const cached = this.entries.get(outputIndex);
    if (cached?.kind === "subscription") {
      cached.fanOutShouldStop = true;
      // Notify all polling handles so any pending `next()` resolves with [].
      for (const handle of cached.pollingHandles) {
        handle._pushBatch([]);
      }
      if (!cached.sub.isDisposed) {
        try {
          cached.sub.dispose();
        } catch {
          /* best-effort */
        }
      }
    }
    this.entries.set(outputIndex, {
      kind: "negative-backoff",
      recordedAt: this.nowFn(),
    });
  }

  /** Dispose every live native subscription. Called by the MCP server
   *  shutdown hook (sub-plan §11 R2 mitigation). */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === "subscription") {
        entry.fanOutShouldStop = true;
        for (const handle of entry.pollingHandles) {
          handle._pushBatch([]);
        }
        if (!entry.sub.isDisposed) {
          try {
            entry.sub.dispose();
          } catch {
            /* best-effort */
          }
        }
      }
    }
    this.entries.clear();
  }

  /** @internal — test-only inspection of entry state. */
  _getEntryForTest(outputIndex: number): CacheEntry | undefined {
    return this.entries.get(outputIndex);
  }

  // ─── Internal: per-consumer attach + fan-out loop ──────────────────────────

  private attachPollingHandle(
    outputIndex: number,
    entry: CacheEntry & { kind: "subscription" },
  ): PollingHandle {
    const handle = new PollingHandle(outputIndex, () => {
      entry.pollingHandles.delete(handle);
      this.maybeStopFanOut(outputIndex, entry);
    });
    entry.pollingHandles.add(handle);
    this.ensureFanOutRunning(outputIndex, entry);
    return handle;
  }

  private attachCallbackHandle(
    outputIndex: number,
    entry: CacheEntry & { kind: "subscription" },
    callback: (rects: NativeDirtyRect[]) => void,
  ): () => void {
    const handle = new CallbackHandle(outputIndex, callback);
    entry.callbackHandles.add(handle);
    this.ensureFanOutRunning(outputIndex, entry);
    return () => {
      if (handle.isUnsubscribed) return;
      handle.isUnsubscribed = true;
      entry.callbackHandles.delete(handle);
      this.maybeStopFanOut(outputIndex, entry);
    };
  }

  private ensureFanOutRunning(
    outputIndex: number,
    entry: CacheEntry & { kind: "subscription" },
  ): void {
    if (entry.fanOutPromise !== null) return;
    entry.fanOutShouldStop = false;
    entry.fanOutPromise = this.runFanOut(outputIndex, entry).finally(() => {
      entry.fanOutPromise = null;
    });
  }

  private maybeStopFanOut(
    _outputIndex: number,
    entry: CacheEntry & { kind: "subscription" },
  ): void {
    if (entry.pollingHandles.size === 0 && entry.callbackHandles.size === 0) {
      entry.fanOutShouldStop = true;
    }
  }

  /**
   * Per-output fan-out loop. Polls the native subscription and pushes each
   * batch to every polling handle's queue + every registered callback.
   * Exits when `fanOutShouldStop` flips (last consumer disposed, invalidate,
   * or disposeAll).
   *
   * **Busy-loop guard (PR-SR4-1)**: real `NativeDirtyRectSubscription.next(timeoutMs)`
   * blocks the awaiter for up to `timeoutMs` when no rects arrive; mock
   * subscriptions (test fixtures) typically resolve `[]` immediately, which
   * would turn the `while`-`continue` into a synchronous tight loop on the
   * microtask queue. Yield `fanOutPollMs` between iterations on empty
   * batches so neither production (degenerate driver) nor test stubs can
   * burn the worker fork.
   */
  private async runFanOut(
    outputIndex: number,
    entry: CacheEntry & { kind: "subscription" },
  ): Promise<void> {
    while (!entry.fanOutShouldStop && !entry.sub.isDisposed) {
      let batch: NativeDirtyRect[];
      try {
        batch = await entry.sub.next(this.fanOutPollMs);
      } catch (err) {
        // Surface DXGI lifecycle errors as cache invalidation so the next
        // `acquire`/`subscribe` enters `hit-negative-backoff`.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("E_DUP_ACCESS_LOST") || msg.includes("E_DUP_UNSUPPORTED")) {
          this.invalidate(outputIndex);
        }
        return;
      }
      if (batch.length === 0) {
        // See JSDoc: yield to keep the event loop healthy when the
        // subscription resolves `[]` synchronously.
        await new Promise<void>((r) => setTimeout(r, this.fanOutPollMs));
        continue;
      }
      // Snapshot consumers before delivery — callbacks may unsubscribe
      // synchronously inside the callback, which would mutate the Set.
      const pollers = Array.from(entry.pollingHandles);
      const callbacks = Array.from(entry.callbackHandles);
      for (const poller of pollers) {
        poller._pushBatch(batch.slice());
      }
      for (const cb of callbacks) {
        if (cb.isUnsubscribed) continue;
        try {
          cb.callback(batch.slice());
        } catch {
          /* callbacks must not crash the broker fan-out loop */
        }
      }
    }
  }

  // ─── Internal: TTL sweep ───────────────────────────────────────────────────

  private sweepStale(): void {
    const now = this.nowFn();
    for (const [key, entry] of this.entries) {
      if (entry.kind === "subscription") {
        if (
          entry.pollingHandles.size === 0 &&
          entry.callbackHandles.size === 0 &&
          now - entry.lastUsedAt >= this.idleTimeoutMs
        ) {
          entry.fanOutShouldStop = true;
          if (!entry.sub.isDisposed) {
            try {
              entry.sub.dispose();
            } catch {
              /* best-effort */
            }
          }
          this.entries.delete(key);
        }
      } else if (entry.kind === "negative-backoff") {
        if (now - entry.recordedAt >= BROKER_NEGATIVE_BACKOFF_MS) {
          this.entries.delete(key);
        }
      } else if (entry.kind === "unavailable") {
        if (now - entry.recordedAt >= this.unavailableTtlMs) {
          this.entries.delete(key);
        }
      }
    }
  }
}

// ─── Shared singleton (lazy, server-wide) ────────────────────────────────────

let _sharedBroker: DirtyRectBroker | null = null;

function defaultFactory(outputIndex: number): SubscriptionLike {
  const Ctor = nativeDuplication?.DirtyRectSubscription;
  if (typeof Ctor !== "function") {
    throw new Error("DirtyRectSubscription not available in native addon");
  }
  return new Ctor(outputIndex) as unknown as SubscriptionLike;
}

/** Lazily construct (and reuse) the process-wide broker. Returns `null`
 *  when the native addon is not available (no DXGI binding). */
export function getSharedDirtyRectBroker(): DirtyRectBroker | null {
  if (_sharedBroker !== null) return _sharedBroker;
  if (typeof nativeDuplication?.DirtyRectSubscription !== "function") return null;
  _sharedBroker = new DirtyRectBroker(defaultFactory);
  return _sharedBroker;
}

/** Dispose the shared broker. Called by the MCP server shutdown hook so the
 *  DXGI session is released cleanly (sub-plan §11 R2 mitigation). */
export function disposeSharedDirtyRectBroker(): void {
  _sharedBroker?.disposeAll();
  _sharedBroker = null;
}

/** @internal — test-only hook to swap the shared broker (or clear it). */
export function _setSharedDirtyRectBrokerForTest(
  broker: DirtyRectBroker | null,
): void {
  _sharedBroker = broker;
}

// ─── Constants re-export (for tests / future consumer migration) ─────────────

/**
 * Exported for `tests/unit/dxgi-broker.test.ts` and future PR-SR4-2 /
 * PR-SR4-3 consumer migration. Stage 5 `STAGE5_CONSTANTS`
 * (`any-change.ts:653`) is currently the SSOT; PR-SR4-2 で broker 側に SSOT
 * shift + Stage 5 を broker re-export に切替時、両定数の numeric 値が
 * bit-equal であることを test で機械保証する (sub-plan §5.3 acceptance)。
 */
export const BROKER_CONSTANTS = Object.freeze({
  BROKER_CACHE_IDLE_TIMEOUT_MS,
  BROKER_UNAVAILABLE_TTL_MS,
  BROKER_NEGATIVE_BACKOFF_MS,
});
