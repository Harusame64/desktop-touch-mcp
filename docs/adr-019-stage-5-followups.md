# ADR-019 Stage 5 dogfood — DXGI `any_change` primitive verification

- Predecessor PRs:
  - PR #321 — Stage 5 sub-plan (`docs/adr-019-stage-5-plan.md`)
  - PR #322 — `OutputBounds` populated from `DXGI_OUTPUT_DESC.DesktopCoordinates` (all monitors)
  - PR #323 — sub-plan amendment lifting v1 primary-monitor-only constraint
  - PR #325 — Stage 5 impl (`verifyAnyChange` orchestrator + `desktop_act` / `_mouse-verify` / `keyboard` wiring)
  - PR (this one) — **lint fix only**: drops one unused `NativeDirtyRectSubscription` type import from `src/engine/any-change.ts` that was failing the `Lint` step on the post-#325 `main` CI since the merge. The originally bundled Stage 5 foreground-fallback dormancy fix (`DesktopFacade.resolveHwndForViewId` + `desktop-register` refactor) is held back on branch `feature/adr-019-stage-5-dormancy-fix-deferred` (same SHA `10982e2`) pending resolution of the v1.7.0 release blockers tracked in **issue #327** — shipping the dormancy fix while Stage 5 is degraded at runtime on the dogfood host (items A and B in #327) would attach no useful `result.observation` value, so the revival is gated on the #327 investigation.
- Default toggles in production:
  - `DESKTOP_TOUCH_STAGE5_DXGI` = **ON** (set to `"0"` to opt out of `desktop_act` post-touch observation)
  - `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK` = **OFF** (set to `"1"` to opt into `_mouse-verify` / `keyboard` safety-net path)
- Observation surface: `verifyAnyChange` returns `VisualMotionObservation` with `source ∈ {dxgi_dirty_rect, dxgi_dirty_rect_unavailable}`, attached to `result.observation` on the `desktop_act` envelope.

---

## Purpose

Verify that Stage 5 (the 5th observation tier, default-ON in production) emits honest, useful observations across:

1. **Primary monitor desktop_act** — the common case; must produce `motion: any_change` with `residual.ratioOfTargetArea >= 0.005` for genuine repaint.
2. **Secondary monitor desktop_act** — PR #322 + #323 enable this; the resolver must select `outputIndex >= 1` and the observation must be emitted from the same monitor as the target window.
3. **Cross-monitor straddle window** — v1 carry-over per sub-plan §7 (Stage 5c): `resolveOutputIndexForHwnd` reports `crossMonitor: true` but the orchestrator subscribes to the center-containing monitor only. Confirm the observation remains an honest lower bound on motion (never `no_change` if motion was detected on the observed half).
4. **AccessLost recovery** — Lock / Unlock screen sessions trigger `E_DUP_ACCESS_LOST`; the cache must invalidate and the next call must re-acquire cleanly.
5. **RDP / virtual display fallback** — environments without DXGI must degrade honestly to `source: "dxgi_dirty_rect_unavailable"`.
6. **`DirtyRectSubscriptionCache` amortisation** — chained `desktop_act` calls within the cache idle timeout (`STAGE5_CACHE_IDLE_TIMEOUT_MS`) must re-use the existing subscription without re-paying the DXGI init cost (~50-100 ms).
7. **Safety-net path** (opt-in only) — with `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1`, Stage 4 `indeterminate` + no `residual` results in `_mouse-verify` / `keyboard` get a Stage 5 observation attached but `verifiedDelivery` never upgrades (sub-plan §2.3.2 contract).

---

## Test matrix (template)

Scenarios are grouped by the environment they require. Maintainer note (2026-05-17): the primary dogfood environment is **single-monitor only**; dual-monitor scenarios (#5, #6) are formally **deferred to a future dual-monitor environment** and tracked in `Carry-over delta` below. The single-monitor MUST-PASS set still validates the v1.7.0 release per the Acceptance section.

### Single-monitor scenarios (runnable in any Windows 11 environment)

| # | Scenario | Op | Expected `motion` | Expected `source` | Notes |
|---|---|---|---|---|---|
| 1 | Notepad text-area click | `desktop_act` | `any_change` | `dxgi_dirty_rect` | baseline positive — caret + selection redraw |
| 2 | Notepad scroll (`PageDown`) | `desktop_act` | `any_change` | `dxgi_dirty_rect` | larger area than single click |
| 3 | VS Code editor click (line 1) | `desktop_act` | `any_change` | `dxgi_dirty_rect` | minimap + line-highlight repaint; verifies Electron/CEF apps work |
| 4 | Chrome address-bar click | `desktop_act` | `any_change` | `dxgi_dirty_rect` | browser top-level (Chromium widget class) |
| 7 | Lock screen → Unlock → `desktop_act` | `desktop_act` | `any_change` after recovery | `dxgi_dirty_rect` (after) | **AccessLost recovery** — first post-unlock call may degrade; second call must succeed |
| 9 | Chained `desktop_act` × 5 within 30 s | `desktop_act` × 5 | all `any_change` | all `dxgi_dirty_rect` | **cache amortisation** — observe verifyWallclockMs; cycles 2-5 should be faster than cycle 1 |
| 10 | Idle baseline (no input) | (none — passive observation) | `no_change` | `dxgi_dirty_rect` | true-negative — confirms the 0.5 % gate rejects ambient noise (clock ticks, taskbar animations) |
| 11 | `DESKTOP_TOUCH_STAGE5_DXGI=0` → `desktop_act` | `desktop_act` | (absent) | (absent) | env opt-out — `result.observation` field absent; bit-equal to pre-Stage-5 envelope |
| 12 | `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1` + Stage 4 `indeterminate` (e.g. Blender viewport click) | `desktop_act` then `keyboard:type` on a window that yields Stage 4 `indeterminate` | observation attached but `verifyDelivery.status` unchanged | `dxgi_dirty_rect` | safety-net contract — `verifiedDelivery` never upgrades (sub-plan §2.3.2) |

### Dual-monitor scenarios (DEFERRED — no dual-monitor dogfood environment available)

| # | Scenario | Status | Notes |
|---|---|---|---|
| 5 | Notepad on **secondary monitor** | **DEFERRED** | **PR #322 + #323 verification** — resolver picks `outputIndex >= 1`; observation arrives from that monitor. Unit-test coverage at `tests/unit/resolve-output-index.test.ts` already pins the resolver contract for multi-monitor input; this scenario validates that contract end-to-end against real DXGI hardware on a non-zero output. Re-attempt when a dual-monitor host is available. |
| 6 | Window spanning both monitors (drag Chrome across boundary) | **DEFERRED** | **Stage 5c carry-over** — `crossMonitor: true` path in `any-change.ts:380-399`. Today the observation falls back to the center-containing monitor; the v2 fix (simultaneous-output subscription) is tracked under sub-plan §7 Stage 5c carry-over. Re-attempt with dual-monitor environment when planning Stage 5c. |

### Optional / environment-dependent

| # | Scenario | Op | Expected `motion` | Expected `source` | Notes |
|---|---|---|---|---|---|
| 8 | RDP session (or `mstsc /v:localhost` to same machine) | `desktop_act` | `indeterminate` | `dxgi_dirty_rect_unavailable` | honest graceful degrade per sub-plan §6 R1; run if you have an RDP-reachable host. Skip if not applicable. |

---

## How to run

1. **Build current main** (PR #325 merged):
   ```pwsh
   npm run build
   ```
2. **Open the dogfood target app** (e.g. Notepad) and ensure it's the foreground window with a known HWND.
3. **Invoke `desktop_act`** via the MCP server. The simplest path:
   - From a Claude Code session connected to `desktop-touch-mcp` (after `npm publish` for v1.7.0 — see E-5), call:
     ```
     desktop_discover { "hint": "Notepad" }
     # then with the returned lease:
     desktop_act { "lease": ..., "action": "click" }
     ```
   - Inspect the response: `result.observation` field should be populated with `{ source, motion, residual?, ... }`.
4. **For per-scenario verification**, capture the raw envelope to `docs/adr-019-stage-5-dogfood-raw/<scenario-N>-<app>.txt`:
   ```pwsh
   # In the MCP-connected session, run desktop_act and pipe the result to a file
   ```
5. **Record findings below** (§ Findings) — one row per scenario.

---

## Observation method (what to look for in the envelope)

```jsonc
{
  "ok": true,
  "executor": "...",
  "diff": [...],
  "next": "refresh_view",
  "observation": {
    "source": "dxgi_dirty_rect",      // or "dxgi_dirty_rect_unavailable" on degrade
    "motion": "any_change",            // or "no_change" / "indeterminate"
    "residual": {                      // present only for source: "dxgi_dirty_rect"
      "fractionChanged": 0.0,          // (Stage 5 leaves SSIM-axis fields at 0)
      "dirtyRectCount": 3,             // count of DXGI dirty rects observed
      "totalIntersectedAreaPx": 4096,  // px² intersected with target rect (or sub-region)
      "ratioOfTargetArea": 0.012       // = totalIntersected / (target.width * target.height); gate at 0.005
    }
  }
}
```

- **Healthy positive**: `source: "dxgi_dirty_rect"`, `motion: "any_change"`, `ratioOfTargetArea >= 0.005`, `dirtyRectCount >= 1`.
- **Healthy negative** (true no-op): `motion: "no_change"`, `ratioOfTargetArea < 0.005`.
- **Honest degrade**: `source: "dxgi_dirty_rect_unavailable"`, `motion: "indeterminate"`, no `residual`.

---

## Findings (fill in during dogfood)

### 2026-05-17 — dogfood smoke during dormancy-fix exploration (operator: Claude Code session)

A dogfood smoke was run against the candidate dormancy fix at SHA `10982e2` (now held in `feature/adr-019-stage-5-dormancy-fix-deferred`) to verify the wire-up works at the envelope layer. The two scenarios below confirm that `result.observation` is now populated on both `desktop_discover({ windowTitle })` and `desktop_discover()` (no args) flows — the two paths PR #325 silently left dormant.

The same smoke also surfaced **seven unexpected degrades / regression candidates** documented in tracking issue **#327**. Three of them (B / C / D) look like daily-use regressions that would erode user trust if shipped. As a result, this PR has been narrowed to the lint fix only, and v1.7.0 release is blocked on closing #327. The dogfood data captured below is retained as raw evidence for the #327 investigation.

The pixel-level positive verification (`motion: any_change` with non-zero `residual`) was not reachable on this host because of the `dxgi_dirty_rect_unavailable` degrade described under "Environment-specific degrade" below — which is itself item A on #327.

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Notepad text-area click via `desktop_discover({ windowTitle: "メモ帳" })` | **PASS (wire-up)** | `result.observation` populated: `source: "dxgi_dirty_rect_unavailable", motion: "indeterminate", framesSampled: 0, totalElapsedMs: 45.6`. Proves the windowTitle-path dormancy fix (held in `feature/adr-019-stage-5-dormancy-fix-deferred`) reaches `verifyAnyChange` and emits an envelope-attached observation. `indeterminate` value is item A on #327 (vision-gpu coexistence), not introduced by the dormancy fix candidate. |
| 2 | Notepad text-area click via `desktop_discover()` (no args, foreground) | **PASS (wire-up)** | `result.observation` populated with the same shape as #1 — proves the foreground (`lastTarget === undefined`) dormancy-fix wire-up. Before the candidate fix, this path silently skipped `verifyAnyChange` and produced no `observation` field at all. |

**Conclusion for the dormancy-fix candidate**: at the envelope layer, the foreground / windowTitle wire-up works. Revival of the dormancy fix (restoring SHA `10982e2` from `feature/adr-019-stage-5-dormancy-fix-deferred`) is gated on the #327 items A and B being root-caused, because both items affect the value of the very `observation` field this fix newly populates — shipping the fix while A/B are unresolved would attach honest-but-useless `indeterminate` observations to every `desktop_act` envelope.

**Environment-specific degrade**: on this dogfood host both calls degraded to `source: "dxgi_dirty_rect_unavailable"` because vision-gpu (`src/engine/vision-gpu/dirty-rect-source.ts`) holds an exclusive DXGI `DirtyRectSubscription` on `outputIndex 0`, and DXGI returns `NotCurrentlyAvailable` for the second concurrent subscription. This is the documented fail-soft path per sub-plan §2.6 — it is **not** introduced by this PR. To exercise the positive path (`source: "dxgi_dirty_rect", motion: "any_change", residual.*`) on this host, restart the MCP server with `DESKTOP_TOUCH_DISABLE_DIRTY_RECTS=1` so vision-gpu releases the subscription before Stage 5 acquires it. The `any_change` healthy-positive case remains covered structurally by the unit tests in `tests/unit/any-change-orchestrator.test.ts`; an end-to-end MCP-roundtrip positive smoke can be appended below when an unblocked environment is available.

### Pending scenarios (not yet exercised — re-run after hotfix lands)

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Notepad text-area click (positive — `any_change`) | — | run with `DESKTOP_TOUCH_DISABLE_DIRTY_RECTS=1` to bypass vision-gpu coexistence |
| 2 | Notepad scroll PageDown | — | — |
| 3 | VS Code editor click | — | — |
| 4 | Chrome address-bar click | — | — |
| 5 | Notepad on secondary monitor | **DEFERRED** (no dual-monitor env) | n/a |
| 6 | Window spanning both monitors | **DEFERRED** (no dual-monitor env) | n/a |
| 7 | Lock / Unlock recovery | — | — |
| 8 | RDP session | — | — |
| 9 | Chained × 5 (cache amortisation) | — | — |
| 10 | Idle baseline | — | — |
| 11 | `DESKTOP_TOUCH_STAGE5_DXGI=0` opt-out | — | requires MCP restart with env var |
| 12 | `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1` safety-net | — | requires MCP restart with env var |

---

## Failure-mode catalogue (record + diagnose if hit)

| Symptom | Likely root cause | Investigation hint |
|---|---|---|
| Every call returns `source: "dxgi_dirty_rect_unavailable"` on a normal Windows desktop | `DirtyRectSubscription` constructor throwing on init (driver, missing addon) | Check `console.error` for `[desktop-register] Stage 5 disabled — ...`; verify `nativeDuplication.DirtyRectSubscription` is `function` |
| Secondary-monitor scenarios always report `out_of_range` or `off_screen` | `enumMonitors()` not returning multi-monitor data, or `outputBounds` empty | Inspect `enumMonitors()` output directly; verify PR #322 native binding present |
| Idle baseline (#10) reports `any_change` instead of `no_change` | 0.5 % gate too low, or ambient animation noise (Win11 widget panel) is hitting the target rect | Capture `dirtyRectCount` + `ratioOfTargetArea`; consider raising `STAGE5_MIN_INTERSECTED_AREA_RATIO` |
| Cache amortisation (#9) shows cycle 2-5 not faster than cycle 1 | Cache invalidated between calls (AccessLost / explicit dispose) | Inspect `cache.acquire()` / `cache.invalidate()` log; check `STAGE5_CACHE_IDLE_TIMEOUT_MS` |
| Lock / Unlock recovery (#7) fails on 2nd post-unlock call | `cache.invalidate()` not wired in AccessLost path | Trace `any-change.ts:403-407` (`E_DUP_ACCESS_LOST` branch) |
| Cross-monitor straddle (#6) reports `no_change` despite click-side repaint | Resolver picked the wrong (non-click) monitor | Inspect `resolveOutputIndexForHwnd` output; verify center-containment logic in `any-change.ts:280-298` |

---

## Carry-over delta (Stage 5b / Stage 5c followups discovered during dogfood)

(Fill in any new OQ / R items beyond what sub-plan §7 already enumerates.)

- **Stage 5b** (DXGI move rects): no new items yet.
- **Stage 5c** (cross-monitor straddle simultaneous subscription): no new items yet.

### 2026-05-17 — `VisualMotionObservation.cacheState` instrumentation (#327 item B)

Issue #327 item B added an optional `cacheState` field (5-value union: `hit-subscription` / `hit-unavailable` / `hit-negative-backoff` / `miss-init` / `miss-init-unavailable`) on `VisualMotionObservation` so dogfood logs can audit the cache hit/miss ratio directly. The field is **instrumentation-only**, optional, and adds no contract to the `desktop_act` envelope surface — Stage 5 sub-plan §2.6 documented fail-soft contract is unchanged.

Dogfood usage: after the first DXGI failure on a host (vision-gpu coexistence, RDP, virtual display, etc.), back-to-back calls must report `cacheState: "hit-negative-backoff"` — NOT `cacheState: "miss-init"`. Reporting `miss-init` repeatedly would indicate the back-off marker is failing to be set (a regression of the #327 item B fix). The unit tests at `tests/unit/dxgi-broker.test.ts` (ADR-020 SR-4 broker SSOT; superseded the deleted `tests/unit/dirty-rect-subscription-cache.test.ts`) + `tests/unit/any-change-orchestrator.test.ts` + `tests/unit/path-class-contract/b-dxgi-cache-state.test.ts` mechanically pin the contract.

### 2026-05-17 — Separate `STAGE5_UNAVAILABLE_TTL_MS` for marker persistence across Claude Code round-trips (#327 item B follow-up)

Surfaced by post-PR-#333 dogfood: 2 desktop_act calls separated by ~23 s wallclock showed `cacheState: "miss-init-unavailable"` on both (instead of the expected `hit-unavailable` on the 2nd). Empirical sweep proved the cache marker WAS being set correctly — the gap simply exceeded the 20 s `STAGE5_CACHE_IDLE_TIMEOUT_MS`, so `sweepStale` cleared the marker before the 2nd call.

Root cause: the 20 s timeout was originally chosen for subscription idle dispose (resource hygiene) and was being reused for the `unavailable` marker. But the marker's semantic is **permanent unavailability for this process lifetime** (vision-gpu coexistence, RDP, virtual display) — re-trying the factory every 20 s pays a ~50 ms init storm across typical 10-30 s Claude Code round-trips.

Fix: separated TTLs — `STAGE5_CACHE_IDLE_TIMEOUT_MS = 20_000` (subscription idle, unchanged) + new `STAGE5_UNAVAILABLE_TTL_MS = 60_000` (unavailable marker). The `negative-backoff` 2 s path is unchanged. Empirical dogfood after the fix shows back-to-back calls within 60 s report `cacheState: "hit-unavailable"` with `totalElapsedMs < 1 ms` (vs. ~40 ms cold). Unit tests at `tests/unit/dxgi-broker.test.ts` (ADR-020 SR-4 broker SSOT; the original `dirty-rect-subscription-cache.test.ts` was deleted in PR-SR4-2) pin the 60 s TTL and the test-only constructor override.

### Deferred validations (dual-monitor environment required)

The following two scenarios are deferred until a dual-monitor host is available; they must be re-attempted before Stage 5c v2 is shipped, because Stage 5c relies on multi-output subscription correctness that v1 only partially proves:

- **Scenario #5 — secondary-monitor desktop_act**: end-to-end DXGI subscription on `outputIndex >= 1` is currently only proven by unit tests at `tests/unit/resolve-output-index.test.ts`. Real hardware on a second monitor has never been exercised against `verifyAnyChange` since PR #322 + #323 lifted the v1 primary-only constraint.
- **Scenario #6 — cross-monitor straddle observation lower-bound**: the in-source comment at `src/engine/any-change.ts:380-399` claims the observation is an honest lower bound on motion when `crossMonitor: true`. The claim is structurally consistent (we never claim `no_change` if motion was detected on the observed monitor), but the *direction* assumption (that the observed monitor is the one operators care about) has not been empirically tested.

Both deferred scenarios are documented as **carry-over** rather than blocking the v1.7.0 release. Re-attempt timeline: bundled with Stage 5c v2 planning.

---

## Acceptance for v1.7.0 release

Stage 5 ships in v1.7.0 with `DESKTOP_TOUCH_STAGE5_DXGI=ON` by default. Before tagging:

- **MUST PASS**: scenarios #1, #2, #3, #10, #11 (single-monitor regression baseline + opt-out path) — all runnable in the current single-monitor environment.
- **SHOULD PASS**: scenarios #4, #7, #9 (cross-app coverage + AccessLost + cache).
- **MAY DEFER**: scenarios #8, #12 (RDP edge-case / opt-in safety-net) — record but do not block release.
- **FORMALLY DEFERRED (no environment)**: scenarios #5, #6 (dual-monitor). Not a release blocker — unit tests + structural review cover the contract; real-hardware validation happens when a dual-monitor host is available, before Stage 5c v2 ships.

If `MUST PASS` fails, the release is blocked and Stage 5 default must be flipped to OFF (toggle `DESKTOP_TOUCH_STAGE5_DXGI` default in `src/tools/desktop-register.ts`) before re-attempting.
