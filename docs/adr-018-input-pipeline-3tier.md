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
  - Existing 4-value `verifyDelivery.reason` enum in `src/tools/mouse.ts:971-982` (`read_back_unsupported` / `page_end_inferred` / `scrollbar_unavailable` / `no_target_window`) — superseded by the new 5-value tier-based taxonomy (D6); the existing test pin in `tests/unit/scroll-raw-verify.test.ts:114-129` will be rewritten in Phase 1
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
| 4 | `SendInput(MOUSEEVENTF_WHEEL)` | **Destination unresolvable**: `InputDestination.kind === 'unresolved'`. Records `reason='target_unreachable'` per §2.6.2 path-(a) | existing nutjs path in `src/tools/mouse.ts:1058-1100` |

Tier 4 is the **only** path that depends on cursor position; it is reached only when destination resolution fails (`kind === 'unresolved'`), and its outcome is reported as `reason='target_unreachable'` with `channel='send_input'`. Resolved destinations whose every applicable tier (1/2/3) is exhausted without observable delta also emit `reason='target_unreachable'` (per §2.6.2 path-(b)) but report the last-attempted tier's channel (e.g. `channel='postmessage'` for the Word `_WwG` case) and do **not** invoke Tier 4 SendInput — the Phase 1 runtime guard prevents that.

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

MCP SDK Issue #1643 will eventually be fixed upstream. Until then, add `materializeUnionJsonSchema()` to `src/tools/_envelope.ts`. The two helpers operate at different layers and are **not** sibling/parent in the sense of producing the same kind of object:

- `withEnvelopeIncludeForUnion` (`src/tools/_envelope.ts:484-501`) takes a `z.discriminatedUnion`, mutates each variant by injecting the `include` field, and returns a **new `z.discriminatedUnion`** (a Zod type, used for input validation and TS inference).
- `materializeUnionJsonSchema()` (new) takes the **output** of `withEnvelopeIncludeForUnion` (or the original union if no envelope extension is needed) and produces a **JSON Schema** object (a plain JS object with `oneOf` over the discriminator branches, suitable for direct use in `server.registerTool({ inputSchema })`).

So the call sequence in `scroll.ts` / `keyboard.ts` / `excel.ts` becomes: `schema = withEnvelopeIncludeForUnion(union); inputSchema = materializeUnionJsonSchema(schema); server.registerTool({ inputSchema, ... });`. The new helper does **not** replace `withEnvelopeIncludeForUnion` — both run.

Implementation strategy for `materializeUnionJsonSchema`: walk the Zod schema with `zod._def` introspection (the same path Zod's own `toJSONSchema` uses), emit `{ oneOf: [<per-variant object schema>], discriminator: { propertyName: <discriminator>, mapping: {...} } }`. Reference: the SDK's `normalizeObjectSchema()` that drops the discriminator today does so by checking `def.type === 'union'`; the new helper short-circuits that path by producing a fully materialized object schema before the SDK sees it.

When upstream lands the fix (MCP TypeScript SDK Issue #1643), deprecate the helper and remove the hand-rolled schemas — tracked in §7 OQ4.

### 2.6 D6 — Typed reason taxonomy

The existing `ScrollVerifyOutcome` (`src/tools/mouse.ts:943-985`) has two orthogonal fields that must stay orthogonal under the new pipeline:

- `status: "delivered" | "unverifiable" | "not_delivered"` — 3-value outcome (unchanged)
- `reason?:` — context for non-`delivered` outcomes (currently 4 values, replaced below)
- `channel:` — transport identifier (currently `"wheel_send_input"`); ADR-018 extends to 4 values

#### 2.6.1 `verifyDelivery.channel` (transport identifier, 4 values)

| Channel | Tier | Meaning |
|---|---|---|
| `uia` | Tier 1 | `IUIAutomationScrollPattern::SetScrollPercent` issued |
| `cdp` | Tier 2 | `Input.dispatchMouseEvent({type:'mouseWheel'})` issued |
| `postmessage` | Tier 3 | `PostMessage(hwnd, WM_MOUSEWHEEL, …)` issued |
| `send_input` | Tier 4 | `SendInput(MOUSEEVENTF_WHEEL)` issued (cursor-position fallback) |

`channel` is always set, regardless of `status`. It tells the LLM which physical channel made the attempt, decoupled from whether the attempt succeeded.

#### 2.6.2 `verifyDelivery.reason` (new 5-value enum, replaces existing 4)

| Reason | Emitted when | `status` |
|---|---|---|
| `delivered_via_uia` | Tier 1 succeeded, UIA `CurrentVerticalScrollPercent` pre/post differed by ≥ `SCROLL_PERCENT_EPSILON` | `delivered` |
| `delivered_via_cdp` | Tier 2 succeeded, CDP `document.scrollingElement.scrollTop` pre/post differed | `delivered` |
| `delivered_via_postmessage` | Tier 3 succeeded, `GetScrollInfo` or dHash confirmed change | `delivered` |
| `wheel_overlay_intercepted` | Cursor-pixel HWND ≠ focused HWND AND a `WS_EX_LAYERED \| WS_EX_TRANSPARENT` window detected on top, after all destination-explicit tiers were tried and reported no movement | `unverifiable` |
| `target_unreachable` | Either (a) `InputDestination.kind === 'unresolved'` AND Tier 4 SendInput produced no observable delta — emits `channel='send_input'`; **OR** (b) destination resolved but every applicable tier (1/2/3) was exhausted without observable delta (e.g. Word `_WwG` does not consume `WM_MOUSEWHEEL`, Phase 4 OQ8) — emits `channel` ∈ {`uia`, `cdp`, `postmessage`} reflecting the last-attempted tier (typically `postmessage` for the Word case). Tier 4 SendInput is **not** invoked in path (b). | `not_delivered` |

#### 2.6.3 Migration from the existing 4-value `reason`

| Old reason (mouse.ts:971-982) | New reason | Mapping rationale |
|---|---|---|
| `page_end_inferred` | **deleted** | Old "I have no observer channel" shrug. Under ADR-018 every tier carries its own observer (UIA percent / CDP scrollTop / PostMessage + GetScrollInfo), so this state is unreachable. |
| `read_back_unsupported` | `wheel_overlay_intercepted` (if overlay detected) or `target_unreachable` (otherwise) | Old "Win32 GetScrollInfo unsupported" → split into the two real cases the new taxonomy distinguishes. |
| `scrollbar_unavailable` | `delivered_via_cdp` / `delivered_via_uia` (success cases, since they don't need a scrollbar) or `target_unreachable` | The condition itself disappears — only Tier 4 still depends on Win32 scrollbar observation, and Tier 4 only fires when destination is unresolved. |
| `no_target_window` | `target_unreachable` | Direct semantic equivalent; the new name aligns with destination-explicit terminology. |

**Public API contract** (CLAUDE.md §3.2 carry-over scope shrink): callers that pass `scroll({action:'raw', direction:'down', amount:N})` with no destination today receive `status:'delivered'` on the happy path. Under ADR-018 they still receive `status:'delivered'`, but `reason` is now one of `delivered_via_*` (Tier 1/2/3 attached automatically by `resolveWindowTarget(@active)`) — the **happy-path `status` string does not change**. Only the `reason` enum values change; the existing field shape is preserved. Existing tests in `tests/unit/expansion-scroll-wrapper.test.ts:83, 109, 135, 167` (which mock the handler and don't inspect `reason`) continue to pass without modification.

This is the **only** SSOT for `verifyDelivery.reason`. The synchronization surfaces are:
- `src/tools/mouse.ts:971-982` (`ScrollVerifyOutcome.reason` union type — single source of truth in code)
- `tests/unit/scroll-raw-verify.test.ts:114-130` (existing test pin — rewritten in Phase 1)
- `src/tools/_errors.ts:256-262` (`ScrollNotDelivered` suggest list — surface 2, updated to reference new reasons)
- per-tool description in `src/tools/scroll.ts:249-256` (surface 3, updated in Phase 1)
- CHANGELOG entry for the eventual user-facing release (surface 4, written at release time per CLAUDE.md §10)

CLAUDE.md §3.1 multi-table fact sweep applies across these 5 surfaces. ADR-010 is **not** in the sync set — its typed-reason taxonomy is the typed-error catalog (`WindowNotFound` class), not `verifyDelivery.reason`.

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
| `src/tools/mouse.ts` | 971-982 (`ScrollVerifyOutcome.reason` union) + `scrollHandler` `verifyDelivery` emission | Replace 4-value reason union with 5-value enum per §2.6.2; add `channel: "uia" \| "cdp" \| "postmessage" \| "send_input"` field per §2.6.1 (Phase 1, single source of truth) |
| `tests/unit/scroll-raw-verify.test.ts` | 114-130 | Rewrite the `page_end_inferred` test case to assert the new mapping per §2.6.3 (Phase 1) |
| `src/tools/_errors.ts` | 256-262 (`ScrollNotDelivered` suggest list) | Update suggest copy to reference new reason names (`wheel_overlay_intercepted`, `target_unreachable`); typed-error code unchanged (Phase 1) |
| `src/tools/scroll.ts` | 249-256 (tool description `Caveats:` section) | Update `action='raw' typed errors:` paragraph to list new reasons (Phase 1) |
| `.github/workflows/input-pipeline-guard.yml` | **new** | CI assert: zero `getWindows` in `src/tools/`, zero `page_end_inferred` in `src/` and `tests/` (Phase 5) |
| `__test__/smoke/scroll-5app.smoke.test.ts` | **new** | 5-app × 4-direction smoke (Phase 5, `workflow_dispatch` Windows runner) |
| `__test__/fixtures/overlay-window.ts` | **new** | `WS_EX_LAYERED | WS_EX_TRANSPARENT` fake overlay child process for DDPM repro (Phase 1) |
| `__test__/unit/keyboard-cjk.test.ts` | **new** | NON_ASCII_RE + clipboard-route integration assertions (Phase 2b) |
| `__test__/integration/tools-list-schema.test.ts` | **new** | MCP `tools/list` inputSchema non-empty assertion (Phase 2a) |

---

## 4. Phase split (trunk + expansion, walking-skeleton pattern)

### Phase 1 — Trunk PR: Tier 1 UIA path on Notepad (1 PR, 3-4 days)

**Scope minimum / contract maximum** per `docs/walking-skeleton-trunk-selection.md` §3.2.

Deliverables:
- New `_input-pipeline.ts` with dispatcher skeleton + `InputDestination` discriminated union (type per §2.3) + 5-value `reason` enum + 4-value `channel` enum (per §2.6)
- New napi export `uia_scroll_by_wheel_at_hwnd` (wraps existing `scroll_by_percent_impl` with wheel-delta → percent conversion)
- `scrollHandler` (`src/tools/mouse.ts:1040-1174`) refactored to call dispatcher; `resolveWindowTarget` required as first step (with `@active` default when no `windowTitle` / `hwnd` supplied, preserving cursor-only happy path per §2.6.3)
- **Runtime guard**: `assert(dest.kind === 'unresolved', 'Tier 4 SendInput requires unresolved destination')` immediately before any `MOUSEEVENTF_WHEEL` SendInput call. Failure throws a typed error caught at the handler and reported as `status: 'not_delivered', reason: 'target_unreachable'` (covers L2 compile-time-guard overreliance)
- `ScrollVerifyOutcome.reason` union (`src/tools/mouse.ts:971-982`) extended to the new 5-value enum; old 4 reasons mapped per §2.6.3
- `tests/unit/scroll-raw-verify.test.ts:114-130` `page_end_inferred` test case rewritten to assert the new 5-value mapping (one test per reason)
- `src/tools/_errors.ts:256-262` `ScrollNotDelivered` suggest list updated to reference the new reason names; typed-error code unchanged
- `src/tools/scroll.ts:249-256` tool description `Caveats:` section updated to list the new reasons
- `__test__/fixtures/overlay-window.ts` fixture (Win32 `WS_EX_LAYERED \| WS_EX_TRANSPARENT` child process) for DDPM repro under unit test

CLAUDE.md §3.1 sweep covers the 5 surfaces listed in §2.6 (`mouse.ts:971-982` / `scroll-raw-verify.test.ts` / `_errors.ts:256-262` / `scroll.ts:249-256` / CHANGELOG).

**G1 acceptance**: `scroll(action='raw', windowTitle:'メモ帳', direction:'down')` returns `verifyDelivery.status='delivered'`, `verifyDelivery.channel='uia'`, `verifyDelivery.reason='delivered_via_uia'`, with numeric `scrollObserved.delta`, and continues to do so when the `overlay-window` fixture is running. Tier 4 SendInput must not fire (asserted via a Phase 1 unit-test spy on the SendInput call site).

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
- **Word HWND class enumeration sub-deliverable**: Word's document body is a custom-painted MFC surface (`_WwG` / `_WwO` class), and `WM_MOUSEWHEEL` PostMessage to the document HWND is known to be flaky — the ribbon and host frame frequently intercept. Phase 4 enumerates Word's HWND class hierarchy via `EnumChildWindows`, identifies the receiver class empirically (likely `_WwG`), and adds a fixture `__test__/fixtures/word-class-enumerate.test.ts` that pins the class name. If `_WwG` does not receive `WM_MOUSEWHEEL` reliably, Word emits `status='not_delivered', reason='target_unreachable', channel='postmessage'` (§2.6.2 path-(b): destination resolved, Tier 3 attempted, no observable delta). **Tier 4 SendInput is NOT invoked** for this case — the Phase 1 runtime guard prevents it because Word's destination is resolved (`kind='hwnd'`, not `'unresolved'`). The Word fallback is a documented Tier 3 unobserved exhaust, not a Tier 4 SendInput invocation. Carry-over recorded in §7 OQ8.
- Word / Excel / Explorer smoke cases (stubbed Phase 1, finalized here)

**G4 acceptance**: Excel cell area / Explorer ListView scroll returns `status='delivered', channel='postmessage', reason='delivered_via_postmessage'`; Tier 4 SendInput never fires for those 2 apps. Word: either (a) `status='delivered', channel='postmessage', reason='delivered_via_postmessage'` if `_WwG` consumes `WM_MOUSEWHEEL`, OR (b) `status='not_delivered', channel='postmessage', reason='target_unreachable'` with class enumeration recorded in `word-class-enumerate.test.ts`. Tier 4 SendInput must not fire for Word in either outcome.

**Review loop**: Opus 2-3 rounds, Codex 1 round (Win32 API contract axis — PR #102 same regression class).

### Phase 5 — Finalize: SSOT unification + CI assert + 5-app smoke (1 PR, 2 days)

Deliverables:
- `scroll-read.ts:96` `getWindows()` → `resolveWindowTarget`
- `input-pipeline-guard.yml` (negative assertions): grep `getWindows src/tools/` returns 0 lines, grep `page_end_inferred src/ tests/` returns 0 lines
- **Positive assertion** (`__test__/integration/reason-enum-coverage.test.ts` new): every code path in `mouse.ts` `scrollHandler` that emits `status='not_delivered'` populates `reason` from the 5-value enum (no `undefined`, no string outside the enum). Asserted via a vitest case that exercises each tier failure mode through the dispatcher
- `tests/unit/scroll-raw-verify-tier1.test.ts` (new): `scrollHandler` envelope-assembly integration test — asserts `verifyDelivery.channel='uia'` / `reason='delivered_via_uia'` end-to-end when the Tier 1 UIA dispatcher succeeds, and that `observedHwnd` is seeded from `dest.hwnd` for resolved destinations. **Carried over from Phase 1b** (sub-plan §2.1#5): the dispatcher-level contract is pinned by `input-pipeline-dispatch.test.ts`; this test covers the `scrollHandler` envelope path and is folded in here because a meaningful end-to-end assertion needs the same full `scrollHandler` wiring the 5-app smoke harness builds. Natural sibling of `reason-enum-coverage.test.ts`.
- `scroll-5app.smoke.test.ts` finalized for all 5 apps × 4 directions (`workflow_dispatch`, Windows runner)

**G5 acceptance** (= AC1+AC2+AC5): All 5 apps return numeric delta + the expected `(status, channel, reason)` triple per AC1; no `page_end_inferred` survives in `src/` or `tests/`; no `getWindows` in `src/tools/`.

**Total**: 6 PRs, 12–19 days. Phase 2a and 2b parallel-OK, reducing wall-clock to ~10-15 days with background-agent parallelism (CLAUDE.md §3.4).

---

## 5. Risks

- **R1** — DDPM overlay detection is environment-specific. CI runners can't reproduce. Mitigation: `__test__/fixtures/overlay-window.ts` synthesizes the same `WS_EX_LAYERED | WS_EX_TRANSPARENT` topology via a Win32 child process; Tier 1.5 `WindowFromPoint`-based detector surfaces the warning in production.
- **R2** — UIA ScrollPattern support varies. Word document body is UIA-blind. Mitigation: dispatcher falls through Tier 1 → Tier 3 when `IsScrollPatternAvailable` is false; tier-selection logic centralized in `_input-pipeline.ts::pickActionTier`.
- **R3** — CDP `target='body'` scrollTop=0 bug. Mitigation: Phase 3 replaces single `document.body.scrollIntoView` with `document.scrollingElement || document.documentElement` two-step query.
- **R4** — MCP SDK Issue #1643 timing. Mitigation: §7 OQ4 documents 3 candidate strategies (vendored patch / fork / hand-rolled helper). Default to hand-rolled until upstream lands; the helper has a clear deprecation path.
- **R5** (CLAUDE.md §3.2) — Tier 4 SendInput retained as fallback may be misread as carry-over scope shrink that breaks existing API. Mitigation: ADR-level contract pinned in §2.6.3 ("Public API contract") that Tier 4 is reachable only when `InputDestination.kind === 'unresolved'`, and its outcome is always reported as `status:'not_delivered', reason:'target_unreachable'`, never as success. Existing cursor-only callers (`tests/unit/expansion-scroll-wrapper.test.ts:83, 109, 135, 167`, hypothetical end-users typing `scroll({action:'raw', direction:'down', amount:N})` with no destination) preserve their happy-path `status:'delivered'` because `resolveWindowTarget(@active)` (the existing default destination in `_resolve-window.ts`) successfully resolves to the foreground HWND and routes through Tier 1/2/3. The runtime guard in Phase 1 deliverables (assert before SendInput) is the structural enforcement of this contract.
- **R6** (CLAUDE.md §3.1) — 5-value `verifyDelivery.reason` and 4-value `verifyDelivery.channel` taxonomies spread across 5 surfaces (`src/tools/mouse.ts:971-982`, `tests/unit/scroll-raw-verify.test.ts:114-130`, `src/tools/_errors.ts:256-262` `ScrollNotDelivered` suggest list, `src/tools/scroll.ts:249-256` tool description caveats, CHANGELOG entry at release time). Mitigation: Opus review prompt for each phase includes a mandatory grep sweep of these 5 surfaces; the Phase 5 CI guard (`input-pipeline-guard.yml`) automates the `page_end_inferred` 0-hit assertion across `src/` and `tests/`.
- **R7** — Keyboard CJK keystroke path may currently work in some IME configurations (composition mode + active IME). Phase 2b regex change must not break these. Mitigation: integration test 1 case (IME ON, CJK typing) added before regex flip; if test fails, regex change is reverted and Phase 2b is split into "detector only" + "auto-clipboard upgrade" sub-PRs.

---

## 6. Acceptance criteria

- **AC1**: All 5 tested apps (Chrome / Notepad / Word / Excel / File Explorer) return `verifyDelivery.status='delivered'`, `verifyDelivery.channel` ∈ {`uia`, `cdp`, `postmessage`}, and `verifyDelivery.reason` ∈ {`delivered_via_uia`, `delivered_via_cdp`, `delivered_via_postmessage`}, with numeric `scrollObserved.delta` for `scroll(action='raw', direction='down')`. **For Word, AC1 is satisfied by either (a) `status='delivered', channel='postmessage', reason='delivered_via_postmessage'` via Tier 3 PostMessage to `_WwG`, OR (b) `status='not_delivered', channel='postmessage', reason='target_unreachable'` per §2.6.2 path-(b) "every applicable tier exhausted" with the class-enumeration fixture `__test__/fixtures/word-class-enumerate.test.ts` pinning the rationale. Tier 4 SendInput (`channel='send_input'`) must not appear for Word — its destination is resolved.** (Phase 4 OQ8 documented fallback.)
- **AC2**: `grep -rn "page_end_inferred" src/ tests/` returns 0 hits; every emitted `verifyDelivery.reason` value matches the 5-value enum in §2.6.2
- **AC3**: `keyboard(action='type', text='日本語テスト')` succeeds with `typed:7` and Notepad's `ValuePattern.Value` reads back `'日本語テスト'`
- **AC4**: MCP `tools/list` for `scroll`, `keyboard`, `excel` returns `inputSchema` with **both** non-empty `properties` (or top-level `oneOf` with discriminator-bearing branches) **AND** the action discriminator value enumerated. A schema with `properties:{}` but non-empty `oneOf` does **not** satisfy AC4 (SDK collapse symptom). Asserted via `__test__/integration/tools-list-schema.test.ts` (Phase 2a)
- **AC5**: `grep -rn "getWindows" src/tools/` returns 0 hits; all `windowTitle` resolution in scroll path goes through `resolveWindowTarget`

---

## 7. Open Questions

1. **OQ1** — **Resolved**: ADR number is 018 (ADR-016 occupied by `adr-016-rdp-virtual-window.md`, ADR-017 occupied by `adr-017-session-aware-desktop-touch.md` which landed 2026-05-13)
2. **OQ2** — DDPM overlay handling: (a) README adds "consider disabling DDPM if scroll feels sticky" / (b) tool-side `WindowFromPoint` detector emits warning in `hints.environmentNotes` / (c) both. **Default**: (b) only, surface in production telemetry; (a) added if user reports recur. Decide at Phase 1 PR creation.
3. **OQ3** — Tier 1 UIA inside Chromium (`--force-renderer-accessibility` required): try in Phase 3 as a Tier 1.5 between CDP and PostMessage? **Default**: skip; CDP is the canonical Chrome path. Reopen if Phase 3 dogfood reveals CDP latency outliers.
4. **OQ4** — MCP SDK Issue #1643 adoption: (a) `patches/` vendored / (b) fork & npm alias / (c) maintain `materializeUnionJsonSchema` until upstream merges. **Default**: (c); revisit when upstream PR lands.
5. **OQ5** — Tier 4 SendInput: remove entirely vs retain as `target_unreachable` reporter. **Default**: retain. **Reopen trigger**: any of (a) a user report of a removed cursor-only `scroll({action:'raw'})` happy path, (b) Phase 4 G4 Word fallback proving impractical and the team chooses to remove the dead path instead of documenting it, (c) Phase 5 telemetry showing zero production `channel='send_input'` emissions over 30 days.
6. **OQ6** — CDP wheel injection: (a) `Input.dispatchMouseEvent` new wrapper / (b) `evaluateInTab` JS injection `element.scrollBy()`. **Default**: (a); CDP-native is lower-latency and matches Playwright convention. (b) becomes a per-element override in `scroll(action='to_element', selector=...)`. **Reopen trigger**: Phase 3 dogfood reveals `Input.dispatchMouseEvent` latency p99 > 200 ms or routing failures on Chromium-based apps that are not Chrome / Edge (e.g. Slack, VS Code).
7. **OQ7** — Excel COM scroll as Tier 0 (`Application.ActiveWindow.SmallScroll`)? **Default**: defer to a separate ADR if needed; current 3 tiers already cover Excel cell area via Tier 1 UIA on the ListView pattern. **Reopen trigger**: Phase 4 G4 reveals Excel Tier 1 UIA path fails on frozen panes, formula bar focus, or other non-grid Excel regions.
8. **OQ8** — Word document body (`_WwG` MFC class) PostMessage(WM_MOUSEWHEEL) reception: per Phase 4 sub-deliverable, if class enumeration confirms `WM_MOUSEWHEEL` is intercepted by the frame, Word emits `status='not_delivered', channel='postmessage', reason='target_unreachable'` per §2.6.2 path-(b) (Tier 3 exhausted; Tier 4 SendInput is **not** invoked because Word's destination is resolved, blocked by the Phase 1 runtime guard at §4 Phase 1 deliverables). **Reopen trigger**: an alternative path (e.g. Word automation via COM `Application.ActiveDocument.Application.CommandBars`, or via the Office UIA provider's `LegacyIAccessible` pattern) lands in scope.

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
- `src/tools/_envelope.ts:484-501` `withEnvelopeIncludeForUnion` — Zod-v3/v4 union extension, **upstream** of new `materializeUnionJsonSchema` in the call sequence (the union output of the former is the input to the latter; see §2.5 for the exact sequence)
- `src/tools/mouse.ts:910-933` `captureScrollSnapshot` — dHash + GetScrollInfo observation (preserved as Tier 3)

→ **Phase 1 trunk PR introduces zero new Rust code**; all native paths are reused from existing crates.
