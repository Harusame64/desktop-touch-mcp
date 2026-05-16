# ADR-019 Stage 2b sub-plan — promote `finalChangedFraction > 0` to `verifyDelivery.status` decision gate

- Status: **Draft (Round 0, 2026-05-16)** — written after Stage 2a impl land (PR #311, `0063ee3`) + dogfood report land (PR #312, `d9278a7`).
- Date: 2026-05-16
- Authors: Claude (Sonnet drafting, auto-mode `feature/adr-019-stage-2b-plan` branch).
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Predecessor PRs:
  - PR #309 (ADR-019 MVP-1 Stage 1, `c196bbc`) — `VisualMotionObservation` contract.
  - PR #310 (ADR-019 Stage 2a sub-plan, `6fd0ddd`) — pre-pivot fixed-schedule design.
  - PR #311 (ADR-019 Stage 2a impl, `0063ee3`) — stop-detection polling + causal strip filter (observation-only telemetry).
  - PR #312 (ADR-019 Stage 2a dogfood report, `d9278a7`) — Excel chain-trust validated, scope narrowed.
- This PR ("Stage 2b sub-plan"): branch `feature/adr-019-stage-2b-plan` — **docs-only** (no production code change).
- Successor (post-merge): Stage 2b impl PR (separate `feature/adr-019-stage-2b-impl` branch) — production code change against `_input-pipeline.ts` per §3 below.
- Walking-skeleton classification: **trunk** sub-plan (extends the temporal-observation primitive into a decision gate).
- Dogfood evidence: `docs/adr-019-stage-2a-dogfood-results.md` — Excel real-scroll vs idle perfect separation on `finalChangedFraction > 0` (30/30 vs 0/30, sensitivity / specificity = 100 % / 100 %).

---

## 0. Summary (why Stage 2b now, and why this shape)

Stage 2a (PR #311) added stop-detection polling + causal strip filter as **observation-only telemetry**: `ringTelemetry.finalChangedFraction` and `ringTelemetry.stripsAboveNoise` are populated on the chain-trust fallback path but **no decision change** flows from them. `verifyDelivery.status` is still `delivered` with `reason: "delivered_via_postmessage"` and `observation.source: "temporal_ring_observation_only"`, regardless of whether the post actually moved any pixels.

Stage 2a dogfood (PR #312) measured the telemetry on Excel (the only modern Windows app whose scroll path activates Stage 2a per the structural analysis in `docs/adr-019-stage-2a-dogfood-results.md` §4.5):

- Real scroll, 30 cycles: `finalChangedFraction p99 = 0.015`, `firstPostDelta > 0.001` count = **30 / 30 (100 %)**.
- Idle baseline, 30 cycles: `finalChangedFraction p99 = 0.000`, `firstPostDelta < 0.001` count = **30 / 30 (100 %)**.
- Wallclock p99 = 215 ms = **30.7 % of the 700 ms AC6 budget**.

**Perfect separation** on the simple `finalChangedFraction > 0` predicate. The block-SAD diff with `NOISE_THRESHOLD = 16` is structurally insensitive to thin-line shifts, so the idle floor is genuinely 0.000 (no spurious blocks). No threshold tuning, no per-app calibration; the gate is simply non-zero.

Stage 2b's decision rule is **the single load-bearing line below**:

```
if (ringTelemetry?.finalChangedFraction > 0)
  motion = "translation", verifyDelivery.status = "delivered", reason = "delivered_via_postmessage", observation.source = "temporal_ring_observation_only"
else
  motion = "no_change",   verifyDelivery.status = "not_delivered", reason = "target_unreachable",   observation.source = "temporal_ring_observation_only"
```

The strip-filter telemetry (`finalStripChangedFractions[]`, `stripsAboveNoise`) is **kept in the envelope** but **not gated on** in Stage 2b. The dogfood data shows it's redundant on Excel (sensitivity ≤ 20 % at PoC threshold 0.01, perfect on simple full-window non-zero check); Stage 2c+ may layer strip-shape gating onto a future dense-content / canvas-app target where `finalChangedFraction` saturates.

The `compute_block_motion_vectors` napi originally drafted in ADR-019 §2.5.3 is **deferred** — Stage 2a's existing `computeChangeFraction` (SSE2 8×8 block SAD, already SIMD) achieves perfect Excel separation with zero new native code. Block motion vectors revive only if a future target's telemetry refutes the full-window predicate (§5 R1).

`SCROLL_LEAF_CHAINS` (`src/win32/window.rs:271-274`) stays at **Excel + Word** (no expansion in Stage 2b). The dogfood analysis (`docs/adr-019-stage-2a-dogfood-results.md` §4.5) confirms Chromium / AvaloniaUI / File Explorer route through Tier 1 UIA or Tier 2 CDP — they would not benefit from Stage 2a/2b chain-trust observation. Future custom-paint canvases (Paint.NET, Photoshop, Blender, OBS preview) need their own chain-table addition as a separate effort.

### 0.1 Decision matrix summary (the 6 questions from agent prompt)

| # | Question | Decision |
|---|---|---|
| 1 | Gate threshold: `finalChangedFraction > 0` alone, or `stripsAboveNoise ≥ 1` too? | **`finalChangedFraction > 0` alone**. Strip telemetry retained but not gated. Dogfood: full-window non-zero is sufficient (100 % / 100 %), strip shape becomes useful only when `finalChangedFraction` saturates (future dense-content carry-over). |
| 2 | `observation.source` value: keep `"temporal_ring_observation_only"` + add `motion: "translation"`, or emit `"block_motion_vectors"`? | **Keep `"temporal_ring_observation_only"` + populate `motion: "translation"` (or `"no_change"`)**. The source enum value already describes the algorithm; the new content is the `motion` decision now being populated rather than `"indeterminate"`. No new enum value (§4 R1 keeps the §3.1 SSOT sweep small). `"block_motion_vectors"` reserved for a future native-SAD napi addition (Stage 2c+, conditional). |
| 3 | `verifyDelivery.reason` value change? | **No new reason value**. Real scroll keeps `"delivered_via_postmessage"`. Silent drop (`finalChangedFraction === 0`) flips to **`"target_unreachable"`** (existing ADR-018 §2.6.2 value, `status: "not_delivered"`) — this is the **decision gate that Stage 2b lands**. No new reason word added; we reuse the existing taxonomy and let the `observation.source` distinguish "TMOL-observed not_delivered" from other `target_unreachable` causes. |
| 4 | `compute_block_motion_vectors` napi: needed in Stage 2b? | **No — deferred to Stage 2c (conditional)**. PoC + dogfood proved `computeChangeFraction` (existing 8×8 SSE2 SAD) is sufficient for Excel. Block motion vectors revive only when a future telemetry target shows `finalChangedFraction` saturating to > 0 even on idle (no separation), at which point per-strip or per-block discrimination becomes necessary. |
| 5 | `SCROLL_LEAF_CHAINS` expansion? | **No — Excel + Word only (unchanged)**. Dogfood `docs/adr-019-stage-2a-dogfood-results.md` §4.5: Chromium / AvaloniaUI / File Explorer use Tier 1 UIA or Tier 2 CDP; they don't take the chain-trust branch. Adding a chain entry without a confirmed silent-drop scenario would be premature and would expose other apps to a behaviour change without dogfood evidence. |
| 6 | Backward compat: existing chain-trust callers unaffected? | **Behavioural break is intentional and load-bearing on Stage 2a-observable silent drops only**. Excel real-scroll: zero behaviour change (still `delivered` + `delivered_via_postmessage`). Excel silent drop (no pixel change despite PostMessage queued): **changes from `delivered` to `not_delivered` with `target_unreachable`**. This is the bug Stage 2a was built to expose. Stage 2a's existing env opt-out `DESKTOP_TOUCH_STAGE2A_RING=0` extends to opt out of Stage 2b too — when the env var is set, Stage 2b doesn't fire (no ring captured → no `finalChangedFraction` → no gate trigger; the bare `chain_trust_unverified` path runs and the original `delivered_via_postmessage` is emitted unchanged). Telemetry-only mode (Stage 2a behaviour) is preserved via a **new env var `DESKTOP_TOUCH_STAGE2B_GATE=0`** that suppresses just the decision gate while keeping the ring telemetry. |

---

## 1. Context

### 1.1 The gap Stage 2b closes

ADR-019 §1.1 framed the silent-failure mode for the chain-trust path:

> Codex P1 boundary case is documented unverified.

Stage 1 added the `VisualMotionObservation` envelope hint but emitted `source: "chain_trust_unverified"` on Excel — no actual verification. Stage 2a polled post-frames and computed pre-vs-final diff, but **continued to claim `delivered_via_postmessage`** regardless of the diff result; the LLM still receives `status: "delivered"` even when zero pixels changed.

Stage 2b is the **decision** that consumes Stage 2a's evidence. After Stage 2b:

- Real Excel scroll (pixels moved) → `verifyDelivery.status = "delivered"`, `reason = "delivered_via_postmessage"`, `observation.motion = "translation"`. **Unchanged from Stage 2a's wire-level output**.
- Excel silent drop (PostMessage queued but no pixel change — receiver dropped the message, modal occluded, animation interrupted, etc.) → `verifyDelivery.status = "not_delivered"`, `reason = "target_unreachable"`, `observation.motion = "no_change"`. **This is the case Stage 2b newly catches**.

The status flip from `"delivered"` to `"not_delivered"` is the load-bearing behavioural change. The LLM sees an honest negative when the post didn't move anything, and chain-trust no longer falsely returns `delivered` on receiver-side drops.

### 1.2 Why now (sequencing)

Stage 2b is gated on Stage 2a dogfood evidence per the original Stage 2a sub-plan §3 P6 ("Dogfood report → Stage 2b gate decision"). PR #312 published the report; this sub-plan executes the carry-over recommendation `docs/adr-019-stage-2a-dogfood-results.md` §5.1 ("Primary gate (recommended): `finalChangedFraction > 0`").

### 1.3 Scope boundary (Stage 2b vs Stage 2c)

| Concern | Stage 2b (this sub-plan) | Stage 2c (future, conditional) |
|---|---|---|
| Decision rule: `finalChangedFraction > 0` | **yes** (primary gate) | reused |
| `verifyDelivery.status` flip on silent drop | **yes** (`delivered` → `not_delivered`) | reused |
| Strip-shape gate (`stripsAboveNoise`) | **no** (telemetry retained, not gated) | yes (dense-content / canvas-app discrimination) |
| Block motion vectors napi | **no** (deferred) | conditional — activates only if a future target's telemetry triggers §6 OQ #4 criteria (saturation / `stableReached: false` rate / silent-drop report). Otherwise remains dormant indefinitely. |
| `SCROLL_LEAF_CHAINS` expansion | **no** (Excel + Word unchanged) | yes (per-app empirical addition) |
| New `observation.source` enum values | **no** | maybe `"block_motion_vectors"` if napi lands |
| Env opt-out granularity | gate-only via `DESKTOP_TOUCH_STAGE2B_GATE` (additive on Stage 2a's `DESKTOP_TOUCH_STAGE2A_RING`) | reused |
| Latency budget | unchanged — temporal fallback p99 ≤ 700 ms (AC6 amended) | unchanged |

---

## 2. Decision

Adopt the **`finalChangedFraction > 0` primary gate** as the Stage 2b decision rule on the chain-trust fallback path. When activated:

1. Stage 2a captures the ring + computes telemetry (no change to Stage 2a's existing wiring).
2. Stage 2b consumes `ringTelemetry.finalChangedFraction` and decides:
   - `> 0` → `motion = "translation"`, dispatch outcome unchanged (`scrolled: true`, `channel: "postmessage"`, `reason: "delivered_via_postmessage"`).
   - `=== 0` → `motion = "no_change"`, dispatch outcome **flipped** to `scrolled: false`, dispatcher returns `null` so the caller (`postWheelToHwnd` → `dispatchScrollWheel` cascade or `mouse.ts:scrollHandler`) emits `verifyDelivery.status = "not_delivered"` with `reason: "target_unreachable"`.
3. Stage 2a env opt-out (`DESKTOP_TOUCH_STAGE2A_RING=0`) suppresses the entire ring → Stage 2b has no telemetry to gate on → falls back to bare `chain_trust_unverified` (Stage 1 behaviour). The new env var `DESKTOP_TOUCH_STAGE2B_GATE=0` keeps the ring (telemetry retained) but suppresses just the gate (Stage 2a behaviour: always `delivered`).

### 2.1 Activation rule

Stage 2b's gate fires iff **all** of the following hold:

1. The dispatcher took the chain-trust branch of `postWheelToHwnd` (`pre === null && retargetedByLeafWalker`), **AND**
2. `DESKTOP_TOUCH_STAGE2A_RING !== "0"` (Stage 2a ring was captured), **AND**
3. `DESKTOP_TOUCH_STAGE2B_GATE !== "0"` (Stage 2b gate is not opted out), **AND**
4. `observation.ringTelemetry !== undefined` (capture succeeded — preFrame, region, axis all non-null and ring helper returned at least one frame).

When any of (2-4) is false the chain-trust path emits the existing `delivered_via_postmessage` (Stage 2a behaviour preserved).

### 2.2 Gate predicate

```ts
// Stage 2b decision (operates on Stage 2a's ringTelemetry):
const finalChangedFraction = observation.ringTelemetry.finalChangedFraction;
if (finalChangedFraction > 0) {
  observation.motion = "translation";
  // observation.source unchanged: "temporal_ring_observation_only"
  // dispatch outcome unchanged: scrolled=true, channel=postmessage, reason=delivered_via_postmessage
} else {
  observation.motion = "no_change";
  // observation.source unchanged: "temporal_ring_observation_only"
  // dispatch outcome flipped: dispatcher returns null
  //   → caller emits status="not_delivered", reason="target_unreachable" per ADR-018 §2.6.2 path-(b)
}
```

The gate is **strictly `> 0`**, not `> ε`. Block-SAD with `NOISE_THRESHOLD = 16` already filters thin-line noise; the idle floor is empirically 0.000 (30 / 30 cycles in dogfood). An epsilon would risk demoting genuine micro-scrolls (1 px line shift on a 555-row Excel window = 0.0018 changedFraction, just above STABLE_THRESHOLD).

### 2.3 `observation.motion` field semantics post-Stage-2b

Pre-Stage-2b (Stage 2a impl): `motion` is hardcoded `"indeterminate"` when `source === "temporal_ring_observation_only"` (`_input-pipeline.ts:777`).

Post-Stage-2b: `motion` is populated to `"translation"` or `"no_change"` based on `finalChangedFraction`. The `"indeterminate"` value remains valid for non-gate fall-through paths (e.g. ring capture returned zero frames → bare `chain_trust_unverified` emits `motion: "indeterminate"`).

### 2.4 New `observation.shift` field population for chain-trust path?

The contract (`VisualMotionObservation`, ADR-019 §2.1) declares `shift?: { dx: number; dy: number; confidence: number }` "present iff motion === 'translation'". Stage 2a's `finalChangedFraction` is a scalar — it doesn't measure pixel-level shift, only "fraction of blocks above noise". Stage 2b therefore **does NOT populate `shift`** on the chain-trust path; `motion: "translation"` is emitted with `shift: undefined`.

This is a contract relaxation: the original ADR-019 §2.1 docstring "present iff" is a strong claim that holds for `source: "uia_scroll_percent"` (which carries percent delta) but not for `source: "temporal_ring_observation_only"` (which carries only block-fraction). Two repair options:

- **Option A — Relax docstring**: change "present iff" to "present when the algorithm produced a numeric shift (e.g. UIA percent for `uia_scroll_percent`); may be absent for sources that produce only a binary motion verdict (e.g. `temporal_ring_observation_only`)". Minimal SSOT impact (ADR-019 §2.1 docstring + `VisualMotionObservation` TSDoc).
- **Option B — Populate `shift` with a sentinel**: emit `{ dx: 0, dy: 0, confidence: 0 }` to satisfy "present iff". Semantically wrong (zeros suggest no shift was detected, but `motion = "translation"` says the opposite); confidence-0 leaks "we don't actually know" through the wrong field.

**Decision**: **Option A** (relax docstring). The honest contract is "shift is present when measurable; motion is present always". Stage 2b updates the ADR-019 §2.1 docstring + the `VisualMotionObservation` TSDoc in `_input-pipeline.ts`. CLAUDE.md §3.1 sweep grep across ADR-019 / ADR-018 / `_input-pipeline.ts` / `mouse.ts` / `index.d.ts` for any "present iff" wording.

### 2.5 Affected files (SSOT)

| File | Change | Stage |
|---|---|---|
| `src/tools/_input-pipeline.ts` | (a) `observeViaUiaOrChainTrust`: populate `motion` from `finalChangedFraction > 0` predicate (currently hardcoded `"indeterminate"`). (b) New `DESKTOP_TOUCH_STAGE2B_GATE` env check guarding the populate-or-keep-indeterminate branch. (c) Dispatcher caller (`postWheelToHwnd` chain-trust branch, lines 1136-1163): when `observation.motion === "no_change"`, return `null` from `postWheelToHwnd` so caller emits `target_unreachable`. Helper extraction recommended for clarity. | Stage 2b impl |
| `src/tools/_input-pipeline.ts:VisualMotionObservation` (TSDoc) | Relax `shift?` "present iff" wording per §2.4 Option A. | Stage 2b impl |
| `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` §2.1 | Relax `shift?` "present iff" wording (matches `_input-pipeline.ts`). | Stage 2b impl |
| `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` §10 OQ | Mark Stage 2b decision recorded; reference this sub-plan. **NOTE**: Stage 4 (Click verify SSIM) may concurrently edit ADR-019 main doc — Stage 2b impl PR should rebase carefully and surgical-edit only §2.1 docstring + §10 OQ entry. If conflict arises, Stage 2b impl defers main doc edit to a sweep PR. | Stage 2b impl (deferred-OK) |
| `docs/adr-018-phase-5-followup-verification-pathway-analysis.md` lines 157, 159 | Mirror the `shift?` / `residual?` "present iff" wording relaxation (Round 1 Opus P2-1 — this doc contains an early `VisualMotionObservation` shape sketch with the original "present iff" comments; SSOT sweep must reach this surface too, or §3 P7 grep would miss it). | Stage 2b impl |
| `docs/adr-018-input-pipeline-3tier.md` §2.6.2 | Add `target_unreachable (Stage 2b TMOL gate)` row note: clarifies that the existing 5-value reason taxonomy is unchanged but `target_unreachable` now has a new emission path on the chain-trust branch (additive; existing paths preserved). | Stage 2b impl |
| `tests/unit/temporal-ring-buffer.test.ts` or new `tests/unit/stage-2b-gate.test.ts` | Add cases pinning the gate: (a) `finalChangedFraction = 0.005` → `motion: "translation"`, dispatcher outcome `delivered_via_postmessage`. (b) `finalChangedFraction = 0.000` → `motion: "no_change"`, dispatcher returns `null`. (c) `DESKTOP_TOUCH_STAGE2B_GATE=0` → motion stays `"indeterminate"`, dispatcher outcome `delivered_via_postmessage` regardless of `finalChangedFraction`. (d) `DESKTOP_TOUCH_STAGE2A_RING=0` → no ring captured → no gate (regressively safe). | Stage 2b impl |
| `tests/integration/scroll-chain-trust.test.ts` (if exists) | Update to expect new `motion` values; otherwise no change. Verify with grep before assuming. | Stage 2b impl |
| `benches/poc_stage_2a_causal_strip.mjs` | No code change. The bench script's `finalChangedFraction` column already drives the gate's empirical case; Stage 2b impl PR may add a `--check-gate` flag that asserts the `>0` predicate against captured cycles for regression-bench purposes. **Carry-over to impl PR** (not Stage 2c). | Stage 2b impl (optional) |
| `docs/adr-019-stage-2b-dogfood-results.md` (NEW) | Post-impl dogfood report (separate post-merge PR). Captures Excel real-scroll → `motion: "translation"` 30/30, Excel silent-drop scenario (synthetic — modal block? receiver kill?) → `motion: "no_change"`. Populated by impl PR's author. | Stage 2b dogfood |

Stage 2b does **NOT** touch:
- `src/uia/scroll.rs` (UIA path unchanged)
- `src/pixel_diff.rs` (no new Rust SAD variant)
- `src/win32/window.rs:SCROLL_LEAF_CHAINS` (table unchanged)
- `src/engine/layer-buffer.ts` (Stage 2a helpers unchanged)
- `src/tools/mouse.ts` (`ScrollVerifyOutcome` already carries `observation` from Stage 1; `scrollHandler` emits `target_unreachable` from existing `null` dispatch outcome — no new code path in this file)
- `index.d.ts` / `index.js` (no new napi)

---

## 3. Implementation plan (Stage 2b impl PR, separate from this sub-plan PR)

Note: this checklist is for the **impl PR** that lands after this sub-plan PR merges. The sub-plan PR (this branch) is **docs-only**.

- [ ] **P1** — `src/tools/_input-pipeline.ts`: add `DESKTOP_TOUCH_STAGE2B_GATE` env check; populate `motion` from `finalChangedFraction > 0` when env not opted out; keep `"indeterminate"` when opted out. Extract `evaluateStage2bGate(ringTelemetry, env)` helper for testability.
- [ ] **P2** — `src/tools/_input-pipeline.ts:postWheelToHwnd`: when chain-trust branch emits `observation.motion === "no_change"`, return a **non-null `DispatchOutcome` with `scrolled: false`** (NOT bare `null`) carrying the observation. Caller (`dispatchScrollWheel` / `mouse.ts:scrollHandler`) emits `verifyDelivery.status = "not_delivered"` with `reason = "target_unreachable"` AND `observation` preserved. **Design decision locked (Round 1 Opus P2-2, see §5 R3 for the choice between alternatives)**: extend the `DispatchOutcome` type to allow `scrolled: false` to coexist with `observation` — preserve the `null` return path for the existing "fall through to next tier" semantic (NOT used by chain-trust which already terminates on `pre === null`), and use the `scrolled: false` outcome as the **Stage 2b TMOL gate-fail signal**. Caller-side detection: `outcome.scrolled === false && outcome.reason === "target_unreachable"` triggers the `not_delivered` envelope emission. This contract change is additive (`scrolled` already exists in the type; today it is always `true` in chain-trust path); existing `null` consumers unaffected.
- [ ] **P3** — `src/tools/_input-pipeline.ts:VisualMotionObservation` TSDoc + ADR-019 §2.1 docstring: relax `shift?` "present iff" wording per §2.4 Option A.
- [ ] **P4** — `docs/adr-018-input-pipeline-3tier.md` §2.6.2: add Stage 2b emission row note for `target_unreachable`.
- [ ] **P5** — `tests/unit/stage-2b-gate.test.ts` (or extend `temporal-ring-buffer.test.ts`): 4 cases per §2.5 SSOT row.
- [ ] **P6** — `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` §10 OQ entry: Stage 2b gate decision recorded.
- [ ] **P7** — CLAUDE.md §3.1 sweep: grep `"present iff"` across ADR-019 main / ADR-018 §2.6 / **`docs/adr-018-phase-5-followup-verification-pathway-analysis.md` lines 157/159** (Round 1 Opus P2-1 sweep target — early `VisualMotionObservation` shape sketch) / `src/tools/_input-pipeline.ts` / `src/tools/mouse.ts` / `index.d.ts` / `tests/` to confirm Option A's docstring relaxation is consistently applied. As of this sub-plan PR, grep confirms 3 hits: `_input-pipeline.ts`, ADR-019 main, the followup verification pathway analysis doc.
- [ ] **P8** — Full `npm run test:capture` regression sweep; expect no test failures (existing Stage 2a tests should pass unchanged because the gate predicate runs on telemetry that already exists).
- [ ] **P9** — Post-merge dogfood — populate `docs/adr-019-stage-2b-dogfood-results.md` with ≥ 30-cycle Excel real-scroll + silent-drop scenario.

---

## 4. Acceptance criteria

- **G2b-1 (functional, real scroll)** — Excel real-scroll via `benches/poc_stage_2a_causal_strip.mjs --cycles 30` returns `verifyDelivery.status = "delivered"` 30 / 30 with `observation.motion = "translation"` and `observation.source = "temporal_ring_observation_only"`.
- **G2b-2 (functional, silent drop synthetic)** — Synthetic silent-drop scenario (e.g. ring captures returned `finalChangedFraction = 0` due to mocked telemetry, or a real receiver-side drop reproduced via modal cover): `verifyDelivery.status = "not_delivered"` with `reason = "target_unreachable"` and `observation.motion = "no_change"`. **Carry-over to impl PR**: identify the most reliable synthetic reproduction.
- **G2b-3 (no regression on Tier 1 UIA path)** — Word / Notepad / File Explorer scrolls (Tier 1 UIA, Stage 2a not invoked) emit unchanged envelope (status, reason, channel, observation absent or `uia_scroll_percent`).
- **G2b-4 (env opt-out preserves Stage 2a behaviour)** — `DESKTOP_TOUCH_STAGE2B_GATE=0`: Excel chain-trust silent-drop scenario emits `verifyDelivery.status = "delivered"` (Stage 2a behaviour preserved), `observation.motion = "indeterminate"` (gate suppressed), `ringTelemetry.finalChangedFraction = 0` (telemetry preserved).
- **G2b-5 (env opt-out preserves Stage 1 behaviour)** — `DESKTOP_TOUCH_STAGE2A_RING=0`: Excel chain-trust scenario emits `observation.source = "chain_trust_unverified"` (Stage 1 behaviour preserved, no ring captured), no `ringTelemetry`, `verifyDelivery.status = "delivered"` (no gate possible without telemetry).
- **G2b-6 (latency budget, AC6 unchanged)** — wallclock p99 ≤ **700 ms** end-to-end. Stage 2b adds < 100 ns of decision logic on top of Stage 2a's ~210 ms p99; budget unaffected.
- **G2b-7 (CLAUDE.md §3.1 sweep)** — `observation.source` 8-value enum bit-equal across ADR-019 §2.1, `_input-pipeline.ts:VisualMotionObservation`, ADR-018 §2.6 (Stage 2b adds NO new enum values). `shift?` "present iff" wording consistently relaxed per §2.4 Option A across all surfaces.
- **G2b-8 (CLAUDE.md §3.2 carry-over scope shrink)** — No exhaustive `switch` on `observation.source` or `observation.motion` exists (grep `switch.*\.(source|motion)` returns zero hits in `src/`). Stage 2b is additive on the envelope semantic (motion value transitions from `"indeterminate"` to a concrete value; no shape change).
- **G2b-9 (post-merge dogfood report)** — `docs/adr-019-stage-2b-dogfood-results.md` populated within 1 week of impl PR merge.

---

## 5. Risks

- **R1 — `finalChangedFraction` saturates on future dense-content targets**: Excel's chain-trust hits `finalChangedFraction p99 = 0.015` (well below 1.0). Word `_WwG` rich docs or Photoshop legacy may produce `finalChangedFraction = 1.0` on idle (large animated regions, persistent background change), making `> 0` a meaningless gate. **Mitigation**: Stage 2c sub-plan re-introduces strip-shape gating (`stripsAboveNoise ≥ 2`) or block motion vectors when a target's dogfood telemetry shows saturation. Stage 2b ships honest behaviour for current confirmed target (Excel); future targets carry-over.
- **R2 — Silent drop is hard to synthesise**: Excel's chain-trust path nearly always succeeds (PR #312 dogfood = 30 / 30 real-scroll). Genuine silent drops (PostMessage queued but receiver dropped) are rare on healthy systems; G2b-2 acceptance may need a mock test rather than a real-system repro. **Mitigation**: unit test with mocked `capturePostFrameUntilStable` returning `finalChangedFraction = 0`; defer real-system repro to Stage 2c dogfood when more receiver-side failure modes are catalogued.
- **R3 — `DispatchOutcome` shape preservation under TMOL gate-fail**: the `postWheelToHwnd` function returns `DispatchOutcome | null`; today `null` means "fall through to next tier" and the observation would be lost on a `null` return. Stage 2b's `motion: "no_change"` decision must surface the observation on the `target_unreachable` outcome (otherwise LLM sees `status: "not_delivered"` with no `observation` field — same as a destination-resolution failure, ambiguous with TMOL-observed silent drop). **Design decision locked (Round 1 Opus P2-2)**: choose **Option I — non-null `DispatchOutcome` with `scrolled: false`**, NOT Option II (extend return type to `{ outcome, observation? }` tuple) or Option III (closure / module-global context). Rationale: (a) the `DispatchOutcome.scrolled: boolean` field already exists and is naturally truthful when set to `false` for a TMOL gate-fail; (b) Option II would force every caller (today only `dispatchScrollWheel`) to unwrap a tuple, expanding the surface; (c) Option III hides the gate-fail signal in mutable shared state, violating CLAUDE.md 強制命令 7 ("仕組みで対応する"). The `null` return path is preserved for "fall-through to next tier" (no chain-trust fall-through exists below `postWheelToHwnd` today; the `null` path is dormant on the chain-trust branch but the type union stays the same). Impl PR: extend `DispatchOutcome.reason` union (or `DispatchOutcome.scrolled` semantic) to allow `scrolled: false, reason: "target_unreachable", observation: { motion: "no_change", source: "temporal_ring_observation_only", ringTelemetry: {...} }` as a valid contract output; `mouse.ts:scrollHandler` already inspects `tier1 !== null && tier1.scrolled` (line ~1254) so the existing predicate flips naturally to the `not_delivered` branch. **This is the load-bearing implementation detail of Stage 2b** — design locked here; impl PR executes without re-deciding.
- **R4 — Behavioural break on `verifyDelivery.status` from `delivered` → `not_delivered`**: this is **intentional** and load-bearing on the silent-drop case the bug Stage 2a / 2b exist to expose. Mitigation: env opt-out `DESKTOP_TOUCH_STAGE2B_GATE=0` preserves Stage 2a behaviour for users who hit unexpected regressions; user can flip the flag and report telemetry for Stage 2c refinement.
- **R5 — Stage 4 (Click verify SSIM) lands concurrently and conflicts on ADR-019 §2.1 docstring**: per ADR-019 §4 stages plan, Stage 4 (SSIM for click verify) is parallel-shippable with Stage 2b. Both edit ADR-019 §2.1 (Stage 4 adds source enum semantics for `"ssim_residual"`; Stage 2b relaxes `shift?` docstring). **Mitigation**: agent prompt explicitly forbids touching ADR-019 main doc in **this** sub-plan PR; Stage 2b impl PR coordinates with Stage 4 author (likely separate agent) via rebase. Worst case: Stage 2b impl PR's §2.1 docstring change moves to a follow-up sweep PR after Stage 4 lands.
- **R6 — `target_unreachable` overload**: this reason is already emitted for destination-resolution failure (path-a) and tier exhaustion (path-b). Stage 2b adds a third path (chain-trust + TMOL gate fail). The three paths are distinguishable by `observation.source` (`undefined` for path-a, `undefined` for path-b legacy, `"temporal_ring_observation_only"` for Stage 2b). **Mitigation**: `_errors.ts` hint text for `target_unreachable` may need a Stage 2b-aware enhancement; defer to impl PR. ADR-018 §2.6.2 row note (P4 above) documents the new emission path inline.
- **R7 — CLAUDE.md §3.1 multi-table fact integrity sweep**: `observation.source` enum (8 values), `observation.motion` enum (4 values), `verifyDelivery.reason` enum (5 values + 4 legacy), `verifyDelivery.status` enum (3 values) all live in multiple surfaces. Stage 2b adds zero new enum values (key claim: §0.1 decisions 2 and 3) but **relaxes** `shift?` semantics (§2.4 Option A). Sweep target: grep `"present iff"` + `"shift?"` across ADR-019 / ADR-018 / `_input-pipeline.ts` / `mouse.ts` / `index.d.ts`.
- **R8 — CLAUDE.md §3.2 carry-over scope shrink**: Stage 2b is "promote Stage 2a observation to decision gate". The promotion does NOT involve adding a new pre-existing public API contract — `ScrollVerifyOutcome.observation` already accepts arbitrary `VisualMotionObservation` shapes; Stage 2b just transitions one motion value (`"indeterminate"` → `"translation"` | `"no_change"`). No external code that consumes `ScrollVerifyOutcome.motion` (none exists in `src/`, grep verified) is affected.

---

## 6. Open questions

1. **Should `target_unreachable` on the Stage 2b path emit a different reason** (e.g. a new `silent_drop_observed` enum value) **to disambiguate from legacy destination-resolution failure**? **Decision (this sub-plan, §0.1 #3)**: NO — keep `target_unreachable`, distinguish via `observation.source`. Re-open if a Stage 2b dogfood reveals operator confusion in LLM responses.
2. **Should the Stage 2b gate consider `stableReached: false` as a third outcome** (instead of inferring from `finalChangedFraction`)? **Decision**: NO for Stage 2b — `stableReached: false` correlates with budget-timeout (caret animation, slow MFC), and `finalChangedFraction` covers the same information in scalar form. Stage 2c may refine if a target produces `stableReached: true` AND `finalChangedFraction > 0` AND user-perceived no-scroll (currently no evidence).
3. **Should `DESKTOP_TOUCH_STAGE2B_GATE=0` be the default in v1.6.x (telemetry-only) and flip to `=1` (gate active) in v1.7.0**? **Decision**: NO — Stage 2b ships gate-on by default in the next minor (likely v1.6.1 or v1.7.0 depending on release pipeline). Env opt-out is for users who need to roll back the behaviour change. Rationale: the dogfood data is strong enough (perfect separation on Excel) that gating is the correct production default.
4. **Stage 2c trigger** — when does Stage 2c start? **Decision criteria**: at least one of (a) a new chain-trust target's dogfood shows `finalChangedFraction` saturation (no separation between real-scroll and idle — concretely, the real-scroll vs idle separation collapses such that a `> 0` predicate yields < 95 % sensitivity OR < 95 % specificity, vs Stage 2a Excel dogfood's 100 % / 100 % per `docs/adr-019-stage-2a-dogfood-results.md` §2.3), OR (b) a new chain-trust target shows `stableReached: false` rate > 10 % despite real user-visible motion (specific threshold chosen as a Round 1 P3-2 placeholder — Stage 2a Excel dogfood baseline = 0 % `stableReached: false` per §2.1; 10 % is a 1-in-10 worst-case the LLM can still gracefully handle, calibrate per-target during Stage 2c if available), OR (c) user / operator report of a silent-drop case Stage 2b missed. Until any trigger fires, Stage 2c is dormant.
5. **`compute_block_motion_vectors` napi naming** — if Stage 2c does need it, should the napi reuse the `pixel_diff.rs` module (extending the existing SSE2 8×8 SAD to 16×16 coarse-to-fine) or live in a new `motion_estimation.rs`? **Decision**: defer to Stage 2c sub-plan, not Stage 2b.
6. **Stage 2b interaction with `stableReached: false`** — when budget exhausts AND `finalChangedFraction > 0` (animation present, real scroll superimposed), Stage 2b emits `motion: "translation"`. This is correct (motion was observed) but the LLM may want to know stability was not achieved. **Decision**: the existing `ringTelemetry.stableReached` field is already in the envelope; LLM can inspect it. No new code path.

---

## 7. Dependencies / sequencing

- **Blocks**: nothing (Stage 2c is a sequence successor, not a hard block — it activates only when Stage 2b telemetry warrants).
- **Blocked by**:
  - PR #309 (ADR-019 MVP-1, `c196bbc`) — `VisualMotionObservation` contract.
  - PR #311 (ADR-019 Stage 2a impl, `0063ee3`) — Stage 2a ring buffer + telemetry.
  - PR #312 (ADR-019 Stage 2a dogfood, `d9278a7`) — dogfood evidence for the `finalChangedFraction > 0` gate.
  - `_input-pipeline.ts:observeViaUiaOrChainTrust` + `postWheelToHwnd` — Stage 2a wiring extension points.
- **Concurrent / coordinate with**:
  - **Stage 4 (Click verify SSIM)** — ADR-019 §4 lists Stage 4 as parallel-shippable. Both touch ADR-019 §2.1 (different parts of the contract). Stage 2b impl PR coordinates rebase with Stage 4 author.
  - **ADR-018 Phase 6+** (if any) — unlikely conflict; ADR-018 §2.6.2 row notes are additive.
- **Walking-skeleton classification**: trunk (Stage 2b extends the temporal-observation primitive into a decision gate — load-bearing on chain-trust contract).
- **Successor**: Stage 2c sub-plan — drafted when one of §6 OQ #4 triggers fires.

---

## 8. North-star reconciliation

ADR-019 §1 / §2 names the TMOL framework's load-bearing thesis: **観測の時間軸をサーバに持ち込む** (bring the temporal observation surface into the server). Stage 1 added the contract. Stage 2a captured temporal evidence. Stage 2b **decides on the evidence** — the LLM's `verifyDelivery.status` now reflects what actually happened pixel-wise, not just what was queued message-wise.

The decision rule (`finalChangedFraction > 0`) is intentionally simple. The framework's value is NOT in algorithmic sophistication; it's in **closing the silent-failure gap on the chain-trust path** with the simplest gate that the dogfood data justifies. Stage 2c (block motion vectors, strip-shape gate, dense-content discrimination) layers complexity onto the framework only when new telemetry refutes the simple gate.

This matches CLAUDE.md 強制命令 7 ("仕組みで対応する") — the gate is a structural enforcement (the dispatcher's return contract), not a "be careful in code review" rule.

---

## 9. Test plan summary

- **Unit (4 new cases)**: `tests/unit/stage-2b-gate.test.ts` (or extension of `tests/unit/temporal-ring-buffer.test.ts`):
  - Gate fires `motion: "translation"` on `finalChangedFraction = 0.005`.
  - Gate fires `motion: "no_change"` on `finalChangedFraction = 0.000`.
  - `DESKTOP_TOUCH_STAGE2B_GATE=0` → `motion: "indeterminate"` regardless of `finalChangedFraction`.
  - `DESKTOP_TOUCH_STAGE2A_RING=0` → no `ringTelemetry` → no gate; bare `chain_trust_unverified` source.
- **Integration regression sweep**: full `npm run test:capture`. Expect zero new failures (existing Stage 2a tests should pass unchanged; `motion: "indeterminate"` → `"translation"` transition is observable but tests pinning the old value may need updates — flag in impl PR).
- **PoC bench / dogfood**: `benches/poc_stage_2a_causal_strip.mjs --target-title "Book1 - Excel" --cycles 30` against impl PR build; expect `verifyDelivery.status = "delivered"` 30 / 30. Idle baseline: expect `status = "not_delivered"` with `reason = "target_unreachable"` 30 / 30 (gate now flips on `finalChangedFraction = 0`).
- **Synthetic silent-drop**: impl PR identifies a reliable synthetic (mock receiver, modal cover, throttled CPU). Carry-over to dogfood report.
- **Env opt-out matrix**: 4 combos of `DESKTOP_TOUCH_STAGE2A_RING` × `DESKTOP_TOUCH_STAGE2B_GATE` ({on, off} × {on, off}) tested via env-var smoke test in impl PR.

---

## 10. References

- Parent: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- PoC results: `docs/adr-019-stage-2a-poc-results.md`
- Dogfood results: `docs/adr-019-stage-2a-dogfood-results.md`
- Stage 2a sub-plan: `docs/adr-019-stage-2a-plan.md`
- Predecessor PRs: #309 (`c196bbc`), #311 (`0063ee3`), #312 (`d9278a7`)
- ADR-018 §2.6 envelope reason taxonomy: `docs/adr-018-input-pipeline-3tier.md`
- CLAUDE.md sections enforced:
  - §3 review loop (Opus + Codex)
  - §3.1 multi-table fact sweep (R7 above + P7)
  - §3.2 carry-over scope shrink (R8 above)
  - §3.3 PR review loop (§11 below)
  - §7 仕組みで対応する (gate is structural, not review-time)
  - §9 残件は docs/ (Stage 2c criteria + dogfood follow-up in this doc, not memory)

---

## 11. Review workflow (CLAUDE.md §3.3)

This is the **sub-plan PR** review workflow. The Stage 2b impl PR follows its own §3.3 cycle separately.

- **Step 0** — Classification: **docs / plan PR**. Codex **recommended** (Phase-boundary plan; §3.3 Step 0 — `feedback_ai_multi_reviewer.md` notes Phase-boundary plans benefit from Codex's API-contract surface axis even when no production code changes).
- **Step 1** — Opus phase-boundary review with explicit §3.1 + §3.2 sweep + Lesson 1-4 sweep. Code change prohibited; review only.
- **Step 2** — Codex re-review via `@codex review` PR comment (best-effort — skip if usage limit).
- **Step 3** — Iterate to P1 = 0.
- **Step 4** — User reviewer Lesson 1-4 final sweep window (best-effort under auto-mode; agent proceeds to Step 5 after Opus Approved).
- **Step 5** — Merge (auto-mode: Opus Approved + (Codex Approved OR usage limit) → AI may merge per `memory/feedback_auto_mode_merge_opus_judgment.md`).

---

## 12. Round history

- **Round 0 (this PR, 2026-05-16)** — initial draft. Decisions §0.1 #1-6 locked via Stage 2a PoC + dogfood evidence. Carry-over of Stage 2c trigger criteria + `compute_block_motion_vectors` deferral + ADR-019 §2.1 `shift?` docstring relaxation.
- **Round 1+** — Opus / Codex review iteration TBD.
