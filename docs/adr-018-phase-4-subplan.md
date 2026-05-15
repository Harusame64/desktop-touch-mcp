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
   - `lParam = MAKELPARAM(screenX, screenY)` where coordinates point to the **window rect center in screen coordinates** (`getWindowRectByHwnd(hwnd)` → center). MFC/Win32 apps often use lParam to find the target child via `ChildWindowFromPoint`; the window center is the safest neutral hit point.
   - Pre/post observation: best-effort `win32_get_scroll_info(hwnd, axis)` on the axis of interest.
     - `pre`/`post` present AND axis position changed by ≥ 1 → return `{ scrolled: true, channel: 'postmessage', reason: 'delivered_via_postmessage' }`.
     - Either snapshot null OR no movement → return `null` (caller emits `target_unreachable`).
   - Settle delay: 16 ms (one frame; same as Tier 2 CDP — wheel handling is synchronous on the message pump side but scrollbar position reflects the next paint).
   - All native call failures → `null` (graceful fall-through; the helper never throws — matches Tier 1/2 contract).

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

5. **Unit tests** in `tests/unit/input-pipeline-dispatch.test.ts`:
   - Mock `win32PostMessage` + `win32GetScrollInfo` + `getWindowRectByHwnd` (via mocking `../../src/engine/win32.js`) so the Tier 3 path is deterministic.
   - New describe block: `"ADR-018 Phase 4 — postWheelToHwnd (Tier 3 PostMessage path)"`:
     - vertical down: posts `WM_MOUSEWHEEL` (0x020A) with `wParam = (-120 << 16) | 0` (Win32-flipped: UIA down=+120 → Win32 = -120 for "forward = up" convention — see §2.3 matrix), lParam = MAKELPARAM(screenCx, screenCy).
     - vertical up: posts `WM_MOUSEWHEEL` with positive HIWORD (`120 << 16`).
     - horizontal right: posts `WM_MOUSEHWHEEL` (0x020E) with positive HIWORD (`120 << 16`) — no flip (UIA right=+ matches Win32 WM_MOUSEHWHEEL right=+).
     - horizontal left: posts `WM_MOUSEHWHEEL` with negative HIWORD.
     - Observable scroll diff (pre.nPos=10, post.nPos=30) → returns `{channel:'postmessage', reason:'delivered_via_postmessage'}`.
     - No observable diff → `null`.
     - `win32GetScrollInfo` returns null (Word `_WwG` MFC custom-paint case) → `null` (dispatcher returns null; caller emits `target_unreachable`).
     - `win32GetWindowRect` returns null → uses fallback lParam=0 (best-effort) and still posts; observation null path same as above.
     - Native call throws → `null`.
   - New describe block: `"ADR-018 Phase 4 — dispatchScrollWheel (Tier 1 → Tier 3 fall-through)"`:
     - Tier 1 returns null, Tier 3 returns delivered → returns Tier 3 outcome.
     - Tier 1 returns null, Tier 3 returns null → dispatcher returns null.
     - Tier 1 returns delivered → Tier 3 NOT invoked (asserted via `win32PostMessage` not called).
   - Updated `assertTier4Reachable` describe:
     - `kind:'hwnd'` now `.toThrow(...)` (was `.not.toThrow()` in Phase 1b).
     - `kind:'unresolved'` still passes.

6. **Word `_WwG` class enumeration fixture** (`tests/integration/word-class-enumerate.smoke.test.ts`):
   - Locally-runnable smoke; CI-skipped (no Word installed on `windows-latest` runners).
   - Skip condition: `process.env.WORD_E2E !== "1"` OR `winword.exe` not running.
   - Enumerates `EnumChildWindows` for the first reachable `OpusApp` top-level (Word's main class) and logs the class hierarchy. Asserts `_WwG` (or `_WwO`) appears in the tree.
   - Output is informational; Phase 4 records Word's PostMessage behaviour as documented unobserved-exhaust if `_WwG` does not respond — the Tier 3 `null` path handles it correctly without further code branching.

### 2.2 Out of scope (carry-over to later phases)

| Item | Carries to | Reason |
|---|---|---|
| Tier 4 reason / channel rename (`wheel_send_input` → `send_input`, legacy 4 reasons → unreachable) | A future cleanup PR | The legacy literals are still emitted from the `kind:'unresolved'` Tier 4 fall-through; renaming is mechanical but unrelated to the Tier 3 wire-up and would balloon the diff. ADR §2.6.3 migration is type-level satisfied by the existing 5-value enum lock in `mouse.ts:971-982`. |
| Word real-app integration assertion (assert scroll actually moves Word document) | Phase 5 5-app smoke | Phase 5 covers 5-app × 4-direction; Phase 4 contributes the Tier 3 path + class fixture only. |
| `wheel_overlay_intercepted` detection (DDPM-style invisible overlay sensor) | Future / OQ2 | ADR §7 OQ2; not gated on Phase 4. |
| Shared `findPlainTopLevelWindowByTitle` helper | A future PR | Phase 1b §2.2 carry-over still open; not touched here. |

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

