# ADR-019 Stage 4 dogfood results — SSIM `local_repaint` primitive confirmed across 4 real apps

- Date: 2026-05-16
- Predecessor PRs:
  - PR #309 (`c196bbc`) — ADR-019 MVP-1 Stage 1 contract (`VisualMotionObservation`)
  - PR #311 (`0063ee3`) — Stage 2a impl (`captureFrame` + `capturePostFrameUntilStable` Stage 4 inherits)
  - PR #314 (`88866e9`) — Stage 4 sub-plan
  - PR #316 (`b475af3`) — Stage 4 sub-plan retro-review follow-up (P-tasks P15/P16)
  - PR #318 (`4768fea`) — Stage 4 impl (this report dogfoods that PR)
- Bench harness: `benches/dogfood_stage_4.mjs` (new — invokes `verifyLocalRepaint` directly so the dogfood runs against the post-v1.6.0 build that has the Stage 4 wiring, even when the connected MCP server is still v1.6.0)
- Raw outputs: `docs/adr-019-stage-4-dogfood-raw/{mspaint-click-20,blender-click-center-10,paintnet-click-brush100-jitter150-20,paintnet-idle-10,vscode-editor-click-10}.txt`

**TL;DR**: the `local_repaint` primitive correctly distinguishes substantial repaint (Paint.NET wide-brush stamp, VS Code line-click) from sub-threshold change (MSPaint default-tool click, idle baseline). Across 70 cycles on 4 real apps:

- **29 positive cycles → `motion: "local_repaint"`** (`fractionChanged` 0.18-0.31, `meanSsim` 0.71-0.95).
- **40 negative cycles → `motion: "no_change"`** (cheap-reject path for sub-threshold change, no SSIM kernel cost).
- **1 unstable cycle → `motion: "indeterminate"`** (R6 stable-not-reached, ~1.4 s budget exhausted on Blender's GPU viewport during first frame).

End-to-end `verifyLocalRepaint` wallclock p99 = 258 ms across all positive cases — well under the AC6 700 ms budget.

---

## 1. Sample sizes

| App | Tool / scenario | Cycles | Mode | Jitter | Purpose |
|---|---|---|---|---|---|
| **MSPaint** (Win11 Microsoft.Paint) | Default tool (selection) | 20 | click | 0 | sub-threshold change → expect `no_change` (cheap-reject) |
| **Blender 5.1.1** (default scene, cube selected) | LMB click in 3D viewport | 10 | click | 0 | selection toggle → expect first cycle to deselect (`local_repaint` / `indeterminate`), subsequent to be `no_change` |
| **Paint.NET V5.1.12** (blank 800×600 canvas) | Brush, size = **100**, jittered click | 20 | click | 150 | substantial paint stamp per cycle → expect `local_repaint` |
| **Paint.NET V5.1.12** (same canvas) | Idle (no click) | 10 | idle | n/a | true-negative baseline → expect `no_change` |
| **VS Code 1.x** (release-process.md open) | LMB click in editor | 10 | click | 100 | caret reposition + minimap/line highlight repaint → expect mixed |

60 click cycles + 10 idle baseline cycles = **70 total** (matches the per-motion split in TL;DR: 29 `local_repaint` + 40 `no_change` + 1 `indeterminate` = 70). All ran against the post-PR #318 build (TS dist + Rust napi `compute_ssim_residual`). Per-app click counts: MSPaint 20 + Blender 10 + Paint.NET click 20 + VS Code 10 = 60; Paint.NET idle 10.

---

## 2. Positive cases — `local_repaint` upgrade confirmed

### 2.1 Paint.NET wide-brush click (clean positive ⭐)

Brush size raised to **100 px** via the toolbar NumericUpDown (default 2 px is sub-threshold), 20 cycles with `--jitter 150` so each click lands at a fresh canvas position.

| Metric | Value |
|---|---|
| `observation.motion` | **`local_repaint` × 20 / 20** |
| `observation.source` | `ssim_residual` × 20 |
| `rectSource` | `point_padded` × 20 (192×192 pad centred on click) |
| `residual.fractionChanged` p50 / p90 / p99 | 0.271 / 0.302 / **0.306** (well above the `RESIDUAL_DELIVERED_FRACTION = 0.05` gate) |
| `residual.meanSsim` p50 / p90 / p99 | 0.762 / 0.834 / **0.895** (below the `MEAN_SSIM_NO_CHANGE_FLOOR = 0.99`, so the gate decides on `fractionChanged` not the fallback floor) |
| `residual.centroid` | consistently ~`(96, 96)` (= pad centre, i.e. exactly the click point) — confirms the centroid arithmetic is correct |
| `framesSampled` | 4 (1 pre + 3 post-stable polls) |
| `verifyLocalRepaint` wallclock p50 / p90 / p99 | 219 / 239 / **249 ms** (well under AC6 700 ms) |

The centroid landing on the pad centre across all 20 jittered click positions independently confirms that the SSIM map's mean-position computation isn't drifting based on background content.

### 2.2 VS Code click in editor (incidental positive)

10 click cycles, `--jitter 100`, click point near editor middle on a markdown file with line highlights, minimap, breadcrumbs, and status-bar active-line indicators.

| Metric | Value |
|---|---|
| `observation.motion` | **`local_repaint` × 9 / 10**, `no_change` × 1 |
| `observation.source` | `ssim_residual` × 10 |
| `residual.fractionChanged` p50 / p90 / p99 | 0.230 / 0.271 / 0.271 |
| `residual.meanSsim` p50 / p90 / p99 | 0.911 / 0.952 / 0.952 |
| `verifyLocalRepaint` wallclock p99 | **258 ms** |

The VS Code positive rate (9/10) was higher than initially predicted. Stage 4's threshold (5 % of 192² windows above the 0.05 per-window residual cap) catches the cumulative repaint of: (a) the previously-active line losing its current-line indicator, (b) the newly-clicked line gaining one, (c) the gutter line-number colour shift, (d) minimap viewport indicator, (e) the breadcrumbs current-symbol update. Even though each individual repaint is small, the 192×192 pad around an editor click intercepts several of them.

This is informative for production wiring: in the Stage 4 production gate (`mouse_click.verifyDelivery` activates only when `classifyDelivery` returns `focus_only` / `unverifiable`), VS Code click would normally NOT reach the Stage 4 fallback because the editor exposes UIA TextPattern. So the production blast radius is unchanged — but this dogfood confirms the SSIM algorithm correctly handles the rich-repaint case if a similar visual stack ever shipped without UIA support.

### 2.3 Blender 3D viewport click (first-cycle positive only)

10 click cycles at window centre on a fresh `(Unsaved) - Blender 5.1.1` workspace (cube selected by default).

| Cycle | Motion | Notes |
|---|---|---|
| 0 | `indeterminate` | `totalElapsedMs = 1444` (≈ 700 ms `RING_WALLCLOCK_BUDGET_MS` + ~700 ms post-frame polling/capture overhead before the degraded return; raw `framesSampled: 2` confirms only 1 pre + 1 post frame reached the orchestrator's R6 branch). `stableReached: false` triggered R6 mitigation. Blender's GPU viewport had ongoing animation (compositor preview / object hint render) that didn't settle within budget. |
| 1-9 | `no_change` | Centre click on the same already-selected cube produced no visible state change → cheap-reject path. |

This is the **R6 mitigation in action** (orchestrator branch at `src/engine/local-repaint.ts:349`): when the post-frame ring fails to reach stability within `RING_WALLCLOCK_BUDGET_MS = 700`, Stage 4 emits `motion: "indeterminate"` via `observationDegrade(1 + postResult.frames.length)` rather than running SSIM on transient frames. Caller (would-be mouse_click handler) keeps `focus_only` / `unverifiable` — Stage 4 doesn't pretend to know.

The Blender-specific dogfood pattern (selection state stable after first click) is not a Stage 4 limitation; it's the reality of click semantics. A more elaborate dogfood (drag, alt-click, viewport navigation) would exercise other Blender click outcomes; out of scope for this report (carry-over to a future dogfood pass alongside `mouse_drag` Stage 4 wiring, sub-plan §7 OQ #6).

---

## 3. Negative cases — `no_change` cheap-reject confirmed

### 3.1 MSPaint default-tool click (zero pixel change)

Win11 MSPaint's default tool on launch is the **selection** tool (not the pencil/brush). Clicking on the empty canvas with the selection tool produces **zero visible repaint** — the click neither draws nor changes any UI state. 20 cycles at window centre, no jitter.

| Metric | Value |
|---|---|
| `observation.motion` | **`no_change` × 20** |
| `observation.source` | `ssim_residual` (= the pipeline that decided) |
| `residual` | **`null` × 20** (cheap-reject short-circuited before the SSIM kernel) |
| `framesSampled` | 4 (1 pre + 3 post-stable polls) |
| `verifyLocalRepaint` wallclock p99 | **166 ms** |

This pins **G4-5 sample 1** (no-change correctness) on a real app. The cheap-reject path (`computeChangeFraction < NO_CHANGE_FLOOR = 0.001`) saves the SSIM kernel cost when the pre/post pair is essentially identical, which is the dominant case in production.

### 3.2 Paint.NET idle baseline (no click, no paint)

10 cycles with `--mode idle` — the harness captures pre and post frames without sending any click. Static canvas → identical buffers.

| Metric | Value |
|---|---|
| `observation.motion` | **`no_change` × 10** |
| `observation.source` | `ssim_residual` × 10 |
| `rectSource` | `window_fallback` × 10 (idle mode supplies no `point`, so the resolver falls back to the whole `windowRect`) |
| `residual` | `null` (cheap-reject) |

This pins the **idle baseline** for Stage 4 — the algorithm correctly reports `no_change` when nothing happened.

The `window_fallback` (whole 1000×800 window) is a 800,000 px rect — under `MAX_RECT_AREA_PX = 1,000,000`, so the R3 cap path is NOT hit. The cheap-reject path still triggers because the static canvas produces identical pre/post bytes (`computeChangeFraction = 0.0 << NO_CHANGE_FLOOR`).

---

## 4. Acceptance criteria — Stage 4 algorithmic side pinned

| AC | Wording | Status |
|---|---|---|
| **G4-1** (functional, mouse_click synthetic) | 200×200 frame with 40×40 dark rect at centre returns `local_repaint`, fractionChanged ∈ [0.04, 0.20], centroid ≈ (100, 100) | covered by `tests/unit/ssim-residual.test.ts` (pinned by impl PR #318); this dogfood adds real-app evidence — see §2.1 (Paint.NET centroid landing on pad centre across all 20 jittered positions) |
| **G4-2** (functional, keyboard:type synthetic) | typed-character fixture → `local_repaint`, envelope upgrade | covered by `tests/unit/keyboard-type-stage4.test.ts` (impl PR #318); real-app keyboard:type BG-verify dogfood deferred — see §5 below |
| **G4-3** (no regression, mouse_click env opt-out) | `DESKTOP_TOUCH_STAGE4_SSIM=0` keeps PR #309 + Stage 2a baseline output bit-identical | not measurable in this dogfood (production-gate wiring is in mouseClickHandler which the connected MCP server doesn't yet expose; unit tests `mouse-click-verify-stage4.test.ts` pin this contract synthetically) |
| **G4-4** (no regression, keyboard:type env opt-out) | `DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD=0` keeps BG `false` behaviour | covered by `tests/unit/keyboard-type-stage4.test.ts` (impl PR #318); dogfood-not-applicable for the same reason as G4-3 |
| **G4-5** (no-change correctness) | Idle / focus-thief click returns `no_change` 30/30 | **✓** §3.1 (MSPaint 20/20) + §3.2 (Paint.NET idle 10/10) = 30/30 across 2 apps |
| **G4-6** (latency, unit) | `compute_ssim_residual` p99 ≤ 15 ms on a 400×400 frame pair | pinned by `benches/ssim_residual.mjs` (impl PR #318 bench); this report's end-to-end `verifyElapsedMs` p99 = 258 ms includes **post-frame ring polling + SSIM crop + SSIM kernel** (the pre-`captureFrame` is measured separately by the harness, see `benches/dogfood_stage_4.mjs:170-178` — `tVerify` brackets only the `verifyLocalRepaint` call); the SSIM kernel itself is a small fraction of the 258 ms |
| **G4-7** (latency, integration) | `verifyLocalRepaint` end-to-end p99 ≤ 700 ms | **✓** §2 (Paint.NET p99 = 249 ms, VS Code p99 = 258 ms) — both well under budget |
| **G4-8** (CLAUDE.md §3.1 multi-table sweep) | `observation.source` 8-value enum bit-equal across SoTs | covered by sub-plan PR #314 + follow-up PR #316 + impl PR #318; this dogfood does not re-verify docs SSOT sweep |
| **G4-9** (CLAUDE.md §3.2 carry-over scope shrink) | No exhaustive `switch (observation.source)` | confirmed structurally during impl PR review |
| **G4-10** (env opt-out) | Independent gates `DESKTOP_TOUCH_STAGE4_SSIM` + `_KEYBOARD` | covered by `tests/unit/*-stage4.test.ts` (impl PR #318); not measurable here |
| **G4-11** (focused-rect resolver) | `point_padded` when `hint.point`, `window_fallback` otherwise | **✓** §2 (point_padded × 50 on click modes) + §3.2 (window_fallback × 10 on idle mode) |

R6 (background animation / unstable) explicitly seen and handled in §2.3 cycle 0 (Blender 1.4 s budget exhaust → `indeterminate`). R3 (over-sized rect) not triggered (no rect approached 1 Mpx).

---

## 5. Deferred / known limits

- **Real-app `keyboard:type` BG-verify dogfood**: deferred. The connected MCP server is v1.6.0 (pre-Stage 4) so it doesn't surface the production gate. The unit test `tests/unit/keyboard-type-stage4.test.ts` (impl PR #318) pins the activation gate + envelope upgrade contract synthetically. Real-app dogfood requires either (a) restarting the local MCP server with the post-PR-#318 build and reconnecting Claude Code, or (b) extending `benches/dogfood_stage_4.mjs` with a `--type` mode that drives a `keyboard:type` BG path before invoking `verifyLocalRepaint`. **Carry-over to v1.7.x dogfood** alongside the production release of Stage 4 in the next minor.
- **Custom-paint pure positive on app without UIA fallback**: the dogfood's most reliable `local_repaint` trigger (Paint.NET wide brush + jitter) is on an app whose canvas DOES have UIA bounding info (the Paint.NET canvas exposes some UIA, just not as a typed text-editable). To prove Stage 4 closes a gap that *no other tier covers*, the canonical target would be Photoshop / Krita / GIMP (true UIA-blind canvases). None of those are installed on the dogfood host. Carry-over.
- **Blender click that consistently triggers `local_repaint`**: §2.3 cycle 0 was indeterminate (GPU animation); cycles 1-9 stabilised to `no_change`. A multi-click dogfood with click jitter over the toolbar / properties panel (which DO repaint on click) is straightforward but not run here. Carry-over.
- **`mouse_drag` Stage 4 wiring**: out of scope (sub-plan §7 OQ #6). The drag's visual change is at the drag end-point, not the start; Stage 4 would need its own activation gate for drag handlers.
- **Multi-region SSIM**: a click that produces both a focus ring near the click AND a side-panel update far from the click — Stage 4 catches only the focus ring (the side panel falls outside the 192×192 pad). Sub-plan §7 OQ #7 carries this to a future stage.

---

## 6. Notes for future Stage 4 dogfoods

- **Brush size matters**: Paint.NET's default 2 px brush produces ~4 pixel change per click = 0.01 % of pad → cheap-reject. Bump to ≥ 50 px (preferably 100) for reliable `local_repaint` trigger.
- **Click jitter is required for repeat positives**: without jitter, cycle N's pre frame already contains cycle N-1's paint, so SSIM sees identical pre/post → `no_change`. `--jitter 150` worked well for Paint.NET's 800×600 canvas.
- **Idle mode tests `window_fallback` rect resolution path** (no click point supplied → resolver returns whole windowRect). Useful side-effect for resolver dogfood coverage.
- **Blender's GPU viewport reliably triggers R6 mitigation** (first-frame `stableReached: false`); good real-app fixture for the unstable case.
- **VS Code editor is a Chromium/Electron app with rich line-click repaint** — Stage 4 fires on it. In production this matters only if the editor stopped exposing TextPattern (which it does today), but it's a useful regression canary that the SSIM threshold is sized correctly for "rich UI repaint" cases.

---

## 7. Deferred P2 sweep (post-impl PR #318)

Four P2 findings from the post-merge external Opus review of PR #318 were
deemed defer-eligible and are persisted here for v1.7.x patch follow-up
(CLAUDE.md §9 — residuals in docs/, not memory). None of these are P1 / load-
bearing; the Stage 4 algorithm + production wiring are correct as shipped.

### 7.1 (Opus Round 1 P2-1) `keyboard.ts` Stage 4 integration test gap

**Site**: `tests/unit/keyboard-type-stage4.test.ts` (4 cases, all passing).

**Gap**: The test file's docstring (lines 18-22) explicitly notes that the
full `typeHandler` BG verify block is **not exercised**:

> "we test the gate semantics by directly exercising the §2.4.2 decision
> tree against the contracts that the orchestrator returns. ... the Stage 4
> surface is fully pinned without booting `typeHandler`'s 200+ line BG
> verify block."

The function `evaluateKeyboardStage4Gate` defined in the test is a
**replication of the production gate contract**, not the production wiring
itself. If `src/tools/keyboard.ts:keyboardTypeHandler` (exported at line 701)
BG verify failover path drifts (e.g. the gate site moves, or the
`verifyReason === "read_back_unsupported"` condition gets refactored), the
test would keep passing while production breaks silently. (The quoted
docstring uses the informal shortname `typeHandler`; the actual exported
symbol is `keyboardTypeHandler` — grep accordingly.)

**Suggested fix**: add **one** integration case that exercises the actual
`keyboardTypeHandler` codepath end-to-end with mocked
`backgroundChannelResolver` + mocked `verifyTextDelivery` returning
`unverifiable + read_back_unsupported`, and asserts that
`verifyLocalRepaint` is called with the resolved target's `windowRect`.
Scope: ~50-80 lines, additive only (existing 4 cases unchanged).

**Effort**: 0.5 day. **Priority**: medium — keyboard wiring stability is
load-bearing for v1.7.x dogfood when the MCP server starts shipping Stage 4.

### 7.2 (Opus Round 1 P2-2) Pre-frame `captureFrame` overhead bench (R4 commitment)

**Site**: `src/tools/mouse.ts:608` — `await captureFrame(stage4Hwnd, stage4WindowRect)`
runs on every `mouse_click(verifyDelivery=true)` call when Stage 4 prerequisites
are met (default-on), adding ~30-50 ms estimated to every mouse click.

**Gap**: sub-plan §6 R4 ("`mouse_click` pre-frame capture timing") explicitly
commits to a bench gate: "Bench gate enforces overall `mouse_click` p99 ≤
existing baseline + 50ms". No such bench file exists (`benches/` has
`ssim_residual.mjs` for kernel-only, no end-to-end mouse_click overhead bench).

**Suggested fix**: extend an existing mouse benchmark or add
`benches/mouse_click_stage4_overhead.mjs` that drives N cycles of
`mouseClickHandler` with `verifyDelivery=true` × {`DESKTOP_TOUCH_STAGE4_SSIM=0`,
default (Stage 4 on)} and asserts the delta is ≤ 50 ms p99. **Isolation
note**: pre-frame capture is gated on the env var + windowRect resolution
ONLY — NOT on `classifyDelivery`'s outcome (the wrapper at
`src/tools/_mouse-verify.ts:257-270` runs `verifyLocalRepaint` whenever the
baseline returns non-`delivered`, but the pre-frame capture at
`src/tools/mouse.ts:608` runs BEFORE classification). So the env opt-out
cleanly suppresses pre-capture and any low-noise click target (Notepad,
Calculator, etc.) works; the **isolation comes from the env flag, not
from picking a UIA-rich target**. (Codex PR #320 Round 2 P2 corrected an
earlier draft that incorrectly implied Notepad bypasses Stage 4 via UIA tier.)

**Effort**: 0.5 day. **Priority**: medium — production callers absorbing the
~30-50ms hit deserve a regression gate.

### 7.3 (Opus Round 1 P2-3) `moveTo` ↔ pre-capture hover-render race

**Site**: `src/tools/mouse.ts:580-608` — `moveTo(tx, ty)` runs BEFORE
`captureFrame(...)` (~28 lines / ~5-30 ms gap depending on `mouse.config.mouseSpeed`).

**Risk**: when the cursor moves to a new element with a hover affordance
(button highlight, tooltip, link underline), the hover state begins
rendering immediately. If the pre-frame is captured before the hover
render completes, the post-frame will contain the hover state that the
pre-frame doesn't → fractionChanged carries hover-only repaint, not click
repaint → potential false-positive `local_repaint`. Conversely, if the
previous cursor position had a hover state still un-hovering, the
pre-frame may carry that transient. Net effect: noisy fractionChanged
distributions on hover-rich UIs.

**Suggested fix**: measurement bench that, for a stable target with known
hover affordance (e.g. a single Win11 Calculator button), runs:
1. `moveTo → sleep(0) → captureFrame → captureFrame` (back-to-back pre captures)
2. `moveTo → sleep(50) → captureFrame → captureFrame`
3. `moveTo → sleep(150) → captureFrame → captureFrame`

Compare back-to-back `computeChangeFraction` to bound the hover-settling
budget. If ≥ NO_CHANGE_FLOOR within 50 ms, add `POST_MOVETO_SETTLE_MS = 50`
constant before pre-capture; if not, the current zero settle is honest.

**Effort**: 0.5 day. **Priority**: low — the existing dogfood (§2.1 Paint.NET
fractionChanged p99 = 0.306) shows good signal-to-noise on a static-hover
target; the failure mode would only surface on hover-rich apps not yet dogfooded.

### 7.4 (Opus Round 2 P2-2) `cropRawFrame === null` branch unit test

**Site**: `src/engine/local-repaint.ts:367-372` — branch where `cropRawFrame`
returns null for either pre or post (window moved/resized between mouse.ts
capture and Stage 4 post capture, so `localRect` falls outside the captured
buffer); the orchestrator degrades to `observationDegrade(framesSampled)`.

**Gap**: `tests/unit/local-repaint-orchestrator.test.ts` (14 cases) does NOT
exercise the cropRawFrame null branch — grep returns zero matches for
"cropRawFrame" or "crop" in the test file. The branch is unreachable in
the test mocks because the pre/post frames always match `windowRect`
dimensions.

**Suggested fix**: add one unit case where the orchestrator is invoked with
a `hint.windowRect` that's smaller than the captured pre-frame's actual
dimensions OR a localRect that escapes the buffer (simulating window
resize-during-action). Assert `motion: "indeterminate"` with `source:
"ssim_residual"` and no `residual` field. ~30 lines.

**Effort**: ~0.25 day (extending existing test file, ~30 lines). **Priority**:
low — the branch is defensive against a rare race condition; honest degrade
behaviour is more important than the unit test, which the branch already
implements.

### 7.5 Total scope estimate

| Item | Effort | Priority |
|---|---|---|
| §7.1 keyboardTypeHandler integration test | 0.5 day | medium |
| §7.2 mouse_click pre-capture overhead bench | 0.5 day | medium |
| §7.3 moveTo → captureFrame hover-render race bench | 0.5 day | low |
| §7.4 cropRawFrame === null unit test | 0.25 day | low |
| **Total bundled (single v1.7.x PR)** | **~1.75 days** | — |

None block v1.7.0 release. Recommended bundling with the first v1.7.x patch
that touches Stage 4 production code (each item is independent enough that
partial landings are also fine; medium-priority items should land first if
the patch is split).

---

## 8. References

- Sub-plan + decisions: `docs/adr-019-stage-4-plan.md`
- Sub-plan follow-up (P15 mean_ssim plumbing + P16 rectSource resolver decision): PR #316 (`b475af3`)
- Stage 4 impl PR (this dogfood targets): PR #318 (`4768fea`)
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Sibling Stage 2b dogfood: `docs/adr-019-stage-2b-dogfood-results.md`
- Bench harness: `benches/dogfood_stage_4.mjs`
- Raw outputs: `docs/adr-019-stage-4-dogfood-raw/`
- Production wiring sites (for future MCP-restart dogfood):
  - `src/tools/mouse.ts:mouseClickHandler` — Stage 4 mouse activation
  - `src/tools/keyboard.ts:keyboardTypeHandler` BG-verify block — Stage 4 keyboard activation
  - `src/engine/local-repaint.ts:verifyLocalRepaint` — orchestrator (exercised directly by this dogfood)
  - `src/ssim.rs` + `index.d.ts:computeSsimResidual` — Rust SSIM napi binding
