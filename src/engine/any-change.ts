/**
 * any-change.ts — ADR-019 Stage 5 `any_change` primitive orchestrator.
 *
 * Layers a thin TS orchestrator on top of the existing DXGI Desktop Duplication
 * infrastructure shipped by PR #102 (ADR-007 P5c-2). The Rust side (`src/duplication/`)
 * provides per-output `DirtyRectSubscription` napi with a background polling
 * thread; this module:
 *
 *   1. Caches subscriptions per `output_index` so chained `desktop_act` calls
 *      amortise the ~50-100 ms DXGI session init cost.
 *   2. Resolves a target window's primary monitor (output index) via
 *      `enumMonitors` + window-center containment.
 *   3. Polls dirty rects for a bounded window, intersects against the target
 *      window rect (or a sub-region), and decides `motion: any_change | no_change | indeterminate`.
 *
 * Sub-plan: `docs/adr-019-stage-5-plan.md`. Activation gates and envelope
 * wiring live at the call sites (`src/tools/desktop-register.ts` for
 * `desktop_act`; optional safety net in `src/tools/_mouse-verify.ts` +
 * `src/tools/keyboard.ts` gated on `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1`).
 *
 * Invariant: this module **must never throw** — every error path (DXGI
 * `Unsupported` / `NotCurrentlyAvailable` / `AccessLost`, resolver failure,
 * native binding absence) degrades to `motion: "indeterminate"` so the caller's
 * envelope is unaffected.
 */

import type { VisualMotionObservation } from "../tools/_input-pipeline.js";
import { nativeDuplication } from "./native-engine.js";
import type { NativeDirtyRectSubscription } from "./native-types.js";
import { enumMonitors } from "./win32.js";

// ─── Constants (Stage 5 sub-plan §2.4) ───────────────────────────────────────

/** Stage 5 sub-plan §2.4 — wallclock budget for one `next()` poll, aligned to
 *  ~6 frames at 60 Hz. Keeps `desktop_act` round-trip under sub-100 ms verify
 *  overhead. */
const STAGE5_POLL_BUDGET_MS = 100;

/** Stage 5 sub-plan §2.4 — idle timeout before the cache disposes a subscription.
 *  Bumped from 10→20 sec in Round 1 P2-1 (Stage 4 Paint.NET dogfood 20-cycle
 *  chain ≈ 10 sec sat right at the prior boundary; 2× headroom now). */
const STAGE5_CACHE_IDLE_TIMEOUT_MS = 20_000;

/** Stage 5 sub-plan §2.4 — hard cap on `outputIndex` to guard against runaway
 *  enumeration. Resolver clamps; out-of-range emits `dxgi_dirty_rect_unavailable`. */
const STAGE5_MAX_OUTPUT_INDEX = 8;

/** Stage 5 sub-plan §2.4 — relative-area gate. 0.5 % of the target rect
 *  (Round 1 P2-5: replaces an absolute 4-px count which falsely qualified
 *  background animation grazing the target rect). */
const STAGE5_MIN_INTERSECTED_AREA_RATIO = 0.005;

// ─── Subscription cache ──────────────────────────────────────────────────────

/** Minimal interface so tests can inject mock subscriptions without the
 *  native addon. Mirrors `NativeDirtyRectSubscription`. */
export interface SubscriptionLike {
  readonly isDisposed: boolean;
  next(timeoutMs: number): Promise<Array<{ x: number; y: number; width: number; height: number }>>;
  dispose(): void;
}

/** Sentinel marker recording an `Unsupported` / `NotCurrentlyAvailable` failure.
 *  Cached for `STAGE5_CACHE_IDLE_TIMEOUT_MS` to avoid the init-cost storm on
 *  RDP / virtual-display hosts (Stage 5 sub-plan §6 R4). */
type CacheEntry =
  | { kind: "subscription"; sub: SubscriptionLike; lastUsedAt: number }
  | { kind: "unavailable"; recordedAt: number };

/**
 * Singleton cache keyed by `outputIndex`. Lifecycle:
 *
 * - First `acquire(0)` constructs a subscription (~50-100 ms DXGI init).
 * - Subsequent `acquire(0)` within 20 sec returns the cached entry (~< 1 ms).
 * - 20 sec idle → background sweep disposes the entry on next `acquire` / `disposeAll`.
 * - Server shutdown calls `disposeAll` for clean exit.
 *
 * Coexistence with `src/engine/vision-gpu/dirty-rect-source.ts`: DXGI returns
 * `NotCurrentlyAvailable` for a second concurrent subscription on the same
 * output. Stage 5 fail-soft per §2.6 — the failure is cached as
 * `unavailable` for the idle timeout and the caller's observation degrades
 * to `dxgi_dirty_rect_unavailable`.
 */
export class DirtyRectSubscriptionCache {
  private readonly entries = new Map<number, CacheEntry>();

  constructor(
    private readonly factory: (outputIndex: number) => SubscriptionLike,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly idleTimeoutMs: number = STAGE5_CACHE_IDLE_TIMEOUT_MS,
  ) {}

  /**
   * Return a subscription for `outputIndex`, or `null` when DXGI is
   * unsupported / unavailable for this output. Caches the failure for the
   * idle timeout window so RDP / coexistence-locked hosts don't pay the
   * init cost on every call.
   */
  acquire(outputIndex: number): SubscriptionLike | null {
    this.sweepStale();
    const cached = this.entries.get(outputIndex);
    if (cached?.kind === "subscription") {
      if (!cached.sub.isDisposed) {
        cached.lastUsedAt = this.nowFn();
        return cached.sub;
      }
      // Disposed externally (AccessLost recovery) — drop and re-init.
      this.entries.delete(outputIndex);
    } else if (cached?.kind === "unavailable") {
      return null;
    }
    try {
      const sub = this.factory(outputIndex);
      this.entries.set(outputIndex, {
        kind: "subscription",
        sub,
        lastUsedAt: this.nowFn(),
      });
      return sub;
    } catch {
      this.entries.set(outputIndex, {
        kind: "unavailable",
        recordedAt: this.nowFn(),
      });
      return null;
    }
  }

  /** Mark `outputIndex` as `unavailable` and dispose any live subscription
   *  for it. Used by the orchestrator on `AccessLost` so the next call
   *  re-initialises after the idle window. */
  invalidate(outputIndex: number): void {
    const cached = this.entries.get(outputIndex);
    if (cached?.kind === "subscription" && !cached.sub.isDisposed) {
      try {
        cached.sub.dispose();
      } catch {
        /* best-effort */
      }
    }
    this.entries.delete(outputIndex);
  }

  /** Dispose every live subscription. Called by the MCP server shutdown
   *  hook (§6 R2). */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === "subscription" && !entry.sub.isDisposed) {
        try {
          entry.sub.dispose();
        } catch {
          /* best-effort */
        }
      }
    }
    this.entries.clear();
  }

  /** @internal — exposed for unit tests so they can assert lifecycle without
   *  faking `Date.now`. */
  _getEntryForTest(outputIndex: number): CacheEntry | undefined {
    return this.entries.get(outputIndex);
  }

  private sweepStale(): void {
    const now = this.nowFn();
    for (const [key, entry] of this.entries) {
      if (entry.kind === "subscription") {
        if (now - entry.lastUsedAt >= this.idleTimeoutMs) {
          if (!entry.sub.isDisposed) {
            try {
              entry.sub.dispose();
            } catch {
              /* best-effort */
            }
          }
          this.entries.delete(key);
        }
      } else if (now - entry.recordedAt >= this.idleTimeoutMs) {
        this.entries.delete(key);
      }
    }
  }
}

// Process-singleton cache. Constructed lazily on first orchestrator call.
let _sharedCache: DirtyRectSubscriptionCache | null = null;

function defaultFactory(outputIndex: number): SubscriptionLike {
  const Ctor = nativeDuplication?.DirtyRectSubscription;
  if (typeof Ctor !== "function") {
    throw new Error("DirtyRectSubscription not available in native addon");
  }
  return new Ctor(outputIndex) as unknown as SubscriptionLike;
}

/** Lazily construct (and reuse) the process-wide cache. */
export function getSharedSubscriptionCache(): DirtyRectSubscriptionCache | null {
  if (_sharedCache !== null) return _sharedCache;
  if (typeof nativeDuplication?.DirtyRectSubscription !== "function") return null;
  _sharedCache = new DirtyRectSubscriptionCache(defaultFactory);
  return _sharedCache;
}

/**
 * Dispose the shared cache. Called by the MCP server shutdown hook so the
 * DXGI session is released cleanly (§6 R2 mitigation).
 */
export function disposeSharedSubscriptionCache(): void {
  _sharedCache?.disposeAll();
  _sharedCache = null;
}

/** @internal — test-only hook to swap the shared cache (or clear it). */
export function _setSharedSubscriptionCacheForTest(
  cache: DirtyRectSubscriptionCache | null,
): void {
  _sharedCache = cache;
}

// ─── Output-index resolver ───────────────────────────────────────────────────

export type ResolveOutputIndexResult =
  | { ok: true; outputIndex: number; crossMonitor: boolean }
  | { ok: false; reason: "off_screen" | "no_monitors" | "out_of_range" };

/**
 * Resolve the output index of the monitor that contains the window's center
 * point. Walks `enumMonitors()` (the same path used by
 * `desktop_state({includeScreen:true})`); the monitor order returned by
 * `enumMonitors` matches the per-output `DirtyRectSubscription` order
 * (`IDXGIAdapter::EnumOutputs(i)` over the default adapter), so the index
 * is reusable as the DXGI `outputIndex` argument.
 *
 * `crossMonitor: true` when the window's rect straddles two monitors (the
 * window's screen rect overlaps more than one monitor) but the center
 * unambiguously falls inside one. Stage 5 uses this to attach a
 * `hints.warnings` entry per Stage 5 sub-plan §6 R3.
 */
export function resolveOutputIndexForHwnd(
  _hwnd: bigint,
  windowRect: { x: number; y: number; width: number; height: number },
  opts?: { enumerate?: () => Array<{ bounds: { x: number; y: number; width: number; height: number } }> },
): ResolveOutputIndexResult {
  const monitors = opts?.enumerate ? opts.enumerate() : enumMonitors();
  if (monitors.length === 0) {
    return { ok: false, reason: "no_monitors" };
  }

  const centerX = windowRect.x + windowRect.width / 2;
  const centerY = windowRect.y + windowRect.height / 2;

  let primaryIndex = -1;
  for (let i = 0; i < monitors.length; i++) {
    const b = monitors[i].bounds;
    if (
      centerX >= b.x &&
      centerX < b.x + b.width &&
      centerY >= b.y &&
      centerY < b.y + b.height
    ) {
      primaryIndex = i;
      break;
    }
  }

  if (primaryIndex < 0) {
    return { ok: false, reason: "off_screen" };
  }
  if (primaryIndex > STAGE5_MAX_OUTPUT_INDEX) {
    return { ok: false, reason: "out_of_range" };
  }

  // Detect straddling: window rect overlaps more than one monitor's bounds.
  let overlapCount = 0;
  for (const m of monitors) {
    const b = m.bounds;
    const ix0 = Math.max(windowRect.x, b.x);
    const iy0 = Math.max(windowRect.y, b.y);
    const ix1 = Math.min(windowRect.x + windowRect.width, b.x + b.width);
    const iy1 = Math.min(windowRect.y + windowRect.height, b.y + b.height);
    if (ix1 > ix0 && iy1 > iy0) overlapCount++;
  }

  return {
    ok: true,
    outputIndex: primaryIndex,
    crossMonitor: overlapCount > 1,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface VerifyAnyChangeOpts {
  hwnd: bigint;
  /** Window rect in screen coords (output of `getWindowRectByHwnd`). */
  windowRect: { x: number; y: number; width: number; height: number };
  /** Optional sub-rect of `windowRect` to constrain the intersection (e.g.
   *  the mouse_click pad). When omitted, the entire `windowRect` is used. */
  region?: { x: number; y: number; width: number; height: number };
  /** Wallclock budget for dirty-rect polling. Default `STAGE5_POLL_BUDGET_MS`. */
  budgetMs?: number;
  /** @internal — test-only override for the shared cache. */
  cache?: DirtyRectSubscriptionCache | null;
  /** @internal — test-only override for `enumMonitors`. */
  enumerate?: () => Array<{ bounds: { x: number; y: number; width: number; height: number } }>;
}

/**
 * Intersect two rects. Returns `null` when they don't overlap.
 */
function intersectRect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  return { x: x0, y: y0, width: w, height: h };
}

/**
 * Stage 5 sub-plan §2.1 — `any_change` primitive orchestrator. Subscribes to
 * the appropriate DXGI output, polls dirty rects for a bounded window,
 * intersects with the target rect, and returns a `VisualMotionObservation`.
 *
 * Decision matrix (§2.1 step 5):
 *
 *   intersected area ratio ≥ STAGE5_MIN_INTERSECTED_AREA_RATIO
 *     → motion: "any_change", source: "dxgi_dirty_rect", residual populated
 *   intersected area > 0 but ratio < threshold
 *     → motion: "no_change", source: "dxgi_dirty_rect", residual populated
 *   intersected area === 0 AND rects.length > 0
 *     → motion: "no_change", source: "dxgi_dirty_rect", residual populated
 *   empty rects
 *     → motion: "no_change", source: "dxgi_dirty_rect", residual omitted
 *   DXGI Unsupported / NotCurrentlyAvailable
 *     → motion: "indeterminate", source: "dxgi_dirty_rect_unavailable"
 *   AccessLost mid-flight
 *     → motion: "indeterminate", source: "dxgi_dirty_rect" + cache invalidated
 *   resolver failure (no monitors / off-screen / out of range)
 *     → motion: "indeterminate", source: "dxgi_dirty_rect_unavailable"
 *
 * Invariant (§9): never throws — degraded observations are returned instead.
 */
export async function verifyAnyChange(
  opts: VerifyAnyChangeOpts,
): Promise<VisualMotionObservation> {
  const startMs = performance.now();

  const degradeUnavailable = (): VisualMotionObservation => ({
    motion: "indeterminate",
    source: "dxgi_dirty_rect_unavailable",
    framesSampled: 0,
    totalElapsedMs: performance.now() - startMs,
  });

  const degradeAccessLost = (): VisualMotionObservation => ({
    motion: "indeterminate",
    source: "dxgi_dirty_rect",
    framesSampled: 0,
    totalElapsedMs: performance.now() - startMs,
  });

  // Resolve target monitor first — cheaper than touching the DXGI cache when
  // the window is off-screen.
  const resolution = resolveOutputIndexForHwnd(opts.hwnd, opts.windowRect, {
    enumerate: opts.enumerate,
  });
  if (!resolution.ok) {
    return degradeUnavailable();
  }

  const cache =
    opts.cache !== undefined ? opts.cache : getSharedSubscriptionCache();
  if (cache === null) {
    return degradeUnavailable();
  }

  const sub = cache.acquire(resolution.outputIndex);
  if (sub === null) {
    return degradeUnavailable();
  }

  let rects: Array<{ x: number; y: number; width: number; height: number }>;
  try {
    rects = await sub.next(opts.budgetMs ?? STAGE5_POLL_BUDGET_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("E_DUP_ACCESS_LOST")) {
      // Thread re-creates context, but the current subscription is stale —
      // invalidate so the next call re-acquires.
      cache.invalidate(resolution.outputIndex);
      return degradeAccessLost();
    }
    if (msg.includes("E_DUP_UNSUPPORTED")) {
      cache.invalidate(resolution.outputIndex);
      return degradeUnavailable();
    }
    // Disposed / Other — degrade honestly without invalidating (Disposed
    // means our consumer has already torn down).
    return degradeAccessLost();
  }

  const target = opts.region ?? opts.windowRect;
  const targetArea = Math.max(1, target.width * target.height);

  let totalIntersectedAreaPx = 0;
  for (const r of rects) {
    const hit = intersectRect(r, target);
    if (hit !== null) {
      totalIntersectedAreaPx += hit.width * hit.height;
    }
  }
  const ratioOfTargetArea = totalIntersectedAreaPx / targetArea;

  const totalElapsedMs = performance.now() - startMs;
  const framesSampled = rects.length;

  // Empty rect case — observation cleanest with `residual` omitted (§2.1 step 5
  // last bullet, G5-2 outcome (a)).
  if (rects.length === 0) {
    return {
      motion: "no_change",
      source: "dxgi_dirty_rect",
      framesSampled,
      totalElapsedMs,
    };
  }

  if (ratioOfTargetArea >= STAGE5_MIN_INTERSECTED_AREA_RATIO) {
    return {
      motion: "any_change",
      source: "dxgi_dirty_rect",
      residual: {
        fractionChanged: ratioOfTargetArea,
        dirtyRectCount: rects.length,
        totalIntersectedAreaPx,
        ratioOfTargetArea,
      },
      framesSampled,
      totalElapsedMs,
    };
  }

  // Rects observed but sub-threshold (grazing / off-target) → no_change with
  // residual populated for audit (G5-2 outcomes (b) + (c)).
  return {
    motion: "no_change",
    source: "dxgi_dirty_rect",
    residual: {
      fractionChanged: ratioOfTargetArea,
      dirtyRectCount: rects.length,
      totalIntersectedAreaPx,
      ratioOfTargetArea,
    },
    framesSampled,
    totalElapsedMs,
  };
}

// ─── Constants re-export (for unit tests + bench harness) ────────────────────

/**
 * Exported for the unit tests under `tests/unit/{any-change-orchestrator,
 * dirty-rect-subscription-cache,resolve-output-index}.test.ts` and the
 * post-impl bench harness `benches/dogfood_stage_5.mjs`. Production callers
 * MUST NOT branch on these values — they are tuning parameters, not API
 * contract.
 */
export const STAGE5_CONSTANTS = Object.freeze({
  STAGE5_POLL_BUDGET_MS,
  STAGE5_CACHE_IDLE_TIMEOUT_MS,
  STAGE5_MAX_OUTPUT_INDEX,
  STAGE5_MIN_INTERSECTED_AREA_RATIO,
});
