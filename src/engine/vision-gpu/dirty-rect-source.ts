/**
 * dirty-rect-source.ts — TypeScript wrapper around DirtyRectSubscription (Phase 3).
 *
 * Drives RoiScheduler.scheduleRois() with dirty-rect events from the Desktop
 * Duplication API (via the native addon). Falls back to no-op polling mode when
 * the native addon is unavailable (RDP, headless, addon not built).
 *
 * Usage:
 *   const router = new DirtyRectRouter({ onRois: (rois, nowMs) => { ... } });
 *   router.start();
 *   // ... later:
 *   router.stop();
 */

import { createRequire } from "node:module";
import { scheduleRois } from "./roi-scheduler.js";
import type { Rect } from "./types.js";

// ESM-safe require for CJS native addon (.node binaries cannot be loaded via import()).
// Pattern mirrors index.js which also uses createRequire(import.meta.url).
const _require = createRequire(import.meta.url);

/** Minimal interface so unit tests can inject a mock subscription. */
export interface SubscriptionLike {
  readonly isDisposed: boolean;
  next(timeoutMs: number): Promise<Array<{ x: number; y: number; width: number; height: number }>>;
  dispose(): void;
}

export interface DirtyRectRouterOptions {
  onRois: (rois: Rect[], scheduledAtMs: number) => void;
  /** Primary monitor index (default 0). */
  outputIndex?: number;
  /** Max ms to wait for each frame (default 16 ≈ 60fps). */
  tickMs?: number;
  /** Called when the native path is unavailable or fails permanently. */
  onFallback?: (reason: string) => void;
  /** Override subscription factory for tests. */
  subscriptionFactory?: (outputIndex: number) => SubscriptionLike;
}

export class DirtyRectRouter {
  private sub: SubscriptionLike | null = null;
  private running = false;
  private lastScheduledMs = 0;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: DirtyRectRouterOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const index = this.opts.outputIndex ?? 0;

    try {
      if (this.opts.subscriptionFactory) {
        this.sub = this.opts.subscriptionFactory(index);
      } else {
        // Dynamically import so tests can run without the native addon.
        this.sub = createNativeSubscription(index);
      }
      void this._loop();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.opts.onFallback?.(`duplication init failed: ${reason}`);
      // No polling fallback — caller still gets OCR-based visual_gpu from Phase 1.
    }
  }

  stop(): void {
    this.running = false;
    if (this.sub && !this.sub.isDisposed) {
      try { this.sub.dispose(); } catch { /* best-effort */ }
    }
    this.sub = null;
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private async _loop(): Promise<void> {
    const tick = this.opts.tickMs ?? 16;
    while (this.running && this.sub) {
      try {
        const rects = await this.sub.next(tick);
        if (!this.running) break;
        if (rects.length === 0) continue;

        const nowMs = Date.now();
        const out = scheduleRois(
          { dirtyRects: rects, nowMs, lastScheduledMs: this.lastScheduledMs },
          {},
        );
        if (out.mode === "recognize") {
          this.lastScheduledMs = nowMs;
          this.opts.onRois(out.rois, nowMs);
        }
      } catch (e) {
        if (!this.running) break;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("E_DUP_ACCESS_LOST")) {
          // Thread re-creates context automatically; back off briefly then retry.
          await new Promise<void>((r) => setTimeout(r, 100));
          continue;
        }
        if (msg.includes("E_DUP_DISPOSED")) break;
        this.opts.onFallback?.(`duplication loop error: ${msg}`);
        break;
      }
    }
  }
}

/**
 * Attempt to construct a DirtyRectSubscription from the native addon.
 * Throws if the addon is absent or the output is unavailable (RDP etc.).
 *
 * Uses createRequire (ESM-safe) because .node CJS binaries cannot be loaded
 * via dynamic import(). Mirrors the pattern used in index.js and native-engine.ts.
 * Relative path "../../../index.js" resolves from src/engine/vision-gpu/ to project root.
 */
function createNativeSubscription(outputIndex: number): SubscriptionLike {
  const addon = _require("../../../index.js") as Record<string, unknown>;
  const Ctor = addon["DirtyRectSubscription"] as
    | (new (outputIndex?: number) => SubscriptionLike)
    | undefined;
  if (typeof Ctor !== "function") {
    throw new Error("DirtyRectSubscription not available in native addon");
  }
  return new Ctor(outputIndex);
}
