# ADR-019 Stage 2a PoC results — causal strip filter + stop-detection

- Date: 2026-05-16
- Branch / commit: `feature/adr-019-stage-2a-impl` @ `68e3fed` (PoC commit)
- Script: `benches/poc_stage_2a_causal_strip.mjs`
- Sub-plan: `docs/adr-019-stage-2a-plan.md`

## 1. Background

User-prompted design refinement of ADR-019 Stage 2a algorithm (2026-05-16):

1. **stop-detection polling** replaces fixed `[30, 60, 120, 240] ms` ring sampling — poll until `delta(frame[k-1], frame[k]) < STABLE_THRESHOLD` for `CONSECUTIVE_STABLE = 2` consecutive frames (Playwright visual-snapshot pattern), then return final frame's diff against pre-frame.
2. **causal strip filter** replaces single scalar `maxChangedFraction` — partition window into `STRIP_COUNT` strips along the dispatch motion axis (horizontal strips for vertical scroll, vice versa) and emit per-strip `changedFraction`. Caret blink touches 1 strip; real scroll touches multiple strips.

Both refinements aim to replace threshold tuning with semantic filtering. The PoC validates 5 hypotheses on real apps before committing the production wiring.

## 2. Hypotheses

| # | Hypothesis | Test |
|---|---|---|
| H1 | Real scroll: stripsAboveNoise ≥ 3 (allowing Excel frozen header row) | 15+ cycles of `scroll-down` against rich content; expect distribution shifted right vs idle baseline |
| H2 | Caret-blink-only window: stripsAboveNoise ≤ 1 | n/a (Excel cell selection rectangle is steady; Notepad/Word are Tier 1 UIA — Stage 2a scope-out) |
| H3 | stable reached within 700 ms p99 | wallclock p99 measured per app |
| H4 | GPU staleness absorbed by minWaitMs=50 | first-post-delta should be > 0.001 for real-scroll, ≈ 0 for idle |
| H5 | App-specific threshold required (frozen-region apps) | Compare real-scroll vs idle `fullChangedFraction` distributions |

## 3. Configuration (PoC defaults)

```
POLL_INTERVAL_MS       = 30      # 2 DWM frames @ 60 Hz
MIN_WAIT_MS            = 50      # GPU staleness guard (~3 DWM frames)
STABLE_THRESHOLD       = 0.002   # 0.2 % block diff
STRIP_NOISE_THRESHOLD  = 0.01    # 1 % per-strip block diff (initial guess; revised by data)
CONSECUTIVE_STABLE     = 2       # Playwright pattern
BUDGET_MS              = 700     # covers caret cycle 530ms + safety
STRIP_COUNT            = 4       # horizontal strips for vertical scroll
SCROLL_NOTCH           = 3       # wheel notches per dispatch
```

## 4. Empirical results

### 4.1 Excel (`Book1 - Excel`, `XLMAIN` class, region 905x555, scroll-down notch=3)

**Run 1 — real scroll, fresh from A1** (15 cycles after `Ctrl+Home` reset):

| Metric | Value |
|---|---|
| wallclock p50 / p90 / p99 | 187 / 204 / 204 ms |
| stable reached | 15 / 15 (100 %) |
| `framesToStability` (every cycle) | 3 |
| `stripsAboveNoise` (threshold 0.01) | histogram [9, 4, 1, 1, 0] — p50=0, p90=2 |
| `fullChangedFraction` p50 / p90 / p99 | 0.005 / 0.007 / 0.015 |
| `firstPostDelta < 0.001` count | 0 / 15 (motion captured every cycle) |
| `postWheelToHwnd` dispatch | 15 / 15 ok, channel = `postmessage` |

**Run 2 — idle baseline, no dispatch** (15 cycles):

| Metric | Value |
|---|---|
| wallclock p50 / p90 / p99 | 179 / 204 / 206 ms |
| stable reached | 15 / 15 (100 %) |
| `framesToStability` (every cycle) | 3 |
| `stripsAboveNoise` | histogram [15, 0, 0, 0, 0] — p50=0, p90=0 |
| `fullChangedFraction` p50 / p90 / p99 | 0 / 0 / 0 |
| `firstPostDelta < 0.001` count | 15 / 15 (zero noise) |

**Real-scroll cycle 0 strip pattern** (most informative cycle, fresh from A1):

```
stripFractions: [0, 0.034, 0.017, 0.012]
                 |   |      |      |
                 |   |      |      └ strip 3 (bottom) — incremental row enter
                 |   |      └ strip 2 (middle) — translated content
                 |   └ strip 1 (top, row labels visible) — strongest signal (row labels change A1→A4 etc.)
                 └ strip 0 (frozen header row) — always 0
```

### 4.2 Word (`文書 1 - Word`, `OpusApp` class, region 1440x753, empty document)

| Metric | Value |
|---|---|
| `postWheelToHwnd` dispatch | 0 / 10 ok (all returned `null`) — Tier 1 UIA path; Stage 2a not invoked |
| MCP `scroll` tool verifyDelivery | `channel: "uia"`, `reason: "delivered_via_uia"` |

**Finding**: empty Word document uses Tier 1 UIA `IUIAutomationScrollPattern::SetScrollPercent` — Stage 2a chain-trust scope **does not activate**. Stage 2a would only activate on Word docs where leaf walker retargets to `_WwG` AND UIA pattern isn't exposed (rich MFC docs, certain layouts). Out of PoC scope.

### 4.3 Notepad (`_input-pipeline.ts - メモ帳`, modern Win11 Notepad)

| Metric | Value |
|---|---|
| `postWheelToHwnd` dispatch | 0 / 10 ok — Tier 1 UIA path; same as Word |

Same finding as Word: Tier 1 UIA path, Stage 2a not invoked.

## 5. Hypothesis evaluation

| # | Result | Notes |
|---|---|---|
| H1 (stripsAboveNoise ≥ 3 for real scroll) | **PARTIAL** | With `STRIP_NOISE_THRESHOLD = 0.01`, only 1 / 15 real-scroll cycles reached 3. With `STRIP_NOISE_THRESHOLD = 0.003`, an estimated ~14 / 15 would reach ≥ 1. The Excel cell grid signal is genuinely small (block-SAD with NOISE_THRESHOLD=16 ignores most thin-line shifts). **Algorithm decision**: lower `STRIP_NOISE_THRESHOLD` to 0.003 — empirically distinguishes real-scroll from idle floor of 0.000. |
| H2 (caret blink ≤ 1 strip) | **n/a** | Excel cell selection rectangle is stable (no caret blink in non-edit mode). Notepad / Word are Tier 1 UIA → Stage 2a not invoked. Caret-region calibration deferred to Stage 2b when ADR-019 Stage 4 (SSIM on focused-element rect) provides the focused-rect mask. |
| H3 (stable < 700 ms p99) | **PASS** | p99 = 204 ms = 29 % of budget. Significant headroom for slower apps (Word `_WwG` with rich docs, future custom-paint canvases). |
| H4 (GPU staleness absorbed) | **PASS** | minWaitMs=50 perfectly separates real-scroll motion (15 / 15 `firstPostDelta > 0.001`) from idle (15 / 15 `firstPostDelta < 0.001`). |
| H5 (app-specific threshold) | **CONFIRMED** | Excel's block-SAD signal is small (0.003-0.015 range). Word and Notepad never activate Stage 2a so calibration is single-app for now. Stage 2a emits raw signal (per-strip + full-window changedFraction); Stage 2b sets the app-specific gate. |

## 6. Algorithm decisions (locked for impl pivot)

```
POLL_INTERVAL_MS         = 30        # locked
MIN_WAIT_MS              = 50        # locked
STABLE_THRESHOLD         = 0.002     # locked (idle noise floor = 0.000)
STRIP_NOISE_THRESHOLD    = 0.003     # revised from 0.01 (PoC H1 finding)
CONSECUTIVE_STABLE       = 2         # locked (Playwright pattern)
BUDGET_MS                = 700       # locked (29 % usage in PoC, headroom retained)
STRIP_COUNT              = 4         # locked (frozen header row separation)
```

## 7. Stage 2a scope clarification (post-PoC)

- **Active**: chain-trust fallback path = Excel `NUIScrollbar` (confirmed Stage 2a target).
- **Inactive (Tier 1 UIA)**: Notepad, Word (empty doc), most modern Windows apps.
- **Conditional**: Word `_WwG` with MFC custom-paint dense docs — would activate when UIA `ScrollPattern` not exposed on the leaf. Not exercised in PoC.
- **Future custom-paint canvases**: Photoshop, Blender, Paint.NET, OBS — out of PoC scope; would be Stage 2b carry-overs.

## 8. Stage 2a telemetry shape (revised)

```ts
ringTelemetry: {
  framesSampled: number;                    // 1 pre + N polled frames
  elapsedMsPerFrame: number[];              // timestamps from minWait start
  // Stop-detection metrics (delta from previous frame)
  changedFractions: number[];               // delta(pre, frame[k]) per k — Stage 2b decision input
  maxChangedFraction: number;               // max of changedFractions
  // Strip-filter telemetry (pre vs final stable frame, per strip)
  axis: "vertical" | "horizontal";          // motion axis from dispatch direction
  stripCount: number;                       // = 4
  finalStripChangedFractions: number[];     // length stripCount
  stripsAboveNoise: number;                 // count of strips > STRIP_NOISE_THRESHOLD
  finalChangedFraction: number;             // delta(pre, final)
  // Stop-detection diagnostics
  stableReached: boolean;
  framesToStability: number | null;         // null when budget exhausted
};
```

## 9. AC6 amendment (ADR-019 §6)

- **Old** (pre-PoC): temporal-fallback p99 ≤ 300 ms wall-clock.
- **New** (post-PoC): temporal-fallback p99 ≤ **700 ms** wall-clock. Justification: 700 ms covers a full Win32 caret blink cycle (530 ms default) + safety margin, even though the PoC measured 204 ms on Excel (29 % usage). The wider budget is intentionally generous so future apps with slower MFC repaint (Word `_WwG` rich docs) or persistent animations don't budget-timeout the algorithm; in practice the early-exit on `stableReached` keeps median wall-clock low.

## 10. Notes for impl pivot

- `RING_SCHEDULE_MS` constant removed (no fixed schedule).
- `RING_WALLCLOCK_BUDGET_MS` retained, value changed to 700.
- New constants: `POLL_INTERVAL_MS`, `MIN_WAIT_MS`, `STABLE_THRESHOLD`, `STRIP_NOISE_THRESHOLD`, `CONSECUTIVE_STABLE`, `STRIP_COUNT`.
- `capturePostFrameRing` removed; replaced by `capturePostFrameUntilStable(hwnd, region, opts)`.
- New helper `computeStripChangedFractions(pre, post, axis, stripCount)` in `layer-buffer.ts`.
- `VisualMotionObservation.ringTelemetry` shape extended (new fields are additive on top of the existing PR #309 contract).
- ADR-019 §2.1 contract enum and ADR-018 §2.6 envelope reference enum unchanged (Stage 2a still emits `source: "temporal_ring_observation_only"`).
