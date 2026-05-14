# ADR-018 Phase 1b — Sub-plan: dispatcher skeleton + Tier 1 UIA wheel path

- Status: **Draft (in PR feat/adr-018-phase-1b-input-pipeline)**
- Date: 2026-05-13
- Parent: `docs/adr-018-input-pipeline-3tier.md` §4 Phase 1
- Authors: Claude (Sonnet drafting, Opus review)

---

## 1. Why this sub-plan exists

ADR §4 Phase 1 specifies a single trunk PR (3-4 days), but lists 9 deliverables across 5 files and adds 1 new Rust napi export. The carry-over interaction between ADR §2.6.3 reason migration ("old 4 reasons mapped") and §2.6.2 path-(b) Tier 4 guard contract is **not unambiguous** when only Tier 1 lands — Word / Excel / Chrome would either lose scroll entirely (strict path-(b) reading) or violate the guard (lenient Tier 4 fallback). This sub-plan pins the interpretation.

ADR §B Reuse map says **Phase 1 introduces zero new Rust code**, but `src/uia/scroll.rs::scroll_by_percent_impl` is `find_window(window_title: String)`-based — it cannot accept an HWND target. A new HWND-based napi export is required. The user handoff note already records this correction.

## 2. Phase 1b scope (non-destructive enhancement)

### 2.1 In-scope deliverables

1. **New `src/tools/_input-pipeline.ts`** (TS):
   - `type InputDestination = { kind: 'uia' | 'cdp' | 'hwnd' | 'unresolved'; ... }` per ADR §2.3
   - `async function resolveInputDestination(params: { hwnd?, windowTitle? })`: calls `resolveWindowTarget` first. **Case 3 recovery (Round 2 — Codex/Opus P1)**: `resolveWindowTarget` returns `null` for a plain `windowTitle` that *does* match a top-level window (it discards the matched HWND by design to keep legacy title-based callers unchanged). `resolveInputDestination` re-runs the same top-level `enumWindowsInZOrder` lookup to recover the HWND → `{ kind: 'hwnd' }`, so Tier 1 UIA stays reachable for the common windowTitle-only scroll call (otherwise G1 acceptance could never pass). `@active` is excluded from recovery (`resolveWindowTarget` owns that shorthand). Returns `{ kind: 'unresolved' }` only when no top-level window matches. ScrollPattern availability is **not** probed here — the dispatcher's native `uiaScrollByWheelAtHwnd` call probes it and returns `ok:false` for graceful fall-through.
   - `async function dispatchScroll(dest: InputDestination, params: WheelParams)`: routes Tier 1 / Tier 4 (Tier 2 / 3 stubs return `null` so callers fall through to legacy)
   - Runtime guard `assertTier4Reachable(dest)`: **lenient form for Phase 1b** — `kind === 'unresolved' || kind === 'hwnd'` is allowed (Phase 4 tightens to `'unresolved'` only when Tier 3 PostMessage lands)
   - **No exposure** to legacy callers — `scrollHandler` is the sole consumer in Phase 1b

2. **New Rust napi export `uia_scroll_by_wheel_at_hwnd`** (`src/uia/scroll.rs` + `src/lib.rs`):
   - Signature: `(hwnd: BigInt, wheel_delta_y: i32, wheel_delta_x: i32) -> ScrollResult`
   - Internal: `IUIAutomation::ElementFromHandle(HWND)` → walk to `IUIAutomationScrollPattern` → `SetScrollPercent(currentH + wheelXPct, currentV + wheelYPct)`
   - Wheel-delta → percent conversion via the pure `wheel_step_percent(wheel_delta, view_size)` helper. **Units contract (Round 2 — Codex/Opus P1)**: `Current{Vertical,Horizontal}ViewSize` is ALREADY a percentage of total content (0..100), so the step is `view_size * (delta/120) * SCROLL_STEP_MULTIPLIER` with **no extra `* 100`**. `SCROLL_STEP_MULTIPLIER = 0.1` (one notch ≈ one-tenth of the visible viewport), tunable per app in Phase 4. Pinned by `#[cfg(test)] mod tests` in `scroll.rs`.
   - Return shape unchanged from existing `ScrollResult { ok, scrolled, error }` to minimize napi surface churn

3. **scrollHandler refactor** (`src/tools/mouse.ts:1070-1204`):
   - `resolveWindowTarget` already called first — preserve
   - Add `resolveInputDestination` call after window resolution. `dest` is the dispatch destination (title-based only — explicit hwnd / `@active` / dialog chain / Case 3 enum recovery — never cursor/foreground, per Opus Round 1 P1-1). **Observation HWND (Round 2 — Opus P1-3)**: when `dest.kind === 'hwnd'` the observation HWND is seeded from `dest.hwnd` directly so observation and action share the same destination (ADR §2.2 invariant); the enum/cursor/foreground ladder in `scrollHandler` only fills in for an `'unresolved'` destination (Tier 4 nutjs path, read-only observation). Dispatcher routing never touches cursor coords.
   - Branch on `dest.kind`:
     - `'uia' | 'hwnd'` → dispatcher attempts `uia_scroll_by_wheel_at_hwnd`. If Rust path returns `scrolled:true` (UIA pre/post percent differ per ADR §2.6.2), emit `channel='uia'`, `reason='delivered_via_uia'`.
     - Else (Tier 1 returned null, or kind === 'unresolved'): legacy nutjs SendInput path preserved, emits `channel='wheel_send_input'` (the legacy literal — Phase 4 §2.6.3 migration renames to `'send_input'` along with the 4 legacy reason values), `reason` from existing `evaluateScrollDelivery` taxonomy.
   - **Tier 1 UIA failure** (UIA call returned `ok:false` or `scrolled:false`) falls through to nutjs (graceful degrade) without emitting any ADR-018 reason on that call.

4. **5-value reason `delivered_via_uia` emission**:
   - Only `delivered_via_uia` is emitted in Phase 1b; the other 4 ADR-018 reasons (`delivered_via_cdp`, `delivered_via_postmessage`, `wheel_overlay_intercepted`, `target_unreachable`) remain type-level only until Phase 3 / 4
   - **Legacy 4 reasons are retained** (`read_back_unsupported`, `page_end_inferred`, `scrollbar_unavailable`, `no_target_window`) — they continue to emit from the nutjs fall-through path. Their removal is deferred to Phase 4 when Tier 3 PostMessage replaces nutjs fall-through entirely. The §2.6.3 migration table executes in Phase 4, not 1b.

5. **Unit tests**:
   - Add `tests/unit/input-pipeline-dispatch.test.ts`: mock `uiaScrollByWheelAtHwnd` + `resolveWindowTarget` + `enumWindowsInZOrder`, assert `resolveInputDestination` (incl. Case 3 recovery) and `dispatchScrollWheel` branch deterministically per `dest.kind` — **done**
   - `scroll.rs` math: pure `wheel_step_percent` helper pinned by `#[cfg(test)] mod tests` (no-extra-`*100` regression guard) — **done**
   - `tests/unit/scroll-raw-verify.test.ts`: 5-value reason enum type-assignability lock — **already present** (added Phase 1a, still passes post-refactor; the `ScrollVerifyOutcome.reason` union was not changed by Phase 1b)
   - `tests/unit/scroll-raw-verify-tier1.test.ts` (`scrollHandler` envelope integration: `verifyDelivery.channel='uia'` / `reason='delivered_via_uia'` end-to-end): **OPEN — Round 2 review item**, see §2.2 carry-over row. Not yet created; the dispatcher-level contract is pinned by `input-pipeline-dispatch.test.ts`, but the `scrollHandler` envelope-emission path (`effectiveChannel` ternary, `observedHwnd` seeding, `verifyDelivery` construction) is not yet integration-tested.
   - Add `__test__/fixtures/overlay-window.ts` skeleton: stubs the `WS_EX_LAYERED | WS_EX_TRANSPARENT` Win32 child process; integration assertion runs only in Phase 4 / Phase 5 smoke (Phase 1b lands the file so Phase 4 can reuse without churn) — **done**

### 2.2 Out of scope (carry-over to later phases)

| Item | Carries to | Reason |
|---|---|---|
| Tier 2 CDP `dispatchMouseEvent({type:'mouseWheel'})` wrapper | Phase 3 | ADR §4 |
| Tier 3 `postWheelToHwnd` + WM_MOUSEWHEEL encoding | Phase 4 | ADR §4 |
| Legacy 4 reasons deletion + §2.6.3 migration | Phase 4 | Tier 3 must land first to claim coverage |
| Strict Tier 4 guard (`kind === 'unresolved'` only) | Phase 4 | Lenient form (`'unresolved' | 'hwnd'`) prevents Phase 1b regression on Word/Chrome |
| `getWindows()` → `resolveWindowTarget` in `scroll-read.ts` | Phase 5 | ADR §4 |
| `input-pipeline-guard.yml` CI gate | Phase 5 | Depends on Phase 4 legacy deletion |
| 5-app smoke | Phase 5 | Depends on Phase 3/4 transport coverage |
| `scroll-raw-verify-tier1.test.ts` (`scrollHandler` envelope integration test) | **OPEN — Round 2 review item** | Sub-plan §2.1#5 deliverable not created in the trunk PR. Opus Round 3 to decide: Phase 1b-required (add before merge) vs Phase 5 carry-over (fold into the 5-app smoke harness, which already needs full `scrollHandler` wiring). Dispatcher-level contract is covered by `input-pipeline-dispatch.test.ts`; the gap is the `scrollHandler` envelope path. |

## 3. G1 acceptance (Phase 1b only)

1. `scroll(action='raw', windowTitle:'メモ帳', direction:'down')` returns `verifyDelivery.status='delivered'`, `channel='uia'`, `reason='delivered_via_uia'`, with numeric `scrollObserved.delta` (Notepad exposes UIA ScrollPattern on its document edit control)
2. Pre-Phase-1b callers that hit a non-UIA path (Chrome / Excel / Word) **return the same shape as today** (`channel='send_input' | 'wheel_send_input'`, legacy reasons) — zero regression
3. Tier 4 SendInput **never fires** when `dest.kind === 'uia'` and the UIA call returned `scrolled:true` (asserted via unit-test spy on `mouse.scrollDown/Up/Left/Right`)
4. `__test__/fixtures/overlay-window.ts` skeleton file lands (no live behaviour test in Phase 1b — Phase 4 wires it)
5. `npm run build` + `npm run build:rs` (when Rust skip-able for non-Win32 hosts is preserved) succeed; full vitest run shows no regression

## 4. CLAUDE.md sweep checklist (mandatory per §3.3 Step 1)

- **§3.1 multi-table fact sweep**: `Grep "delivered_via_uia|verifyDelivery.channel|InputDestination|uia_scroll_by_wheel_at_hwnd"` across `src/` `tests/` `docs/`. Synchronized surfaces:
  - `src/tools/mouse.ts:943-977` ScrollVerifyOutcome union — adds `channel` field at emission sites (already declared in `verifyDelivery` shape at `:1176-1187`)
  - `src/tools/_input-pipeline.ts` (new) dispatcher
  - `src/tools/_errors.ts:256-262` SUGGESTS — Phase 1b adds `delivered_via_uia` to neighbouring docs only (Phase 4 rewrites for migration)
  - `src/tools/scroll.ts:249-256` caveats — Phase 1b adds 1 line "Tier 1 UIA path enabled for UIA-aware apps (Notepad, native ListView). Other apps continue via SendInput."
  - `docs/adr-018-input-pipeline-3tier.md` §4 Phase 1 unchanged
- **§3.2 carry-over scope shrink**: legacy nutjs SendInput path **preserved unchanged**. `dest.kind === 'hwnd'` (resolved but no UIA) routes through nutjs in Phase 1b (lenient Tier 4 guard) — does not break existing API contract per §2.6.3.
- **Lesson 1-4**: (1) dispatcher branches by `dest.kind` discriminator, no causal-window mismatch; (2) `assertTier4Reachable` is runtime-not-compile-time guard; (3) Phase 1a contract lock (5-value type) + Phase 1b emission lands first reason — order is consistent; (4) wheel-delta → percent conversion is a single helper with unit-test coverage, no count drift.

## 5. Review loop

Per ADR §4 Phase 1 + CLAUDE.md §3.3 Step 0 (production code + native binding):
- **Opus 3+ rounds** mandatory (architecture / fact integrity / scope shrink axis)
- **Codex 1+ round** required when usage available; if unavailable, escalate Opus to 4+ rounds with extra Rust-API-contract emphasis (PR #102 §3.2 case-study axis)
- Round 1 prompt must include CLAUDE.md §3.1 grep sweep + §3.2 carry-over sweep + Lesson 1-4 sweep + `file:line` citations

## 6. File-level work plan

| File | Action |
|---|---|
| `docs/adr-018-phase-1b-subplan.md` | **new** (this file) |
| `src/tools/_input-pipeline.ts` | **new** (~150 lines) |
| `src/uia/scroll.rs` | append `scroll_by_wheel_at_hwnd_impl` + `ScrollByWheelAtHwndOptions` |
| `src/lib.rs` | append `uia_scroll_by_wheel_at_hwnd` napi export + `UiaScrollByWheelAtHwndTask` |
| `src/tools/mouse.ts:1070-1204` | refactor `scrollHandler` to call dispatcher; UIA branch emits new channel/reason; nutjs branch preserved |
| `src/tools/scroll.ts:249-256` | add 1 caveat line |
| `tests/unit/input-pipeline-dispatch.test.ts` | **new** |
| `tests/unit/scroll-raw-verify-tier1.test.ts` | **new** |
| `tests/unit/scroll-raw-verify.test.ts:130-159` | append type-level pin (no rewrite) |
| `__test__/fixtures/overlay-window.ts` | **new** (skeleton, no live behaviour) |
| `index.js` / `index.d.ts` (napi loader) | re-export new napi function |

Total ≈ 5 new files + 5 modified files. Expected diff ≈ +600 / -50 lines.
