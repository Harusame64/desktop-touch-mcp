# ADR-019 — Anti-fukuwarai v3: Temporal Motion Observation Layer (TMOL) for `verifyDelivery`

- Status: **Draft (Round 0)** — initial framework draft from the PR #308 dHash failure post-mortem + user north-star pushback
- Date: 2026-05-16
- Authors: Claude (Sonnet drafting, Opus initial recommendation B → user Round 2 pushback → Sonnet revision)
- Related:
  - **ADR-005** (vision-gpu backend — ONNX Runtime + DirectML / ROCm / CUDA) — existing GPU compute path TMOL Stage 8 opportunistically reuses (§4.6)
  - **ADR-018** (`docs/adr-018-input-pipeline-3tier.md`) §1.3 / §2.2 / §2.6 — destination-explicit input pipeline; TMOL is its symmetric *observation* counterpart for verifyDelivery
  - **PR #307 / #308** — chain-trust assertion path that exposed the dHash macro-pattern collapse on Excel's cell grid (commit `926c69b`, 2026-05-16 dogfood)
  - **`docs/adr-018-phase-5-followup-verification-pathway-analysis.md`** — Round 1 vs Round 2 pathway analysis (preserves the A / B / C / A2 decision audit)
  - **Anti-fukuwarai genealogy**:
    - **v1** — v0.6.0 Anti-Fukuwarai (focus / modal / perception baseline; 2026-04 release line)
    - **v2** — v0.9 – v0.11 RPG (Reactive Perception Graph; lensId, perception guards)
    - **v3** — *this ADR* (temporal observation: "did the user-visible state actually move?")
- Blocks: none
- Blocked by: ADR-019 review and acceptance

---

## 1. Context

### 1.1 The recurring failure mode

"Anti-fukuwarai" — the metaphor where a blindfolded agent places facial features on a face — is the project's standing description of the LLM-agent failure mode this codebase exists to prevent. v1 (focus / modal observation) and v2 (perception graph) closed the *pre-action* observation gap: the agent knows what's on the screen before acting. They did **not** close the *post-action* observation gap: did the action actually change the user-visible state?

ADR-018 §1.3 reframes this for the dispatch side:

> the silent-failure mode is unrecoverable from the LLM side — `ok:true` masks a 0-px scroll.

PR #307 / #308 closed the *dispatch* leg (destination-explicit, leaf-walker for MDI scroll receivers). The *observation* leg — "did the post-action state actually differ from pre-action?" — remains partially fukuwarai-blind in the following cases:

1. **Scroll on custom-painted MDI apps** (Excel cell grid, Word `_WwG`, PowerPoint slide canvas, OneNote canvas): `GetScrollInfo(SB_VERT)` returns null (custom `NUIScrollbar`, MFC paint). Chain-trust assertion (PR #308) emits `delivered_via_postmessage` without observation; Codex P1 boundary case is documented unverified.
2. **Click verify**: `mouse_click.verifyDelivery` reports `delivered` / `focus_only` / `unverifiable` based on focused-element heuristics; for custom-paint canvases (Photoshop, Blender, GPU games) the heuristic is silent.
3. **Keyboard BG verify**: `BackgroundInputNotDelivered` returns `unverifiable` when the target doesn't expose `TextPattern` — silent for the same custom-paint surfaces.
4. **`desktop_act` post-state**: relies on the perception graph's diff — works for UIA-exposed elements, silent for custom-paint.

The dHash gate (PR #308 Round 2, reverted Round 3) tried to address #1 with a single 8×8 perceptual hash pre/post. Empirical dogfood (Excel A1 → A74, raw byte diff 0.36 %, 8×8 dHash byte-identical) showed the gate **demoted real scrolls to `target_unreachable`** — opposite of the user-visible truth. Documented in `docs/adr-018-phase-5-followup-leaf-walker-subplan.md` §2.1 reverted-note.

### 1.2 Why "v3"

v1 and v2 closed the **structured-state pre-action observation gap** (focus / modal / UIA tree / perception graph; with some image-based helpers like terminal_read and browser_search). They're fukuwarai-defending where the OS / accessibility layer cooperates AND on the *pre-action* axis. (Round 1 P2-5 — earlier draft over-claimed "v1/v2 = structured only"; v1 v0.6.0 included terminal_read/send + browser_search image-adjacent components per `memory/project_v0_6_anti_fukuwarai`.)

v3 must read **visual state across time** when the structured layer is silent. The mechanisms — multi-frame temporal capture, motion vector estimation, residual change detection, OS-level dirty-rect metadata — overlap with modern video coding (inter-frame motion compensation + residual coding). The user named the analogy: "まるで、最新の動画エンコードのようだ" (2026-05-16).

This ADR formalises that observation layer.

### 1.3 The four primitives that emerged from Round 2 review

User pushback on the Round 1 framing (single phase correlation primitive) surfaced four distinct observation problems that share architecture but **not the same algorithm**:

| Primitive | Question answered | Example use case |
|---|---|---|
| `scroll_translation` | Did the content shift by `(dx, dy)` pixels? | scroll dispatcher's chain-trust verify |
| `local_repaint` | Did a known sub-rect change without translating? | click verify (focus rectangle drew) |
| `any_change` | Did any pixel change in the window? | desktop_act post-state diff |
| `structured_state` | Did a UIA-exposed property change? | UIA `ScrollPattern.VerticalScrollPercent` pre/post |

Conflating these primitives into a single algorithm is a category error: phase correlation answers `scroll_translation` well but is wrong for `local_repaint` (no global shift). SSIM answers `local_repaint` well but is wrong for `scroll_translation` (a 1-pixel shift drops SSIM far below the no-change threshold even when the user-visible state is identical-up-to-translation, which the dispatcher needs to distinguish from real translation).

---

## 2. Decision

Adopt a **Temporal Motion Observation Layer (TMOL)** built around three architectural pillars:

1. **Single contract, pluggable implementations** — one observation contract (`VisualMotionObservation`), N candidate algorithms beneath, dispatcher picks per `capability` field.
2. **Multi-frame ring buffer** — capture pre + multiple post frames at low-frequency sampling intervals (default `[30, 60, 120, 240 ms]`), apply a **dual-condition decision rule** (motion observed AND last frame stable AND last frame differs from pre).
3. **Primitive split** — `scroll_translation` / `local_repaint` / `any_change` / `structured_state` are distinct primitives with distinct algorithm preferences.

### 2.1 The contract

```ts
type VisualMotionObservation = {
  motion:
    | "translation"
    | "local_repaint"
    | "no_change"
    | "indeterminate";
  /** Present when the algorithm produced a numeric shift (e.g. UIA percent for
   *  `source: "uia_scroll_percent"`); may be absent for sources that produce
   *  only a binary motion verdict (e.g. `source: "temporal_ring_observation_only"`).
   *  Stage 2b sub-plan §2.4 Option A — `shift` is present when measurable;
   *  `motion` is present always. */
  shift?: { dx: number; dy: number; confidence: number };
  /** Present when the algorithm measured a local repaint signature (e.g.
   *  SSIM residual fraction for `source: "ssim_residual"`); may be absent
   *  for sources that produce only a binary motion verdict (Stage 2b
   *  sub-plan §2.4 Option A relaxation, same rationale as `shift?` above).
   *  Stage 4 `ssim_residual` pipeline (impl PR) emits `residual` even on
   *  `no_change` / `indeterminate` outputs so that callers can audit the
   *  Wang "perceptually identical" (`meanSsim ≥ 0.99`) vs `indeterminate`
   *  (`meanSsim < 0.99`) boundary — Stage 4 sub-plan §4 P15 decision lock
   *  default (a). */
  residual?: {
    fractionChanged: number;
    centroid?: { x: number; y: number };
    meanSsim?: number;
  };
  /** algorithm that produced this observation. **Canonical 8-value enum** — single
   *  source of truth for the surface; ADR-018 §2.6 envelope reference and
   *  TS / Rust type definitions MUST bit-equal-mirror this list. */
  source:
    | "uia_scroll_percent"
    | "block_motion_vectors"
    | "tiled_phase_correlation"
    | "ssim_residual"
    | "dxgi_dirty_rect"
    | "optical_flow"
    | "temporal_ring_observation_only" // Stage 2a telemetry-only emission (no decision)
    | "chain_trust_unverified";
  /** Stage 2a telemetry — populated when source === "temporal_ring_observation_only"
   *  or as a sibling diagnostic field on other sources. Original PR #309 schema
   *  carries the inter-frame `changedFraction` series (stop-detection metric);
   *  **post-2026-05-16 Stage 2a pivot** (`docs/adr-019-stage-2a-plan.md`) adds
   *  the causal strip filter fields (`axis` / `stripCount` /
   *  `finalStripChangedFractions` / `stripsAboveNoise` / `finalChangedFraction`
   *  / `stableReached` / `framesToStability`). New fields are additive on the
   *  PR #309 forward-declared shape. */
  ringTelemetry?: {
    framesSampled: number;
    elapsedMsPerFrame: number[];
    changedFractions: number[];      // inter-frame stop-detection metric
    maxChangedFraction: number;
    // Causal strip filter (Stage 2a impl PR, 2026-05-16 PoC-locked)
    axis: "vertical" | "horizontal";
    stripCount: number;
    finalStripChangedFractions: number[];
    stripsAboveNoise: number;
    finalChangedFraction: number;
    // Stop-detection diagnostics
    stableReached: boolean;
    framesToStability: number | null;
  };
  framesSampled: number;
  totalElapsedMs: number;
};

interface TmolObserver {
  verifyVisualMotion(opts: {
    hwnd: bigint;
    region?: { x: number; y: number; width: number; height: number };
    axisHint?: "vertical" | "horizontal";
    capability: "scroll_translation" | "local_repaint" | "any_change";
    /** **Stage 2a pivot 2026-05-16 (PoC-driven, see `docs/adr-019-stage-2a-plan.md`)**: the
     *  originally-planned fixed-schedule (`[30, 60, 120, 240] ms`) was replaced
     *  by stop-detection polling — polls at `POLL_INTERVAL_MS = 30 ms` until
     *  `CONSECUTIVE_STABLE_TARGET = 2` consecutive inter-frame deltas drop
     *  below `STABLE_THRESHOLD = 0.002`, with wallclock cap
     *  `RING_WALLCLOCK_BUDGET_MS = 700 ms`. The `settleSchedule?: number[]`
     *  parameter is preserved for forward compatibility with custom callers
     *  (e.g. Stage 4 click-verify) but Stage 2a's production wiring uses the
     *  stop-detection constants directly rather than a schedule. */
    settleSchedule?: number[];
  }): Promise<VisualMotionObservation>;
}
```

### 2.2 The multi-frame ring buffer (the load-bearing architectural feature)

User Round 2 P2: "今回の本丸はむしろここで、`t=0, 50, 100, 200 ms` のような低周波 multi-frame ring buffer を持ち、N フレーム内の最大変化/安定後変化を見る設計にすると、かなり北極星っぽくなります。"

Single pre/post is structurally fragile against:
- **GPU staleness** — `PrintWindow(PW_RENDERFULLCONTENT)` can return a cached pre-paint frame for ~16-50 ms after the receiver processes the message; the post-paint frame appears only after the next composition cycle (`DwmGetCompositionTimingInfo::cFramesPresented`).
- **Animation transients** — caret blink, marching-ants selection, hover effects, loading spinners all introduce motion between pre and post that isn't related to our action.
- **Receiver settle time** — Excel's row-label strip repaint happens incrementally; capturing at t=30 ms might catch only a partial repaint that doesn't resemble the final state.

The ring buffer captures `pre` + `post[...]` and applies the **dual-condition rule**:

```
motion_observed = ∃ k such that motion(pre, post[k]) ≥ threshold
last_stable    = motion(post[k_last - 1], post[k_last]) < noise_floor
final_differs  = motion(pre, post[k_last]) ≥ threshold

deliver(translation | local_repaint) iff motion_observed AND last_stable AND final_differs
```

**Stage 2a sub-plan algorithm refinement (2026-05-16 PoC pivot, see `docs/adr-019-stage-2a-plan.md`)**: the production Stage 2a implementation realises `last_stable` as a **stop-detection polling termination criterion** rather than a fixed-schedule sample. Poll at `POLL_INTERVAL_MS = 30 ms` (= 2 DWM frames @ 60 Hz) until `CONSECUTIVE_STABLE_TARGET = 2` consecutive inter-frame deltas drop below `STABLE_THRESHOLD = 0.002`. Then return `final_differs = motion(pre, last_stable_frame)`. This adaptively bounds the wallclock at `RING_WALLCLOCK_BUDGET_MS = 700 ms` (covers caret blink cycle) — fast apps return in ~60 ms, slow apps wait for genuine settle, caret-active windows budget-timeout with honest `stableReached: false`. Per-strip diff oriented along the dispatch motion axis adds `motion_observed` discriminability without per-app threshold tuning (caret blink touches 1 strip; real scroll touches multiple).

This catches:
- **Real scrolls** → motion in some k AND final frame stable AND final differs from pre → accept.
- **Transient animations** (caret) → motion in middle frames AND final matches pre → reject (no_change). Strip filter also rejects via single-strip signature.
- **GPU staleness** → `MIN_WAIT_MS = 50` (3 DWM frames) before first poll absorbs the cache.
- **Boundary cases (Codex PR #308 P1)** → no motion at any k → reject (no_change, downgrades chain-trust to honest `unverifiable` / `target_unreachable` depending on caller policy).

### 2.3 Primitive split + candidate implementations

#### 2.3.1 `scroll_translation`

The question: did content shift by `(dx, dy)` pixels (a global translation, possibly with edges fading in/out)?

| Priority | Algorithm | Why this primitive | Cost (est.) | Failure mode |
|---|---|---|---|---|
| 1 | **UIA `CurrentVerticalScrollPercent`** (read-only) | exact numeric, OS-canonical | ~1-5 ms RPC | only when ScrollPattern exposed on the leaf or an ancestor |
| 2 | **Block motion vectors (16×16 SAD coarse-to-fine)** | majority `dy` across blocks votes the global shift; robust against periodic grids because each 16×16 block carries enough local entropy for unambiguous register | ~5-15 ms Rust SSE2 on 1080p | low texture (uniform background) drops vote confidence |
| 3 | **Tiled phase correlation (4×4 grid of 64×64 tiles)** | per-tile FFT, majority `(dx, dy)` vote, gated by `peak/secondPeak ≥ 3` + texture floor + tile agreement ≥ 0.5 | ~10-20 ms in `rustfft` SIMD | very-low-texture and exact-periodic regions can still alias |
| 4 | **SSIM residual map** | confidence-floor cross-check: SSIM ≥ 0.99 → certainly no_change, regardless of motion-vector noise | ~5-15 ms `dssim` crate | doesn't quantify shift |
| 5 | **DXGI Desktop Duplication dirty/move rects** | OS-side compositor metadata; authoritative `(dx, dy)` per move-rect | depends on Desktop Duplication session lifecycle | per-window scope is mixed with full-desktop; integration heavier |

#### 2.3.2 `local_repaint`

The question: did a known sub-rect (or an unknown sub-rect inside the window) change while the rest stayed?

| Priority | Algorithm | Why this primitive | Cost | Failure mode |
|---|---|---|---|---|
| 1 | **SSIM residual on focused-element rect** | when the click's expected effect rect is knowable (UIA element bounds), SSIM there gives a clean delta | ~5-15 ms | when rect is unknowable (custom canvas) |
| 2 | **Block motion vectors with `dy ≈ 0` constraint** | for click feedback (highlight, focus rectangle) the "movement" is local repaint with global shift = 0; per-block residual on `dy=0` captures this | ~5-15 ms | overlaps with animation; need ring buffer to distinguish |
| 3 | **Optical flow (Lucas-Kanade sparse)** | sparse N feature points; ignores periodic-grid translation; localised motion only | ~20-50 ms | feature point selection brittle |
| 4 | **DXGI dirty rect** | OS-side per-region metadata; if the dirty rect is small relative to window → `local_repaint` | shared with `scroll_translation` | same DXGI integration cost |

#### 2.3.3 `any_change`

The question: did anything change in the window?

| Priority | Algorithm | Why | Cost | Failure mode |
|---|---|---|---|---|
| 1 | **DXGI Desktop Duplication dirty/move rects** | OS authoritative answer | DXGI session | per-window scope |
| 2 | **Block motion vectors + SSIM residual map** | software fallback | shared | shared |
| 3 | **`computeChangeFraction` (existing 8×8 block SAD)** | the legacy helper; useful as final fall-back | very fast | low resolution |

#### 2.3.4 `structured_state`

The question: did a UIA / Win32-exposed numeric property change?

| Priority | Algorithm | Why | Cost | Failure mode |
|---|---|---|---|---|
| 1 | **UIA `CurrentVerticalScrollPercent` / `CurrentHorizontalScrollPercent`** | OS canonical, exact | ~1-5 ms RPC | pattern not exposed |
| 2 | **UIA `ValuePattern.Value`** (existing in keyboard verify) | exact, OS canonical | ~1-5 ms RPC | pattern not exposed |
| 3 | **Win32 `GetScrollInfo` (legacy SB_VERT path)** | for apps with a real Win32 scrollbar | <1 ms | null on custom-paint |

### 2.4 Phase correlation, properly gated

Round 1 framing: "phase correlation peak > 0.05 → motion." Round 2 finding: that's insufficient for Excel-class periodic grids.

Correct gating (referenced via Guizar-Sicairos et al. 2008 for sub-pixel registration):

```
phase_correlation_pass(pre, post):
  let cross = fft2(pre) × conj(fft2(post)) / |fft2(pre) × conj(fft2(post))|
  let r = ifft2(cross)
  let (peak1_loc, peak1_val) = argmax(r)
  let peak2_val = max(r excluding neighbourhood(peak1_loc, radius=3))
  let ratio = peak1_val / peak2_val
  let texture = variance(grayscale(pre))
  let per_tile_dy = [phase_correlation(pre_tile_i, post_tile_i) for i in tiles]
  let tile_agreement = count(per_tile_dy ≈ median(per_tile_dy)) / len(per_tile_dy)

  PASS iff:
    ratio ≥ 3
    AND texture ≥ noise_floor
    AND tile_agreement ≥ 0.5
    AND |peak1_loc - median(per_tile_dy)| ≤ 1 px
```

The four gates compose: a single bright peak with no second peak, enough texture to register at all, majority of tiles agreeing on the shift, and the global FFT agreeing with the per-tile majority.

### 2.5 Concrete new APIs

#### 2.5.1 napi `uia_read_scroll_percent_at_hwnd`

```rust
/// ADR-019 §2.3.4 — read-only sibling of `uia_scroll_by_wheel_at_hwnd`.
/// Walks UIA ancestors via RawViewWalker looking for an element that exposes
/// IUIAutomationScrollPattern. Returns None when no pattern is exposed (the
/// "custom-paint" case). Pure observation; no SetScrollPercent side effect.
#[napi]
pub fn uia_read_scroll_percent_at_hwnd(
  hwnd: BigInt,
  axis: String,  // "vertical" | "horizontal"
) -> napi::Result<Option<f64>>;
```

#### 2.5.2 TS `captureMultiFrameRing`

```ts
/** ADR-019 §2.2 — multi-frame ring buffer for temporal motion analysis. */
export async function captureMultiFrameRing(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
  scheduleMs: number[], // e.g. [30, 60, 120, 240]
): Promise<{
  pre: RawFrame;
  post: RawFrame[]; // length === scheduleMs.length
  elapsedMs: number;
}>;
```

#### 2.5.3 Rust `compute_block_motion_vectors`

```rust
/// ADR-019 §2.3.1 priority 2 — coarse-to-fine block matching motion estimation.
/// Returns a (dx, dy, confidence) per 16×16 block + a global majority vote.
#[napi]
pub fn compute_block_motion_vectors(
  pre: Buffer,
  post: Buffer,
  width: u32,
  height: u32,
  channels: u32,
  block_size: u32,      // default 16
  search_radius: u32,   // default 32 (covers typical line-scroll heights)
) -> napi::Result<BlockMotionResult>;
```

---

## 3. Affected components (initial SSOT table)

| File | Change | Stage |
|---|---|---|
| `src/uia/scroll.rs` | new `uia_read_scroll_percent_at_hwnd` napi (§2.5.1) | Stage 1 |
| `src/engine/native-engine.ts` | `NativeUia.uiaReadScrollPercentAtHwnd?` extension | Stage 1 |
| `index.d.ts` / `index.js` | hand-maintained re-export of the new napi | Stage 1 |
| `src/tools/_input-pipeline.ts` | (a) wire UIA percent pre/post into `postWheelToHwnd` chain-trust path; (b) **extend `DispatchOutcome` to additively carry `observation?: VisualMotionObservation`** (Round 1 P1-3) so the new field reaches the envelope; (c) caller-side fall-through to chain-trust assertion when UIA pattern not exposed | Stage 1 |
| `src/tools/mouse.ts` | (a) **extend `ScrollVerifyOutcome` (lines 971-982) to thread `observation?` through** (Round 1 P1-3); (b) `scrollHandler` propagates `observation` from dispatcher outcome into the `verifyDelivery` envelope hint | Stage 1 |
| `docs/adr-018-input-pipeline-3tier.md` §2.6 | **add additive `verifyDelivery.observation` paragraph** (Round 1 P1-2) that references this ADR-019 as the canonical `source` enum SoT. Lands in the MVP-1 PR alongside the wire-up. | Stage 1 |
| `src/engine/layer-buffer.ts` | new `captureMultiFrameRing` helper (§2.5.2) | Stage 2 |
| `src/pixel_diff.rs` | extend existing 8×8 block SAD to coarse-to-fine 16×16 block motion estimation | Stage 2 |
| `src/engine/image.ts` | `compute_block_motion_vectors` TS wrapper | Stage 2 |
| `src/image/phase_correlation.rs` | **new module**, `rustfft` SIMD FFT + gating (§2.4) | Stage 3 |
| `Cargo.toml` | add `rustfft` dep | Stage 3 |
| `src/image/ssim.rs` | **new module**, SSIM residual map (Wang et al. 2004) | Stage 4 |
| `src/tools/mouse.ts` (`mouse_click.verifyDelivery`) | wire SSIM into focused-element-rect path | Stage 4 |
| `src/tools/keyboard.ts` (BG `BackgroundInputNotDelivered`) | wire SSIM into TextPattern-unavailable fallback | Stage 4 |
| `src/image/dxgi_duplication.rs` | **new module**, IDXGIOutputDuplication session lifecycle + dirty-rect parsing | Stage 5 |
| `src/image/optical_flow.rs` | **new module**, Lucas-Kanade sparse + Farneback dense | Stage 6 (defer) |
| `docs/adr-018-input-pipeline-3tier.md` §2.6.2 | reference TMOL observation in `verifyDelivery.observation` envelope (additive) | Stage 1 |
| `tests/unit/tmol-*.test.ts` | per-primitive contract pin | each stage |
| `benches/tmol_*.mjs` | per-primitive latency bench | each stage |

---

## 4. Phase split

### Stage 1 — UIA read-only `ScrollPercent` (1 PR, 1-2 days) — **MVP-1**

Empirical probe + minimal observation upgrade. If EXCEL7 exposes `ScrollPattern` for reads (independent question from dispatch), this stage alone resolves Excel scroll observation without any image processing.

Deliverables (matches §3 SSOT rows for Stage 1):

- New `uia_read_scroll_percent_at_hwnd` napi (`src/uia/scroll.rs`).
- TS surface: `NativeUia.uiaReadScrollPercentAtHwnd?` (`src/engine/native-engine.ts`) + hand-maintained `index.d.ts` / `index.js` re-export.
- **Type extension**: `DispatchOutcome` in `_input-pipeline.ts` and `ScrollVerifyOutcome` in `mouse.ts:971-982` additively carry `observation?: VisualMotionObservation` (Round 1 P1-3 fix).
- Wire pre/post into `postWheelToHwnd` chain-trust branch; emit `delivered_via_postmessage` with `observation.source: "uia_scroll_percent"` when pre/post differ by ≥ `SCROLL_PERCENT_EPSILON`.
- Fall-through to chain-trust assertion (unchanged) when pattern not exposed → `observation.source: "chain_trust_unverified"`.
- **ADR-018 §2.6 additive paragraph** (Round 1 P1-2 fix): document `verifyDelivery.observation` as an additive field whose `source` enum lives in ADR-019 §2.1 as canonical SoT.
- 3 unit test cases: mock `uiaReadScrollPercentAtHwnd` (returns null / same percent / different percent) — pin each branch's `observation.source`.

**G1 acceptance**: probe via `node -e ...uiaReadScrollPercentAtHwnd(excelLeafHwnd, 'vertical')` returns a non-null number for Excel EXCEL7. If yes, dogfood Excel scroll returns `observation.source: "uia_scroll_percent"` and `observation.shift` carries the percent delta. If no, dogfood returns `observation.source: "chain_trust_unverified"` (preserves PR #308 chain-trust behaviour with explicit observation field — no regression).

### Stage 2a — Multi-frame ring buffer (observation-only, 1 PR, 1-2 days)

> **MVP split 2026-05-16**: the original Stage 2 was "ring buffer + block motion vectors + dispatcher wiring" in one PR — too much for a single review. Stage 2a is the ring buffer ALONE, using the existing `computeChangeFraction` (8×8 block SAD, SSE2 SIMD) for per-frame diff. It produces *telemetry* in `verifyDelivery.observation` but does NOT change the chain-trust decision yet. This empirically validates the multi-frame thesis ("does temporal observation actually catch what single pre/post misses?") before any new algorithm work.

- `captureMultiFrameRing(hwnd, region, scheduleMs)` in `layer-buffer.ts` — returns `pre + post[]` raw frames.
- Reuse `computeChangeFraction(pre, post[i])` for each post-frame; collect `changedFractions: number[]` over the ring.
- Add telemetry-only `observation` field: `{ source: "temporal_ring_observation_only", framesSampled, elapsedMs, changedFractions, maxChangedFraction }`. **No behaviour change in `verifyDelivery.status` / `.reason` / `.channel`** — Stage 2a is observation telemetry only.
- **G2a acceptance**: dogfood Excel + Word + Notepad scrolls; `verifyDelivery.observation.changedFractions` array is populated; the `maxChangedFraction` empirically discriminates real scrolls (> noise) from no-ops (≈ noise). Bench captures the actual values so Stage 2b's threshold can be data-calibrated.

### Stage 2b — Promote `finalChangedFraction > 0` to a decision gate (1 PR, 1-2 days)

> **Post-pivot 2026-05-16 (sub-plan `docs/adr-019-stage-2b-plan.md`)**: Stage 2a's dogfood (`docs/adr-019-stage-2a-dogfood-results.md`) showed *perfect* separation between Excel real-scroll (`finalChangedFraction p99 = 0.015`, 30/30) and idle (`finalChangedFraction p99 = 0.000`, 30/30) on the simple full-window non-zero predicate. Stage 2b therefore ships with `computeChangeFraction` (the existing 8×8 SSE2 SAD) as the gate — no new algorithm required. The `compute_block_motion_vectors` napi originally drafted in §2.5.3 is **deferred to Stage 2c (conditional)**; it activates only when a future target's telemetry refutes the full-window predicate per §6 OQ #4 saturation trigger.

- **Decision rule** (sub-plan §2.2): `motion observed AND last-stable AND final-differs → emit delivered_via_postmessage with observation.source: "temporal_ring_observation_only" and observation.motion: "translation"` (shift not populated on this path; sub-plan §2.4 Option A — `shift?` is "present when measurable", absent for sources that produce only a binary motion verdict).
- **Silent-drop case** (the load-bearing Stage 2b decision): `ringTelemetry.finalChangedFraction === 0 → observation.motion: "no_change", verifyDelivery.status: "not_delivered", reason: "target_unreachable"` (chain-trust silent drop). `observation.source` remains `"temporal_ring_observation_only"` and discriminates from legacy `target_unreachable` path-(b-i) per ADR-018 §2.6.2.
- **G2b acceptance** (sub-plan §4): Excel cell-grid scroll returns `observation.motion = "translation"` with `ringTelemetry.finalChangedFraction > 0` (≥ 0.005 per Stage 2a dogfood median; perfect separation vs idle floor 0.000). Synthetic silent-drop scenario returns `observation.motion = "no_change"` with `verifyDelivery.status: "not_delivered"` and `reason: "target_unreachable"`.
- **Env opt-outs** (sub-plan §0.1 #6 + §2.1): `DESKTOP_TOUCH_STAGE2B_GATE=0` suppresses just the gate (Stage 2a behaviour preserved: `delivered_via_postmessage` regardless of `finalChangedFraction`); `DESKTOP_TOUCH_STAGE2A_RING=0` suppresses the ring entirely (Stage 1 behaviour: `chain_trust_unverified`).
- **Stage 2c carry-over** (sub-plan §1.3 / §5 R1 / §6 OQ #4): `observation.source: "block_motion_vectors"` (and the `compute_block_motion_vectors` napi reference in §2.5.3) is reserved as a Stage 2c carry-over. Stage 2c activates only when a future dense-content / canvas-app target's dogfood telemetry shows `finalChangedFraction` saturation (real-scroll vs idle separation collapses such that the `> 0` predicate yields < 95 % sensitivity OR specificity — current Excel baseline = 100 % / 100 %) OR `stableReached: false` rate > 10 % despite real user-visible motion OR an operator report of a silent-drop Stage 2b missed.

### Stage 3 — Tiled phase correlation (1 PR, 2-3 days)

- New `src/image/phase_correlation.rs` with `rustfft` SIMD FFT + §2.4 gating.
- Wire as Stage 2 disambiguator when block-motion confidence < 0.7.
- **G3 acceptance**: synthetic test fixture with periodic grid + 50 px scroll returns `(dx, dy) = (0, 50)` with the four-gate pass. Same fixture with caret-blink-only returns `motion: "no_change"`.

### Stage 4 — SSIM residual for click / keyboard verify (1 PR, 2-3 days)

- New `src/image/ssim.rs` (Wang et al. 2004 reference impl).
- Wire into `mouse_click.verifyDelivery` (focused-element-rect SSIM) and `keyboard` BG verify (TextPattern-unavailable fallback rect SSIM).
- Different code path from scroll; this is the `local_repaint` primitive.
- **G4 acceptance**: synthetic test fixture with click → focus rectangle drawn at known rect returns `motion: "local_repaint"` with `residual.fractionChanged > 0.05` inside that rect.

### Stage 5 — DXGI Desktop Duplication (exploratory, 5-7 days)

- `src/image/dxgi_duplication.rs` with session lifecycle, dirty / move rect parsing.
- Wire as priority-1 source for `any_change` primitive when on the primary desktop.
- Carry-over to a separate sub-ADR if the session-lifecycle complexity warrants.

### Stage 6 — Optical flow (deferred)

- Lucas-Kanade sparse + Farneback dense. Defer to telemetry-driven decision after Stages 1-4 land.

### Stage 7 — AVX-512 SIMD acceleration (deferred, conditional)

- Add AVX-512 code paths to Stages 2-4 if AVX2 benches miss the 50 ms p99 budget on consumer hardware. Runtime dispatch (`is_x86_feature_detected!("avx512f")`) keeps backward compatibility. Skip if AVX2 is sufficient.

### Stage 8 — GPU compute path (deferred, opportunistic)

- Reuse the ADR-005 vision-gpu backend (ONNX Runtime + DirectML) to dispatch Stages 2-4 compute on GPU when the window size warrants. CPU SIMD remains the baseline; GPU is opportunistic acceleration for ≥ 1080p × 4-frame batches or ≥ 4K windows. See §4.6 for the dispatch logic and algorithm-to-graph mapping.

### Total

6 production stages (1, 2a, 2b, 3, 4, 5) + 3 conditional stages (6 optical flow, 7 AVX-512, 8 GPU compute), ~13-19 days base + per-conditional-stage exploration. Stages independently shippable; each one provides observable LLM-side capability (`observation.source` field).

### MVP ordering (2026-05-16 user feedback)

- **MVP-0**: ADR fixes (this revision) — split AC6 latency into fast / temporal / compute, split Stage 2 → 2a + 2b. **Already applied in this draft.**
- **MVP-1**: Stage 1 ONLY (UIA read-only `ScrollPercent`). Smallest possible PR — `_input-pipeline.ts:596` chain-trust branch gets `observation.source: "uia_scroll_percent" | "chain_trust_unverified"` only. Resolves the biggest single empirical uncertainty: does EXCEL7 expose `ScrollPattern` for reads? If yes, Excel is fixed with zero image processing. If no, MVP-2a is the next move.
- **MVP-2a**: Multi-frame ring buffer (observation-only telemetry) — empirically validate the temporal observation thesis before any new algorithm work.
- **MVP-2b**: Conditional on Stage 2a telemetry — only land block motion vectors if `changedFractions` alone is insufficient.
- **MVP-3 / MVP-4 / MVP-5+**: Stages 3-5 / 6-8 per the per-stage gating criteria.

The user-named load-bearing insight: **観測の時間軸をサーバに持ち込む** — bringing the temporal observation surface into the server is the foundational move; new algorithms are downstream of it.

---

## 4.5 SIMD strategy (per-stage computational budget)

The TMOL primitives sit on the hot path of every `verifyDelivery`-bearing tool call (scroll, click, BG keyboard). The latency budget is ≤ 50 ms p99 (AC6); on a 1080p window that translates to ~40 GB/s of effective pixel throughput when comparing pre/post raw frames. SIMD is mandatory, not optional, for the image-processing stages.

### 4.5.1 Existing SIMD in the codebase

- **`src/pixel_diff.rs`** — SSE2 `psadbw` (Sum of Absolute Differences) on 8×8 blocks; foundation for `computeChangeFraction`. Already SIMD; baseline.
- **`src/dhash.rs`** — Rust f32 bilinear resize + grayscale; some scalar work, some auto-vectorised. dHash is being replaced by motion vectors in TMOL Stage 2; this path will be deprecated.

### 4.5.2 Per-stage SIMD plan

| Stage | Algorithm | SIMD strategy | Rationale |
|---|---|---|---|
| 1 | UIA `ScrollPercent` read | none (RPC) | OS-side call; SIMD irrelevant |
| 2 | Block motion vectors (16×16 SAD, search ±32 px) | **AVX2 `vpsadbw`** with SSE2 fallback (cpuid runtime check) | inner SAD loop is the hottest path; AVX2 doubles `psadbw` throughput vs SSE2. Use `is_x86_feature_detected!("avx2")` at runtime, build with both code paths via Rust's `target_feature` |
| 3 | Tiled phase correlation | `rustfft` (already SIMD-optimised: AVX2 / NEON / scalar dispatch) + custom AVX2 for the magnitude-normalisation and IFFT-peak-detection steps | `rustfft` 0.31+ has automatic ISA dispatch; we add SIMD only for the wrapper |
| 4 | SSIM | **AVX2** for the per-window mean / variance / covariance (Wang 8×8 sliding); SSE2 fallback | sliding-window stats vectorise naturally; `dssim` crate uses AVX2 internally — consider direct dep over hand-rolling |
| 5 | DXGI Desktop Duplication | none (OS does the diff) | dirty-rect metadata is OS-computed; pixel work is zero |
| 6 | Optical flow | **AVX2** Lucas-Kanade gradient pyramid; or use `imageproc` crate's existing SIMD | deferred |

### 4.5.3 Build-time vs run-time dispatch

The repo already builds for `x86_64-pc-windows-msvc` / `x86_64-pc-windows-gnu` (Cargo.toml). Pure compile-time `-C target-feature=+avx2` would refuse to run on pre-Haswell CPUs (≤2013), which we don't want to require.

**Use runtime dispatch** via Rust's `is_x86_feature_detected!` macro:

```rust
pub fn block_motion_vectors(pre: &[u8], post: &[u8], ...) -> Vec<MotionVector> {
    if is_x86_feature_detected!("avx2") {
        unsafe { block_motion_vectors_avx2(pre, post, ...) }
    } else if is_x86_feature_detected!("sse2") {
        // SSE2 is x86-64 baseline; always present on our target
        unsafe { block_motion_vectors_sse2(pre, post, ...) }
    } else {
        block_motion_vectors_scalar(pre, post, ...)
    }
}
```

The dispatch overhead is ~1 ns per call (after JIT warms up); negligible compared to the ms-scale work.

### 4.5.4 AVX-512 ROI

AVX-512 (512-bit SIMD) doubles throughput again over AVX2 but:
- only available on a subset of consumer CPUs (Intel Ice Lake / Tiger Lake / Rocket Lake; AMD Zen 4+);
- causes downclocking on older Intel implementations (Skylake-X);
- Rust support is `target_feature` gated.

**Decision**: skip AVX-512 in initial impl. Add later as a Stage 7 optimisation if Stage 2-4 latency benches exceed the 50 ms p99 budget on AVX2-only systems. Cost is the dispatch path expansion; benefit is marginal for our window sizes.

### 4.5.5 Cargo features

Initial impl adds two Cargo features for opt-out / build-time control:

```toml
[features]
default = ["tmol-simd"]
tmol-simd = []           # enables AVX2/SSE2 runtime dispatch; disable for pure-scalar testing
tmol-avx512 = []         # future: AVX-512 path, off by default
```

The `default` is `tmol-simd` so production builds get the fast path.

### 4.5.6 Bench gate

Each SIMD stage lands with a `benches/tmol_<stage>.mjs` (criterion or vitest bench). Budgets are **compute-only** (algorithm time per pre/post pair, excluding settle waits):

- Stage 2b block motion (1080p, single pre/post): p99 ≤ 30 ms
- Stage 3 tiled phase correlation (256×256 downsample): p99 ≤ 20 ms
- Stage 4 SSIM (400×400 focused-element rect): p99 ≤ 15 ms

The temporal fallback wall-clock budget (≤ **700 ms** end-to-end, AC6 — **amended 2026-05-16** by Stage 2a sub-plan Round 4 pivot; see §6 AC6 for the full justification, was 300 ms pre-pivot) is the bench gate for the *integration* path (capture + ring + compute combined); the per-algorithm budgets above are the *unit* gates that feed it.

If any stage misses its compute budget, the SIMD path is the first place to look (compare AVX2 vs SSE2 via the runtime dispatch; the bench can force-disable AVX2 via `RUSTFLAGS=-C target-feature=-avx2` to measure the floor). The GPU path (§4.6 Stage 8) is the second place to look when SIMD-CPU still misses budget on large windows.

---

## 4.6 GPU compute path (reuse ADR-005 vision-gpu backend)

**Existing asset**: the repo ships a vision-gpu backend (ADR-005) — Rust `src/vision_backend/` + TS `src/engine/vision-gpu/` — backed by ONNX Runtime with DirectML / ROCm / CUDA execution providers (`src/vision_backend/ep_select.rs`). Today it's used for vision-AI inference (PaddleOCR, Florence-2, OmniParser, dirty-rect tracking). It is **not** currently used for general image-diff compute, but the GPU device + ORT session lifecycle infrastructure is in place.

TMOL can opportunistically dispatch its image-processing primitives to the GPU when:
1. **Window size large** (4K+ or multi-monitor capture where 1920×1080 SIMD-CPU paths would exceed the 50 ms p99 budget).
2. **Multi-frame ring buffer batch** (4-8 post-frames processed in parallel rather than serial CPU loops).
3. **Algorithm GPU-friendly** (FFT, block matching, convolution-based motion estimation, optical flow) — all of which map naturally to DirectCompute / DirectML graphs.

### 4.6.1 GPU vs CPU tier dispatch

```
Image size budget × frame count → tier dispatch:

  ≤ 1080p × 1-2 frames    → AVX2 SIMD CPU (already fast enough; PCIe upload overhead would dominate)
  ≤ 1080p × 4-8 frames    → AVX2 SIMD CPU (parallelisable with rayon over frames) OR GPU if available
  > 1080p × 1-8 frames    → GPU preferred (DirectML)
  > 4K       × any        → GPU mandatory (CPU SIMD would miss latency budget)
```

PCIe upload of a 1080p RGBA frame is ~8 MB → ~1 ms at PCIe 3.0 x16 (16 GB/s). 4-frame batch is ~32 MB → ~2 ms. Round-trip ~4 ms. For 50 ms budget, GPU breaks even around 8-16 ms of compute saved vs SIMD.

### 4.6.2 Algorithm → GPU mapping

| Primitive | GPU-friendly form | Backend |
|---|---|---|
| Block motion vectors (16×16 SAD) | 2D convolution against shifted post-frame, per-shift candidate; or motion-estimation compute shader | DirectCompute HLSL (custom shader) OR DirectML `Convolution` op |
| Tiled phase correlation | FFT via DirectML's existing FFT op (if available) OR a Cooley-Tukey compute shader | DirectML (if FFT supported) OR DirectCompute |
| SSIM | Sliding-window mean / variance / covariance via 2D convolution (Gaussian kernel) | DirectML `Convolution` |
| Optical flow (Lucas-Kanade) | Per-pixel gradient + linear-solve; or use ONNX-exported PyTorch model | DirectML / CUDA |
| dHash / pHash (legacy) | Resize + DCT + threshold | DirectML (overkill for 8×8) |

### 4.6.3 GPU integration cost

Reusing the ADR-005 path means:
- ONNX Runtime session per algorithm graph (or one shared session with multiple inputs)
- Tensor I/O (upload pre/post frames → run graph → download motion vectors)
- Existing `nativeVisionGpu` napi exports (`src/engine/native-engine.ts`) extended with `compute_motion_vectors_gpu` etc.

New work:
- Author the algorithm ONNX graphs (or DirectCompute HLSL shaders)
- Pipeline: capture (CPU) → upload (PCIe) → compute (GPU) → download → consume (CPU)
- Async / non-blocking dispatch so the scroll dispatcher isn't blocked on GPU work

### 4.6.4 Recommended scope

- **Stage 2 (block motion vectors)**: ship CPU SIMD first; add GPU path as Stage 7 if the latency bench shows CPU > 30 ms p99 on 1080p (unlikely with AVX2; very likely on 4K).
- **Stage 3 (tiled phase correlation)**: same — `rustfft` SIMD is fast enough at 256×256; GPU FFT becomes interesting at 1024×1024 or larger.
- **Stage 4 (SSIM)**: same — sliding-window stats vectorise well in AVX2.
- **Stage 5 (DXGI dirty-rect)**: this *is* a GPU path already — the OS compositor computes dirty rects on the GPU and exposes them via DXGI metadata. Reusing it is free.
- **Stage 8 (NEW: GPU compute path for Stages 2-4)**: lands after the CPU SIMD path is benched and the gap is empirically identified. Carry-over to a sub-ADR if the scope grows.

### 4.6.5 Practical note

DirectML's strength is *inference* — fixed graphs executed many times. For TMOL's per-call image diff, the graph is run once per `verifyVisualMotion` call. The session-setup cost may dominate at small windows; the wall-clock win shows up only when the per-frame work is large enough to amortise.

If the practical sweet spot is "GPU for >1080p windows, CPU SIMD otherwise," the dispatch logic looks like:

```rust
fn dispatch_block_motion(pre: &Frame, post: &Frame) -> BlockMotionResult {
    let area = pre.width * pre.height;
    let gpu_available = nativeVisionGpu::is_available();
    if area >= 1920 * 1080 * 2 && gpu_available {  // > 2 megapixels AND GPU ready
        return compute_block_motion_gpu(pre, post);
    }
    compute_block_motion_avx2(pre, post)  // fall back to CPU SIMD path
}
```

GPU path is **opportunistic, not required**. Stages 2-4 ship on CPU SIMD; GPU dispatch is a transparent acceleration that activates only on large windows or when the CPU bench gate fails.

---

## 5. Risks

- **R1 — UIA read-only `ScrollPercent` not exposed by EXCEL7**: empirical probe in Stage 1 may return null. Mitigation: **Stage 2b (block motion vectors) is the fallback**; until Stages 2a + 2b land, Stage 1 null on Excel preserves the current PR #308 chain-trust behaviour with the new `observation.source: "chain_trust_unverified"` field — no regression vs current main, just an explicit "we don't yet know" envelope hint. (Round 1 P2-4 clarification.)
- **R2 — Block motion vector latency on 1080p**: 16×16 blocks × full-window search may exceed 30 ms p99. Mitigation: downsample to 512×512 first; bench in Stage 2.
- **R3 — Phase correlation alias on perfectly periodic grids**: even tiled. Mitigation: the four-gate pass (§2.4) rejects ambiguous cases; fall back to block motion vectors (Stage 2) which is more local-structure-driven.
- **R4 — SSIM false-positive on cursor blink**: a blinking caret inside the focused-element rect would raise SSIM residual. Mitigation: multi-frame ring per §2.2 — caret blink resolves as transient (last frame matches pre).
- **R5 — DXGI Desktop Duplication scope creep**: session lifecycle, multi-monitor, cross-desktop. Mitigation: carry-over to sub-ADR; not blocking Stages 1-4.
- **R6 — Observation envelope migration**: callers that read `verifyDelivery.reason` directly are unaffected; callers that consult `verifyDelivery.observation` are new (additive). No backwards-compat break.
- **R7 — CLAUDE.md §3.1 multi-table fact sweep**: `observation.source` enum lives in 3 surfaces (ADR-019 §2.1 contract, ADR-018 §2.6 reason table, TS / Rust type definitions). Keep in bit-equal sync.
- **R8 — Anti-fukuwarai v1 / v2 / v3 dependency**: TMOL consumes the perception graph's focused-element rect (v2 RPG output) for the SSIM `local_repaint` primitive. If RPG is unavailable, fall back to full-window SSIM with a higher threshold.

---

## 6. Acceptance criteria

- **AC1** — Stage 1: `uia_read_scroll_percent_at_hwnd(excelLeafHwnd, 'vertical')` returns a non-null number when Excel is in foreground with a default workbook open, OR an empirical confirmation note in the ADR §10 OQ1 with the rationale for falling through to Stage 2.
- **AC2** — Stage 2 (Stage 2b shipping shape, post-pivot 2026-05-16): the chain-trust branch after a 3-notch wheel post returns `observation.motion: "translation"` with `observation.source: "temporal_ring_observation_only"` and `ringTelemetry.finalChangedFraction > 0` on Excel (real-scroll). Silent-drop case (`finalChangedFraction === 0`) returns `observation.motion: "no_change"` with `verifyDelivery.status: "not_delivered"` and `reason: "target_unreachable"`. `shift` is not populated on the temporal-ring path (§2.4 Option A — `shift?` is "present when measurable"; the ring computes a scalar fraction, not a pixel shift). **Stage 2c carry-over** (conditional): `confidence ≥ 0.7` + `shift.dy ≈ <expected px>` re-enters when block motion vectors land per §6 OQ #4 saturation trigger.
- **AC3** — Stage 3: synthetic test fixture (periodic grid + 50 px scroll) returns `(dx, dy) = (0, 50)` via tiled phase correlation, all four gates passing.
- **AC4** — Stage 4: `mouse_click.verifyDelivery` with `narrate: "rich"` returns `observation.source: "ssim_residual"` with `residual.fractionChanged > 0.05` on a synthetic click that draws a focus rectangle.
- **AC5** — System-wide: 3 of 4 primitives (`scroll_translation`, `local_repaint`, `structured_state`) wired into at least one tool each. `any_change` deferred to Stage 5.
- **AC6** — Performance: split latency budgets by tier of `verifyVisualMotion` for `scroll_translation`. The dispatcher selects **at most one primary algorithm per call** (cascade short-circuits on the first confident answer); the compute-only umbrella below is per-call, not per-algorithm. (Round 1 P2-1 fix.)
  - **Fast path** (Stage 1 UIA `ScrollPercent` read-only when pattern exposed): p99 ≤ **50 ms** wall-clock (no capture, just 2× UIA RPC). Bench-asserted.
  - **Temporal fallback** (Stages 2a/2b: stop-detection polling + per-frame diff) wall-clock: p99 ≤ **700 ms** end-to-end. **Amended 2026-05-16 by Stage 2a sub-plan Round 4 pivot** (PoC-driven, `docs/adr-019-stage-2a-poc-results.md`): the original 300 ms ceiling was set for the fixed `[30, 60, 120, 240] ms` ring (max 240 ms settle); the post-pivot stop-detection polls until 2 consecutive sub-`STABLE_THRESHOLD` inter-frame deltas detected, with a wallclock cap of 700 ms that covers a full Win32 caret blink cycle (`GetCaretBlinkTime` default 530 ms) + safety margin. PoC measured Excel chain-trust p99 = 204 ms (29 % of budget); the wider ceiling is intentional headroom for slower MFC repaint paths and caret-active idle windows that need a full caret cycle to budget-timeout honestly with `stableReached: false`. Bench-asserted via dogfood ≥ 30 cycles per app.
  - **Compute-only umbrella per call** (excluding settle waits, sum of algorithm time per pre/post pair across the cascade-short-circuit path): p99 ≤ **70 ms**. Raised from the original 50 ms to accommodate the worst-case cascade Stage 2b → Stage 3 → Stage 4 (30+20+15=65 ms). In the common case the cascade short-circuits on Stage 1 or Stage 2b, well under the umbrella. Bench-asserted.
  - Per-algorithm compute-only sub-budgets (these are the unit gates that feed the umbrella):
    - Stage 2b block motion (1080p, single pre/post pair): p99 ≤ **30 ms**.
    - Stage 3 tiled phase correlation (256×256 downsample): p99 ≤ **20 ms**.
    - Stage 4 SSIM (400×400 focused-element rect): p99 ≤ **15 ms**.
    Sum 65 ms = within the 70 ms umbrella. Bench-asserted per stage.
- **AC7** — CLAUDE.md §3.1 sweep: `observation.source` enum values exactly match across the ADR-019 §2.1 contract, ADR-018 §2.6 reason-table reference, and TS / Rust type definitions.

---

## 7. Open questions

1. **Does EXCEL7 expose `IUIAutomationScrollPattern` for reads** (separately from dispatch failure)? **Resolved 2026-05-16: NO**. G1 probe (`uia_read_scroll_percent_at_hwnd({hwnd: '<excel-top>', axis: 'vertical' | 'horizontal'})`) returned `null` for Excel `Book1 - Excel` foreground state, scroll-induced state, and post-scroll state. Phase A (ancestor walk) + Phase B (subtree DFS) both miss. Stage 1 produces `observation.source: "chain_trust_unverified"` on Excel. Stage 2a sub-plan (`docs/adr-019-stage-2a-plan.md`) extends the chain-trust path with stop-detection polling + causal strip filter telemetry. Stage 2a impl PR (branch `feature/adr-019-stage-2a-impl`, in-progress).
2. **Block motion vector search radius** — line scroll heights vary per app (Excel ~20 px row, Word ~24 px line, Notepad varies). Default `±row_height` is app-specific. Initial default 32 px; per-app tuning carry-over.
3. **Ring buffer schedule** — `[30, 60, 120, 240 ms]` is a starting point. Excel may need `+500 ms` for full settle on slow systems. Adaptive schedule (capture until last-stable holds, cap at 500 ms total) is the right design; **initial impl ships the fixed-schedule default AND wires `settleSchedule?: number[]` through the §2.1 contract** (Round 1 P2-3 fix — earlier draft contradicted itself by declaring the parameter in the contract while OQ3 said fixed schedule). The adaptive form is deferred to a Stage 2a follow-up.
4. **DXGI Desktop Duplication per-window** — IDXGIOutputDuplication is a *display output* surface, not per-window. Mapping back to a single window's region requires the window rect + clip. Defer to Stage 5 sub-ADR.
5. **Phase correlation gating thresholds** — `peak/secondPeak ≥ 3`, `texture floor`, `tile_agreement ≥ 0.5` are rule-of-thumb; per-app empirical calibration carry-over.
6. **SSIM threshold for `local_repaint`** — Wang et al. recommend 0.95 as "perceptually identical" cutoff; for click feedback that's likely too coarse. Initial impl uses 0.98; per-app calibration carry-over.
7. **Anti-fukuwarai v4** — is there one? Likely: combining v2 RPG's reactive graph with v3 TMOL's temporal observation to produce a continuous "what changed since last action" stream for the LLM. Out of scope for v3.
8. **Stage 2b gate decision** — should the chain-trust branch promote Stage 2a's `finalChangedFraction` to a `verifyDelivery.status` decision gate? **Resolved 2026-05-16: YES, simple `finalChangedFraction > 0` predicate** (sub-plan `docs/adr-019-stage-2b-plan.md`). The Stage 2a dogfood (`docs/adr-019-stage-2a-dogfood-results.md`) showed perfect separation between Excel real-scroll (30/30 with `finalChangedFraction p99 = 0.015`) and idle (30/30 with `finalChangedFraction p99 = 0.000`); a strict `> 0` predicate yields 100 % sensitivity / 100 % specificity with no threshold tuning. Stage 2b ships gate-on by default. `DESKTOP_TOUCH_STAGE2B_GATE=0` env opt-out preserves Stage 2a wire-level output. Strip-shape gate (`stripsAboveNoise`) + block motion vectors deferred to Stage 2c (conditional on future dense-content / canvas-app target showing `finalChangedFraction` saturation). See sub-plan §6 OQ #1-#6 for the per-question decisions.

---

## 8. Out of scope

- **GPU shader-based diff (CUDA / DirectCompute)** — performance optimisation; current SIMD path is sufficient for the latency budget.
- **Audio observation** — Excel chime / Windows error sound as a delivery signal. Different primitive; separate ADR.
- **OCR-based delta** — text-content change detection. Already exists for `scroll(action='read')`; not part of TMOL's pixel-motion focus.
- **Network-side observation** (e.g., Office365 cloud telemetry) — out of scope.
- **Cross-process automation** (Excel COM `Application.ActiveWindow.ScrollRow`) — separate channel; Tier 0 of the input pipeline, not the TMOL observation layer.

---

## 9. Anti-fukuwarai genealogy summary

| Version | Era | What it addressed | Primary channel |
|---|---|---|---|
| **v1** | v0.6.0 (2026-04) | Focus / modal / static window observation | UIA tree + focused-element |
| **v2** | v0.9 – v0.11 RPG (2026-04) | Reactive perception graph; lensId-pinned targets; cross-action perception continuity | UIA + perception graph (v2) |
| **v3** | *this ADR* (2026-05) | Temporal post-action observation; "did the visual state actually move?" | TMOL = UIA `ScrollPercent` + block motion + tiled phase correlation + SSIM + DXGI dirty-rect |

Each version closes a different fukuwarai gap. v1 says "I see what's there now." v2 says "I see what changed in the structured graph." v3 says "I see whether my action moved the world."

---

## 10. References

- ADR-018 §1.3 — system-wide silent-failure framing
- PR #307 / #308 — chain-trust assertion + dHash gate revert (`docs/adr-018-phase-5-followup-leaf-walker-subplan.md`)
- `docs/adr-018-phase-5-followup-verification-pathway-analysis.md` — Round 1 vs Round 2 audit trail leading to this ADR
- Wang, Bovik, Sheikh, Simoncelli, "Image quality assessment: from error visibility to structural similarity" (2004) — SSIM
- Guizar-Sicairos, Thurman, Fienup, "Efficient subpixel image registration algorithms" (2008) — sub-pixel phase correlation
- [Microsoft DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) — dirty / move rect metadata
- [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) — per-window capture
- [OpenCV Optical Flow tutorial](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html) — Lucas-Kanade / Farneback
- [`rustfft` crate](https://docs.rs/rustfft/) — pure-Rust SIMD FFT
- [Phase correlation — Wikipedia](https://en.wikipedia.org/wiki/Phase_correlation)
- [Block-matching algorithm — Wikipedia](https://en.wikipedia.org/wiki/Block-matching_algorithm)
- MEMORY index entries: `project_v0_6_anti_fukuwarai`, `project_v0_9_rpg`, `project_v0_12_auto_perception` — v1 / v2 genealogy
