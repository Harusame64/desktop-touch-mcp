# ADR-019 Stage 5 sub-plan — `any_change` primitive via DXGI Desktop Duplication dirty rects

- Status: **Draft (Round 0, 2026-05-16)** — written after Stage 4 impl land (PR #318, `4768fea`) + Stage 4 dogfood (PR #319, `b75733d`) + Stage 4 deferred-P2 sweep (PR #320, `8509070`).
- Date: 2026-05-16
- Authors: Claude (Sonnet drafting, auto-mode `feature/adr-019-stage-5-plan` branch).
- Parent ADR: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Sibling sub-plans:
  - `docs/adr-019-stage-2a-plan.md` — `scroll_translation` temporal infrastructure (Stage 5 reuses `MIN_WAIT_MS`/`STABLE_THRESHOLD` ideas only at the higher orchestrator level)
  - `docs/adr-019-stage-2b-plan.md` — `scroll_translation` decision gate
  - `docs/adr-019-stage-4-plan.md` — `local_repaint` SSIM primitive (Stage 5 is its safety net for the R3 `MAX_RECT_AREA_PX` cap path)
- Predecessor PRs (must merge before Stage 5 impl):
  - PR #102 (ADR-007 P5c-2, `c535fc2`) — **already shipped** `IDXGIOutputDuplication` session + dirty-rect polling thread + AccessLost recovery in `src/duplication/{device,thread,types,mod}.rs`. This is the load-bearing infrastructure Stage 5 layers on top of.
  - PR #309 — `VisualMotionObservation` contract with the `"dxgi_dirty_rect"` source enum slot already reserved.
  - PR #318 — Stage 4 wiring patterns (`verifyLocalRepaint`, `VerifyDeliveryHint.observation` field).
- This PR (sub-plan only): branch `feature/adr-019-stage-5-plan`, **no production code change**.
- Successor: Stage 5 **impl PR** (~2-3 days, separate review cycle per CLAUDE.md §3.3).
- Walking-skeleton classification: **expansion** sub-plan for the `any_change` primitive (`scroll_translation` and `local_repaint` are already-shipped trunks; Stage 5 closes the 3rd of the 4 §1.3 primitives).

---

## 0. Why Stage 5 now (and why the scope is smaller than ADR §4 predicted)

ADR-019 §4 originally estimated Stage 5 at "5-7 days exploratory" because the DXGI session lifecycle, multi-monitor handling, and AccessLost recovery were unbuilt. They are now **already shipped** in `src/duplication/` (PR #102, ADR-007 P5c-2):

- `DirtyRectSubscription` napi class (`src/duplication/mod.rs:16`) — `new(output_index)` constructor, `next(timeout_ms): Promise<DirtyRect[]>`, `dispose()`, `outputBounds` getter.
- `DirtyRect` / `OutputBounds` types (`src/duplication/types.rs`) — `{x, y, width, height}` in monitor coords (DXGI returns output-relative; the thread already adds `bounds.x/y` to translate to desktop coords, see `device.rs:23` comment).
- AccessLost recovery (`thread.rs:91, 146`) — 5-consecutive-failures suppression already in place.
- L3 bridge `src/l3_bridge/dirty_rect_pump.rs` — already pumps dirty rects through L1 ring into engine-perception for ADR-008 D2-C `current_focused_element` view.

The original ADR-019 §4 framing predicted **DXGI session lifecycle would be the dominant cost**. PR #102 retired that cost. Stage 5 ships in **~2-3 days** as a thin orchestrator over the existing subscription.

Stage 5 closes the 3rd of the 4 §1.3 primitives:

| Primitive | Status | Sub-plan |
|---|---|---|
| `structured_state` | ✓ shipped (Stage 1, PR #309) | UIA `ScrollPercent` |
| `scroll_translation` | ✓ shipped (Stage 2a+2b, PR #311+#317) | temporal ring + finalChangedFraction gate |
| `local_repaint` | ✓ shipped (Stage 4, PR #318) | SSIM residual |
| **`any_change`** | **this sub-plan** | DXGI dirty rect intersection |

After Stage 5, only the future `structured_state` extensions (custom UIA patterns) and the deferred Stages 3/6/8 (phase correlation / optical flow / GPU dispatch) remain.

---

## 1. Context

### 1.1 What's already in place (do not re-build)

| Asset | Where | Stage 5 reuses |
|---|---|---|
| `IDXGIOutputDuplication` session + background polling thread | `src/duplication/device.rs` + `thread.rs` | yes — `DirtyRectSubscription.new(output_index)` is the entry point |
| Per-frame dirty-rect collection (`AcquireNextFrame` + `GetFrameDirtyRects`) | `src/duplication/thread.rs:156` (`acquire_dirty_rects`) | yes — feeds the existing `next(timeout_ms)` queue |
| AccessLost suppression (5 consecutive failures → silent stop) | `src/duplication/thread.rs:146` | yes — Stage 5 receives `DuplicationError::AccessLost` and degrades gracefully |
| `DirtyRect` + `OutputBounds` napi types | `src/duplication/types.rs` | yes — Stage 5 consumes `DirtyRect[]` returned from `next()` |
| `VisualMotionObservation` contract with `source: "dxgi_dirty_rect"` enum slot | `src/tools/_input-pipeline.ts:107` + ADR-019 §2.1 + ADR-018 §2.6 | yes — Stage 5 is the first emitter of this enum slot |
| `VerifyDeliveryHint.observation` field | `src/tools/_mouse-verify.ts` (PR #318) | yes — Stage 5 attaches observation via the same hint shape |
| `getWindowRectByHwnd` window-rect resolver | `src/engine/win32.ts` | yes — needed for window-rect intersection with output rects |
| `findContainingWindow(x, y)` hwnd resolver | `src/engine/win32.ts` | yes — for click-coord-based hwnd resolution (mirrors Stage 4) |

### 1.2 What Stage 5 must add

**Stage 5 v1 has 3 new TS components + 1 wiring task** (§2 enumerates exactly these 4 below; §3 SSOT table includes the new file impact + the existing-file SSOT extension):

1. **Output-index resolver** (component 1) — given an `hwnd` + `windowRect`, return the `output_index` of the monitor the window primarily lies on (= the monitor whose `DesktopCoordinates` contain the window's center point). **Full multi-monitor support** is now in scope after PR #322 (`3d1ab2a`) fixed `src/duplication/device.rs:77` to populate `OutputBounds` from `DXGI_OUTPUT_DESC.DesktopCoordinates`. Cross-monitor window handling (window straddling two outputs) falls back to primary-of-center with a `hints.warnings` entry; future Stage 5b refinement may subscribe to multiple outputs.
2. **`verifyAnyChange(opts)` orchestrator** (component 2) — TS function analogous to `verifyLocalRepaint`. Subscribes to the correct output, polls `next()` for a bounded window, intersects returned dirty rects with the target window's screen rect, and decides `motion: "any_change" | "no_change" | "indeterminate"`.
3. **Subscription cache** (component 3) — DXGI session init is ~50-100 ms. Per-call subscribe would dominate the verify latency. Cache the subscription per `output_index` with an idle-timeout dispose to amortise init across multiple verify calls. Coexistence with the existing `src/engine/vision-gpu/dirty-rect-source.ts` consumer is **locked via fail-soft** per §2.6 (which resolves §7 OQ #5).
4. **Wiring** (task — touches existing files; envelope schema extension required, see §2.5 + §3 row "desktop_act envelope extension") — `desktop_act` post-state verify (primary; **requires extending the `TouchResult` discriminated union to carry an optional `observation` field**), and an optional safety-net path for mouse_click / keyboard:type when Stage 4 returns `motion: "indeterminate"` due to the `MAX_RECT_AREA_PX` R3 cap or `stableReached: false` R6 path.

### 1.3 Scope boundary (Stage 5 vs adjacent stages)

| Concern | Stage 5 (this plan) | Adjacent stage |
|---|---|---|
| `desktop_act` post-state visible-change verify | **yes** (primary integration) | n/a |
| `any_change` primitive emit (`motion: "any_change"`, `source: "dxgi_dirty_rect"`) | **yes** | n/a |
| Window-rect intersection with output-level dirty rects | **yes** | n/a |
| Multi-monitor output-index resolution | **yes** (basic — primary-output-of-window) | future Stage 5 follow-up for cross-monitor windows |
| `mouse_click` / `keyboard:type` safety net when Stage 4 returns indeterminate | **partial** (gated on env opt-in, default-off) | Stage 4 follow-up if dogfood shows demand |
| Per-rect motion vector extraction (DXGI `GetFrameMoveRects`) | **no** — defer to Stage 5b carry-over | Stage 5b (`scroll_translation` priority-1 source candidate) |
| RDP / virtual-display fallback to software path (DXGI unsupported on RDP) | **no** (Stage 5 surfaces honest `indeterminate` + observation source records "dxgi_dirty_rect_unavailable") | future RDP support sub-plan |
| GPU dispatch | **n/a** (DXGI is already a GPU path — OS compositor) | Stage 8 |

---

## 2. Decision

Adopt an `any_change` primitive built on **three pillars** (orchestrator §2.1 + subscription cache §2.2 + activation gates §2.3) plus **three supporting subsections**: constants table §2.4, `TouchResult` discriminated-union extension lock §2.5, DXGI subscription coexistence lock §2.6 (resolves §7 OQ #5). Six subsections total under §2:

1. **`resolveOutputIndexForHwnd(hwnd)` TS helper** — query the window rect, walk the existing display catalogue (already used by `desktop_state({includeScreen:true})`) AND the per-output `OutputBounds` (now correctly populated by PR #322), return the index of the monitor whose `DesktopCoordinates` contain the window's center point. Cross-monitor windows (center on monitor boundary OR window straddling two outputs) fall back to primary-of-center with `hints.warnings` (per R3 + Stage 5c carry-over).
2. **`verifyAnyChange(opts)` orchestrator** — subscribes to the correct output (or reuses a cached subscription), polls `next(timeout_ms=POLL_BUDGET_MS)` for a bounded window, intersects returned rects with the target window's screen rect, returns `motion: "any_change" | "no_change" | "indeterminate"`.
3. **`DirtyRectSubscriptionCache`** — singleton map keyed by `output_index`, with an idle-timeout that disposes subscriptions after `STAGE5_CACHE_IDLE_TIMEOUT_MS = 20 sec` of no use (Round 1 P2-1 bumped from 10 sec — see §2.4 constants table). Stage 5's verify reuses the same subscription across desktop_act calls in a chain.

### 2.1 The orchestrator (TS)

```ts
/** ADR-019 Stage 5 — `any_change` primitive orchestrator. Called by
 *  `desktop_act` post-execution AND optionally as a safety net for
 *  `mouse_click` / `keyboard:type` when Stage 4 returns `indeterminate`. */
export async function verifyAnyChange(opts: {
  hwnd: bigint;
  /** Window rect in screen coords (output of `getWindowRectByHwnd`). */
  windowRect: { x: number; y: number; width: number; height: number };
  /** Optional sub-rect of `windowRect` to constrain the intersection
   *  (e.g. mouse_click pad). When omitted, the entire windowRect is used. */
  region?: { x: number; y: number; width: number; height: number };
  /** Wallclock budget for dirty-rect polling. Default `STAGE5_POLL_BUDGET_MS`. */
  budgetMs?: number;
}): Promise<VisualMotionObservation>;
```

Algorithm:

1. **Resolve output index** — `resolveOutputIndexForHwnd(opts.hwnd, opts.windowRect)` walks the existing display catalogue (the same `enumDisplayMonitors` path used by `desktop_state({includeScreen:true})`) AND the `DirtyRectSubscription.outputBounds` for each output (now correctly populated from `DXGI_OUTPUT_DESC.DesktopCoordinates` per PR #322 `3d1ab2a`), then returns the index of the output whose desktop rect contains the window's center point. Falls back to 0 (primary) on ambiguity (cross-monitor window with center on a boundary). When no output contains the center (window minimised / off-screen), Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` and `hints.warnings` recording the resolution failure.
2. **Acquire subscription** — `DirtyRectSubscriptionCache.acquire(outputIndex)`. Returns existing or creates new. On `DuplicationError::Unsupported` (RDP / virtual display) → return `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` (new enum slot — see R1). On any other `Duplication*` error during cache acquire (including the secondary-subscription-on-same-output `NotCurrentlyAvailable` case that may arise from `src/engine/vision-gpu/dirty-rect-source.ts` already owning the output) → same fail-soft path: `motion: "indeterminate"`, `source: "dxgi_dirty_rect_unavailable"`. See §2.6 + §6 R10/R11.
3. **Poll for dirty rects** — `await subscription.next(budgetMs)`. Returns `DirtyRect[]` in **desktop screen coords** (the Rust thread translates output-local rects via `+OutputBounds.x/y` per `thread.rs:271-272`; now correct for all monitors after PR #322 `3d1ab2a`). On timeout (no dirty rects in window), returns empty array.
4. **Intersect with target rect** — for each dirty rect, compute intersection with `region ?? windowRect`. Sum the intersected area.
5. **Decide motion**:
   - intersected area ratio `>= STAGE5_MIN_INTERSECTED_AREA_RATIO` (default `0.005` = 0.5 % of target rect) → `motion: "any_change"`, `source: "dxgi_dirty_rect"`, attach `residual: { dirtyRectCount: N, totalIntersectedAreaPx: A, ratioOfTargetArea: A/(targetW*targetH) }` (new residual fields — see SSOT extension below). The ratio gate (vs an absolute pixel count) discriminates real action-caused repaint from sub-pixel noise / background animation faintly touching the target; see §6 R5 expanded for the rationale.
   - intersected area > 0 but ratio `< STAGE5_MIN_INTERSECTED_AREA_RATIO` → `motion: "no_change"`, `source: "dxgi_dirty_rect"`, residual populated for audit. (Tiny overlap — likely background animation grazing the target rect; honest under-claim.)
   - intersected area `=== 0` AND `rects.length > 0` → `motion: "no_change"`, `source: "dxgi_dirty_rect"`, attach `residual: { dirtyRectCount: N, totalIntersectedAreaPx: 0, ratioOfTargetArea: 0 }`. (Other parts of the desktop changed but not the target.)
   - empty `rects` → `motion: "no_change"`, `source: "dxgi_dirty_rect"`, residual omitted (no observation activity at all; cheapest path).
   - subscription error other than `Unsupported` / `NotCurrentlyAvailable` (e.g. `AccessLost`) → `motion: "indeterminate"`, `source: "dxgi_dirty_rect"`, no residual.
6. **Never throw** — every error path returns a degraded observation. Stage 5 must not break the caller's existing envelope (same invariant as Stage 4 §9).

### 2.2 Subscription cache (TS)

```ts
class DirtyRectSubscriptionCache {
  acquire(outputIndex: number): DirtyRectSubscription;
  release(outputIndex: number): void;  // touches lastUsedAt
  // Background timer disposes any subscription whose lastUsedAt < now - CACHE_IDLE_TIMEOUT_MS
  // Called by both verify orchestrator + server shutdown hook.
  disposeAll(): void;
}
```

Lifecycle:

- First `acquire(0)` creates subscription, takes ~50-100 ms (DXGI session init).
- Subsequent `acquire(0)` within 20 sec (`STAGE5_CACHE_IDLE_TIMEOUT_MS`) returns cached subscription, takes < 1 ms.
- 20 sec idle → background timer calls `subscription.dispose()` + removes from cache.
- Server shutdown → `disposeAll()` releases all subscriptions cleanly.

This matches the **session-lifecycle** pattern from ADR-008 D2-0 (`ensure_perception_pipeline` / `shutdown_perception_pipeline_for_test`) so Stage 5 inherits the same shutdown-safety guarantees.

### 2.3 Activation gates

#### 2.3.1 `desktop_act` post-state verify

Stage 5 fires iff **all** of:

1. The dispatcher (`desktop-executor.ts`) returned `ok: true` (action landed) — Stage 5 is for **observing** the post-state, not for diagnosing dispatch failures.
2. The target window's `hwnd` is resolvable (from the lease / target spec).
3. `process.env.DESKTOP_TOUCH_STAGE5_DXGI !== "0"` (default ON; opt-out by setting to `"0"`).
4. The cached subscription returns successfully (or initialises on first call) — `Unsupported` (RDP) gracefully degrades to `motion: "indeterminate"` per §2.1 step 5.

When Stage 5 fires, the `desktop_act` envelope adds `hints.verifyDelivery.observation: VisualMotionObservation`. The existing `desktop_act` ok/error contract is unchanged (additive only).

#### 2.3.2 `mouse_click` / `keyboard:type` safety net (default OFF, opt-in)

Stage 5 fires as a safety net iff **all** of:

1. `verifyLocalRepaint` returned `motion: "indeterminate"` AND `source: "ssim_residual"` AND no `residual` field (= R3 `MAX_RECT_AREA_PX` cap path OR R6 `stableReached: false`).
2. `process.env.DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK === "1"` (opt-in; default OFF because (a) Stage 5 init cost on first call is meaningful, (b) Stage 4 already returns honestly degrade — adding Stage 5 risks false-positive on background animations the user didn't trigger).
3. Otherwise: Stage 5 not invoked, Stage 4's `indeterminate` flows through unchanged (caller keeps `focus_only` / `unverifiable`).

When Stage 5 fires as fallback and returns `motion: "any_change"`, the wrapper **does NOT upgrade** the verify status — the observation is attached but the existing `focus_only` / `unverifiable` is preserved. Rationale: DXGI dirty rect is too coarse (window-level any-change) to confidently claim the user's click caused the change vs background animation. Stage 5's job here is to record evidence, not adjudicate.

### 2.4 Time-base and constants

| Constant | Value | Why |
|---|---|---|
| `STAGE5_POLL_BUDGET_MS` | 100 | aligned to DXGI single-frame budget at 60 Hz (16.7 ms × ~6 frames); short enough to keep `desktop_act` round-trip under sub-100 ms overhead |
| `STAGE5_CACHE_IDLE_TIMEOUT_MS` | **20000** | 20 sec — covers longer desktop_act chains AND tool-chain pauses (Stage 4 dogfood Paint.NET 20-cycle chain ≈ 10 sec was right at the prior 10-sec boundary; 20 sec gives 2× headroom — Opus Round 1 P2-1). Disposed by server shutdown hook for clean exit. |
| `STAGE5_MAX_OUTPUT_INDEX` | 8 | hard cap on output_index to prevent runaway enumeration on hypothetical 9+ monitor setups. **Now actively used in v1** (Stage 5 ships with full multi-monitor support after PR #322 `3d1ab2a`); `resolveOutputIndexForHwnd` clamps to this cap, emitting `dxgi_dirty_rect_unavailable` + `hints.warnings` if a window resolves above. |
| `STAGE5_MIN_INTERSECTED_AREA_RATIO` | **0.005** (= 0.5 % of target rect area) | **relative-area gate, NOT absolute pixel count** (Opus Round 1 P2-5). Discriminates real action-caused repaint from background animation faintly touching the target rect (e.g. clock-tick / notification toast sliver). Examples: 800×600 target → threshold ≈ 2400 px ≈ 49×49 region. 200×200 focus pad → threshold ≈ 200 px ≈ 14×14. Calibrated to be permissive enough for small button highlights yet reject 1-2 px noise. |

Constants live in `src/engine/any-change.ts` (new module) alongside the orchestrator.

### 2.5 `TouchResult` discriminated-union extension (envelope shape lock)

**Decision lock (Opus Round 1 P1-3 + R6 expanded)**: Stage 5 must extend `TouchResult` (`src/engine/world-graph/guarded-touch.ts:46`) — the `desktop_act` result discriminated union — to carry an optional `observation: VisualMotionObservation` field. The current shape:

```ts
export type TouchResult =
  | { ok: true; executor: ExecutorKind; diff: SemanticDiff; next: ... }
  | { ok: false; reason: TouchFailReason; diff: SemanticDiff; blockingElement?: ... };
```

has NO `hints` field today (verified `src/tools/desktop.ts:120` — only `attention?: AttentionState` at the top level). Stage 5 extends the `ok: true` variant **only** (Stage 5 attaches observation post-execution, so it never runs on `ok: false`):

```ts
| { ok: true; executor: ExecutorKind; diff: SemanticDiff; observation?: VisualMotionObservation; next: ... }
```

The wiring in §3 row "desktop_act envelope extension" must:
1. Extend the `TouchResult.ok: true` variant signature in `guarded-touch.ts:46`.
2. Thread the new field through `desktop-executor.ts` (record observation after successful execution).
3. Thread the new field through `desktop-register.ts` (surface observation in MCP envelope as `hints.verifyDelivery.observation` to match the Stage 4 mouse_click pattern).
4. CLAUDE.md §3.1 sweep across **all `TouchResult` consumers** (run `Grep "TouchResult|\.ok === true.*executor" src/` to enumerate). Currently estimated at ~3-5 sites.
5. NO existing consumer that destructures `ok: true` variants should break (the field is optional — `observation?:` — so existing destructures of `{ok, executor, diff, next}` still work).

This is materially larger than the prior draft's "desktop_act envelope extension" row estimate (~30-50 lines). Revised estimate: ~60-100 lines additive across 3-5 files. Still bounded; still v1 doable in 2-3 days impl, but accounted for honestly. (Round 4 P2-1 dropped the brittle "§3 row 6" ordinal since row positions shifted across review rounds.)

### 2.6 DXGI subscription coexistence lock (resolves §7 OQ #5)

**Decision lock (Opus Round 1 P1-4)**: there are two DXGI subscription consumers in the codebase today:

1. `src/engine/vision-gpu/dirty-rect-source.ts:124-133` — instantiates `DirtyRectSubscription` directly via `addon["DirtyRectSubscription"]` (untyped escape hatch). On-demand activation when vision-gpu backend is invoked.
2. `src/l3_bridge/dirty_rect_pump.rs` — subscribes to the **L1 ring** (NOT the `DirtyRectSubscription` napi), observing dirty-rect events that `src/duplication/thread.rs:297-313` forks into the L1 ring. So the pump does NOT own a subscription; it consumes whatever vision-gpu (or now Stage 5) drives.

DXGI's per-output `DuplicateOutput` typically returns `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` for a second concurrent subscription on the same output. So if vision-gpu has already constructed a subscription on output 0, Stage 5's cache attempting to construct another on output 0 will fail.

**Lock**: Stage 5 v1 ships **fail-soft coexistence**:

- When `DirtyRectSubscriptionCache.acquire(0)` returns a DXGI error (`NotCurrentlyAvailable` / `Unsupported` / `Other`), Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` (§2.1 step 2 + step 5 cover this). The caller's envelope still succeeds (action ok, observation degraded honestly).
- The DXGI subscription thread already forks events to the L1 ring (`thread.rs:297-313`), so when Stage 5 IS the subscription owner, `dirty_rect_pump.rs` continues to receive events and the engine-perception `current_focused_element` view stays alive. Stage 5 is therefore the **L1 ring's data source** when active.
- When Stage 5 is NOT active (cache idle-timed-out OR Unsupported), vision-gpu may still create its own subscription on demand. The two consumers race for first-acquire; whoever wins, the L1 ring sees events from the active one. This is honest under-claim — no false data, just possible-degraded coverage windows.

**Stage 5b carry-over**: a single shared `DirtyRectSubscriptionCache` for both Stage 5 + vision-gpu + future consumers is a clean follow-up but materially expands v1 scope (vision-gpu refactor + ownership model). Documented as Stage 5b OQ — not blocking v1.

---

## 3. Affected components (SSOT)

| File | Stage 5 change |
|---|---|
| **`src/engine/any-change.ts`** (NEW) | `verifyAnyChange` orchestrator + `resolveOutputIndexForHwnd` helper + `DirtyRectSubscriptionCache` + Stage 5 constants. ~200-300 line module. |
| **`index.d.ts`** (Opus Round 1 P1-2) | **Add `DirtyRectSubscription` napi class declaration + `NativeDirtyRect` + `NativeOutputBounds` interfaces**. Verified absent today (line 590 has zero hits for "DirtyRectSubscription"; `src/engine/vision-gpu/dirty-rect-source.ts:124-133` reaches the class via `addon["DirtyRectSubscription"]` untyped escape hatch precisely because the SSOT is missing). This is **NOT** "SSOT sync only" — it adds the canonical type declaration that vision-gpu's escape hatch can also migrate to in a future cleanup. |
| **`index.js`** (Opus Round 1 P1-2) | Re-export `DirtyRectSubscription` via the existing ESM `createRequire` hand-maintained pattern (`memory/feedback_esm_napi_loader.md` + `memory/feedback_napi_default_export.md`). |
| **`src/engine/native-types.ts`** | Add `NativeDirtyRect` + `NativeOutputBounds` re-exported interface types AND `NativeDirtyRectSubscription` constructor signature. Materially extends the file — not sync-only as the prior draft claimed (Opus Round 1 P1-2 + P2-3). |
| **`src/engine/native-engine.ts`** | Add `DirtyRectSubscription: { new(outputIndex?: number): NativeDirtyRectSubscription }` constructor reference to the `NativeEngine` interface. |
| **`src/tools/_input-pipeline.ts:VisualMotionObservation`** | Extend `residual?` to include optional `dirtyRectCount?: number`, `totalIntersectedAreaPx?: number`, `ratioOfTargetArea?: number` (Stage 5-specific fields, optional on the existing residual shape). Update TSDoc. |
| **`src/tools/_input-pipeline.ts:source enum`** | Add `"dxgi_dirty_rect_unavailable"` enum value to the existing 8-value source enum (the RDP / virtual-display / subscription-not-available graceful-degrade label). This is a **NEW enum value** — CLAUDE.md §3.1 sweep required (see §6 R1 below). |
| **`src/engine/world-graph/guarded-touch.ts`** (Opus Round 1 P1-3) | **Extend `TouchResult.ok: true` discriminated-union variant** to carry `observation?: VisualMotionObservation`. See §2.5 for the full lock decision. |
| **desktop_act envelope extension** — `src/tools/desktop-executor.ts` + `src/tools/desktop-register.ts` + `src/engine/world-graph/guarded-touch.ts` | Wire `verifyAnyChange` into the `desktop_act` handler's post-execution path. Surface observation through `TouchResult.ok: true` (§2.5) → MCP envelope `hints.verifyDelivery.observation`. Gate on `DESKTOP_TOUCH_STAGE5_DXGI !== "0"`. ~60-100 lines additive across 3-5 files (revised from prior draft's "30-50 lines" — Opus Round 1 P1-3). |
| **`src/tools/_mouse-verify.ts`** | Add optional Stage 5 fallback inside `classifyDeliveryWithLocalRepaint` — when `verifyLocalRepaint` returned `indeterminate` AND `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1`, call `verifyAnyChange` and attach observation (no status upgrade per §2.3.2). ~20 lines additive. |
| **`src/tools/keyboard.ts:keyboardTypeHandler`** | Same Stage 5 fallback at the BG-verify `unverifiable + read_back_unsupported` sink — env-gated, observation-only. ~15 lines additive. |
| **`docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`** | §2.1 enum extension (add `"dxgi_dirty_rect_unavailable"`); §3 SSOT correction (`src/image/dxgi_duplication.rs` doesn't exist — actual implementation lives at `src/duplication/{device,thread,mod,types}.rs` from PR #102; Stage 5 adds `src/engine/any-change.ts`); §4 Stage 5 section update with the smaller scope estimate (2-3 days impl, not 5-7); §7 OQ #4 ("DXGI per-window mapping") marked **Resolved** by the window-rect intersection design in §2.1 step 4; record the `device.rs` multi-monitor bounds limitation as an acknowledged carry-over. |
| **`docs/adr-018-input-pipeline-3tier.md`** §2.6 enum reference | Add the new `"dxgi_dirty_rect_unavailable"` value + a one-line note that `desktop_act` is now the second tool (after `mouse_click` / `keyboard:type` via Stage 4) to attach an `observation` field. |
| **`tests/unit/any-change-orchestrator.test.ts`** (NEW) | 8-12 unit cases — `verifyAnyChange` with mocked `DirtyRectSubscription.next` returning various rect arrays (empty / inside-target / outside-target / partial-overlap / Unsupported error / AccessLost error / NotCurrentlyAvailable error — Stage 5 v1 lock §2.6). Test ratio gate at boundary (just below 0.5 %, just above). Test cache acquire/release/dispose lifecycle. |
| **`tests/unit/dirty-rect-subscription-cache.test.ts`** (NEW) | 6 cases — singleton behaviour, 20-sec idle timeout dispose, shutdown hook, **multi-output independence** (actively exercised in v1 after PR #322 multi-monitor scope restore), Unsupported caching (don't retry init for `STAGE5_CACHE_IDLE_TIMEOUT_MS`). Mock `DirtyRectSubscription` constructor. |
| **`tests/unit/resolve-output-index.test.ts`** (NEW) | **5 cases** (multi-monitor reinstated after PR #322 device.rs fix) — single-monitor primary returns 0; dual-monitor secondary window returns 1; window center on monitor boundary falls back to 0 (primary) with warning; window off-screen returns `unavailable` indeterminate; output_index > MAX_OUTPUT_INDEX warning (forward-looking ceiling). |
| **`benches/dogfood_stage_5.mjs`** (NEW, post-impl) | Real-app dogfood harness analogous to `dogfood_stage_4.mjs` — drive desktop_act on a known target, observe dirty rect count + intersected area. |

Stage 5 does **NOT** touch: `src/ssim.rs`, `src/pixel_diff.rs`, `src/engine/local-repaint.ts` (Stage 4 internals unchanged), `src/duplication/{device,thread}.rs` (PR #102 infrastructure unchanged — only consumed), `src/tools/scroll.ts`, browser tools, perception graph, vision-gpu modules.

---

## 4. Implementation plan (Phase checklist for the impl PR)

The sub-plan PR closes here; below is the checklist the **impl PR** flips `[ ]` → `[x]`.

- [x] **P0 (prerequisite — DONE by PR #322 `3d1ab2a`)** — `src/duplication/device.rs:77` placeholder replaced with `IDXGIOutput::GetDesc()` + `DesktopCoordinates`. Multi-monitor `DirtyRect` coordinate translation now correct for all outputs. Stage 5 impl ships with full multi-monitor scope (no v1 / v2 split).
- [ ] **P1** — `src/engine/any-change.ts` new module: `resolveOutputIndexForHwnd` (walks `enumDisplayMonitors` + per-output `OutputBounds` via the new typed `DirtyRectSubscription` SSOT — see P4; returns the output index containing the window's center) + `DirtyRectSubscriptionCache` (20-sec idle timeout + Unsupported-failure caching per §2.6 fail-soft, keyed by output_index to support multi-monitor) + `verifyAnyChange` orchestrator + Stage 5 constants. Scalar implementation; no SIMD work (DXGI is already GPU).
- [ ] **P2** — `src/tools/_input-pipeline.ts`: extend `VisualMotionObservation.residual` with optional Stage 5 fields (`dirtyRectCount?`, `totalIntersectedAreaPx?`, `ratioOfTargetArea?`); add `"dxgi_dirty_rect_unavailable"` to the source enum.
- [ ] **P3** — `tests/unit/{any-change-orchestrator,dirty-rect-subscription-cache,resolve-output-index}.test.ts` (≥ 19 cases total: 8-12 orchestrator + 6 cache + 5 resolver — resolver bumped from 3 to 5 after PR #322 multi-monitor scope restore, see §3 SSOT row).
- [ ] **P4** — `index.d.ts` + `index.js` + `src/engine/native-{types,engine}.ts`: add `DirtyRectSubscription` napi class declaration + `NativeDirtyRect` / `NativeOutputBounds` interfaces + ESM `createRequire` re-export. This formalises the SSOT that `src/engine/vision-gpu/dirty-rect-source.ts` currently bypasses (Opus Round 1 P1-2). Vision-gpu's escape hatch can migrate in a follow-up cleanup.
- [ ] **P5** — `src/engine/world-graph/guarded-touch.ts`: extend `TouchResult.ok: true` variant with `observation?: VisualMotionObservation` (§2.5 lock). Grep all `TouchResult` consumers (~3-5 sites) and verify additive-only — destructures of `{ok, executor, diff, next}` continue to work without the new field.
- [ ] **P6** — `src/tools/desktop-executor.ts` + `src/tools/desktop-register.ts`: wire `verifyAnyChange` into post-execution path. Resolve target hwnd from lease/spec; populate `TouchResult.observation` on success; surface in MCP envelope `hints.verifyDelivery.observation`. Gate on `DESKTOP_TOUCH_STAGE5_DXGI !== "0"`.
- [ ] **P7** — `src/tools/_mouse-verify.ts:classifyDeliveryWithLocalRepaint`: add Stage 5 fallback when Stage 4 returns `indeterminate` AND `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK === "1"` (default OFF). Observation-only; no status upgrade.
- [ ] **P8** — `src/tools/keyboard.ts:keyboardTypeHandler`: mirror the Stage 5 fallback at the BG-verify `unverifiable + read_back_unsupported` sink, gated on `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK === "1"`.
- [ ] **P9** — `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` + `docs/adr-018-input-pipeline-3tier.md` docs sync per §3 table above.
- [ ] **P10** — Full `npm run test:capture` regression sweep; expect zero new failures (Stage 5 is additive; existing tests use no DXGI mocks).
- [ ] **P11** — Post-merge dogfood — populate `docs/adr-019-stage-5-followups.md` with ≥ 30-cycle desktop_act runs against ≥ 2 real targets (e.g. Notepad menu open + Calculator button click).
- [ ] **P12** — CLAUDE.md §3.1 sweep: grep `observation.source` enum values across ADR-019 / ADR-018 / `_input-pipeline.ts` / `index.d.ts` / `tests/` to confirm the new `"dxgi_dirty_rect_unavailable"` value is consistently applied. Confirm count goes from 8 → 9 enum values in every SSOT surface. Also sweep `TouchResult.observation` extension across all `TouchResult` consumers (P5 references this; P12 verifies).

---

## 5. Acceptance criteria

- **G5-1 (functional, desktop_act post-state)** — `desktop_act` against a known visible-change target (e.g. menu open) attaches `hints.verifyDelivery.observation` with `motion: "any_change"`, `source: "dxgi_dirty_rect"`, `residual.dirtyRectCount > 0`, AND `residual.ratioOfTargetArea >= STAGE5_MIN_INTERSECTED_AREA_RATIO (0.005)`. (The ratio gate prevents background-animation-grazing-the-target from being claimed as `any_change` — see §6 R5 expanded.)
- **G5-2 (functional, no-change baseline)** — `desktop_act` against an idle / no-effect target (e.g. clicking on a hot-key that does nothing) returns `motion: "no_change"` with EITHER (a) `rects.length === 0` and `residual` omitted (empty-rect path; cheapest), OR (b) `rects.length > 0` with `residual.totalIntersectedAreaPx === 0` (rects exist but missed the target), OR (c) `rects.length > 0` with `residual.totalIntersectedAreaPx > 0` but `residual.ratioOfTargetArea < STAGE5_MIN_INTERSECTED_AREA_RATIO` (background grazing — Codex Round 1 P2 relaxation). All three are valid `no_change` outcomes per §2.1 step 5.
- **G5-3 (no regression on Stage 4)** — `mouse_click` / `keyboard:type` with `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=0` (default) emits exactly the pre-Stage-5 envelope. Stage 4 outputs bit-equal. Asserted by re-running the Stage 4 dogfood (PR #319) against the post-Stage-5 build.
- **G5-4 (env opt-out, desktop_act)** — `DESKTOP_TOUCH_STAGE5_DXGI=0` suppresses Stage 5 entirely on the desktop_act path; envelope omits `observation`. Bit-equal pre-Stage-5 contract.
- **G5-5 (Unsupported graceful degrade)** — On RDP / virtual-display where DXGI returns `Unsupported`, Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` and no `residual`. `desktop_act` envelope still succeeds (action ok, observation degraded). Pinned by unit test mocking the Unsupported error.
- **G5-5b (coexistence fail-soft graceful degrade)** — When DXGI returns `NotCurrentlyAvailable` (vision-gpu/dirty-rect-source.ts already owns the output 0 subscription — see §2.6 lock), Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` and the cache marks output 0 as Unavailable for `STAGE5_CACHE_IDLE_TIMEOUT_MS` to avoid retry storm. Pinned by unit test.
- **G5-6 (AccessLost graceful degrade)** — When the DXGI session is lost mid-flight (display sleep / suspend), Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect"` and the cache invalidates the subscription so the next call re-initialises. Pinned by unit test mocking AccessLost error after N successful calls.
- **G5-7 (cache amortisation)** — Within a single `desktop_act` chain (3+ sequential acts in < 20 sec, the new `STAGE5_CACHE_IDLE_TIMEOUT_MS`), subscription init cost is paid ONCE. Bench-asserted: first-call p99 ≤ 150 ms, subsequent-call p99 ≤ 100 ms (the `STAGE5_POLL_BUDGET_MS` ceiling). After 20 sec of idle, the next call re-initialises (~50-100 ms).
- **G5-8 (latency budget, integration)** — `verifyAnyChange` wallclock p99 ≤ **150 ms** end-to-end (including first-call init). Subsequent calls in a chain p99 ≤ 100 ms (dominated by `STAGE5_POLL_BUDGET_MS`).
- **G5-9 (CLAUDE.md §3.1 multi-table sweep)** — `observation.source` enum extended from 8 → 9 values, bit-equal across all 3 SSOT surfaces (ADR-019 §2.1 / `_input-pipeline.ts:VisualMotionObservation` / ADR-018 §2.6). `observation.residual.{dirtyRectCount, totalIntersectedAreaPx, ratioOfTargetArea}` Stage 5-specific additions documented in TSDoc + ADR-019 §2.1. **PLUS** `TouchResult.ok: true` variant extension (§2.5) bit-equal across `guarded-touch.ts` + all `TouchResult` consumers (~3-5 sites grep-enumerated).
- **G5-10 (CLAUDE.md §3.2 carry-over scope shrink)** — No exhaustive `switch (observation.source)` exists in `src/` (grep returns zero hits). Stage 5 is additive only — no existing API contract breaks. Existing `desktop_act` callers that destructure `TouchResult.ok: true` without naming the new `observation` field are unaffected (optional field).
- **G5-11 (multi-monitor correctness)** — **REINSTATED after PR #322** (`3d1ab2a` populated `OutputBounds` from `DXGI_OUTPUT_DESC.DesktopCoordinates`, lifting the v1 primary-monitor-only constraint). Window on secondary monitor → subscription targets the correct output index resolved by `resolveOutputIndexForHwnd` walking `enumDisplayMonitors` + the now-correct `outputBounds`. Pinned by unit test with mocked `enumDisplayMonitors` returning 2 monitors and `getWindowRectByHwnd` returning a rect inside monitor 1's bounds. Cross-monitor windows (center on boundary) fall back to primary with `hints.warnings` — separately pinned. Full-multi-output subscription for windows materially straddling two monitors is a future Stage 5b refinement.
- **G5-12 (post-merge dogfood report)** — `docs/adr-019-stage-5-followups.md` populated within 1 week of impl PR merge with ≥ 30 cycles across ≥ 2 real desktop_act targets ON BOTH primary AND secondary monitor (dual-monitor host required). Single-monitor-only dogfood acceptable as fallback if dual-monitor host unavailable, with explicit note recording the gap.

---

## 6. Risks

- **R1 — New enum value `"dxgi_dirty_rect_unavailable"` requires §3.1 sweep across 3 SoTs** — Stage 4 sub-plan was careful to NOT add new enum values (sub-plan §0.1 #2 explicitly locked "no new enum values"). Stage 5 reintroduces one. **Mitigation**: P2 adds the enum value to `_input-pipeline.ts`; P12 explicitly does the §3.1 sweep across all 3 SoTs (ADR-019 §2.1 + `_input-pipeline.ts` + ADR-018 §2.6 reference). The new value's semantics are precise (RDP / virtual-display where DXGI is unavailable at the OS level — distinct from `dxgi_dirty_rect` which means DXGI is available but observed no relevant change). Alternative considered: reuse `"chain_trust_unverified"` as a generic "observation unavailable" label, rejected because that source has scroll-specific semantics that would confuse desktop_act consumers.

- **R2 — DXGI subscription cache leak on server shutdown** — if the cache's background idle-timer fires while shutdown is in flight, OR if shutdown happens before `disposeAll()` is wired, the DXGI session leaks (Windows will reclaim on process exit, but interim correctness suffers). **Mitigation**: wire `DirtyRectSubscriptionCache.disposeAll()` into the MCP server shutdown hook (same surface as ADR-008 D2-0 `shutdown_perception_pipeline_for_test`). Unit test the shutdown path.

- **R3 — Output-index resolution on cross-monitor windows** — a window straddling two monitors has ambiguous primary-output. Current design (§2.1 step 1) uses the window's center point. If the center is on monitor A but most of the action is on monitor B, Stage 5 misses changes on B. **Mitigation**: `resolveOutputIndexForHwnd` returns the primary-of-center monitor's index AND attaches a `hints.warnings` entry recording the straddle (`cross_monitor_window: primary_used = N, secondary_seen = M`). Single-monitor windows on any monitor are correctly handled (G5-11 reinstated after PR #322). Multi-output simultaneous subscription for materially-straddling windows is **Stage 5c carry-over** (§7 OQ #6) — current single-output v1 covers the common case (>95% of windows fit entirely within one monitor per Windows HW survey).

- **R4 — RDP / virtual-display fail-soft cost** — every `desktop_act` on RDP would pay the failed DXGI init cost (~50 ms?). **Mitigation**: cache the `Unsupported` failure for `STAGE5_CACHE_IDLE_TIMEOUT_MS` so RDP sessions don't retry the init for every act. Same cache structure as success path; the cached "subscription handle" is a sentinel marker recording the Unsupported state.

- **R5 — False positive on background animation overlapping the target rect** — a video playing inside the target window OR a chat notification popup overlapping OR clock-tick repaint OR animated cursor blink → dirty rects intersect the target rect even when the user's action didn't cause them. The 100 ms `STAGE5_POLL_BUDGET_MS` window can easily catch a notification toast that intersects the target rect for a few ms. **Mitigations**: (a) Stage 5 is **observational not adjudicative** on the safety-net path (§2.3.2: never upgrades verify status). (b) On the desktop_act path, the `STAGE5_MIN_INTERSECTED_AREA_RATIO = 0.005` (0.5 % of target rect) gate (§2.4 constants) discriminates real action-caused repaint from sliver-grazing animation — Opus Round 1 P2-5 specifically called this out: a 4-pixel absolute threshold was far too low. (c) Document explicitly that desktop_act observation is heuristic; LLM should consult other signals (`ok` + `executor.kind` + `diff`) when high confidence is needed. (d) Stage 5b OQ: empirical per-app calibration of the threshold ratio.

- **R6 — `desktop_act` envelope schema impact** — Stage 5 adds `hints.verifyDelivery.observation` to `desktop_act`'s envelope. Currently `desktop_act` does NOT have a `verifyDelivery` hint at all (verified via grep — Stage 4 covers `mouse_click` / `keyboard:type` only). The `TouchResult` discriminated union also has NO `hints` field today (`src/engine/world-graph/guarded-touch.ts:46`). **Mitigation**: P5 extends `TouchResult.ok: true` with `observation?:` (§2.5 lock); P6 (desktop_act wiring at `desktop-executor.ts` + `desktop-register.ts`) populates that field post-execution AND surfaces it through the MCP envelope as `hints.verifyDelivery.observation` for callers' downstream parity with Stage 4. The observation shape is already shared via `_mouse-verify.ts` types, so reuse is straightforward.

- **R7 — CLAUDE.md §3.1 multi-table fact integrity (Stage 4-style sweep needed)** — `observation.residual` shape lives in 3 SoT surfaces today (`{ fractionChanged, centroid?, meanSsim? }`). Stage 5 adds 3 fields (`dirtyRectCount?`, `totalIntersectedAreaPx?`, `ratioOfTargetArea?`). **Mitigation**: same P15-style decision pattern as Stage 4 — extend the shape across all 3 SoTs in the same impl PR (no follow-up retro-review needed if done atomically).

- **R8 — CLAUDE.md §3.2 carry-over scope shrink** — Stage 5 is additive (new orchestrator, new envelope field, no public API break). Existing `DirtyRectSubscription` napi (currently consumed by `src/engine/vision-gpu/dirty-rect-source.ts` — see §2.6 + R11; `src/l3_bridge/dirty_rect_pump.rs` separately consumes the L1 ring fork) is **used but not modified** by Stage 5. P4 ADDS the typed declaration to `index.d.ts` (was previously missing — vision-gpu used untyped escape hatch); existing API callers unaffected by the additive declaration. `TouchResult` discriminated union gains an optional `observation?:` field via P5 — additive only, no existing destructure breaks (verified in §2.5 lock).

- **R9 — Stage 5 first-emitter contract surface** — Stage 5 is the first emitter of `source: "dxgi_dirty_rect"`. ADR-019 §2.1 enum slot existed since PR #309 but no code emits it today. **Mitigation**: P3 (test addition for the new orchestrator) and P10 (full regression sweep) must double-check no existing test asserts "no emitter of dxgi_dirty_rect exists" (negative tests are a known anti-pattern; should be zero). Pre-sweep at sub-plan write time confirms no such test.

- **R10 — `device.rs:77` placeholder `bounds` invalidates multi-monitor coord translation** (Opus Round 1 P1-1; **RESOLVED by PR #322 `3d1ab2a`**) — PR #102 left `OutputBounds = {x:0,y:0,width:0,height:0}` hardcoded with comment line 75 "Phase 3: use (0, 0) offset … Multi-monitor offset support is deferred to Phase 4." So `DirtyRect` coords returned from `next()` on a non-primary output were output-LOCAL, not desktop-translated. PR #322 replaced the placeholder with `IDXGIOutput::GetDesc()` + `DesktopCoordinates` (~20-line Rust fix, additive — primary monitor behaviour bit-equal). Stage 5 v1 now ships with FULL multi-monitor scope: G5-11 reinstated (above); resolveOutputIndexForHwnd walks all outputs via `enumDisplayMonitors`; cross-monitor windows fall back to primary-of-center per R3. Historical note kept here for sub-plan provenance.

- **R11 — DXGI subscription coexistence with `src/engine/vision-gpu/dirty-rect-source.ts`** (Opus Round 1 P1-4 + §2.6 lock) — vision-gpu instantiates `DirtyRectSubscription` directly via `addon["DirtyRectSubscription"]` untyped escape hatch (line 124-133). DXGI typically returns `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` for a second concurrent subscription on the same output. Note: vision-gpu activation is on-demand (not always-on), so the fail-soft frequency is expected to be low in normal use. **Mitigation**: §2.6 fail-soft lock — Stage 5's cache emits `dxgi_dirty_rect_unavailable` honestly when acquire fails. The L1 ring fork in `thread.rs:297-313` continues to feed `dirty_rect_pump.rs` from whichever subscription is active. Stage 5b carry-over: shared cache for both consumers + vision-gpu refactor to use the typed `DirtyRectSubscription` SSOT introduced in P4 of the impl checklist.

---

## 7. Open questions

1. **`STAGE5_CACHE_IDLE_TIMEOUT_MS` = 20 sec — is this the right balance?** Too short → desktop_act chains pay init cost mid-chain. Too long → DXGI session held while user is idle (RAM + minor power draw). **Resolution**: lock 20 sec for v1 (raised from 10 sec in Round 1 P2-1 after Stage 4 dogfood Paint.NET 20-cycle chain ≈ 10 sec was found right at the prior boundary; 2× headroom now). Revisit if dogfood shows chain-length distribution centres above 20 sec OR memory measurements show meaningful cost.
2. **Should `verifyAnyChange` be called BEFORE the action (pre-frame baseline) or AFTER (poll-once)?** Current design is poll-once after the action (the DXGI thread accumulates rects continuously; we just read whatever happened during the post-action window). Alternative: capture pre-frame rect count, call action, capture post-frame rect count, diff. **Resolution**: poll-once is simpler and matches DXGI's natural model (the thread already accumulates). Pre/post diff would be a Stage 5b carry-over if dogfood shows confusion (e.g. background animation rects swamping the action's rects).
3. **Should the safety-net path (§2.3.2) be default ON or OFF?** Current design is default OFF (`DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1` to enable). Rationale: Stage 4's `indeterminate` is honest; promoting to `any_change` risks false-positive on background activity. **Resolution**: default OFF in v1 ships. v1.7.x dogfood collects evidence; default flip to ON considered for v1.8 if `any_change` signal proves reliable.
4. **DXGI move rects (`GetFrameMoveRects`)** — DXGI exposes both *dirty* rects (re-painted regions) and *move* rects (regions copied from one place to another, with delta vectors). Stage 5 v1 uses dirty rects only. Move rects could feed `scroll_translation` as a future Stage 5b priority-1 source (ADR-019 §2.3.1 table row 5). **Resolution**: out of Stage 5 v1 scope; carry-over to Stage 5b sub-plan if a target's `scroll_translation` dogfood shows demand.
5. **DXGI thread already feeds engine-perception (ADR-008 D2-C)** — clarified investigation (Opus Round 1 P1-4): `src/l3_bridge/dirty_rect_pump.rs` subscribes to the **L1 ring** (NOT to `DirtyRectSubscription`), so it doesn't own a subscription. Actual second subscription owner is `src/engine/vision-gpu/dirty-rect-source.ts:124-133`. **Resolution locked in §2.6**: Stage 5 ships fail-soft coexistence — when DXGI returns `NotCurrentlyAvailable` (vision-gpu owns the output), Stage 5 emits `dxgi_dirty_rect_unavailable` honestly. Stage 5 cache is the **primary** subscription owner when active; the L1 ring fork keeps the pump alive either way. Shared cache for both consumers is a Stage 5b carry-over.

6. **Stage 5b multi-monitor support trigger** (**RESOLVED by PR #322 + this Round 5 amendment** — points (a) and (b) are done; point (c) remains carry-over) — PR #322 (`3d1ab2a`) fixed `src/duplication/device.rs:77` to populate `OutputBounds` from `DXGI_OUTPUT_DESC.DesktopCoordinates`. This Round 5 sub-plan amendment (a) reinstates G5-11 multi-monitor correctness, (b) restores `resolveOutputIndexForHwnd` to true multi-output resolution via `enumDisplayMonitors`. Remaining **Stage 5c carry-over**: multi-output subscription for windows materially straddling two monitors (current design picks primary-of-center with `hints.warnings`, missing changes on the other output). **Stage 5c trigger criteria**: dogfood reveals frequent cross-monitor window scenarios where the warning-only behaviour produces practical LLM blind spots. Until trigger fires, Stage 5c is dormant.
7. **Should desktop_act's `verifyDelivery.observation` be exposed via the new MCP tool surface for callers to gate on?** Currently `desktop_act` returns `{ok, ...}` with hints in a flatter structure. Adding nested `hints.verifyDelivery.observation` requires schema awareness on the MCP client side. **Resolution**: follow the Stage 4 mouse_click pattern (already in production via `hints.verifyDelivery`); existing MCP clients ignore unknown hint fields harmlessly.

---

## 8. Out of scope

- **Move rect parsing (DXGI `GetFrameMoveRects`)** — Stage 5b carry-over for `scroll_translation` priority-1 source.
- **Per-rect motion vector extraction** — Stage 6 (optical flow) or Stage 5b (DXGI move rects).
- **Multi-output simultaneous subscription for materially-straddling cross-monitor windows** — v1 falls back to primary-of-center with `hints.warnings` (basic multi-monitor IS in scope per G5-11 + R3 after PR #322). Multi-output simultaneous subscription = Stage 5c carry-over (§7 OQ #6).
- **RDP / virtual-display alternative implementation** — Stage 5 only surfaces `dxgi_dirty_rect_unavailable`; no software fallback. Future RDP support sub-plan.
- **GPU dispatch** — Stage 5 is already a GPU path (OS compositor); Stage 8's CPU→GPU migration is unrelated.
- **`mouse_drag` Stage 5 wiring** — drag has different post-state semantics (motion is during the drag, not after); out of Stage 5 v1 scope.
- **Pre/post diff variant** — current design polls only post-action rects (§7 OQ #2); pre/post would be a future Stage 5b refinement.

---

## 9. North-star reconciliation

ADR-019's load-bearing thesis (§2.2, "観測の時間軸をサーバに持ち込む" / "bring the temporal observation surface into the server") is **maximally honoured** by Stage 5 — DXGI dirty rects are temporal observations produced by the OS compositor itself. The Rust thread (PR #102) already brought the observation surface into the process; Stage 5 brings it into the **per-tool envelope**.

Stage 5 is the cleanest demonstration of the §1.3 4-primitive split: it shipped without needing any new SIMD work (§4.5 dispatch row 5: "none — OS does the diff") because the algorithm is hardware-accelerated by the GPU compositor we already pay for at every frame. The contract (`VisualMotionObservation`) sized for this in PR #309 — adding the first `dxgi_dirty_rect` emitter required only the existing enum slot.

After Stage 5, **all 4** of the §1.3 primitives are wired into ≥ 1 tool each (`structured_state` → Stage 1 UIA, `scroll_translation` → Stage 2a+2b scroll, `local_repaint` → Stage 4 mouse_click+keyboard, `any_change` → Stage 5 desktop_act). AC5 of the parent ADR is now satisfiable **with full multi-monitor coverage** (G5-11 reinstated after PR #322 `3d1ab2a` lifted the v1 primary-monitor-only constraint). Remaining v1 honest-limitations: (a) no DXGI move-rect motion vectors (Stage 5b carry-over); (b) default-OFF mouse_click/keyboard safety net (§2.3.2); (c) multi-output simultaneous subscription for materially-straddling cross-monitor windows (Stage 5c carry-over). (Codex Round 1 P3 corrected the prior "3 of 4" mis-count which omitted Stage 5 itself from the wired list.)

---

## 10. Dependencies / sequencing

- **Blocks**: nothing.
- **Blocked by**:
  - PR #102 (ADR-007 P5c-2, `c535fc2`) — DXGI subscription infrastructure (already merged).
  - PR #309 (ADR-019 MVP-1) — `VisualMotionObservation` contract surface.
  - PR #318 (ADR-019 Stage 4 impl) — `VerifyDeliveryHint.observation` field pattern.
  - PR #320 (Stage 4 deferred-P2 sweep) — already merged; Stage 5 sub-plan references it for the §7.2 keyboardTypeHandler integration test pattern.
- **Concurrent / coordinate with**:
  - Stage 4 follow-up bench work (per `docs/adr-019-stage-4-followups.md` §7) may touch `_mouse-verify.ts` if a Stage 4 integration test is added before Stage 5 impl. Coordinate the `classifyDeliveryWithLocalRepaint` edits via small atomic PRs.
- **Walking-skeleton classification**: expansion (Stage 5 is the 4th primitive — the §1.3 4-primitive split's last leg).
- **Successor**: Stage 5 dogfood PR (post-impl); Stage 5b sub-plan for DXGI move rects if `scroll_translation` evidence demands.

---

## 11. Test plan summary

| Layer | What's tested | Where |
|---|---|---|
| TS unit | `resolveOutputIndexForHwnd` policy | `tests/unit/resolve-output-index.test.ts` (5 cases — multi-monitor reinstated after PR #322; primary/secondary/boundary-straddle/off-screen/MAX_OUTPUT_INDEX cap; per §3 row) |
| TS unit | `DirtyRectSubscriptionCache` lifecycle | `tests/unit/dirty-rect-subscription-cache.test.ts` (6 cases) |
| TS unit | `verifyAnyChange` orchestration with mocked subscription | `tests/unit/any-change-orchestrator.test.ts` (8-12 cases) |
| TS unit | desktop_act post-state wiring | extend `tests/unit/desktop-*.test.ts` (if exists) or add new (~4 cases) |
| TS unit | mouse_click / keyboard:type Stage 5 fallback gate | extend `mouse-click-verify-stage4.test.ts` / `keyboard-type-stage4.test.ts` (~4 cases each) |
| Regression sweep | Full `npm run test:capture` confirms zero new failures | CI |
| Dogfood (post-merge) | desktop_act on real targets (menu open / button click) | `docs/adr-019-stage-5-followups.md` |

---

## 12. References

- Parent: `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`
- Sibling sub-plans: `docs/adr-019-stage-2a-plan.md`, `docs/adr-019-stage-2b-plan.md`, `docs/adr-019-stage-4-plan.md`
- Predecessor PRs: #102 (`c535fc2`, DXGI infra), #309 (`c196bbc`, MVP-1 contract), #318 (`4768fea`, Stage 4 impl), #319 (`b75733d`, Stage 4 dogfood), #320 (`8509070`, deferred-P2 sweep)
- Existing DXGI infrastructure (do not duplicate): `src/duplication/{device,thread,mod,types}.rs`, `src/l3_bridge/dirty_rect_pump.rs`, `index.d.ts:DirtyRectSubscription`
- Existing window-rect helpers: `src/engine/win32.ts` (`getWindowRectByHwnd`, `findContainingWindow`, display enumeration helpers used by `desktop_state({includeScreen:true})`)
- CLAUDE.md sections enforced:
  - §3 review loop (Opus + Codex)
  - §3.1 multi-table fact sweep (G5-9 above + new enum value `dxgi_dirty_rect_unavailable`)
  - §3.2 carry-over scope shrink (G5-10 above)
  - §3.3 PR review loop (§13 below)
  - §3.4 Max 20x parallelism (Stage 5 is expansion-phase, may run parallel to Stage 4 follow-ups)
  - §9 residuals in docs/ (`docs/adr-019-stage-5-followups.md` post-impl)

---

## 13. Review workflow (CLAUDE.md §3.3)

This sub-plan PR:

- **Step 0** — Classification: **docs / plan PR** (no production code change). Codex recommended (Phase-boundary plan; Stage 5 adds a new enum value + extends `VisualMotionObservation.residual` shape — API contract surface that benefits from Codex's strict axis).
- **Step 1** — Opus phase-boundary review with explicit §3.1 + §3.2 sweep + Lesson 1-4 sweep. Code change prohibited; review only.
- **Step 2** — Codex re-review via `@codex review` PR comment (mandatory for Phase-boundary plan with API contract surface — `feedback_ai_multi_reviewer.md` "Phase-boundary plans benefit from Codex's API-contract surface axis").
- **Step 3** — Iterate to P1 = 0.
- **Step 4** — User reviewer Lesson 1-4 final sweep window (best-effort under auto-mode; agent proceeds to Step 5 after Opus Approved).
- **Step 5** — Merge (auto-mode: Opus Approved + (Codex Approved OR usage limit) → AI may merge per `memory/feedback_auto_mode_merge_opus_judgment.md`).

The **impl PR** (separate) is classified **production code 改修 PR** — Codex **mandatory**.

---

## 14. Round history

- **Round 0 (this PR, 2026-05-16)** — initial draft. Decisions §2 locked: 3-pillar design (orchestrator + subscription cache + output-index resolver). Scope right-sized from ADR §4's "5-7 days" estimate to "2-3 days impl" given PR #102's existing DXGI infrastructure. New enum value `"dxgi_dirty_rect_unavailable"` introduced for RDP graceful degrade (R1 explains alternative considered + rejected). §7 OQ list captures the deferred items most likely to need future follow-up (move rects, cross-monitor, pre/post variant).

- **Round 1 (this PR, 2026-05-16)** — Opus phase-boundary review found 4 P1 + 5 P2 + 2 P3 (= 11); Codex found 1 P2 + 1 P3 (= 2). **All 13 findings applied** without re-draft (surgical edits). (Round 2 P1-4 corrected an earlier miscount of "12 findings" — exactly the Lesson 4 numeric-count-sync drift this round history is meant to surface.) Key structural locks added by Round 1:
  - **P1-1 (R10)** — Stage 5 v1 scope hardcoded to primary monitor (`outputIndex = 0`) due to `src/duplication/device.rs:77` placeholder bounds. G5-11 demoted to "v1 N/A"; multi-monitor lifted to Stage 5b via new §7 OQ #6. Non-primary windows emit `dxgi_dirty_rect_unavailable` honestly via §2.1 step 1 `enumDisplayMonitors` check.
  - **P1-2 (P2-3)** — §3 SSOT row expanded: `index.d.ts` + `index.js` + `native-types.ts` + `native-engine.ts` all need NEW `DirtyRectSubscription` napi class declaration. Was incorrectly labelled "SSOT sync only"; verified via grep of `index.d.ts` (zero hits for `DirtyRectSubscription`) and `vision-gpu/dirty-rect-source.ts:124-133` (untyped escape hatch because SSOT was missing).
  - **P1-3 (§2.5 NEW lock; was §2.4 at Round 1 commit time — renumbered in Round 2 to resolve duplicate-§2.4 collision)** — `TouchResult` discriminated-union has NO `hints` field today; Stage 5 must extend the `ok: true` variant to carry `observation?: VisualMotionObservation`. Wiring scope revised from "30-50 lines" to "60-100 lines additive across 3-5 files".
  - **P1-4 (§2.6 NEW lock + R11; was §2.5 at Round 1 commit time)** — DXGI coexistence lock: `dirty_rect_pump.rs` subscribes to L1 ring (not the napi); the actual second consumer is `vision-gpu/dirty-rect-source.ts`. Stage 5 v1 ships fail-soft (`NotCurrentlyAvailable` → `dxgi_dirty_rect_unavailable`). Shared cache deferred to Stage 5b.
  - **P2-1** — `STAGE5_CACHE_IDLE_TIMEOUT_MS` 10 → 20 sec (Stage 4 Paint.NET dogfood chain ≈ 10 sec was right at the prior boundary; 2× headroom now).
  - **P2-5** — `STAGE5_MIN_INTERSECTED_AREA_RATIO = 0.005` (0.5 % of target rect) replaces the prior absolute `STAGE5_MIN_INTERSECTED_AREA_PX = 4` (too low; background animation grazing the target would have falsely qualified as `any_change`).
  - **Codex P2** — G5-2 acceptance relaxed: 3 valid `no_change` outcome shapes per §2.1 step 5 (empty rects / no-intersect / sub-ratio-grazing). Prior wording forced one specific shape.
  - **Codex P3** — §9 "3 of 4 primitives wired" → "all 4 wired with v1 limitations noted" (Stage 5 itself was the 4th).
  - §4 P-checklist re-numbered P0 (prerequisite confirmation) → P12 with additional steps for native SSOT add (P4 new) + `TouchResult` extension (P5 new) + `TouchResult` consumer sweep (P12 expanded).
  - §1.2 "4 things" framing rewritten as "3 new components + 1 wiring task" with explicit pointers to §2 / §3 / §2.5 (Opus Round 1 P2-4 numeric-count sync — pointer renumbered in Round 2 to track the TouchResult lock's section move).

  No production code change in Round 1; all edits to `docs/adr-019-stage-5-plan.md` only.

- **Round 2 (this PR, 2026-05-16)** — second Opus phase-boundary review found 4 P1 + 3 P2 + 1 P3 = 8 mechanical fixes from Round 1's surgical-edit drift. All applied without re-draft:
  - **P1-1**: `§2.4` collision (constants table + TouchResult lock both numbered 2.4) → renumbered TouchResult lock to **§2.5** and coexistence lock to **§2.6**. Updated cross-references at lines 67, 113, 234, 235, 240, 254, 258, 276, 280, 309, 319, 416, 417, 423 (12 spots — verified via grep).
  - **P1-2**: §7 OQ #6 duplicate (Stage 5b multi-monitor AND Cross-monitor safety net both numbered 6). Merged the cross-monitor item INTO OQ #6 (both driven by same `device.rs` gap); existing OQ #6 → renumbered list cleanly maintained at 7 OQs total.
  - **P1-3**: OQ #1 stale value (still said "10 sec" / "lock 10 sec" but §2.4 constants table set 20 sec in Round 1 P2-1). Rewrote OQ #1 to 20-sec value + explicit Round 1 reference.
  - **P1-4**: §14 Round 1 entry claimed "All 12 findings applied" but math is 4 P1 + 5 P2 + 2 P3 + 1 P2 + 1 P3 = **13**. Corrected to "All 13 findings applied" with explicit Lesson 4 (numeric-count sync) annotation.
  - **P2-1**: §2 intro "three pillars" was correct for Round 0 but stale after §2.5 + §2.6 were added in Round 1. Rewrote intro to "three pillars (§2.1-§2.3) + three supporting subsections (§2.4 constants, §2.5 TouchResult lock, §2.6 DXGI coexistence lock); six subsections total under §2".
  - **P2-2**: §11 test plan stale "4 cases" for `resolve-output-index.test.ts` (§3 SSOT row was updated to 3 in Round 1; §11 wasn't). Synced.
  - **P2-3**: §1.2 "3 + 1 = 4" framing under-sold §4 P-checklist scope. Acknowledged in §14 only (no further restructure — the §1.2 intent is high-level component count, §4 is impl-level phase count; both internally consistent).
  - **P3-1**: §2.5 cross-reference (line 66) said "§2.5 OQ #5 resolution" but OQ #5 is in §7. Updated to "§2.6 (which resolves §7 OQ #5)".

  No production code change in Round 2; all edits to `docs/adr-019-stage-5-plan.md` only.

- **Round 3 (this PR, 2026-05-16)** — third Opus phase-boundary review found 3 P1 + 0 P2 + 0 P3 = 3 stale-reference fixes that Round 2's renumber-only sweep missed. All applied:
  - **P1-1**: §2.2 Lifecycle bullets (lines 139-140) still said "within 10 sec" / "10 sec idle" while Round 2's §2.4 constants table / line 90 §2 intro / §7 OQ #1 / G5-7 all said "20 sec". Synced to 20 sec with explicit `STAGE5_CACHE_IDLE_TIMEOUT_MS` annotation. Round 2 P1-3 fixed adjacent stale-value sites but missed these two bullets directly under the §2.2 cache description — exact Lesson 4 (numeric/citation sync within close-by surfaces) regression Round 2 was meant to close.
  - **P1-2**: §6 R1 mitigation referenced "P7 + P10" but the actual §3.1 sweep tasks after Round 1's P-checklist expansion are **P2** (adds the enum value) + **P12** (cross-SoT sweep). Synced.
  - **P1-3**: §6 R6 mitigation referenced "P4 must check" but P4 is now the native SSOT addition (`index.d.ts` + `index.js`) after Round 1's expansion. The desktop_act wiring is **P6**, and the TouchResult extension is **P5**. Synced + clarified the two-step coordination (P5 type extension → P6 wiring + envelope surface).

  Root cause: Round 1 expanded the P-checklist (added P0 prerequisite, P4 native SSOT, P5 TouchResult extension, shifting downstream P-numbers). The cross-references in §6 R-list and §2.2 Lifecycle bullets used the OLD P-numbers and weren't swept. Round 3 is a follow-up Lesson 4 cross-reference-staleness sweep — same class of drift as Round 2 P1-1 / P1-2 (which Round 2 fixed for §2.X and OQ-numbering but missed the §6 R-list).

  No production code change in Round 3; all edits to `docs/adr-019-stage-5-plan.md` only.

- **Round 4 (this PR, 2026-05-16)** — fourth Opus phase-boundary review found 1 P2 + 1 P3 (defer-acceptable). P2-1 fixed; P3-1 deferred per Round 2 P2-3 precedent. **Round 4 Approved after P2 fix.**
  - **P2-1**: §2.5 wrap-up line 202 referenced "the original §3 row 6 estimate (~30-50 lines)" — but Round 1's §3 SSOT expansion (adding native SSOT rows + TouchResult row) shifted "desktop_act envelope extension" from row 6 to row 9. Dropped the brittle ordinal; reference the row by its name instead. Same Lesson 4 (citation-staleness across renumbered tables) pattern as Round 2/Round 3 P-checklist drift.
  - **P3-1 (deferred)**: §1.2 "§2 enumerates exactly these 4 below" literally inaccurate (§2 numbered list has 3 entries; the 4th "Wiring" item lives in §2.3 + §2.5 + §3 rows). Round 2 P2-3 already weighed and deferred this as "high-level component count vs impl-level phase count" honesty trade-off — not re-litigated.

  **Round 4 verified clean** (sweep summary, no further issues found): all P0-P12 / §2.X / §7 OQ #N / G5-N cross-references valid; all numeric values (`STAGE5_CACHE_IDLE_TIMEOUT_MS = 20`, `STAGE5_MIN_INTERSECTED_AREA_RATIO = 0.005`, enum 8→9, test counts 8-12/6/3, "2-3 days impl") consistent across surfaces; source-file line citations (device.rs:77, thread.rs:146/156/297-313, vision-gpu/dirty-rect-source.ts:124-133, guarded-touch.ts:46) verified live against current code.

  No production code change in Round 4; all edits to `docs/adr-019-stage-5-plan.md` only.

- **Round 5 (this PR, 2026-05-16)** — **scope restoration amendment** after PR #322 (`3d1ab2a`) merged the `device.rs` multi-monitor bounds fix (~20 line Rust change populating `OutputBounds` from `DXGI_OUTPUT_DESC.DesktopCoordinates`). The v1 primary-monitor-only constraint that drove Round 1's G5-11 demotion + Stage 5b carry-over is **no longer needed**. Amendments:
  - §1.2 component 1 + §2.1 step 1 + §2 intro pillar 1: drop "v1 hardcodes outputIndex = 0" language; `resolveOutputIndexForHwnd` now performs true multi-output resolution.
  - §2.1 step 3 + §2.4 `STAGE5_MAX_OUTPUT_INDEX` row: notes that DirtyRect translation is correct for all monitors; the constant is now actively used in v1 (not "forward-looking for Stage 5b").
  - §3 SSOT test row: `resolve-output-index.test.ts` 3 cases → **5 cases** (primary / secondary / boundary-straddle / off-screen / MAX cap).
  - §3 SSOT test row for `dirty-rect-subscription-cache.test.ts`: multi-output independence is "actively exercised in v1" (not "forward-looking for Stage 5b").
  - §4 P0 marked **DONE** (was prerequisite confirmation; PR #322 satisfies); P1 phrasing tightened to name `enumDisplayMonitors` + per-output `OutputBounds` walk explicitly (P4's wording was already multi-monitor-supportive in prior rounds — no edit needed). P3 case count `≥ 17 → ≥ 19` (5 resolver vs prior 3, synced post-Opus Round 1 P1-1 finding on this amendment PR).
  - §5 G5-11 **reinstated** as a real acceptance criterion (was "v1 N/A"). G5-12 dogfood now requires both primary AND secondary monitor coverage (dual-monitor host).
  - §6 R3 mitigation rewritten: cross-monitor windows now properly return primary-of-center with `hints.warnings`; multi-output simultaneous subscription is the new Stage 5c carry-over (vs the prior R3 was "Stage 5b carries multi-monitor entirely").
  - §6 R10 marked **RESOLVED by PR #322** with historical provenance note.
  - §7 OQ #6 marked **RESOLVED** (points a + b done); remaining Stage 5c carry-over is multi-output simultaneous subscription only.
  - §9 north-star: dropped "v1 limitations: single-monitor primary-window only"; updated remaining limits to (a) no move rects (b) default-OFF safety net (c) Stage 5c cross-monitor straddle.
  - §11 test plan: 3 → 5 cases sync.

  No production code change in Round 5; all edits to `docs/adr-019-stage-5-plan.md` only. PR #322 was the production prerequisite; this amendment realigns the sub-plan to the new scope ceiling.
