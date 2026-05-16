# ADR-019 Stage 4 sub-plan — SSIM `local_repaint` primitive for click / keyboard BG verifyDelivery

- Status: **Draft (Round 0)** — sub-plan establishing the scope, helpers, and wiring for the `local_repaint` TMOL primitive. Implementation lands in a follow-up PR.
- Date: 2026-05-16
- Authors: Claude (Sonnet drafting)
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Sibling sub-plans:
  - `docs/adr-019-stage-2a-plan.md` — stop-detection polling + causal strip filter (the `scroll_translation` temporal infrastructure Stage 4 reuses)
  - `docs/adr-019-stage-2a-poc-results.md` — locked parameters Stage 4 inherits (`POLL_INTERVAL_MS=30`, `MIN_WAIT_MS=50`, `STABLE_THRESHOLD=0.002`, `CONSECUTIVE_STABLE_TARGET=2`, `RING_WALLCLOCK_BUDGET_MS=700`)
  - `docs/adr-019-stage-2a-dogfood-results.md` — dogfood validation of the shared helpers
- Predecessor PRs (must merge before Stage 4 impl):
  - PR #309 — ADR-019 MVP-1 / Stage 1 UIA `ScrollPercent` (canonical `VisualMotionObservation` contract)
  - PR #311 — Stage 2a impl (`captureFrame`, `capturePostFrameUntilStable`, `computeStripChangedFractions` exported helpers)
  - PR #312 — Stage 2a dogfood (closes Stage 2a Phase 6)
- This PR (sub-plan only): branch `feature/adr-019-stage-4-plan`, **no production code changes**.
- Successor: Stage 4 **impl PR** (~3-5 days, separate review cycle per CLAUDE.md §3.3).
- Walking-skeleton classification: **expansion** sub-plan for the `local_repaint` primitive (the trunk-direct path is Stage 2a's `scroll_translation`; Stage 4 layers SSIM atop the same temporal infrastructure).

---

## 0. Why Stage 4 now

The `mouse_click.verifyDelivery` (`src/tools/_mouse-verify.ts`) and `keyboard.type` BG verify (`src/tools/keyboard.ts:1085-1187`) currently classify delivery on UIA / focused-element / scrollbar / TextPattern / ValuePattern read-back. For **custom-paint surfaces** — Photoshop / Blender / GPU games / Avalonia draw canvases / Paint.NET / GIMP / Krita / OBS preview — none of those channels report change, so:

- `mouse_click` returns `status: "focus_only"` or `status: "unverifiable"` even when the click visibly drew a focus rectangle or selected a brush handle.
- `keyboard:type` returns `BackgroundInputNotDelivered` (`verifyReason: "read_back_unsupported"`) when neither TextPattern nor ValuePattern exposes the focused control's text — the LLM sees `not_delivered` for an action that did land.

ADR-019 §1.3 names this the `local_repaint` primitive: "did a known sub-rect change without translating?". The standard answer per Wang, Bovik, Sheikh, Simoncelli 2004 is SSIM on the focused-element rectangle. Stage 4 wires that into both `mouse_click.verifyDelivery` and `keyboard:type` BG verify as a **fallback observer** that activates only when the existing heuristics produced `focus_only` / `unverifiable`.

This closes the click / BG-keyboard leg of the anti-fukuwarai v3 surface. The scroll leg is covered by Stage 1 (UIA `ScrollPercent`) + Stage 2a (temporal ring + strip filter) and the `desktop_act` leg is covered by `any_change` (Stage 5, deferred).

---

## 1. Context

### 1.1 What's already in place (do not re-build)

| Asset | Where | Stage 4 reuses |
|---|---|---|
| `VisualMotionObservation` contract (8-value `source` enum incl. `ssim_residual`) | `src/tools/_input-pipeline.ts:327-450` + ADR-019 §2.1 + ADR-018 §2.6 | yes — Stage 4 sets `motion: "local_repaint"` + `source: "ssim_residual"` |
| `captureFrame(hwnd, region)` | `src/engine/layer-buffer.ts:490-495` | yes — pre-action reference frame |
| `capturePostFrameUntilStable(hwnd, region, opts)` | `src/engine/layer-buffer.ts:519-589` | yes — post-action stable frame using inherited stop-detection constants |
| `computeChangeFraction` (block-SAD, SSE2 native + TS fallback) | `src/engine/layer-buffer.ts:84-125` | yes — full-window pre-filter before SSIM (cheap reject of `no_change`) |
| `RawFrame` type | `src/engine/layer-buffer.ts:475-480` | yes — Stage 4 helpers consume / emit `RawFrame` |
| `UiElement.boundingRect` (UIA-tree walker) | `src/engine/uia-bridge.ts:393` + Rust `src/uia/tree.rs:174-210` (`CurrentBoundingRectangle`) | yes — focused-element rect source |

### 1.2 What Stage 4 must add

1. **SSIM compute primitive** producing `residual.fractionChanged` ∈ [0, 1] over an optional sub-rect of the captured frames.
2. **Focused-element rect resolver** that turns the click coordinate / focused control's UIA bounds into the rect Stage 4 captures.
3. **Wiring**: a `verifyLocalRepaint(...)` helper called by `mouse_click` and `keyboard:type` after their existing heuristics tier returned `focus_only` / `unverifiable`.

### 1.3 Scope boundary (Stage 4 vs adjacent stages)

| Concern | Stage 4 (this plan) | Adjacent stage |
|---|---|---|
| `mouse_click` focused-rect SSIM fallback | **yes** | n/a |
| `keyboard:type` BG verify focused-rect SSIM fallback | **yes** | n/a |
| `scroll` chain-trust observation | no — Stage 2a | Stage 2a (`scroll_translation` primitive) |
| `desktop_act` post-state full-window change | no — Stage 5 carry-over | Stage 5 (`any_change` primitive, DXGI dirty-rect) |
| Block motion vectors | no — Stage 2b | Stage 2b (`scroll_translation` deferred algorithm) |
| Tiled phase correlation | no — Stage 3 | Stage 3 |
| Optical flow | no — Stage 6 deferred | Stage 6 |
| GPU dispatch (DirectML) | no — Stage 8 deferred | Stage 8 (opportunistic, ≥1080p windows) |
| Caret-region masking | **partial** — Stage 4 emits whole-rect SSIM; caret-masking refinement is OQ (§7) | future Stage 4 follow-up |

---

## 2. Decision

Adopt a **`local_repaint` primitive** built on three pillars:

1. **`compute_ssim_residual` napi binding (Rust, AVX2 + SSE2 + scalar runtime dispatch)** producing `(residual.fractionChanged, centroid?)` for a pre/post pair.
2. **`resolveLocalRepaintRect(hint)` TS helper** returning the rect Stage 4 captures (focused control bounds + click-coord fallback + dynamic intersection with window region).
3. **`verifyLocalRepaint(opts)` orchestrator** wiring `captureFrame` + `capturePostFrameUntilStable` + `computeChangeFraction` (cheap reject) + `compute_ssim_residual` into a single `Promise<VisualMotionObservation>` invocation, callable from both `mouse.ts` and `keyboard.ts`.

### 2.1 The SSIM primitive (Rust napi)

```rust
/// ADR-019 §2.3.2 — SSIM residual between two same-size pre/post frames.
///
/// Implementation: Wang et al. 2004 reference (L=255, K1=0.01, K2=0.03)
/// over an 8×8 sliding window with stride 4. Per-window SSIM is computed
/// from sliding means / variances / covariance; the residual map is
/// `1.0 - ssim_window` per window, thresholded at `RESIDUAL_WINDOW_THRESHOLD`
/// (default 0.05) and aggregated to `fractionChanged`.
///
/// `region` selects an inner sub-rect (in pre / post coordinates); pass
/// `None` for whole-frame. The centroid (when emitted) is the mean position
/// of windows above threshold, useful for the click-feedback case where
/// "where did the repaint land?" is informative for the LLM.
///
/// Runtime SIMD dispatch (`is_x86_feature_detected!("avx2")`): AVX2 → SSE2
/// fallback → scalar floor. Same pattern as `compute_change_fraction` in
/// `src/pixel_diff.rs`.
#[napi]
pub fn compute_ssim_residual(
  pre: Buffer,
  post: Buffer,
  width: u32,
  height: u32,
  channels: u32,    // 3 or 4
  region: Option<SsimRegion>,
) -> napi::Result<SsimResidualResult>;

#[napi(object)]
pub struct SsimRegion {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

#[napi(object)]
pub struct SsimResidualResult {
  /// Fraction of 8×8 sliding windows whose `1 - SSIM` exceeded
  /// `RESIDUAL_WINDOW_THRESHOLD` (default 0.05). 0.0 means no change;
  /// 1.0 means every window changed.
  pub fraction_changed: f64,
  /// Mean window-coordinate centroid of the above-threshold windows.
  /// Omitted when `fraction_changed === 0` (no changed windows to mean).
  pub centroid: Option<SsimCentroid>,
  /// Mean SSIM across all windows in the region. Useful for the Wang
  /// "perceptually identical" cutoff (≥ 0.99) as a no_change sanity check.
  pub mean_ssim: f64,
}

#[napi(object)]
pub struct SsimCentroid {
  pub x: f64,
  pub y: f64,
}
```

Rationale for Rust over TS:

- SSIM's sliding-window stats are the same shape as `computeChangeFraction` (already SSE2 in `pixel_diff.rs`); the existing native pattern + runtime SIMD dispatch carry over with low risk.
- AVX2 buys 2× over SSE2 on the per-window means / variances; ADR-019 §4.5 already names AVX2 as the Stage 4 SIMD target.
- A pure-TS SSIM would miss ADR-019 AC6 compute sub-budget (≤ 15 ms p99 for a 400×400 rect) on AVX2-class hosts; PoC of the Stage 2a `computeChangeFraction` TS fallback shows ~10× slower than the native path on the same buffers.
- ADR-008 D1-5 cdylib constraint applies (the SSIM crate must compile under `crate-type = ["cdylib"]` without pulling new dynamic deps). Hand-rolling per `pixel_diff.rs` rather than depending on the `dssim` crate avoids the C-FFI ICC profile lookup that `dssim` enables; we want a pure-Rust path that builds with the existing `windows-rs` + `napi` toolchain only. (If empirical bench shows hand-rolled is materially slower than `dssim`'s AVX2 path, Stage 4 follow-up can swap; for the sub-plan the hand-rolled path is the default.)

`compute_ssim_residual` lives in **`src/ssim.rs`** (new module at the same depth as `dhash.rs` / `pixel_diff.rs` / `image_processing.rs`; the repo has no `src/image/` directory and ADR-019 §3's `src/image/ssim.rs` SSOT row is corrected accordingly — see §3 SSOT corrections below).

### 2.2 The focused-element-rect resolver (TS)

**P16 decision lock default (b) — `focused_element` rectSource DROPPED.** Neither `ResolvedWindow` (`src/tools/_resolve-window.ts:149-164`, fields `{ title; hwnd; warnings; className? }`) nor `UiaFocusInfo` (`src/engine/uia-bridge.ts:404-410`, fields `{ name; controlType; automationId?; value? }`) carries a `boundingRect`; only `UiElement` (`src/engine/uia-bridge.ts:393`) does, and it is not on the mouse / keyboard verify path today. Adding a new UIA bounding-rect RPC for Stage 4 would add ~10-50 ms unbudgeted in the §6 AC6 700 ms wallclock cap (per impl-PR Round 0 P16 analysis). Resolver therefore handles two strategies only — `point_padded` and `window_fallback`.

```ts
/** ADR-019 Stage 4 — resolve the rect Stage 4 captures around the click.
 *  Returns the rect in screen coordinates (matches `captureFrame`'s
 *  `region` contract; same as Stage 2a). */
export interface LocalRepaintRectHint {
  /** Click coordinate (screen px), present for `mouse_click`. Keyboard path
   *  falls through to `window_fallback` when no point is meaningful. */
  point?: { x: number; y: number };
  /** Containing window rect — Stage 4 clips its capture to this to avoid
   *  reading desktop / other windows when the point pad overflows. */
  windowRect: { x: number; y: number; width: number; height: number };
}

export interface ResolvedLocalRepaintRect {
  /** The rect Stage 4 captures (clipped to windowRect, padded around point). */
  rect: { x: number; y: number; width: number; height: number };
  /** Diagnostic — which input strategy produced the rect. */
  rectSource: "point_padded" | "window_fallback";
}

export function resolveLocalRepaintRect(
  hint: LocalRepaintRectHint,
): ResolvedLocalRepaintRect;
```

Resolution policy (priority order):

1. **`point` ± `LOCAL_REPAINT_POINT_PAD_HALF = 96 px`** (192×192 square centred on the click), clipped to `windowRect`. `rectSource: "point_padded"`. The 192 px default is calibrated for click-feedback rectangles (focus ring, ripple, button highlight typically ≤ 64 px); 192 leaves ~64 px slack on each side.
2. **`windowRect`** fallback when no point is supplied OR the point's `point_padded` square does not intersect `windowRect` (overlapping windows / off-canvas click). `rectSource: "window_fallback"`. Wider rect → higher SSIM compute cost; combined with R3's `MAX_RECT_AREA_PX = 1_000_000` cap the orchestrator short-circuits to `motion: "indeterminate"` when the fallback rect is too large.

Padding constants are tuned values; the sub-plan locks initial defaults and an OQ records the carry-over for empirical refinement (§7 OQ #2).

### 2.3 The `verifyLocalRepaint` orchestrator (TS)

```ts
/** ADR-019 Stage 4 — local_repaint primitive orchestrator. Called by
 *  `mouse_click.verifyDelivery` and `keyboard:type` BG verify *after* the
 *  existing UIA heuristics returned `focus_only` / `unverifiable`. */
export async function verifyLocalRepaint(opts: {
  hwnd: bigint;
  hint: LocalRepaintRectHint;
  /** Pre-action frame, optionally pre-captured by the caller (matches
   *  Stage 2a's `preFrame` pattern). When null, Stage 4 captures it inline
   *  before the action — caller must arrange the action to happen between
   *  the call returning the pre-action frame and `verifyLocalRepaint(post)`. */
  preFrame: RawFrame;
}): Promise<VisualMotionObservation>;
```

Internally (after pre-action capture has happened upstream):

1. `capturePostFrameUntilStable(hwnd, rect, {...Stage 2a constants})` — reuse the post-action stop-detection helper. The default `budgetMs = 700` covers the caret-blink cycle Stage 4 also needs to reject.
2. Cheap reject path: `computeChangeFraction(pre, finalStable)` over the whole rect. If `< NO_CHANGE_FLOOR (0.001)` → return `motion: "no_change"` with `source: "ssim_residual"` and `residual` field omitted (the SSIM cascade ran end-to-end and concluded no-change before reaching the SSIM kernel — the source label identifies the pipeline that decided, parallel to Stage 2a emitting `source: "temporal_ring_observation_only"` even on idle baselines where no real motion was found). This short-circuits the expensive SSIM kernel for the common "click landed but rect is unchanged" / "key fell on a focus thief" case.
3. SSIM path: `compute_ssim_residual(pre, finalStable, region=null)` over the captured rect (the helper handles the rect at capture time — SSIM input is already clipped). Compare `fraction_changed`:
   - `≥ RESIDUAL_DELIVERED_FRACTION (0.05)` → `motion: "local_repaint"` with `residual.fractionChanged` + `residual.centroid`. **Caller treats this as a positive delivery signal.**
   - `< RESIDUAL_DELIVERED_FRACTION` AND `mean_ssim ≥ 0.99` → `motion: "no_change"` (Wang perceptually identical floor). **Caller treats this as `not_delivered`.**
   - `< RESIDUAL_DELIVERED_FRACTION` AND `mean_ssim < 0.99` (small residual, not perceptually identical) → `motion: "indeterminate"` with `source: "ssim_residual"`. **Caller treats this as `unverifiable`** — Stage 4 saw weak evidence but cannot commit.

`RESIDUAL_DELIVERED_FRACTION = 0.05` is the Wang et al. residual threshold lifted from ADR-019 §4 Stage 4 acceptance (G4). PoC during impl will tighten / relax per app.

### 2.4 Activation rules

#### 2.4.1 `mouse_click.verifyDelivery`

Stage 4 fires iff **all** of:

1. `verifyDelivery` parameter is `true` (existing opt-out preserved).
2. `classifyDelivery(pre, post, "send_input")` returned `status === "focus_only"` OR `status === "unverifiable"`.
3. `process.env.DESKTOP_TOUCH_STAGE4_SSIM !== "0"` (default ON; opt-out by setting to `"0"`, mirrors the `DESKTOP_TOUCH_STAGE2A_RING` convention in `_input-pipeline.ts:981`).
4. An `hwnd` is resolvable for the target — either supplied by the caller (`windowTitle` / `hwnd` arg), OR auto-resolved via `findContainingWindow(tx, ty)` (already used by `_mouse-verify.ts:115` for the scroll-snapshot path). Cursor-position-only `mouse_click` callers therefore still benefit from Stage 4 as long as `findContainingWindow` returns a target.
5. The pre-snapshot was taken before the click (existing behaviour — Stage 4 just adds a parallel pre-capture).

When Stage 4 fires and returns `motion: "local_repaint"`, the existing `verifyDeliveryHint.status` is **upgraded** from `focus_only` / `unverifiable` to `delivered`, and `observation: VisualMotionObservation` is attached to the hint. When Stage 4 returns `motion: "no_change"` the existing status is **preserved** (Stage 4 cannot demote a `focus_only` to `not_delivered` — same caution as Stage 2a's observation-only policy). When Stage 4 returns `motion: "indeterminate"` only the `observation` field is added.

#### 2.4.2 `keyboard:type` BG verify

Stage 4 fires iff **all** of:

1. The existing TextPattern / ValuePattern verify path returned `verifiedDelivery === "unverifiable"` with `verifyReason === "read_back_unsupported"` (lines `keyboard.ts:1118-1140` for the F4-bis VP delta layer; `keyboard.ts:1141-1187` for the early-fallback path — both terminate at the same `unverifiable` sink).
2. `process.env.DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD !== "0"` (default ON; separate from the mouse gate per R5).
3. The target window is resolved AND its `windowRect` is obtainable via `getWindowRectByHwnd(target.hwnd)` (which calls `win32GetWindowRect`). Keyboard path has no click point, so the resolver always falls through to `rectSource: "window_fallback"` — combined with R3's `MAX_RECT_AREA_PX = 1_000_000` cap that yields `motion: "indeterminate"` for very large windows; that's the honest answer and matches the §2.4.2 "Stage 4 never demotes a heuristic that was honest about being silent" invariant. (P16 decision lock default (b) — `focused_element` rectSource was DROPPED; see §2.2.)

When Stage 4 returns `motion: "local_repaint"`, the caller upgrades `verifiedDelivery` from `unverifiable` to `true` and emits the existing `ok: true` envelope with `hints.verifyDelivery.observation`. When Stage 4 returns `motion: "no_change"` the caller keeps `verifyReason = "read_back_unsupported"` (Stage 4 confirms the screen didn't move; the action still didn't reach a readable control — we don't promote to `BackgroundInputNotDelivered` because that would demote heuristics that were honest about being silent).

### 2.5 Time-base and constants

Stage 4 inherits Stage 2a's constants verbatim — they're already tuned for the temporal infrastructure and changing them would diverge two `local_*`-class primitives unnecessarily.

| Constant | Value | Source |
|---|---|---|
| `POLL_INTERVAL_MS` | 30 | Stage 2a (`_input-pipeline.ts:161-180`) |
| `MIN_WAIT_MS` | 50 | Stage 2a (GPU staleness guard) |
| `STABLE_THRESHOLD` | 0.002 | Stage 2a (idle floor 0.000 + safety) |
| `CONSECUTIVE_STABLE_TARGET` | 2 | Stage 2a (Playwright pattern) |
| `RING_WALLCLOCK_BUDGET_MS` | 700 | Stage 2a (covers caret cycle 530ms) |

New Stage 4 constants:

| Constant | Value | Why |
|---|---|---|
| `RESIDUAL_DELIVERED_FRACTION` | 0.05 | ADR-019 §4 Stage 4 G4 acceptance (Wang et al. 2004 standard) |
| `RESIDUAL_WINDOW_THRESHOLD` | 0.05 | per-window `1 - SSIM` cutoff inside `compute_ssim_residual` |
| `MEAN_SSIM_NO_CHANGE_FLOOR` | 0.99 | Wang "perceptually identical" cutoff for the `no_change` disambiguator. **Exposed via `observation.residual.meanSsim`** (sub-plan §4 P15 decision lock default (a)) so callers can audit the `no_change` (≥ 0.99) vs `indeterminate` (< 0.99) boundary. |
| `NO_CHANGE_FLOOR` | 0.001 | `computeChangeFraction` short-circuit (cheaper than SSIM) |
| `LOCAL_REPAINT_POINT_PAD_HALF` | 96 px | click-coord square half-side (192 × 192 px square). `LOCAL_REPAINT_RECT_PAD` (8 px focused-rect padding) was **REMOVED** per P16 decision lock default (b) — `focused_element` rectSource dropped. |
| `MAX_RECT_AREA_PX` | 1_000_000 | R3 mitigation cap — `verifyLocalRepaint` short-circuits to `motion: "indeterminate"` when the resolved rect area exceeds this. |

Constants live in `src/tools/_input-pipeline.ts` alongside the Stage 2a ones; the `RESIDUAL_*` thresholds and `*_PAD` constants are NEW SoT but the `STAGE2A_*` constants are referenced as the canonical source (same imports).

---

## 3. Affected components (SSOT correction to ADR-019 §3)

ADR-019 main §3 names new modules at `src/image/ssim.rs` / `src/image/phase_correlation.rs` / `src/image/dxgi_duplication.rs`. The repo has **no `src/image/` directory** — image-adjacent Rust modules live at `src/dhash.rs` / `src/pixel_diff.rs` / `src/image_processing.rs`. Stage 4 corrects this SSOT row by placing the new SSIM module at the same depth.

| File | Stage 4 change |
|---|---|
| **`src/ssim.rs`** (NEW) | `compute_ssim_residual` napi binding (§2.1). Runtime AVX2 / SSE2 / scalar dispatch matching `pixel_diff.rs`. |
| **`src/lib.rs`** | `pub mod ssim;` registration + napi export wiring. |
| **`src/engine/native-engine.ts`** | `computeSsimResidual?` extension on the existing `NativeEngine` interface (matches the existing `computeChangeFraction` pattern). |
| **`src/engine/native-types.ts`** | `NativeSsimResidualResult` / `NativeSsimRegion` / `NativeSsimCentroid` types matching the Rust shapes. |
| **`index.d.ts` / `index.js`** | Hand-maintained re-export of `computeSsimResidual` (ESM `createRequire` shim per `memory/feedback_esm_napi_loader.md`). |
| **`src/engine/layer-buffer.ts`** | Re-export `resolveLocalRepaintRect` + `verifyLocalRepaint` via a new sibling helper section, OR move them to a new `src/engine/local-repaint.ts` to keep `layer-buffer.ts` from growing further. **Decision locked in §3 sub-plan: new `src/engine/local-repaint.ts`** (already 684 lines is enough). |
| **`src/engine/local-repaint.ts`** (NEW) | `resolveLocalRepaintRect` (§2.2) — **two-strategy** resolver per P16 decision lock default (b) (`point_padded` + `window_fallback` only; `focused_element` rectSource DROPPED) — + `verifyLocalRepaint` (§2.3) + `LOCAL_REPAINT_*` constants. Re-exports `RawFrame` from `layer-buffer.ts`. |
| **`src/tools/_mouse-verify.ts`** | Add optional `observation?: VisualMotionObservation` field on `VerifyDeliveryHint` (mirrors `ScrollVerifyOutcome` extension). Add `classifyDeliveryWithLocalRepaint(...)` wrapper that calls `verifyLocalRepaint` when the existing `classifyDelivery` returned `focus_only` / `unverifiable`. Wrapper opt-in via signature (existing `classifyDelivery` unchanged for callers that don't want Stage 4). |
| **`src/tools/mouse.ts`** | `mouseClickHandler` captures a Stage 4 `preFrame` (best-effort, around line 583-586) alongside `preSnapshot`; the post-snapshot path (lines 629-636) invokes `classifyDeliveryWithLocalRepaint` instead of `classifyDelivery` and threads `verifyDeliveryHint.observation` through the existing `hints.verifyDelivery` envelope. Drag handler not in scope (`mouse_drag` has different semantics — covered as Stage 4 follow-up). |
| **`src/tools/keyboard.ts`** | `typeHandler` (line ~1083-1187 BG verify block) — when `verifiedDelivery === "unverifiable"` AND `verifyReason === "read_back_unsupported"`, invoke `verifyLocalRepaint` with the resolved target's focused-rect + window rect. Pre-frame captured right before the actual `WM_CHAR` send (the exact wiring location is OQ #5). Promote `verifiedDelivery` to `true` only on `motion: "local_repaint"`; observation hint always attached on Stage 4 invocation. |
| **`tests/unit/ssim-residual.test.ts`** (NEW) | 6+ unit cases — synthetic same-pre-post-frame returns `fraction_changed === 0` + `mean_ssim ≥ 0.999`; pre-post pair with 20×20 black rectangle drawn in centre of a white 200×200 frame returns `fraction_changed` in 0.04-0.10 band + centroid near `(100, 100)`; degenerate inputs (size mismatch, zero region, channels=3 vs 4) handled. |
| **`tests/unit/local-repaint-orchestrator.test.ts`** (NEW) | 8+ cases — `verifyLocalRepaint` returns `motion: "local_repaint"` when `compute_ssim_residual` is mocked to return `fraction_changed > 0.05`; returns `no_change` when both `computeChangeFraction < NO_CHANGE_FLOOR` AND SSIM returns `fraction_changed < 0.05 + mean_ssim ≥ 0.99`; returns `indeterminate` when small residual with `mean_ssim < 0.99`. Activation gate respects `DESKTOP_TOUCH_STAGE4_SSIM=0` (mouse path) and `DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD=0` (keyboard path) independently. |
| **`tests/unit/mouse-click-verify-stage4.test.ts`** (NEW) | 4+ cases — `classifyDeliveryWithLocalRepaint` upgrades `focus_only` to `delivered` on `motion: "local_repaint"`; preserves `focus_only` on `motion: "no_change"`; adds observation field on `motion: "indeterminate"` without status change; respects env opt-out. |
| **`tests/unit/keyboard-type-stage4.test.ts`** (NEW) | 4+ cases — BG verify `unverifiable` + Stage 4 `local_repaint` promotes to `verifiedDelivery: true`; BG verify `unverifiable` + Stage 4 `no_change` keeps `unverifiable`; respects env opt-out. |
| **`benches/ssim_residual.mjs`** (NEW) | Criterion-style harness measuring `compute_ssim_residual` p99 over a 400×400 synthetic frame pair (matches ADR-019 AC6 Stage 4 unit budget ≤ 15 ms). |
| **`docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`** | §3 SSOT row correction (`src/image/ssim.rs` → `src/ssim.rs`); §7 OQ #6 (SSIM threshold for `local_repaint` — main doc proposed 0.98) marked **Resolved** by the locked `MEAN_SSIM_NO_CHANGE_FLOOR = 0.99` (stricter, with `RESIDUAL_DELIVERED_FRACTION = 0.05` per-window-fraction gate as the primary metric; the SSIM mean is the disambiguator for the `no_change` vs `indeterminate` boundary); §4 Stage 4 deliverables list (matches this sub-plan's §3 table). |
| **`docs/adr-018-input-pipeline-3tier.md`** | §2.6 enum reference unchanged (still 8 values); add a short sentence noting Stage 4 is the first emitter of `source: "ssim_residual"`. |
| **`docs/adr-019-stage-4-followups.md`** (NEW, post-impl) | Stage 4 dogfood report (mirrors `adr-019-stage-2a-dogfood-results.md`). |

Stage 4 does **not** touch: `src/uia/`, `src/pixel_diff.rs`, `src/dhash.rs`, `src/tools/_input-pipeline.ts` Stage 2a block, `src/tools/scroll.ts`, browser tools, `desktop_act`, `desktop_state`, perception, vision-gpu modules.

---

## 4. Implementation plan (Phase checklist for the impl PR)

The sub-plan PR closes here; below is the checklist the **impl PR** flips `[ ]` → `[x]`.

- [x] **P1** — `src/ssim.rs` new module with `compute_ssim_residual` + `SsimRegion` / `SsimResidualResult` / `SsimCentroid` napi objects. Scalar implementation only at this checkpoint (correctness first).
- [x] **P2** — `src/lib.rs` registers the module + napi export wiring.
- [x] **P3** — `src/engine/native-types.ts` adds `NativeSsim*` interfaces; `src/engine/native-engine.ts` adds `computeSsimResidual?` extension; `index.d.ts` / `index.js` hand-maintained re-export (ESM `createRequire`, per `memory/feedback_esm_napi_loader.md`).
- [x] **P4** — `src/engine/local-repaint.ts` new file with `resolveLocalRepaintRect` + `verifyLocalRepaint` + Stage 4 constants + `RawFrame` re-export from `layer-buffer.ts`.
- [ ] **P5** — `tests/unit/ssim-residual.test.ts` (≥ 6 cases) + `tests/unit/local-repaint-orchestrator.test.ts` (≥ 8 cases). Use deterministic Buffer-construction so tests are independent of the host GPU / monitor.
- [ ] **P6** — `src/tools/_mouse-verify.ts` adds `classifyDeliveryWithLocalRepaint` wrapper + `observation` field on `VerifyDeliveryHint`. Existing `classifyDelivery` signature preserved (additive only).
- [ ] **P7** — `src/tools/mouse.ts` `mouseClickHandler` wiring: pre-frame capture parallel to pre-snapshot, post-path invokes `classifyDeliveryWithLocalRepaint`, observation threaded into envelope hint.
- [ ] **P8** — `tests/unit/mouse-click-verify-stage4.test.ts` (≥ 4 cases).
- [ ] **P9** — `src/tools/keyboard.ts` `typeHandler` wiring at the BG verify `verifiedDelivery === "unverifiable"` site. Pre-frame capture timing per §2.4.2 + OQ #5.
- [ ] **P10** — `tests/unit/keyboard-type-stage4.test.ts` (≥ 4 cases).
- [ ] **P11** — `benches/ssim_residual.mjs` AC6 unit bench.
- [ ] **P12** — Optimisation pass: AVX2 + SSE2 runtime dispatch in `src/ssim.rs` (the §4.5 SIMD strategy). Defer to ONLY if scalar P1 misses the 15ms p99 unit budget; otherwise carry-over to Stage 4 follow-up.
- [ ] **P13** — ADR-019 main + ADR-018 §2.6 docs sync (the rows listed in §3 table above).
- [ ] **P14** — Post-merge dogfood (Photoshop / Blender / Paint.NET click + Avalonia / VS Code text-input BG verify) → `docs/adr-019-stage-4-followups.md`.
- [x] **P15** — **`mean_ssim` envelope plumbing decision (external Opus retro-review P1-1)** — **Adopted default (a)** (impl PR Round 0 decision lock). `meanSsim?: number` field added to `VisualMotionObservation.residual` and synced across all 7 surfaces: parent ADR §2.1, `src/tools/_input-pipeline.ts` shape, `docs/adr-018-phase-5-followup-verification-pathway-analysis.md` (lines 160 + 263), `NativeSsimResidualResult` Rust↔TS mapping (P3), `verifyLocalRepaint` orchestrator output (P4), `tests/unit/local-repaint-orchestrator.test.ts` fixtures (P5), and §2.5 constants table annotation. `MEAN_SSIM_NO_CHANGE_FLOOR = 0.99` is decision-driving (`no_change` vs `indeterminate` disambiguator per §2.3 line 205-206) but the canonical `VisualMotionObservation.residual` shape across 3 SoT surfaces (`docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md:82` + `src/tools/_input-pipeline.ts:332-335` + `docs/adr-018-phase-5-followup-verification-pathway-analysis.md:160` and `:263`) is `{ fractionChanged: number; centroid?: { x; y } }` — no slot for `mean_ssim`. **Pick one and execute**: (a) **PREFERRED** — add `meanSsim?: number` to `VisualMotionObservation.residual` and bit-equal-sync **all of**: the 3 SoT surfaces (`docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md:82` + `src/tools/_input-pipeline.ts:332-335` + `docs/adr-018-phase-5-followup-verification-pathway-analysis.md:160` and `:263`), the Rust `NativeSsimResidualResult` mapping, the `verifyLocalRepaint` orchestrator output shape, **`tests/unit/local-repaint-orchestrator.test.ts` fixture assertions** (Round 2 P2-1 — the 8+ unit cases in §3 row 12 must assert the `meanSsim` field on `motion: "no_change"` outputs), and **§2.5 constants table** (Round 2 P2-1 — annotate `MEAN_SSIM_NO_CHANGE_FLOOR` row with "exposed via `observation.residual.meanSsim`" so reviewers see the contract surface in one read); OR (b) keep `meanSsim` internal to `verifyLocalRepaint` (never exposed) and amend §2.3 + §2.5 + R6 to make explicit that the LLM and downstream callers cannot audit `no_change` vs `indeterminate` decisions. **Decision locked at impl PR Round 0 (not deferred); choice MUST be picked before P3 / P4 / P7 / P9 / P13 land. Default = (a)**.
- [x] **P16** — **`focused_element` rect-source resolver decision (external Opus retro-review P1-2)** — **Adopted default (b)** (impl PR Round 0 decision lock). `focused_element` rectSource was DROPPED across all 6 surfaces: §2.2 (3-strategy → 2-strategy resolver), §2.4.2 gate 4 (keyboard always falls through to `window_fallback`), §3 row 14 (`resolveLocalRepaintRect` description revised), §5 G4-11 (3-source → 2-source acceptance), §6 R3 (mitigation chain references `point_padded` + `window_fallback` only), §2.5 `LOCAL_REPAINT_RECT_PAD` row removed (8 px focused-rect padding no longer needed) and `MAX_RECT_AREA_PX = 1_000_000` row added (R3 cap relocated from §6 prose into the §2.5 constants table for SSOT clarity). §2.4.2 gate 4 line 231 claims "`target` has a `boundingRect` from the existing resolution path" — **this is structurally false**. `ResolvedWindow` (`src/tools/_resolve-window.ts:149-164`) has `{ title; hwnd; warnings; className? }` only. `UiaFocusInfo` (`src/engine/uia-bridge.ts:404-410`, used by `snapshotForVerify`) has `{ name; controlType; automationId?; value? }` only. Only `UiElement` (`src/engine/uia-bridge.ts:393`) carries `boundingRect`, and `UiElement` is not on either the mouse or keyboard verify path today. So `rectSource: "focused_element"` is **unreachable** without a new UIA bounding-rect RPC (~10-50 ms unbudgeted in §3 cost analysis). **Pick one**: (a) **add the new UIA RPC**, document its cost as ADR-019 §6 AC6 budget impact (mouse `mouseClickHandler` pre-snapshot path adds the call when `verifyDelivery === true`; keyboard `typeHandler` adds it inside the BG verify failover path), AND add a bench gate `compute_ssim_residual + uia_rect_fetch` p99 to G4-6 / G4-7; OR (b) **drop `focused_element` from the rectSource priority** and revise **all of**: §2.2 + §2.4.2 + §3 row 14 + §5 G4-11 (the four surfaces that name the 3-strategy resolver), **R3 mitigation chain** (Round 2 P2-2 — R3 references `focusedRect` for the SSIM-skip / `MAX_RECT_AREA_PX = 1_000_000` window-fallback gate; if `focused_element` is dropped, R3's failure-mode description simplifies to "point-padded too large" only), and **§2.5 `LOCAL_REPAINT_RECT_PAD` row** (Round 2 P2-2 — this 8 px constant becomes dead under option (b) since no `focused_element` rect is captured; either delete the row or repurpose it as `point_padded` overflow padding with a renamed semantic). **Decision locked at impl PR Round 0 (not deferred); choice MUST be picked before §2.2 + §3 row 7 + §5 G4-11 sub-tasks land. Default = (b)** — dropping `focused_element` keeps the AC6 budget honest; the impl can revisit if dogfood shows `point_padded` misses load-bearing app cases.

---

## 5. Acceptance criteria

- **G4-1 (functional, mouse_click)** — Synthetic test fixture: pre-frame is a white 200×200 frame, post-frame has a 40×40 dark rectangle centred at `(100, 100)`. `verifyLocalRepaint({hwnd: 0n, hint: {point: {x:100,y:100}, ...}, preFrame})` returns `motion: "local_repaint"` with `residual.fractionChanged` ∈ [0.04, 0.20] and `residual.centroid` within 16 px of `(100, 100)`. **The actual click handler integration test runs the same fixture through `classifyDeliveryWithLocalRepaint` and verifies the upgrade from `focus_only` to `delivered`.**
- **G4-2 (functional, keyboard:type)** — Synthetic test fixture: BG verify reaches `unverifiable + read_back_unsupported`; `verifyLocalRepaint` returns `motion: "local_repaint"` on a buffer pair that simulates a typed character drawing inside the focused-rect; `typeHandler` envelope upgrades `verifiedDelivery` to `true` and emits `observation.source: "ssim_residual"`.
- **G4-3 (no regression, mouse_click)** — Existing 3-value `verifyDelivery.status` semantics preserved when Stage 4 is opted out (`DESKTOP_TOUCH_STAGE4_SSIM=0`). `classifyDelivery` output bit-identical to PR #309 + Stage 2a baseline for every case.
- **G4-4 (no regression, keyboard:type)** — `BackgroundInputNotDelivered` still surfaces on BG verify `false` (TextPattern / ValuePattern explicitly negative). Stage 4 never promotes `false` → `true` (it only acts on `unverifiable`).
- **G4-5 (no-change correctness)** — Idle window (no click / no type) input fixture returns `motion: "no_change"` 30 / 30 cycles with `residual.fractionChanged < 0.01`. Caret-blink-only window returns `motion: "no_change"` 30 / 30 cycles thanks to `capturePostFrameUntilStable`'s stop-detection draining the caret transient before SSIM runs.
- **G4-6 (latency, unit)** — `compute_ssim_residual` p99 ≤ **15 ms** on a 400×400 frame pair (matches ADR-019 §6 AC6 Stage 4 sub-budget). Bench-asserted in `benches/ssim_residual.mjs`.
- **G4-7 (latency, integration)** — `verifyLocalRepaint` end-to-end p99 ≤ **700 ms** wall-clock (inherits AC6 temporal-fallback budget). Empirical median expected ~220 ms (same shape as Stage 2a Excel dogfood); slow apps (Photoshop heavy filter render) may approach 500-600 ms before stop-detection settles.
- **G4-8 (CLAUDE.md §3.1 multi-table sweep)** — `observation.source` 8-value enum still bit-equal across ADR-019 §2.1 / `_input-pipeline.ts:VisualMotionObservation` / ADR-018 §2.6 / TS / Rust type definitions. Stage 4 adds NO new enum values (only becomes the first emitter of the existing `ssim_residual` slot).
- **G4-9 (CLAUDE.md §3.2 carry-over scope shrink)** — No exhaustive `switch (observation.source)` exists in `src/` (grep returns 0). Stage 4 is strictly additive — no caller currently routes on `source`, so adding the first `ssim_residual` emitter does not break any existing switch.
- **G4-10 (env opt-out)** — `DESKTOP_TOUCH_STAGE4_SSIM=0` deterministically disables Stage 4 in the `mouse_click` path; `DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD=0` independently disables Stage 4 in the `keyboard:type` path. The two gates are intentionally separate (R5 — keyboard wiring is more complex than mouse wiring so a regression in one path must not blanket-disable the other). Verified by unit tests mocking `process.env` for each path independently.
- **G4-11 (rect resolver correctness)** — **two-source per P16 decision lock default (b)**: `resolveLocalRepaintRect` returns `rectSource: "point_padded"` when `hint.point` is supplied AND the padded square intersects `windowRect`; `"window_fallback"` when `hint.point` is absent OR the padded square does not intersect `windowRect`. Padding behaviour pinned by ≥ 3 unit cases.

---

## 6. Risks

- **R1 — SSIM hand-rolled vs `dssim` crate trade-off** — hand-rolling avoids the `dssim` crate's C-FFI ICC profile dep and stays inside the existing `windows-rs` + `napi` toolchain (memory `feedback_ci_node_lib.md` cdylib constraint). Risk: hand-rolled AVX2 may be 1.3-1.8× slower than `dssim`'s AVX2 path. Mitigation: if P12 bench misses 15ms p99, Stage 4 follow-up evaluates `dssim` adoption with the CI / build-time toolchain impact assessed.
- **R2 — Stage 2a polling repurposed for Stage 4** — `capturePostFrameUntilStable` was sized for the scroll case (caret blink + Excel MFC repaint). Click feedback / keystroke repaint may settle faster (≤ 100ms typical) so the 700ms budget is generous. Stage 4 inherits Stage 2a's stop-detection so it exits early on actual stability — no risk of paying 700ms when 80ms suffices.
- **R3 — Rect resolver coverage** — with P16 decision lock default (b) the resolver has only two strategies: `point_padded` (when the caller supplies a click coordinate AND the padded square intersects `windowRect`) and `window_fallback`. The keyboard path always lands on `window_fallback`. Risk: `window_fallback` would run SSIM on the whole window (≥ 1080p) and may exceed the 15 ms p99 unit budget. Mitigation: orchestrator short-circuits to `motion: "indeterminate"` when the resolved rect area exceeds `MAX_RECT_AREA_PX = 1_000_000` (~1000×1000) — the caller treats this as `unverifiable`, same outcome as a UIA-unavailable read-back. Stage 4 follow-up: downsample the rect before SSIM (ADR-019 §4.6 Stage 8 GPU dispatch is the natural home for whole-window).
- **R4 — `mouse_click` pre-frame capture timing** — Stage 4 needs a `preFrame` from BEFORE the click. Adding `captureFrame` before `mouse.click()` adds ~30-50ms to every Stage-4-eligible `mouse_click` call. Mitigation: pre-frame capture is **gated on `verifyDelivery === true` AND env opt-in** (default-on once Stage 4 lands, but reversible). Bench gate enforces overall `mouse_click` p99 ≤ existing baseline + 50ms; if exceeded, Stage 4 falls back to "capture pre on-demand after `focus_only`" with a small risk of missing the pre-state.
- **R5 — Keyboard pre-frame capture timing** — The exact wiring is OQ #5; pre-frame must be captured before the actual `WM_CHAR` send to be useful. The keyboard handler has a more complex internal pipeline (parallel TextPattern / ValuePattern baseline + UIA target resolution); inserting `captureFrame` requires care to avoid additional UIA round-trips. Mitigation: gate Stage 4 in keyboard via `DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD` (separate from the mouse gate) so a wiring regression doesn't break BG keyboard verify entirely. Stage 4 keyboard impl PR may land **after** the mouse impl PR if wiring complexity warrants the split.
- **R6 — False positives from background animation / video playback** — Custom-paint surfaces (Photoshop video preview, Blender 3D viewport with auto-rotate, OBS scene preview) can produce ongoing repaint independent of the action. `capturePostFrameUntilStable` would budget-timeout (`stableReached: false`) and SSIM would still report `fraction_changed > 0.05` for unrelated motion. Risk: Stage 4 falsely promotes `focus_only` → `delivered`. Mitigation: when `stableReached === false`, Stage 4 returns `motion: "indeterminate"` (the caller keeps `focus_only`). This is honest — the algorithm cannot prove the change was caused by the action when the screen never settled.
- **R7 — Stage 4 mouse pre-frame race** — When `mouse_click` is called rapidly back-to-back (run_macro chain), the pre-frame of click N+1 may already contain the post-state of click N before the user-observable repaint settles. Mitigation: only relevant if Stage 2a / Stage 4 prove this is a real failure mode; rely on existing `settleMs` defaults (60ms) + new `LOCAL_REPAINT_*` constants to delay the post-frame.
- **R8 — CLAUDE.md §3.1 multi-table sweep** — The `observation.source` enum lives in 3 SoT surfaces. Stage 4 does not change the enum values but its docs PR (P13) touches both ADR-019 and ADR-018; sweep grep before PR submit confirms parity.
- **R9 — CLAUDE.md §3.2 carry-over scope shrink** — `mouse_click`'s existing API contract is `verifyDelivery: boolean` (default true) returning `hints.verifyDelivery: VerifyDeliveryHint`. Stage 4 adds an optional `observation` sub-field. NO existing API is broken (additive). NO `switch (observation.source)` exists in `src/`. Confirmed by grep before PR submit.
- **R10 — Click handler / handler-call-sites that hand-call `classifyDelivery` directly** — Some test harnesses or run_macro inlines may call `classifyDelivery` directly. Stage 4 adds `classifyDeliveryWithLocalRepaint` as a **separate** function; existing callers of `classifyDelivery` continue to work unchanged. Bit-equal `VerifyDeliveryHint` output preserved when the wrapper is not used.
- **R11 — `mean_ssim` discriminator absent from canonical `VisualMotionObservation.residual` shape** (post-merge follow-up — external Opus retro-review P1-1). The decision rule in §2.3 promotes `MEAN_SSIM_NO_CHANGE_FLOOR = 0.99` to a discriminator between `no_change` and `indeterminate`, but `residual` carries only `{ fractionChanged, centroid? }` across all 3 SoT surfaces today. P15 forces the impl PR to pick (a) extend the shape and sync (preferred) or (b) keep `meanSsim` internal and document the audit-trail loss. Without P15, the impl reviewer will (correctly) flag this at code-review time and the impl PR will pay re-derivation cost mid-review.
- **R12 — `focused_element` rectSource is unreachable without a new UIA bounding-rect RPC** (post-merge follow-up — external Opus retro-review P1-2). §2.4.2 gate 4 claims `target.boundingRect` exists on the resolution path. It does not — neither `ResolvedWindow` nor `UiaFocusInfo` carries a rect. P16 forces the impl PR to pick (a) acknowledge the new RPC cost and budget-audit it, or (b) drop `focused_element` rectSource entirely. The §3 cost analysis silently assumed (a) but never accounted for the ~10-50 ms RPC; the AC6 700 ms budget remains satisfiable either way, but G4-6 / G4-7 benches must reflect the chosen path. Without P16, the impl reviewer will flag this at code-review time and either choice introduces a cascading sub-plan revision.

---

## 7. Open questions

1. **`compute_ssim_residual` Rust crate strategy — hand-rolled vs `dssim`** — sub-plan locks hand-rolled (R1). Carry-over: if AC6 unit bench fails, Stage 4 follow-up PR evaluates the C-FFI cost of `dssim`. **Resolution**: hand-rolled scalar first, AVX2 SIMD second, `dssim` only if both miss budget.
2. **`LOCAL_REPAINT_POINT_PAD_HALF` value (96 px default)** — chosen for typical click-feedback (focus ring ≤ 64 px, button ripple ≤ 80 px) with slack. Custom-paint app feedback (Blender selection handle ≈ 12 px, Photoshop selection marquee = anywhere on the canvas) varies wildly. **Resolution**: lock 96 px default; Stage 4 follow-up dogfood report calibrates per app.
3. **Click "drag-handle precision" case** — Photoshop / Blender click on a small handle (≤ 12 px) where the visible change is < 4×4 px. SSIM sliding window 8×8 might miss this. **Resolution**: out of Stage 4 scope; document as Stage 4 follow-up. Workaround: caller passes `focusedRect` from a prior UIA query to constrain Stage 4 to the relevant region.
4. **Keyboard BG verify path complexity** — keyboard's BG verify has both the F4-bis VP delta layer and the early-fallback path. Stage 4 fires only on the terminal `unverifiable + read_back_unsupported` outcome. **Resolution**: wire at the single terminal point (line ~1138-1140 / 1180-1187); avoid wiring inside the F4-bis branch.
5. **`keyboard:type` pre-frame capture timing** — where exactly to `captureFrame` before the `WM_CHAR` send. Options: (a) right after target resolution before the WM_CHAR loop (clean but may pay capture cost on every `keyboard:type` call), (b) lazy capture only when BG verify reaches `unverifiable` (cheapest but the pre-state is no longer "pre-action"). **Resolution**: option (a), gated on `verifyDelivery === true` so the cost only lands on callers asking for verification. Stage 4 follow-up may refine if dogfood shows the cost is meaningful.
6. **`mouse_drag` Stage 4 scope** — drag has different semantics (down + move + up vs single click); the visual change is at the END point not the start point. **Resolution**: out of Stage 4 scope; Stage 4 follow-up PR after `mouse_click` lands and dogfood validates the approach.
7. **Multi-region SSIM** — for a click that draws BOTH a focus ring (near click) AND a side-panel update (far from click), single-rect Stage 4 catches only the focus ring. ADR-019 §7 OQ #6 already marks Wang threshold per-app calibration as carry-over. **Resolution**: multi-region carry-over to a future stage (`structured_state` + ADR-019 §7 OQ #7 anti-fukuwarai v4 framing). Not in Stage 4 scope.
8. **`hints.verifyDelivery.observation` envelope renderer** — narration / `narrate: "rich"` may want to surface the SSIM fraction / centroid in the LLM-facing string. ADR-019 main ADR §6 AC4 hints at this. **Resolution**: narration is out of Stage 4 scope; Stage 4 follow-up `narrate` extension after impl PR + dogfood.

---

## 8. Out of scope

- **GPU dispatch (DirectML for Stage 4)** — ADR-019 §4.6 names this as Stage 8. Stage 4 ships CPU SIMD only.
- **DXGI Desktop Duplication for `any_change`** — Stage 5.
- **Block motion vectors for `scroll_translation`** — Stage 2b.
- **Audio observation** (Excel chime, system error sound) — out of ADR-019 v3 scope per §8.
- **Cross-process automation** (e.g. Photoshop AppleScript / COM) — out of TMOL framing per §8.

---

## 9. Anti-fukuwarai genealogy reconciliation

| Action | Pre-Stage-4 observation | Post-Stage-4 observation |
|---|---|---|
| `mouse_click` on a UIA control | UIA element identity diff → `delivered` | unchanged (Stage 4 doesn't fire) |
| `mouse_click` on a custom-paint canvas (Photoshop / Blender) | focus delta only → `focus_only` (silent regression) | Stage 4 SSIM → `delivered` + `observation.source: "ssim_residual"` |
| `mouse_click` on truly silent target (off-canvas / UIPI block) | `focus_only` with no observable change | Stage 4 `motion: "no_change"` → preserved `focus_only` (honest) |
| `keyboard:type` on TextPattern-exposed input | TextPattern read-back → `delivered` | unchanged (Stage 4 doesn't fire) |
| `keyboard:type` on TextPattern-silent input (Avalonia / IM-driven RichEdit) | `BackgroundInputNotDelivered (unverifiable)` | Stage 4 SSIM → `verifiedDelivery: true` (delivered) when the rect actually repainted |
| `keyboard:type` truly dropped (focus lost between key strokes) | `BackgroundInputNotDelivered (unverifiable)` | Stage 4 `motion: "no_change"` → still `unverifiable` (Stage 4 doesn't demote heuristics that were honest) |

The pattern: **Stage 4 only upgrades**. It never demotes. This preserves the existing tool surface for callers / LLMs that trust the heuristics-driven outcomes and adds a positive evidence channel for the custom-paint surfaces.

---

## 10. Dependencies / sequencing

- **Blocks**: nothing.
- **Blocked by**:
  - PR #309 (ADR-019 MVP-1) — provides the `VisualMotionObservation` contract surface.
  - PR #311 (Stage 2a impl) — provides `captureFrame` / `capturePostFrameUntilStable` / `RawFrame` helpers.
  - PR #312 (Stage 2a dogfood) — closes Stage 2a Phase 6; Stage 4 can begin once Stage 2a is past dogfood.
- **Walking-skeleton classification**: expansion (per §0 preface — Stage 2a was the trunk for the temporal infrastructure; Stage 4 expands it for `local_repaint`).
- **Successor**: Stage 4 dogfood PR (after impl land); future Stage 4 follow-up PRs for `mouse_drag` / multi-region / GPU dispatch / `dssim` evaluation as separate sub-plans.
- **Parallel with**: Stage 2b sub-plan (`scroll_translation` decision gate) may proceed in parallel; the two stages share NO production-code surface (Stage 2b touches `_input-pipeline.ts` chain-trust block; Stage 4 touches `mouse.ts` / `keyboard.ts` / new `local-repaint.ts` / new `ssim.rs`).

---

## 11. North-star reconciliation

ADR-019's load-bearing thesis (§2.2, user-named "観測の時間軸をサーバに持ち込む") is that **temporal observation is the foundational primitive — new algorithms are downstream of it**. Stage 4 fully honours this:

- Stage 4 reuses Stage 2a's temporal helpers verbatim (`capturePostFrameUntilStable` for the post-action stable frame).
- Stage 4's NEW work is the **algorithm** (SSIM) atop the same temporal substrate; the algorithm is downstream of the temporal infrastructure as the framework predicts.
- Stage 4 only adds the `ssim_residual` enum slot's **first emitter**; the enum was sized for this in PR #309.

Stage 4 is the second proof point (after Stage 2a) that the §1.3 4-primitive split is structurally sound — adding `local_repaint` did not require renegotiating the contract.

---

## 12. Test plan summary

| Layer | What's tested | Where |
|---|---|---|
| Rust unit | `compute_ssim_residual` correctness on synthetic buffers | Rust `#[cfg(test)]` block in `src/ssim.rs` (≥ 4 cases — same-frame / known-residual / size-mismatch / channel mismatch) |
| TS unit | `resolveLocalRepaintRect` resolution policy | `tests/unit/local-repaint-orchestrator.test.ts` |
| TS unit | `verifyLocalRepaint` orchestration with mocked SSIM | `tests/unit/local-repaint-orchestrator.test.ts` |
| TS unit | `compute_ssim_residual` napi binding correctness (synthetic buffers) | `tests/unit/ssim-residual.test.ts` |
| TS unit | `classifyDeliveryWithLocalRepaint` wrapper logic | `tests/unit/mouse-click-verify-stage4.test.ts` |
| TS unit | `keyboard:type` BG verify Stage 4 integration | `tests/unit/keyboard-type-stage4.test.ts` |
| Regression sweep | Full `npm run test:capture` confirms no existing test broke | CI |
| Bench | `compute_ssim_residual` p99 ≤ 15 ms on 400×400 | `benches/ssim_residual.mjs` |
| Dogfood (post-merge) | Photoshop / Blender / Paint.NET click + Avalonia / VS Code BG type | `docs/adr-019-stage-4-followups.md` |

---

## 13. References

- Parent: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Sibling: `docs/adr-019-stage-2a-plan.md`, `docs/adr-019-stage-2a-poc-results.md`, `docs/adr-019-stage-2a-dogfood-results.md`
- Predecessor PRs: #309 (`c196bbc`), #311 (`0063ee3`), #312 (`d9278a7`)
- Wang, Bovik, Sheikh, Simoncelli, "Image quality assessment: from error visibility to structural similarity" (2004) — SSIM standard form
- Existing helpers (do not duplicate): `src/engine/layer-buffer.ts` (`captureFrame`, `capturePostFrameUntilStable`, `RawFrame`, `computeChangeFraction`), `src/tools/_mouse-verify.ts` (`classifyDelivery`, `snapshotForVerify`, `VerifyDeliveryHint`), `src/tools/_input-pipeline.ts` (`VisualMotionObservation`, Stage 2a constants), `src/uia/tree.rs:174-210` (`CurrentBoundingRectangle` source for focused-element rect)
- CLAUDE.md sections enforced:
  - §3 review loop (Opus + Codex)
  - §3.1 multi-table fact sweep (G4-8 above)
  - §3.2 carry-over scope shrink (G4-9 above)
  - §3.3 PR review loop (§14 below)
  - §3.4 Max 20x parallelism (Stage 4 is expansion-phase, may run parallel to Stage 2b)
  - §9 residuals in docs/ (`docs/adr-019-stage-4-followups.md` post-impl)

---

## 14. Review workflow (CLAUDE.md §3.3)

This sub-plan PR:

- **Step 0** — Classification: **docs / plan PR** (no production code change). Codex recommended (Phase-boundary plan).
- **Step 1** — Opus phase-boundary review with explicit §3.1 + §3.2 sweep + Lesson 1-4 sweep.
- **Step 2** — Codex re-review via `@codex review`.
- **Step 3** — Iterate to P1 = 0.
- **Step 4** — User reviewer Lesson 1-4 final sweep window.
- **Step 5** — Merge (auto-mode: Opus Approved + (Codex Approved OR usage limit) → AI may merge per `memory/feedback_auto_mode_merge_opus_judgment.md`).

The **impl PR** (separate) is classified **production code 改修 PR** — Codex **mandatory**.
