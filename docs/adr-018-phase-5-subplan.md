# ADR-018 Phase 5 — Sub-plan: Finalize (scroll-read migration + CI guard + integration tests + 5-app smoke + `findPlainTopLevelWindowByTitle` extraction)

- Status: **Draft (in PR feat/adr-018-phase-5-finalize)**
- Date: 2026-05-15
- Parent: `docs/adr-018-input-pipeline-3tier.md` §4 Phase 5
- Authors: Claude (Sonnet drafting + impl, Opus + Codex review)

---

## 1. Why this sub-plan exists

ADR §4 Phase 5 lists 5 deliverables. Two are blocked by carry-overs that Phase 4 sub-plan §2.2 explicitly deferred:

- **`page_end_inferred` deletion + CI grep guard for it**: Phase 4 §2.2 row "Tier 4 reason / channel rename + legacy 4 reasons → unreachable" is "a future cleanup PR". Phase 5 trunk preserves the legacy emitter in `evaluateScrollDelivery` to avoid scope creep; only the `getWindows` half of the CI guard lands.
- **Word `_WwG` / `_WwO` descendant assertion in `scroll-5app.smoke.test.ts`**: requires new `win32_enum_child_windows` napi export (Phase 4 §2.2 carry-over to Phase 5). This sub-plan **lands the smoke harness expansion but skips the Word descendant assertion** — added when the napi export lands in a follow-up PR.

Phase 5 also picks up the Phase 4 §2.2 commitment to extract `findPlainTopLevelWindowByTitle` (originally Phase 1b §2.2 / re-routed Phase 4 → 5).

---

## 2. Phase 5 scope (trunk PR)

### 2.1 In-scope deliverables

1. **`scroll-read.ts:96` `getWindows()` → `resolveWindowTarget` migration** (ADR §4 Phase 5 D1):
   - Replace the nutjs `getWindows()` flat enumeration with `resolveWindowTarget({ windowTitle })` from `_resolve-window.ts` — the destination-explicit SSOT per ADR §2.3 D3.
   - `scroll-read` must additionally bind to the resolved HWND for `region` lookup; use `getWindowRectByHwnd` (already imported in adjacent tools) to derive the `{x, y, width, height}` region. Keep the same dimension floor (`< 10 px` reject) and the same `windowTitle` substring semantics by passing the user's string through `resolveWindowTarget`.
   - The legacy `focusedWin: FocusableWin` object (used for `.focus()` later in the loop) is replaced by `focus_window`-style native focus call — `setForegroundHwnd(hwnd)` from `src/engine/win32.ts` (or equivalent existing export). Refactored to remove the nutjs `Window` object dependency.

2. **Shared `findPlainTopLevelWindowByTitle` helper extraction** (Phase 4 §2.2 carry-over):
   - Extract the Case 3 recovery predicate from `_input-pipeline.ts:268-289` (non-dialog class + no owner + non-minimized) into `_resolve-window.ts::findPlainTopLevelWindowByTitle(title: string, opts?: { excludeMinimized?: boolean }) → WindowZInfo | null`.
   - `excludeMinimized` defaults to `false` so `_resolve-window.ts` Case 3 itself can use the helper without behavior change. Phase 1b §2.2 explicitly demands this — collapsing the two predicates verbatim would re-introduce Round 4 P1 (minimized HWND as dispatch target).
   - `_input-pipeline.ts::resolveInputDestination` calls `findPlainTopLevelWindowByTitle(title, { excludeMinimized: true })` for the Case 3 recovery branch.
   - `mouse.ts:1145-1153` observation-ladder fallback also migrates to the helper — but with `excludeMinimized: true` AND **without** the dialog/owner filter (the observation ladder explicitly tolerates dialog matches). To accommodate, the helper's `opts` extends to `{ excludeMinimized?: boolean; excludeDialogsAndOwned?: boolean }`. Default both `false` for `_resolve-window.ts` parity.

3. **CI guard `.github/workflows/input-pipeline-guard.yml`** (ADR §4 Phase 5 D2, **partial**):
   - Asserts `grep -rn "getWindows" src/tools/ | grep -v -E "(// |/\*)" | wc -l` returns **0** (no production-code reference to the legacy nutjs enumeration).
   - The `page_end_inferred` sub-assertion is **deferred** per Phase 4 §2.2 carry-over. CI workflow comment links the carry-over so a future PR enabling it is one-line.
   - Runs on `pull_request` for any `src/tools/**` change. Lightweight ubuntu-latest job (no Windows runner needed).

4. **`tests/integration/reason-enum-coverage.test.ts`** (ADR §4 Phase 5 D3, new):
   - Exercises each `status='not_delivered'` emission path in `mouse.ts:scrollHandler` via mocked dispatcher returns and asserts `reason` ∈ the ADR-018 §2.6.2 5-value enum (`delivered_via_*` not applicable for `not_delivered`, so the assertion is `reason === 'target_unreachable'`).
   - Covers: (a) `dest.kind === 'cdp'` Tier 2 exhaust → `target_unreachable` + `channel:'cdp'`; (b) `dest.kind === 'hwnd' | 'uia'` Tier 3 exhaust → `target_unreachable` + `channel:'postmessage'`; (c) `dest.kind === 'unresolved'` Tier 4 (SendInput path) with no observable diff → existing legacy reason path (NOT yet `target_unreachable` per Phase 4 §2.2 deferral — test asserts current behaviour and references the deferred migration).
   - Path (c) uses the surviving legacy reason union (`evaluateScrollDelivery` emits `read_back_unsupported` etc.). Test pins current behaviour and **does not** assert ADR-018 §2.6.2 5-value; the §2.6.3 migration table converts those once the future cleanup PR lands.

5. **`tests/integration/scroll-handler-envelope.test.ts`** (ADR §4 Phase 5 D4 — renamed from `scroll-raw-verify-tier1.test.ts` for clarity):
   - `scrollHandler` envelope-assembly integration test. Mocks dispatcher to return `{channel:'uia', reason:'delivered_via_uia'}` and asserts the returned `hints.verifyDelivery.channel === 'uia'` / `hints.verifyDelivery.reason === 'delivered_via_uia'` end-to-end.
   - Asserts `observedHwnd` is seeded from `dest.hwnd` when dispatcher returns `kind:'hwnd'` (ADR §2.2 invariant — observation HWND must match action destination).
   - Pins the `effectiveChannel` ternary mapping (`'uia'` / `'cdp'` / `'postmessage'` / `'wheel_send_input'`) so a future Channel enum addition cannot silently degrade an actual Tier 1/2/3 success to `'wheel_send_input'` (Phase 4 effectiveChannel union extension regression guard).

6. **`tests/integration/scroll-5app.smoke.test.ts` expansion** (ADR §4 Phase 5 D5, **partial**):
   - Adds Notepad case (Tier 1 UIA path) to the existing `SCROLL_SMOKE=1` env-gated harness.
   - Adds Excel cell-area case (Tier 3 PostMessage expected).
   - Adds Explorer ListView case (Tier 3 expected).
   - Word case is added with both outcomes accepted (`delivered_via_postmessage` OR `target_unreachable`) per ADR §6 AC1.
   - **Word `_WwG` descendant assertion** in `word-class-enumerate.smoke.test.ts` is **NOT** added in this PR — Phase 4 §2.2 carry-over (requires new `win32_enum_child_windows` napi export). The skeleton lands in Phase 4; Phase 5 leaves it unchanged until the napi PR ships.
   - All cases CI-skipped (`SCROLL_SMOKE=1`); Word case additionally requires Word installed locally.

### 2.2 Out of scope (carry-over to future PRs)

| Item | Carries to | Reason |
|---|---|---|
| `page_end_inferred` legacy reason deletion + CI grep guard for it | Future cleanup PR | Phase 4 §2.2 explicit deferral. Removing the emitter requires migrating each call site in `evaluateScrollDelivery` to one of the ADR-018 §2.6.2 5-value reasons (`wheel_overlay_intercepted` or `target_unreachable`); the migration is mechanical but cross-cuts the Tier 4 fallback path and is best done in a focused PR alongside the `effectiveChannel` rename. |
| `effectiveChannel` local-union rename (`wheel_send_input` → `send_input`) + ADR §2.6.3 migration table execution | Future cleanup PR | Phase 4 §2.2 explicit deferral. Same scope as above. |
| `win32_enum_child_windows` napi export + Word `_WwG` / `_WwO` descendant assertion in `word-class-enumerate.smoke.test.ts` | Follow-up PR (new Rust napi) | Phase 4 §2.2 explicit deferral. Phase 5 trunk does not introduce new Rust code. |
| `wheel_overlay_intercepted` detection (DDPM-style overlay sensor) | ADR §7 OQ2 | Not gated on Phase 5. |

---

## 3. G5 acceptance (Phase 5 only)

1. **scroll-read migration**: `scroll(action='read', windowTitle:'メモ帳')` resolves the same HWND that other scroll actions resolve (via `resolveWindowTarget`), with the legacy `getWindows()` reference removed from `src/tools/`. ADR-018 symptom #6 ("`scroll(action='read', windowTitle:'メモ帳')` returns `Window not found`") is fully closed.
2. **`findPlainTopLevelWindowByTitle` extraction**: `_input-pipeline.ts::resolveInputDestination`, `_resolve-window.ts::resolveWindowTarget` (Case 3 path), and `mouse.ts:scrollHandler` observation ladder all delegate to the single helper. The two-flag option object (`{excludeMinimized, excludeDialogsAndOwned}`) preserves each call site's behaviour bit-equal — pinned by 3+ unit tests in `tests/unit/find-plain-top-level-window.test.ts` (new).
3. **CI guard**: `.github/workflows/input-pipeline-guard.yml` runs on `pull_request` for `src/tools/**`, fails the build if `grep -rn "getWindows" src/tools/` matches outside comments.
4. **`reason-enum-coverage.test.ts`**: covers all three `dest.kind` exhaust paths and pins the current `target_unreachable` emission for Tier 2/3, plus the legacy reason for Tier 4 (deferred migration noted).
5. **`scroll-handler-envelope.test.ts`**: pins the dispatcher → scrollHandler envelope assembly contract (channel/reason flow + observedHwnd seeding).
6. **5-app smoke expansion**: 4 new app cases (Notepad / Word / Excel / Explorer) land in `scroll-5app.smoke.test.ts` behind the `SCROLL_SMOKE=1` env gate. Word case accepts both `delivered_via_postmessage` and `target_unreachable` per ADR §6 AC1.
7. **Build + suite green**: `npm run build` + `npm run build:rs` succeed; full `npm test` adds the new unit/integration tests with no regression to the existing 3100+ tests.

---

## 4. CLAUDE.md sweep checklist (mandatory per §3.3 Step 1)

- **§3.1 multi-table fact sweep**: grep targets for Phase 5 facts:
  - `findPlainTopLevelWindowByTitle|excludeMinimized|excludeDialogsAndOwned|getWindows|reason-enum-coverage|scroll-handler-envelope|input-pipeline-guard` across `src/` `tests/` `docs/` `.github/`. Synchronized surfaces:
    - `src/tools/_resolve-window.ts` — new helper definition
    - `src/tools/_input-pipeline.ts` — Case 3 recovery delegates to helper
    - `src/tools/mouse.ts:1145-1153` — observation ladder delegates to helper
    - `src/tools/scroll-read.ts:91-127` — migration to `resolveWindowTarget`
    - `.github/workflows/input-pipeline-guard.yml` — new CI guard
    - `tests/unit/find-plain-top-level-window.test.ts` — helper contract pin
    - `tests/integration/reason-enum-coverage.test.ts` — `not_delivered` reason emission coverage
    - `tests/integration/scroll-handler-envelope.test.ts` — envelope assembly contract
    - `tests/integration/scroll-5app.smoke.test.ts` — 4 new app cases
    - `docs/adr-018-input-pipeline-3tier.md` §4 Phase 5 — no edits (Phase 5 is implementation of existing ADR §4 contract)
- **§3.2 carry-over scope shrink sweep**: helper extraction MUST preserve each call site's behaviour bit-equal. Pinned by:
  - `_resolve-window.ts` Case 3 uses `findPlainTopLevelWindowByTitle(title, { excludeMinimized: false, excludeDialogsAndOwned: true })` — keeps legacy behaviour where minimized windows match (Case 3 was always tolerant)
  - `_input-pipeline.ts::resolveInputDestination` uses `{ excludeMinimized: true, excludeDialogsAndOwned: true }` — matches its existing stricter predicate
  - `mouse.ts:scrollHandler` observation ladder uses `{ excludeMinimized: true, excludeDialogsAndOwned: false }` — matches its existing observation-only predicate (no dialog filter)
- **Lesson 1-4 sweep**: numeric counts pinned in §2.1 deliverable enumeration; helper extraction does not change `dispatcher` causal ordering; CI guard is a positive assertion (not a negative one whose absence is silent).

---

## 5. Risks

- **R1** — `findPlainTopLevelWindowByTitle` extraction missing one call site re-introduces predicate drift.  
  **Mitigation**: 3-call-site enumeration in §2.1#2 is explicit. Phase 5 unit tests pin per-call-site flag combinations. CI grep guard catches new `enumWindowsInZOrder().find(...)` clones in `src/tools/`.
- **R2** — `scroll-read.ts` migration changes the focused HWND semantics (legacy code stored the `Window` object for `.focus()`; new code uses `setForegroundHwnd`).  
  **Mitigation**: focus-then-read happens once per `scroll-read` call. Loss of the `Window` object reference does not affect the OCR loop because OCR uses `focusedHwnd` (hwnd) not the `Window` object. Manual smoke before merge (`SCROLL_READ_SMOKE=1` env gated).
- **R3** — 5-app smoke flakes on slow CI runners.  
  **Mitigation**: smoke is `SCROLL_SMOKE=1` env-gated, NOT in regular CI. The expansion adds cases to the manual harness only.

---

## 6. Review loop (per CLAUDE.md §3.3)

- **Step 0**: production code改修 PR → Opus + Codex 必須.
- **Step 1**: Opus review prompts for §2.1 per-call-site flag preservation correctness (helper extraction is the bit-equal pin), §3 G5 acceptance, §3.1 fact sweep, §3.2 carry-over.
- **Step 2**: Codex `@codex review` PR comment — emphasis on `scroll-read.ts` API surface change and CI guard regex correctness.
- **Step 3**: Iterate to P1 zero; auto-merge per `feedback_auto_mode_merge_opus_judgment.md`.
