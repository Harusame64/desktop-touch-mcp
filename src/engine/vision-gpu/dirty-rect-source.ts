/**
 * dirty-rect-source.ts — TypeScript wrapper around `DirtyRectBroker.subscribe()`
 * (ADR-020 SR-4 PR-SR4-3; pre-SR-4 used `DirtyRectSubscription` via an
 * untyped `addon["DirtyRectSubscription"]` escape hatch with its own
 * `_loop` + 100 ms AccessLost back-off).
 *
 * Drives `RoiScheduler.scheduleRois()` with dirty-rect events from the
 * shared DXGI broker. The broker holds exactly one native subscription per
 * `outputIndex` and fan-out multiplexes Stage 5 (polling consumer,
 * `src/engine/any-change.ts`) + vision-gpu (this callback consumer) so the
 * race-loss `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` axis is **structurally
 * impossible** after PR-SR4-2 + PR-SR4-3 (sub-plan §2 北極星 2).
 *
 * Fallback (RDP, virtual display, addon absent, broker factory throw): the
 * caller's `onFallback` is invoked once with a reason and the router stops
 * — OCR-based visual_gpu (Phase 1) continues to serve as the safety net.
 *
 * Sub-plan: `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md` §7.
 *
 * Usage:
 *   const router = new DirtyRectRouter({ onRois: (rois, nowMs) => { ... } });
 *   router.start();
 *   // ... later:
 *   router.stop();
 */

import { scheduleRois } from "./roi-scheduler.js";
import type { Rect } from "./types.js";
import {
  type DirtyRectBroker,
  getSharedDirtyRectBroker,
} from "../dxgi-broker.js";

/**
 * Dirty rect shape received from the broker's fan-out callback. Matches
 * `NativeDirtyRect` (`src/engine/native-types.ts:409`) — broker forwards
 * batches verbatim from the underlying native subscription.
 */
type DirtyRect = { x: number; y: number; width: number; height: number };

export interface DirtyRectRouterOptions {
  onRois: (rois: Rect[], scheduledAtMs: number) => void;
  /** Primary monitor index (default 0). */
  outputIndex?: number;
  /**
   * Pre-SR-4 per-tick poll budget (~16 ms, 60 fps). ADR-020 SR-4 PR-SR4-3
   * superseded the local `_loop` with the broker's shared fan-out loop
   * (default 100 ms cadence; configurable on the broker constructor, not
   * per-subscriber). Retained for option-shape backward compat — no longer
   * read by the router.
   *
   * @deprecated since PR-SR4-3. The broker controls fan-out cadence.
   */
  tickMs?: number;
  /** Called when the broker is unavailable or rejects the subscription. */
  onFallback?: (reason: string) => void;
  /**
   * @internal — test-only override for the shared DXGI broker. PR-SR4-3
   * replaces the prior `subscriptionFactory` option: tests construct a real
   * `DirtyRectBroker` with a mock `factory` and inject it here. Passing
   * `null` exercises the "broker unavailable" fallback path.
   */
  broker?: DirtyRectBroker | null;
}

export class DirtyRectRouter {
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private lastScheduledMs = 0;

  constructor(private readonly opts: DirtyRectRouterOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const index = this.opts.outputIndex ?? 0;
    const broker =
      this.opts.broker !== undefined ? this.opts.broker : getSharedDirtyRectBroker();

    if (broker === null) {
      this.running = false;
      this.opts.onFallback?.("DXGI broker unavailable");
      return;
    }

    try {
      const result = broker.subscribe(
        index,
        (rects) => this._onBatch(rects),
        () => this._handleInvalidate(),
      );
      // Broker factory threw (RDP / Unsupported / Other) or unavailable marker
      // is still live. Surface the state via `onFallback` and exit; no
      // callback will fire and there is no live `unsubscribe` to keep.
      if (
        result.state === "miss-init-unavailable" ||
        result.state === "hit-unavailable" ||
        result.state === "hit-negative-backoff"
      ) {
        this.running = false;
        this.opts.onFallback?.(`broker unavailable (state=${result.state})`);
        return;
      }
      this.unsubscribe = result.unsubscribe;
    } catch (e) {
      this.running = false;
      const reason = e instanceof Error ? e.message : String(e);
      this.opts.onFallback?.(`broker subscribe failed: ${reason}`);
    }
  }

  stop(): void {
    this.running = false;
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        /* best-effort */
      }
      this.unsubscribe = null;
    }
  }

  /**
   * Fan-out callback handler. Called by the broker's fan-out loop with
   * each non-empty batch. Mid-flight DXGI errors (AccessLost / Unsupported
   * / Other) are folded by the broker into a uniform `invalidate()`
   * transition — `_handleInvalidate` below receives the dedicated hook
   * fired by the broker so the router does not silently zombie on the
   * stale `unsubscribe` handle (PR-SR4-3 Round 1 P1-1 fix). Recovery is
   * bounded by `BROKER_NEGATIVE_BACKOFF_MS` (2 s); the caller chain
   * (`desktop-register.ts`) decides whether to rebuild the router on
   * `onFallback`.
   */
  private _onBatch(rects: DirtyRect[]): void {
    if (!this.running) return;
    if (rects.length === 0) return;
    const nowMs = Date.now();
    const out = scheduleRois(
      { dirtyRects: rects, nowMs, lastScheduledMs: this.lastScheduledMs },
      {},
    );
    if (out.mode === "recognize") {
      this.lastScheduledMs = nowMs;
      this.opts.onRois(out.rois, nowMs);
    }
  }

  /**
   * PR-SR4-3 Round 1 P1-1: broker invalidation hook. Fired exactly once
   * by the broker when this handle is torn down mid-flight (uniform
   * `sub.next()` failure fold via `invalidate()` OR server-wide
   * `disposeAll()`). The router cannot recover on its own — the broker
   * entry transitions to `negative-backoff` (2 s) and re-attach is not
   * symmetric for callback handles (broker.subscribe needs a fresh call
   * from the caller). Surface via `onFallback` so the caller chain can
   * decide whether to rebuild the router; flip `running=false` and clear
   * the stale `unsubscribe` so `stop()` becomes a no-op.
   */
  private _handleInvalidate(): void {
    if (!this.running) return;
    this.running = false;
    // The broker has already removed this handle from `callbackHandles` and
    // flipped `isUnsubscribed=true`, so calling our local unsubscribe is a
    // no-op; clearing the reference avoids a redundant call from `stop()`.
    this.unsubscribe = null;
    this.opts.onFallback?.("broker invalidated subscription mid-flight");
  }
}
