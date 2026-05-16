# ADR-019 Stage 2a sub-plan — Multi-frame ring buffer (observation-only telemetry)

- Status: **Draft (Round 0)** — initial sub-plan extraction from ADR-019 §4 Stage 2a
- Date: 2026-05-16
- Authors: Claude (Sonnet drafting)
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Predecessor PR: **PR #309** — ADR-019 MVP-1 (Stage 1 UIA `ScrollPercent` read-only observation), merged 2026-05-16 (`c196bbc`)
- Successor (conditional): Stage 2b sub-plan — only drafted after ≥ 30 dogfood telemetry confirms / refutes `changedFractions`-only gate sufficiency (ADR-019 §4 Stage 2b gate)
- G1 empirical result (2026-05-16): `uia_read_scroll_percent_at_hwnd({hwnd: '<excel-top>', axis: 'vertical' | 'horizontal'})` returns `null` for Excel `Book1 - Excel` foreground state, scroll-induced state, and post-scroll state. **NO branch confirmed** — Excel EXCEL7 does not expose `IUIAutomationScrollPattern` for reads via Phase A (ancestor walk) or Phase B (subtree DFS). Stage 1 produces `observation.source: "chain_trust_unverified"` for Excel; Stage 2a is the next observable upgrade.
- Walking-skeleton classification: **trunk** sub-plan for the temporal-observation primitive (the entire TMOL framework rests on multi-frame ring buffer existing — ADR-019 §2.2 "load-bearing architectural feature"). Stage 2b / 3 / 4 / 5 are expansion.

---

## 1. Context

### 1.1 Why Stage 2a now

ADR-019 Stage 1 (PR #309) added the canonical `observation` envelope hint with two values populated: `uia_scroll_percent` (read succeeded) and `chain_trust_unverified` (read failed). The 2026-05-16 G1 probe established that Excel — the largest concrete failure surface motivating the ADR — produces `chain_trust_unverified`. The same is expected for Word `_WwG`, PowerPoint canvas, OneNote canvas, and any custom-paint MDI receiver whose UIA tree does not lift `ScrollPattern` to an ancestor of EXCEL7-class leaves.

Without a visual-state observer, the post-PostMessage envelope says "delivered" with no evidence beyond chain-table membership. Stage 2a closes the *evidence* gap (not the *decision* gap) by adding a multi-frame ring buffer that captures `pre + post[k]` raw frames around the chunking loop and computes `computeChangeFraction(pre, post[k])` for each `k`. The result is attached to `observation.ringTelemetry` for empirical calibration — **no behaviour change in `verifyDelivery.status` / `.reason` / `.channel`**.

Stage 2a is the smallest possible PR that empirically validates the multi-frame thesis ("does temporal observation actually catch what single pre/post misses?") before any new algorithm work (Stage 2b block motion vectors, Stage 3 phase correlation, Stage 4 SSIM). The next stage's threshold and algorithm choice are data-calibrated from the telemetry Stage 2a produces.

### 1.2 Why ring buffer is "load-bearing"

ADR-019 §2.2 names the multi-frame ring buffer as the structural anti-fragile feature. Single pre/post is structurally weak against:

- **GPU staleness** — `PrintWindow(PW_RENDERFULLCONTENT)` returns a cached pre-paint frame for ~16-50 ms after the receiver processes the message; the post-paint appears only after the next DWM composition cycle.
- **Animation transients** — caret blink, marching-ants selection, hover effects, loading spinners introduce motion between pre and post that is not related to the dispatched action.
- **Incremental settle** — Excel's row-label strip repaints incrementally; a single `t = 30 ms` post-frame may catch a partial repaint that does not resemble the final state.

Reading at `t ∈ {30, 60, 120, 240} ms` lets later stages (2b / 3 / 4) implement the **dual-condition decision rule** (`motion_observed AND last_stable AND final_differs` — ADR-019 §2.2). Stage 2a does not yet apply the rule; it only captures the time-series.

### 1.3 Scope boundary (Stage 2a vs Stage 2b)

| Concern | Stage 2a (this sub-plan) | Stage 2b (future sub-plan) |
|---|---|---|
| Ring buffer capture | **yes** | reused |
| Per-frame diff algorithm | reuses existing `computeChangeFraction` (8×8 block SAD, SSE2) | adds `compute_block_motion_vectors` napi (16×16 SAD, AVX2) **only if** Stage 2a telemetry says simple `changedFractions` is insufficient |
| Decision rule (dual-condition) | **no** — telemetry only | yes — wires into chain-trust fallback as `delivered_via_postmessage` with `observation.source: "block_motion_vectors"` or upgraded `temporal_ring_observation_only` (depending on Stage 2a data) |
| `verifyDelivery.status / .reason / .channel` change | **no** | yes (the gate) |
| `observation.source` values added | `"temporal_ring_observation_only"` (already declared in §2.1 contract; Stage 1 left it undefined — Stage 2a is the first emitter) | `"block_motion_vectors"` (conditional) |
| Latency budget tier | temporal fallback (≤ 300 ms p99 end-to-end, AC6) | same |

---

## 2. Decision

Adopt a **chain-trust fallback ring buffer** that activates only when Stage 1 UIA observation returns `chain_trust_unverified` (i.e. `preUiaPercent === null` OR the post-read fell through). When activated, capture `preFrame` (raw image **before** the PostMessage chunking loop begins) plus `post[k]` raw frames at the schedule `[30, 60, 120, 240] ms` (ADR-019 §2.2 default) from the dispatch settle-end timestamp, compute `computeChangeFraction(preFrame, post[k])` per frame, and attach the result to `observation.ringTelemetry`.

### 2.1 Activation rule + time-base (precise — Round 1 P1-3)

The ring buffer fires iff:

1. The dispatcher took the chain-trust branch of `postWheelToHwnd` (`pre === null && retargetedByLeafWalker`), **AND**
2. The Stage 1 UIA observation returned `motion: "indeterminate"` with `source: "chain_trust_unverified"` (i.e. UIA percent read failed pre or post).

When the Stage 1 UIA observation succeeded (`source: "uia_scroll_percent"`), the ring buffer is **not** captured in Stage 2a. Rationale: avoid paying the ~280 ms temporal-fallback wall-clock when a 50 ms fast-path observation already exists. Stage 3 may revisit (cross-validation) but Stage 2a's scope is the chain-trust fallback only.

**Time-base (single canonical definition)** — three reference points along one wall-clock axis:

| Reference point | Symbol | When |
|---|---|---|
| Dispatch-pre (raw image captured **before** chunking loop) | `T_pre` | inside `postWheelToHwnd`, before the first `postMessage(...)` call |
| Settle-end (existing `POSTMESSAGE_SETTLE_MS = 16 ms` await completes) | `T_settle` | line `_input-pipeline.ts:824` `await setTimeout(POSTMESSAGE_SETTLE_MS)` resolved |
| Post-frame `k` (ring sample at offset `scheduleMs[k]` from `T_settle`) | `T_post[k]` | `T_settle + scheduleMs[k]` |

The ring schedule offsets are measured from `T_settle`, **not** from `T_pre` and **not** from the call start of `observeViaUiaOrChainTrust`. Rationale: `T_settle` is the point where the receiver has finished its first DWM composition cycle after the PostMessage queue drained; sampling earlier (e.g. from `T_pre`) would mix the chunking-loop duration into the schedule, which varies per `amount`. Sampling from `T_settle` keeps the schedule data-comparable across calls with different `amount` values.

The 16 ms `POSTMESSAGE_SETTLE_MS` await happens **before** `observeViaUiaOrChainTrust` is invoked, so the helper does not duplicate it. The first post-frame at `T_settle + 30 ms` is therefore **46 ms after the last `postMessage` call** in wall-clock terms (= 16 ms settle + 30 ms ring slot 0). Document this in code comment alongside the helper call site.

### 2.1.1 Helper API design (Round 1 P1-3 resolution)

To make the time-base unambiguous and avoid mis-using a single `captureMultiFrameRing` for two reference points (which was the Round 1 P1-3 ambiguity), Stage 2a splits the helper into **two** functions:

```ts
/** Single synchronous capture — used for the dispatch-pre reference frame (T_pre). */
export async function captureFrame(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
): Promise<RawFrame | null>;

/** Ring of post-frames at offsets from "now" (T_settle when called from chain-trust path). */
export async function capturePostFrameRing(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
  scheduleMs: number[],
): Promise<{
  post: Array<{ frame: RawFrame; offsetMs: number } | null>;  // null when an individual capture failed
  totalElapsedMs: number;
}>;
```

`RawFrame = { rawPixels: Buffer; width: number; height: number; channels: 3 | 4 }`.

The caller in `_input-pipeline.ts` becomes:

```ts
// inside postWheelToHwnd, BEFORE the chunking loop:
const preFrame = await captureFrame(effectiveHwnd, rect);  // ← T_pre

// ... existing chunking loop + POSTMESSAGE_SETTLE_MS await ...
// T_settle achieved.

// inside observeViaUiaOrChainTrust chain-trust fallback:
if (process.env.DESKTOP_TOUCH_STAGE2A_RING !== "0" && preFrame !== null) {
  const ring = await capturePostFrameRing(effectiveHwnd, rect, RING_SCHEDULE_MS);
  const changedFractions = ring.post
    .map((p) => (p === null ? NaN : computeChangeFraction(preFrame.rawPixels, p.frame.rawPixels, ...)));
  // ... build ringTelemetry per §2.2 ...
}
```

This makes `T_pre` and `T_settle` syntactically distinct: two different function calls at two different sites in the dispatcher.

### 2.2 Observation contract delta

`VisualMotionObservation` already declares `ringTelemetry?` (PR #309 Round 3 P3 — anticipating Stage 2a). Stage 2a is the first emitter; no new contract surface is added. The new `source` value `"temporal_ring_observation_only"` is also pre-declared in the §2.1 enum.

**Numeric-count semantics (Round 1 P2-1)** — `framesSampled` is the total count of raw captures attempted that contributed to telemetry:

- **Happy path**: `framesSampled = 5` = 1 pre (`T_pre`) + 4 post (`T_settle + 30/60/120/240 ms`); `changedFractions.length = 4`.
- **Partial path** (1-3 post frames failed): `framesSampled = 1 + N_successful_post` (range 2-4); `changedFractions.length = N_successful_post` (range 1-3).
- **Pre-only path** (every post-frame capture failed): `framesSampled = 1`; `changedFractions = []`; `maxChangedFraction = 0` (see §2.2 fallthrough rule below).
- **Degraded path** (pre-frame capture itself failed): ring is **not** attached; observation falls back to `chain_trust_unverified` per §2.2 fallthrough.

Stage 2a output shape when ring buffer captures (happy path example):

```ts
{
  motion: "indeterminate",                              // Stage 2a does not decide motion
  source: "temporal_ring_observation_only",
  framesSampled: 5,                                     // 1 pre + 4 post (happy path)
  totalElapsedMs: <wallclock of pre capture + 240ms settle + 4 captures + 4 diffs>,
  ringTelemetry: {
    framesSampled: 5,
    elapsedMsPerFrame: [<T_pre wallclock>, <T_settle+30>, <T_settle+60>, <T_settle+120>, <T_settle+240>],
    changedFractions: [<post[0] vs pre>, <post[1] vs pre>, <post[2] vs pre>, <post[3] vs pre>],
    maxChangedFraction: max(changedFractions),
  },
}
```

**Empty-array fallthrough rule** (Round 1 P2-3) — when `changedFractions` is empty (all post-frame captures failed but pre succeeded), `maxChangedFraction = 0` (not `Math.max(...[])` = `-Infinity`). This is a sentinel for "ring captured but no signal" and lets downstream telemetry aggregations skip NaN-handling.

When activation fails (e.g. window rect unavailable, pre-frame capture failed, schedule was empty), fall through to the existing `chain_trust_unverified` observation (no telemetry attached). Stage 2a is **strictly additive** — the chain-trust fallback path's existing envelope output remains identical when ring buffer cannot run.

### 2.3 Affected files (SSOT)

| File | Change | Surface |
|---|---|---|
| `src/engine/layer-buffer.ts` | export two new async functions per §2.1.1: `captureFrame(hwnd, region)` and `capturePostFrameRing(hwnd, region, scheduleMs)`; reuse existing `captureWindowRawWithFallback` + `computeChangeFraction` | TS engine |
| `src/tools/_input-pipeline.ts` | (a) call `captureFrame` at `T_pre` (before chunking loop in `postWheelToHwnd`); (b) call `capturePostFrameRing` at `T_settle` inside `observeViaUiaOrChainTrust` chain-trust branch; (c) emit `temporal_ring_observation_only` with `ringTelemetry` populated; (d) **no** changes to `verifyDelivery.status` / `.reason` / `.channel` | TS pipeline |
| `src/tools/_input-pipeline.ts` (constants) | add `RING_SCHEDULE_MS = [30, 60, 120, 240]` and `RING_WALLCLOCK_BUDGET_MS = 290` (= `max(RING_SCHEDULE_MS) + 50` safety; Round 1 P3-2 reconciliation — the constant equals the stop-condition expression in §3 Phase 1 P1-3, no two competing numbers) | constant SSOT |
| `tests/unit/temporal-ring-buffer.test.ts` | **new** unit test suite — 6 cases per §3 Phase 3 P3-1 | test |
| `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` §10 OQ 1 | mark as **Resolved 2026-05-16: G1 probe NO, Stage 2a activated** + link to this sub-plan | docs sync |
| `docs/adr-018-input-pipeline-3tier.md` §2.6 envelope reference | **Round 1 P1-2 fix**: convert the in-paragraph 8-value `observation.source` enum (line 165) into an explicit bullet/table list that includes `temporal_ring_observation_only`, and add Stage 2a as the first emitter beyond Stage 1 (CLAUDE.md §3.1 multi-table sweep enforceable in lockstep with ADR-019 §2.1 + `_input-pipeline.ts:VisualMotionObservation`) | docs sync |
| `benches/tmol_stage_2a_ring_telemetry.mjs` | **new** dogfood bench — drives ≥ 30 scroll cycles against Excel + Word + Notepad + Explorer + 1 custom-paint app and prints the per-app `maxChangedFraction` distribution + wall-clock | bench |

Stage 2a does **not** touch: `src/uia/scroll.rs`, `src/pixel_diff.rs`, any new Rust module, `src/tools/mouse.ts`'s public surface (the `ScrollVerifyOutcome` already carries `observation?` through from PR #309), `index.d.ts` (the `VisualMotionObservation` shape is a runtime TS envelope hint produced by the dispatcher — it is **not** a napi binding type and has no presence in `index.d.ts` by design; see §5 R10 for the rationale and the resolution of Round 1 P1-2 G2a-5 vacuous wording).

### 2.4 Latency budget reconciliation (ADR-019 AC6)

- Fast path (Stage 1 UIA success): unchanged, p99 ≤ 50 ms wall-clock. Stage 2a does not run here.
- Temporal fallback (Stage 2a activated): p99 ≤ 300 ms end-to-end. Composition:
  - 240 ms ring schedule (max)
  - +1 pre capture (~5-10 ms)
  - +4 post captures (~5-10 ms each)
  - +4 `computeChangeFraction` diffs (~2-5 ms each on 1080p with SSE2 SIMD)
  - = ~280 ms p99 worst case → fits AC6 ≤ 300 ms with margin
- Compute-only umbrella per call (AC6): unchanged 70 ms umbrella. Stage 2a adds ~30 ms compute (4 diffs × ~5 ms + 1 ring overhead) — well under the umbrella.

A `benches/tmol_stage_2a_ring_telemetry.mjs` smoke run asserts the wall-clock budget is met on the dogfood machine; the unit tests use a fake clock to exercise the schedule without paying the wall-clock.

---

## 3. Implementation plan (phase checklist)

**Phase dependency notes (Round 1 P2-5)** — phases are sequential per their dependencies:

- Phase 1 (helpers in `layer-buffer.ts`) **must** land before Phase 2 (`_input-pipeline.ts` wiring) compiles.
- Phase 2 (wiring) **must** land before Phase 3 (unit tests) since the test mocks target `_input-pipeline.ts` import paths.
- Phase 3 (unit tests) **must** land before Phase 4 (bench) — bench depends on the dispatcher emitting `ringTelemetry`.
- Phase 5 (docs sync) can land in parallel with Phase 2-3 (same PR commit).
- Phase 6 (dogfood) **must** land after Phase 4 bench file exists.

This is one PR that lands all six phases together; dependency order is the **commit order within the PR** so each commit can be tested green. The PR description maps commits to phases.

### Phase 1 — `captureFrame` + `capturePostFrameRing` helpers (Round 1 P1-3 split)

- [ ] **P1-1** — Read `src/engine/layer-buffer.ts:9-150` to confirm `captureWindowRawWithFallback` signature (returns `{ rawPixels, width, height, channels }`).
- [ ] **P1-2** — Add **two** exported async functions (per §2.1.1) to `src/engine/layer-buffer.ts`:
  ```ts
  export type RawFrame = {
    rawPixels: Buffer; width: number; height: number; channels: 3 | 4;
  };

  /** Single synchronous capture — used for the dispatch-pre reference frame (T_pre). */
  export async function captureFrame(
    hwnd: bigint,
    region: { x: number; y: number; width: number; height: number },
  ): Promise<RawFrame | null>;

  /** Ring of post-frames at offsets from "now" (T_settle when called from chain-trust path). */
  export async function capturePostFrameRing(
    hwnd: bigint,
    region: { x: number; y: number; width: number; height: number },
    scheduleMs: number[], // monotonically increasing offsets, measured from the helper call start (= T_settle when called from the chain-trust path; the helper does not embed timing knowledge about the dispatcher's settle wait)
  ): Promise<{
    post: Array<{ frame: RawFrame; offsetMs: number } | null>;
    totalElapsedMs: number;
  }>;
  ```
  **Note (Round 2 P2-A clarification)**: the `scheduleMs` comment uses "helper call start" because the helper itself measures `performance.now()` from its own call instant. The caller's choice to invoke this helper at `T_settle` (chain-trust path) is what makes the helper's call-start coincide with `T_settle`. The helper has no other knowledge of the dispatch timeline — keeping the contract caller-agnostic so future callers (e.g. Stage 4 click-verify) can use it at any reference point.
- [ ] **P1-3** — Internal behaviour for `capturePostFrameRing`:
  - For each `offset` in `scheduleMs`: schedule the capture using **absolute deadlines** (`const start = performance.now(); for each offset → await sleepUntil(start + offset)`) to avoid cumulative `await setTimeout` drift. (Round 1 P1-3: deadline-based scheduling keeps `T_post[k]` accurate even when individual captures stretch into the next slot.)
  - On individual capture failure, push `null` to `post[]` (do not throw — caller decides whether telemetry is partial-acceptable).
  - Wall-clock guard: if `performance.now() - start` exceeds `Math.max(...scheduleMs) + 50 ms` (computed from the caller-supplied schedule at runtime), stop scheduling further frames and return what was captured. **Round 2 P2-B contract clarification**: the helper computes the budget from the actual `scheduleMs` it received; the `RING_WALLCLOCK_BUDGET_MS = 290` constant in `_input-pipeline.ts` is the caller's pre-computed value for the default `RING_SCHEDULE_MS = [30, 60, 120, 240]`. When a future caller passes a different `scheduleMs`, the helper's runtime guard stays correct without depending on the caller's constant.
- [ ] **P1-4** — Export both functions and `RawFrame` from `layer-buffer.ts`; confirm zero TypeScript build break with `npm run build`.

### Phase 2 — Wire into `postWheelToHwnd` + `observeViaUiaOrChainTrust`

- [ ] **P2-1** — In `src/tools/_input-pipeline.ts`, add constants near the existing `UIA_PRE_READ_TIMEOUT_MS` / `POSTMESSAGE_SETTLE_MS` constants (~lines 86-130):
  ```ts
  const RING_SCHEDULE_MS = [30, 60, 120, 240] as const;
  const RING_WALLCLOCK_BUDGET_MS = Math.max(...RING_SCHEDULE_MS) + 50;  // = 290
  ```
- [ ] **P2-2** — In `postWheelToHwnd`, BEFORE the chunking loop (`_input-pipeline.ts:~790` per current main), call `const preFrame = process.env.DESKTOP_TOUCH_STAGE2A_RING !== "0" ? await captureFrame(effectiveHwnd, getWindowRectByHwnd(effectiveHwnd) ?? null) : null;` Guard against null rect (window minimised / unmeasurable) by treating as "no Stage 2a ring this call".
- [ ] **P2-3** — Thread `preFrame` into `observeViaUiaOrChainTrust` as an optional parameter (along with the rect already required for the ring call).
- [ ] **P2-4** — In `observeViaUiaOrChainTrust`, when the function is about to return `chain_trust_unverified` (UIA pattern not exposed OR post-read failed) **AND** `preFrame !== null` **AND** rect supplied **AND** `RING_SCHEDULE_MS.length > 0`:
  - call `capturePostFrameRing(hwnd, rect, RING_SCHEDULE_MS)`
  - compute `changedFractions[k] = computeChangeFraction(preFrame.rawPixels, post[k].frame.rawPixels, ...)` for each successful post-frame
  - skip null post-frames (filter them out before computing `maxChangedFraction`)
  - if the filtered array is empty, set `maxChangedFraction = 0` (§2.2 fallthrough rule)
  - **Round 2 P2-C aggregate responsibility**: the caller (this function, `observeViaUiaOrChainTrust`) is responsible for assembling the `framesSampled` count as `1 + post.filter((p) => p !== null).length` — the `+1` accounts for the pre-frame captured upstream at `T_pre` (not in the helper's return shape). The helper's `post` array length is the post-capture attempt count, which may be less than `scheduleMs.length` if the wall-clock guard tripped; the caller therefore counts successful entries explicitly.
  - attach `ringTelemetry` to the observation and switch `source` to `temporal_ring_observation_only` (keeps `motion: "indeterminate"` because Stage 2a does not decide)
- [ ] **P2-5** — If `capturePostFrameRing` itself throws / returns zero post-frames AND every post is null, fall back to `chain_trust_unverified` (no `ringTelemetry`, additive zero-loss).
- [ ] **P2-6** — Stage 1 success path (`uia_scroll_percent`) — **do not** capture ring; Stage 2a's scope is fallback-only.
- [ ] **P2-7** — Feature toggle: `DESKTOP_TOUCH_STAGE2A_RING=0` disables both the `T_pre` and `T_settle` capture sites (default ON). Before adding inline `!== "0"`, **grep first** for an existing boolean parser: `Grep "parseBool\|parseBoolean\|parseEnvBool" src/` — if a helper exists (memory references `DESKTOP_TOUCH_AUTO_GUARD=0` and similar in `feedback_pre_v0_12_e2e_autoguard.md`), reuse it; otherwise inline `process.env.DESKTOP_TOUCH_STAGE2A_RING !== "0"` (default ON) is acceptable. Round 2 P3-A note.

### Phase 3 — Unit tests

- [ ] **P3-1** — `tests/unit/temporal-ring-buffer.test.ts` — 6 cases:
  - (a) UIA returns valid percent delta → observation `source: "uia_scroll_percent"`, NO `ringTelemetry`.
  - (b) UIA returns null pre **and** Stage 2a captures → ring attached, `source: "temporal_ring_observation_only"`, `ringTelemetry.framesSampled === 5` (1 pre + 4 post), `changedFractions.length === 4`.
  - (c) UIA post-read times out **and** Stage 2a captures → same observation shape as (b).
  - (d) Ring capture throws → observation falls back to `chain_trust_unverified`, no `ringTelemetry`.
  - (e) Partial ring (1 of 4 post-frames captured, 3 failed) → `framesSampled === 2` (1 pre + 1 post), `changedFractions.length === 1`, `maxChangedFraction === changedFractions[0]`.
  - (f) Env `DESKTOP_TOUCH_STAGE2A_RING=0` → neither `captureFrame` nor `capturePostFrameRing` is invoked; observation stays `chain_trust_unverified`. Pre-frame capture site at `T_pre` is also skipped.
- [ ] **P3-2** — Use a fake clock (vitest `vi.useFakeTimers()`) so the suite runs in milliseconds, not 240 ms × 6 cases.
- [ ] **P3-3** — Mock `captureFrame` and `capturePostFrameRing` at the import boundary (vitest module mock on `src/engine/layer-buffer.ts`); do **not** actually capture screen pixels in the unit suite.

### Phase 4 — Bench harness

- [ ] **P4-1** — **Empirical floor measurement first (Round 1 P2-6)**: before the per-app loops, run a standalone `captureWindowRawWithFallback` p99 measurement on the dogfood machine (≥ 30 calls against an idle Notepad). Write the p99 floor into the bench output header. This replaces R1's hand-cited "~50 ms" with an actual measurement; the wall-clock budget comparison in G2a-3 uses this floor + ring schedule to compute headroom.
- [ ] **P4-2** — `benches/tmol_stage_2a_ring_telemetry.mjs` (new file). Drives a real `scroll(action='raw', windowTitle:'<target>', direction:'down', amount:10, include:['envelope'])` round-trip for:
  - Excel `Book1 - Excel`
  - Word `Document1 - Word` (or empty doc title)
  - Notepad `無題 - メモ帳`
  - Explorer (`Window class CabinetWClass`, any open folder)
  - 1 user-supplied custom-paint canvas (e.g. Paint.NET, Photoshop, Blender — `--target-title` CLI arg)
- [ ] **P4-3** — For each target, run ≥ 30 cycles: scroll → read envelope → record `observation.ringTelemetry.maxChangedFraction` + wall-clock. Also run ≥ 10 "no-op" baselines per the OQ #4 resolution: `--baseline=idle` (capture-only, no scroll) is the primary; `--baseline=round-trip` (scroll then immediately reverse scroll, both via `amount: 10`) is the secondary. **Do not** offer `amount: 0` — Zod `.positive()` at `src/tools/scroll.ts:33` rejects it (Round 1 P1-1 resolution).
- [ ] **P4-4** — Print per-app distribution stats (p50 / p90 / p99 of `maxChangedFraction` for real scrolls vs no-ops) and wall-clock p99. Document the operator note that the user must trigger focus / scrolling manually if the bench cannot induce.
- [ ] **P4-5** — Acceptance gate: real-scroll `maxChangedFraction` p50 ≥ 5 × no-op p50 across **at least 3 of 5** target apps. Excel + Word are mandatory (the original motivation); other 3 are tie-breakers. If gate fails → Stage 2b drafts with `compute_block_motion_vectors` napi; if gate passes → Stage 2b drafts with `changedFractions` reused as the gate (no new algorithm).

### Phase 5 — Docs sync (CLAUDE.md §3.1 sweep)

- [ ] **P5-1** — Update `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` §10 OQ 1 with G1 result + link to this sub-plan.
- [ ] **P5-2** — **Round 1 P1-2 fix**: convert the in-paragraph 8-value `observation.source` enum at `docs/adr-018-input-pipeline-3tier.md:165` into a bullet list (or table-row format consistent with §2.6.1 / §2.6.2 around it) so the enum is machine-greppable in lockstep. Add a row / bullet describing `temporal_ring_observation_only` as "Stage 2a chain-trust fallback telemetry; sibling to `chain_trust_unverified` per ADR-019 Stage 2a sub-plan §2.1".
- [ ] **P5-3** — Grep sweep: `Grep "observation.source\|VisualMotionObservation" docs/ src/` — confirm the **canonical 3-surface sync set** (ADR-019 §2.1 contract, `_input-pipeline.ts:VisualMotionObservation`, ADR-018 §2.6 envelope reference) has the 8 values identically. `index.d.ts` is **out of the sync set by design** (§5 R10). Record the grep output in the PR description with line-by-line proof of the enum's identity across the 3 surfaces (Round 1 P2-2: the claim is no longer free-form — the PR description shows the grep result so the next reviewer can reproduce).
- [ ] **P5-4** — Grep sweep: `Grep "ringTelemetry" docs/ src/` — confirm the field is documented identically across (a) ADR-019 §2.1, (b) `_input-pipeline.ts`, (c) this sub-plan §2.2.

### Phase 6 — Dogfood + Stage 2b gate decision

- [ ] **P6-1** — Run the bench harness on the dogfood machine. Record telemetry distributions in `docs/adr-019-stage-2a-dogfood-results.md` (new file, persistent per CLAUDE.md §9: residual / pending observations belong in `docs/`, not memory). **Round 2 P3-B reminder**: also re-capture the current `npm test` baseline pass count at this point (instead of relying on the 2548 figure from `memory/project_adr010_p1_s5_impl_done.md` 2026-05-01 which may have drifted); record both pre-Stage-2a and post-Stage-2a baselines in the dogfood report.
- [ ] **P6-2** — Apply Stage 2b gate (§3 Phase 4 P4-5). Update ADR-019 §4 Stage 2b acceptance with the data-calibrated decision.
- [ ] **P6-3** — Open Stage 2b sub-plan PR if gate passes either way (just with different algorithm scope).

---

## 4. Acceptance criteria

- **G2a-1 (functional)** — When Stage 1 UIA observation returns `chain_trust_unverified` AND `DESKTOP_TOUCH_STAGE2A_RING ≠ 0`, the envelope hint contains `observation.source: "temporal_ring_observation_only"` with `ringTelemetry.framesSampled >= 1` and `ringTelemetry.changedFractions.length >= 1`.
- **G2a-2 (no regression)** — Pre-existing `chain_trust_unverified` behaviour preserved when ring capture fails: `verifyDelivery.status`, `.reason`, `.channel` are bit-identical to PR #309 output.
- **G2a-3 (latency budget)** — `tmol_stage_2a_ring_telemetry.mjs` reports wall-clock p99 ≤ 300 ms across 30 Excel + 30 Word cycles. Compute-only umbrella ≤ 70 ms per call.
- **G2a-4 (telemetry discrimination)** — Across ≥ 30 dogfood cycles per app (Excel + Word mandatory + 3 of {Notepad, Explorer, custom-paint canvas}), real-scroll `maxChangedFraction` p50 ≥ 5 × no-op `maxChangedFraction` p50 in at least 3 of 5 apps. Telemetry written to `docs/adr-019-stage-2a-dogfood-results.md`.
- **G2a-5 (CLAUDE.md §3.1 sweep — Round 1 P1-2 tightened)** — All 8 enum values in `observation.source` appear identically in the canonical 3-surface sync set: (a) ADR-019 §2.1, (b) `_input-pipeline.ts:VisualMotionObservation`, (c) ADR-018 §2.6 envelope reference. `index.d.ts` is **explicitly out of scope** per §5 R10 — `VisualMotionObservation` is a TS-only envelope hint shape with no napi binding. The "(d)" surface from the Round 0 draft is removed because the parenthetical "if re-exported" rendered the acceptance vacuous; Round 1 makes the 3-surface set non-vacuous + machine-verifiable. Grep output recorded in PR description per Phase 5 P5-3.
- **G2a-6 (Stage 2b gate decision recorded)** — `docs/adr-019-stage-2a-dogfood-results.md` includes a final paragraph stating whether Stage 2b ships with `changedFractions` reuse or `compute_block_motion_vectors` introduction, with the telemetry distribution that justified the choice.

---

## 5. Risks

- **R1 — Capture latency spikes on slow disks / RDP (Round 1 P2-6 sourcing fix)**: `captureWindowRawWithFallback` (see `src/engine/layer-buffer.ts:126-145` for the `PrintWindow` → BitBlt fallback chain) can stretch on first-call DWM warm-up and on RDP. No empirical p99 floor exists in the current codebase. Stage 2a's `benches/tmol_stage_2a_ring_telemetry.mjs` runs a **standalone `captureWindowRawWithFallback` floor measurement (Phase 4 P4-1)** as the first step, replacing the original draft's hand-cited "~50 ms" anchor with an actual p99 number that feeds the headroom calc. Worst-case upper bound (paper estimate): 5 captures × (measured floor) + 240 ms settle. Mitigations: (a) bench measures + reports; (b) env toggle `DESKTOP_TOUCH_STAGE2A_RING=0` is the user escape hatch; (c) Stage 2b can shorten / adapt the schedule based on Stage 2a data.
- **R2 — `computeChangeFraction` 8×8 macro pattern collapse (PR #308 lesson)**: Excel's cell grid is byte-identical at 8×8 dHash level after a 3-notch scroll (commit `926c69b` revert note). The block-SAD `computeChangeFraction` is **different** — it operates on raw pixel block differences with `NOISE_THRESHOLD = 16`, not perceptual hash. The 2026-05-16 PR #308 dogfood note records "raw byte diff 0.36 %" — that's exactly what `computeChangeFraction` captures. Stage 2a's risk is that 0.36 % per-block diff fraction is close to no-op noise floor → telemetry discriminator may be marginal. The G2a-4 gate verifies this empirically; the data feeds Stage 2b's algorithm choice. **Cross-reference**: `memory/feedback_dhash_macro_pattern_limit.md` is the cautionary tale; `pixel_diff.rs::compute_change_fraction` is the different baseline.
- **R3 — Animation transients distort `maxChangedFraction`**: caret blink at ~500 ms cycle + 240 ms ring → caret-blink may toggle once during the ring → adds spurious changed-block fraction. Stage 2a does not gate on this; the telemetry exposes it for Stage 2b's dual-condition rule to handle. Document in dogfood report.
- **R4 — `getWindowRectByHwnd` returns full window rect; receiver area is smaller**: for Excel, the EXCEL7 cell-grid area is a sub-rect of the XLMAIN top-level. Capturing the full window includes the ribbon (~150 px) and status bar (~30 px), which dilutes the changed-fraction signal. Stage 2a uses the full window rect for simplicity; Stage 2b can refine to the leaf-rect via `find_scroll_leaf_for_top_level` (PR #307) if data calls for it.
- **R5 — Concurrent `scroll(...)` calls share the ring buffer state**: there is no concurrency; the chain-trust path is synchronous within `observeViaUiaOrChainTrust`. The ring capture awaits sequentially. No shared state.
- **R6 — Env toggle drift**: `DESKTOP_TOUCH_STAGE2A_RING=0` semantics must match the existing `DESKTOP_TOUCH_*` envvar conventions (boolean parser). Reuse `parseBoolEnv` helper if exists; otherwise inline `=== "0"` check (default ON).
- **R7 — CLAUDE.md §3.2 carry-over scope shrink (Round 1 P2-2 reproducible)**: Stage 2a adds `temporal_ring_observation_only` source value; the contract's 8-value enum was pre-declared in PR #309 §2.1 with this value already listed. Stage 2a is the first emitter — no enum surface change. Existing callers that read `observation.source` and `switch` on it MUST handle the new value (or fall through default) without crashing. **Verified 2026-05-16 by `Grep "switch.*\\.source|case ['\\\"](uia_scroll_percent|chain_trust_unverified|temporal_ring)" src/ tests/`** → zero exhaustive `switch` statements on `VisualMotionObservation.source`; only field-reads exist in `mouse.ts` envelope passthrough at `src/tools/mouse.ts:1336-1337`. Round 1 P2-2 reviewer can rerun the same grep to reproduce.
- **R8 — Bench cannot reliably induce real scroll on every app**: nutjs alt+tab + scroll dispatch may fail on apps with non-standard focus models. Document operator note for manual trigger; bench `--no-induce` mode.
- **R9 — `walking-skeleton-trunk-selection.md` trunk classification cross-ref**: Stage 2a is classified "trunk" in this sub-plan's preface metadata; the canonical walking-skeleton selection rationale lives in `docs/walking-skeleton-trunk-selection.md` (the ADR-008 D2 walking-skeleton trunk document). Stage 2a's "trunk" claim here is because it lands the foundational temporal-observation primitive that Stage 2b / 3 / 4 / 5 depend on. (Round 1 P3-1 cross-reference fix.)
- **R10 — `index.d.ts` out-of-sync-by-design (Round 1 P3-3)**: `VisualMotionObservation` is a TypeScript-only envelope hint shape produced by the dispatcher in `_input-pipeline.ts`; it is not a napi binding type and has no presence in `index.d.ts` by design. The `index.d.ts` file is hand-maintained per ADR-019 §3 SSOT table only for native bindings (e.g. `uiaReadScrollPercentAtHwnd`). Including `VisualMotionObservation` in `index.d.ts` would imply a Rust counterpart that does not exist. Result: `index.d.ts` is **explicitly removed from the §3.1 sync set** (see G2a-5 fix); the canonical sync set is the 3 surfaces ADR-019 §2.1 / `_input-pipeline.ts` / ADR-018 §2.6.

---

## 6. Open questions

1. **Optimal ring schedule** — `[30, 60, 120, 240]` is ADR-019 §2.2's starting default. Stage 2a's dogfood data may show that 240 ms is excessive for Excel (settle is faster) or insufficient for Word (slower MFC paint). **Resolution**: Stage 2a ships the default; per-app calibration is a Stage 2b carry-over.
2. **Capture region — full window vs leaf rect** — see R4. Stage 2a uses full window. **Resolution**: defer to Stage 2b based on telemetry signal quality.
3. **`maxChangedFraction` vs `changedFractions[-1]`** — should the discriminator be the max over the ring, or the last frame's fraction? Max favours catching transients (caret blink) as false positives; last-frame favours the dual-condition rule (motion observed AND last-stable AND final-differs). **Resolution**: Stage 2a emits both via the `changedFractions[]` array; Stage 2b decides which to gate on.
4. **No-op baseline definition** — how do we measure a "no-op" scroll for the gate? Options reconsidered (Round 1 P1-1 fix): (a) `scroll(amount: 0)` — **rejected**: `src/tools/scroll.ts:33` declares `amount: z.coerce.number().int().positive().default(3)` and `.positive()` rejects 0 with a Zod validation error before the dispatcher runs. Picking option (a) would crash the bench harness with zero telemetry recorded. (b) scroll-then-immediately-reverse-scroll (round trip via `amount: 10` both ways); (c) capture two pre frames with no scroll between (no scroll dispatch at all). **Resolution (Round 1)**: bench supports (b) and (c) — exposed as `--baseline=round-trip` and `--baseline=idle`; `--baseline=idle` is the **primary** (measures `captureMultiFrameRing` noise floor) and `--baseline=round-trip` is the **secondary** (measures whether opposing scrolls cancel visually). The (a) `amount: 0` option is removed from the plan and from `--baseline` choices.
5. **Custom-paint canvas choice for the 5th target** — Paint.NET, Photoshop, Blender, OBS, GPU games. **Resolution**: user picks at bench-run time; the bench accepts `--target-title` and reads ≥ 30 cycles.
6. **`temporal_ring_observation_only` is `indeterminate` motion** — should it imply degraded `confidence`? Stage 1's `chain_trust_unverified` already returns `confidence: "degraded"` via the envelope wrapper. Stage 2a inherits this. **Resolution**: no change to confidence semantics in Stage 2a; Stage 2b will define `motion: "translation"` confidence levels.

---

## 7. Dependencies / sequencing

- **Blocks**: nothing (Stage 2a is observation-only; Stage 2b waits on Stage 2a data but is in a separate PR).
- **Blocked by**:
  - PR #309 (ADR-019 MVP-1, merged `c196bbc`) — provides the `VisualMotionObservation` contract surface and the `observeViaUiaOrChainTrust` extension point.
  - `captureWindowRawWithFallback` in `src/engine/image.ts` (existing, used by `layer-buffer.ts`) — the capture primitive.
  - `computeChangeFraction` in `src/engine/layer-buffer.ts` (existing, SSE2 SIMD via `pixel_diff.rs`) — the diff primitive.
- **Walking-skeleton classification**: trunk (per §0 preface metadata). Canonical walking-skeleton trunk-selection rationale: `docs/walking-skeleton-trunk-selection.md` — Stage 2a lands the foundational temporal-observation primitive that Stage 2b / 3 / 4 / 5 depend on, so it is on the critical path (trunk) rather than parallelisable expansion. (Round 1 P3-1 cross-reference.)
- **Successor**: Stage 2b sub-plan (drafted only after Stage 2a's dogfood report).

---

## 8. North-star reconciliation (CLAUDE.md §3 / `memory/feedback_north_star_reconciliation.md`)

The TMOL framework's load-bearing thesis (ADR-019 §2.2, user-named "観測の時間軸をサーバに持ち込む") is that **temporal observation is the foundational primitive — new algorithms are downstream of it**. Stage 2a is the smallest concrete step that lands the foundational primitive without committing to a specific algorithm (Stage 2b block motion / Stage 3 phase correlation / Stage 4 SSIM) before the data is in. Skipping Stage 2a — e.g. by directly shipping `compute_block_motion_vectors` — would be pivot away from this north-star: it would commit to a new algorithm before knowing whether the simpler `computeChangeFraction` reuse handles 80 % of cases.

Stage 2a is therefore aligned with the north-star: it lands the ring buffer (foundational) and defers algorithm choice (downstream).

---

## 9. Test plan summary

- **Unit (6 cases)**: §3 Phase 3 P3-1 list. `vitest tests/unit/temporal-ring-buffer.test.ts`. Fake clock; mocked `captureMultiFrameRing` for IO determinism.
- **Integration (existing suite)**: regression sweep — no existing test should change behaviour because Stage 2a is additive. Verify `npm test` reports zero new failures vs `main` baseline (currently 2548 pass / per memory `project_adr010_p1_s5_impl_done.md`).
- **Bench / dogfood**: §3 Phase 4 P4 list. `node benches/tmol_stage_2a_ring_telemetry.mjs --target-title "..." --cycles 30`. Output written to `docs/adr-019-stage-2a-dogfood-results.md`.
- **Manual dogfood**: post-merge, run a `scroll(action='raw', windowTitle:'Book1 - Excel', direction:'down', amount:10, include:['envelope'])` and assert envelope contains `observation.source: "temporal_ring_observation_only"` and `ringTelemetry.changedFractions` is a non-empty array.

---

## 10. References

- Parent: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Predecessor PR: #309 (commit `c196bbc`, merged 2026-05-16) — Stage 1 MVP-1
- Sibling docs:
  - `docs/adr-018-input-pipeline-3tier.md` §2.6 — envelope `observation` reference
  - `docs/adr-018-phase-5-followup-verification-pathway-analysis.md` — A / B / C / A2 audit trail
- Memory cross-references:
  - `memory/feedback_dhash_macro_pattern_limit.md` — PR #308 revert lesson (8×8 macro patterns collapse on Excel cell grid) — informs R2.
  - `memory/feedback_north_star_reconciliation.md` — pivot-check rationale (§8).
  - `memory/feedback_dogfood_before_release_for_destination_explicit_io.md` — operator-induced dogfood pattern (Stage 2a bench reuses).
- CLAUDE.md sections enforced:
  - §3 (Opus + Codex review loop) — this sub-plan PR is a Phase-boundary plan; Opus mandatory + Codex strongly recommended (production-code follow-up PR mandates Codex per §3.3 Step 0).
  - §3.1 (multi-table fact sweep) — §3 Phase 5 P5-3 / P5-4 grep step.
  - §3.2 (carry-over scope shrink) — R7 grep check.
  - §3.3 (PR review loop) — §11 review workflow.
  - §3.4 (Background agent parallelism) — bench harness execution can be parallelised across worktrees if needed.
  - §7 (mechanism over memory) — env toggle + bench gate are the durable mechanisms.
  - §9 (residuals in docs not memory) — dogfood results land in `docs/adr-019-stage-2a-dogfood-results.md`.

---

## 11. Review workflow (CLAUDE.md §3.3)

- **Step 0** — Classification: docs / plan PR with a small follow-up production-code PR. The **plan PR** (this file) requires Opus mandatory + Codex strongly recommended (Phase B PR #161 lesson — Phase-boundary plan PRs catch API-contract surface drift Opus misses).
- **Step 1** — Opus phase-boundary review with explicit § 3.1 + § 3.2 sweep + Lesson 1-4 sweep. Prompt MUST include:
  - "code 変更しないでください、レビューのみ"
  - read this sub-plan + parent ADR-019 + ADR-018 §2.6
  - § 3.1 sweep: `observation.source` enum across 4 surfaces
  - § 3.2 sweep: ring buffer activation as additive only (no existing path broken)
  - Lesson 1-4 sweep: causal window / compile-time guard / ordering / numeric-count sync
  - P1 / P2 / P3 classification + file:line citation
  - Report < 800 words
  - Round N marker
- **Step 2** — Codex re-review via `@codex review` (Phase-boundary plan PR; PR #161 lesson recommended escalation).
- **Step 3** — Iterate to P1 = 0. 1 commit per round; message includes "Round N findings apply".
- **Step 4** — User reviewer Lesson 1-4 final sweep window.
- **Step 5** — Merge (auto-mode: Opus Approved + Codex Approved/no-comment → AI may merge per `memory/feedback_auto_mode_merge_opus_judgment.md`).

The production-code follow-up PR (Phase 1-4 implementation) is a **separate PR** drafted after this sub-plan lands. That PR runs the same §3.3 loop with Codex **mandatory** (production-code改修).
