# ADR-018 Phase 5+N — Sub-plan: Excel cell-grid scroll regression fix via FindWindowExW leaf-walker

- Status: **Draft (in PR fix/adr-018-excel-scroll-leaf-walker)**
- Date: 2026-05-15
- Parent: `docs/adr-018-input-pipeline-3tier.md` §4 Phase 5 §2.2 carry-over #6
- Authors: Claude (Sonnet drafting + impl, Opus + Codex review)
- Trigger: 2026-05-15 dogfood on main (`26d920b`) found `scroll(action='raw', windowTitle:'Book1 - Excel', direction:'down')` returns `ok:false code:'ScrollNotDelivered' verifyDelivery:{status:'not_delivered', channel:'postmessage', reason:'target_unreachable'}` — a user-visible regression vs v1.5.1 (pre-ADR-018) where the legacy SendInput path under the cursor worked.

---

## 1. Why this sub-plan exists

ADR-018 §6 AC1 lists Excel as a `delivered_via_postmessage` target. Dogfood on main proves Excel actually hits §2.6.2 path-(b) `target_unreachable` because:

1. **WM_MOUSEWHEEL propagation is upward-only** (Microsoft Learn, DefWindowProc spec). `PostMessage(top_level, WM_MOUSEWHEEL, …)` never trickles down to the child HWND that actually owns the scrollbar.
2. **Excel HWND chain**: `XLMAIN` (top-level) → `XLDESK` → `EXCEL7` (cell grid; scrollbar is on `EXCEL7`, painted as `NUIScrollbar`).
3. `postWheelToHwnd` posts to top-level `XLMAIN`; `win32_get_scroll_info(XLMAIN, vertical)` returns `null` (no Win32 scrollbar at top-level) — current implementation surfaces `target_unreachable`.
4. Phase 5 §2.2 carry-over #6 anticipated this via `win32_enum_child_windows` + iterate-children, but a simpler shape (FindWindowExW class chain table) covers the two confirmed cases (Excel + Word `_WwG`) with no enumeration overhead and zero behavioural drift for non-MDI apps.

This sub-plan supersedes the original carry-over #6 framing and lands a **smaller (~70 line)** fix that preserves the destination-explicit-HWND principle.

---

## 2. Scope

### 2.1 In-scope deliverables

1. **New Rust napi `win32_find_scroll_leaf_for_top_level(top_hwnd: BigInt) → Option<BigInt>`** in `src/win32/window.rs` (additive; no changes to existing exports):
   - Maintains a small static class chain table:
     ```
     [
       ("XLMAIN",  &["XLDESK", "EXCEL7"]),   // Excel: top → desktop → workbook leaf
       ("OpusApp", &["_WwF",   "_WwG"]),     // Word:  top → frame    → grid leaf
     ]
     ```
   - Looks up the top HWND's class via `GetClassNameW`. If absent from the table → `None` (no-op; caller uses the top HWND unchanged).
   - If present, walks `FindWindowExW` once per chain segment. Any miss → `None` (defensive: a future Excel version that drops `XLDESK` returns to top-level POST behaviour rather than mis-routing).
   - Returns the leaf HWND on full chain success.
   - Implementation budget: ~50 lines of Rust (single function + table constant + `GetClassNameW` UTF-16 helper).
   - Annotated `#[napi]`. Goes through `napi_safe_call` per the existing window.rs pattern (panic-safe across napi boundary).

2. **TS dispatcher hook** in `src/tools/_input-pipeline.ts::postWheelToHwnd` (~20 lines):
   - Before the first `postMessage(hwnd, …)` call, attempt `nativeWin32?.win32FindScrollLeafForTopLevel(hwnd_bigint)`.
   - If the helper returns a non-null leaf HWND, use the leaf for: (a) `getWindowRectByHwnd` (so lParam centres on leaf, not top-level — Excel rejects wheels whose lParam is outside the recipient's client rect per web-research finding), (b) every `postMessage` call in the chunking loop, (c) the `nativeL1?.l1PushHwInputPostMessage` L1 capture call, (d) the pre/post `getScrollInfo` snapshot reads.
   - If the helper returns null or is undefined (older `.node` build), fall through to current behaviour (POST to top-level).
   - Single early-binding read at function entry; subsequent calls reuse the resolved leaf.

3. **Native types sync**:
   - `src/engine/native-engine.ts` `NativeWin32` interface: add `win32FindScrollLeafForTopLevel(hwnd: BigInt): BigInt | null`.
   - `index.d.ts` + `index.js` (hand-maintained re-exports, per existing pattern noted in `scripts/build-rs.mjs` log "restored hand-maintained index.d.ts / index.js").

4. **Unit tests** (in existing `tests/unit/input-pipeline-dispatch.test.ts`, expanding the Phase 4 describe block):
   - Mock `nativeWin32.win32FindScrollLeafForTopLevel` to return a leaf HWND; assert `postMessage` / `getScrollInfo` / `l1PushHwInputPostMessage` all use the leaf HWND.
   - Mock to return `null`; assert behaviour identical to pre-PR (top-level HWND used everywhere).
   - Mock to return `undefined` (binding missing); assert graceful fall-through (no throw, top-level HWND used).
   - Mock leaf with a different rect from top; assert lParam high/low words match the leaf's centre.
   - Mock the walker to throw a native error (R4 — `GetClassNameW` on stale HWND, etc.); assert the throw is caught locally and the top-level POST proceeds.
   - **Chain-trust follow-up (Cases 6 / 7, added by PR #308)**: leaf retargeted AND `getScrollInfo(leaf, axis)` returns null → emit `delivered_via_postmessage` per the Case 2a chain-table trust path (the Excel `NUIScrollbar` / Word MFC custom-paint observation gap); AND not-retargeted AND `getScrollInfo` null → preserve Case 2b emit-null behaviour so the caller surfaces `target_unreachable`.
   - Total: 7 new cases.

5. **Docs update**:
   - `docs/adr-018-input-pipeline-3tier.md`:
     - §3 SSOT table: add `src/win32/window.rs` row for the new napi.
     - §4 Phase 5+N follow-up list: mark "win32_enum_child_windows napi + Word `_WwG` / `_WwO` descendant assertion" as **superseded by `win32_find_scroll_leaf_for_top_level` (this PR)**; the smoke test deferral stays as carry-over because it depends on the harness expansion, not on the napi shape.
     - §6 AC1: clarification that Excel + Word `_WwG` deliver via the leaf-targeted Tier 3 PostMessage path (no AC text change — AC1 already permits Word `_WwG` to deliver via Tier 3; this PR makes the Excel path actually deliver).
   - `docs/adr-018-phase-4-subplan.md` §2.2 + `docs/adr-018-phase-5-subplan.md` §2.2: update carry-over rows to mark `win32_enum_child_windows` as supplanted by this PR's `win32_find_scroll_leaf_for_top_level`.
   - CHANGELOG entry under `[Unreleased]` (release will collapse this into the v1.6.0 entry):
     ```
     ### Fixed
     - **Excel cell-grid scroll** now delivers via Tier 3 PostMessage to the
       `XLMAIN → XLDESK → EXCEL7` leaf child window. Previously
       `scroll(action='raw', windowTitle:'Book1 - Excel')` returned
       `target_unreachable` because `WM_MOUSEWHEEL` does not propagate from
       a top-level window down to its children (Win32 contract). The same fix
       covers Word `OpusApp → _WwF → _WwG` for documents whose grid surface
       is exposed below the top-level frame.
     ```

### 2.2 Out of scope (kept as carry-over)

| Item | Reason |
|---|---|
| `win32_enum_child_windows` generic napi | Superseded for the Excel/Word fix. Future MDI apps that don't fit the table can be added by extending the table; if a need for unknown-app coverage emerges, the generic enum can land as a separate PR. |
| Smoke harness `scroll-5app.smoke.test.ts` 4-app expansion | Independent test infra carry-over (Phase 5 §2.2). Will be added alongside other smoke expansions in a dedicated PR. |
| `page_end_inferred` deletion + `effectiveChannel` rename | Unchanged Phase 4 §2.2 carry-over. |
| `bigint` tightening of `hwnd: unknown` helpers | Unchanged Phase 5 §2.2 carry-over. |
| Tier 1 UIA DFS subtree fallback improvements (depth / node_budget tuning for Excel) | Future optimisation. The leaf-walker fix routes Excel through Tier 3 deterministically, so Tier 1 tuning is no longer on the critical path. |

---

## 3. CLAUDE.md sweep checklist (per §3.3 Step 1)

- **§3.1 multi-table fact sweep**: grep targets for this PR:
  - `XLMAIN|XLDESK|EXCEL7|_WwG|_WwF|OpusApp|find_scroll_leaf|FindWindowExW` across `src/` `tests/` `docs/`. Synchronized surfaces:
    - `src/win32/window.rs` — new napi definition + table
    - `src/engine/native-engine.ts` — NativeWin32 interface extension
    - `index.d.ts` + `index.js` — hand-maintained re-exports
    - `src/tools/_input-pipeline.ts::postWheelToHwnd` — dispatcher hook
    - `tests/unit/input-pipeline-dispatch.test.ts` — new test cases
    - `docs/adr-018-input-pipeline-3tier.md` §3 / §4 / §6 — SSOT update
    - `docs/adr-018-phase-4-subplan.md` §2.2 / `docs/adr-018-phase-5-subplan.md` §2.2 — carry-over status update
    - CHANGELOG — release-time entry
- **§3.2 carry-over scope shrink sweep**: this PR resolves carry-over #6 with a smaller shape than originally specified — confirm no public API regression. Specifically:
  - `postWheelToHwnd`'s public signature (`hwnd: bigint, params: WheelParams`) is unchanged — the leaf-walker is internal.
  - The L1 capture event records the **leaf** HWND (not top-level) — this is the correct destination-explicit record per ADR-007 P5a contract. Document the L1 stream shape in the PR description so downstream consumers (replay tooling) see the change clearly.
  - When the leaf walker returns null (non-MDI app), behaviour is bit-equal to current main. Unit test pins this.
- **Lesson 1-4 sweep**:
  - Causal window: the leaf-walker is a single lookup at function entry; subsequent reads of `effectiveHwnd` cannot diverge.
  - Compile-time guard overreliance: the FindWindowExW chain is runtime-validated (each segment can fail). Defensive null return on any miss prevents wrong-window POST.
  - Order matters: the chain walk is sequential (parent → child by class name); reversing would not match.
  - Numeric counts: 2 entries in the chain table, 7 new test cases — pinned in §2.1 (5 from the initial PR, 2 added by the PR #308 chain-trust follow-up for Case 2a / 2b pin).

---

## 4. Risks

- **R1** — A future Excel/Word version reorganises the HWND chain (e.g. drops `XLDESK`).
  **Mitigation**: defensive null return on any segment miss → falls back to top-level POST (current behaviour). User sees the same `target_unreachable` they see today, not silent mis-routing to the wrong window.

- **R2** — Other MDI apps with similar regressions (PowerPoint, Outlook, OneNote) are not covered by the 2-entry table.
  **Mitigation**: table-driven design makes adding entries trivial (one line per app). Future dogfood iterations can extend.

- **R3** — L1 capture stream changes the HWND it records (top-level → leaf) which downstream replay tools may not expect.
  **Mitigation**: PR description explicitly notes this. The leaf HWND is the correct destination-explicit record per ADR-007 P5a, so this is a contract improvement, not regression. Replay tooling sees a HWND that points to the actual scrollbar owner — better fidelity.

- **R4** — `GetClassNameW` for a stale/closed HWND returns garbage.
  **Mitigation**: `napi_safe_call` traps panics; `GetClassNameW` failure → `None` return (caller falls through). Stale-HWND POST itself is already handled by existing `postMessage` returning false.

- **R5** — CLAUDE.md §3.1 multi-table fact sweep — the chain table is duplicated nowhere else, so drift cannot occur within the codebase. Documentation references to "XLMAIN/EXCEL7" / "_WwG" exist in `docs/adr-018-*` and must stay in sync with the code table; the sweep checklist enumerates them.

---

## 5. G-acceptance

- **G1**: dogfood `scroll(action='raw', windowTitle:'Book1 - Excel', direction:'down')` returns `ok:true verifyDelivery:{status:'delivered', channel:'postmessage', reason:'delivered_via_postmessage'}` with numeric `scrollObserved.delta` (or `'unverifiable'` only if scrollbar API is missing — never `target_unreachable`).
- **G2**: dogfood the same call on Notepad / Word / Explorer — all preserve current passing behaviour (`channel:'uia'` / `reason:'delivered_via_uia'`).
- **G3**: dogfood on a non-MDI app (e.g. Chrome) — leaf-walker returns null, behaviour bit-equal to current main.
- **G4**: full `npm test` green (no regression to existing 3100+ tests; 4 new cases pass).
- **G5**: `npm run build:rs` succeeds (new napi exports cleanly).
- **G6**: ADR §3 SSOT table + Phase 4/5 sub-plan §2.2 + CHANGELOG entry all reference `win32_find_scroll_leaf_for_top_level` consistently (no drift between docs).

---

## 6. Review loop (per CLAUDE.md §3.3)

- **Step 0**: production code改修 PR (Rust + TS) → Opus + Codex 必須.
- **Step 1**: Opus review prompts include §3.1 fact sweep across the 8 surfaces listed in §3, §3.2 carry-over preservation (specifically: behaviour bit-equal when leaf-walker returns null), Lesson 1-4 sweep, §4 R1-R5 mitigation completeness, ADR-018 §6 AC1 alignment for Excel.
- **Step 2**: Codex `@codex review` PR comment — emphasis on:
  - `FindWindowExW` UTF-16 string handling correctness (no off-by-one in `GetClassNameW` buffer / null terminator)
  - lParam recalculation after leaf retarget (must use leaf's rect, not top-level)
  - L1 capture stream HWND switch (does any test pin top-level HWND in the L1 stream?)
- **Step 3**: Iterate to P1 zero; auto-merge per `feedback_auto_mode_merge_opus_judgment.md` (Opus 判断、release 工程対象外).

---

## 7. Implementation notes (concrete shape)

### 7.1 Rust napi

> **Note**: the snippet below is illustrative. The landed code in
> `src/win32/window.rs` uses the windows-rs **0.62** `FindWindowExW`
> signature: both `hwndparent` and `hwndchildafter` are `Option<HWND>`
> (so `Some(parent)` / `None` rather than raw `parent` / `HWND(null)`),
> and `get_class_name` returns `String` (empty on failure) rather than
> `Option<String>`. The semantic flow is identical.

```rust
// src/win32/window.rs (additive)

use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;

/// Class chain table for MDI apps where WM_MOUSEWHEEL must target a leaf child
/// (Win32 contract: WM_MOUSEWHEEL propagates upward only). Each entry is
/// (top-level class, descending chain of child classes). FindWindowExW walks
/// the chain once per call; any segment miss returns None (caller falls back
/// to top-level POST, preserving current behaviour).
static SCROLL_LEAF_CHAINS: &[(&str, &[&str])] = &[
    ("XLMAIN",  &["XLDESK", "EXCEL7"]),
    ("OpusApp", &["_WwF",   "_WwG"]),
];

#[napi]
pub fn win32_find_scroll_leaf_for_top_level(top: BigInt) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_find_scroll_leaf_for_top_level", || {
        let top_hwnd = hwnd_from_bigint(top);
        let top_class = match get_class_name(top_hwnd) {
            Some(c) => c,
            None => return Ok(None),
        };
        let chain = match SCROLL_LEAF_CHAINS.iter().find(|(c, _)| *c == top_class) {
            Some((_, chain)) => *chain,
            None => return Ok(None),
        };
        let mut parent = top_hwnd;
        for child_class in chain {
            let wide: Vec<u16> = child_class.encode_utf16().chain(std::iter::once(0)).collect();
            let child = unsafe { FindWindowExW(parent, HWND(std::ptr::null_mut()), PCWSTR(wide.as_ptr()), PCWSTR::null()) };
            if child.is_err() || child.as_ref().unwrap().0.is_null() {
                return Ok(None);
            }
            parent = child.unwrap();
        }
        Ok(Some(hwnd_to_bigint(parent)))
    })
}

fn get_class_name(h: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(h, &mut buf) };
    if len == 0 { return None; }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}
```

### 7.2 TS dispatcher

```ts
// src/tools/_input-pipeline.ts::postWheelToHwnd (insert near function entry)

const findLeaf = nativeWin32?.win32FindScrollLeafForTopLevel;
const leafBig = typeof findLeaf === "function" ? findLeaf(BigInt(hwnd)) : null;
const effectiveHwnd: bigint = leafBig !== null && leafBig !== undefined
  ? BigInt(leafBig)
  : hwnd;

// rest of function uses `effectiveHwnd` instead of `hwnd`:
// - getWindowRectByHwnd(effectiveHwnd) — lParam centre on leaf
// - getScrollInfo(effectiveHwnd, axisName) — observation on leaf
// - postMessage(effectiveHwnd, message, wParam, lParam) — POST to leaf
// - nativeL1?.l1PushHwInputPostMessage?.(effectiveHwnd, ...) — L1 records leaf
```

---

## 8. Out-of-band (post-merge)

After merge, the release option B (originally chosen route in 2026-05-15 session) becomes ready: dogfood Excel again (should pass), then proceed to v1.6.0 release (option A) per `docs/release-process.md` full read.
