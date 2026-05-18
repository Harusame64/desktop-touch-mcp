/**
 * any-change.ts — ADR-019 Stage 5 `any_change` primitive orchestrator.
 *
 * Layers a thin TS orchestrator on top of the existing DXGI Desktop Duplication
 * infrastructure shipped by PR #102 (ADR-007 P5c-2). The Rust side (`src/duplication/`)
 * provides per-output `DirtyRectSubscription` napi with a background polling
 * thread; this module:
 *
 *   1. Acquires a polling handle from the **shared DXGI broker**
 *      (`src/engine/dxgi-broker.ts`, ADR-020 SR-4) so the ~50-100 ms DXGI
 *      session init cost is amortised across chained `desktop_act` calls AND
 *      shared with the vision-gpu consumer (PR-SR4-3) — race-loss
 *      `NotCurrentlyAvailable` is structurally eliminated.
 *   2. Resolves a target window's output index via `enumMonitors` +
 *      window-center containment. Works for every monitor (primary AND
 *      secondary) — PR #322 populated `outputBounds` from
 *      `DXGI_OUTPUT_DESC.DesktopCoordinates`, and PR #323 lifted the v1
 *      primary-monitor-only constraint.
 *   3. Polls dirty rects for a bounded window, intersects against the target
 *      window rect (or a sub-region), and decides `motion: any_change | no_change | indeterminate`.
 *
 * Sub-plan: `docs/adr-019-stage-5-plan.md` (PR-SR4-2 §2.6 sync).
 * Broker sub-plan: `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md`.
 * Activation gates and envelope wiring live at the call sites
 * (`src/tools/desktop-register.ts` for `desktop_act`; optional safety net in
 * `src/tools/_mouse-verify.ts` + `src/tools/keyboard.ts` gated on
 * `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1`).
 *
 * Invariant: this module **must never throw** — every error path (DXGI
 * `Unsupported` / `AccessLost` mid-flight, resolver failure, native binding
 * absence) degrades to `motion: "indeterminate"` so the caller's envelope is
 * unaffected. Race-loss `NotCurrentlyAvailable` was the third pre-SR-4 error
 * mode and is now structurally impossible (broker owner-1-固定).
 */

import type { VisualMotionObservation } from "../tools/_input-pipeline.js";
import {
  BROKER_CONSTANTS,
  type CacheAcquireState,
  type DirtyRectBroker,
  getSharedDirtyRectBroker,
} from "./dxgi-broker.js";
import { enumMonitors } from "./win32.js";

// Re-export so downstream consumers (`_input-pipeline.ts:VisualMotionObservation.cacheState`)
// can keep importing the 5-value state enum from the orchestrator's public
// surface — the SSOT is now the broker but the public re-export is preserved.
export type { CacheAcquireState };

// ─── Constants (Stage 5 sub-plan §2.4) ───────────────────────────────────────

/** Stage 5 sub-plan §2.4 — wallclock budget for one `next()` poll, aligned to
 *  ~6 frames at 60 Hz. Keeps `desktop_act` round-trip under sub-100 ms verify
 *  overhead. */
const STAGE5_POLL_BUDGET_MS = 100;

/**
 * ADR-020 SR-4 PR-SR4-2: idle timeout for the underlying DXGI subscription.
 * **The broker (`dxgi-broker.ts`) is now the SSOT** for this numeric value;
 * Stage 5 re-exports it through `STAGE5_CONSTANTS` for bench harness +
 * orchestrator unit tests so `BROKER_CACHE_IDLE_TIMEOUT_MS` and
 * `STAGE5_CACHE_IDLE_TIMEOUT_MS` are bit-equal by construction (no
 * independent definition to drift).
 *
 * Tuning rationale (carried from PR #333): 20 s gives 2× headroom over the
 * Stage 4 Paint.NET 20-cycle ≈ 10 s chain so a typical dogfood sequence
 * stays inside one broker-owned subscription lifetime; broker `acquire()`
 * the second call returns `hit-subscription` without paying ~50-100 ms DXGI
 * re-init.
 */
const STAGE5_CACHE_IDLE_TIMEOUT_MS = BROKER_CONSTANTS.BROKER_CACHE_IDLE_TIMEOUT_MS;

/**
 * ADR-020 SR-4 PR-SR4-2: separate TTL for the `unavailable` marker. SSOT is
 * the broker; Stage 5 re-exports.
 *
 * Tuning rationale (carried from issue #327 item B follow-up, 2026-05-17
 * dogfood): the `unavailable` marker records a **process-lifetime**
 * unavailability (RDP host, virtual display, vision-gpu permanently holding
 * the output). The 20 s subscription-idle was tuned for resource hygiene;
 * the 60 s unavailable TTL is tuned to absorb typical 10-30 s LLM
 * reasoning latency between chained `desktop_act` calls so the marker
 * persists across multi-step dogfood without re-paying ~50 ms DXGI init on
 * every turn that exceeds 20 s wallclock.
 */
const STAGE5_UNAVAILABLE_TTL_MS = BROKER_CONSTANTS.BROKER_UNAVAILABLE_TTL_MS;

/** Stage 5 sub-plan §2.4 — hard cap on `outputIndex` to guard against runaway
 *  enumeration on hypothetical many-monitor setups. The check
 *  `index > STAGE5_MAX_OUTPUT_INDEX` accepts indices `0..=8` (up to 9
 *  monitors total); index `>= 9` emits `dxgi_dirty_rect_unavailable` via
 *  `reason: "out_of_range"`. Opus PR #325 Round 1 P3-1: kept the
 *  `_INDEX` suffix + strict-inequality check to avoid cascading the
 *  rename through `STAGE5_CONSTANTS` consumers + unit tests; the docstring
 *  pins the inclusive-max semantic. */
const STAGE5_MAX_OUTPUT_INDEX = 8;

/** Stage 5 sub-plan §2.4 — relative-area gate. 0.5 % of the target rect
 *  (Round 1 P2-5: replaces an absolute 4-px count which falsely qualified
 *  background animation grazing the target rect). */
const STAGE5_MIN_INTERSECTED_AREA_RATIO = 0.005;

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
  /** @internal — test-only override for the shared DXGI broker.
   *  ADR-020 SR-4 PR-SR4-2: replaces the prior `cache?` option (one-to-one
   *  injection swap; orchestrator semantics preserved). */
  broker?: DirtyRectBroker | null;
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
 * Stage 5 sub-plan §2.1 — `any_change` primitive orchestrator. Acquires a
 * polling handle from the shared DXGI broker (ADR-020 SR-4 PR-SR4-2),
 * drains dirty rects for a bounded window, intersects with the target
 * rect, and returns a `VisualMotionObservation`.
 *
 * Decision matrix (§2.1 step 5, post-SR-4):
 *
 *   intersected area ratio ≥ STAGE5_MIN_INTERSECTED_AREA_RATIO
 *     → motion: "any_change", source: "dxgi_dirty_rect", residual populated
 *   intersected area > 0 but ratio < threshold
 *     → motion: "no_change", source: "dxgi_dirty_rect", residual populated
 *   intersected area === 0 AND rects.length > 0
 *     → motion: "no_change", source: "dxgi_dirty_rect", residual populated
 *   empty rects
 *     → motion: "no_change", source: "dxgi_dirty_rect", residual omitted
 *   broker factory failure (Unsupported / Other — acquire returns sub=null)
 *     → motion: "indeterminate", source: "dxgi_dirty_rect_unavailable"
 *   broker invalidates mid-flight (handle disposed during `next()`)
 *     → motion: "indeterminate", source: "dxgi_dirty_rect" (recoverable
 *       within `BROKER_NEGATIVE_BACKOFF_MS`; the next acquire surfaces
 *       `hit-negative-backoff` via cacheState which the consumer can use
 *       to distinguish from a normal empty-rects observation)
 *   resolver failure (no monitors / off-screen / out of range)
 *     → motion: "indeterminate", source: "dxgi_dirty_rect_unavailable"
 *
 * ADR-020 SR-4 PR-SR4-2 semantics shift (vs pre-broker `verifyAnyChange`):
 *   - Race-loss `NotCurrentlyAvailable` is **structurally impossible** —
 *     the broker holds the single subscription per output, no concurrent
 *     `DuplicateOutput` calls can race.
 *   - Mid-flight `sub.next()` errors (AccessLost / Unsupported / Other) are
 *     caught inside the broker's fan-out loop and folded into a uniform
 *     `invalidate()` → negative-backoff transition. The orchestrator no
 *     longer string-matches on `E_DUP_*` markers — `sub.isDisposed` after
 *     `await next()` is the canonical mid-flight failure signal.
 *
 * Invariant (§9): never throws — degraded observations are returned instead.
 */
export async function verifyAnyChange(
  opts: VerifyAnyChangeOpts,
): Promise<VisualMotionObservation> {
  const startMs = performance.now();

  // Issue #327 item B: `cacheState` is passed in by post-broker callers;
  // pre-broker callers (resolver failure, broker=null) pass `undefined` so
  // the optional field is omitted from the observation entirely.
  const degradeUnavailable = (
    cacheState?: CacheAcquireState,
  ): VisualMotionObservation => ({
    motion: "indeterminate",
    source: "dxgi_dirty_rect_unavailable",
    framesSampled: 0,
    totalElapsedMs: performance.now() - startMs,
    ...(cacheState !== undefined ? { cacheState } : {}),
  });

  const degradeAccessLost = (
    cacheState?: CacheAcquireState,
  ): VisualMotionObservation => ({
    motion: "indeterminate",
    source: "dxgi_dirty_rect",
    framesSampled: 0,
    totalElapsedMs: performance.now() - startMs,
    ...(cacheState !== undefined ? { cacheState } : {}),
  });

  // Resolve target monitor first — cheaper than touching the DXGI broker when
  // the window is off-screen.
  const resolution = resolveOutputIndexForHwnd(opts.hwnd, opts.windowRect, {
    enumerate: opts.enumerate,
  });
  if (!resolution.ok) {
    return degradeUnavailable();
  }

  // Codex PR #325 Round 1 P2 — `resolution.crossMonitor === true` signals
  // the window straddles two monitors. Stage 5 v1 intentionally observes
  // only the center-containing monitor (sub-plan §7 carry-over "Stage 5c:
  // cross-monitor straddle simultaneous subscription"). Pre-SR-4 the
  // off-monitor portion could leak via vision-gpu's parallel subscription
  // racing on output 0; post-SR-4 the broker holds a single owner so the
  // observation is a more honest lower bound (we never claim `no_change`
  // if motion is detected on the observed monitor). Stage 5c will add
  // simultaneous-output subscription. Until then we do NOT attach a
  // `hints.warnings` entry from this module because the observation shape
  // (`VisualMotionObservation`) has no `warnings` channel — sub-plan §6 R3
  // routes warnings through the caller's envelope, which can inspect
  // `crossMonitor` separately if it adopts the v2 resolver shape.
  const broker =
    opts.broker !== undefined ? opts.broker : getSharedDirtyRectBroker();
  if (broker === null) {
    return degradeUnavailable();
  }

  const acquired = broker.acquire(resolution.outputIndex);
  const acquireState: CacheAcquireState = acquired.state;
  if (acquired.sub === null) {
    return degradeUnavailable(acquireState);
  }
  const sub = acquired.sub;

  try {
    const rects = await sub.next(opts.budgetMs ?? STAGE5_POLL_BUDGET_MS);

    // ADR-020 SR-4 PR-SR4-2: broker fan-out catches every `sub.next()` error
    // uniformly and calls `invalidate(outputIndex)`, which marks our handle
    // disposed and releases the pending resolver with `[]`. Distinguish
    // "broker invalidated mid-flight" from "normal empty-rects observation"
    // via `sub.isDisposed`. The cacheState propagated from the acquire call
    // (recorded BEFORE the failure) lets dogfood reproduce the cache path
    // the consumer was on; the NEXT acquire within `BROKER_NEGATIVE_BACKOFF_MS`
    // (2 s) will surface `hit-negative-backoff` distinguishing recoverable
    // mid-flight failure from permanent factory unavailability.
    if (sub.isDisposed) {
      return degradeAccessLost(acquireState);
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

    // Empty rect case — observation cleanest with `residual` omitted
    // (§2.1 step 5 last bullet, G5-2 outcome (a)).
    if (rects.length === 0) {
      return {
        motion: "no_change",
        source: "dxgi_dirty_rect",
        framesSampled,
        totalElapsedMs,
        cacheState: acquireState,
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
        cacheState: acquireState,
      };
    }

    // Rects observed but sub-threshold (grazing / off-target) → no_change
    // with residual populated for audit (G5-2 outcomes (b) + (c)).
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
      cacheState: acquireState,
    };
  } finally {
    // ADR-020 SR-4 PR-SR4-2 — release the per-call polling handle. The
    // broker entry's native subscription stays cached (idle-timeout-managed),
    // but this handle's queue cursor + its registration in
    // `entry.pollingHandles` are explicitly released here so chained
    // `verifyAnyChange` calls do not leak per-call cursors. The dispose is
    // idempotent: a no-op when the broker already invalidated the handle.
    if (!sub.isDisposed) {
      sub.dispose();
    }
  }
}

// ─── Constants re-export (for unit tests + bench harness) ────────────────────

/**
 * Exported for the unit tests under `tests/unit/{any-change-orchestrator,
 * dxgi-broker,resolve-output-index}.test.ts` and the post-impl bench harness
 * `benches/dogfood_stage_5.mjs`. Production callers MUST NOT branch on these
 * values — they are tuning parameters, not API contract.
 *
 * ADR-020 SR-4 PR-SR4-2: `STAGE5_CACHE_IDLE_TIMEOUT_MS` and
 * `STAGE5_UNAVAILABLE_TTL_MS` re-export `BROKER_CONSTANTS` (broker is SSOT).
 * The numeric values stay bit-equal by construction.
 */
export const STAGE5_CONSTANTS = Object.freeze({
  STAGE5_POLL_BUDGET_MS,
  STAGE5_CACHE_IDLE_TIMEOUT_MS,
  STAGE5_UNAVAILABLE_TTL_MS,
  STAGE5_MAX_OUTPUT_INDEX,
  STAGE5_MIN_INTERSECTED_AREA_RATIO,
});
