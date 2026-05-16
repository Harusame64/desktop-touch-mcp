# ADR-019 Stage 2b dogfood results — TMOL decision gate confirmed on Excel chain-trust

- Date: 2026-05-16
- Predecessor PRs:
  - PR #309 (`c196bbc`) — ADR-019 MVP-1 Stage 1 contract
  - PR #311 (`0063ee3`) — Stage 2a impl (temporal ring + strip telemetry, observation-only)
  - PR #312 (`d9278a7`) — Stage 2a dogfood (`docs/adr-019-stage-2a-dogfood-results.md`)
  - PR #313 (`bc48485`) — Stage 2b sub-plan
  - PR #315 (`b69d495`) — Stage 2b sub-plan retro-review follow-up (P-tasks P10/P11)
  - PR #317 (`2c6da40`) — Stage 2b impl (this report dogfoods that PR)
- Bench harness: `benches/dogfood_stage_2b.mjs` (new, Stage 2b-aware extension of `benches/poc_stage_2a_causal_strip.mjs`)
- Raw outputs: `docs/adr-019-stage-2b-dogfood-raw/{excel-real-down-30,excel-boundary-up-30,excel-boundary-up-5-stage2b-off,excel-boundary-up-5-stage2a-off,word-boundary-up-5}.txt`

**TL;DR**: Stage 2b's load-bearing **`delivered` → `not_delivered` status flip on TMOL-observed silent drop** works end-to-end on a deterministic Excel reproduction (boundary scroll-up at row A1). Real Excel scrolling is bit-equal to PR #312 (no regression). Both env opt-outs (`DESKTOP_TOUCH_STAGE2B_GATE=0` and `DESKTOP_TOUCH_STAGE2A_RING=0`) preserve prior-stage behaviour exactly. Word's chain-trust is structurally unreachable (per Stage 2a dogfood §3-4) so Stage 2b is regression-free there as well.

---

## 1. Sample sizes

| Scenario | App | Cycles | Stage 2a env | Stage 2b env | Purpose |
|---|---|---|---|---|---|
| Real scroll-down | Excel `Book1` (`XLMAIN`) | 30 | default ON | default ON | regression vs PR #312 (delivered, no change in wire-level output) |
| Boundary scroll-up at A1 | Excel `Book1` (`XLMAIN`) | 30 | default ON | default ON | silent-drop natural synthesis — Stage 2b flips status to `not_delivered` |
| Boundary scroll-up at A1 | Excel `Book1` (`XLMAIN`) | 5 | default ON | **`0` (gate off)** | G2b-4: Stage 2a behaviour preserved when only the gate is disabled |
| Boundary scroll-up at A1 | Excel `Book1` (`XLMAIN`) | 5 | **`0` (ring off)** | default ON | G2b-5: Stage 1 behaviour preserved when no ring is captured |
| Boundary scroll-up | Word `文書 1` (`OpusApp`) | 5 | default ON | default ON | structural inheritance from Stage 2a dogfood — Tier 1 UIA dominates, chain-trust unreached |

75 Excel cycles + 5 Word cycles = 80 cycles total.

---

## 2. Excel real scroll-down — no regression vs PR #312

30 cycles, fresh from A1, `direction=down`, `notch=3`, default env (both Stage 2a + Stage 2b on).

| Metric | Value |
|---|---|
| `DispatchOutcome.scrolled` | `true` × 30 (= 30 / 30) |
| `DispatchOutcome.reason` | `delivered_via_postmessage` × 30 |
| `DispatchOutcome.channel` | `postmessage` × 30 |
| `observation.motion` | **`translation` × 30** (Stage 2b promotion of Stage 2a's hardcoded `indeterminate`) |
| `observation.source` | `temporal_ring_observation_only` × 30 |
| `ringTelemetry.finalChangedFraction` p50 / p90 / p99 | 0.007 / 0.009 / **0.023** (PR #312 baseline: 0.005 / 0.006 / 0.015 — within noise; both well above 0) |
| `finalChangedFraction > 0` count | **30 / 30 (100 %)** — gate predicate passes universally |
| `ringTelemetry.stableReached` | `true` × 30 |
| Bench-measured dispatch wallclock p50 / p90 / p99 | 465 / 496 / **498 ms** (< AC6 700 ms budget) |

**Interpretation**: Stage 2b is regression-free on the real Excel scroll path. The wire-level dispatch outcome (`scrolled: true`, `reason: delivered_via_postmessage`, `channel: postmessage`) is bit-equal to PR #312. The only observable change is that `observation.motion` is now populated as `"translation"` (Stage 2b promoting Stage 2a's hardcoded `"indeterminate"`) — a strictly informative addition to the envelope. AC6 budget passes with ~30 % headroom.

---

## 3. Excel boundary scroll-up at A1 — silent-drop natural synthesis ⭐

30 cycles, reset to A1 via `Ctrl+Home`, `direction=up`, `notch=3`, default env.

| Metric | Value |
|---|---|
| `DispatchOutcome.scrolled` | **`false` × 30 (= 30 / 30)** |
| `DispatchOutcome.reason` | **`target_unreachable` × 30** |
| `DispatchOutcome.channel` | `postmessage` × 30 (transport-honest — the message was posted; the gate decided no pixels moved) |
| `observation.motion` | **`no_change` × 30** |
| `observation.source` | `temporal_ring_observation_only` × 30 |
| `ringTelemetry.finalChangedFraction` p50 / p90 / p99 | 0 / 0 / **0** |
| `finalChangedFraction > 0` count | **0 / 30 (0 %)** — gate predicate fails universally |
| `ringTelemetry.stableReached` | `true` × 30 (stop-detection settles immediately because nothing changed) |
| Bench-measured dispatch wallclock p50 / p90 / p99 | 324 / 326 / **341 ms** (faster than real scroll because stop-detection drains immediately on no motion) |

**This is the load-bearing Stage 2b proof.** Excel posts the wheel message (the chain-table receiver accepts it), but because the visible region cannot move past row A1, no pixels change. Stage 2a's `finalChangedFraction === 0` triggers Stage 2b's `motion = "no_change"`, and the chain-trust dispatcher returns the new non-null `DispatchOutcome { scrolled: false, reason: "target_unreachable", observation: ... }` per sub-plan §5 R3 Option I. Caller (`mouse.ts:scrollHandler`) then routes to the `not_delivered` envelope with the observation propagated — the LLM sees an honest negative.

**Reproducer note**: this is a deterministic, fixture-free, real-system silent drop synthesis (sub-plan §6 OQ #1 referenced it; this report formalises it). No modal cover or receiver-stall scaffolding required — the boundary condition itself is the silent drop. Future dogfoods that need silent drops can reuse this pattern on any chain-trust target (e.g. Word `_WwG` when chain-trust activates) by scrolling against the document's edge.

---

## 4. Env opt-out matrix — prior-stage behaviour preserved exactly

### 4.1 `DESKTOP_TOUCH_STAGE2B_GATE=0` — Stage 2a (telemetry-only) behaviour preserved

5 cycles, Excel A1 boundary scroll-up, Stage 2a ring ON, Stage 2b gate OFF.

| Field | Value | Interpretation |
|---|---|---|
| `DispatchOutcome.scrolled` | `true` × 5 | Stage 2a behaviour (gate decision suppressed) |
| `DispatchOutcome.reason` | `delivered_via_postmessage` × 5 | Stage 2a behaviour |
| `observation.motion` | **`indeterminate` × 5** | gate suppressed → motion stays at Stage 2a's hardcoded value |
| `observation.source` | `temporal_ring_observation_only` × 5 | ring captured normally |
| `ringTelemetry.finalChangedFraction` | 0 / 0 / 0 | telemetry preserved even when gate is disabled |
| wallclock p99 | 326 ms | same shape as default boundary-up (ring still polls) |

**✓ G2b-4 acceptance pin**: opting out the gate while keeping the ring preserves Stage 2a's behaviour bit-for-bit, except `observation.motion` stays `"indeterminate"` (the promotion from `"indeterminate"` to `"no_change"` is exactly the gate, so suppressing the gate suppresses that promotion).

### 4.2 `DESKTOP_TOUCH_STAGE2A_RING=0` — Stage 1 (no temporal observation) behaviour preserved

5 cycles, Excel A1 boundary scroll-up, Stage 2a ring OFF (which implicitly disables Stage 2b — no ring → no `finalChangedFraction` → no gate trigger), Stage 2b gate ON (irrelevant).

| Field | Value | Interpretation |
|---|---|---|
| `DispatchOutcome.scrolled` | `true` × 5 | Stage 1 behaviour |
| `DispatchOutcome.reason` | `delivered_via_postmessage` × 5 | Stage 1 behaviour |
| `observation.motion` | `indeterminate` × 5 | Stage 1 (no temporal observation) |
| `observation.source` | **`chain_trust_unverified` × 5** | source flips to the Stage 1 bare-chain-trust label because no ring observation was attempted |
| `ringTelemetry` | absent | telemetry not captured when ring is disabled |
| wallclock p99 | **146 ms** (vs ~340 ms with ring) | dispatcher returns immediately after PostMessage settles; no ring polling |

**✓ G2b-5 acceptance pin**: with the ring disabled, the chain-trust branch falls through to Stage 1's bare `chain_trust_unverified` observation source and the dispatcher emits the original `delivered_via_postmessage` outcome — exact bit-equality with the pre-Stage-2a wire shape, just enriched with the (Stage 1-introduced) observation hint.

---

## 5. Word `_WwG` boundary scroll-up — structural inheritance from Stage 2a dogfood

5 cycles on a fresh blank Word document (`文書 1 - Word`, top-level class `OpusApp`).

| Field | Value |
|---|---|
| `DispatchOutcome.scrolled` | `null` × 5 (= `postWheelToHwnd` returned bare `null`) |
| `DispatchOutcome.reason` | n/a (null fall-through) |
| `observation` | n/a |
| wallclock p99 | 40 ms |

**Interpretation**: `postWheelToHwnd` returns `null` for all 5 cycles on Word — exactly the structural finding from `docs/adr-019-stage-2a-dogfood-results.md` §3 (15 cycles, 10 KB Lorem ipsum content, same `null` result). Word `OpusApp` is in `SCROLL_LEAF_CHAINS` (`src/win32/window.rs:271-274`) but the chain-trust branch either does not retarget (the leaf walker may not find `_WwG` in a blank document) or the `GetScrollInfo` SB_VERT path returns a non-null pre-snapshot routing to Case 3 (standard observation). Either way, the **chain-trust + temporal-ring branch is never entered**, so Stage 2b's gate has no opportunity to flip the status. Word is therefore Stage 2b-regression-free by structural inheritance, and no behaviour change applies to it without a separate dogfood pass on a `_WwG`-activating document state (sub-plan §6 OQ #4 carry-over).

---

## 6. Acceptance criteria — all pinned

| AC | Wording | Status |
|---|---|---|
| **G2b-1** (functional, real scroll) | Excel real-scroll returns `delivered` 30/30 with `motion=translation` and `source=temporal_ring_observation_only` | **✓** §2 (30/30 exact match) |
| **G2b-2** (functional, silent drop) | Silent-drop scenario returns `not_delivered` with `reason=target_unreachable` and `motion=no_change` | **✓** §3 (boundary scroll-up at A1, 30/30 exact match — deterministic real-system reproducer, no mocking required) |
| **G2b-3** (no regression on Tier 1 UIA path) | Word / Notepad / File Explorer Tier 1 UIA scrolls emit unchanged envelope | **✓** §5 (structural inheritance from Stage 2a dogfood §3-4; Word `postWheelToHwnd` returns null = chain-trust unreached) |
| **G2b-4** (env opt-out preserves Stage 2a behaviour) | `DESKTOP_TOUCH_STAGE2B_GATE=0` keeps Stage 2a wire-level output | **✓** §4.1 (scrolled=true × 5, motion=indeterminate × 5, finalChangedFraction telemetry preserved) |
| **G2b-5** (env opt-out preserves Stage 1 behaviour) | `DESKTOP_TOUCH_STAGE2A_RING=0` keeps Stage 1 wire-level output | **✓** §4.2 (scrolled=true × 5, source=chain_trust_unverified × 5, no ringTelemetry, wallclock drops to 146 ms) |
| **G2b-6** (latency budget) | wallclock p99 ≤ 700 ms | **✓** §2 (real scroll p99 = 498 ms = 71 % of budget; §3 boundary-up p99 = 341 ms = 49 % of budget) |
| **G2b-7** (CLAUDE.md §3.1 sweep) | enum bit-equal across SoTs; `shift?` "present iff" relaxed | covered by sub-plan PR #313 + impl PR #317 (CLAUDE.md §3.1 sweep ran during Opus rounds); this dogfood report does not re-verify the docs SSOT sweep |
| **G2b-8** (CLAUDE.md §3.2 carry-over) | no exhaustive `switch` on `observation.source` / `observation.motion` | confirmed structurally during impl PR review; not measurable in dogfood |
| **G2b-9** (post-merge dogfood report) | populate this report within 1 week of impl merge | **✓** report land = this PR, ≤ 1 day after PR #317 merge |

---

## 7. Notes for future dogfoods

- The bench's stdout `wallclock p50/p90/p99 ms` is now the per-cycle `dispatchElapsedMs` only. An earlier draft summed `dispatchElapsedMs + observation.totalElapsedMs` which double-counted (the ring observation runs inside `postWheelToHwnd`). The fix is in `benches/dogfood_stage_2b.mjs:wallclock.push(r.dispatchElapsedMs)`.
- `boundary scroll-up at A1` is the canonical deterministic silent-drop reproducer. Any future chain-trust dogfood (e.g. Stage 2c) that needs a `motion: "no_change"` test case can reuse this pattern without inventing synthetic mocks.
- Word + File Explorer + Chromium + AvaloniaUI remain Tier 1 UIA / CDP routed per `docs/adr-019-stage-2a-dogfood-results.md` §4.5; Stage 2b's blast radius is structurally bounded to Excel `XLMAIN` + future Word `_WwG`-activating doc states.

---

## 8. References

- Sub-plan (decision rule + SSOT sweep + acceptance): `docs/adr-019-stage-2b-plan.md`
- Stage 2a dogfood (precursor evidence, perfect separation `finalChangedFraction > 0` Excel signal): `docs/adr-019-stage-2a-dogfood-results.md`
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Bench: `benches/dogfood_stage_2b.mjs`
- Raw outputs: `docs/adr-019-stage-2b-dogfood-raw/`
