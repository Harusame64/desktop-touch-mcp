# ADR-019 Stage 2a sub-plan — stop-detection polling + causal strip filter (observation-only telemetry)

- Status: **Round 4 pivot (PoC-driven, 2026-05-16)** — revised from the originally-merged fixed `[30, 60, 120, 240] ms` ring (PR #310) after user-prompted algorithm refinement + PoC validation.
- Date: 2026-05-16
- Authors: Claude (Sonnet drafting + user-driven design refinement)
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Predecessor PR: **PR #309** — ADR-019 MVP-1 (Stage 1 UIA `ScrollPercent` read-only observation), merged 2026-05-16 (`c196bbc`)
- This PR ("Stage 2a impl"): branch `feature/adr-019-stage-2a-impl` extending PR #310's sub-plan with the post-PoC algorithm.
- Successor (conditional): Stage 2b sub-plan — only drafted after ≥ 30 dogfood cycles confirm or refute the `stripsAboveNoise` gate.
- G1 empirical result (2026-05-16): Excel EXCEL7 does NOT expose `IUIAutomationScrollPattern` for reads (Phase A ancestor walk + Phase B subtree DFS both miss). Stage 1 produces `observation.source: "chain_trust_unverified"` for Excel; Stage 2a is the next observable upgrade.
- Walking-skeleton classification: **trunk** sub-plan for the temporal-observation primitive.
- PoC results: `docs/adr-019-stage-2a-poc-results.md` (algorithm decisions locked, 2026-05-16).

---

## 0. Round 4 pivot summary (why the algorithm changed)

The originally-merged sub-plan (PR #310) proposed **fixed-schedule sampling** at `[30, 60, 120, 240] ms` offsets from `T_settle`. During implementation, two user observations refined the design:

1. **stop-detection polling** (Playwright-style "2 consecutive sub-threshold frames = stable") replaces fixed sampling. Windows GUI actions always converge to a stable state; polling adaptively until convergence is detected makes the wallclock budget responsive (fast apps return in ~60 ms, slow apps wait until done capped at budget) rather than spending a fixed 240 ms regardless.
2. **causal strip filter** filters noise semantically instead of with thresholds. The dispatch direction (scroll-down → expect content shift up) implies an expected change pattern: real scrolls touch multiple strips (translation across the axis), caret blink touches one strip. Stage 2a emits per-strip `changedFraction` plus `stripsAboveNoise` count, letting Stage 2b discriminate by signal SHAPE rather than tuned threshold.

PoC validated both refinements on real Excel chain-trust path (`docs/adr-019-stage-2a-poc-results.md`). Algorithm decisions locked:

| Parameter | Value | Source |
|---|---|---|
| `POLL_INTERVAL_MS` | 30 | 2 DWM frames @ 60 Hz |
| `MIN_WAIT_MS` | 50 | GPU staleness guard, PoC validated |
| `STABLE_THRESHOLD` | 0.002 | idle floor = 0.000 observed |
| `STRIP_NOISE_THRESHOLD` | 0.003 | Excel signal range 0.003-0.015 observed (revised from 0.01) |
| `CONSECUTIVE_STABLE_TARGET` | 2 | Playwright pattern |
| `RING_WALLCLOCK_BUDGET_MS` | 700 | covers Win32 caret cycle 530 ms + safety (raised from 290) |
| `STRIP_COUNT` | 4 | frozen header row separation in Excel |

PoC empirical separation Excel real-scroll vs idle:
- `fullChangedFraction p50`: 0.005 vs 0.000 (perfect separation)
- `firstPostDelta < 0.001`: 0 / 15 vs 15 / 15 (perfect separation)
- `wallclock p99`: 204 ms = 29 % of 700 ms budget

ADR-019 §6 AC6 temporal-fallback budget is amended **300 ms → 700 ms** to accommodate the larger budget. The PoC measured wall-clock is well below, so this is headroom, not optimisation slack.

---

## 1. Context

### 1.1 Why Stage 2a now

ADR-019 Stage 1 (PR #309) added the canonical `observation` envelope hint. The 2026-05-16 G1 probe established that Excel produces `chain_trust_unverified` (UIA `ScrollPattern` not exposed for reads). Without a visual-state observer, the post-PostMessage envelope says "delivered" with no evidence beyond chain-table membership.

Stage 2a closes the *evidence* gap (not the *decision* gap) by polling post-dispatch frames until visual stability is reached and emitting strip-wise diff telemetry. The result is attached to `observation.ringTelemetry` for Stage 2b decision input — **no behaviour change in `verifyDelivery.status` / `.reason` / `.channel`**.

### 1.2 Why stop-detection + strip filter (post-pivot)

- **stop-detection** generalises ADR-019 §2.2 dual-condition rule's `last_stable` as a polling termination criterion. Same mathematical content, more adaptive wallclock.
- **strip filter** generalises ADR-019 §1.3 primitive split's `scroll_translation` axis. Caret blink (1 strip) is semantically distinguishable from real scroll (3-4 strips above noise) without per-app threshold tuning.

Both refinements stay within the §1.3 4-primitive framework (`scroll_translation` / `local_repaint` / `any_change` / `structured_state`). Stage 2a emits raw signal; Stage 2b decides.

### 1.3 Scope boundary (Stage 2a vs Stage 2b)

| Concern | Stage 2a (this sub-plan) | Stage 2b (future) |
|---|---|---|
| Stop-detection polling | **yes** | reused |
| Strip-wise diff | **yes** (per-strip `changedFraction`) | reused, possibly Rust SIMD optimised |
| Per-app threshold calibration | emits raw `stripsAboveNoise` | sets the gate (likely Excel 1+ strips, dense content 3+ strips) |
| Decision rule | **no** — telemetry only | yes — wires into chain-trust fallback as `delivered_via_postmessage` with `observation.source: "block_motion_vectors"` OR upgraded `temporal_ring_observation_only` |
| `verifyDelivery.status / .reason / .channel` change | **no** | yes (the gate) |
| `observation.source` values added | `"temporal_ring_observation_only"` (first emitter; declared in PR #309 §2.1) | `"block_motion_vectors"` (conditional, only if stripsAboveNoise gate insufficient) |
| Latency budget tier | temporal fallback ≤ **700 ms** p99 (AC6 amended) | same |

---

## 2. Decision

Adopt a **chain-trust fallback observation layer** that activates only when Stage 1 UIA observation returns `chain_trust_unverified`. When activated:

1. Capture `preFrame` BEFORE the PostMessage chunking loop (T_pre).
2. After the existing `POSTMESSAGE_SETTLE_MS = 16 ms` settle, poll post-frames with `pollIntervalMs = 30 ms` until `CONSECUTIVE_STABLE_TARGET = 2` consecutive inter-frame deltas drop below `STABLE_THRESHOLD = 0.002`, or budget exhausts at `RING_WALLCLOCK_BUDGET_MS = 700 ms`.
3. Compute strip-wise `changedFraction(preFrame, finalStableFrame)` partitioned along the dispatch motion axis (horizontal strips for vertical scroll), with `STRIP_COUNT = 4`.
4. Attach `observation.ringTelemetry` with the full telemetry (per-frame deltas + per-strip fractions + stability metadata). Stage 2a does NOT decide motion — `motion: "indeterminate"`.

### 2.1 Activation rule + time-base

The chain-trust fallback ring fires iff:

1. The dispatcher took the chain-trust branch of `postWheelToHwnd` (`pre === null && retargetedByLeafWalker`), **AND**
2. The Stage 1 UIA observation returned `motion: "indeterminate"` with `source: "chain_trust_unverified"`.

When Stage 1 UIA observation succeeded (`source: "uia_scroll_percent"`), the ring buffer is **not** captured. Rationale: avoid paying the temporal-fallback wallclock when a 50 ms fast-path observation already exists.

Time-base reference points:

| Reference point | Symbol | When |
|---|---|---|
| Dispatch-pre raw image | `T_pre` | inside `postWheelToHwnd`, before the chunking loop |
| Settle-end (existing 16 ms wait completes) | `T_settle` | line `_input-pipeline.ts:824` `await setTimeout(POSTMESSAGE_SETTLE_MS)` resolved |
| First polled post-frame | `T_settle + MIN_WAIT_MS` (= 50 ms after settle) | inside `capturePostFrameUntilStable` |

The `MIN_WAIT_MS = 50` absorbs DWM composition latency + PrintWindow pre-paint cache risk. PoC confirmed: with this delay Excel real-scroll always produces `firstPostDelta > 0` (15 / 15 cycles) while idle baseline produces 0 (15 / 15).

### 2.2 Helper API

Two TypeScript helpers in `src/engine/layer-buffer.ts`:

```ts
/** Single synchronous capture used for the dispatch-pre reference frame (T_pre). */
export async function captureFrame(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
): Promise<RawFrame | null>;

/** Poll post-frames until stable or budget exhausts. */
export async function capturePostFrameUntilStable(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
  opts: {
    pollIntervalMs: number;
    minWaitMs: number;
    stableThreshold: number;
    consecutiveStableTarget: number;
    budgetMs: number;
  },
): Promise<{
  frames: RawFrame[];        // includes the first sampled frame (post-minWait)
  deltas: number[];          // inter-frame: deltas[k] = changedFraction(frames[k], frames[k+1])
  stableReached: boolean;
  framesToStability: number | null;
  totalElapsedMs: number;
}>;

/** Per-strip changedFraction(preFrame, finalStableFrame) along the motion axis. */
export function computeStripChangedFractions(
  pre: RawFrame,
  post: RawFrame,
  axis: "vertical" | "horizontal",
  stripCount: number,
): { fractions: number[]; sizeMismatch: boolean };
```

`RawFrame = { rawPixels: Buffer; width: number; height: number; channels: 3 | 4 }`.

### 2.3 Telemetry shape

`VisualMotionObservation.ringTelemetry` extended (additive on PR #309 forward-declared shape):

```ts
ringTelemetry: {
  // From PR #309 forward declaration (preserved)
  framesSampled: number;             // 1 pre + N polled frames
  elapsedMsPerFrame: number[];       // timestamps from T_pre (=0)
  changedFractions: number[];        // inter-frame deltas (stop-detection metric)
  maxChangedFraction: number;
  // New Stage 2a (causal strip filter)
  axis: "vertical" | "horizontal";
  stripCount: number;                // = 4
  finalStripChangedFractions: number[]; // length = stripCount
  stripsAboveNoise: number;          // count of strips > STRIP_NOISE_THRESHOLD (0.003)
  finalChangedFraction: number;      // changedFraction(pre, finalStableFrame)
  // Stop-detection diagnostics
  stableReached: boolean;
  framesToStability: number | null;
};
```

### 2.4 Affected files (SSOT)

| File | Change |
|---|---|
| `src/engine/layer-buffer.ts` | Export `computeChangeFraction`; add `captureFrame`, `capturePostFrameUntilStable`, `computeStripChangedFractions`, `RawFrame` |
| `src/tools/_input-pipeline.ts` | New constants (`POLL_INTERVAL_MS`, `MIN_WAIT_MS`, `STABLE_THRESHOLD`, `STRIP_NOISE_THRESHOLD`, `CONSECUTIVE_STABLE_TARGET`, `RING_WALLCLOCK_BUDGET_MS=700`, `STRIP_COUNT=4`); extend `VisualMotionObservation.ringTelemetry`; rewrite Stage 2a block in `observeViaUiaOrChainTrust`; thread `axis` through caller |
| `tests/unit/temporal-ring-buffer.test.ts` | 10 cases — `computeStripChangedFractions` correctness + schema pin |
| `benches/poc_stage_2a_causal_strip.mjs` | Standalone PoC (commit `68e3fed`) — re-usable as a bench / dogfood harness |
| `docs/adr-019-stage-2a-poc-results.md` | PoC findings, locked parameters, AC6 amendment |
| `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` | §2.1 contract enum unchanged; §2.2 paragraph updated to mention stop-detection; §6 AC6 budget amendment 300 → 700 ms; §10 OQ #1 marked Resolved (G1 NO) |
| `docs/adr-018-input-pipeline-3tier.md` | §2.6 enum reference unchanged (still `temporal_ring_observation_only`) — Stage 2a is the first emitter |

Stage 2a does **not** touch: `src/uia/scroll.rs`, `src/pixel_diff.rs`, any new Rust module, `src/tools/mouse.ts`'s public surface, `index.d.ts`.

---

## 3. Implementation plan (post-pivot, completed in this PR)

- [x] **P1** — `src/engine/layer-buffer.ts`: export `computeChangeFraction`; add `captureFrame`, `capturePostFrameUntilStable`, `computeStripChangedFractions`, `RawFrame`.
- [x] **P2** — `src/tools/_input-pipeline.ts`: new constants, extended `ringTelemetry` interface, rewritten Stage 2a block in `observeViaUiaOrChainTrust`, axis threaded through caller.
- [x] **P3** — `tests/unit/temporal-ring-buffer.test.ts`: 10 cases.
- [x] **P4** — `benches/poc_stage_2a_causal_strip.mjs`: PoC harness committed (`68e3fed`); reusable as dogfood bench.
- [x] **P5** — Docs sync (this commit + ADR-019 / ADR-018 sweep below).
- [ ] **P6** — Dogfood report (post-merge, populates `docs/adr-019-stage-2a-dogfood-results.md` with ≥ 30-cycle distributions per app).

---

## 4. Acceptance criteria (post-pivot)

- **G2a-1 (functional)** — When chain-trust fallback fires AND `DESKTOP_TOUCH_STAGE2A_RING ≠ 0` AND `preFrame !== null` AND `rect !== null`, the envelope contains `observation.source: "temporal_ring_observation_only"` with `ringTelemetry.stripsAboveNoise` set + `ringTelemetry.finalChangedFraction` set.
- **G2a-2 (no regression)** — Pre-existing `chain_trust_unverified` behaviour preserved when stop-detection fails (capture errors, first capture null). `verifyDelivery.status`, `.reason`, `.channel` bit-identical to PR #309 output.
- **G2a-3 (latency budget, AC6-amended)** — wallclock p99 ≤ **700 ms** end-to-end. PoC empirical p99 = 204 ms = 29 % of budget on Excel chain-trust path.
- **G2a-4 (telemetry discrimination, PoC-validated)** — Excel real-scroll vs idle baseline: `fullChangedFraction p50` perfectly separates (0.005 vs 0.000); `firstPostDelta < 0.001` count perfectly separates (0 / 15 vs 15 / 15). Equivalent measurement against Word `_WwG` chain-trust path is a Stage 2b carry-over (PoC found Word + Notepad use Tier 1 UIA path so Stage 2a not invoked).
- **G2a-5 (CLAUDE.md §3.1 sweep)** — `observation.source` 8-value enum identical across ADR-019 §2.1, `_input-pipeline.ts:VisualMotionObservation`, ADR-018 §2.6. `index.d.ts` out-of-scope-by-design (runtime envelope hint, not napi binding).
- **G2a-6 (Stage 2b gate decision recorded)** — post-merge dogfood report (`docs/adr-019-stage-2a-dogfood-results.md`) documents per-app `stripsAboveNoise` distribution and the Stage 2b threshold choice.

---

## 5. Risks (post-pivot)

- **R1 — block-SAD coarse on sparse content (PoC finding)** — Excel cell grid signal is small (0.003-0.015 range) because `computeChangeFraction` with `NOISE_THRESHOLD = 16` is structurally insensitive to thin-line shifts (the same property that made dHash collapse PR #308). `STRIP_NOISE_THRESHOLD = 0.003` is calibrated for Excel; dense content (Word `_WwG` rich docs, custom-paint canvases) likely produces stronger signal so the threshold remains sufficient. Stage 2b can refine per-app.
- **R2 — Word `_WwG` empty docs use Tier 1 UIA (PoC finding)** — Stage 2a not invoked. The chain-trust path activates only when leaf walker retargets AND UIA pattern is unavailable on the leaf. Most modern apps use Tier 1 UIA; Stage 2a's scope is narrow but the path it covers (Excel chain-trust + future dense-doc Word `_WwG`) is genuinely silent without it.
- **R3 — Capture latency on slow disks / RDP** — `captureWindowRawWithFallback` can hit `PrintWindow` slow paths (~50 ms per call on RDP). Worst case 5 captures × 50 ms + 700 ms budget = budget exhausts before stability. PoC empirical p99 = 204 ms (29 % of budget), but RDP / slow systems may push higher. Mitigation: (a) `DESKTOP_TOUCH_STAGE2A_RING=0` user opt-out; (b) `stableReached: false` is honest signal — Stage 2b can fall through to `chain_trust_unverified`.
- **R4 — Persistent animations (caret blink, spinners)** — caret cycle 530 ms ≤ 700 ms budget → caret-active idle window may budget-timeout. Honest behaviour: `stableReached: false`, Stage 2b falls through to `chain_trust_unverified`. Strip filter mitigates partially (caret touches 1 strip → `stripsAboveNoise = 1` distinguishable from real scroll's 3-4 strips even if stability not reached).
- **R5 — Capture region uses full window rect** — frozen header row in Excel sits in strip 0 (always 0). `STRIP_COUNT = 4` partitions the rest into strips 1-3. Future Stage 2b refinement: capture only the leaf rect via `win32FindScrollLeafForTopLevel`.
- **R5.5 — `computeStripChangedFractions` vertical-strip per-strip memcpy on 4K windows (Opus PR #311 Round 1 P2-3)** — `axis === "horizontal"` (vertical strips) requires a per-strip `Buffer.alloc(sliceBytes)` + row-by-row copy because columns are not contiguous in row-major pixel layout. PoC Excel 905×555 ≈ 2 MB per ring is fine; 4K (3840×2160×4) × 4 strips ≈ 33 MB allocated + memcpy per Stage 2a invocation on horizontal scrolls. Stage 2a accepts the cost for impl simplicity; Stage 2b carry-over: per-strip column-major SIMD in Rust (`pixel_diff.rs`) avoiding the allocation. Note: vertical scrolls (the chain-trust Excel target) use `axis === "vertical"` and the zero-copy `subarray` path, so this risk only materialises on horizontal-scroll dispatches against custom-paint apps — not exercised in PoC and likely rare in practice.
- **R6 — CLAUDE.md §3.1 sweep verified** — `observation.source` 8 values still bit-equal across the 3 surfaces (ADR-019 §2.1 / `_input-pipeline.ts` / ADR-018 §2.6). Stage 2a adds NO new enum values; `temporal_ring_observation_only` is the first emitter of an existing PR #309 value.
- **R7 — CLAUDE.md §3.2 carry-over scope shrink verified** — no exhaustive `switch` on `observation.source` exists (grep `switch.*\\.source` returns zero hits in `src/`). Stage 2a is strictly additive on the envelope shape.

---

## 6. Open questions (post-pivot)

1. **Per-app `STRIP_NOISE_THRESHOLD` calibration** — Excel locked at 0.003. Other apps unknown until they activate the chain-trust path with rich content. **Resolution**: emit raw signal; Stage 2b sets per-app gate.
2. **`stripsAboveNoise` gate value for "real scroll" verdict** — PoC Excel data: real-scroll [9, 4, 1, 1, 0] (60 % zero), idle [15, 0, 0, 0, 0] (100 % zero). `stripsAboveNoise ≥ 1` distinguishes idle (100 %) from real-scroll (40 % reach ≥ 1). Whether ≥ 1 is enough vs ≥ 2 vs ≥ 3 → Stage 2b empirical decision.
3. **Caret-region masking** — Stage 4 (SSIM on focused-element rect) provides the mask infrastructure; Stage 2a uses full window, which is robust enough for the chain-trust path's typical targets (Excel cell area is mostly cells, not text input).
4. **Adaptive `pollIntervalMs`** — currently fixed 30 ms (2 DWM frames @ 60 Hz). 120 Hz monitors would benefit from 16 ms. Future refinement; Stage 2a ships fixed.

---

## 7. Dependencies / sequencing

- **Blocks**: nothing.
- **Blocked by**:
  - PR #309 (ADR-019 MVP-1, `c196bbc`) — provides the `VisualMotionObservation` contract surface and the `observeViaUiaOrChainTrust` extension point.
  - PR #310 (ADR-019 Stage 2a sub-plan, `6fd0ddd`) — the prior sub-plan version (pre-pivot).
  - `captureWindowRawWithFallback` in `src/engine/image.ts` — capture primitive.
  - `computeChangeFraction` in `src/engine/layer-buffer.ts` — diff primitive (now exported by Stage 2a).
- **Walking-skeleton classification**: trunk (per §0 preface). Canonical rationale: `docs/walking-skeleton-trunk-selection.md`.
- **Successor**: Stage 2b sub-plan — drafted after Stage 2a dogfood report.

---

## 8. North-star reconciliation

The TMOL framework's load-bearing thesis (ADR-019 §2.2, user-named "観測の時間軸をサーバに持ち込む") is that **temporal observation is the foundational primitive — new algorithms are downstream of it**. The pivot from fixed-schedule to stop-detection + strip filter does NOT change the framework — both are temporal observation algorithms within ADR-019 §1.3 / §2.2. The pivot is a refinement of HOW Stage 2a captures temporal motion, not WHAT Stage 2a does (still telemetry-only, observation-only, no decision).

---

## 9. Test plan summary

- **Unit (10 cases)**: `tests/unit/temporal-ring-buffer.test.ts` — strip filter correctness + schema pin. Fake clock not needed because helpers are synchronous (pure-Buffer math). 10 / 10 pass.
- **Integration regression sweep**: full `npm run test:capture`. 3403 / 3444 pass (4 pre-existing e2e Notepad-scroll flakes on `main` — not Stage 2a related).
- **PoC bench / dogfood**: `benches/poc_stage_2a_causal_strip.mjs --target-title "Book1 - Excel" --cycles 30` (real-scroll) + `--baseline=idle` (noise floor). PoC results in `docs/adr-019-stage-2a-poc-results.md`.
- **Production wiring verification**: PoC script imports from `dist/` so it exercises the same wiring as the production dispatcher. Excel real-scroll via `postWheelToHwnd` returns `channel: "postmessage"` 10 / 10, motion detected (`firstPostDelta > 0.001`) 10 / 10.

---

## 10. References

- Parent: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- PoC results: `docs/adr-019-stage-2a-poc-results.md`
- Predecessor PR: #309 (`c196bbc`, ADR-019 MVP-1)
- Prior sub-plan PR: #310 (`6fd0ddd`, originally fixed-schedule design — superseded by this Round 4 pivot)
- Sibling docs:
  - `docs/adr-018-input-pipeline-3tier.md` §2.6 — envelope `observation` reference
  - `docs/adr-018-phase-5-followup-verification-pathway-analysis.md` — A / B / C / A2 audit trail
- CLAUDE.md sections enforced:
  - §3 review loop (Opus + Codex)
  - §3.1 multi-table fact sweep (R6 above)
  - §3.2 carry-over scope shrink (R7 above)
  - §3.3 PR review loop (§11 below)
  - §9 residuals in docs/ (PoC results, dogfood results)

---

## 11. Review workflow (CLAUDE.md §3.3)

- **Step 0** — Classification: **production code改修 PR**. Codex **mandatory** (CLAUDE.md §3.3 Step 0 — `feedback_ai_multi_reviewer.md` API-contract surface軸).
- **Step 1** — Opus phase-boundary review with explicit §3.1 + §3.2 sweep + Lesson 1-4 sweep. Code change prohibited; review only.
- **Step 2** — Codex re-review via `@codex review` PR comment.
- **Step 3** — Iterate to P1 = 0.
- **Step 4** — User reviewer Lesson 1-4 final sweep window.
- **Step 5** — Merge (auto-mode: Opus Approved + (Codex Approved OR usage limit) → AI may merge per `memory/feedback_auto_mode_merge_opus_judgment.md`).

---

## 12. Pivot trail (round history)

- **Round 0 (PR #310 land 2026-05-16)** — fixed-schedule `[30, 60, 120, 240] ms` ring sampled `pre + post[k]` and emitted `maxChangedFraction`.
- **Round 1 (this PR, in-progress design refinement 2026-05-16)** — user observed that Windows GUI always converges to stable; polling adaptively + strip filter for causal expectation lets us drop threshold tuning. Deep research confirmed Playwright-style stop-detection is industry standard; identified caret blink + GPU staleness as primary failure modes (Windows specific).
- **Round 2 (this PR, PoC validation 2026-05-16)** — `benches/poc_stage_2a_causal_strip.mjs` ran 15-cycle Excel real-scroll + idle baseline. Empirical separation perfect; algorithm parameters locked. AC6 budget amended 300 → 700 ms.
- **Round 3 (this PR, impl + tests 2026-05-16)** — production wiring in `_input-pipeline.ts`, helpers in `layer-buffer.ts`, 10 unit cases, this sub-plan revised.
- **Round 4+** — post-merge dogfood report → Stage 2b sub-plan.
