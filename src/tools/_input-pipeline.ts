/**
 * ADR-018 destination-explicit input pipeline — Phase 1b dispatcher skeleton.
 *
 * Resolves an `InputDestination` (4-discriminator union per ADR §2.3) and
 * dispatches scroll wheel actions through the appropriate tier. Phase 1b
 * implements Tier 1 (UIA `IUIAutomationScrollPattern::SetScrollPercent` via
 * the new napi export `uiaScrollByWheelAtHwnd`); Tier 2 (CDP) lands in
 * Phase 3, Tier 3 (PostMessage WM_MOUSEWHEEL) in Phase 4. Tier 4 (legacy
 * nutjs SendInput) remains in `mouse.ts:scrollHandler` and is invoked by
 * the caller when `dispatchScrollWheel` returns `null` (Phase 1b fall-through
 * path; Phase 4 tightens this to `dest.kind === 'unresolved'` only when
 * Tier 3 PostMessage covers resolved-but-non-UIA destinations).
 *
 * See `docs/adr-018-phase-1b-subplan.md` for the Phase 1b interpretation of
 * §2.6.2 path-(b) (lenient Tier 4 guard during 1b → strict in Phase 4).
 *
 * CLAUDE.md §3.1 (multi-table fact integrity): the `reason` values emitted
 * here mirror the `reason?:` union of `ScrollVerifyOutcome` in
 * `src/tools/mouse.ts` and `docs/adr-018-input-pipeline-3tier.md` §2.6.2.
 * The `Channel` type below is the ADR §2.6.1 canonical 4-value enum that the
 * *dispatcher* emits via `DispatchOutcome.channel` (Phase 1b emits only
 * `'uia'`). NOTE: `mouse.ts:scrollHandler` additionally emits the legacy
 * literal `'wheel_send_input'` for its Tier 4 nutjs path — that literal is
 * scrollHandler-local and is folded into this `Channel` enum as `'send_input'`
 * by the Phase 4 §2.6.3 migration. Any rename must sweep all surfaces.
 */

import {
  resolveWindowTarget,
  findPlainTopLevelWindowsByTitle,
  type ResolvedWindow,
} from "./_resolve-window.js";
import { logDispatchSink } from "./_resolve-log.js";
import { getWindowRectByHwnd } from "../engine/win32.js";
import { nativeUia, nativeWin32, nativeL1 } from "../engine/native-engine.js";
import {
  captureFrame,
  capturePostFrameUntilStable,
  computeChangeFraction,
  computeStripChangedFractions,
  type RawFrame,
} from "../engine/layer-buffer.js";
import {
  listTabsLight,
  dispatchWheelInTab,
  readScrollPositionInTab,
} from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";
import type { Rect } from "../engine/vision-gpu/types.js";

/**
 * Win32 class name of a Chrome / Edge **top-level** window. Used as the gate
 * for CDP probing — only this exact class triggers a `listTabsLight` HTTP
 * round-trip in `resolveCdpDestinationForHwnd`. The earlier `startsWith
 * "Chrome_WidgetWin"` shape over-matched `Chrome_WidgetWin_0` (Chromium
 * **sub-windows** — popup menus, dropdowns) which can never be a scroll
 * destination, so the gate is now an equality on the top-level class only.
 *
 * **Known carry-over (Electron / multi-Chromium-app desktops)**: Chrome /
 * Edge / Slack / VS Code / Discord / Teams all use the same class name for
 * their top-level windows because they share the Chromium frame. When the
 * user has Chrome running with `--remote-debugging-port=9222` AND scrolls a
 * different Chromium-shell app (Slack, VS Code), the gate matches and the
 * `listTabsLight` probe succeeds — the wheel then mis-routes to Chrome.
 * Phase 3 accepts this risk because:
 *   1. Other Chromium-shell apps rarely run with a public CDP port (they
 *      don't expose `--remote-debugging-port` by default).
 *   2. When they do, the user has opted into CDP control and the
 *      destination ambiguity is theirs to manage (e.g. distinct ports).
 *   3. Phase 5 will tighten by cross-checking the HWND's PID against the
 *      `Target.getTargets()` window-owner PID via CDP — out of scope for
 *      Phase 3 to avoid scope creep. ADR §7 OQ3 / OQ6 carry-over.
 *
 * Future: if Edge's top-level class diverges in a Windows update, extend
 * this to a `new Set([...])` lookup. As of 2026-05 both Chrome and Edge
 * stable channels emit `Chrome_WidgetWin_1`.
 */
const CHROMIUM_TOP_LEVEL_CLASS = "Chrome_WidgetWin_1";

/**
 * Minimum pixel delta required to classify a CDP scroll as `delivered_via_cdp`.
 * 1px is the smallest observable scroll in CSS px; below that, browser pixel
 * snapping or sub-pixel rounding can produce noise on a no-op wheel. (ADR §2.6.2
 * — Tier 2 boundary signal: pre/post `scrollingElement.scrollTop` differ by
 * at least this many px.)
 */
const CDP_SCROLL_DELIVERY_EPSILON_PX = 1;

/**
 * ADR-018 Phase 4 — Tier 3 PostMessage settle delay (ms) before reading
 * `win32_get_scroll_info` post-snapshot. Wheel message handling on the
 * receiver pump is synchronous, but the scrollbar position reflects the next
 * paint. 16 ms ≈ one display frame at 60 Hz; same value Tier 2 CDP uses.
 */
const POSTMESSAGE_SETTLE_MS = 16;

/**
 * ADR-019 MVP-1 (Stage 1) — UIA `ScrollPercent` pre/post delta threshold for
 * `observation.source: "uia_scroll_percent"`. Aligned with `mouse.ts`
 * `SCROLL_PERCENT_EPSILON = 1e-6` baseline; the chain-trust observation
 * needs a slightly larger floor because UIA percent reads on custom-paint
 * receivers may exhibit sub-percent jitter on idle frames. 1e-3 (0.001 %)
 * is empirically a safe gate.
 */
const SCROLL_PERCENT_EPSILON_OBSERVATION = 1e-3;

/**
 * ADR-019 MVP-1 (Stage 1) — `Promise.race` budget for the pre-snapshot UIA
 * `ScrollPercent` read in `postWheelToHwnd`'s chain-trust path. The wheel
 * dispatch must NOT block for seconds on a slow UIA provider (Codex PR #309
 * Round 1 P2), but the pre-snapshot ALSO MUST be a genuine pre-dispatch
 * sample (Codex PR #309 Round 2 P2 — a fire-and-forget Promise that
 * resolves after the chunk loop would carry a post-scroll value). 100 ms
 * is the compromise: UIA reads typically return in 1-5 ms (well under
 * budget) while the worst-case dispatch delay is bounded at an
 * interactive-acceptable ceiling. Timeout → `preUiaPercent = null` →
 * observation falls back to `chain_trust_unverified` honestly.
 */
const UIA_PRE_READ_TIMEOUT_MS = 100;

/**
 * ADR-019 MVP-1 (Stage 1) — same budget for the post-snapshot UIA read
 * inside `observeViaUiaOrChainTrust`. Without this bound, the post-read
 * could block the dispatcher's return for the full 8 s Rust thread
 * timeout when the UIA provider hangs (Codex PR #309 Round 3 P2 — same
 * blocking concern as the pre-read, applied symmetrically to post).
 * Timeout → observation falls back to `chain_trust_unverified`.
 */
const UIA_POST_READ_TIMEOUT_MS = 100;

/**
 * ADR-019 MVP-1 (Stage 1) — known limitation, Codex PR #309 Round 3 P2:
 *
 * `Promise.race` against `UIA_PRE_READ_TIMEOUT_MS` / `UIA_POST_READ_TIMEOUT_MS`
 * lets the JS path return quickly when the UIA read is slow, BUT the
 * losing `readUiaPercent` Promise is never cancelled — the underlying
 * Rust napi task (`thread::execute_with_timeout` in `src/uia/scroll.rs`)
 * continues running until its own 8 s timeout. Under repeated scrolls
 * against a slow / hung provider, each call enqueues another long-running
 * UIA read into the native worker queue, causing backlog and sustained
 * degraded behaviour even though the JS path returns fast with
 * `chain_trust_unverified`.
 *
 * Mitigation deferred to Stage 2a (multi-frame ring buffer) where the
 * temporal observation surface naturally batches / coalesces per-HWND
 * in-flight reads; a per-HWND in-flight gate or an AbortSignal wired
 * through the napi task lifecycle is the proper structural fix and is
 * out of scope for MVP-1. For Stage 1, the JS-side timeout is a
 * meaningful improvement over the pre-PR-309-Round-2 8 s wallclock-stall
 * even without native cancellation.
 */

/**
 * ADR-018 Phase 4 — Tier 3 PostMessage minimum observable `nPos` delta to
 * classify the scroll as `delivered_via_postmessage`. Scrollbar position is
 * reported in app-defined units (often pixels for a custom scrollbar, line
 * count for a listbox); a 1-unit movement is the smallest physically
 * observable change.
 */
const POSTMESSAGE_SCROLL_DELIVERY_EPSILON_NPOS = 1;

/**
 * ADR-019 Stage 2a — stop-detection + causal strip filter parameters.
 *
 * Locked by PoC results 2026-05-16 (`docs/adr-019-stage-2a-poc-results.md`).
 * The algorithm polls until visual stability is detected (CONSECUTIVE_STABLE
 * consecutive frames with inter-frame `changedFraction < STABLE_THRESHOLD`),
 * then computes strip-wise diff between preFrame and the final stable frame
 * oriented along the dispatch motion axis. Activates ONLY on the chain-trust
 * fallback path (Stage 1 UIA percent unavailable). Observation-only telemetry
 * — does NOT change `verifyDelivery.status` / `.reason` / `.channel`.
 */
/** Polling interval between successive frame captures (~2 DWM frames @ 60 Hz). */
const POLL_INTERVAL_MS = 30;
/**
 * Initial wait after the helper is invoked before the first frame is captured.
 * Absorbs GPU staleness: `PrintWindow` can return a pre-paint cache for
 * ~16-50 ms after WM_MOUSEWHEEL is processed; without this wait two
 * consecutive cached frames could declare a false-stable (= a frame still
 * showing the pre-dispatch state). PoC: 50 ms perfectly separates
 * Excel real-scroll (`firstPostDelta > 0`) from idle (= 0).
 */
const MIN_WAIT_MS = 50;
/** Inter-frame `changedFraction` threshold below which a frame counts as stable. */
const STABLE_THRESHOLD = 0.002;
/**
 * Per-strip `changedFraction` threshold above which a strip counts as
 * "above noise". Calibrated to Excel's chain-trust block-SAD signal range
 * (0.003-0.015 per PoC) — well above the empirically-observed idle floor
 * (0.000 on 15/15 cycles). Stage 2b refines per-app.
 */
const STRIP_NOISE_THRESHOLD = 0.003;
/** Consecutive stable frames required before ring termination (Playwright pattern). */
const CONSECUTIVE_STABLE_TARGET = 2;
/**
 * Wall-clock budget for the entire stop-detection ring. Covers a full Win32
 * caret cycle (530 ms default) + safety margin so caret-active idle windows
 * eventually budget-timeout with `stableReached: false` instead of looping
 * indefinitely. PoC empirical p99 = 204 ms (29 % of budget); the wider
 * budget is intentional headroom for slower MFC repaint paths.
 */
const RING_WALLCLOCK_BUDGET_MS = 700;
/** Strip partitioning of the window for the causal filter (top→bottom for vertical motion). */
const STRIP_COUNT = 4;

// ─── ADR-019 Stage 2b decision gate ──────────────────────────────────────────

/**
 * ADR-019 Stage 2b — gate evaluation result.
 *
 * Inputs: Stage 2a `ringTelemetry` (`finalChangedFraction`) + env var read.
 * Output: the `motion` value to populate on the emitted
 * `VisualMotionObservation`. `"indeterminate"` is returned when the env opt-out
 * is set OR when telemetry is structurally missing (Stage 2a env off) — both
 * cases preserve pre-Stage-2b behaviour. The caller then uses `motion` to
 * decide whether `postWheelToHwnd`'s chain-trust branch should emit a
 * `delivered_via_postmessage` success outcome (`"translation"`) or a non-null
 * `target_unreachable` outcome carrying the observation (`"no_change"`).
 *
 * Sub-plan §2.2 / §2.5 SSOT table / §3 P1.
 */
export type Stage2bGateMotion = "translation" | "no_change" | "indeterminate";

/**
 * Resolve the Stage 2b gate's `motion` decision from Stage 2a's ring
 * telemetry. Extracted as a pure helper for testability per sub-plan §3 P1.
 *
 * @param finalChangedFraction Stage 2a's whole-window pre-vs-final
 *   `changedFraction` (block-SAD with `NOISE_THRESHOLD = 16`). Strict `> 0`
 *   gate per sub-plan §2.2 — block-SAD already filters thin-line noise so an
 *   epsilon would risk demoting genuine micro-scrolls (Excel 1 px line shift
 *   ≈ 0.0018 changedFraction on a 555-row window, just above the
 *   `STABLE_THRESHOLD = 0.002` floor).
 * @param env opt-out flag (read by caller from `process.env`). `true` keeps
 *   `motion: "indeterminate"` so callers preserve Stage 2a wire-level output
 *   even when the ring fired.
 * @returns one of `"translation"` (real motion observed, dispatcher emits
 *   `delivered_via_postmessage`), `"no_change"` (gate-fail — Stage 2b's load-
 *   bearing decision: TMOL observed silent drop, dispatcher emits
 *   `target_unreachable` per §2.5 SSOT row), or `"indeterminate"` (opt-out).
 */
export function evaluateStage2bGate(
  finalChangedFraction: number,
  env: { stage2bGateDisabled: boolean },
): Stage2bGateMotion {
  if (env.stage2bGateDisabled) {
    return "indeterminate";
  }
  return finalChangedFraction > 0 ? "translation" : "no_change";
}

/**
 * Win32 wheel message constants. Verified against Microsoft Learn:
 * - WM_MOUSEWHEEL  = 0x020A — vertical wheel, HIWORD positive = forward (scroll up)
 * - WM_MOUSEHWHEEL = 0x020E — horizontal wheel, HIWORD positive = tilt right (scroll right)
 */
const WM_MOUSEWHEEL = 0x020a;
const WM_MOUSEHWHEEL = 0x020e;

/**
 * `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` HIWORD is read as a signed 16-bit value
 * via `GET_WHEEL_DELTA_WPARAM` on the receiver side. A single message can
 * carry at most ±32767 raw units; large `notch` requests must be chunked so
 * each emitted message stays within the signed 16-bit range (otherwise the
 * sign bit wraps and a "scroll down" emerges as a "scroll up" on the
 * receiver, per Codex PR #305 review).
 *
 * ADR-018 Phase 6: the same cap now bounds Tier 4's SendInput events
 * (`mouse.ts` scrollHandler). The limit is a property of how a receiver reads
 * the delta, not of the transport, so both paths honour it.
 */
export const WHEEL_DELTA_MAX_PER_MSG = 0x7fff;

/**
 * Raw wheel units per notch — the Win32 `WHEEL_DELTA` constant, unchanged
 * since Windows 2000. One detent of a physical wheel is 120 units.
 *
 * ADR-018 Phase 6 §2.1 — SSOT for the whole input pipeline. Every tier takes
 * `amount` / `notch` in **notches** and scales here; Tier 4 (`mouse.ts`
 * nut-js → libnut `INPUT.mi.mouseData`) previously used a private `* 3`
 * constant, which made one caller-supplied unit mean 1/40 of a notch on that
 * tier and a full notch on Tier 1/3. Import this rather than re-deriving it.
 */
export const WHEEL_DELTA_PER_NOTCH = 120;

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * ADR §2.3 D3 — Destination as a first-class discriminated union. Every input
 * tool resolves destination **first**, before choosing a tier. Phase 1b's
 * resolver returns either `'hwnd'` (HWND known, tier probed by dispatcher)
 * or `'unresolved'` (no destination → Tier 4 SendInput fallback). The `'uia'`
 * and `'cdp'` discriminators are declared up-front so Phase 3 (CDP) and a
 * future explicit-element resolver can extend the union without contract
 * churn.
 */
export type InputDestination =
  | { kind: "uia"; hwnd: bigint }
  | { kind: "cdp"; tabId: string; nodeId?: number }
  | { kind: "hwnd"; hwnd: bigint }
  | { kind: "unresolved"; reason: string };

/**
 * ADR §2.6.1 — Transport identifier emitted by the dispatcher. Always
 * populated; orthogonal to delivery status (caller may emit `channel:'uia'`
 * with `status:'not_delivered'` if the UIA call returned `scrolled:false` and
 * observation confirmed no movement).
 *
 * This is the canonical 4-value ADR §2.6.1 enum. The legacy Tier 4 literal
 * `'wheel_send_input'` emitted by `mouse.ts:scrollHandler` is **not** part of
 * this type — it is scrollHandler-local until the Phase 4 §2.6.3 migration
 * renames it to `'send_input'` and routes it through `DispatchOutcome`.
 */
export type Channel = "uia" | "cdp" | "postmessage" | "send_input";

/**
 * Wheel parameters in raw notch deltas.
 *
 * **Sign convention (UIA-internal, NOT Win32 WM_MOUSEWHEEL-compatible)**: this
 * interface uses the UIA `SetScrollPercent` direction sense — down/right is
 * positive (percent increases toward the bottom/right of content). The Win32
 * `WM_MOUSEWHEEL` `wParam` high word uses the opposite convention (positive
 * = wheel rotated forward, scroll **up**). Phase 4 PostMessage encoding
 * (ADR-018 §4 Phase 4) MUST flip the sign at the `postWheelToHwnd` napi
 * boundary — `WheelParams.notch` carries UIA-direction signed values
 * throughout the TS layer.
 *
 * `notch` is the integer count of mouse-wheel detents (1 notch = 120 raw
 * `WHEEL_DELTA` units). The dispatcher converts this to a percent step
 * inside the Rust UIA path. CDP `dispatchMouseEvent({type:'mouseWheel'})`
 * (Phase 3) uses positive-down convention too (same as UIA / CSS), so no
 * sign flip is needed at the Tier 2 boundary — only Tier 3 PostMessage flips.
 */
export interface WheelParams {
  direction: "up" | "down" | "left" | "right";
  notch: number;
  /**
   * Optional viewport-relative CSS px coordinates for Tier 2 CDP dispatch.
   * CDP `Input.dispatchMouseEvent({type:'mouseWheel'})` requires `(x,y)` but
   * routes the wheel to the tab (not the point) — so for Phase 3 these are
   * a hint only; viewport center is used when omitted. Tier 1 (UIA) and
   * Tier 4 (legacy SendInput) ignore both fields.
   *
   * Phase 3 / ADR §7 OQ6 carry-over: per-element CDP coords land in a future
   * phase (e.g. `scroll(action='to_element', selector=...)` Tier 2 path).
   */
  x?: number;
  y?: number;
}

/**
 * Outcome of one tier dispatch attempt. `null` return from `dispatchScrollWheel`
 * means "this tier did not handle the dispatch — caller should fall through
 * to the next tier (or to Tier 4 SendInput in Phase 1b)".
 *
 * **ADR-019 Stage 2b extension (sub-plan §5 R3 Option I, locked Round 1
 * P2-2)**: a non-null `DispatchOutcome` with `scrolled: false` AND
 * `reason: "target_unreachable"` is the TMOL gate-fail signal. The chain-
 * trust branch of `postWheelToHwnd` returns this when Stage 2a's
 * `finalChangedFraction === 0` (no pixel motion observed despite the
 * PostMessage being queued). Caller (`mouse.ts:scrollHandler`) inspects
 * `outcome.scrolled === false && outcome.reason === "target_unreachable"`
 * and routes to the `not_delivered` envelope, propagating `observation`.
 * Existing `null` returns are preserved for "fall through to next tier".
 */
export interface DispatchOutcome {
  scrolled: boolean;
  channel: Channel;
  /**
   * ADR §2.6.2 reason value. Phase 1b emits `'delivered_via_uia'`, Phase 3
   * adds `'delivered_via_cdp'`, Phase 4 adds `'delivered_via_postmessage'`;
   * `'wheel_overlay_intercepted'` is surfaced by the caller via the typed
   * envelope (see `mouse.ts:scrollHandler`). `null` indicates no ADR-018
   * reason applies (caller picks the legacy `evaluateScrollDelivery` reason
   * from `mouse.ts`).
   *
   * **ADR-019 Stage 2b additive value**: `'target_unreachable'` paired with
   * `scrolled: false` is the TMOL gate-fail signal emitted by the chain-
   * trust branch when `observation.motion === "no_change"`. See type-level
   * comment above for the routing contract.
   *
   * **ADR-018 Phase 6 §2.3 additive value**: `'pixel_delta_observed'` paired
   * with `scrolled: true` is the weakest delivery evidence in the taxonomy —
   * the target's raw pixels changed across the dispatch, which proves a
   * repaint and not a scroll. `mouse.ts` emits it from its own last-resort
   * comparison; `postWheelToHwnd` emits it when a structural hit-test
   * retarget moved the leaf's pixels while no watched scrollbar moved, a
   * shape the caller's comparison cannot reach because it runs only when the
   * window it watched exposes no scrollbar at all.
   */
  reason:
    | "delivered_via_uia"
    | "delivered_via_cdp"
    | "delivered_via_postmessage"
    | "pixel_delta_observed"
    | "target_unreachable"
    | null;
  /**
   * ADR-019 MVP-1 (Stage 1) — additive observation telemetry. Populated
   * when a TMOL primitive (UIA `ScrollPercent` for Stage 1; block motion /
   * tiled phase correlation / SSIM / DXGI for Stages 2-5) produces a
   * concrete observation; absent on legacy Tier 1 / 2 / 3 paths that have
   * not yet been wired through TMOL. The `source` enum is canonically
   * defined in `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
   * §2.1; keep all surfaces (this type, `ScrollVerifyOutcome.observation`,
   * the envelope hint, ADR-018 §2.6 reference, ADR-019 §2.1) bit-equal.
   */
  observation?: VisualMotionObservation;
}

/**
 * ADR-019 §2.1 — `VisualMotionObservation`. Carried additively in
 * `DispatchOutcome.observation` / `ScrollVerifyOutcome.observation` /
 * `verifyDelivery.observation` envelope hint. Existing callers that ignore
 * the field are unaffected (CLAUDE.md §3.2 carry-over scope shrink).
 */
export interface VisualMotionObservation {
  /** ADR-019 Stage 5 added `"any_change"` for the DXGI dirty-rect primitive
   *  (sub-plan §2.1 step 5) — emitted when observed dirty rects intersect
   *  the target rect at ratio ≥ `STAGE5_MIN_INTERSECTED_AREA_RATIO`. The
   *  remaining four values are bit-equal with Stages 1-4. */
  motion: "translation" | "local_repaint" | "any_change" | "no_change" | "indeterminate";
  /**
   * Present when the algorithm produced a numeric shift (e.g. UIA percent
   * delta for `source: "uia_scroll_percent"`); may be absent for sources
   * that produce only a binary motion verdict (e.g.
   * `source: "temporal_ring_observation_only"` whose `finalChangedFraction`
   * is a scalar gate input, not a pixel-level shift). ADR-019 Stage 2b
   * sub-plan §2.4 Option A: an honest contract relaxation — `shift` is
   * present when measurable; `motion` is always present. CLAUDE.md §3.1
   * sweep targets: ADR-019 §2.1, this docstring, and
   * `docs/adr-018-phase-5-followup-verification-pathway-analysis.md`
   * lines 157/159.
   */
  shift?: { dx: number; dy: number; confidence: number };
  /**
   * Present when the algorithm measured a local repaint signature (e.g.
   * SSIM residual fraction for `source: "ssim_residual"`). May be absent
   * for sources that produce only a binary motion verdict (Stage 2b
   * Option A relaxation — same rationale as `shift?` above).
   *
   * Stage 4 `ssim_residual` pipeline (impl PR) emits `residual` even on
   * `no_change` / `indeterminate` outputs so that callers can audit the
   * `no_change` (meanSsim ≥ 0.99) vs `indeterminate` (meanSsim < 0.99)
   * boundary. `fractionChanged` is `0` when no windows crossed the
   * per-window residual threshold; `centroid` is omitted in that same
   * case (no above-threshold windows to mean); `meanSsim` is the Wang
   * "perceptually identical" floor exposed by `compute_ssim_residual`
   * (Stage 4 sub-plan §4 P15 decision lock default (a)).
   */
  residual?: {
    fractionChanged: number;
    centroid?: { x: number; y: number };
    meanSsim?: number;
    /**
     * ADR-019 Stage 5 — number of DXGI dirty rectangles observed during the
     * post-action poll window. Optional and only populated for
     * `source: "dxgi_dirty_rect"`. Omitted when no rects were observed
     * (cheapest path; see Stage 5 sub-plan §2.1 step 5 empty-rect outcome).
     */
    dirtyRectCount?: number;
    /**
     * ADR-019 Stage 5 — total intersected area (in pixels) between observed
     * dirty rectangles and the target window rect (or its `region` sub-rect).
     * `0` when rects exist but none overlap the target.
     */
    totalIntersectedAreaPx?: number;
    /**
     * ADR-019 Stage 5 — `totalIntersectedAreaPx / (target.width * target.height)`.
     * The Stage 5 motion gate is `ratio >= STAGE5_MIN_INTERSECTED_AREA_RATIO`
     * (0.005 = 0.5 % of target rect). See Stage 5 sub-plan §2.1 step 5 +
     * §2.4 constants table for rationale.
     */
    ratioOfTargetArea?: number;
  };
  /**
   * ADR-024 Seed-2 Stage 5 (S3a) — the raw DXGI dirty rectangles observed
   * during the post-action poll, in **desktop screen-absolute coordinates**
   * (per-output, translated via `DXGI_OUTPUT_DESC.DesktopCoordinates` — PR
   * #322). Surfaced from the **same** `sub.next()` poll that produced
   * `motion`, so the visual-only ROI-capture path (ADR-024 Seed-2) reuses
   * the gate's poll with **no second DXGI acquire** (sub-plan §2 S3a, OQ-11).
   *
   * **Opt-in**: only populated when the caller passes
   * `VerifyAnyChangeOpts.includeDirtyRects === true` (the `desktop_act` ROI
   * path). Every other `verifyAnyChange` caller (keyboard / mouse-verify
   * Stage-5 fallback) leaves it `undefined`, so their serialized observation
   * stays byte-equal (additive optional field — CLAUDE.md §3.2 carry-over).
   * Only populated for `source: "dxgi_dirty_rect"` and only when ≥1 rect was
   * observed; omitted on the empty-rect / `indeterminate` / non-DXGI paths.
   *
   * **NOT yet window-rect filtered**: these are per-output rects that may
   * include dirty regions outside the target window (other windows, the
   * cursor, notifications). The window-rect intersection filter that turns
   * them into a window-relative ROI lands in S3b; the ROI-aware OCR + fold
   * into `roiCapture` land in S4/S5. Until then no consumer reads this field.
   */
  dirtyRects?: Rect[];
  /**
   * ADR-024 Seed-2 S5c-1b — the **window-relative** bounding box of the
   * changed region, derived from the pre/post true-PrintWindow frame-diff
   * (native SSIM above-threshold-window aggregation). A sibling internal
   * ROI-source channel to `dirtyRects`: it is **opt-in** (only populated when
   * `verifyLocalRepaint` is called with `includeRoiBbox === true`, i.e. the
   * visual-only `desktop_act` ROI path) and the act handler **splits it off
   * before assigning `result.observation`**, so it never reaches the public
   * Stage 5 telemetry envelope (ADR-019 contract; byte-equal for every other
   * caller — additive optional field, CLAUDE.md §3.2 carry-over).
   *
   * Only emitted on the positive `motion: "local_repaint"` path AND only when
   * the capture was occlusion-immune (both pre and post frames came from
   * PrintWindow, not the BitBlt fallback). Absent on `no_change` /
   * `indeterminate` / non-occlusion-immune captures → the consumer
   * (`buildRoiCapture`) falls back to the full-window ROI (P1-1).
   */
  roiBbox?: Rect;
  /**
   * Algorithm that produced this observation. Stage 1 emits
   * `"uia_scroll_percent"` (success) or `"chain_trust_unverified"`
   * (UIA pattern not exposed, chain-trust fall-through). Stages 2-5+
   * add the remaining values. Stage 5 added
   * `"dxgi_dirty_rect_unavailable"` for the RDP / virtual-display /
   * `NotCurrentlyAvailable` graceful-degrade path (Stage 5 sub-plan §2.1
   * step 2 + §6 R1 + §2.6 coexistence lock).
   */
  source:
    | "uia_scroll_percent"
    | "block_motion_vectors"
    | "tiled_phase_correlation"
    | "ssim_residual"
    | "dxgi_dirty_rect"
    | "dxgi_dirty_rect_unavailable"
    | "optical_flow"
    | "temporal_ring_observation_only"
    | "chain_trust_unverified";
  /**
   * Stage 2a multi-frame ring buffer telemetry (Stage 1 leaves undefined).
   * Populated when the temporal observation layer captured a ring; carries
   * both the inter-frame stability series (`changedFractions`) and the
   * causal strip-filter signature (`finalStripChangedFractions` +
   * `stripsAboveNoise`) for Stage 2b decision input.
   *
   * Schema decided in `docs/adr-019-stage-2a-poc-results.md` (PoC, 2026-05-16):
   * the original PR #309 forward-declared shape (`framesSampled` /
   * `elapsedMsPerFrame` / `changedFractions` / `maxChangedFraction`) is
   * preserved bit-equal; the new strip-filter fields are additive.
   */
  ringTelemetry?: {
    /** Total frames in the ring = 1 pre + N polled post frames. */
    framesSampled: number;
    /** Wallclock ms per frame (index 0 = pre at t=0, then post frames). */
    elapsedMsPerFrame: number[];
    /**
     * Inter-frame `changedFraction` series (stop-detection stability metric).
     * `changedFractions[k] = changedFraction(post[k], post[k+1])` where
     * `post[*]` is the helper's polled frame ring (does NOT include the
     * `preFrame` captured upstream at `T_pre`). With `K` polled frames in
     * the ring, the helper emits `K - 1` deltas; the caller then sets
     * `framesSampled = 1 + K`, so **length = `framesSampled - 2`** (one
     * subtract for `preFrame` not being in `post[*]`, one for delta-count
     * being one less than frame-count). A value `< STABLE_THRESHOLD`
     * (0.002) signals frame-to-frame stability; two consecutive sub-
     * threshold values (`CONSECUTIVE_STABLE_TARGET = 2`) trigger ring
     * termination. (Opus PR #311 Round 1 P2-1 — corrected from `- 1`
     * which contradicted the runtime + unit test fixture.)
     */
    changedFractions: number[];
    /** Max of `changedFractions` — proxy for peak motion during the ring. */
    maxChangedFraction: number;
    /**
     * ADR-019 Stage 2a causal strip filter — motion axis derived from the
     * dispatch direction: `"vertical"` for up/down scrolls, `"horizontal"`
     * for left/right scrolls. Strip orientation follows the axis (horizontal
     * strips for vertical motion, vice versa).
     */
    axis: "vertical" | "horizontal";
    /** Number of strips the window was partitioned into (default 4). */
    stripCount: number;
    /**
     * Per-strip `changedFraction(preFrame, finalStableFrame)` — length =
     * `stripCount`. The causal expectation is that a real scroll touches
     * multiple strips (translation across the axis), while caret / local UI
     * animation touches one strip; Stage 2b gates on `stripsAboveNoise`.
     */
    finalStripChangedFractions: number[];
    /**
     * Count of strips with `finalStripChangedFractions[i] > STRIP_NOISE_THRESHOLD`
     * (0.003 per PoC calibration). Stage 2b decision input.
     */
    stripsAboveNoise: number;
    /**
     * Whole-window `changedFraction(preFrame, finalStableFrame)`. Useful when
     * the dispatch axis is unknown or strip filter is uninformative; idle
     * baseline = 0.000, real scroll ≥ 0.003 (Excel chain-trust empirically).
     */
    finalChangedFraction: number;
    /** True iff `CONSECUTIVE_STABLE_TARGET` consecutive stable frames detected before budget. */
    stableReached: boolean;
    /**
     * Index in `frames[]` at which stability was confirmed, or `null` when
     * the wall-clock budget exhausted before stability. Diagnostic for
     * Stage 2b's per-app budget tuning.
     */
    framesToStability: number | null;
  };
  framesSampled: number;
  totalElapsedMs: number;
  /**
   * ADR-019 Stage 5 + issue #327 item B instrumentation — DXGI subscription
   * cache state observed during this call. Helps audit the cache fast-path
   * vs cold-path ratio for back-to-back `desktop_act` calls (the dogfood
   * symptom that triggered #327: `totalElapsedMs ~50ms constant`). Only
   * populated on Stage 5 paths that consult the shared `DirtyRectBroker`
   * (ADR-020 SR-4); absent on non-broker sources.
   *
   * Values:
   * - `"hit-subscription"`: cached subscription returned, no init cost.
   * - `"hit-unavailable"`: cached `unavailable` marker (factory previously
   *   threw); fast-path negative.
   * - `"hit-negative-backoff"`: cached `negative-backoff` marker (a recent
   *   `sub.next()` failure triggered `invalidate`, which now sets a short
   *   back-off instead of clearing — issue #327 item B fix).
   * - `"miss-init"`: cache miss + factory succeeded (paid init cost).
   * - `"miss-init-unavailable"`: cache miss + factory threw, marker now
   *   set (paid init cost; subsequent calls fast-path on `hit-unavailable`).
   */
  cacheState?:
    | "hit-subscription"
    | "hit-unavailable"
    | "hit-negative-backoff"
    | "miss-init"
    | "miss-init-unavailable";
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the input destination using `resolveWindowTarget` (ADR §2.3 D3 SSOT).
 *
 * Resolution order:
 *   1. `resolveWindowTarget({hwnd, windowTitle})` — handles explicit `hwnd`,
 *      `@active`, and the H3 dialog owner chain → `{ kind: 'hwnd' }`.
 *   2. **Plain-windowTitle Case 3 recovery**: `resolveWindowTarget` returns
 *      `null` for a plain `windowTitle` that DOES match a top-level window
 *      (`_resolve-window.ts` Case 3 discards the matched HWND by design, to
 *      keep legacy title-based callers unchanged). The dispatcher still needs
 *      that HWND so Tier 1 UIA is reachable for the common windowTitle-only
 *      scroll call (ADR §4 Phase 1 G1 acceptance — otherwise
 *      `scroll(windowTitle:'メモ帳')` could never report `channel:'uia'`). We
 *      re-run an `enumWindowsInZOrder` lookup here with Case 3's predicate
 *      (non-dialog class, no owner window) plus a minimized-window exclusion
 *      (a minimized HWND is not a usable dispatch/observation target) to
 *      recover it → `{ kind: 'hwnd' }`. This is still title-based, not
 *      cursor/foreground.
 *   3. No resolvable target → `{ kind: 'unresolved' }` so the caller falls
 *      through to Tier 4 SendInput (legacy nutjs in Phase 1b). This preserves
 *      the cursor-only / no-destination happy path (`scroll({action:'raw',
 *      direction:'down'})` with no windowTitle).
 *
 * **Dispatcher routing never touches cursor coordinates** — the cursor-pixel
 * routing that ADR-018 §1.2 identified as the root cause of the 11 reported
 * symptoms is confined to Tier 4 (which only fires when the destination is
 * unresolved, or when Tier 3 PostMessage is exhausted in Phase 4).
 *
 * Callers that need a *snapshot* HWND for Win32 GetScrollInfo observation
 * compute that separately — see `mouse.ts:scrollHandler`, which seeds the
 * observation HWND from `dest.hwnd` whenever `dest.kind === 'hwnd'` so
 * observation and action share the same destination (ADR §2.2 invariant).
 */
export async function resolveInputDestination(
  params: {
    hwnd?: string;
    windowTitle?: string;
  },
  /**
   * ADR-035 Phase 1 — optional collector for non-blocking advisories. When the
   * Case 3 recovery below matches more than one window it appends the same
   * "N windows match" wording `action-target.ts` already uses, so an ambiguous
   * scroll destination stops being silent. Purely additive: the destination
   * returned is byte-identical with or without a collector, and callers that
   * pass nothing behave exactly as before.
   */
  warnings?: string[],
): Promise<InputDestination> {
  const resolved: ResolvedWindow | null = await resolveWindowTarget({
    hwnd: params.hwnd,
    windowTitle: params.windowTitle,
  });
  if (resolved !== null) {
    // ADR §2.1 D1 Tier 2 — promote Chrome/Edge top-level HWNDs to a CDP
    // destination when a CDP session is reachable. This is the auto-detect the
    // ADR specifies ("Tier 2: Target is a Chrome/Edge tab (CDP attached via
    // browser_open)") — callers do NOT pass a tabId; the resolver gates by
    // window class and probes only when the gate matches, so non-browser
    // windows pay no CDP latency. The class name is already known to
    // `resolveWindowTarget` (filled in via `safeGetClassName` on the resolved
    // HWND) so the gate does not require a second `enumWindowsInZOrder`
    // syscall — pass it through directly.
    const cdp = await resolveCdpDestinationForHwnd(resolved.hwnd, resolved.className ?? null);
    if (cdp !== null) return cdp;
    return { kind: "hwnd", hwnd: resolved.hwnd };
  }
  // Case 3 recovery (see docstring): `resolveWindowTarget` returns null for a
  // plain `windowTitle` that matches a top-level window — recover that HWND so
  // Tier 1 UIA stays reachable. ADR-018 Phase 5: delegated to the shared
  // `findPlainTopLevelWindowByTitle` helper. Flags:
  //   - excludeMinimized: true — minimized HWND is not a usable dispatch target
  //     (UIA scroll on off-screen window) and would pin observation to an
  //     unobservable window (Codex PR #288 Round 4 P1).
  //   - excludeDialogsAndOwned: true — non-dialog class (`#32770` excluded)
  //     AND no owner window, so we recover a true top-level window, never an
  //     owned/modal dialog with a coincidentally-overlapping title substring
  //     (Codex PR #288 Round 3 P2).
  // `@active` is excluded here: `resolveWindowTarget` owns that shorthand and
  // a null return there means foreground resolution genuinely failed.
  if (params.windowTitle && params.windowTitle !== "@active") {
    const matches = findPlainTopLevelWindowsByTitle(params.windowTitle, {
      excludeMinimized: true,
      excludeDialogsAndOwned: true,
      logAs: "inputPipelineCase3",
    });
    const match = matches[0];
    if (matches.length > 1) {
      // ADR-035 §6.3 — advisory only in Phase 1. `resolveInputDestination`
      // keeps the historic frontmost tie-break; strict refusal is ADR-037's
      // decision to make once the Phase 1 log says how often this fires.
      warnings?.push(
        `${matches.length} windows match "${params.windowTitle}"; using the frontmost`,
      );
    }
    if (match) {
      // Case 3 recovery also gets the CDP Tier 2 promotion — otherwise a
      // plain-windowTitle scroll on Chrome (where resolveWindowTarget returns
      // null by Case 3 design) would never see channel='cdp'. The class name
      // is already on the `match` record (`enumWindowsInZOrder` returns it),
      // so the gate inside `resolveCdpDestinationForHwnd` does not re-enumerate.
      const cdp = await resolveCdpDestinationForHwnd(match.hwnd, match.className ?? null);
      if (cdp !== null) return cdp;
      return { kind: "hwnd", hwnd: match.hwnd };
    }
  }
  return { kind: "unresolved", reason: "no_target_window" };
}

/**
 * ADR §2.1 D1 Tier 2 — auto-promote a Chrome/Edge HWND to a CDP destination
 * when a CDP session is reachable on the configured port. Returns `null` when
 * the gate fails (non-Chromium-top-level class) OR when the CDP probe fails
 * (browser not running with `--remote-debugging-port`, no tabs, network error)
 * — caller then falls back to `{kind:'hwnd'}` and tries Tier 1 UIA.
 *
 * **The class name is passed in by the caller** (already known from
 * `ResolvedWindow.className` or `enumWindowsInZOrder()`'s record) so this
 * function does NOT re-enumerate windows. Total syscall budget per call is
 * **zero on the gate-miss path** and **one HTTP round-trip** on the gate-hit
 * path. (Opus Round 1 P2 — earlier shape redundantly called
 * `enumWindowsInZOrder` here, doubling the syscall cost per scroll.)
 *
 * Phase 3 picks the first listed tab as the destination — matching
 * `resolveTab(null, port)` semantics in `cdp-bridge.ts`. A future phase may
 * thread a focused-tab hint via the foreground HWND → tab mapping (ADR §7
 * OQ-Electron carry-over).
 *
 * Exported for unit testing.
 */
export async function resolveCdpDestinationForHwnd(
  _hwnd: bigint,
  className: string | null,
): Promise<{ kind: "cdp"; tabId: string } | null> {
  if (className !== CHROMIUM_TOP_LEVEL_CLASS) {
    return null;
  }
  try {
    const port = getCdpPort();
    const tabs = await listTabsLight(port);
    const firstPage = tabs[0];
    if (!firstPage) return null;
    return { kind: "cdp", tabId: firstPage.id };
  } catch {
    return null;
  }
}

// ─── Runtime guard (ADR §4 Phase 1 deliverable) ──────────────────────────────

/**
 * Asserts that the caller is allowed to invoke Tier 4 (legacy SendInput
 * nutjs path) for the given destination. **Phase 4 strict form** — only
 * `dest.kind === 'unresolved'` is allowed; resolved destinations of any
 * kind (`'uia' | 'cdp' | 'hwnd'`) MUST dispatch through their own transport
 * and surface `target_unreachable` per ADR §2.6.2 path-(b) when every
 * applicable tier (1/2/3) is exhausted. The dispatcher routes Tier 1 → Tier 3
 * for `kind:'hwnd' | 'uia'` so by the time the caller would consider Tier 4
 * the destination was already proven exhausted at the dispatcher layer.
 *
 * History: Phase 1b adopted a lenient form (`'hwnd'` allowed) so the dispatcher
 * could roll out Tier 1 without losing the legacy SendInput fallback for
 * Word / Chrome / Excel before Tier 3 PostMessage landed. Phase 4 tightens
 * to strict because Tier 3 PostMessage now covers those resolved-but-non-UIA
 * destinations.
 *
 * @throws Error if `dest.kind` is `'uia'`, `'cdp'`, or `'hwnd'` (those
 *   destinations must dispatch through Tier 1/2/3 — invoking SendInput
 *   would bypass the destination-explicit contract and re-introduce the
 *   cursor-pixel routing that ADR §1.2 identifies as the root cause of
 *   the 11 reported symptoms).
 */
export function assertTier4Reachable(dest: InputDestination): void {
  if (dest.kind !== "unresolved") {
    throw new Error(
      `Tier 4 SendInput must not be reached when destination kind is '${dest.kind}'. ` +
        "Resolved destinations dispatch through Tier 1 (UIA) / Tier 2 (CDP) / Tier 3 (PostMessage) " +
        "and surface 'target_unreachable' when every applicable tier is exhausted. " +
        "(ADR-018 §2.6.2 path-(b): Tier 4 is reachable only when destination is unresolved.)",
    );
  }
}

/**
 * ADR-019 MVP-1 (Stage 1) — chain-trust observation gate. Called inside the
 * `postWheelToHwnd` Case 2a branch (leaf walker retargeted + `GetScrollInfo`
 * returns null) AFTER the PostMessage chunking loop has posted at least one
 * chunk. Reads UIA `ScrollPercent` post-snapshot, compares with the supplied
 * pre-snapshot, and returns the corresponding `VisualMotionObservation`.
 *
 *   - pre + post both non-null AND |delta| ≥ epsilon → translation observed
 *     via UIA percent. Stage 1 doesn't convert the percent to a pixel shift
 *     (different observers carry different units — block motion vectors will
 *     carry pixels in Stage 2b); just record `source: "uia_scroll_percent"`
 *     and let the caller trust the result.
 *   - pre non-null + post non-null AND |delta| < epsilon → no_change. The
 *     wheel reached the receiver but the receiver did not advance (boundary
 *     case Codex PR #308 P1 honest signal).
 *   - any failure (UIA pattern not exposed on either snapshot, post read
 *     throws) → fall through to chain-trust assertion: `source:
 *     "chain_trust_unverified"`.
 *
 * Stages 2-5 add additional observers (block motion vectors / phase
 * correlation / SSIM / DXGI dirty-rect); this helper is the first one wired.
 */
async function observeViaUiaOrChainTrust(
  effectiveHwnd: bigint,
  axis: "vertical" | "horizontal",
  preUiaPercent: number | null,
  preElapsedMs: number,
  readUiaPercent:
    | ((opts: {
        hwnd: string;
        axis: "vertical" | "horizontal";
      }) => Promise<number | null>)
    | undefined,
  stage2a:
    | {
        preFrame: RawFrame;
        region: { x: number; y: number; width: number; height: number };
        /**
         * Motion axis derived from dispatch direction — "vertical" for
         * up/down scrolls (horizontal strips), "horizontal" for left/right
         * (vertical strips). Used by `computeStripChangedFractions` to
         * partition the window orthogonally to the expected motion.
         */
        axis: "vertical" | "horizontal";
      }
    | null,
): Promise<VisualMotionObservation> {
  if (preUiaPercent !== null && typeof readUiaPercent === "function") {
    const tPostStart = performance.now();
    try {
      // Same bounded-await pattern as the pre-read site (Codex PR #309
      // Round 3 P2 — post must also not block the dispatcher's return
      // for seconds on a slow / hung UIA provider). 100 ms cap; timeout
      // → observation falls back to `chain_trust_unverified`. See
      // `UIA_POST_READ_TIMEOUT_MS` docstring for the rationale and the
      // known native-cancellation limitation.
      const postReadPromise = readUiaPercent({
        hwnd: effectiveHwnd.toString(),
        axis,
      }).catch(() => null);
      const postTimeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), UIA_POST_READ_TIMEOUT_MS),
      );
      const postUiaPercent = await Promise.race([
        postReadPromise,
        postTimeoutPromise,
      ]);
      const postElapsedMs = performance.now() - tPostStart;
      // ADR-019 §2.1: `framesSampled` is documented to be the number of
      // pre/post observation samples this primitive captured. For Stage 1
      // UIA percent reads, that is exactly 2 (pre + post). `totalElapsedMs`
      // is the actual wallclock spent on the pre and post reads — feeds the
      // AC6 fast-path budget bench (Opus Round 1 P2-2).
      const totalElapsedMs = preElapsedMs + postElapsedMs;
      if (postUiaPercent !== null) {
        const delta = postUiaPercent - preUiaPercent;
        if (Math.abs(delta) >= SCROLL_PERCENT_EPSILON_OBSERVATION) {
          return {
            motion: "translation",
            source: "uia_scroll_percent",
            framesSampled: 2,
            totalElapsedMs,
          };
        }
        // pre and post both readable, but no meaningful delta. Honest "no
        // movement" signal — the UIA observer says the receiver did not
        // scroll (boundary / non-scrollable / receiver chose not to act).
        return {
          motion: "no_change",
          source: "uia_scroll_percent",
          framesSampled: 2,
          totalElapsedMs,
        };
      }
    } catch {
      // Any throw during post-snapshot falls through to chain-trust.
    }
  }
  // ADR-019 Stage 2a — chain-trust fall-through with stop-detection +
  // causal strip filter. Activates only when the caller supplied a Stage 2a
  // payload (preFrame + region + axis, gated on `retargetedByLeafWalker` +
  // env toggle in `postWheelToHwnd`).
  //
  // Algorithm (PoC-locked, `docs/adr-019-stage-2a-poc-results.md`):
  //   1. Poll until 2 consecutive inter-frame deltas < STABLE_THRESHOLD
  //      (= visual stability reached), or budget exhausted.
  //   2. Compute strip-wise diff of preFrame vs final stable frame oriented
  //      along the dispatch motion axis (horizontal strips for vertical
  //      scroll). Caret blink touches 1 strip; real scroll touches multiple.
  //   3. Emit raw telemetry. Stage 2a does NOT decide motion — Stage 2b uses
  //      `stripsAboveNoise` + `finalChangedFraction` to gate.
  //
  // No behaviour change in `verifyDelivery.status` / `.reason` / `.channel` —
  // the caller (`postWheelToHwnd`) still emits `delivered_via_postmessage`
  // when the chain-trust branch fires; we only enrich the `observation`
  // envelope hint.
  if (stage2a !== null) {
    try {
      const tRingStart = performance.now();
      const ring = await capturePostFrameUntilStable(
        effectiveHwnd,
        stage2a.region,
        {
          pollIntervalMs: POLL_INTERVAL_MS,
          minWaitMs: MIN_WAIT_MS,
          stableThreshold: STABLE_THRESHOLD,
          consecutiveStableTarget: CONSECUTIVE_STABLE_TARGET,
          budgetMs: RING_WALLCLOCK_BUDGET_MS,
        },
      );
      const ringElapsedMs = performance.now() - tRingStart;

      // The helper returns at least the first capture frame if it
      // succeeded; we need a non-empty `frames[]` to compute the
      // pre-vs-final diff. Empty `frames[]` → first capture failed →
      // fall through to chain_trust_unverified (terminal return below).
      // Opus PR #311 Round 1 P3-1 → Round 2 P3-NEW — refactored from
      // empty-if + else to positive-guard + return-on-success.
      if (ring.frames.length > 0) {
        const finalFrame = ring.frames[ring.frames.length - 1]!;
        const framesSampled = 1 + ring.frames.length;  // 1 preFrame + N polled
        // Use reduce instead of spread to avoid V8 argument-count limits
        // when a future budget raise pushes ring length high (Opus PR #311
        // Round 1 P2-4 defensive — currently safe at ~22 entries but
        // future-proofs the idiom).
        const maxChangedFraction = ring.deltas.reduce(
          (acc, d) => (d > acc ? d : acc),
          0,
        );

        // Strip-wise pre-vs-final diff along the motion axis.
        const stripResult = computeStripChangedFractions(
          stage2a.preFrame,
          finalFrame,
          stage2a.axis,
          STRIP_COUNT,
        );
        const stripsAboveNoise = stripResult.fractions.filter(
          (f) => f > STRIP_NOISE_THRESHOLD,
        ).length;

        // Full-window pre-vs-final diff (also useful when strip filter is
        // uninformative, e.g. window resized mid-ring → sizeMismatch).
        const finalChangedFraction = stripResult.sizeMismatch
          ? 1.0
          : computeChangeFraction(
              stage2a.preFrame.rawPixels,
              finalFrame.rawPixels,
              finalFrame.width,
              finalFrame.height,
              finalFrame.channels,
            );

        // Elapsed timestamps per frame from `tRingStart`. Pre is at t=0
        // (captured upstream); polled frames at their measured offsets.
        // We don't have per-frame timestamps from the helper (only the
        // total elapsed), so approximate evenly across the ring. Stage 2b
        // can refine if granular timing matters.
        const perFrameApprox = ring.frames.length > 0
          ? Array.from(
              { length: ring.frames.length },
              (_, i) =>
                Math.round(
                  MIN_WAIT_MS + (i * (ringElapsedMs - MIN_WAIT_MS)) / Math.max(1, ring.frames.length - 1),
                ),
            )
          : [];

        // ADR-019 Stage 2b — promote `finalChangedFraction > 0` to a
        // decision gate per sub-plan §2.2. Env opt-out
        // (`DESKTOP_TOUCH_STAGE2B_GATE=0`) suppresses just the decision and
        // preserves Stage 2a's `motion: "indeterminate"` wire-level output;
        // ring telemetry is unchanged either way. The caller
        // (`postWheelToHwnd` chain-trust branch) inspects `motion` to choose
        // between `delivered_via_postmessage` and the new TMOL gate-fail
        // outcome `{ scrolled: false, reason: "target_unreachable", observation }`
        // (Option I per sub-plan §5 R3, locked Round 1 P2-2).
        const stage2bGateDisabled =
          process.env.DESKTOP_TOUCH_STAGE2B_GATE === "0";
        const motion = evaluateStage2bGate(finalChangedFraction, {
          stage2bGateDisabled,
        });

        return {
          motion,
          source: "temporal_ring_observation_only",
          framesSampled,
          totalElapsedMs: ringElapsedMs,
          ringTelemetry: {
            framesSampled,
            elapsedMsPerFrame: [0, ...perFrameApprox],
            changedFractions: ring.deltas,
            maxChangedFraction,
            axis: stage2a.axis,
            stripCount: STRIP_COUNT,
            finalStripChangedFractions: stripResult.fractions,
            stripsAboveNoise,
            finalChangedFraction,
            stableReached: ring.stableReached,
            framesToStability: ring.framesToStability,
          },
        };
      }
    } catch {
      // Ring capture threw entirely → fall through to chain_trust_unverified.
    }
  }

  // Chain-trust fall-through: UIA pattern wasn't exposed on the leaf OR the
  // post-snapshot failed. The dispatcher still emits delivered_via_postmessage
  // (PR #308 chain-table trust), but the observation field signals that the
  // delivery is unverified at the observation layer (LLM honest signal).
  return {
    motion: "indeterminate",
    source: "chain_trust_unverified",
    framesSampled: 0,
    totalElapsedMs: 0,
  };
}

// ─── Tier 3 PostMessage helpers (ADR-018 §4 Phase 4) ─────────────────────────

/**
 * Convert (direction, notch) into the Win32-flipped wheel-delta units used in
 * the `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` `wParam` high word. UIA convention
 * (down/right positive) → Win32 convention (forward = scroll up = positive
 * for the **vertical** wheel only; horizontal wheel WM_MOUSEHWHEEL keeps
 * UIA's right=positive). 1 notch = 120 raw `WHEEL_DELTA` units.
 *
 * See sub-plan `docs/adr-018-phase-4-subplan.md` §2.3 sign matrix for the
 * load-bearing per-direction expectations. A second flip on the horizontal
 * axis would silently reverse left/right scrolling.
 */
function win32WheelEncoding(params: WheelParams): {
  message: number;
  signedDelta: number;
} {
  const magnitude = WHEEL_DELTA_PER_NOTCH * Math.abs(params.notch);
  switch (params.direction) {
    case "down":
      // UIA down=+ → Win32 vertical forward=- (scroll up=+ ⇒ scroll down=-).
      return { message: WM_MOUSEWHEEL, signedDelta: -magnitude };
    case "up":
      return { message: WM_MOUSEWHEEL, signedDelta: magnitude };
    case "right":
      // UIA right=+ matches WM_MOUSEHWHEEL right=+ (Vista+ horizontal wheel).
      return { message: WM_MOUSEHWHEEL, signedDelta: magnitude };
    case "left":
      return { message: WM_MOUSEHWHEEL, signedDelta: -magnitude };
  }
}

/**
 * Pack `MAKEWPARAM(modifiers, wheelDelta)` — Win32 macro that places the
 * modifiers in LOWORD and the signed wheelDelta in HIWORD. Both halves are
 * masked to 16 bits so a negative `wheelDelta` (e.g. -120 for vertical down)
 * round-trips as the two's-complement bit pattern HIWORD would re-extract
 * via `(short)HIWORD(wParam)`.
 */
function makeWheelWParam(modifiers: number, wheelDelta: number): bigint {
  const lo = modifiers & 0xffff;
  const hi = wheelDelta & 0xffff;
  return BigInt((hi << 16) | lo) & 0xffffffffn;
}

/**
 * Pack `MAKELPARAM(screenX, screenY)` — low word = X, high word = Y, both
 * as **screen** coordinates. Negative coords (secondary monitor left of
 * primary) are packed via `& 0xFFFF` so the sign bit survives for the
 * receiver's `(short)HIWORD(lParam)` extraction.
 */
function makeScreenLParam(screenX: number, screenY: number): bigint {
  const lo = screenX & 0xffff;
  const hi = screenY & 0xffff;
  return BigInt((hi << 16) | lo) & 0xffffffffn;
}

/**
 * ADR-018 Phase 4 — Tier 3 PostMessage wheel dispatch.
 *
 * Encodes `WM_MOUSEWHEEL` (vertical) or `WM_MOUSEHWHEEL` (horizontal) via
 * `win32_post_message` and verifies the scroll happened with pre/post
 * `win32_get_scroll_info` snapshots on the axis of interest.
 *
 * Returns `DispatchOutcome` on observable delivery; `null` on any failure
 * (missing native binding, no scrollbar to observe, message not consumed by
 * the target HWND — Word `_WwG` MFC custom-paint case, etc.) so the caller
 * can emit `target_unreachable` per ADR §2.6.2 path-(b). Never throws.
 *
 * lParam is `MAKELPARAM(rect.cx, rect.cy)` from `getWindowRectByHwnd` — the
 * window-center screen coordinate. MFC apps frequently use lParam to find
 * the receiving child via `ChildWindowFromPoint`; the window center is the
 * safest neutral hit point. When the rect lookup fails the lParam falls
 * back to 0 (apps that ignore lParam still scroll; apps that hit-test fail
 * observably and emit `target_unreachable`).
 *
 * Exported for unit testing.
 */
/**
 * `GetAncestor` flag for the immediate parent (winuser.h `GA_PARENT`).
 */
const GA_PARENT = 1;

/**
 * Depth cap for the parent walk. Matches the descent's own cap in
 * `find_wheel_leaf_by_hittest`, so the walk can always get back up whatever
 * the descent came down.
 */
const OBSERVATION_CHAIN_MAX_DEPTH = 8;

/**
 * Every HWND whose scroll position could legitimately move in response to a
 * wheel posted at `leaf`, for a target the caller named as `inputHwnd`.
 *
 * `WM_MOUSEWHEEL` propagates UP: an unhandled wheel is passed to the parent,
 * and so on, so the window that ends up scrolling is anywhere on the chain
 * from the post target to the window we were asked to scroll — **including
 * the middle**. Watching only the two ends looks sufficient until an
 * intermediate container owns the scrollbar (a scrollable panel between a
 * WebView host and its render widget), at which point a scroll that plainly
 * happened is reported as `ScrollNotDelivered`.
 *
 * Returns `[leaf]` unchanged for a class-table retarget (the table's leaves
 * ARE the scrolling surface) and for the no-retarget case, so the common paths
 * pay nothing.
 */
function buildObservationChain(
  leaf: bigint,
  inputHwnd: bigint,
  retargetedByHitTest: boolean,
): bigint[] {
  if (!retargetedByHitTest || leaf === inputHwnd) return [leaf];
  const chain: bigint[] = [leaf];
  const getAncestor = nativeWin32?.win32GetAncestor;
  if (typeof getAncestor === "function") {
    let current = leaf;
    for (let depth = 0; depth < OBSERVATION_CHAIN_MAX_DEPTH; depth++) {
      if (current === inputHwnd) break;
      let parent: bigint | null | undefined;
      try {
        parent = getAncestor(current, GA_PARENT);
      } catch {
        break; // Defensive: a native throw must not lose the endpoints below.
      }
      if (parent === null || parent === undefined || parent === current) break;
      if (!chain.includes(parent)) chain.push(parent);
      current = parent;
    }
  }
  // The window the caller named is always watched, even when the walk could
  // not run (missing binding) or stopped early — that keeps this at least as
  // good as watching the two endpoints.
  if (!chain.includes(inputHwnd)) chain.push(inputHwnd);
  return chain;
}

export async function postWheelToHwnd(
  hwnd: bigint,
  params: WheelParams,
): Promise<DispatchOutcome | null> {
  const postMessage = nativeWin32?.win32PostMessage;
  const getScrollInfo = nativeWin32?.win32GetScrollInfo;
  if (typeof postMessage !== "function") return null;
  try {
    // ADR-018 Phase 5+N — WM_MOUSEWHEEL propagation is upward-only (Microsoft
    // Learn / DefWindowProc). For MDI / OLE apps that host the scrollable
    // surface as a deep child (Excel: XLMAIN → XLDESK → EXCEL7; Word:
    // OpusApp → _WwF → _WwG), POST to the top-level HWND never reaches the
    // leaf that owns the scrollbar — the regression dogfooded on main 2026-05-15.
    // The leaf walker consults a small class-name chain table and returns the
    // resolved leaf, or null when the top-level class is not in the table.
    // On null we keep the input HWND (bit-equal to pre-PR behaviour for
    // non-MDI apps). The resolved `effectiveHwnd` is used for **every**
    // subsequent observation, post, and L1 capture call so that observation
    // and dispatch share the same destination (ADR §2.2 invariant).
    const findLeaf = nativeWin32?.win32FindScrollLeafForTopLevel;
    let effectiveHwnd: bigint = hwnd;
    let retargetedByLeafWalker = false;
    if (typeof findLeaf === "function") {
      try {
        const leaf = findLeaf(hwnd);
        if (leaf !== null && leaf !== undefined) {
          effectiveHwnd = leaf;
          retargetedByLeafWalker = true;
        }
      } catch {
        // Defensive: any native throw → keep input HWND (top-level POST).
      }
    }

    // ADR-018 Phase 6 §2.2 — structural fallback, tried ONLY after a class-table
    // miss. WebView hosts (Tauri/WRY, Electron, CEF) put the wheel receiver
    // several levels down and across a process boundary, so no class table can
    // keep up; a hit test down the target's own children finds it structurally.
    //
    // `retargetedByLeafWalker` is deliberately NOT set here. That flag is the
    // chain-trust signal consumed at the `pre === null` branch below: it means
    // "the destination is a KNOWN scroll leaf, so a post to it can be asserted
    // as delivered without a scrollbar reading". A hit-test result carries no
    // such guarantee. Setting it would make every child-hosted window claim
    // `delivered` with no observation behind it — the silent-success mode this
    // pipeline exists to remove — and would also make the Phase 6 §2.3
    // pixel-delta fallback unreachable on exactly the hosts it was built for,
    // since this function would stop returning null for them.
    let retargetedByHitTest = false;
    if (!retargetedByLeafWalker) {
      const findLeafByHitTest = nativeWin32?.win32FindWheelLeafByHittest;
      if (typeof findLeafByHitTest === "function") {
        try {
          const leaf = findLeafByHitTest(hwnd);
          if (leaf !== null && leaf !== undefined) {
            effectiveHwnd = leaf;
            retargetedByHitTest = true;
          }
        } catch {
          // Defensive: any native throw → keep input HWND (top-level POST).
        }
      }
    }

    const { message, signedDelta } = win32WheelEncoding(params);
    // lParam centres on the **leaf** rect so MFC / OLE hit-tests via
    // `ChildWindowFromPoint(lParam)` land inside the recipient. Some Excel
    // versions reject wheels whose lParam falls outside the recipient's
    // client area (web research, 2026-05-15).
    const rect = getWindowRectByHwnd(effectiveHwnd);
    const lParam = rect !== null
      ? makeScreenLParam(
          Math.round(rect.x + rect.width / 2),
          Math.round(rect.y + rect.height / 2),
        )
      : 0n;

    const axisIsVertical =
      params.direction === "up" || params.direction === "down";
    // `axisName` is narrowed to `"vertical" | "horizontal"` by the ternary;
    // both `getScrollInfo` and `uiaReadScrollPercentAtHwnd` accept that union
    // directly so no `as` cast is needed downstream (Opus PR #309 Round 1 P2-1
    // / P2-3 — eliminate the duplicate axis-cast that previously existed at
    // the two call sites).
    const axisName: "vertical" | "horizontal" = axisIsVertical
      ? "vertical"
      : "horizontal";

    // Pre-snapshot is best-effort. Two distinct "no observation" cases must
    // be kept apart (Codex PR #305 review P2-A):
    //   1. `getScrollInfo` is genuinely missing (mixed-version `.node` build
    //      without the Phase 1 GetScrollInfo binding) — caller cannot detect
    //      `target_unreachable` either, so we presume the post is delivered
    //      and let the caller's own observation (`captureScrollSnapshot`
    //      dHash + Win32 in `mouse.ts`) catch a no-op.
    //   2. `getScrollInfo` is present but returns null for THIS HWND (Word
    //      `_WwG`, modern UWP custom-paint, no Win32 scrollbar) — that IS
    //      the `target_unreachable` signal — except when the leaf walker
    //      retargeted to a `SCROLL_LEAF_CHAINS` member (Excel `NUIScrollbar`,
    //      Word MFC), where chain-trust applies (Codex PR #308 P1 follow-up:
    //      an attempt at 8×8 dHash verification was rejected during dogfood
    //      because Excel's mostly-uniform cell grid + row-label strip
    //      collapses to an essentially-constant perceptual hash even when
    //      raw pixels show real change — see §2.6.2 row notes).
    const getScrollInfoAvailable = typeof getScrollInfo === "function";
    // Observation targets. Dispatch and observation answer different questions:
    // dispatch asks "who should receive the message", observation asks "whose
    // scroll position moves". For a class-table retarget those are the same
    // window — the table's leaves ARE the scrolling surface — but for a
    // structural hit-test retarget they need not be.
    //
    // `WM_MOUSEWHEEL` propagates UP (`DefWindowProc`), so a wheel posted to a
    // descendant may be handled anywhere along the chain to the window we were
    // asked to scroll. Watching only one end of that chain produces a false
    // `ScrollNotDelivered` — a scroll that plainly worked, reported as a hard
    // error — and it does so from either end:
    //   - watch only the leaf, and a scrollable frame whose full-size child
    //     panel has no scrollbar reads `null` while the frame scrolls;
    //   - watch only the input window, and a child that owns the real
    //     scrollbar moves invisibly.
    // A first fix that merely preferred the leaf and fell back on `null` still
    // missed a third shape: a child carrying a vestigial `WS_VSCROLL` reads
    // non-null, suppressing the fallback, while the ancestor is what actually
    // scrolls. So watch every candidate and treat motion anywhere on the chain
    // as delivery — which is what upward propagation means.
    const observationHwnds = buildObservationChain(
      effectiveHwnd,
      hwnd,
      retargetedByHitTest,
    );
    const observed = getScrollInfoAvailable
      ? observationHwnds
          .map((h) => ({ hwnd: h, pre: getScrollInfo(h, axisName) }))
          .filter((o): o is { hwnd: bigint; pre: NonNullable<typeof o.pre> } => o.pre !== null)
      : [];
    // The `pre === null` gate below means "no axis is observable anywhere on
    // the chain", which is what routes chain-trust and the caller's own
    // evidence. Keep the first readable candidate as its representative.
    const pre = observed.length > 0 ? observed[0]!.pre : null;

    // ADR-019 Stage 2a — capture the dispatch-pre reference frame (T_pre)
    // *before* the chunking loop runs. Gated on:
    //   - `DESKTOP_TOUCH_STAGE2A_RING !== "0"` (default ON; user opt-out)
    //   - `retargetedByLeafWalker` (chain-trust fallback can only fire when
    //     the leaf walker retargeted — the only path that consumes the
    //     ring telemetry — so we don't waste a capture on standard Tier 3
    //     paths that observe via GetScrollInfo)
    //   - `rect !== null` (we need a region to capture)
    // Capture failure → `preFrame = null` → `observeViaUiaOrChainTrust`
    // sees no Stage 2a payload and emits plain `chain_trust_unverified`.
    // Sub-plan §3 Phase 2 P2-2.
    const stage2aEnvDisabled = process.env.DESKTOP_TOUCH_STAGE2A_RING === "0";
    let preFrame: RawFrame | null = null;
    if (!stage2aEnvDisabled && retargetedByLeafWalker && rect !== null) {
      preFrame = await captureFrame(effectiveHwnd, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }

    // ADR-018 Phase 6 §2.2 — evidence for the retry decision further down.
    //
    // When a structural retarget produces no observable motion there are two
    // possible worlds, and `GetScrollInfo` cannot tell them apart: the leaf
    // consumed the wheel and scrolled something with no Win32 scrollbar (a
    // WebView inside a scrollable frame), or the leaf consumed it and did
    // nothing. Re-posting is right in the second world and scrolls twice in the
    // first. The leaf's own pixels answer it.
    //
    // Captured only in the configuration where a retry could actually fire —
    // structural retarget, and the retry target readable — so the ordinary
    // WebView scroll pays nothing. The condition is decidable here, before
    // dispatch, which is the only place a "pre" frame can be taken.
    const retryCouldFire =
      retargetedByHitTest &&
      effectiveHwnd !== hwnd &&
      observed.some((o) => o.hwnd === hwnd);
    const leafPreFrame =
      retryCouldFire && rect !== null
        ? await captureFrame(effectiveHwnd, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })
        : null;

    // ADR-019 MVP-1 (Stage 1) — read-only UIA `ScrollPercent` pre-snapshot.
    // The dispatcher's chain-trust branch (Case 2a below) prefers UIA percent
    // when available because it's the OS-canonical observation (TMOL
    // `scroll_translation` fast path). Best-effort: null preUiaPercent or any
    // throw falls back to the bare chain-trust assertion (observation.source:
    // "chain_trust_unverified"). Only meaningful when retargetedByLeafWalker
    // is true; for non-MDI apps the Win32 SB_VERT pre-snapshot is the path.
    // ADR-019 MVP-1 (Stage 1) — bounded-await pre-snapshot UIA read. The
    // value MUST be a real pre-dispatch sample (Codex PR #309 Round 2 P2 —
    // a fire-and-forget Promise that resolves AFTER the chunk loop would
    // carry a *post-scroll* value, breaking the chain-trust observation
    // contract). The value MUST NOT block dispatch for seconds (Codex PR
    // #309 Round 1 P2 — a slow/hung UIA provider should not delay sending
    // wheel messages). Resolution: `Promise.race` the pre-read against a
    // tight wallclock budget (`UIA_PRE_READ_TIMEOUT_MS = 100ms`), then
    // proceed with chunking. UIA reads typically return in ~1-5 ms, well
    // under the budget; the 100 ms ceiling caps the worst-case dispatch
    // delay at a level acceptable for an interactive scroll. Timeout →
    // observation falls back to `chain_trust_unverified` honestly.
    //
    // **Gate** (Codex PR #309 Round 4 P2): the UIA pre-read is only useful
    // when `pre === null` (Case 2a chain-trust branch). For Case 1
    // (`getScrollInfoAvailable === false`) and Case 3 (`pre !== null`,
    // standard Tier 3 path) the value is never consumed, so issuing the
    // RPC would only pay up-to-100 ms latency for no benefit (and load
    // the native UIA worker queue unnecessarily). Skip the read in those
    // paths.
    const readUiaPercent = nativeUia?.uiaReadScrollPercentAtHwnd;
    let preUiaPercent: number | null = null;
    let preUiaElapsedMs = 0;
    if (
      retargetedByLeafWalker &&
      pre === null &&
      getScrollInfoAvailable &&
      typeof readUiaPercent === "function"
    ) {
      const tPreStart = performance.now();
      const preReadPromise = readUiaPercent({
        hwnd: effectiveHwnd.toString(),
        axis: axisName,
      }).catch(() => null);
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), UIA_PRE_READ_TIMEOUT_MS),
      );
      const result = await Promise.race([preReadPromise, timeoutPromise]);
      preUiaPercent = result;
      preUiaElapsedMs = performance.now() - tPreStart;
    }

    // Chunk the wheel delta into ≤ 16-bit signed messages so the receiver's
    // `GET_WHEEL_DELTA_WPARAM` (signed short) does not wrap. For typical
    // notch counts (1-10) this loops once. For `notch >= 274` the previous
    // single-message implementation wrapped the sign bit and silently
    // reversed scroll direction (Codex PR #305 review P2-B).
    const sign = signedDelta < 0 ? -1 : 1;
    let postedAny = false;
    // Emit the whole (chunked) wheel request at one HWND. Factored out because
    // a hit-test retarget may have to repeat it at the input window — see the
    // retry below. `logDispatchSink` / L1 record the HWND actually posted to.
    const postAllChunksTo = (targetHwnd: bigint, targetLParam: bigint): boolean => {
      let remaining = Math.abs(signedDelta);
      let postedHere = false;
      while (remaining > 0) {
        const chunkMagnitude = Math.min(remaining, WHEEL_DELTA_MAX_PER_MSG);
        const chunkSigned = sign * chunkMagnitude;
        const wParam = makeWheelWParam(0, chunkSigned);
        // ADR-035 Phase 1 — recorded HERE, at the real message boundary, not at
        // the tier-3 branch above: every early return before this point (missing
        // native binding, a zero-magnitude call, a pre-dispatch failure) would
        // otherwise write a dispatch event for a message that was never posted
        // (Codex Round 1 P2). Once per call, not per chunk; the handle is the
        // LEAF the walker resolved, which is what actually receives the message.
        if (!postedHere) {
          logDispatchSink({ sink: "postmessage", tool: "scroll", targetHwnd, tier: "3" });
        }
        const posted = postMessage(targetHwnd, message, wParam, targetLParam);
        if (!posted) {
          // Receiver rejected this chunk. If at least one earlier chunk
          // delivered, fall through to observation; if NOTHING posted, report
          // that so the caller emits target_unreachable.
          break;
        }
        postedHere = true;
        postedAny = true;
        // ADR-007 P5a L1 capture contract — record every successful chunk to
        // the L1 ring for replay-accurate observability. `postMessageToHwnd`
        // in `src/engine/win32.ts:602` does this for the WM_CHAR/WM_KEY
        // paths; Tier 3 wheel posts must follow the same contract or the L1
        // stream loses an entire input class. (Opus PR #305 Round 1 P2-1.)
        // ADR-018 Phase 5+N: records the **leaf** HWND (effectiveHwnd) — the
        // destination-explicit record per ADR-007 P5a contract.
        nativeL1?.l1PushHwInputPostMessage?.(
          targetHwnd,
          message >>> 0,
          wParam,
          targetLParam,
        );
        remaining -= chunkMagnitude;
      }
      return postedHere;
    };

    postAllChunksTo(effectiveHwnd, lParam);

    // `notch=0` (or any zero-magnitude call) loops zero times → nothing was
    // ever posted. Surface as null so the caller emits `target_unreachable`
    // rather than claiming a false-positive delivery from the mixed-version
    // observation-API-missing branch below (Opus PR #305 Round 3 P2-1).
    if (!postedAny) return null;

    await new Promise((r) => setTimeout(r, POSTMESSAGE_SETTLE_MS));

    // Case 1 — observation API genuinely missing: presume delivered.
    if (!getScrollInfoAvailable) {
      return {
        scrolled: true,
        channel: "postmessage",
        reason: "delivered_via_postmessage",
      };
    }
    // Case 2 — pre-snapshot null splits two ways:
    //   2a. Leaf walker retargeted (e.g. Excel `XLMAIN → XLDESK → EXCEL7`,
    //       Word `OpusApp → _WwF → _WwG`): the leaf is in the
    //       `SCROLL_LEAF_CHAINS` table that pins which HWND classes are
    //       documented scroll receivers. These leaves use custom-painted
    //       scrollbars (Excel `NUIScrollbar`, Word MFC custom paint) that
    //       `GetScrollInfo(SB_VERT)` cannot observe. Trust the chain-table
    //       assertion: PostMessage queued + leaf is a documented receiver
    //       = `delivered_via_postmessage`. The semantics match Tier 1 UIA's
    //       boundary handling (`mouse.ts::evaluateScrollDelivery`), which
    //       treats "at-boundary, no movement" as a successful no-op
    //       delivery — the wheel reached the receiver, which decided how
    //       to act. PR #308 Codex P1 raised a false-positive concern; the
    //       dogfood-evaluated dHash verification (commit ee364c4) was
    //       reverted because 8×8 perceptual hashing of Excel's mostly-
    //       uniform cell grid + dark-gray row-label strip yields
    //       essentially-constant macro patterns regardless of which rows
    //       are visible — empirical raw-byte diff after a 3-notch wheel
    //       shows 0.36 % of bytes change (Excel actually scrolled) while
    //       the 8×8 dHash is byte-identical (information lost in the
    //       downsample). dHash is therefore structurally inadequate as a
    //       chain-trust gate. Future work could plug a higher-resolution
    //       hash or a UIA-cell-name observation; for now the chain-table
    //       membership IS the trust signal.
    //   2b. No retarget AND `pre === null`: the input HWND has no Win32
    //       scrollbar and is not in any chain table → no trust signal →
    //       caller emits `target_unreachable` per ADR §2.6.2 path-(b).
    if (pre === null) {
      if (retargetedByLeafWalker) {
        // ADR-019 MVP-1 Case 2a: try UIA `ScrollPercent` observation BEFORE
        // emitting the bare chain-trust assertion. When the leaf (or one of
        // its UIA ancestors / descendants) exposes a ScrollPattern whose
        // pre/post percent differ by ≥ SCROLL_PERCENT_EPSILON_OBSERVATION,
        // attach an `observation.source: "uia_scroll_percent"` with the
        // numeric percent delta. Otherwise attach `observation.source:
        // "chain_trust_unverified"` so the caller knows the delivery is
        // unverified (Stage 1 honest signal; Stages 2-5 upgrade this).
        // `preUiaPercent` and `preUiaElapsedMs` were captured ABOVE the
        // chunking loop via `Promise.race` against `UIA_PRE_READ_TIMEOUT_MS`
        // (Codex PR #309 Round 2 P2 — pre value must be a real pre-dispatch
        // sample; Round 1 P2 — bounded so a slow provider does not stall
        // dispatch for seconds).
        const observation = await observeViaUiaOrChainTrust(
          effectiveHwnd,
          axisName,
          preUiaPercent,
          preUiaElapsedMs,
          readUiaPercent,
          // ADR-019 Stage 2a: pass T_pre frame + region + motion axis so the
          // chain-trust fall-through can run stop-detection polling and
          // attach causal-strip telemetry. `preFrame === null` or
          // `rect === null` → no Stage 2a payload → bare
          // `chain_trust_unverified`. The motion axis derives from the
          // dispatch direction (vertical for up/down, horizontal for
          // left/right) so the strip filter partitions orthogonally to the
          // expected motion (sub-plan §2.1.1, PoC results §8).
          preFrame !== null && rect !== null
            ? {
                preFrame,
                region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                axis: axisName,
              }
            : null,
        );
        // ADR-019 Stage 2b sub-plan §2.2 / §5 R3 Option I: when the Stage 2a
        // temporal-ring gate observed `motion: "no_change"` (ring captured
        // AND `finalChangedFraction === 0` AND env opt-out not set), return a
        // **non-null** `DispatchOutcome` with `scrolled: false` AND
        // `reason: "target_unreachable"` carrying the observation. Caller
        // (`mouse.ts:scrollHandler`) detects this shape and routes to the
        // `not_delivered` envelope. `null` is reserved for "fall through to
        // next tier" semantics which the chain-trust branch doesn't use.
        //
        // **Gated on `source: "temporal_ring_observation_only"`**: the UIA
        // observer's existing `motion: "no_change"` signal (Codex PR #308
        // P1 trade-off — boundary / no-op) MUST keep its prior
        // `delivered_via_postmessage` semantics so existing
        // `tests/unit/input-pipeline-dispatch.test.ts` UIA-boundary
        // contracts and the in-code comment "Honest 'no movement' signal —
        // the UIA observer says the receiver did not scroll
        // (boundary / non-scrollable / receiver chose not to act)"
        // continue to hold. Stage 2b only promotes the temporal-ring
        // observation to a gate; the UIA observation path is unaffected.
        if (
          observation.motion === "no_change" &&
          observation.source === "temporal_ring_observation_only"
        ) {
          return {
            scrolled: false,
            channel: "postmessage",
            reason: "target_unreachable",
            observation,
          };
        }
        return {
          scrolled: true,
          channel: "postmessage",
          reason: "delivered_via_postmessage",
          observation,
        };
      }
      return null;
    }
    // Motion on ANY watched HWND counts: the post travels up the chain, so the
    // window whose position changes is not necessarily the one it was sent to.
    // Each candidate's post is read from the same HWND as its own pre.
    const observeMotion = (): boolean =>
      observed.some((o) => {
        const post = getScrollInfo!(o.hwnd, axisName);
        return (
          post !== null &&
          Math.abs(post.nPos - o.pre.nPos) >= POSTMESSAGE_SCROLL_DELIVERY_EPSILON_NPOS
        );
      });

    let moved = observeMotion();

    // Dispatch retry for a structural retarget.
    //
    // Note for anyone joining resolve→dispatch telemetry: when this fires, the
    // tool call emits TWO `logDispatchSink` events with different `targetHwnd`.
    // That is the truth — two posts really happened — but analysis that assumes
    // one dispatch per call needs to account for it. Upward propagation is what
    // makes posting to a descendant safe, but it only holds when that
    // descendant hands the message to `DefWindowProc`. A child that CONSUMES
    // `WM_MOUSEWHEEL` without scrolling and without forwarding breaks the
    // assumption, and the window whose handler used to do the scrolling never
    // sees the wheel at all — a regression against posting to the top level,
    // which is what this code did before the hit test existed. So when a
    // hit-test retarget produced no motion anywhere we can see, send the same
    // request to the window the caller actually named.
    //
    // Only retry when the RETRY TARGET's own movement is observable. The risk
    // being guarded against is scrolling twice: if the first post already
    // reached `hwnd` by propagation and moved it, but we cannot see `hwnd`'s
    // position, then "no motion seen" does not mean "nothing happened" and a
    // second post adds a second scroll.
    //
    // "Something on the chain is readable" is NOT sufficient, and the gap is
    // reachable in exactly the shape that motivated watching the chain at all:
    // a leaf with custom-painted scrollbars (unreadable), an intermediate
    // container carrying a vestigial `WS_VSCROLL` (readable, never moves), and
    // a custom-paint top level (unreadable). The wheel bubbles to the top
    // level and scrolls it; `observeMotion` sees only the static middle and
    // reports nothing; a gate on "any candidate readable" is satisfied by that
    // middle and fires the retry — double scroll.
    //
    // Narrowing the gate to `hwnd` itself also makes it load-bearing: with the
    // earlier `observed.length > 0` form, the unobservable-`pre` branch already
    // returned first, so removing it changed nothing and a mutation test could
    // not see it.
    // The leaf acted if its pixels moved, even though no scrollbar shows it.
    // Frames of different shape are not comparable (the capture stack re-picks
    // its stage per call), so that counts as "no evidence the leaf acted" and
    // the retry proceeds — the same direction the null-frame case takes.
    const leafActed = await (async (): Promise<boolean> => {
      if (!retryCouldFire || moved || leafPreFrame === null || rect === null) return false;
      const leafPostFrame = await captureFrame(effectiveHwnd, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      if (leafPostFrame === null) return false;
      if (
        leafPostFrame.width !== leafPreFrame.width ||
        leafPostFrame.height !== leafPreFrame.height ||
        leafPostFrame.channels !== leafPreFrame.channels ||
        leafPostFrame.rawPixels.length !== leafPreFrame.rawPixels.length
      ) {
        return false;
      }
      return !leafPostFrame.rawPixels.equals(leafPreFrame.rawPixels);
    })();

    if (!moved && retryCouldFire && !leafActed) {
      const inputRect = getWindowRectByHwnd(hwnd);
      const inputLParam =
        inputRect !== null
          ? makeScreenLParam(
              Math.round(inputRect.x + inputRect.width / 2),
              Math.round(inputRect.y + inputRect.height / 2),
            )
          : lParam;
      if (postAllChunksTo(hwnd, inputLParam)) {
        await new Promise((r) => setTimeout(r, POSTMESSAGE_SETTLE_MS));
        moved = observeMotion();
      }
    }

    // The leaf's pixels decide in both directions. Above they suppress a retry
    // that would scroll a second surface; here they are the only evidence that
    // the wheel arrived at all, because nothing on the observation chain moved.
    //
    // Dropping them at this point returns `null`, which the caller turns into a
    // hard `ScrollNotDelivered` — for a WebView that visibly scrolled. Its own
    // pixel fallback cannot rescue that: it runs only when the window it
    // watched exposes no scrollbar on either axis, and this shape is reachable
    // exactly when it does (a scrollable frame hosting a WebView child, the
    // frame's scrollbar readable and stationary).
    //
    // Ranked as `pixel_delta_observed`, the same reason the caller-side
    // comparison emits, and for the same reason: a changed frame proves the
    // leaf repainted, not that a view scrolled, so it sits below the Win32
    // percent diff in the §2.6.2 taxonomy.
    if (!moved && leafActed) {
      return {
        scrolled: true,
        channel: "postmessage",
        reason: "pixel_delta_observed",
      };
    }

    if (!moved) return null;

    return {
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    };
  } catch {
    return null;
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Phase 1b dispatcher. Returns `DispatchOutcome` when a tier handled the
 * dispatch, or `null` when the caller should fall through to the next tier
 * (Tier 4 SendInput in Phase 1b).
 *
 * - `kind === 'hwnd'`: probes Tier 1 UIA via the static-imported
 *   `uiaScrollByWheelAtHwnd` native call. If the HWND exposes a
 *   ScrollPattern ancestor AND the Rust path observes
 *   `|post_percent - pre_percent| >= SCROLL_PERCENT_EPSILON` (ADR §2.6.2
 *   emission condition for `delivered_via_uia`), returns
 *   `{ scrolled: true, channel: 'uia', reason: 'delivered_via_uia' }`.
 *   Otherwise returns `null` (caller falls through to legacy nutjs).
 * - `kind === 'uia'`: future-reserved (Phase 3 or later). The resolver does
 *   not emit `'uia'` in Phase 1b, so this branch is dormant. It dispatches
 *   through the same Tier 1 native path as `'hwnd'` and, like `'hwnd'`,
 *   returns `null` on native failure — `dispatchScrollWheel` itself never
 *   throws. The *failure-path* asymmetry is at the **caller**: `mouse.ts`
 *   calls `assertTier4Reachable(dest)` before the nutjs fallback, which lets
 *   an `'hwnd'` destination fall through but THROWS for `'uia'` (an
 *   explicit-UIA destination must never silently fall to cursor-routed
 *   SendInput — that is the guard's purpose). The asymmetry is intentional
 *   and harmless while the branch is dormant.
 * - `kind === 'cdp'`: Phase 3 stub — returns `null` so caller falls through.
 *   The `assertTier4Reachable` guard prevents misuse — see signature note.
 * - `kind === 'unresolved'`: returns `null` (caller invokes Tier 4 SendInput
 *   after `assertTier4Reachable(dest)` passes).
 *
 * Any thrown native error causes dispatch to return `null` and the caller
 * falls through to legacy.
 */
export async function dispatchScrollWheel(
  dest: InputDestination,
  params: WheelParams,
): Promise<DispatchOutcome | null> {
  if (dest.kind === "hwnd" || dest.kind === "uia") {
    // ADR §2.1 D1 — try Tier 1 UIA first. The native call returns null /
    // ok:false when the HWND lacks a ScrollPattern ancestor (Word document,
    // modern UWP, accessibility-blind custom paint) so we fall through to
    // Tier 3 PostMessage rather than returning null immediately (Phase 4).
    //
    // `'uia'` branch: today no resolver emits `'uia'` (Phase 1b sub-plan
    // §2.1#1) so the kind is dormant. When a future resolver does emit it
    // (e.g. an explicit-element resolver passing in a UIA AutomationElement),
    // Tier 3 PostMessage on the same HWND is a SAFE escape hatch — the
    // destination is still HWND-anchored, no cursor-pixel routing occurs.
    // If a future design wants `'uia'` to be UIA-only (no Tier 3 fall-back),
    // split this branch. As of Phase 4 the dormant branch matches `'hwnd'`
    // semantics. (Opus PR #305 Round 1 P2-3.)
    try {
      // Resolve the Tier 1 native call through the tolerant `native-engine.ts`
      // loader — NOT a direct `import from "../../index.js"`, which `throw`s at
      // module-init time when the `.node` binary is missing (`index.js:35-43`),
      // defeating the graceful-degradation intent of the guard below (Codex
      // PR #288 Round 6 P1). `nativeUia` is `null` when the addon is absent,
      // and `uiaScrollByWheelAtHwnd` is `undefined` on older `.node` builds
      // without the Phase 1b export — both cases fall through to Tier 3.
      const scrollByWheel = nativeUia?.uiaScrollByWheelAtHwnd;
      if (typeof scrollByWheel === "function") {
        const wheelDelta = wheelDeltaForNotch(params);
        const result = (await scrollByWheel({
          hwnd: dest.hwnd.toString(),
          wheelDeltaY: wheelDelta.y,
          wheelDeltaX: wheelDelta.x,
        })) ?? { ok: false, scrolled: false };
        // ADR-035 Phase 1 — recorded from the RESULT, not before the call: the
        // native side returns `ok:false` without ever reaching
        // `SetScrollPercent` when the target has no usable ScrollPattern, and
        // the caller then falls through to Tier 3. Logging on entry would put
        // both a UIA and a PostMessage dispatch in the log for one write
        // (Codex Round 2). `ok:true, scrolled:false` DID call it — a boundary
        // no-op is still a dispatch.
        if (result.ok === true) {
          logDispatchSink({ sink: "uia", tool: "scroll", targetHwnd: dest.hwnd, tier: "1" });
        }
        if (result.ok === true && result.scrolled === true) {
          return {
            scrolled: true,
            channel: "uia",
            reason: "delivered_via_uia",
          };
        }
        // ok:false or scrolled:false → fall through to Tier 3 PostMessage.
      }
    } catch {
      // Tier 1 native crash → fall through to Tier 3 (best-effort).
    }
    // ADR-018 Phase 4 — Tier 3 PostMessage fall-through. Covers Word `_WwG`,
    // Excel cell area, Explorer ListView, and other destinations that have a
    // resolvable HWND but no ScrollPattern. `postWheelToHwnd` returns null on
    // either "message not consumed" or "no observable scrollbar diff"; the
    // caller (`mouse.ts:scrollHandler`) reads `dest.kind === 'hwnd'` AND
    // dispatcher null → emits `target_unreachable` per ADR §2.6.2 path-(b)
    // and does NOT fall through to Tier 4 SendInput.
    return await postWheelToHwnd(dest.hwnd, params);
  }
  if (dest.kind === "cdp") {
    // ADR-018 Phase 3 — Tier 2 CDP wheel dispatch. Pre/post observation via
    // `readScrollPositionInTab` (document.scrollingElement); we declare
    // `delivered_via_cdp` only when both endpoints succeed AND scrollTop /
    // scrollLeft moved by at least CDP_SCROLL_DELIVERY_EPSILON_PX on the
    // axis of interest. Any failure (no session, JS exception, no observable
    // delta) returns null — caller emits `target_unreachable` per §2.6.2
    // path-(b) because Tier 4 SendInput must not be reached for a resolved
    // CDP destination (assertTier4Reachable throws on kind:'cdp').
    try {
      const port = getCdpPort();
      const pre = await readScrollPositionInTab(dest.tabId, port);
      if (pre === null) return null;
      const wheelDelta = wheelDeltaForNotch(params);
      // CDP dispatchMouseEvent requires viewport coordinates. Phase 3 sends
      // wheels at the viewport center; per-element coords (ADR §7 OQ6) are a
      // future phase. The tab is the destination, not the point.
      const cx = params.x ?? Math.floor(pre.clientWidth / 2);
      const cy = params.y ?? Math.floor(pre.clientHeight / 2);
      // Recorded AFTER the await for the same reason as Tier 1: the helper
      // resolves the tab and opens a session first, and either can fail — the
      // surrounding catch turns that into a plain `null` outcome, so an event
      // on entry would report a wheel that was never sent (Codex Round 2). The
      // await resolving means the protocol command went out.
      await dispatchWheelInTab(
        wheelDelta.x,
        wheelDelta.y,
        cx,
        cy,
        dest.tabId,
        port,
      );
      logDispatchSink({ sink: "cdp", tool: "scroll", targetHwnd: null, tier: "2" });
      // Settle: CDP wheel handling is synchronous on the renderer side but
      // scrollTop reflects the layout-flushed value. A tiny yield is enough
      // to land on the post-frame state without burning latency.
      await new Promise((r) => setTimeout(r, 16));
      const post = await readScrollPositionInTab(dest.tabId, port);
      if (post === null) return null;
      const axisIsVertical =
        params.direction === "up" || params.direction === "down";
      const observedDelta = axisIsVertical
        ? Math.abs(post.scrollTop - pre.scrollTop)
        : Math.abs(post.scrollLeft - pre.scrollLeft);
      if (observedDelta < CDP_SCROLL_DELIVERY_EPSILON_PX) {
        return null;
      }
      return {
        scrolled: true,
        channel: "cdp",
        reason: "delivered_via_cdp",
      };
    } catch {
      return null;
    }
  }
  // unresolved → caller handles (Tier 4 SendInput fall-through)
  return null;
}

/**
 * Convert (direction, notch) into signed wheel-delta units. 1 notch = 120
 * units (the value of `WHEEL_DELTA` since Windows 2000); the Rust UIA path
 * scales this against `ScrollPattern.VerticalViewSize` to derive a percent
 * step. Down / right are positive, up / left negative — the UIA-internal
 * convention documented on `WheelParams` above. This is the **opposite** of
 * the Win32 `WM_MOUSEWHEEL` wParam high-word convention (positive = wheel
 * rotated forward = scroll up); Phase 4 PostMessage encoding MUST flip the
 * sign at the `postWheelToHwnd` napi boundary.
 */
function wheelDeltaForNotch(params: WheelParams): { x: number; y: number } {
  const unit = WHEEL_DELTA_PER_NOTCH * params.notch;
  switch (params.direction) {
    case "down":
      return { x: 0, y: unit };
    case "up":
      return { x: 0, y: -unit };
    case "right":
      return { x: unit, y: 0 };
    case "left":
      return { x: -unit, y: 0 };
  }
}
