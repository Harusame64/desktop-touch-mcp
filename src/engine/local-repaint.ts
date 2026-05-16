/**
 * local-repaint.ts — ADR-019 Stage 4 `local_repaint` primitive orchestrator.
 *
 * Wires the SSIM residual primitive (`compute_ssim_residual` napi) on top of
 * the Stage 2a temporal helpers (`captureFrame` + `capturePostFrameUntilStable`
 * + `computeChangeFraction`) to provide a positive delivery signal for
 * custom-paint surfaces (Photoshop / Blender / Paint.NET / GIMP / Avalonia /
 * RichEdit) where the existing `verifyDelivery` heuristics in
 * `_mouse-verify.ts` (UIA element identity / focus / Win32 scrollbar) and
 * `keyboard.ts` (TextPattern / ValuePattern read-back) return
 * `focus_only` / `unverifiable + read_back_unsupported`.
 *
 * Sub-plan: `docs/adr-019-stage-4-plan.md`. This module ships the resolver
 * (§2.2) + orchestrator (§2.3) only; the SSIM compute primitive lives in
 * Rust (`src/ssim.rs`) and the activation gates live at the call sites
 * (`src/tools/mouse.ts` mouseClickHandler / `src/tools/keyboard.ts`
 * typeHandler BG verify block).
 *
 * Decision lock: P16 default (b) — `focused_element` rectSource was DROPPED
 * because neither `ResolvedWindow` nor `UiaFocusInfo` carries a
 * `boundingRect`, and the AC6 budget was set before accounting for a new
 * UIA bounding-rect RPC. Resolver therefore handles only `point_padded` and
 * `window_fallback` strategies.
 */

import type { VisualMotionObservation } from "../tools/_input-pipeline.js";
import { nativeEngine } from "./native-engine.js";
import {
  capturePostFrameUntilStable,
  computeChangeFraction,
  type RawFrame,
} from "./layer-buffer.js";

// Re-export `RawFrame` so callers in `src/tools/mouse.ts` /
// `src/tools/keyboard.ts` can import the type from a single module
// alongside `verifyLocalRepaint`. Bit-equal with `layer-buffer.ts`.
export type { RawFrame } from "./layer-buffer.js";

// ─── Constants (Stage 4 sub-plan §2.5) ───────────────────────────────────────

/** Stage 2a inherited polling constants (sub-plan §2.5 row 1-5). */
const POLL_INTERVAL_MS = 30;
const MIN_WAIT_MS = 50;
const STABLE_THRESHOLD = 0.002;
const CONSECUTIVE_STABLE_TARGET = 2;
const RING_WALLCLOCK_BUDGET_MS = 700;

/** ADR-019 Stage 4 sub-plan §4 G4 acceptance — Wang et al. residual threshold. */
const RESIDUAL_DELIVERED_FRACTION = 0.05;

/** Wang "perceptually identical" cutoff for the no_change disambiguator
 *  (sub-plan §2.5; exposed via `observation.residual.meanSsim`). */
const MEAN_SSIM_NO_CHANGE_FLOOR = 0.99;

/** `computeChangeFraction` short-circuit threshold — cheaper than SSIM.
 *  Below this we skip the SSIM kernel entirely. */
const NO_CHANGE_FLOOR = 0.001;

/** Click-coord square half-side (sub-plan §2.5 `LOCAL_REPAINT_POINT_PAD_HALF`).
 *  192 × 192 px square centred on the click — calibrated for focus rings
 *  (≤ 64 px), button ripples (≤ 80 px), with slack. */
const LOCAL_REPAINT_POINT_PAD_HALF = 96;

/** R3 mitigation: skip SSIM when resolved rect area exceeds this cap; caller
 *  receives `motion: "indeterminate"`. Roughly 1000 × 1000 pixels. */
const MAX_RECT_AREA_PX = 1_000_000;

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * ADR-019 Stage 4 §2.2 — resolve the rect Stage 4 captures around the click /
 * focused control. Returns the rect in screen coordinates (matches
 * `captureFrame`'s `region` contract; same as Stage 2a).
 *
 * P16 decision lock default (b): `focused_element` rectSource was DROPPED.
 * Neither `ResolvedWindow` nor `UiaFocusInfo` carries `boundingRect`, and
 * the §3 cost analysis silently assumed a UIA bounding-rect RPC that doesn't
 * exist. Two strategies remain — `point_padded` and `window_fallback`.
 */
export interface LocalRepaintRectHint {
  /** Click coordinate (screen px), present for `mouse_click`. */
  point?: { x: number; y: number };
  /** Containing window rect — Stage 4 clips its capture to this to avoid
   *  reading desktop / other windows when the click pad overflows. */
  windowRect: { x: number; y: number; width: number; height: number };
}

export type LocalRepaintRectSource = "point_padded" | "window_fallback";

export interface ResolvedLocalRepaintRect {
  /** The rect Stage 4 captures (clipped to windowRect, padded around point). */
  rect: { x: number; y: number; width: number; height: number };
  /** Diagnostic — which input strategy produced the rect. */
  rectSource: LocalRepaintRectSource;
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
 * Resolve the SSIM capture rect from the hint. Two strategies:
 *
 * 1. **`point_padded`** — when `hint.point` is supplied, build a
 *    `LOCAL_REPAINT_POINT_PAD_HALF * 2` square centred on the click,
 *    intersected with `windowRect`. The intersection rejects clicks that
 *    fall on overlapping windows / off-canvas.
 * 2. **`window_fallback`** — when neither point intersects the window
 *    nor was the point supplied. Captures the full window; the caller
 *    treats this as `motion: "indeterminate"` when the resolved area
 *    exceeds `MAX_RECT_AREA_PX` (R3 mitigation).
 *
 * Returns the resolved rect + diagnostic source label.
 */
export function resolveLocalRepaintRect(
  hint: LocalRepaintRectHint,
): ResolvedLocalRepaintRect {
  if (hint.point) {
    const padded = {
      x: hint.point.x - LOCAL_REPAINT_POINT_PAD_HALF,
      y: hint.point.y - LOCAL_REPAINT_POINT_PAD_HALF,
      width: LOCAL_REPAINT_POINT_PAD_HALF * 2,
      height: LOCAL_REPAINT_POINT_PAD_HALF * 2,
    };
    const clipped = intersectRect(padded, hint.windowRect);
    if (clipped !== null) {
      return { rect: clipped, rectSource: "point_padded" };
    }
    // Point falls outside the supplied windowRect — fall through to
    // window_fallback so the caller still gets an honest observation.
  }
  return { rect: hint.windowRect, rectSource: "window_fallback" };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * ADR-019 Stage 4 §2.3 — `local_repaint` primitive orchestrator. Called by
 * `mouse_click.verifyDelivery` and `keyboard:type` BG verify *after* the
 * existing UIA heuristics returned `focus_only` / `unverifiable`.
 *
 * Algorithm:
 *
 *   1. Pre-frame was captured upstream (matches Stage 2a's pattern; passed in
 *      via `opts.preFrame`). Caller arranges the action to happen between
 *      pre-capture and this invocation.
 *   2. `capturePostFrameUntilStable` polls until the post-action frame is
 *      stable or the wall-clock budget exhausts (`RING_WALLCLOCK_BUDGET_MS`).
 *   3. **Cheap-reject path**: `computeChangeFraction(pre, finalStable)` over
 *      the whole rect. If `< NO_CHANGE_FLOOR (0.001)`, short-circuit to
 *      `motion: "no_change"` with `source: "ssim_residual"`. The SSIM
 *      cascade ran end-to-end and concluded no-change before reaching the
 *      kernel — the source label identifies the pipeline that decided.
 *   4. **R3 cap path**: when resolved rect area exceeds `MAX_RECT_AREA_PX`,
 *      return `motion: "indeterminate"` (caller treats as `unverifiable`).
 *      Whole-window SSIM at 1080p+ would miss the 15 ms unit budget.
 *   5. **SSIM path**: `compute_ssim_residual(pre, finalStable, region=null)`
 *      over the captured rect. Compare `fractionChanged`:
 *        - `≥ RESIDUAL_DELIVERED_FRACTION (0.05)` → `motion: "local_repaint"`
 *          with `residual.fractionChanged` + `residual.centroid` +
 *          `residual.meanSsim`. **Caller treats this as positive delivery.**
 *        - `< 0.05` AND `meanSsim ≥ 0.99` → `motion: "no_change"`
 *          (Wang perceptually-identical floor). **Caller treats this as
 *          `not_delivered`.**
 *        - `< 0.05` AND `meanSsim < 0.99` → `motion: "indeterminate"`
 *          (small residual, not perceptually identical). **Caller treats this
 *          as `unverifiable`** — Stage 4 saw weak evidence but cannot commit.
 *   6. **Unstable path**: when `stableReached === false` (R6 mitigation —
 *      background animation, video playback), return `motion: "indeterminate"`
 *      regardless of fraction. We cannot prove the change was caused by the
 *      action when the screen never settled.
 *
 * Errors / inability are surfaced via `motion: "indeterminate"`, never
 * thrown — Stage 4 must never break the caller's existing envelope.
 */
export async function verifyLocalRepaint(opts: {
  hwnd: bigint;
  hint: LocalRepaintRectHint;
  /** Pre-action frame, captured by the caller. Stage 4 cannot capture pre
   *  itself because the action has already happened by the time we're
   *  called (per `_mouse-verify.ts::classifyDelivery` returning `focus_only`
   *  / `unverifiable` and `keyboard.ts` BG verify reaching its terminal
   *  `unverifiable + read_back_unsupported` sink). */
  preFrame: RawFrame | null;
}): Promise<VisualMotionObservation> {
  const startMs = performance.now();

  const observationDegrade = (
    framesSampled: number,
  ): VisualMotionObservation => ({
    motion: "indeterminate",
    source: "ssim_residual",
    framesSampled,
    totalElapsedMs: performance.now() - startMs,
  });

  // Native SSIM unavailable (build without P1 export, Linux dev, etc.) →
  // observation-only `indeterminate`. Stage 4 must never crash the caller.
  if (!nativeEngine?.computeSsimResidual) {
    return observationDegrade(0);
  }
  // No pre-frame (capture failed upstream) → observation-only `indeterminate`.
  if (opts.preFrame === null) {
    return observationDegrade(0);
  }

  const { rect } = resolveLocalRepaintRect(opts.hint);

  // R3 mitigation: refuse whole-window SSIM on large rects to keep the AC6
  // 15 ms compute budget honest. Caller treats `indeterminate` as
  // `unverifiable` — same as a UIA-unavailable read-back.
  const rectArea = rect.width * rect.height;
  if (rectArea > MAX_RECT_AREA_PX) {
    return observationDegrade(1);
  }

  // Refuse degenerate rects (window resolved to zero area).
  if (rect.width <= 0 || rect.height <= 0) {
    return observationDegrade(1);
  }

  // Step 2: poll post-frames until stable or budget exhausts.
  let postResult: Awaited<ReturnType<typeof capturePostFrameUntilStable>>;
  try {
    postResult = await capturePostFrameUntilStable(opts.hwnd, rect, {
      pollIntervalMs: POLL_INTERVAL_MS,
      minWaitMs: MIN_WAIT_MS,
      stableThreshold: STABLE_THRESHOLD,
      consecutiveStableTarget: CONSECUTIVE_STABLE_TARGET,
      budgetMs: RING_WALLCLOCK_BUDGET_MS,
    });
  } catch {
    return observationDegrade(1);
  }

  const finalStable = postResult.frames[postResult.frames.length - 1] ?? null;
  // No post-frame captured (DWM warm-up, minimised, permission boundary) →
  // observation-only `indeterminate`.
  if (finalStable === null) {
    return observationDegrade(1);
  }

  // Pre / post shape must match for both `computeChangeFraction` and SSIM.
  if (
    finalStable.width !== opts.preFrame.width ||
    finalStable.height !== opts.preFrame.height ||
    finalStable.channels !== opts.preFrame.channels
  ) {
    return observationDegrade(1 + postResult.frames.length);
  }

  // R6 mitigation: when stable was never reached (background animation,
  // ongoing video), SSIM result is unreliable. Caller keeps `focus_only`.
  if (!postResult.stableReached) {
    return {
      motion: "indeterminate",
      source: "ssim_residual",
      framesSampled: 1 + postResult.frames.length,
      totalElapsedMs: performance.now() - startMs,
    };
  }

  const framesSampled = 1 + postResult.frames.length;

  // Step 3: cheap-reject via `computeChangeFraction` before the SSIM kernel.
  // Acts as a short-circuit for the common "click landed but rect is
  // unchanged" / "key fell on a focus thief" case.
  const wholeChangeFraction = computeChangeFraction(
    opts.preFrame.rawPixels,
    finalStable.rawPixels,
    finalStable.width,
    finalStable.height,
    finalStable.channels,
  );
  if (wholeChangeFraction < NO_CHANGE_FLOOR) {
    return {
      motion: "no_change",
      source: "ssim_residual",
      framesSampled,
      totalElapsedMs: performance.now() - startMs,
    };
  }

  // Step 5: SSIM kernel over the captured rect (no sub-region — the rect was
  // already constrained at capture time).
  let ssim: NonNullable<
    ReturnType<NonNullable<typeof nativeEngine.computeSsimResidual>>
  >;
  try {
    ssim = nativeEngine.computeSsimResidual(
      opts.preFrame.rawPixels,
      finalStable.rawPixels,
      finalStable.width,
      finalStable.height,
      finalStable.channels,
      null,
    );
  } catch {
    return observationDegrade(framesSampled);
  }

  const fractionChanged = ssim.fractionChanged;
  const meanSsim = ssim.meanSsim;
  const centroid = ssim.centroid;
  const totalElapsedMs = performance.now() - startMs;

  if (fractionChanged >= RESIDUAL_DELIVERED_FRACTION) {
    // Positive delivery — local_repaint observed.
    // P15 decision lock default (a): expose meanSsim on the envelope.
    return {
      motion: "local_repaint",
      source: "ssim_residual",
      residual: {
        fractionChanged,
        ...(centroid != null && {
          centroid: { x: centroid.x, y: centroid.y },
        }),
        meanSsim,
      },
      framesSampled,
      totalElapsedMs,
    };
  }
  if (meanSsim >= MEAN_SSIM_NO_CHANGE_FLOOR) {
    // Wang perceptually-identical floor — no_change is the honest answer.
    // Still expose `residual` so callers can audit the boundary (Stage 4
    // sub-plan §4 P15 decision lock default (a)).
    return {
      motion: "no_change",
      source: "ssim_residual",
      residual: {
        fractionChanged,
        meanSsim,
      },
      framesSampled,
      totalElapsedMs,
    };
  }
  // Small residual but not perceptually identical → indeterminate.
  // R6-adjacent case: weak evidence, caller treats as `unverifiable`.
  return {
    motion: "indeterminate",
    source: "ssim_residual",
    residual: {
      fractionChanged,
      meanSsim,
    },
    framesSampled,
    totalElapsedMs,
  };

  // Note: `rectSource` is intentionally NOT destructured here; the
  // orchestrator does not branch on it today. Stage 4 follow-up (per §6 R3
  // mitigation chain) may re-introduce per-source telemetry on the envelope.
}

// ─── Constants re-export (for unit tests + bench harness) ───────────────────

/**
 * Constants are exported for the unit tests in
 * `tests/unit/local-repaint-orchestrator.test.ts` and the bench harness in
 * `benches/ssim_residual.mjs` so their expectations stay aligned with the
 * sub-plan §2.5 table. Production callers should NOT branch on these
 * values — they're tuning parameters, not API contract.
 */
export const STAGE4_CONSTANTS = Object.freeze({
  POLL_INTERVAL_MS,
  MIN_WAIT_MS,
  STABLE_THRESHOLD,
  CONSECUTIVE_STABLE_TARGET,
  RING_WALLCLOCK_BUDGET_MS,
  RESIDUAL_DELIVERED_FRACTION,
  MEAN_SSIM_NO_CHANGE_FLOOR,
  NO_CHANGE_FLOOR,
  LOCAL_REPAINT_POINT_PAD_HALF,
  MAX_RECT_AREA_PX,
});
