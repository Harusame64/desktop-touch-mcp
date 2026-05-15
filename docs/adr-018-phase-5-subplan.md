# ADR-018 Phase 5 — Sub-plan: Finalize trunk (scroll-read/-capture migration + `findPlainTopLevelWindowByTitle` extraction + CI guard)

- Status: **Draft (in PR feat/adr-018-phase-5-finalize)**
- Date: 2026-05-15
- Parent: `docs/adr-018-input-pipeline-3tier.md` §4 Phase 5
- Authors: Claude (Sonnet drafting + impl, Opus + Codex review)

---

## 1. Why this sub-plan exists

ADR §4 Phase 5 lists 5 deliverables. Two are blocked by carry-overs that Phase 4 sub-plan §2.2 explicitly deferred:

- **`page_end_inferred` deletion + CI grep guard for it**: Phase 4 §2.2 row "Tier 4 reason / channel rename + legacy 4 reasons → unreachable" is "a future cleanup PR". Phase 5 trunk preserves the legacy emitter in `evaluateScrollDelivery` to avoid scope creep; only the `getWindows` half of the CI guard lands.
- **Word `_WwG` / `_WwO` descendant assertion in `scroll-5app.smoke.test.ts`**: ~~requires new `win32_enum_child_windows` napi export (Phase 4 §2.2 carry-over to Phase 5).~~ **Updated 2026-05-15**: superseded by `win32_find_scroll_leaf_for_top_level` (PR fix/adr-018-excel-scroll-leaf-walker) — a class-chain `FindWindowExW` walker that already encodes `OpusApp → _WwF → _WwG`. The descendant assertion remains a smoke-test artefact and can land when the 4-app harness expansion lands, asserting against the new helper. This sub-plan still **lands the smoke harness expansion but skips the Word descendant assertion**.

Phase 5 also picks up the Phase 4 §2.2 commitment to extract `findPlainTopLevelWindowByTitle` (originally Phase 1b §2.2 / re-routed Phase 4 → 5).

---

## 2. Phase 5 scope (trunk PR)

### 2.1 In-scope deliverables (Round 1 honest scope reduction)

> **Scope correction (PR #306 Opus Round 1 P1-1)**: the Round-0 draft listed 6 deliverables. Round 1 review confirmed only 3 land in this PR. The remaining 3 (`reason-enum-coverage.test.ts` / `scroll-handler-envelope.test.ts` integration tests / `scroll-5app.smoke.test.ts` 4-app expansion) are explicitly re-routed to §2.2 carry-over to keep the PR scope honest. They are not blocked by Phase 5 trunk and can land in a Phase 5+N follow-up PR without re-opening this PR.

1. **`scroll-read.ts:91-127` + `scroll-capture.ts:340-380` `getWindows()` → `resolveWindowTarget` migration** (ADR §4 Phase 5 D1, scope **expanded** to include scroll-capture since the symptom #6 root cause applies symmetrically):
   - Replace the nutjs `getWindows()` flat enumeration with `resolveWindowTarget({ windowTitle })` from `_resolve-window.ts` — the destination-explicit SSOT per ADR §2.3 D3.
   - The resolved HWND is passed to `restoreAndFocusWindow(hwnd)` from `src/engine/win32.ts` which (a) restores from minimised via `SW_RESTORE`, (b) calls `SetForegroundWindow`, (c) returns the post-focus rect. This is a **deliberate behaviour improvement** over the legacy `Window.focus()` (nutjs) which did not restore minimised windows: OCR / scroll-capture cannot run on a minimised window anyway, so the auto-restore eliminates a silent failure mode.
   - Keep the same dimension floor (`< 10 px` for scroll-read; `< 100 px` for scroll-capture — both preserved from legacy) and the same `windowTitle` substring semantics by passing the user's string through `resolveWindowTarget`.
   - `focusedHwnd` type narrows from `unknown` to `bigint | null` for the loop body; type narrowing at the call sites for `recognizeWindowByHwnd` / `canInjectAtTarget` / `postKeyComboToHwnd` is **deferred** — those helpers still accept `unknown` (separate `bigint` tightening follow-up; PR #306 Round 1 P2-3 carry-over).

2. **Shared `findPlainTopLevelWindowByTitle` helper extraction** (Phase 4 §2.2 carry-over):
   - Extract the Case 3 recovery predicate from `_input-pipeline.ts:268-289` (non-dialog class + no owner + non-minimized) into `_resolve-window.ts::findPlainTopLevelWindowByTitle(title: string, opts?: { excludeMinimized?: boolean }) → WindowZInfo | null`.
   - `excludeMinimized` defaults to `false` so `_resolve-window.ts` Case 3 itself can use the helper without behavior change. Phase 1b §2.2 explicitly demands this — collapsing the two predicates verbatim would re-introduce Round 4 P1 (minimized HWND as dispatch target).
   - `_input-pipeline.ts::resolveInputDestination` calls `findPlainTopLevelWindowByTitle(title, { excludeMinimized: true })` for the Case 3 recovery branch.
   - `mouse.ts:1145-1153` observation-ladder fallback also migrates to the helper — but with `excludeMinimized: true` AND **without** the dialog/owner filter (the observation ladder explicitly tolerates dialog matches). To accommodate, the helper's `opts` extends to `{ excludeMinimized?: boolean; excludeDialogsAndOwned?: boolean }`. Default both `false` for `_resolve-window.ts` parity.

3. **CI guard `.github/workflows/input-pipeline-guard.yml`** (ADR §4 Phase 5 D2, **partial**):
   - Asserts 3 detection shapes return **0 hits** across the scroll-family file set (`scroll-read.ts` / `scroll-capture.ts` / `_input-pipeline.ts` / `mouse.ts` / `_resolve-window.ts` — **mouse.ts + _resolve-window.ts added Round 2 Codex P2-A: the workflow's `pull_request.paths` trigger filter already covered these, so the actual scan set must match**):
     1. Call site: `await   getWindows\b` (any whitespace) OR bare `\bgetWindows\(\)` (no await).
     2. Single-line import: `import { ..., getWindows, ... } from "..nutjs"` — any position in import list.
     3. Multi-line import: `awk` block-match for `import { ... }` spanning lines where `nutjs` is on the `from` line AND `getWindows` appears anywhere in the brace pair.
   - The exact regex / awk shapes are pinned in the workflow file; sub-plan §2.1#3 and workflow MUST be kept in bit-equal sync via `grep "getWindows" docs/adr-018-phase-5-subplan.md .github/workflows/input-pipeline-guard.yml`.
   - **Scope narrowed to scroll-family files** (`scroll-read.ts` / `scroll-capture.ts` / `_input-pipeline.ts`). `screenshot.ts` migration is §2.2 carry-over per Phase 5 sub-plan; ADR §6 AC5 "grep src/tools/ returns 0" is interpreted as "no nutjs `getWindows()` call in the scroll-family pipeline tools" since the symptom #6 root cause (`scroll(action='read')` divergent semantics) only applied to that family. **ADR §6 AC5 amendment** — see PR companion ADR update.
   - The `page_end_inferred` sub-assertion is **deferred** per Phase 4 §2.2 carry-over. CI workflow comment links the carry-over so a future PR enabling it is one-line.
   - Runs on `pull_request` for `src/tools/scroll*.ts` / `src/tools/mouse.ts` / `src/tools/_input-pipeline.ts` / `src/tools/_resolve-window.ts` / the workflow file itself. Lightweight ubuntu-latest job (no Windows runner needed).

### 2.2 Out of scope (carry-over to future PRs)

| Item | Carries to | Reason |
|---|---|---|
| **`tests/integration/reason-enum-coverage.test.ts`** (originally Phase 5 D3) | Phase 5+N follow-up PR | PR #306 Opus Round 1 P1-1 honest scope reduction. Pure-integration test, no Phase 5 contract dependency; can land independently. |
| **`tests/integration/scroll-handler-envelope.test.ts`** (originally Phase 5 D4) | Phase 5+N follow-up PR | PR #306 Opus Round 1 P1-1 honest scope reduction. Pinning the `effectiveChannel` → `verifyDelivery` mapping requires mocking the full `scrollHandler` wire — separate PR. |
| **`scroll-5app.smoke.test.ts` 4-app expansion** (originally Phase 5 D5 — Notepad / Word / Excel / Explorer cases) | Phase 5+N follow-up PR | PR #306 Opus Round 1 P1-1 honest scope reduction. Smoke harness is `SCROLL_SMOKE=1` env-gated and adds locally-validated assertions; can land independently. |
| **`screenshot.ts` `getWindows()` migration** | Future PR | Different tool concern (image capture vs scroll dispatcher). ADR §6 AC5 amended to scope `getWindows` 0-hit to scroll-family tools only — see ADR amendment in this PR. |
| `page_end_inferred` legacy reason deletion + CI grep guard for it | Future cleanup PR | Phase 4 §2.2 explicit deferral. Removing the emitter requires migrating each call site in `evaluateScrollDelivery` to one of the ADR-018 §2.6.2 5-value reasons (`wheel_overlay_intercepted` or `target_unreachable`); the migration is mechanical but cross-cuts the Tier 4 fallback path and is best done in a focused PR alongside the `effectiveChannel` rename. |
| `effectiveChannel` local-union rename (`wheel_send_input` → `send_input`) + ADR §2.6.3 migration table execution | Future cleanup PR | Phase 4 §2.2 explicit deferral. Same scope as above. |
| ~~`win32_enum_child_windows` napi export~~ → `win32_find_scroll_leaf_for_top_level` napi (smaller class-chain shape) + Word `_WwG` / `_WwO` descendant smoke assertion | **Helper landed 2026-05-15** (PR fix/adr-018-excel-scroll-leaf-walker); smoke assertion still a follow-up alongside the 4-app harness expansion | Phase 4 §2.2 explicit deferral. The runtime dispatcher fix landed via a smaller class-chain table (`FindWindowExW` walks XLMAIN→XLDESK→EXCEL7 and OpusApp→_WwF→_WwG); the generic `EnumChildWindows` enumerator was not needed and was superseded. See `docs/adr-018-phase-5-followup-leaf-walker-subplan.md`. |
| `bigint` tightening of `recognizeWindowByHwnd` / `canInjectAtTarget` / `postKeyComboToHwnd` signature (currently `hwnd: unknown`) | Future PR | PR #306 Opus Round 1 P2-3 carry-over. TS narrowing benefit at the helper layer requires sweep of the 6+ existing callers; out of scroll-family scope. |
| `wheel_overlay_intercepted` detection (DDPM-style overlay sensor) | ADR §7 OQ2 | Not gated on Phase 5. |

---

## 3. G5 acceptance (Phase 5 trunk PR — Round 1 honest scope: 3 items)

1. **scroll-read + scroll-capture migration**: `scroll(action='read', windowTitle:'メモ帳')` and `scroll(action='capture', windowTitle:'メモ帳')` both resolve the same HWND that other scroll actions resolve (via `resolveWindowTarget` + Case 3 recovery via the shared helper), with the legacy `getWindows()` reference removed from `scroll-read.ts` / `scroll-capture.ts` / `_input-pipeline.ts`. ADR-018 symptom #6 ("`scroll(action='read', windowTitle:'メモ帳')` returns `Window not found`") is fully closed for the scroll family.
2. **`findPlainTopLevelWindowByTitle` extraction**: `_input-pipeline.ts::resolveInputDestination`, `_resolve-window.ts::resolveWindowTarget` (Case 3 path), and `mouse.ts:scrollHandler` observation ladder all delegate to the single helper. The two-flag option object (`{excludeMinimized, excludeDialogsAndOwned}`) preserves each call site's behaviour bit-equal — pinned by **9** unit cases in `tests/unit/find-plain-top-level-window.test.ts` (new).
3. **CI guard**: `.github/workflows/input-pipeline-guard.yml` runs on `pull_request` for the scroll-family file globs, fails the build if `await getWindows()` or `getWindows[...].nutjs` reappears in any scroll-family tool.
4. **Build + suite green**: `npm run build` + `npm run build:rs` succeed; full `npm test` adds the new unit tests with no regression to the existing 3100+ tests. Pre-existing flakes (`replay-backend` cold/warm timing + `ui-pattern-store-persistence` ENOENT race) remain pre-existing and unchanged by this PR.

> **Carry-over G5 items** (originally 4-6 in Round 0): `reason-enum-coverage.test.ts` / `scroll-handler-envelope.test.ts` integration tests / `scroll-5app.smoke.test.ts` 4-app expansion → §2.2 carry-over. Their absence does not block Phase 5 trunk closure because they pin contracts that are already covered at unit level (dispatcher contract → `input-pipeline-dispatch.test.ts`, helper contract → `find-plain-top-level-window.test.ts`).

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
    - `docs/adr-018-input-pipeline-3tier.md` §4 Phase 5 — block rewritten to declare PR #306 trunk scope (3 deliverables) + Phase 5+N follow-up list, in bit-equal sync with §2.2 of this sub-plan (Round 2 P1-A propagation)
    - `docs/adr-018-input-pipeline-3tier.md` §3 SSOT table — added `scroll-capture.ts` + `_resolve-window.ts` rows; CI guard description narrowed to scroll-family (Round 2 P1-A)
    - `docs/adr-018-input-pipeline-3tier.md` §6 AC5 — already narrowed in Round 1 P1-2
    - `docs/adr-018-phase-4-subplan.md` §2.2 — updated to reflect that `findPlainTopLevelWindowByTitle` landed in Phase 5 trunk PR #306; Word EnumChildWindows + 4-app smoke now extend the chain to Phase 5+N follow-up (Round 2 P1-C)
- **§3.2 carry-over scope shrink sweep**: helper extraction MUST preserve each call site's behaviour bit-equal. Pinned by:
  - `_resolve-window.ts` Case 3 uses `findPlainTopLevelWindowByTitle(title, { excludeMinimized: false, excludeDialogsAndOwned: true })` — keeps legacy behaviour where minimized windows match (Case 3 was always tolerant)
  - `_input-pipeline.ts::resolveInputDestination` uses `{ excludeMinimized: true, excludeDialogsAndOwned: true }` — matches its existing stricter predicate
  - `mouse.ts:scrollHandler` observation ladder uses `{ excludeMinimized: true, excludeDialogsAndOwned: false }` — matches its existing observation-only predicate (no dialog filter)
- **Lesson 1-4 sweep**: numeric counts pinned in §2.1 deliverable enumeration; helper extraction does not change `dispatcher` causal ordering; CI guard is a **negative assertion** (`grep returns 0 hits`) that fails the build on regression — explicit and observable rather than silently absent (Round 2 P2-A correction: "negative" matches ADR §4 line 317 terminology).

---

## 5. Risks

- **R1** — `findPlainTopLevelWindowByTitle` extraction missing one call site re-introduces predicate drift.  
  **Mitigation**: 3-call-site enumeration in §2.1#2 is explicit. Phase 5 unit tests pin per-call-site flag combinations. CI grep guard catches new `enumWindowsInZOrder().find(...)` clones in scroll-family tools.
- **R2** — `scroll-read.ts` + `scroll-capture.ts` migration changes the focused HWND semantics. Legacy code used nutjs `Window.focus()` which set foreground but did NOT restore minimised windows. New code uses `restoreAndFocusWindow(hwnd)` from `src/engine/win32.ts` which **additionally calls `ShowWindow(SW_RESTORE)` before `SetForegroundWindow`** — an intentional behaviour improvement, not bit-equal sync of the legacy. The improvement eliminates a silent failure mode where a minimised target was previously unreachable.  
  **Mitigation**: focus-then-read happens once per call. The auto-restore is a strict superset of legacy behaviour for the OCR / capture use case (a minimised window cannot be captured anyway). Manual smoke before merge (`SCROLL_READ_SMOKE=1` env gated).
- **R3** — CI guard regex scope mismatch with sub-plan §2.1#3 text leads to false-negative drift over time.  
  **Mitigation**: §2.1#3 documents the exact regex shape so the workflow file and sub-plan stay bit-equal. Two-place fact (§3.1 multi-table) — Opus review prompt for any Phase 5+N PR touching the regex must grep both surfaces.

---

## 6. Review loop (per CLAUDE.md §3.3)

- **Step 0**: production code改修 PR → Opus + Codex 必須.
- **Step 1**: Opus review prompts for §2.1 per-call-site flag preservation correctness (helper extraction is the bit-equal pin), §3 G5 acceptance, §3.1 fact sweep, §3.2 carry-over.
- **Step 2**: Codex `@codex review` PR comment — emphasis on `scroll-read.ts` API surface change and CI guard regex correctness.
- **Step 3**: Iterate to P1 zero; auto-merge per `feedback_auto_mode_merge_opus_judgment.md`.
