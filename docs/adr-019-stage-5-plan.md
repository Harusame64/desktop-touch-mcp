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

1. **Output-index resolver** — given an `hwnd` + `windowRect`, return the `output_index` of the monitor the window primarily lies on (so the subscription targets the right output). Default 0 = primary covers single-monitor case; multi-monitor needs explicit resolution.
2. **`verifyAnyChange(opts)` orchestrator** — TS function analogous to `verifyLocalRepaint`. Subscribes to the correct output, polls `next()` for a bounded window, intersects returned dirty rects with the target window's screen rect, and decides `motion: "any_change" | "no_change" | "indeterminate"`.
3. **Subscription cache** — DXGI session init is ~50-100 ms. Per-call subscribe would dominate the verify latency. Cache the subscription per `output_index` with an idle-timeout dispose to amortise init across multiple verify calls.
4. **Wiring** — desktop_act post-state verify (primary), and an optional safety-net path for mouse_click / keyboard:type when Stage 4 returns `motion: "indeterminate"` due to the `MAX_RECT_AREA_PX` R3 cap or `stableReached: false` R6 path.

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

Adopt an `any_change` primitive built on three pillars:

1. **`resolveOutputIndexForHwnd(hwnd)` TS helper** — query the window rect, walk the existing display catalogue (already used by `desktop_state({includeScreen:true})`), return the index of the monitor the window's center point sits on. Defaults to 0 when ambiguous.
2. **`verifyAnyChange(opts)` orchestrator** — subscribes to the correct output (or reuses a cached subscription), polls `next(timeout_ms=POLL_BUDGET_MS)` for a bounded window, intersects returned rects with the target window's screen rect, returns `motion: "any_change" | "no_change" | "indeterminate"`.
3. **`DirtyRectSubscriptionCache`** — singleton map keyed by `output_index`, with an idle-timeout that disposes subscriptions after `CACHE_IDLE_TIMEOUT_MS` of no use (~10 sec). Stage 5's verify reuses the same subscription across desktop_act calls in a chain.

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

1. **Resolve output index** — `resolveOutputIndexForHwnd(opts.hwnd, opts.windowRect)`. Falls back to 0 (primary) on ambiguity.
2. **Acquire subscription** — `DirtyRectSubscriptionCache.acquire(outputIndex)`. Returns existing or creates new. On `DuplicationError::Unsupported` (RDP / virtual display) → return `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` (new enum slot — see R1).
3. **Poll for dirty rects** — `await subscription.next(budgetMs)`. Returns `DirtyRect[]` (in desktop screen coords — the Rust thread already translates `OutputBounds.x/y + rect.{x,y}`, per `device.rs:23` comment). On timeout (no dirty rects in window), returns empty array.
4. **Intersect with target rect** — for each dirty rect, compute intersection with `region ?? windowRect`. Sum the intersected area.
5. **Decide motion**:
   - intersected area `> 0` → `motion: "any_change"`, `source: "dxgi_dirty_rect"`, attach `residual: { dirtyRectCount: N, totalIntersectedAreaPx: A, ratioOfTargetArea: A/(targetW*targetH) }` (new residual fields — see SSOT extension below).
   - intersected area `=== 0` AND `rects.length > 0` → `motion: "no_change"`, `source: "dxgi_dirty_rect"`, attach `residual: { dirtyRectCount: N, totalIntersectedAreaPx: 0, ratioOfTargetArea: 0 }`. (Other parts of the desktop changed but not the target.)
   - empty `rects` → `motion: "no_change"`, `source: "dxgi_dirty_rect"`, residual omitted (no observation activity at all).
   - subscription error other than `Unsupported` → `motion: "indeterminate"`, `source: "dxgi_dirty_rect"`, no residual.
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
- Subsequent `acquire(0)` within 10 sec returns cached subscription, takes < 1 ms.
- 10 sec idle → background timer calls `subscription.dispose()` + removes from cache.
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
| `STAGE5_CACHE_IDLE_TIMEOUT_MS` | 10000 | 10 sec — covers desktop_act chains (typical: 3-5 sequential acts ≤ 5 sec) without holding GPU resources beyond the chain |
| `STAGE5_MAX_OUTPUT_INDEX` | 8 | hard cap on output_index to prevent runaway enumeration on hypothetical 9+ monitor setups; if the window is on output ≥ 8, fall back to 0 with a `hints.warnings` |
| `STAGE5_MIN_INTERSECTED_AREA_PX` | 4 | minimum intersected area to count as "any_change" (rejects 1-2 px noise from rounding errors at the screen↔output boundary translation) |

Constants live in `src/engine/any-change.ts` (new module) alongside the orchestrator.

---

## 3. Affected components (SSOT)

| File | Stage 5 change |
|---|---|
| **`src/engine/any-change.ts`** (NEW) | `verifyAnyChange` orchestrator + `resolveOutputIndexForHwnd` helper + `DirtyRectSubscriptionCache` + Stage 5 constants. ~200-300 line module. |
| **`src/engine/native-types.ts`** | Add `NativeDirtyRect` + `NativeOutputBounds` re-exported interface types (already exist in `index.d.ts` from PR #102; SSOT sync only). |
| **`src/engine/native-engine.ts`** | Add `DirtyRectSubscription` constructor reference to the `NativeEngine` interface. |
| **`src/tools/_input-pipeline.ts:VisualMotionObservation`** | Extend `residual?` to include optional `dirtyRectCount?: number`, `totalIntersectedAreaPx?: number`, `ratioOfTargetArea?: number` (Stage 5-specific fields, optional on the existing residual shape). Update TSDoc. |
| **`src/tools/_input-pipeline.ts:source enum`** | Add `"dxgi_dirty_rect_unavailable"` enum value to the existing 8-value source enum (the RDP / virtual-display graceful-degrade label). This is a **NEW enum value** — CLAUDE.md §3.1 sweep required (see §6 R1 below). |
| **`src/tools/desktop-register.ts` or `desktop-executor.ts`** | Wire `verifyAnyChange` into the `desktop_act` handler's post-execution path. Resolve target hwnd from lease/spec; attach observation to envelope `hints.verifyDelivery.observation`. ~30-50 lines additive. |
| **`src/tools/_mouse-verify.ts`** | Add optional Stage 5 fallback inside `classifyDeliveryWithLocalRepaint` — when `verifyLocalRepaint` returned `indeterminate` AND `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1`, call `verifyAnyChange` and attach observation (no status upgrade per §2.3.2). ~20 lines additive. |
| **`src/tools/keyboard.ts:keyboardTypeHandler`** | Same Stage 5 fallback at the BG-verify `unverifiable + read_back_unsupported` sink — env-gated, observation-only. ~15 lines additive. |
| **`docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md`** | §2.1 enum extension (add `"dxgi_dirty_rect_unavailable"`); §3 SSOT correction (`src/image/dxgi_duplication.rs` doesn't exist — actual implementation lives at `src/duplication/{device,thread,mod,types}.rs` from PR #102; Stage 5 adds `src/engine/any-change.ts`); §4 Stage 5 section update with the smaller scope estimate (2-3 days impl, not 5-7); §7 OQ #4 ("DXGI per-window mapping") marked **Resolved** by the window-rect intersection design in §2.1 step 4. |
| **`docs/adr-018-input-pipeline-3tier.md`** §2.6 enum reference | Add the new `"dxgi_dirty_rect_unavailable"` value + a one-line note that `desktop_act` is now the second tool (after `mouse_click` / `keyboard:type` via Stage 4) to attach an `observation` field. |
| **`tests/unit/any-change-orchestrator.test.ts`** (NEW) | 8-12 unit cases — `verifyAnyChange` with mocked `DirtyRectSubscription.next` returning various rect arrays (empty / inside-target / outside-target / partial-overlap / Unsupported error / AccessLost error). Test cache acquire/release/dispose lifecycle. |
| **`tests/unit/dirty-rect-subscription-cache.test.ts`** (NEW) | 6 cases — singleton behaviour, idle timeout dispose, shutdown hook, multi-output independence. Mock `DirtyRectSubscription` constructor. |
| **`tests/unit/resolve-output-index.test.ts`** (NEW) | 4 cases — single-monitor primary, dual-monitor window on secondary, window spanning two monitors (falls back to primary-of-center), output_index > MAX_OUTPUT_INDEX warning. |
| **`benches/dogfood_stage_5.mjs`** (NEW, post-impl) | Real-app dogfood harness analogous to `dogfood_stage_4.mjs` — drive desktop_act on a known target, observe dirty rect count + intersected area. |

Stage 5 does **NOT** touch: `src/ssim.rs`, `src/pixel_diff.rs`, `src/engine/local-repaint.ts` (Stage 4 internals unchanged), `src/duplication/{device,thread}.rs` (PR #102 infrastructure unchanged — only consumed), `src/tools/scroll.ts`, browser tools, perception graph, vision-gpu modules.

---

## 4. Implementation plan (Phase checklist for the impl PR)

The sub-plan PR closes here; below is the checklist the **impl PR** flips `[ ]` → `[x]`.

- [ ] **P1** — `src/engine/any-change.ts` new module: `resolveOutputIndexForHwnd` + `DirtyRectSubscriptionCache` + `verifyAnyChange` orchestrator + Stage 5 constants. Scalar implementation; no SIMD work (DXGI is already GPU).
- [ ] **P2** — `src/tools/_input-pipeline.ts`: extend `VisualMotionObservation.residual` with optional Stage 5 fields (`dirtyRectCount?`, `totalIntersectedAreaPx?`, `ratioOfTargetArea?`); add `"dxgi_dirty_rect_unavailable"` to the source enum.
- [ ] **P3** — `tests/unit/{any-change-orchestrator,dirty-rect-subscription-cache,resolve-output-index}.test.ts` (≥ 18 cases total).
- [ ] **P4** — `src/tools/desktop-register.ts` or `desktop-executor.ts`: wire `verifyAnyChange` into post-execution path. Attach observation to envelope hint. Gate on `DESKTOP_TOUCH_STAGE5_DXGI !== "0"`.
- [ ] **P5** — `src/tools/_mouse-verify.ts:classifyDeliveryWithLocalRepaint`: add Stage 5 fallback when Stage 4 returns `indeterminate` AND `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK === "1"` (default OFF). Observation-only; no status upgrade.
- [ ] **P6** — `src/tools/keyboard.ts:keyboardTypeHandler`: mirror the Stage 5 fallback at the BG-verify `unverifiable + read_back_unsupported` sink, gated on `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK === "1"`.
- [ ] **P7** — `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` + `docs/adr-018-input-pipeline-3tier.md` docs sync per §3 table above.
- [ ] **P8** — Full `npm run test:capture` regression sweep; expect zero new failures (Stage 5 is additive; existing tests use no DXGI mocks).
- [ ] **P9** — Post-merge dogfood — populate `docs/adr-019-stage-5-followups.md` with ≥ 30-cycle desktop_act runs against ≥ 2 real targets (e.g. Notepad menu open + Calculator button click).
- [ ] **P10** — CLAUDE.md §3.1 sweep: grep `observation.source` enum values across ADR-019 / ADR-018 / `_input-pipeline.ts` / `index.d.ts` / `tests/` to confirm the new `"dxgi_dirty_rect_unavailable"` value is consistently applied. Confirm count goes from 8 → 9 enum values in every SSOT surface.

---

## 5. Acceptance criteria

- **G5-1 (functional, desktop_act post-state)** — `desktop_act` against a known visible-change target (e.g. menu open) attaches `hints.verifyDelivery.observation` with `motion: "any_change"`, `source: "dxgi_dirty_rect"`, and `residual.dirtyRectCount > 0`.
- **G5-2 (functional, no-change baseline)** — `desktop_act` against an idle / no-effect target (e.g. clicking on a hot-key that does nothing) returns `motion: "no_change"` with `residual.totalIntersectedAreaPx === 0`.
- **G5-3 (no regression on Stage 4)** — `mouse_click` / `keyboard:type` with `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=0` (default) emits exactly the pre-Stage-5 envelope. Stage 4 outputs bit-equal. Asserted by re-running the Stage 4 dogfood (PR #319) against the post-Stage-5 build.
- **G5-4 (env opt-out, desktop_act)** — `DESKTOP_TOUCH_STAGE5_DXGI=0` suppresses Stage 5 entirely on the desktop_act path; envelope omits `observation`. Bit-equal pre-Stage-5 contract.
- **G5-5 (Unsupported graceful degrade)** — On RDP / virtual-display where DXGI returns `Unsupported`, Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect_unavailable"` and no `residual`. `desktop_act` envelope still succeeds (action ok, observation degraded). Pinned by unit test mocking the Unsupported error.
- **G5-6 (AccessLost graceful degrade)** — When the DXGI session is lost mid-flight (display sleep / suspend), Stage 5 emits `motion: "indeterminate"` with `source: "dxgi_dirty_rect"` and the cache invalidates the subscription so the next call re-initialises. Pinned by unit test mocking AccessLost error after N successful calls.
- **G5-7 (cache amortisation)** — Within a single `desktop_act` chain (3+ sequential acts in < 5 sec), subscription init cost is paid ONCE. Bench-asserted: first-call p99 ≤ 150 ms, subsequent-call p99 ≤ 100 ms (the `STAGE5_POLL_BUDGET_MS` ceiling). After `STAGE5_CACHE_IDLE_TIMEOUT_MS` of idle, the next call re-initialises (~50-100 ms).
- **G5-8 (latency budget, integration)** — `verifyAnyChange` wallclock p99 ≤ **150 ms** end-to-end (including first-call init). Subsequent calls in a chain p99 ≤ 100 ms (dominated by `STAGE5_POLL_BUDGET_MS`).
- **G5-9 (CLAUDE.md §3.1 multi-table sweep)** — `observation.source` enum extended from 8 → 9 values, bit-equal across all 3 SSOT surfaces (ADR-019 §2.1 / `_input-pipeline.ts:VisualMotionObservation` / ADR-018 §2.6). `observation.residual.{dirtyRectCount, totalIntersectedAreaPx, ratioOfTargetArea}` Stage 5-specific additions documented in TSDoc + ADR-019 §2.1.
- **G5-10 (CLAUDE.md §3.2 carry-over scope shrink)** — No exhaustive `switch (observation.source)` exists in `src/` (grep returns zero hits). Stage 5 is additive only — no existing API contract breaks. Existing `desktop_act` callers that don't read `hints.verifyDelivery.observation` are unaffected.
- **G5-11 (multi-monitor correctness)** — Window on secondary monitor → subscription targets the correct output index. Pinned by unit test with mocked `enumDisplays` returning 2 monitors and `getWindowRectByHwnd` returning a rect inside monitor 1's bounds.
- **G5-12 (post-merge dogfood report)** — `docs/adr-019-stage-5-followups.md` populated within 1 week of impl PR merge with ≥ 30 cycles across ≥ 2 real desktop_act targets.

---

## 6. Risks

- **R1 — New enum value `"dxgi_dirty_rect_unavailable"` requires §3.1 sweep across 3 SoTs** — Stage 4 sub-plan was careful to NOT add new enum values (sub-plan §0.1 #2 explicitly locked "no new enum values"). Stage 5 reintroduces one. **Mitigation**: P7 + P10 explicitly do the sweep. The new value's semantics are precise (RDP / virtual-display where DXGI is unavailable at the OS level — distinct from `dxgi_dirty_rect` which means DXGI is available but observed no relevant change). Alternative considered: reuse `"chain_trust_unverified"` as a generic "observation unavailable" label, rejected because that source has scroll-specific semantics that would confuse desktop_act consumers.

- **R2 — DXGI subscription cache leak on server shutdown** — if the cache's background idle-timer fires while shutdown is in flight, OR if shutdown happens before `disposeAll()` is wired, the DXGI session leaks (Windows will reclaim on process exit, but interim correctness suffers). **Mitigation**: wire `DirtyRectSubscriptionCache.disposeAll()` into the MCP server shutdown hook (same surface as ADR-008 D2-0 `shutdown_perception_pipeline_for_test`). Unit test the shutdown path.

- **R3 — Output-index resolution on cross-monitor windows** — a window straddling two monitors has ambiguous primary-output. Current design (§2.1 step 1) uses the window's center point. If the center is on monitor A but most of the action is on monitor B, Stage 5 misses changes on B. **Mitigation**: G5-11 acceptance pins single-monitor-window correctness. Cross-monitor windows fall back to primary monitor with a `hints.warnings` entry; future Stage 5 follow-up could subscribe to multiple outputs when window is cross-monitor. Out of scope for v1.

- **R4 — RDP / virtual-display fail-soft cost** — every `desktop_act` on RDP would pay the failed DXGI init cost (~50 ms?). **Mitigation**: cache the `Unsupported` failure for `STAGE5_CACHE_IDLE_TIMEOUT_MS` so RDP sessions don't retry the init for every act. Same cache structure as success path; the cached "subscription handle" is a sentinel marker recording the Unsupported state.

- **R5 — False positive on background animation overlapping the target rect** — a video playing inside the target window OR a chat notification popup overlapping → dirty rects intersect the target rect even when the user's action didn't cause them. **Mitigation**: Stage 5 is **observational not adjudicative** on the safety-net path (§2.3.2: never upgrades verify status, only attaches observation). On the desktop_act path, the user explicitly invoked an action so the assumption "any change near the target is caused by the action" is acceptable for the primary use case; document explicitly that desktop_act observation is heuristic and the LLM should consult other signals (e.g. `ok` + executor.kind) when high confidence is needed.

- **R6 — `desktop_act` envelope schema impact** — Stage 5 adds `hints.verifyDelivery.observation` to `desktop_act`'s envelope. Currently `desktop_act` may NOT have a `verifyDelivery` hint at all (Stage 4 covers `mouse_click` / `keyboard:type` only). **Mitigation**: P4 must check whether `desktop_act` already has a `verifyDelivery` shape; if not, introduce it additively (`{ status: "delivered", channel: <kind>, observation: ... }`). The shape is already shared via `_mouse-verify.ts` types, so reuse is straightforward.

- **R7 — CLAUDE.md §3.1 multi-table fact integrity (Stage 4-style sweep needed)** — `observation.residual` shape lives in 3 SoT surfaces today (`{ fractionChanged, centroid?, meanSsim? }`). Stage 5 adds 3 fields (`dirtyRectCount?`, `totalIntersectedAreaPx?`, `ratioOfTargetArea?`). **Mitigation**: same P15-style decision pattern as Stage 4 — extend the shape across all 3 SoTs in the same impl PR (no follow-up retro-review needed if done atomically).

- **R8 — CLAUDE.md §3.2 carry-over scope shrink** — Stage 5 is additive (new orchestrator, new envelope field, no public API break). Existing `DirtyRectSubscription` napi (used by ADR-008 D2-C via `dirty_rect_pump`) is consumed but not modified. No existing API caller breaks.

- **R9 — Stage 5 first-emitter contract surface** — Stage 5 is the first emitter of `source: "dxgi_dirty_rect"`. ADR-019 §2.1 enum slot existed since PR #309 but no code emits it today. **Mitigation**: P4 impl must double-check no test asserts "no emitter of dxgi_dirty_rect exists" (negative tests are a known anti-pattern; should be zero). Sweep confirms no such test.

---

## 7. Open questions

1. **`STAGE5_CACHE_IDLE_TIMEOUT_MS` = 10 sec — is this the right balance?** Too short → desktop_act chains pay init cost mid-chain. Too long → DXGI session held while user is idle (RAM + minor power draw). **Resolution**: lock 10 sec for v1; revisit if dogfood shows chain-length distribution centres above 10 sec OR memory measurements show meaningful cost.
2. **Should `verifyAnyChange` be called BEFORE the action (pre-frame baseline) or AFTER (poll-once)?** Current design is poll-once after the action (the DXGI thread accumulates rects continuously; we just read whatever happened during the post-action window). Alternative: capture pre-frame rect count, call action, capture post-frame rect count, diff. **Resolution**: poll-once is simpler and matches DXGI's natural model (the thread already accumulates). Pre/post diff would be a Stage 5b carry-over if dogfood shows confusion (e.g. background animation rects swamping the action's rects).
3. **Should the safety-net path (§2.3.2) be default ON or OFF?** Current design is default OFF (`DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1` to enable). Rationale: Stage 4's `indeterminate` is honest; promoting to `any_change` risks false-positive on background activity. **Resolution**: default OFF in v1 ships. v1.7.x dogfood collects evidence; default flip to ON considered for v1.8 if `any_change` signal proves reliable.
4. **DXGI move rects (`GetFrameMoveRects`)** — DXGI exposes both *dirty* rects (re-painted regions) and *move* rects (regions copied from one place to another, with delta vectors). Stage 5 v1 uses dirty rects only. Move rects could feed `scroll_translation` as a future Stage 5b priority-1 source (ADR-019 §2.3.1 table row 5). **Resolution**: out of Stage 5 v1 scope; carry-over to Stage 5b sub-plan if a target's `scroll_translation` dogfood shows demand.
5. **DXGI thread already feeds engine-perception (ADR-008 D2-C)** — `src/l3_bridge/dirty_rect_pump.rs` subscribes the same DXGI session for L1 ring → `current_focused_element` view materialisation. Stage 5 cache + the pump would BOTH hold subscriptions if not coordinated. **Resolution**: investigate whether `DirtyRectSubscription` allows multiple concurrent subscriptions on the same output. If yes (broadcast), no coordination needed. If no, Stage 5 cache must share with the pump's subscription. P1 impl prerequisite — confirm before writing the cache.
6. **Cross-monitor window safety net** — for windows that span monitors, current design only watches the primary-of-center monitor. **Resolution**: out of v1 scope; document as known limitation in §5 G5-11 wording. Cross-monitor support → future follow-up.
7. **Should desktop_act's `verifyDelivery.observation` be exposed via the new MCP tool surface for callers to gate on?** Currently `desktop_act` returns `{ok, ...}` with hints in a flatter structure. Adding nested `hints.verifyDelivery.observation` requires schema awareness on the MCP client side. **Resolution**: follow the Stage 4 mouse_click pattern (already in production via `hints.verifyDelivery`); existing MCP clients ignore unknown hint fields harmlessly.

---

## 8. Out of scope

- **Move rect parsing (DXGI `GetFrameMoveRects`)** — Stage 5b carry-over for `scroll_translation` priority-1 source.
- **Per-rect motion vector extraction** — Stage 6 (optical flow) or Stage 5b (DXGI move rects).
- **Cross-monitor window correctness** — v1 falls back to primary-of-center; full multi-monitor subscription is a follow-up.
- **RDP / virtual-display alternative implementation** — Stage 5 only surfaces `dxgi_dirty_rect_unavailable`; no software fallback. Future RDP support sub-plan.
- **GPU dispatch** — Stage 5 is already a GPU path (OS compositor); Stage 8's CPU→GPU migration is unrelated.
- **`mouse_drag` Stage 5 wiring** — drag has different post-state semantics (motion is during the drag, not after); out of Stage 5 v1 scope.
- **Pre/post diff variant** — current design polls only post-action rects (§7 OQ #2); pre/post would be a future Stage 5b refinement.

---

## 9. North-star reconciliation

ADR-019's load-bearing thesis (§2.2, "観測の時間軸をサーバに持ち込む" / "bring the temporal observation surface into the server") is **maximally honoured** by Stage 5 — DXGI dirty rects are temporal observations produced by the OS compositor itself. The Rust thread (PR #102) already brought the observation surface into the process; Stage 5 brings it into the **per-tool envelope**.

Stage 5 is the cleanest demonstration of the §1.3 4-primitive split: it shipped without needing any new SIMD work (§4.5 dispatch row 5: "none — OS does the diff") because the algorithm is hardware-accelerated by the GPU compositor we already pay for at every frame. The contract (`VisualMotionObservation`) sized for this in PR #309 — adding the first `dxgi_dirty_rect` emitter required only the existing enum slot.

After Stage 5, 3 of 4 §1.3 primitives are wired into ≥ 1 tool each (`structured_state` → Stage 1 UIA, `scroll_translation` → Stage 2a+2b scroll, `local_repaint` → Stage 4 mouse_click+keyboard, `any_change` → Stage 5 desktop_act). AC5 of the parent ADR is now satisfiable.

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
| TS unit | `resolveOutputIndexForHwnd` policy | `tests/unit/resolve-output-index.test.ts` (4 cases) |
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
