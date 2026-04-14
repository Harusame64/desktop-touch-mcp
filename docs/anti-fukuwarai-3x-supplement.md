# Anti-Fukuwarai 3.x Supplement — focusedElement, cursorOverElement, and Rich Narration (Combined Sprint)

> 2026-04-14 — supplement to [`anti-fukuwarai-ideals-plan.md`](./anti-fukuwarai-ideals-plan.md)
> Scope: deepen 3.1 (context retrieval) and 3.2 (rich narration) as a **single integrated sprint**. Windows-only.

## 0. Purpose and framing

The current canonical LLM loop is four steps:

1. `screenshot(detail='meta')` — window positions (~400 tok)
2. `screenshot(dotByDot=true)` or `detail='text'` — coordinates / actionables (~1.5–4 k tok)
3. `click_element` / `set_element_value` / `keyboard_*` (action)
4. `screenshot(diffMode=true)` — verify the action actually did something (~160–500 tok)

Phase 2.1 (`post`) already collapses step 4 in the common "nothing surprising happened" case. This supplement attacks step 1 and step 2 by making `get_context` semantically rich enough to replace both, and makes step 4 redundant even under surprises by shipping a UIA diff inside the action response (3.2 rich narration).

This document does **not** revisit Phase 0–2. It aligns 3.1/3.2 with what already shipped (`src/tools/context.ts`, `src/tools/_post.ts`) and specifies the remaining work **as one combined sprint** — an earlier draft proposed splitting it into Sprint A (3.1) then Sprint B (3.2), but the two work items share the same UIA infrastructure and are cheaper to land together. See §2 for the rationale.

---

## 1. Current-state audit (what shipped vs. plan)

### 1.1 `get_context` — implemented, but the semantic layer is missing

| Plan field | Shipped in `src/tools/context.ts` | Gap |
|---|---|---|
| `focusedWindow` | yes | — |
| `cursorPos` | yes | — |
| `cursorOverElement` (UIA `ElementFromPoint`) | no — only `cursorOverWindow` (Z-order hit test at `context.ts:52–59`) | **Missing — downgraded to window level** |
| `focusedElement` (UIA `FocusedElement`) | no | **Missing** |
| `hasModal` | yes (title-regex heuristic, `context.ts:63`) | — |
| `pageState` | yes (binary `ready` / `dialog`) | `loading` / `error` never emitted |
| `visibleWindows` | yes (extra) | — |

### 1.2 `_post.ts` — `focusedElement` hard-coded to `null`

`_post.ts:76` emits `focusedElement: null` unconditionally, with the comment `"Phase 2.1 keeps this minimal; rich variant lives in get_context()"`. The field is declared on `PostState` but never populated — the obligation was consciously deferred to 3.1. Every action tool's `post` block is therefore semantically thinner than its type says.

### 1.3 `get_history` / `get_document_state`

Both match the plan and require no structural change. `get_history` already consumes `PostState`, so the history ring buffer gains `focusedElement` tracking *for free* once `_post.ts` is wired to the new UIA call.

### 1.4 Rich narration (3.2)

Not implemented. The progress table marks it "defer until usage data justifies UIA-diff cost." This document promotes it from "deferred" to "ship with 3.1" because the cost model changes materially once 3.1's infrastructure exists — see §2.

---

## 2. Combined sprint — why 3.1 extension and 3.2 are one piece of work

### 2.1 The infrastructure overlap

The surface area of 3.1 and 3.2 looks different from the top:

- 3.1 needs: "read the one focused element" + "read the one element under the cursor"
- 3.2 needs: "enumerate elements before", "enumerate elements after", "diff them"

But under the hood they are the **same three PowerShell capabilities** — splitting them across two sprints forces us to build, ship, and review the same bridge code twice.

| Capability | Used by 3.1 | Used by 3.2 | Built where |
|---|---|---|---|
| `AutomationElement.FocusedElement` + `Normalize` | `focusedElement` in `get_context` | `post.focusedElement` after the action (same call, same shape) | `uia-bridge.ts` — new `getFocusedUiaElement` |
| `AutomationElement.FromPoint(x,y)` | `cursorOverElement` in `get_context` | — (not strictly needed for diff, lives in the same composite script) | `uia-bridge.ts` — new `getUiaElementFromPoint` |
| `GetCurrentPattern(ValuePattern).Value` inside `makeGetElementsScript` | `focusedElement.value` on text fields | `valueDeltas` before/after comparison | `uia-bridge.ts` — new `fetchValues: true` flag on existing script |
| `computeUiaDiff(before, after)` | — | `post.rich.appeared` / `disappeared` / `valueDeltas` | new `src/engine/uia-diff.ts` |
| `_post.ts` narration hook | writes real `focusedElement` | writes `post.rich` block when `narrate:"rich"` | `_post.ts` — one edit, two readers |

Rows 1 and 3 are shared. Row 2 is a trivial add-on in the same PS composite. Row 4 reuses row 3's output directly. Row 5 is a single `_post.ts` refactor that both paths read from.

### 2.2 Design principle — build the infrastructure once

> **The UIA bridge is extended exactly once. Both 3.1 and 3.2 are read-sites against that bridge.**

Concretely:

- `getFocusedUiaElement` is the same PS call whether `get_context` calls it or `_post.ts` calls it post-action. Wiring one without the other leaves an obvious gap (`get_context` returns `focusedElement.value="hello"`, but the immediately-prior action's `post.focusedElement` is still `null`).
- The `fetchValues` flag on `makeGetElementsScript` costs ~3 lines of PS. Adding it "for 3.1's focusedElement.value" and then re-touching the same function "for 3.2's valueDeltas" is two reviews of the same change.
- `computeUiaDiff` is only useful if the snapshots it diffs carry values, so shipping 3.2 without 3.1's `fetchValues` would land a `valueDeltas: []` that never fires.
- Conversely, shipping 3.1 without 3.2 means we carry the extended PS script (paying its cost on every `get_context`) but never exercise its diff use case — no telemetry to evaluate the deferred 3.2 decision.

The net effect is that **the combined sprint is smaller than the sum of two separate sprints** — one PS composite, one `_post.ts` edit, one instruction-text update, one round of E2E tests.

### 2.3 Scope guardrails (what stays out)

- `narrate:"rich"` is **opt-in** — default stays `"minimal"` so token cost is zero for callers that don't ask.
- Rich is added only to tools where a state delta is semantically expected (see §4.3 matrix). Trivial keys (single letters on `keyboard_press`) silently downgrade.
- Phase 4 (intent composites) remains out of scope.
- Chromium diffing uses CDP, not UIA — see §4.4.

---

## 3. Implementation task list (combined sprint)

```
[ ] uia-bridge.ts: add getFocusedUiaElement + getUiaElementFromPoint
    — single composite PS script, runs both calls in parallel to amortize
      the ~200 ms PS startup cost. Returns { focused, atPoint }.
    — Normalize via TreeWalker.ControlViewWalker.Normalize (NVDA-style).
    — Timeout 1500 ms; on timeout return null (non-essential fields).
    — Probe ValuePattern only for focused (skip for atPoint — no
      password-field echo on hover).

[ ] uia-bridge.ts: extend makeGetElementsScript with fetchValues flag
    — when true, per-element try/catch on GetCurrentPattern(ValuePattern)
      and append `value` to the element record.
    — default false; only get_context (via getFocusedUiaElement) and the
      rich-narration path pay for it.

[ ] uia-diff.ts (new): export computeUiaDiff(before, after)
    — identity key = automationId || (controlType + '|' + name + '|' + depth)
    — appeared/disappeared filtered to elements with boundingRect and
      non-empty name (drops invisible panes)
    — valueDeltas = keys present in both where ValuePattern value changed
    — size caps: appeared ≤5, disappeared ≤5, valueDeltas ≤3, overflow
      reported as { truncated: N }
    — before/after strings trimmed to 80 chars with "…"

[ ] context.ts: wire get_context → focusedElement + cursorOverElement
    — reuse CHROMIUM_TITLE_RE from workspace.ts
    — Chromium: focusedElement still attempted (surface is OK); on
      empty result, fall back to CDP via already-imported evaluateInTab
    — Chromium: cursorOverElement skipped (returns null) — UIA sparse,
      CDP has no cheap screen-point → DOM-node mapping
    — emit hints.chromiumGuard / hints.focusedElementSource / hints.uiaStale

[ ] _post.ts: populate post.focusedElement from getFocusedUiaElement
    — replaces the hard-coded null at _post.ts:76
    — kept fast: same 1500 ms timeout; on timeout, remains null
    — history ring buffer automatically inherits the new field

[ ] _post.ts: add withRichNarration wrapper adjacent to withPostState
    — activated only when args.narrate === "rich"
    — BEFORE: getUiElements(windowTitle, {cached:true, fetchValues:true})
    — ACTION: existing handler
    — AFTER:  sleep(120 ms) → getUiElements(..., fetchValues:true) live
    — diff via computeUiaDiff; splice into post.rich on success
    — on timeout/window-closed/chromium-sparse: post.rich = { diffSource:
      "none", diffDegraded: "<reason>" }
    — NOTE: `before` snapshot must be local to the call (not module-level)
      to avoid concurrent-call state leakage

[ ] Chromium CDP diff path (browser_* tools + mouse_click on Chromium)
    — BEFORE: beforeUrl=tab.url; beforeInteractive=browser_get_interactive
      (cached if <1 s old); beforeValues=CDP eval of
      querySelectorAll('input,textarea,select') values
    — AFTER: wait on Page.loadEventFired OR 150 ms; re-snapshot
    — emit post.rich.navigation when beforeUrl !== afterUrl
    — emit appeared/disappeared on interactive roster by selector/testid
    — emit valueDeltas from the value snapshot

[ ] Action tools: add narrate: "minimal" | "rich" parameter
    — click_element, set_element_value (src/tools/ui-elements.ts)
    — keyboard_type; keyboard_press (hotkeys-only gate: Enter/Tab/Esc/F5)
    — mouse_click, mouse_drag
    — browser_click_element, browser_navigate
    — default "minimal"; rich is opt-in per call

[ ] index.ts: rewrite get_context description
    — emphasize focusedElement.value use case (post-type verification)
    — note Chromium policy (cursorOverElement null; focusedElement may be CDP)
    — explicitly position it as a replacement for screenshot(detail='meta')
      AND for post-action confirmation screenshots

[ ] index.ts: add narrate:"rich" guidance to action-tool descriptions
    — "Use narrate:'rich' when the action is expected to cause a dialog,
       navigation, or value change and you would otherwise take a
       screenshot(diffMode=true) to verify."

[ ] E2E: extend existing suites — see §6
```

---

## 4. Response specifications

### 4.1 `get_context` v2 — full type

```ts
get_context() → ok({
  // OS level (unchanged)
  focusedWindow: { title: string; processName: string; hwnd: string } | null,
  cursorPos: { x: number; y: number },
  cursorOverWindow: { title: string; hwnd: string } | null,      // kept for back-compat

  // NEW — semantic level
  focusedElement: {
    name: string;
    type: string;                 // UIA ControlType, e.g. "Edit", "Button"
    value?: string;               // ValuePattern.Current.Value if applicable
    automationId?: string;
  } | null,
  cursorOverElement: {
    name: string;
    type: string;
    automationId?: string;
  } | null,

  // App / document level (unchanged + enriched)
  hasModal: boolean,
  pageState: "ready" | "loading" | "dialog" | "error",
  visibleWindows: number,

  // NEW — diagnostic hints (parallels screenshot.ts hints)
  hints: {
    chromiumGuard?: true,                  // UIA bypassed for Chromium foreground
    focusedElementSource?: "uia" | "cdp",  // "cdp" = derived via document.activeElement
    uiaStale?: true                        // UIA call timed out; UIA fields are null
  }
})
```

Notes:

- `pageState` upgrades: `loading` emitted when Chromium foreground reports `readyState !== "complete"` via CDP (cheap, only when CDP port already known). `error` emitted when `hasModal && MODAL_RE` matches the error subset.
- `cursorOverWindow` is retained alongside `cursorOverElement` — they answer different questions (Z-order hit test vs. UIA hit test) and both are cheap.

### 4.2 `post.rich` — full type

Spliced into the existing `post` block on success, only when the caller passed `narrate: "rich"`:

```ts
post: {
  // always-on (2.1) — focusedElement is now real, not null
  focusedWindow: string | null,
  focusedElement: {
    name: string; type: string;
    value?: string; automationId?: string;
  } | null,
  windowChanged: boolean,
  elapsedMs: number,

  // opt-in (3.2)
  rich?: {
    appeared:     Array<{ name: string; type: string; automationId?: string }>,
    disappeared:  Array<{ name: string; type: string }>,
    valueDeltas:  Array<{ name: string; type: string; before: string; after: string }>,
    navigation?:  { fromUrl: string; toUrl: string },      // CDP path only
    truncated?:   { appeared?: number; disappeared?: number; valueDeltas?: number },
    diffSource:   "uia" | "cdp" | "none",
    diffDegraded?:"chromium_sparse" | "timeout" | "window_closed" | "process_restarted"
  }
}
```

`diffSource` and `diffDegraded` are honesty fields — they let the LLM distinguish "nothing changed" from "we couldn't look."

### 4.3 Per-tool support matrix

| Tool | `narrate:"rich"` | Diff source | Notes |
|---|---|---|---|
| `click_element` | yes | UIA (Chromium: CDP) | Prime use case — "did the dialog open?" |
| `set_element_value` | yes | UIA | `valueDeltas` confirms value landed |
| `keyboard_type` | yes | UIA (Chromium: CDP) | Routes through focused element |
| `keyboard_press` | conditional | UIA | State-transitioning keys only: Enter, Tab, Esc, F5; trivial keys silently downgrade to minimal |
| `mouse_click` | yes | UIA (Chromium: CDP) | Many apps aren't UIA-addressable |
| `mouse_drag` | yes | UIA | — |
| `browser_click_element` | yes | CDP | |
| `browser_navigate` | yes | CDP | `navigation` field is the key output |
| `browser_eval` | no | — | User-authored scripts — diff semantics don't apply |
| `terminal_send` | no | — | Output read via `terminal_read` / `wait_until terminal_output_contains` |

### 4.4 Chromium path (UIA sparse → CDP fallback)

Chromium apps (Teams, Chrome, Edge, Slack, VS Code WebView — detected via `workspace.ts:CHROMIUM_TITLE_RE`) publish sparse UIA trees. `screenshot.ts:440` already sets `hints.chromiumGuard=true` to bypass UIA. 3.1 and 3.2 follow the same policy:

```
get_context:
  non-Chromium FG      → UIA for both focusedElement and cursorOverElement
  Chromium FG, UIA OK  → UIA focusedElement, cursorOverElement=null
  Chromium FG, UIA thin→ CDP document.activeElement fallback;
                         hints.focusedElementSource="cdp"
  Chromium FG, no CDP  → focusedElement=null + hints.chromiumGuard

post.rich on Chromium:
  BEFORE: beforeUrl=tab.url; beforeInteractive=browser_get_interactive (cached)
          beforeValues=CDP eval over input/textarea/select (.value, keyed by name||id||selector)
  AFTER:  Page.loadEventFired OR 150 ms settle; re-snapshot
  emit    appeared/disappeared on interactive roster (by CSS selector / data-testid)
          valueDeltas from the value snapshot
          navigation if beforeUrl !== afterUrl

No UIA and no CDP:
  rich: { diffSource:"none", diffDegraded:"chromium_sparse" }
  → clear signal to LLM to fall back to screenshot(diffMode=true)
```

---

## 5. Token-reduction estimate

Costs use the same per-call estimates as the main plan:
`screenshot(detail='meta')`=400, `screenshot(detail='text')`=1500, `screenshot(diffMode=true)`=300, `get_context` today=80, `get_context` v2=130, `post` minimal=~30, `post.rich` typical=~100–180.

### 5.1 Single act/verify — UIA-native app

| Step | Today | After combined sprint |
|---|---|---|
| Orient | `screenshot(detail='meta')` 400 | `get_context()` 130 |
| Coords | `screenshot(detail='text')` 1500 | `screenshot(detail='text')` 1500 (first time only) |
| Act + verify | `click_element` 30 + `screenshot(diffMode)` 300 | `click_element(..., narrate:"rich")` 210 |
| **Total** | **2230** | **1840** — (−17%) |

For the **Nth action** in the same window (warm UIA cache, no re-orient):

| | Today | After |
|---|---|---|
| Act + verify | `click_element` 30 + `screenshot(diffMode)` 300 = 330 | `click_element(..., narrate:"rich")` 210 |
| | **330/action** | **210/action** — (−36%) |

### 5.2 "Did my text land in the right field?" — most common verification pattern

| Step | Today | After |
|---|---|---|
| Act | `set_element_value` 30 | `set_element_value` 30 |
| Verify | `screenshot(detail='text')` 1500 (read the field back) | `get_context()` 130 — reads `focusedElement.value` |
| **Total** | **1530** | **160** — (−90%) |

### 5.3 Teams — post a message (Chromium, CDP diff)

| Step | Today | After |
|---|---|---|
| Orient | `screenshot(detail='meta')` 400 | `get_context()` 110 |
| Find compose | `screenshot(dotByDot,grayscale,region)` ~1200 | same, once |
| Type | `keyboard_type` 30 | `keyboard_type(..., narrate:"rich")` 100 |
| Send | `keyboard_press("Enter")` 30 | `keyboard_press("Enter", narrate:"rich")` 90 |
| Verify sent | `screenshot(diffMode)` 300 | (none — `rich.appeared` shows new message row) |
| **Total** | **~1960** | **~1530** — (−22%) |

### 5.4 Windows form — 3 fields + submit (UIA-native)

| Step | Today | After |
|---|---|---|
| Orient | `screenshot(detail='meta')` 400 | `get_context()` 130 |
| Get actionables | `screenshot(detail='text')` 1500 | `screenshot(detail='text')` 1500 |
| Field 1 | 30 + 300 = 330 | `set_element_value(..., narrate:"rich")` 70 |
| Field 2 | 330 | 70 |
| Field 3 | 330 | 70 |
| Submit | 30 + 300 = 330 | `click_element(..., narrate:"rich")` 180 |
| **Total** | **3220** | **2020** — (−37%) |

### 5.5 Summary

| Pattern | Today | After | Reduction |
|---|---|---|---|
| Single action, same window (Nth) | ~330/action | ~210/action | −36% |
| "Did text land in field?" | ~1530 | ~160 | **−90%** |
| Teams message | ~1960 | ~1530 | −22% |
| Multi-field form | ~3220 | ~2020 | −37% |

---

## 6. Test plan — reuse existing E2E harness

The repo already has targeted E2E suites (`tests/e2e/terminal.e2e.ts`, `tests/e2e/browser-search.e2e.ts`, `tests/e2e/wait-until.e2e.ts` per commit `c3f95f5`). The combined sprint adds two files in the same style:

### 6.1 `tests/e2e/context.e2e.ts`

- Launch Notepad, focus edit area, type a value; assert `get_context().focusedElement.value` matches.
- Move cursor over a button in Calculator; assert `get_context().cursorOverElement.name` is the button label.
- Launch Chrome with a known page; assert `hints.chromiumGuard === true`, `cursorOverElement === null`, `focusedElementSource` is `"uia"` or `"cdp"`.
- Simulate UIA timeout; assert `hints.uiaStale === true` and UIA fields are null (not thrown).

### 6.2 `tests/e2e/rich-narration.e2e.ts`

- `set_element_value(..., narrate:"rich")` on Notepad's edit; assert `post.rich.valueDeltas[0].after` is the new value.
- `click_element(..., narrate:"rich")` that opens a confirm dialog; assert `post.rich.appeared` contains the dialog.
- `browser_navigate(..., narrate:"rich")` to a new URL; assert `post.rich.navigation.fromUrl !== .toUrl`, `diffSource === "cdp"`.
- `click_element` on Chromium with CDP disconnected; assert `diffSource === "none"`, `diffDegraded === "chromium_sparse"`.
- `keyboard_press("a", narrate:"rich")` — assert `post.rich` is absent (trivial-key downgrade).

### 6.3 Unit tests — `tests/unit/uia-diff.test.ts`

Pure-function tests on `computeUiaDiff`:

- Appeared/disappeared detection on synthetic before/after element sets.
- Value-delta detection keyed by `automationId`.
- Size cap enforcement + `truncated` counters.
- Empty-name elements filtered out.
- No mutation of the input snapshots.

---

## 7. Consistency with the main plan

- Progress table row for **3.1** becomes "✅ Done (extended — see 3.x supplement)" once this sprint lands.
- Progress table row for **3.2** moves from "⬜ Not started — defer until usage data justifies UIA-diff cost" to "✅ Done (opt-in, narrate:'rich')". The deferral concern is resolved structurally: cost is zero by default; non-zero only when the caller opts in.
- All field names, cost targets, and `hints` schemas remain compatible with existing main-plan diagrams (§3.2 and §3.3).
- Phase 4 (intent composites) remains out of scope.
- No breaking changes: `cursorOverWindow` preserved; `post.focusedElement` changes from always-`null` to `T | null`, which is type-compatible with the declared type.
