# ADR-018: Destination-explicit input pipeline — 3-tier dispatcher for scroll + keyboard + schema

- Status: **Draft (Proposed, Round 0)** — initial draft from user-directed scroll investigation 2026-05-13
- Date: 2026-05-13
- Authors: Claude (Sonnet investigation + Opus web research + Plan agent design)
- Related:
  - User report 2026-05-13 — "scroll feels broken" → 11 symptoms found across Chrome / Notepad / Word / Excel / File Explorer hands-on testing
  - `C:\Users\harus\.claude\plans\zesty-popping-cloud.md` — approved plan-mode artefact (this ADR is the project-tree SoT)
  - MCP TypeScript SDK Issue [#1643](https://github.com/modelcontextprotocol/typescript-sdk/issues/1643) — upstream `z.discriminatedUnion` → JSON Schema collapse
  - ADR-010 (`docs/adr-010-presentation-layer-self-documenting-envelope.md`) — envelope typed-reason taxonomy this ADR extends with 5-tier delivery reasons
  - ADR-014 (`docs/adr-014-cooperative-bridge.md`) — native bridge plumbing reused for Tier 1 / Tier 3
  - ADR-017 (`docs/adr-017-session-aware-desktop-touch.md`) — envelope-evolution cousin (session-aware `desktop_state` fields). ADR-018 reuses ADR-017's "envelope extension via opt-in field" pattern for `verifyDelivery.channel`. No code-path overlap; both can ship in parallel.
  - `docs/walking-skeleton-trunk-selection.md` §3.2 — contract spike pattern this ADR's Phase 1 follows
  - Existing 4-value `verifyDelivery.reason` enum in `src/tools/mouse.ts:943-947` (`read_back_unsupported` / `page_end_inferred` / `scrollbar_unavailable` / `no_target_window`) — superseded by the new 5-value tier-based taxonomy (D6); the existing test pin in `tests/unit/scroll-raw-verify.test.ts:114-121` will be rewritten in Phase 1
- Blocks: none
- Blocked by: this ADR's review and acceptance (Phase 1 trunk PR is the first downstream artefact)

---

## 1. Context

### 1.1 The 11 symptoms (user-directed hands-on testing, 2026-05-13)

Real-world testing on a Windows 11 host running Dell Display Peripheral Manager (DDPM) revealed `scroll`, `keyboard`, MCP `tools/list`, and `windowTitle` resolution **all degrade together** in the same environment:

**Scroll path (5 apps tested)**
1. `scroll(action='raw', notches=5..20)` clamps to `steps:3`; Chrome scrolled only **7–8 px out of 25 944 px** (≈0.03 %)
2. `verifyDelivery.reason='page_end_inferred'` fires on the **first call**, even when the page is at the top, even on **upward** scroll from the bottom
3. `hints.scrollObserved.delta = {x:null, y:null}` on every call
4. `scroll(action='smart', target='body')` returns `ok:true, scrolled:true` but resets `scrollTop` from 23 → **0** (reverse direction)
5. `scroll(action='to_element', selector='#id')` works, but the error path mis-instructs (`Provide at least one of: name, selector`) when only `selector` is missing
6. `scroll(action='read', windowTitle:'メモ帳')` returns `Window not found`, while `keyboard({windowTitle:'メモ帳'})` resolves fine

**Keyboard path**
7. `keyboard(action='type', text='日本語')` reports `typed:1177` but the actual buffer holds only `L1: \r\nL2: \r\n…` — **CJK silently dropped** via `method:"keystroke"`

**Schema path**
8. MCP `tools/list` returns `inputSchema: { properties: {}, type: 'object' }` for `scroll` / `keyboard` / `excel`, forcing the LLM to discover param names via failing calls

**Window resolution**
9. `scroll(action='read')` uses `getWindows()` (nutjs flat enumeration) while every other tool uses `resolveWindowTarget` (`enumWindowsInZOrder` + dialog owner chain) — divergent semantics for the same `windowTitle` string

**Environment observation**
10. Cursor at (800, 500) inside Chrome's region, but `cursorOverWindow="EAWorkWindow"` (`process: DDPM.Subagent.User`, zOrder 0, 1920×1080 transparent) — DDPM's invisible overlay sinks every wheel event
11. `keyboard PageDown` works (Excel A1 → A22) because keyboard input routes to the focused HWND, not the cursor position — proving the failure is wheel-routing-specific, not "DDPM blocks all input"

### 1.2 Why these are one problem, not eleven

Code reading (`src/tools/mouse.ts:910-1174`) + web research (Microsoft `WM_MOUSEWHEEL` 1996 spec, MS DevBlogs 2016-04-20, MCP SDK Issue #1643, MS Learn UIA ScrollPattern docs) reveals a single architectural pattern:

> **Both observation and action depend on cursor-pixel coordinates and implicit foreground state. The destination HWND is never on the wire.**

Concretely:
- **Action layer**: `nutjs SetCursorPos → SendInput(MOUSEEVENTF_WHEEL)` routes the wheel to whatever HWND is under the cursor, which on this host is DDPM's invisible overlay, not Chrome
- **Observation layer**: `Win32 GetScrollInfo` (only works on apps with a real Win32 scrollbar — fails for Chrome, modern UWP, accessibility-blind UIs) + image dHash (silently catches errors). When both miss, `evaluateScrollDelivery` returns `page_end_inferred` as a polite shrug
- **Schema layer**: `z.discriminatedUnion(action, ...)` is the natural schema for "one tool with five behaviors", but MCP SDK's `normalizeObjectSchema` silently drops the discriminator — the LLM cannot see the action surface
- **Window resolution**: `scroll(action='read')` evolved independently of `_resolve-window.ts` and never adopted the dialog owner chain

The industry has converged on **destination-explicit input pipelines**: Microsoft UI Automation, Playwright, FlaUI, and WinAppDriver all attach actions to an automation element / HWND / tab ID rather than the cursor. Microsoft's own DevBlogs explicitly state that WM_MOUSEWHEEL was originally routed to the focus window for Ctrl-state reasons, and that the cursor-position routing introduced in Windows 10 (`MouseWheelRouting` registry value, "Scroll inactive windows" setting) is an opt-in compatibility layer, not the new default.

### 1.3 Why now

Without this fix, every user with a stay-resident accessibility / display-management tool (Dell DDPM, Logitech Options+, NVIDIA Game Filter, MS PowerToys FancyZones with mouse hooks, AutoHotKey scripts, RDP shadow sessions) sees scroll silently degrade to a no-op. This is the most-used class of tool in the MCP surface and the silent-failure mode is unrecoverable from the LLM side — `ok:true` masks a 0-px scroll.

---

## 2. Decision

Adopt a **3-tier destination-explicit input pipeline** for scroll and keyboard, with the destination HWND threaded through every layer, and an explicit typed-reason taxonomy that distinguishes "delivered" from "delivery channel exhausted":

### 2.1 D1 — Input layer 3 tiers (action)

| Tier | Channel | Selection criterion | Existing asset |
|---|---|---|---|
| 1 | UIA `IUIAutomationScrollPattern::SetScrollPercent` | Target HWND exposes ScrollPattern (most native Win32 apps, Office cell area, Explorer ListView, Notepad) | `src/uia/scroll.rs:142-224` `scroll_by_percent_impl` (complete, called today only by `smart` / `to_element`) |
| 2 | CDP `Input.dispatchMouseEvent({type:'mouseWheel'})` | Target is a Chrome/Edge tab (CDP attached via `browser_open`) | `src/engine/cdp-bridge.ts:284` `evaluateInTab` (extend with a new wrapper) |
| 3 | Win32 `PostMessage(hwnd, WM_MOUSEWHEEL, ...)` | Target HWND known but ScrollPattern unavailable (Word document body, custom-drawn UIs, GPU panels) | `src/win32/input.rs:156-183` `win32_post_message` (generic, BigInt-safe, ready to use) |
| 4 | `SendInput(MOUSEEVENTF_WHEEL)` | **Destination unresolvable**: no HWND, no CDP tab, no ScrollPattern. Records typed reason `target_unreachable` | existing nutjs path in `src/tools/mouse.ts:1058-1100` |

Tier 4 is the **only** path that depends on cursor position; it is reached only when every destination-explicit channel has been ruled out, and its outcome is reported as `target_unreachable` rather than disguised as a delivery.

### 2.2 D2 — Observation layer 3 tiers

| Tier | Channel | Existing asset |
|---|---|---|
| 1 | UIA `CurrentVerticalScrollPercent` / `CurrentHorizontalScrollPercent` | `src/uia/scroll.rs:346-355` |
| 2 | CDP `document.scrollingElement.scrollTop` / `window.scrollY` | `src/engine/cdp-bridge.ts:284` `evaluateInTab` |
| 3 | Win32 `GetScrollInfo` + image dHash | `src/win32/scroll.rs:23-69` + `src/tools/mouse.ts:910-933` `captureScrollSnapshot` |

The observation tier is selected by the **same destination** the action tier used. UIA action → UIA observation gives a numeric `deltaPercent`; CDP action → CDP observation gives a numeric `deltaY` in CSS pixels. The dHash fallback is reserved for Tier 4 and is honest about its uncertainty (Hamming distance, not pixel delta).

### 2.3 D3 — Destination explicit-ness as a first-class type

Introduce `src/tools/_input-pipeline.ts` with:

```ts
type InputDestination =
  | { kind: 'uia'; hwnd: bigint; element: AutomationElementRef }
  | { kind: 'cdp'; tabId: string; nodeId?: number }
  | { kind: 'hwnd'; hwnd: bigint }
  | { kind: 'unresolved'; reason: string };
```

Every input tool (`scroll`, `keyboard`, future `mouse_click`) resolves destination **first**, before selecting a tier. `resolveWindowTarget` (`src/tools/_resolve-window.ts:94-178`) is the single source for HWND resolution across all tools, replacing `getWindows()` in `scroll-read.ts`.

### 2.4 D4 — Non-ASCII detection unified

`src/tools/keyboard.ts:283`'s existing `NON_ASCII_SYMBOL_RE` (specifically defends against Chrome accelerator hijack on en-dash / em-dash / smart quotes / ellipsis / NBSP) is **retained as-is** — its semantics are correct for its purpose. Add a sibling constant:

```ts
const NON_ASCII_RE = /[^\x00-\x7F]/;
```

Auto-clipboard upgrade triggers on the OR of both regexes. CJK, emoji, surrogate pairs, combining marks all route to clipboard automatically. The keystroke path is still selected when the text is pure ASCII (fastest path).

### 2.5 D5 — MCP schema collapse workaround

MCP SDK Issue #1643 will eventually be fixed upstream. Until then, add `materializeUnionJsonSchema()` to `src/tools/_envelope.ts` as a sibling of `withEnvelopeIncludeForUnion`. It returns a hand-rolled JSON Schema with `oneOf` over the discriminator variants, suitable for direct use in `server.registerTool({ inputSchema })`. Apply to `scroll`, `keyboard`, `excel` (the three tools using `discriminatedUnion`).

When upstream lands the fix, deprecate the helper and remove the hand-rolled schemas — tracked in §7 OQ4.

### 2.6 D6 — Typed reason taxonomy

Delete `page_end_inferred` from `_errors.ts SUGGESTS` and replace `verifyDelivery.reason` with this enum:

| Reason | When | Action recovery |
|---|---|---|
| `delivered_via_uia` | Tier 1 succeeded, UIA observation confirmed numeric `deltaPercent` | continue |
| `delivered_via_cdp` | Tier 2 succeeded, CDP observation confirmed numeric `deltaY` | continue |
| `delivered_via_postmessage` | Tier 3 succeeded, GetScrollInfo or dHash confirmed change | continue |
| `wheel_overlay_intercepted` | `WindowFromPoint(cursor)` ≠ focused HWND AND a layered transparent window detected on top | warn user, suggest disabling overlay; auto-fall-through to Tier 1/2/3 already attempted |
| `target_unreachable` | Tier 4 (SendInput) executed and no observation channel confirmed any delta | hard failure, return suggest list with three recovery options |

This is the **only** SSOT for typed reasons; `_errors.ts SUGGESTS`, `ADR-010` typed-reason table, and per-tool description caveats must stay synchronized (CLAUDE.md §3.1 multi-table fact sweep applies).

---

## 3. Affected components (SSOT table)

| File | Line range | Change |
|---|---|---|
| `src/tools/_input-pipeline.ts` | **new** | Tier dispatcher + `InputDestination` type + typed-reason enum |
| `src/tools/scroll.ts` | 23-184 / 188-201 / 244-265 | `discriminatedUnion` retained; `registerTool` switched to `materializeUnionJsonSchema` (Phase 2a) |
| `src/tools/mouse.ts` | 910-1174 | `scrollHandler` refactored to call `_input-pipeline.ts::dispatch`; `SCROLL_MULTIPLIER=3` retired (tier-specific scaling) |
| `src/tools/smart-scroll.ts` | 159-179 | Fix `target='body'` regression (`document.scrollingElement` double-query, Phase 3) |
| `src/tools/scroll-read.ts` | 91-127 | `getWindows()` → `resolveWindowTarget` (Phase 5) |
| `src/tools/keyboard.ts` | 283 / 1305-1311 | Add `NON_ASCII_RE`, OR with existing regex (Phase 2b) |
| `src/tools/_envelope.ts` | 484-501 | Add `materializeUnionJsonSchema` sibling helper (Phase 2a) |
| `src/uia/scroll.rs` | adjacent to 142-224 | New napi export `uia_scroll_by_wheel_at_hwnd` calling existing `scroll_by_percent_impl` (Phase 1) |
| `src/engine/cdp-bridge.ts` | adjacent to 284 | New `dispatchMouseEvent({type:'mouseWheel'})` wrapper (Phase 3) |
| `src/tools/_errors.ts` | SUGGESTS table | Remove `page_end_inferred`, add 5 new typed reasons (Phase 1, multi-table sweep) |
| `docs/adr-010-presentation-layer-self-documenting-envelope.md` | typed reason table | Synchronize new 5-value enum (Phase 1, CLAUDE.md §3.1) |
| `.github/workflows/input-pipeline-guard.yml` | **new** | CI assert: zero `getWindows` in `src/tools/`, zero `page_end_inferred` anywhere (Phase 5) |
| `__test__/smoke/scroll-5app.smoke.test.ts` | **new** | 5-app × 4-direction smoke (Phase 5, `workflow_dispatch` Windows runner) |
| `__test__/fixtures/overlay-window.ts` | **new** | `WS_EX_LAYERED | WS_EX_TRANSPARENT` fake overlay child process for DDPM repro (Phase 1) |
| `__test__/unit/keyboard-cjk.test.ts` | **new** | NON_ASCII_RE + clipboard-route integration assertions (Phase 2b) |
| `__test__/integration/tools-list-schema.test.ts` | **new** | MCP `tools/list` inputSchema non-empty assertion (Phase 2a) |

---

## 4. Phase split (trunk + expansion, walking-skeleton pattern)

### Phase 1 — Trunk PR: Tier 1 UIA path on Notepad (1 PR, 3-4 days)

**Scope minimum / contract maximum** per `docs/walking-skeleton-trunk-selection.md` §3.2.

Deliverables:
- New `_input-pipeline.ts` with dispatcher skeleton + `InputDestination` type + 5-value typed-reason enum
- New napi export `uia_scroll_by_wheel_at_hwnd` (wraps existing `scroll_by_percent_impl` with wheel-delta → percent conversion)
- `scrollHandler` refactored to call dispatcher; `resolveWindowTarget` required as first step
- `page_end_inferred` removed from `_errors.ts`, replaced by 5-value enum
- `_errors.ts` / ADR-010 typed-reason table / `scroll` tool description synchronized (CLAUDE.md §3.1 sweep)
- `overlay-window.ts` fixture for DDPM repro under unit test

**G1 acceptance**: `scroll(action='raw', windowTitle:'メモ帳', direction:'down')` returns `verifyDelivery.channel='delivered_via_uia'` with numeric `delta`, and continues to do so when the `overlay-window` fixture is running. Tier 4 SendInput must not fire.

**Review loop**: Opus 3+ rounds, Codex 1+ round (production code, native binding surface — CLAUDE.md §3.2 PR #102 regression-prevention axis).

### Phase 2a — MCP schema workaround (1 PR, 2-3 days, parallel-OK with 2b)

Deliverables:
- `materializeUnionJsonSchema()` in `_envelope.ts`
- `scroll` / `keyboard` / `excel` `registerTool` calls switched to hand-rolled `inputSchema`
- `tools-list-schema.test.ts` CI gate

**G2a acceptance** (= AC4): `tools/list` for the 3 tools returns non-empty `inputSchema.properties` with action discriminator.

### Phase 2b — Non-ASCII regex extension (1 PR, 1-2 days, parallel-OK with 2a)

Deliverables:
- `NON_ASCII_RE = /[^\x00-\x7F]/` in `keyboard.ts:283`
- Auto-clipboard upgrade OR-combined with existing regex
- `keyboard-cjk.test.ts` (5 cases: 日本語 / 한글 / 中文 / 😀 / résumé)
- Integration: `keyboard(action='type', text='日本語テスト')` → Notepad → UIA `ValuePattern.Value` read-back asserts `日本語テスト`

**G2b acceptance** (= AC3): All 5 CJK regex cases pass; round-trip integration passes.

### Phase 3 — Tier 2 CDP path + smart-scroll fix (1 PR, 2-3 days)

Deliverables:
- `dispatchMouseEvent({type:'mouseWheel'})` wrapper in `cdp-bridge.ts`
- Tier 2 selection in dispatcher when `browser_open` is attached
- `smart-scroll.ts:159-179` `target='body'` fix (`document.scrollingElement` two-step query, behavior `'instant'` preserved)
- Chrome smoke case in `scroll-5app.smoke.test.ts` (stub for now, finalized in Phase 5)

**G3 acceptance**: Chrome scroll returns `delivered_via_cdp`; even with overlay fixture running, Tier 1 → Tier 2 fall-through reports the channel correctly.

### Phase 4 — Tier 3 PostMessage path (1 PR, 3-4 days)

Deliverables:
- `postWheelToHwnd(hwnd, delta, modifiers)` helper (new in `_input-pipeline.ts`)
- `WM_MOUSEWHEEL` encoding: `wParam = MAKEWPARAM(modifiers, delta)`, `lParam = MAKELPARAM(screenX, screenY)`
- Tier 3 selection when destination HWND is known but ScrollPattern is absent
- Word / Excel / Explorer smoke cases (stubbed Phase 1, finalized here)

**G4 acceptance**: Word document body / Excel cell area / Explorer ListView scroll returns `delivered_via_postmessage`; Tier 4 SendInput never fires across the 3 apps.

**Review loop**: Opus 2-3 rounds, Codex 1 round (Win32 API contract axis — PR #102 same regression class).

### Phase 5 — Finalize: SSOT unification + CI assert + 5-app smoke (1 PR, 2 days)

Deliverables:
- `scroll-read.ts:96` `getWindows()` → `resolveWindowTarget`
- `input-pipeline-guard.yml`: grep `getWindows src/tools/` returns 0 lines, grep `page_end_inferred` returns 0 lines
- `scroll-5app.smoke.test.ts` finalized for all 5 apps × 4 directions (`workflow_dispatch`, Windows runner)

**G5 acceptance** (= AC1+AC2+AC5): All 5 apps return numeric delta + `delivered_via_*`; no `page_end_inferred` survives; no `getWindows` in scroll path.

**Total**: 6 PRs, 12–19 days. Phase 2a and 2b parallel-OK, reducing wall-clock to ~10-15 days with background-agent parallelism (CLAUDE.md §3.4).

---

## 5. Risks

- **R1** — DDPM overlay detection is environment-specific. CI runners can't reproduce. Mitigation: `__test__/fixtures/overlay-window.ts` synthesizes the same `WS_EX_LAYERED | WS_EX_TRANSPARENT` topology via a Win32 child process; Tier 1.5 `WindowFromPoint`-based detector surfaces the warning in production.
- **R2** — UIA ScrollPattern support varies. Word document body is UIA-blind. Mitigation: dispatcher falls through Tier 1 → Tier 3 when `IsScrollPatternAvailable` is false; tier-selection logic centralized in `_input-pipeline.ts::pickActionTier`.
- **R3** — CDP `target='body'` scrollTop=0 bug. Mitigation: Phase 3 replaces single `document.body.scrollIntoView` with `document.scrollingElement || document.documentElement` two-step query.
- **R4** — MCP SDK Issue #1643 timing. Mitigation: §7 OQ4 documents 3 candidate strategies (vendored patch / fork / hand-rolled helper). Default to hand-rolled until upstream lands; the helper has a clear deprecation path.
- **R5** (CLAUDE.md §3.2) — Tier 4 SendInput retained as fallback may be misread as carry-over scope shrink that breaks existing API. Mitigation: ADR-level contract that Tier 4 is reachable only when `InputDestination.kind === 'unresolved'`, and its outcome is always reported as `target_unreachable`, never as success.
- **R6** (CLAUDE.md §3.1) — 5-value typed-reason taxonomy spreads across 4 tables (`_errors.ts SUGGESTS`, ADR-010, per-tool description caveats, CHANGELOG). Mitigation: Opus review prompt for each phase includes a mandatory grep sweep of these 4 surfaces.
- **R7** — Keyboard CJK keystroke path may currently work in some IME configurations (composition mode + active IME). Phase 2b regex change must not break these. Mitigation: integration test 1 case (IME ON, CJK typing) added before regex flip; if test fails, regex change is reverted and Phase 2b is split into "detector only" + "auto-clipboard upgrade" sub-PRs.

---

## 6. Acceptance criteria

- **AC1**: All 5 tested apps (Chrome / Notepad / Word / Excel / File Explorer) return `verifyDelivery.status='delivered_via_*'` with numeric `scrollObserved.delta` for `scroll(action='raw', direction='down')`
- **AC2**: `grep -r "page_end_inferred" src/` returns 0 hits; every `verifyDelivery.reason` is one of the 5-value enum
- **AC3**: `keyboard(action='type', text='日本語テスト')` succeeds with `typed:7` and Notepad's `ValuePattern.Value` reads back `'日本語テスト'`
- **AC4**: MCP `tools/list` for `scroll`, `keyboard`, `excel` returns `inputSchema` with non-empty `properties` or `oneOf` reflecting the action discriminator
- **AC5**: `grep -r "getWindows" src/tools/` returns 0 hits; all `windowTitle` resolution in scroll path goes through `resolveWindowTarget`

---

## 7. Open Questions

1. **OQ1** — **Resolved**: ADR number is 018 (ADR-016 occupied by `adr-016-rdp-virtual-window.md`, ADR-017 occupied by `adr-017-session-aware-desktop-touch.md` which landed 2026-05-13)
2. **OQ2** — DDPM overlay handling: (a) README adds "consider disabling DDPM if scroll feels sticky" / (b) tool-side `WindowFromPoint` detector emits warning in `hints.environmentNotes` / (c) both. **Default**: (b) only, surface in production telemetry; (a) added if user reports recur. Decide at Phase 1 PR creation.
3. **OQ3** — Tier 1 UIA inside Chromium (`--force-renderer-accessibility` required): try in Phase 3 as a Tier 1.5 between CDP and PostMessage? **Default**: skip; CDP is the canonical Chrome path. Reopen if Phase 3 dogfood reveals CDP latency outliers.
4. **OQ4** — MCP SDK Issue #1643 adoption: (a) `patches/` vendored / (b) fork & npm alias / (c) maintain `materializeUnionJsonSchema` until upstream merges. **Default**: (c); revisit when upstream PR lands.
5. **OQ5** — Tier 4 SendInput: remove entirely vs retain as `target_unreachable` reporter. **Default**: retain; removal would constitute breaking change to the `scroll` action surface for cursor-only callers (unlikely but unverified).
6. **OQ6** — CDP wheel injection: (a) `Input.dispatchMouseEvent` new wrapper / (b) `evaluateInTab` JS injection `element.scrollBy()`. **Default**: (a); CDP-native is lower-latency and matches Playwright convention. (b) becomes a per-element override in `scroll(action='to_element', selector=...)`.
7. **OQ7** — Excel COM scroll as Tier 0 (`Application.ActiveWindow.SmallScroll`)? **Default**: defer to a separate ADR if needed; current 3 tiers already cover Excel cell area via Tier 1 UIA on the ListView pattern.

---

## 8. Out of scope

- **Scroll capture / scroll read OCR**: `scroll(action='capture')` and `scroll(action='read')` are separate concerns from the wheel pipeline. They will adopt `resolveWindowTarget` in Phase 5 (D3), but their OCR / stitching internals are not refactored.
- **Touch / pen / pinch scrolling**: this ADR is wheel-only. Touch input is a future ADR.
- **Horizontal wheel (`WM_MOUSEHWHEEL`)**: implemented symmetrically alongside vertical from Phase 1, but not separately enumerated in acceptance criteria.

---

## Appendix A — Industry references

- Microsoft, "Why are mouse wheel messages delivered to the focus window instead of the window under the mouse?" (DevBlogs, 2016-04-20) — Ctrl-state rationale, focus-window default
- Microsoft, "WM_MOUSEWHEEL message (Winuser.h)" (Learn) — destination semantics, lParam screen-coord encoding
- Microsoft, "Implementing the UI Automation Scroll Control Pattern" (Learn) — provider-side requirements
- MCP TypeScript SDK Issue #1643 — `registerTool` drops `inputSchema` for `z.discriminatedUnion`
- Chrome DevTools Protocol, Input domain — `dispatchMouseEvent` with `mouseWheel` type
- Playwright Windows mouse wheel implementation reference (`page.mouse.wheel(deltaX, deltaY)` → CDP path)

## Appendix B — Reuse map

Implementations that already exist and are called from new tier paths without modification:

- `src/uia/scroll.rs:142-224` `scroll_by_percent_impl` — Tier 1 SetScrollPercent (production-tested)
- `src/uia/scroll.rs:68-123` `scroll_into_view_impl` — Tier 1 ScrollIntoView (production-tested)
- `src/uia/scroll.rs:346-355` UIA scroll-percent getters — Tier 1 observation
- `src/win32/input.rs:156-183` `win32_post_message` — Tier 3 PostMessage (BigInt-safe, PR #77)
- `src/win32/scroll.rs:23-69` `win32_get_scroll_info` — Tier 3 observation fallback
- `src/engine/cdp-bridge.ts:284` `evaluateInTab` — Tier 2 dispatcher base (wraps `Runtime.evaluate`)
- `src/tools/_resolve-window.ts:94-178` `resolveWindowTarget` — destination resolution SSOT
- `src/tools/_envelope.ts:484-501` `withEnvelopeIncludeForUnion` — Zod-v3/v4 union extension (parent of new `materializeUnionJsonSchema`)
- `src/tools/mouse.ts:910-933` `captureScrollSnapshot` — dHash + GetScrollInfo observation (preserved as Tier 3)

→ **Phase 1 trunk PR introduces zero new Rust code**; all native paths are reused from existing crates.
