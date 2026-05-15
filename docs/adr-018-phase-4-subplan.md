# ADR-018 Phase 4 — Sub-plan: Tier 3 PostMessage path (WM_MOUSEWHEEL / WM_MOUSEHWHEEL)

- Status: **Draft (in PR feat/adr-018-phase-4-postmessage)**
- Date: 2026-05-15
- Parent: `docs/adr-018-input-pipeline-3tier.md` §4 Phase 4
- Authors: Claude (Sonnet drafting + impl, Opus + Codex review)

---

## 1. Why this sub-plan exists

ADR §4 Phase 4 lists 5 deliverables across 2 files (`_input-pipeline.ts` + `mouse.ts`), plus Word `_WwG` class enumeration and `assertTier4Reachable` tightening. The interaction surface is small but the **migration is contractually load-bearing**:

1. **Tier 4 SendInput tightening is a breaking semantic change** for the dispatcher's runtime guard. Phase 1b accepts `dest.kind === 'hwnd'` as lenient form; Phase 4 must invert that, and the caller (`mouse.ts:scrollHandler`) must catch the new exhaust shape and emit `target_unreachable` with `channel='postmessage'` *without* falling through to SendInput. Getting this wrong silently re-introduces cursor-pixel routing for resolved-but-Tier-3-exhausted destinations — the exact ADR §1.2 root cause.
2. **WM_MOUSEWHEEL sign convention is opposite to UIA.** UIA: down/right positive (CSS / SetScrollPercent direction). Win32 WM_MOUSEWHEEL wParam HIWORD: forward (= scroll **up**) positive. The flip must happen at one single boundary (`postWheelToHwnd`); any second-flip elsewhere produces silent reverse-direction scroll.
3. **`win32_post_message` + `win32_get_scroll_info` already exist** as napi primitives — Phase 4 introduces **zero new Rust code**. Implementation is pure TS in `_input-pipeline.ts`.

---

## 2. Phase 4 scope

### 2.1 In-scope deliverables

1. **New `postWheelToHwnd(hwnd, params)` helper** in `src/tools/_input-pipeline.ts`:
   - Encodes `WM_MOUSEWHEEL` (vertical, message id `0x020A`) or `WM_MOUSEHWHEEL` (horizontal, `0x020E`).
   - `wParam = MAKEWPARAM(modifiers=0, wheelDelta)` where `wheelDelta` is the Win32-flipped value (see §2.3 sign matrix).
   - **Chunking** (Codex PR #305 review P2-B): the receiver reads `wheelDelta` as a signed 16-bit HIWORD (`GET_WHEEL_DELTA_WPARAM`). Magnitudes ≥ 32768 raw units (`notch >= 274` at `WHEEL_DELTA=120`) wrap the sign bit and silently reverse scroll direction. Helper loops emitting ≤ `0x7FFF`-magnitude chunks until the requested delta is exhausted; each chunk fits in signed 16-bit. Typical `notch=1..10` loops once.
   - `lParam = MAKELPARAM(screenX, screenY)` where coordinates point to the **window rect center in screen coordinates** (`getWindowRectByHwnd(hwnd)` → center). MFC/Win32 apps often use lParam to find the target child via `ChildWindowFromPoint`; the window center is the safest neutral hit point.
   - Pre/post observation: best-effort `win32_get_scroll_info(hwnd, axis)` on the axis of interest.
     - `getScrollInfo` API genuinely missing (mixed-version `.node` build) → presume delivered, return `delivered_via_postmessage` (Codex PR #305 review P2-A — the caller's own `captureScrollSnapshot` dHash + Win32 observation will still detect a true no-op via dHash).
     - `getScrollInfo` present + pre null (this HWND has no Win32 scrollbar — Word `_WwG`, modern UWP) → return `null` (caller emits `target_unreachable`).
     - `getScrollInfo` present + pre/post position changed by ≥ 1 → return `{ scrolled: true, channel: 'postmessage', reason: 'delivered_via_postmessage' }`.
     - `getScrollInfo` present + no movement → return `null` (caller emits `target_unreachable`).
   - Settle delay: 16 ms (one frame; same as Tier 2 CDP — wheel handling is synchronous on the message pump side but scrollbar position reflects the next paint).
   - All native call failures → `null` (graceful fall-through; the helper never throws — matches Tier 1/2 contract).
   - ADR-007 P5a L1 capture: every successful chunk `PostMessage` is recorded to the L1 ring via `nativeL1?.l1PushHwInputPostMessage` for replay-accurate observability (matches `postMessageToHwnd` in `src/engine/win32.ts:602`).

2. **`dispatchScrollWheel` extension** (same file):
   - For `dest.kind === 'hwnd' | 'uia'`: after Tier 1 UIA returns `null` (no ScrollPattern OR no observable percent diff), attempt Tier 3 `postWheelToHwnd(dest.hwnd, params)` before returning `null`.
   - Tier 3 success → return the Tier 3 outcome. Tier 3 also returns `null` → dispatcher returns `null` (caller decides `target_unreachable` vs Tier 4 by checking `dest.kind`).

3. **`assertTier4Reachable` strict form** (same file):
   - Tightens to `dest.kind === 'unresolved'` only — throws for `'hwnd'`, `'uia'`, `'cdp'`.
   - The function's `## ⚠ Phase 4 BREAKING CHANGE marker ⚠` docstring is rewritten to "Phase 4 strict form" prose; the Phase 1b lenient prose moves to a single short "history" line.

4. **`mouse.ts:scrollHandler` exhaust path** (`src/tools/mouse.ts`):
   - When `dispatchScrollWheel` returns `null` AND `dest.kind === 'hwnd' || 'uia'` (resolved-but-Tier-3-exhausted) → emit `failWith` with `verifyDelivery: { status:'not_delivered', channel:'postmessage', reason:'target_unreachable' }`. **`assertTier4Reachable` is NOT called on this path** (it would throw; the explicit failWith path surfaces the typed envelope cleanly, identical to the existing `dest.kind === 'cdp'` branch added in Phase 3).
   - `assertTier4Reachable(dest)` is still called immediately before SendInput so the `'unresolved'`-only contract is structurally enforced at the call site.
   - `effectiveChannel` union extended: `"uia" | "cdp" | "postmessage" | "wheel_send_input"`. The if-chain that maps `tier1.channel → effectiveChannel` now accepts `'postmessage'`. The legacy `'wheel_send_input'` literal is preserved for Tier 4 (the `§2.6.3` rename to `'send_input'` is deferred — Tier 4 still emits the legacy literal until a future PR consolidates).

5. **Unit tests** in `tests/unit/input-pipeline-dispatch.test.ts` (canonical counts: **15** Tier 3 cases (12 base + 2 Codex regression guards: `getScrollInfo` unavailable presumed-delivered + `notch=300` chunking + 1 chunk-boundary `notch=273` + 1 Opus Round 3 P2-1 zero-magnitude guard `notch=0` → null) + **5** Tier 1 → Tier 3 fall-through cases + **4** `assertTier4Reachable` strict cases, total 60 in this file):
   - Mock `win32PostMessage` + `win32GetScrollInfo` + `getWindowRectByHwnd` (via mocking `../../src/engine/win32.js`) so the Tier 3 path is deterministic.
   - New describe block: `"ADR-018 Phase 4 — postWheelToHwnd (Tier 3 PostMessage path)"` — 12 cases:
     - vertical down: posts `WM_MOUSEWHEEL` (0x020A) with `wParam` HIWORD = -120 packed via u32 mask (Win32-flipped: UIA down=+120 → Win32 = -120 for "forward = up" convention — see §2.3 matrix), lParam = MAKELPARAM(screenCx, screenCy).
     - vertical up: posts `WM_MOUSEWHEEL` with positive HIWORD (+120).
     - horizontal right: posts `WM_MOUSEHWHEEL` (0x020E) with positive HIWORD (+240 for notch=2) — no flip (UIA right=+ matches Win32 WM_MOUSEHWHEEL right=+).
     - horizontal left: posts `WM_MOUSEHWHEEL` with negative HIWORD.
     - Observable scroll diff (pre.nPos=50, post.nPos=80) → returns `{channel:'postmessage', reason:'delivered_via_postmessage'}`.
     - pre-snapshot null (Word `_WwG` MFC custom-paint case) → `null` (PostMessage still dispatched best-effort).
     - post-snapshot null (race / scrollbar destroyed mid-scroll) → `null`.
     - pre/post nPos unchanged → `null`.
     - `win32PostMessage` returns false → `null` (no observation attempted).
     - `getWindowRectByHwnd` returns null → uses fallback lParam=0 (best-effort) and still posts.
     - Multi-monitor secondary-display negative-coord packing — lParam preserves sign bits (R2 / §2.4).
     - `win32PostMessage` native binding undefined → `null` (no throw).
     - `win32PostMessage` throws → `null` (graceful fall-through).
   - New describe block: `"ADR-018 Phase 4 — dispatchScrollWheel (Tier 1 UIA → Tier 3 PostMessage fall-through)"` — 5 cases:
     - Tier 1 ok:false → Tier 3 delivered → returns Tier 3 outcome.
     - Tier 1 scrolled:false + Tier 3 null → dispatcher returns null.
     - Tier 1 succeeded → Tier 3 NOT invoked (asserted via `win32PostMessage` not called).
     - Tier 1 throws → Tier 3 still attempted (graceful Tier 1 fall-through preserved).
     - `kind='unresolved'` → null (neither Tier 1 nor Tier 3 invoked).
   - Updated `assertTier4Reachable` describe (4 cases):
     - `kind:'hwnd'` now `.toThrow(...)` (was `.not.toThrow()` in Phase 1b lenient).
     - `kind:'uia'` throws (unchanged).
     - `kind:'cdp'` throws (unchanged).
     - `kind:'unresolved'` passes (unchanged — the only canonical Tier 4 destination).

6. **Word `_WwG` class enumeration fixture skeleton** (`tests/integration/word-class-enumerate.smoke.test.ts`):
   - Locally-runnable smoke; CI-skipped (no Word installed on `windows-latest` runners).
   - Skip condition: `process.env.WORD_E2E !== "1"` OR no top-level `OpusApp` window present.
   - **Phase 4 lands the SKELETON only**: logs the top-level Z-order siblings of `OpusApp` (Word's main class) via the existing `enumWindowsInZOrder()` API and soft-asserts `wordTop.className === "OpusApp"`. The full `EnumChildWindows`-based descendant tree dump that asserts `_WwG` / `_WwO` appears under `OpusApp` requires a new `win32_enum_child_windows` napi export, which is out of scope for Phase 4 (no Tier 3 contract depends on it). The fixture exists so Phase 5 can wire the descendant assertion without churn.
   - Output is informational; Phase 4 records Word's PostMessage behaviour as documented unobserved-exhaust if `_WwG` does not respond — the Tier 3 `null` path handles it correctly without further code branching, independently of whether the descendant assertion lands.

### 2.2 Out of scope (carry-over to later phases)

| Item | Carries to | Reason |
|---|---|---|
| Tier 4 reason / channel rename (`wheel_send_input` → `send_input`, legacy 4 reasons → unreachable) + `effectiveChannel` local-union de-dup | A future cleanup PR | The legacy literals are still emitted from the `kind:'unresolved'` Tier 4 fall-through; renaming is mechanical but unrelated to the Tier 3 wire-up and would balloon the diff. ADR §2.6.3 migration is type-level satisfied by the existing 5-value enum lock in `mouse.ts:971-982`. The `effectiveChannel` local union (`uia|cdp|postmessage|wheel_send_input` in `mouse.ts`) duplicates the broader `Channel` type modulo the `send_input`/`wheel_send_input` legacy literal swap; deferring the rename is what keeps the duplication. (PR #305 Opus Round 1 P3-4.) |
| Word `EnumChildWindows`-based descendant assertion (`_WwG` / `_WwO` confirmed under `OpusApp`) | Phase 5 | Requires new `win32_enum_child_windows` napi export. Phase 4 fixture lands as skeleton (top-level enumeration only); Phase 5 adds the native export + wires the descendant assertion. (PR #305 Opus Round 1 P1-1.) |
| Word real-app integration assertion (scroll actually moves Word document via Tier 3) + Excel cell area Tier 3 real-app smoke + Explorer ListView Tier 3 real-app smoke | Phase 5 5-app smoke | Phase 5 covers 5-app × 4-direction; Phase 4 contributes the Tier 3 dispatcher wire-up + sub-plan §2.3/§2.4 contract pins + the Word fixture skeleton only. ADR §4 Phase 4 deliverable bullet 5 ("Word / Excel / Explorer smoke cases finalized here") is explicitly re-routed to Phase 5 because the 5-app harness already lives in Phase 5 scope. (PR #305 Opus Round 1 P2-2.) |
| `wheel_overlay_intercepted` detection (DDPM-style invisible overlay sensor) | Future / OQ2 | ADR §7 OQ2; not gated on Phase 4. |
| Shared `findPlainTopLevelWindowByTitle` helper | Phase 5 | Phase 1b §2.2 originally committed Phase 4 to extract; re-routed Phase 4 → Phase 5 (PR #305 Opus Round 1 P1-2). Phase 1b sub-plan §2.2 updated in the same PR to reflect. The predicate has 2-3 copies today (`_input-pipeline.ts:268-289` Case 3 recovery + `mouse.ts:1145-1153` observation-ladder fallback + the `_resolve-window.ts` Case 3 original) — not a correctness bug, but a §3.1 drift risk surface. |

### 2.3 Sign convention matrix (load-bearing — §1 point 2)

| `WheelParams.direction` | UIA `wheelDeltaForNotch(notch=1)` | Win32 message | `wParam` HIWORD (signed) | Sign flip? |
|---|---|---|---|---|
| `down` | y = +120 | `WM_MOUSEWHEEL` (0x020A) | -120 | **flip** (UIA down=+ ↔ Win32 forward=- = up=+) |
| `up` | y = -120 | `WM_MOUSEWHEEL` (0x020A) | +120 | **flip** |
| `right` | x = +120 | `WM_MOUSEHWHEEL` (0x020E) | +120 | no flip |
| `left` | x = -120 | `WM_MOUSEHWHEEL` (0x020E) | -120 | no flip |

The flip applies only to the vertical message. WM_MOUSEHWHEEL (Vista+) uses positive HIWORD = wheel tilted right = scroll right, which matches the UIA convention. A second flip on the horizontal axis would silently reverse left/right scrolling — caught by the per-direction test cases in §2.1 deliverable 5.

### 2.4 lParam encoding

`MAKELPARAM(screenX, screenY)` — low word = X, high word = Y, both as **screen** coordinates (not client). Negative values (multi-monitor secondary displays) are packed as `(x & 0xFFFF) | ((y & 0xFFFF) << 16)`. The dispatcher computes `(cx, cy) = (rect.x + rect.width/2, rect.y + rect.height/2)` from `getWindowRectByHwnd(hwnd)`. When the rect lookup fails (null) the helper falls back to `lParam = 0n` — apps that ignore lParam (most Win32 windows do for wheel events) still scroll; apps that hit-test on lParam (some custom controls) fail observably and emit `target_unreachable` per §2.1 deliverable 1.

---

## 3. G4 acceptance (Phase 4 only)

1. **Tier 3 wire-up**: `dispatchScrollWheel({kind:'hwnd', hwnd}, {direction:'down', notch:N})` on a target with no ScrollPattern but a queryable Win32 scrollbar (Excel cell area, Explorer ListView when run under the relevant fixture) returns `{ scrolled:true, channel:'postmessage', reason:'delivered_via_postmessage' }`. Pinned by mocked unit tests; real-app assertion deferred to Phase 5.
2. **Tier 4 strict guard**: `assertTier4Reachable({kind:'hwnd', hwnd})` throws. `assertTier4Reachable({kind:'unresolved', ...})` passes. Pinned by updated unit tests.
3. **Scrollhandler exhaust path**: when dispatcher returns null for `dest.kind === 'hwnd'` (Tier 1 + Tier 3 both exhausted), `scrollHandler` emits a `failWith` envelope with `verifyDelivery: { status:'not_delivered', channel:'postmessage', reason:'target_unreachable' }` — **Tier 4 SendInput is NOT invoked** for that dest. Pinned by an integration unit assertion that mocks the dispatcher and asserts `mouse.scrollDown/Up/Left/Right` is not called for `kind:'hwnd'` exhaust.
4. **Sign convention** (load-bearing per §2.3): per-direction unit tests confirm the wParam HIWORD value and the message ID (`WM_MOUSEWHEEL` vs `WM_MOUSEHWHEEL`) match the §2.3 matrix.
5. **Word class fixture lands**: `tests/integration/word-class-enumerate.smoke.test.ts` skips cleanly on CI (no Word) and runs locally with `WORD_E2E=1`. Class enumeration output is logged for manual review.
6. **Build + suite green**: `npm run build` + `npm run build:rs` succeed; full `npm test` passes with no regression to the 2548+ existing tests.

---

## 4. CLAUDE.md sweep checklist (mandatory per §3.3 Step 1)

- **§3.1 multi-table fact sweep**: grep targets for the Phase 4 facts:
  - `delivered_via_postmessage|target_unreachable|postWheelToHwnd|WM_MOUSEWHEEL|WM_MOUSEHWHEEL|assertTier4Reachable` across `src/` `tests/` `docs/`. Synchronized surfaces:
    - `src/tools/_input-pipeline.ts` — `DispatchOutcome.reason` union + dispatcher branch + `postWheelToHwnd` helper + `assertTier4Reachable` strict form
    - `src/tools/mouse.ts` — `effectiveChannel` union + Tier 3 exhaust failWith path
    - `tests/unit/input-pipeline-dispatch.test.ts` — Tier 3 describe + `assertTier4Reachable` strict form
    - `docs/adr-018-input-pipeline-3tier.md` §2.6.1 / §2.6.2 / §4 Phase 4 / §6 AC1 — no edits needed (ADR already encodes the Phase 4 contract; this sub-plan is the impl trace)
- **§3.2 carry-over scope shrink sweep**: the Tier 4 tightening could break a hypothetical existing caller that depends on `kind:'hwnd' → SendInput` fall-through. None exists today — `mouse.ts:scrollHandler` is the only `dispatchScrollWheel`/`assertTier4Reachable` consumer and Phase 4 updates it in the same PR. No other public API surface is affected. Documented here so a future Codex round can grep `assertTier4Reachable` and confirm.

---

## 5. Risks

- **R1** — Word `_WwG` may not respond to WM_MOUSEWHEEL even at the document HWND level (MFC custom hit-testing).  
  **Mitigation**: dispatcher returns null on no observable diff; caller emits `target_unreachable` per §3 G4 #3. Word fixture documents the hierarchy for future investigation; ADR §7 OQ8 already records the Office COM `Application.ActiveDocument.Application.CommandBars` alternative for future ADR.
- **R2** — Multi-monitor secondary-display coordinates are negative; `(y & 0xFFFF) << 16` packing must preserve the sign bit when the receiver re-extracts with `(short)HIWORD(lParam)`.  
  **Mitigation**: explicit `& 0xFFFF` mask in the encoder; unit test with a window rect at `x=-1920, y=0` (left-of-primary monitor) asserts the lParam value matches the documented bit pattern.
- **R3** — Pre/post `win32_get_scroll_info` may transiently return null mid-scroll (range-recompute race).  
  **Mitigation**: settle delay (16 ms) before post-snapshot; treating null as exhaust is the safe default (false negative → `target_unreachable` envelope; LLM retries on a stable target).
- **R4** — Existing tests in `input-pipeline-dispatch.test.ts` use `expect(uiaScrollByWheelAtHwndMock).not.toHaveBeenCalled()` for the `kind:'unresolved'` path; the Tier 3 fall-through additions must preserve those (Tier 3 must not invoke UIA for `'unresolved'`).  
  **Mitigation**: the `dispatchScrollWheel` change keeps the `kind:'unresolved'` short-circuit identical (returns `null` immediately without touching Tier 1 or Tier 3); covered by the existing test that is left unchanged.

---

## 6. Review loop (per CLAUDE.md §3.3)

- **Step 0**: production code改修 PR → Opus + Codex 必須 (§3.3 Step 0 table).
- **Step 1**: Opus review with explicit prompts for §2.3 sign matrix correctness, §3 G4 acceptance items, §3.1 fact sweep, §3.2 carry-over (Tier 4 strict form), and Lesson 1-4 (causal window / compile-time guard / order / numeric count sync).
- **Step 2**: Codex `@codex review` PR comment trigger — emphasis on API contract surface (Tier 4 strict throw semantics, WM_MOUSEWHEEL sign convention, `effectiveChannel` union exhaustiveness).
- **Step 3**: Iterate to P1 zero; auto-merge per `feedback_auto_mode_merge_opus_judgment.md`.

