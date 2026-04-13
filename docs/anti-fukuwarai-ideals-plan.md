# Beyond Fukuwarai — Implementation Plan

> 2026-04-13 — Implementation plan born from a conversation with Claude Sonnet 4.6
> Related: [`anti-fukuwarai-ideals.md`](./anti-fukuwarai-ideals.md) (verbalized ideals)

---

## Context

`docs/anti-fukuwarai-ideals.md` defines 7 ideals for "an MCP that lets LLMs think while operating." The current `desktop-touch-mcp` is strong at coordinate-based operations, but has a fundamental problem: **state changes are never described in semantic terms — only raw results are returned, with no context about what changed or why.**

Confirmed facts from codebase analysis:

- All 32 tools have zod input schemas, but **output schema is only a generic `{content:[...]}` envelope** (`src/tools/_types.ts:7-10`)
- `click_element` returns only `{"ok":true,"element":"<Name>"}` and **says nothing about post-action state changes** (`src/engine/uia-bridge.ts:156-203`)
- All handlers produce terminal error strings: `"<tool> failed: ${err}"` (e.g., `src/tools/ui-elements.ts:66`)
- OCR / UIA results have **zero confidence scores**
- UIA cache API `updateUiaCache` / `getCachedUia` is implemented at `src/engine/layer-buffer.ts:296-307` but **never called**
- 200ms polling logic is **copy-pasted in 3 places**: `src/tools/browser.ts:664-679` / `src/tools/workspace.ts:204-228` / `src/tools/dock.ts:314-344`
- Zero output-shape tests at MCP level → safe to change shapes

This plan bridges the 7 ideals to implementation across Phase 0–3. Phase 4 (intent-based composite operations: `fill_form` / `navigate_to`) will be re-evaluated after Phase 3 has been used in production and planned separately.

---

## Guiding Principle

> **The LLM must never have to guess what happened. Each MCP response is a diff of the world.**

The 7 ideals are facets of this principle:

| Ideal | Contribution to the principle |
|---|---|
| 1 State as explicit output | Returns "commit + diff" |
| 2 why/state | "Reason the commit succeeded or failed" |
| 3 Lightweight context | "Cheap re-sync of the world model" |
| 4 Confidence | "Certainty of observation" |
| 5 Intent operations | "Composite commit" |
| 6 Failure explanation | "Failure + recovery path" |
| 7 UIA cache | "Memoized world model" |

The goal is for the LLM's internal model to stay accurate without spending re-observation tokens.

---

## Agreed Design Decisions

| Decision | Choice |
|---|---|
| Scope | **All of Phase 0–3** (Phase 4 decided later) |
| narration default | **Always ON for all action tools** (not opt-in — a minimal ~30-token `post` is always returned) |
| Backward compatibility | **Shape changes are free.** LLM instruction text (`src/index.ts:21-167`) is updated in sync |
| P0 priority order | **Constructive errors → UIA cache activation → wait_until + pollUntil** |

---

## Phase 0 — Scaffolding

### 0.1 Introduce Output Envelope Types
**Why**: Establish the type foundation before attaching narration / structured errors / confidence. Prevents drift.
**How**:
- Add `ToolSuccess<T>` / `ToolFailure` discriminated union to `src/tools/_types.ts`
- Place shared helpers `ok(payload)` / `fail(error)` in the same file
- Replace all handler `return { content: [{ type:"text", text: JSON.stringify(...) }] }` with `ok(...)` / `fail(...)` calls
- All Phase 1+ additions (post, hints, suggest) flow through these helpers

### 0.2 Consolidate `pollUntil`
**Why**: Eliminate 3 copy-pasted polling blocks and establish the foundation for the `wait_until` tool at the same time.
**Where**: New `src/engine/poll.ts`; replace `browser.ts:664` / `workspace.ts:204` / `dock.ts:314`
**Shape**:
```ts
pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { intervalMs: number; timeoutMs: number; onTick?: (elapsed: number) => void }
): Promise<{ ok: true; value: T; elapsedMs: number } | { ok: false; timeout: true; elapsedMs: number }>
```

---

## Phase 1 — P0 (Highest Priority, Immediate Impact)

### 1.1 Constructive Error Wrapper (Ideal 6)
**Why**: The current `"X failed: Error: ..."` carries no hint for the next move. Provide information the LLM can learn from.
**How**:
- New `src/tools/_errors.ts`. `ToolError { code, message, suggest?: string[], context?: object }`
- Wire suggestions into common failure patterns:
  - `WindowNotFound` → `["Run get_windows to see available titles", "Try partial title match"]`
  - `ElementNotFound` → `["Call get_ui_elements for candidate names", "Use screenshot(detail='text') for actionable[]"]`
  - `InvokePatternNotSupported` → `["Use mouse_click with clickAt coords", "Use set_element_value for text inputs"]`
  - `UiaTimeout` → `["Retry with cached=true", "Try screenshot(detail='image') for visual fallback"]`
- Replace all handler catch blocks with `failWith(err)` → auto-normalizes to ToolError
- Integrate with the failsafe wrapper at `src/index.ts:175-185`

### 1.2 Cache / Baseline Age and Validity Transparency (Ideals 2 + 7)
**Why**: The current `desktop-touch-mcp` has 3 kinds of time-expiring state that are **completely invisible to the LLM**. In practice, LLMs have expressed uncertainty about "not knowing when the diffMode I-frame (baseline) expires."
- `layer-buffer.ts:60` `LAYER_TTL_MS = 90_000` (diff baseline, 90s TTL)
- `layer-buffer.ts:296-307` UIA cache (implemented but unwired)
- `window-cache.ts:36` HWND layout cache (60s TTL)

Furthermore, `workspace.ts:102` calls `clearLayers()` unconditionally on `workspace_snapshot`, making **invalidation events opaque too**. The current `src/index.ts:26` description is a single line — no TTL, no invalidation conditions.

#### 1.2.a UIA Cache Activation
- Add `cached?: boolean` option to `src/engine/uia-bridge.ts:275 getUiElements`
- When `cached=true`, read `getCachedUia(hwnd)` first; on hit, skip PowerShell restart and return delta: `"Changed: display value '0' → '29,232'"`
- Propagate the parameter through `get_ui_elements` / `click_element` / `screenshot(detail='text')`
- Wire `updateUiaCache` to be called on every successful UIA fetch

#### 1.2.b Identity Preservation (HWND Reuse / App Restart Guard)
**Why**: Caches break not just with time but with "identity." Typical cases:
1. LLM is operating Calculator; user closes it in the background → HWND vanishes
2. User restarts Calculator → same title but different HWND / different pid
3. LLM thinks it is the same Calculator and continues → missing baseline causes confusion, or wrong instance is operated via title-only match

**How**:
- Extend cache entry key from `hwnd` to compound key `{hwnd, pid, processStartTimeMs}`
  - `pid` / `processStartTimeMs` retrieved via Win32 `GetWindowThreadProcessId` + `GetProcessTimes`
- Extend `window-cache.ts:46-49` invalidation logic:
  - HWND no longer in enum → `hwnd_vanished`
  - Same HWND but different pid → `hwnd_reused` (warning level)
  - Same title / same pid but different processStartTimeMs → `process_restarted`
- On title resolution, compare "latest matching candidate" against "previously held identity"; report mismatch via hints

#### 1.2.c Unified Cache State Hints Exposure
Add common fields to the `hints` of screenshot / get_ui_elements / click_element responses:
```ts
hints.target: {                          // identity of the current operation target
  hwnd: number,
  pid: number,
  processName: string,
  processStartTimeMs: number,
  titleResolved: string                  // actual title resolved by partial match
},
hints.caches: {
  diffBaseline?: {
    exists: boolean,
    ageMs?: number,
    expiresInMs?: number,
    degradedToFull?: boolean,
    invalidatedBy?: "ttl" | "workspace_snapshot" | "manual_clear"
                  | "hwnd_vanished" | "hwnd_reused" | "process_restarted" | null,
    previousTarget?: { pid: number; processName: string }  // old identity when it changed
  },
  uiaCache?: { exists: boolean; ageMs?: number; expiresInMs?: number },
  windowLayout?: { ageMs: number; expiresInMs: number }
}
```
→ The LLM can fully verbalize "which app instance this diff came from, and at what point in time."

#### 1.2.d LLM Instruction Text Update
Add to `src/index.ts:21-167`:
- diff baseline has a **90s TTL**, auto-cleared on `workspace_snapshot`
- UIA cache has a **90s TTL**
- Current age / expiry is available from `hints.caches` in each tool response
- If uncertain, check `hints.caches.diffBaseline.exists === false` to confirm "this response is a full snapshot"
- If `hints.target` pid / processStartTimeMs changed since the last response, **the app was restarted** — prior operation history is invalid
- If `invalidatedBy: "hwnd_reused"` appears, HWND was reused — **immediately call get_windows to re-verify**

### 1.3 `wait_until` Tool (Ideal 5a)
**Why**: Currently, the LLM can only wait for "page load complete" or "value changed" by looping screenshots. `macro.ts:116` has only `sleep` for waiting.
**Shape**:
```ts
wait_until({
  condition: "window_appears" | "window_disappears" | "focus_changes" | "value_changes" | "element_appears" | "ready_state",
  target: { windowTitle?: string; elementName?: string; elementSelector?: string },
  timeoutMs?: number,  // default 5000, max 30000
  intervalMs?: number  // default 200
})
→ ok({ elapsedMs, observed: "<what changed>" }) | fail({ code:"WaitTimeout", last:<last observed state> })
```
- Implementation is a thin wrapper over Phase 0.2's `pollUntil`
- Register in `TOOL_REGISTRY` (`src/tools/macro.ts:35-59`) → usable inside `run_macro`

---

## Phase 1 Diagrams

### Overview — Layer Structure for Phase 0–1

```
┌────────────────────────────────────────────────────────────┐
│                        LLM (Claude)                         │
│                                                             │
│   Receives structured responses:                            │
│   - post (state after operation)                            │
│   - hints (cache age, identity, invalidation reason)        │
│   - suggest (next step on failure)                          │
└─────────────────────────┬──────────────────────────────────┘
                          ▲
                          │ JSON-RPC
                          │
┌─────────────────────────┴──────────────────────────────────┐
│                   MCP Handler Layer                         │
│                                                             │
│   ┌────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│   │  ok/fail   │  │  ToolError   │  │   wait_until     │   │
│   │  envelope  │  │  + suggest   │  │   (added in 1.3) │   │
│   │   (0.1)    │  │    (1.1)     │  │                  │   │
│   └────────────┘  └──────────────┘  └────────┬─────────┘   │
└──────────────────────────────────────────────┼─────────────┘
                                               │ uses
┌──────────────────────────────────────────────┴─────────────┐
│                    Engine Layer                             │
│                                                             │
│   ┌────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│   │ pollUntil  │  │   layer-buffer   │  │  identity     │  │
│   │   (0.2)    │  │  + cache hints   │  │  tracker      │  │
│   │            │  │  (1.2.a, 1.2.c)  │  │  (1.2.b)      │  │
│   │ Consolidates│  │                  │  │ {hwnd, pid,   │  │
│   │ 3 copy-    │  │  TTL + identity  │  │  startTime}   │  │
│   │ pasted     │  │  checks          │  │               │  │
│   └────────────┘  └──────────────────┘  └───────────────┘  │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
              Windows UIA  /  CDP  /  Win32 API
```

---

### 1.1 Constructive Errors — Before / After

**Before (fukuwarai)** — fails silently, no hint for next move:

```
  LLM: click_element(windowTitle="Calculator", name="Save")
        │
        ▼
  MCP: ❌ "click_element failed: Error: ElementNotFound"
        │
        ▼
  LLM: "No Save button...? Take another screenshot?
        Try a different name? Wrong window entirely?"
        \(´・ω・`)/
```

**After (constructive)** — failed commit + recovery path:

```
  LLM: click_element(windowTitle="Calculator", name="Save")
        │
        ▼
  MCP: ❌ {
         code: "ElementNotFound",
         message: "No element named 'Save' in Calculator",
         suggest: [
           "Call get_ui_elements for candidate names",
           "Use screenshot(detail='text') for actionable[]",
           "Try partial match (e.g. 'Sa' or 'ave')"
         ],
         context: { windowTitle: "Calculator", attempted: "Save" }
       }
        │
        ▼
  LLM: "Let me call get_ui_elements to see candidates." (・ω・)ノ
```

---

### 1.2 Cache and Identity Visibility

#### Timeline — Time-Based Expiry (TTL)

```
  t=0s          t=30s         t=90s          t=120s
   │             │              │               │
   │  Calculator  │  Operation 1 │  (TTL expire) │  Operation 2
   │  launched   │  diffMode    │               │  diffMode
   │  baseline   │              │               │
   │  created    │              │               │
   ▼             ▼              ▼               ▼
 ┌────┐       ┌────┐         ┌────┐          ┌────┐
 │base│       │diff│         │XXXX│          │full│
 │line│       │ OK │         │gone│          │back│
 └────┘       └────┘         └────┘          └────┘

 hints.caches.diffBaseline:
 ┌────────────────────────────────────────────────────────┐
 │ t=0s:   {exists:true, ageMs:0,     expiresIn:90000}    │
 │ t=30s:  {exists:true, ageMs:30000, expiresIn:60000}    │
 │ t=90s:  {exists:false, invalidatedBy:"ttl"}            │
 │ t=120s: {exists:true, ageMs:0, degradedToFull:true,    │
 │          invalidatedBy:"ttl"}  ← retains last reason   │
 └────────────────────────────────────────────────────────┘
```

The LLM can always know "how many seconds until expiry" from `ageMs` and `expiresIn`.
Even after expiry, `invalidatedBy` explains why it expired.

---

#### Sequence — Identity Expiry (App Restart)

```
  LLM                  MCP                      Windows
   │                    │                         │
   │  workspace_launch  │                         │
   │──────────────────>│  CreateProcess           │
   │                    │────────────────────────>│
   │                    │                         │ ┌─ Calculator ─┐
   │                    │  HWND=0x1234            │ │ pid          │
   │                    │  pid=5678               │ │ 5678         │
   │                    │  startTime=10000        │ │ start        │
   │                    │<────────────────────────│ │ 10000        │
   │  target:{0x1234,   │                         │ └─────────────┘
   │    5678, 10000}    │                         │
   │<──────────────────│                         │
   │                    │                         │
   │  click_element "5" │                         │
   │──────────────────>│────────────────────────>│ [5] clicked
   │                    │                         │ baseline saved
   │                    │                         │
   │                    ··· user operates behind ···
   │                    │                         │ ┌─ Calculator × ─┐
   │                    │                         │ │ closed         │
   │                    │                         │ └────────────────┘
   │                    │                         │ ┌─ Calculator ───┐
   │                    │                         │ │ pid            │
   │                    │                         │ │ 9999           │ (new)
   │                    │                         │ │ start          │
   │                    │                         │ │ 20000          │
   │                    │                         │ └────────────────┘
   │                    │                         │
   │  screenshot        │                         │
   │  (diffMode=true)   │                         │
   │──────────────────>│  EnumWindows + identity │
   │                    │────────────────────────>│
   │                    │  HWND=0x???, pid=9999  │
   │                    │<────────────────────────│
   │                    │                         │
   │                    │  identity compare:       │
   │                    │  old pid=5678 ≠ new 9999│
   │                    │  → "process_restarted"  │
   │                    │                         │
   │<──────────────────│                         │
   │  hints.target.pid=9999                       │
   │  hints.caches.diffBaseline: {                │
   │    exists: false,                            │
   │    invalidatedBy: "process_restarted",       │
   │    previousTarget: {                         │
   │      pid: 5678, processName: "CalculatorApp" │
   │    }                                         │
   │  }                                           │
   │                    │                         │
   │  LLM: "Reset assumptions — prior history is invalid"
```

#### Invalidation Reason Classification

```
  ┌──────────────────────────┬────────────────────────────────────┐
  │ invalidatedBy            │ Cause                              │
  ├──────────────────────────┼────────────────────────────────────┤
  │ "ttl"                    │ 90 seconds elapsed                 │
  │ "workspace_snapshot"     │ workspace_snapshot was called      │
  │ "manual_clear"           │ explicit clearLayers()             │
  │ "hwnd_vanished"          │ HWND absent from EnumWindows       │
  │ "hwnd_reused"            │ same HWND but different pid (risk) │
  │ "process_restarted"      │ same title but different pid       │
  └──────────────────────────┴────────────────────────────────────┘
```

---

### 1.3 wait_until — Move the Polling Loop to the Server

**Before** — LLM self-polls with screenshots:

```
  LLM                              MCP
   │                                │
   │  workspace_launch("Calculator") │
   │───────────────────────────────>│
   │                                │──┐
   │<───────────────────────────────│  │ launching async
   │  {launched:true, pid:...}      │  │
   │                                │  │
   │  screenshot() — ready yet?     │  │
   │───────────────────────────────>│  │
   │<───────────────────────────────│  │  ~500 tokens
   │  not yet                       │  │
   │                                │  │
   │  screenshot() — ready yet?     │  │
   │───────────────────────────────>│<─┘ Calculator appeared
   │<───────────────────────────────│
   │  not yet                       │     ~500 tokens
   │                                │
   │  screenshot() — ready yet?     │
   │───────────────────────────────>│
   │<───────────────────────────────│     ~500 tokens
   │  there it is!                  │
   │                                │
  Total: 3–5 calls, ~1500–2500 tokens wasted
```

**After** — wait_until: server answers in one call:

```
  LLM                              MCP (pollUntil)
   │                                │
   │  workspace_launch("Calculator") │
   │───────────────────────────────>│
   │<───────────────────────────────│
   │                                │
   │  wait_until({                  │
   │    condition:"window_appears", │
   │    target:{windowTitle:        │
   │      "Calculator"},            │
   │    timeoutMs: 5000             │
   │  })                            │
   │───────────────────────────────>│──┐
   │                                │  │ 200ms polling
   │                                │  │ EnumWindows x N
   │                                │  │
   │                                │<─┘ Calculator appeared (820ms)
   │<───────────────────────────────│
   │  ok({                          │
   │    elapsedMs: 820,             │
   │    observed: {                 │
   │      windowTitle: "Calculator",│
   │      hwnd: 0x1234,             │
   │      pid: 5678                 │
   │    }                           │
   │  })                            │
   │                                │
  Total: 1 call, ~100 tokens
```

---

### What the LLM Sees After Phase 1 (Response Cross-Section)

Example response for `click_element("Calculator", "5")`:

```
┌─────────────────────────────────────────────────────┐
│  ok({                                                │
│    element: "5",                                     │
│    reason: "matched Name='5'",          ← Ideal 2    │
│                                                      │
│    post: {                               ← Ideal 1   │
│      focusedWindow: "Calculator",                    │
│      focusedElement: "display",                      │
│      windowChanged: false,                           │
│      elapsedMs: 42                                   │
│    },                                                │
│                                                      │
│    hints: {                                          │
│      target: {                           ← identity  │
│        hwnd: 0x1234,                                 │
│        pid: 5678,                                    │
│        processName: "CalculatorApp",                 │
│        processStartTimeMs: 10000,                    │
│        titleResolved: "Calculator"                   │
│      },                                              │
│      caches: {                           ← time      │
│        diffBaseline: {                               │
│          exists: true,                               │
│          ageMs: 3200,                                │
│          expiresInMs: 86800                          │
│        },                                            │
│        uiaCache: {                                   │
│          exists: true,                               │
│          ageMs: 1100,                                │
│          expiresInMs: 88900                          │
│        }                                             │
│      }                                               │
│    }                                                 │
│  })                                                  │
└─────────────────────────────────────────────────────┘
```

What the LLM can grasp at a glance:
- **What was clicked** (element, reason)
- **Where it is now** (post.focusedWindow / Element)
- **Whether it is touching the same Calculator instance** (hints.target.pid + startTime)
- **Whether the diff is valid, and how many seconds until expiry** (hints.caches.diffBaseline)

Before:
- Click coordinates `(1182, 141)`, result unknown → confirm with screenshot

After Phase 1:
- Semantic operation + world state + verifiable cache freshness → **next move decided without a screenshot**

---

## Phase 2 — Verbalization Layer

### 2.1 Minimal Post-State Narration (Ideal 1, Always ON)
**Why**: The core fix for the fukuwarai feeling. Adding ~30 tokens to all action tools lets the LLM skip screenshot confirmations.
**Shape** — `post` appended to all action tool responses:
```ts
post: {
  focusedWindow: string | null,
  focusedElement: string | null,       // UIA Name or selector
  windowChanged: boolean,               // diff from previous foreground HWND
  elapsedMs: number
}
```
**Where**: Implement `withPostState(handler)` in new `src/tools/_post.ts` → apply to:
- `click_element`, `set_element_value` (`src/tools/ui-elements.ts`)
- `keyboard_press`, `keyboard_type` (`src/tools/keyboard.ts`)
- `mouse_click`, `mouse_drag` (`src/tools/mouse.ts`)
- `browser_click_element`, `browser_navigate`, `browser_eval` (`src/tools/browser.ts`)

Excluded: `mouse_move` / `scroll` / `get_cursor_position` (non-state-transitioning).
**Implementation note**: Fetch focused element lightly — `getActiveWindow` + single UIA focused element fetch (no descendant enumeration).

### 2.2 why / state Hints Extension (Ideal 2)
**Where**: `src/tools/screenshot.ts:428-442` hints assembly and `uia-bridge.ts` actionable generation
**How**:
- Add `state: "enabled" | "disabled" | "toggled" | "readonly"` to each actionable (reflecting UIA `IsEnabled` / `TogglePattern.ToggleState`)
- Include `reason: "matched automationId='multiplyButton'"` in successful `click_element` / `set_element_value` responses (match rationale)
- Pre-detect disabled element operations and return `fail({ code:"ElementDisabled", suggest:["Wait for enable via wait_until(value_changes)"] })`

### 2.3 OCR Confidence Exposure (Ideal 4a)
**Where**: `src/engine/ocr-bridge.ts` → capture Windows OCR API `OcrLine.Confidence`
**How**:
- Add `confidence: 0..1` to `source:"ocr"` items in `actionable[]`
- Add `hints.lowConfidenceCount` to screenshot responses
- Automatically add `suggest:"Use dotByDot screenshot or browser_eval for verification"` to items with `confidence < 0.5`

---

## Phase 2 Diagrams

### 2.1 post Narration Scope — Which Tools Get Always-ON

```
  ┌──────────────────────────────────────────────────────────┐
  │  Covered (state-transitioning tools)  ← ~30 token post   │
  ├──────────────────────────────────────────────────────────┤
  │   click_element            set_element_value              │
  │   keyboard_type            keyboard_press                 │
  │   mouse_click              mouse_drag                     │
  │   browser_click_element    browser_navigate               │
  │   browser_eval                                            │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │  Excluded (observation / non-transitioning tools)        │
  ├──────────────────────────────────────────────────────────┤
  │   mouse_move              scroll                          │
  │   get_cursor_position     screenshot                      │
  │   get_windows             get_ui_elements                 │
  └──────────────────────────────────────────────────────────┘
```

---

### 2.1 Response Before / After — click_element Example

```
  Before (~10 tokens)               After (~40 tokens)
  ┌──────────────────┐              ┌──────────────────────────────┐
  │ ok({             │              │ ok({                          │
  │   element: "5"   │              │   element: "5",               │
  │ })               │              │   reason: "matched Name='5'", │
  └──────────────────┘              │   post: {                     │
                                    │     focusedWindow: "Calculator"│
  LLM: "Clicked. But               │     focusedElement: "display",│
        did it really               │     windowChanged: false,     │
        work?"                      │     elapsedMs: 42             │
            │                       │   }                           │
            ▼                       │ })                            │
   screenshot(diffMode=true)       └──────────────────────────────┘
   to verify (~500 tokens)                  │
                                             ▼
                                  LLM: "Focus still on Calculator,
                                        value entered in display.
                                        Proceeding."
                                        (no screenshot needed)
```

**Net effect**: +30 token post eliminates a ~500-token screenshot confirmation.

---

### 2.2 State-Based Pre-Check (Ideal 2)

```
  Flow when click_element("Submit") is called
  ─────────────────────────────────────────────

                click_element("Submit")
                      │
                      ▼
              Fetch element via UIA
                      │
                      ▼
            ┌── state check ──┐
            │                 │
   ┌────────┴─────┬──────────┴───┬────────────┐
   ▼              ▼              ▼            ▼
 enabled       disabled      toggled      readonly
   │              │              │            │
   ▼              ▼              ▼            ▼
 Invoke      fail({        Invoke +      fail({
 proceed     code:         reason:       code:
             "Element      "ToggleState  "ReadOnly",
             Disabled",    was Off"      suggest:[
             suggest: [                   "Try set_
               "Wait via                  element_
               wait_until                value"
               (value_                   ]
               changes)"                 })
             ]})
```

Previously, clicking a disabled button would silently no-op while reporting success — the LLM would enter an unexplained retry loop.

---

### 2.3 OCR Confidence — Auto suggest for Low-Confidence Items

```
  screenshot(detail='text') on Paint
  ────────────────────────────────────

       UIA returns 0 elements (WinUI3)
                  │
                  ▼
       Windows OCR fallback fires
                  │
                  ▼
  ┌───────────────────────────────────────────────────────┐
  │  actionable: [                                         │
  │    {                                                   │
  │      text: "File",                                     │
  │      confidence: 0.95,  ← from OcrLine.Confidence      │
  │      source: "ocr",     ★★★★★                         │
  │      clickAt: {x:23, y:15}                             │
  │    },                                                  │
  │    {                                                   │
  │      text: "Edit",                                     │
  │      confidence: 0.88,                                 │
  │      source: "ocr",     ★★★★                          │
  │    },                                                  │
  │    {                                                   │
  │      text: "Hョ「5",     ← garbled                     │
  │      confidence: 0.23,                                 │
  │      source: "ocr",     ★                             │
  │      suggest: "Use dotByDot screenshot or              │
  │                browser_eval for verification"          │
  │    }                                                   │
  │  ],                                                    │
  │  hints: {                                              │
  │    lowConfidenceCount: 1,                              │
  │    ocrFallbackFired: true                              │
  │  }                                                     │
  └───────────────────────────────────────────────────────┘
                  │
                  ▼
  LLM: "Item 3 is suspect — re-confirm with dotByDot before clicking"
```

---

## Phase 3 — Context API and Opt-in Extensions

### 3.1 Context Retrieval Tool Suite (Ideal 3)

**Design decision**: "Current state" spans different observation levels (OS / app / document / behavior history), so it is split into **3 tools** rather than packed into one. The LLM selects based on need.

#### 3.1.a `get_context()` — OS + App Level (Lightweight)
```ts
get_context() → ok({
  // OS level
  focusedWindow: { title: string; processName: string; hwnd: number } | null,
  cursorPos: { x: number; y: number },
  cursorOverElement: { name: string; type: string } | null,  // UIA ElementFromPoint

  // App level
  focusedElement: { name: string; type: string; value?: string } | null,  // UIA FocusedElement
  hasModal: boolean,
  pageState: "ready" | "loading" | "dialog" | "error"
})
```
- Richer semantic info than `screenshot(detail='meta')`, orders of magnitude cheaper than `detail='text'`
- UIA called lightly (no descendant enumeration, single focused element)
- **Where**: New `src/tools/context.ts`

#### 3.1.b `get_history(n?)` — Action History
```ts
get_history({ n?: number = 5 }) → ok({
  actions: Array<{
    tool: string,
    argsDigest: string,       // key points only (full args omitted)
    post: PostState,          // post from Phase 2.1
    elapsedMs: number,
    tsMs: number
  }>
})
```
- Recent N actions with their post states. Lets the LLM reconstruct "what was I in the middle of doing"
- Ring buffer co-located in `_post.ts`, updated as a side effect of `withPostState`
- Volatile for MCP session lifetime (not persisted)

#### 3.1.c `get_document_state()` — Document Level (Chrome)
```ts
get_document_state({ port?, tabId? }) → ok({
  url: string,
  title: string,
  readyState: "loading" | "interactive" | "complete",
  selection?: string,         // window.getSelection().toString()
  scroll: { x: number; y: number; maxY: number }
})
```
- Via CDP. Packed into a single `browser_eval` script evaluation.
- For understanding context while editing in a browser.

### 3.2 Rich Narration (Ideal 1 opt-in)
**Trigger**: `narrate: "rich"` flag on any action tool
**Payload**: In addition to `post`:
```ts
post.rich: {
  appeared: Array<{ name: string; type: string }>,    // newly appeared actionables
  disappeared: Array<{ name: string }>,
  valueDeltas: Array<{ name: string; before: string; after: string }>,
  navigation?: { fromUrl: string; toUrl: string }
}
```
**Cost**: UIA diff fetched only when triggered (same logic as `layer-buffer` diff). For use when the LLM wants a full view without a confirmation screenshot.

### 3.3 UIA Confidence Synthesis (Ideal 4b)
**Where**: `actionable[]` generation in `uia-bridge.ts`
**How**: Compute synthetic confidence from match method:
- `automationId` exact match → 1.0
- `Name` exact match → 0.95
- `Name` substring match → 0.7
- `Name` fuzzy match → 0.5

Give `source:"uia"` items a unified `confidence` field, enabling cross-comparison with OCR.

---

### 3.4 Async Event Subscribe (Inter-Turn State Delta Push)

**Design note**: MCP protocol supports server→client push via `notifications/*`. However, LLMs are turn-based and cannot react in real time. **What is practically useful is "injecting event deltas since the previous turn at the start of the next LLM turn."**

#### 3.4.a Server-Side Implementation
- New `src/engine/event-bus.ts`: detect the following events via ~500ms HWND enumeration polling:
  - `window_appeared` / `window_disappeared`
  - `foreground_changed`
  - `modal_opened` / `modal_closed`
- Push to client via MCP `notifications/message`

#### 3.4.b `events/subscribe`-Style Tools
```ts
events_subscribe({ types: string[] }) → ok({ subscriptionId })
events_poll({ subscriptionId, sinceMs?: number }) → ok({ events: [...] })
events_unsubscribe({ subscriptionId })
```
- **Polling fallback** for clients that do not handle MCP notifications
- If the client processes notifications: subscribe + push; otherwise: read via poll

#### 3.4.c Decision
- **Tackle last within Phase 3.** Evaluate the residual value of push after `get_context` / `get_history` cover "where am I now"
- **Skip macro mid-progress push (`notifications/progress`)**: `stop_on_error` suffices. Only valuable for long-running macros; demand is low at this time

---

## Phase 3 Diagrams

### 3.1 Observation Levels — Responsibility Split Across 3 Tools

When the LLM wants to know "where am I now", there are 4 observation levels. Split by responsibility rather than cramming into one tool.

```
  Observation Level    Tool                Key Response Fields
  ─────────────────────────────────────────────────────────────
  OS / Window        │ get_context()    │ focusedWindow
                     │                 │ cursorPos, cursorOverElement
  ───────────────────┼─────────────────┼──────────────────────────
  In-App             │ get_context()   │ focusedElement
                     │                 │ hasModal, pageState
  ───────────────────┼─────────────────┼──────────────────────────
  Document           │ get_document_   │ url, readyState
  (Chrome)           │ state()         │ selection, scroll
  ───────────────────┼─────────────────┼──────────────────────────
  Action History     │ get_history()   │ actions[].tool
                     │                 │ actions[].post
                     │                 │ actions[].elapsedMs
  ─────────────────────────────────────────────────────────────
```

**Cost**: `get_context()` uses no UIA descendant enumeration — single focused element only.
Under **1/10 the tokens** of `screenshot(detail='text')`.

```
  Approximate cost comparison:
  ┌──────────────────────────────────────────────────────────┐
  │ screenshot(detail='image')  ████████████████████ 4000tok │
  │ screenshot(detail='text')   ████████░░░░░░░░░░░░ 1500tok │
  │ screenshot(detail='meta')   ██░░░░░░░░░░░░░░░░░░  400tok │
  │ get_context()               █░░░░░░░░░░░░░░░░░░░  ~80tok │
  │ get_history(n=3)            █░░░░░░░░░░░░░░░░░░░  ~120tok│
  │ get_document_state()        █░░░░░░░░░░░░░░░░░░░  ~60tok │
  └──────────────────────────────────────────────────────────┘
```

---

### 3.2 Rich Narration — Full-View via Opt-in

Difference between the regular `post` (always ON, ~30 tok) and `post.rich` when `narrate:"rich"` is specified (opt-in, ~200 tok):

```
  click_element("Submit", narrate:"minimal")  ← normal (always ON)
  ┌──────────────────────────────────────┐
  │  post: {                             │  ~30 tokens
  │    focusedWindow: "Web Form",        │
  │    focusedElement: "Submit button",  │
  │    windowChanged: false,             │
  │    elapsedMs: 38                     │
  │  }                                   │
  └──────────────────────────────────────┘

  click_element("Submit", narrate:"rich")  ← opt-in
  ┌──────────────────────────────────────┐
  │  post: {                             │  ~200 tokens
  │    focusedWindow: "Web Form",        │
  │    focusedElement: "Thanks page h1", │
  │    windowChanged: false,             │
  │    elapsedMs: 312,                   │
  │    rich: {                           │
  │      appeared: [                     │  ← newly appeared UI
  │        { name:"Thanks!", type:"Text"}│
  │        { name:"Back", type:"Button"} │
  │      ],                              │
  │      disappeared: [                  │  ← removed UI
  │        { name:"Submit" },            │
  │        { name:"Name field" }         │
  │      ],                              │
  │      valueDeltas: [                  │  ← value changes
  │        { name:"progress",            │
  │          before:"0%", after:"100%"}  │
  │      ],                              │
  │      navigation: null                │  ← no page navigation
  │    }                                 │
  │  }                                   │
  └──────────────────────────────────────┘
```

**When to use**:
- `narrate:"minimal"` (default when omitted) — always ON. Understand operation result as substitute for screenshot
- `narrate:"rich"` — when full-view is needed without a confirmation screenshot (after form submit, after page navigation, etc.)

---

### 3.3 UIA Confidence Synthesis — Cross-Comparable with OCR

Phase 2.3 added `confidence` to OCR. UIA is aligned to the same axis.

```
  ┌────────────────────────────────────────────────────────────────┐
  │ Match Method                source  confidence  Stability      │
  ├────────────────────────────────────────────────────────────────┤
  │ automationId exact match    uia     1.00        ★★★★★         │
  │ Name exact match            uia     0.95        ★★★★☆         │
  │ Name substring match        uia     0.70        ★★★☆☆         │
  │ Name fuzzy match            uia     0.50        ★★☆☆☆         │
  ├────────────────────────────────────────────────────────────────┤
  │ OCR (high confidence)       ocr     0.85–1.0    ★★★★☆         │
  │ OCR (medium confidence)     ocr     0.50–0.85   ★★★☆☆         │
  │ OCR (low confidence)        ocr     < 0.50      ★☆☆☆☆         │
  │  → suggest: dotByDot screenshot / browser_eval               │
  └────────────────────────────────────────────────────────────────┘
```

With OCR and UIA on the same `confidence` scale, the LLM can quantitatively decide
"which to trust: UIA fuzzy (0.50) or OCR high-confidence (0.87)?"

```
  Example actionable[] received by LLM:
  [
    { name:"Multiply", source:"uia", confidence:1.00, clickAt:{x:...,y:...} },
    { name:"=",        source:"uia", confidence:0.95, clickAt:{x:...,y:...} },
    { name:"29,232",   source:"ocr", confidence:0.91, clickAt:{x:...,y:...} },
    { name:"Hョ...",   source:"ocr", confidence:0.23,           ← ★ low confidence
      suggest:"Use dotByDot screenshot or browser_eval" }
  ]
```

---

### 3.4 Inter-Turn Events — Before / After

The LLM operates turn-by-turn and cannot react to real-time pushes.
But injecting "what happened since the previous turn" at the turn boundary gives nearly equivalent information.

**Before (without Phase 3)** — events between turns never reach the LLM:

```
  Turn 1                Turn 2                Turn 3
  LLM                   LLM                   LLM
  │                     │                     │
  │ click_element("OK") │                     │ screenshot()
  │──────────>  MCP     │                     │──────────> MCP
  │ <──────────         │                     │ <──────────
  │ ok(...)             │                     │ (full view)
  │                     │
  │             ▲ user switched apps here
  │             │ a dialog appeared
  │             │ a window closed
  │             │ → LLM knows nothing
  │             │
                ∅ (nothing delivered)
```

**After (events_subscribe + events_poll)** — delta injected at turn start:

```
  Turn 1                           Turn 2
  LLM                  MCP (event-bus)        LLM
  │                     │                     │
  │ events_subscribe    │  500ms poll loop ─┐ │
  │ ({types:[           │  EnumWindows      │ │
  │   "window_appeared",│                   │ │
  │   "foreground_      │                   │ │
  │   changed"]})       │                   │ │
  │──────────────────>  │                   │ │
  │ <──────────────────  │                   │ │
  │ {subscriptionId:    │                   │ │
  │   "sub-001"}        │                   │ │
  │                     │  [foreground_changed] ← user switched
  │                     │  [modal_opened]    │ │
  │                     │  [window_appeared] ←┘ Notepad launched
  │                     │                     │
  │                     │                     │ At start of Turn 2:
  │                     │                     │ events_poll()
  │                     │                     │──────────────> MCP
  │                     │                     │ <──────────────
  │                     │                     │ ok({ events: [
  │                     │                     │   {type:"foreground_changed",
  │                     │                     │    from:"Calculator",to:"Chrome"},
  │                     │                     │   {type:"modal_opened",
  │                     │                     │    windowTitle:"Save As"},
  │                     │                     │   {type:"window_appeared",
  │                     │                     │    windowTitle:"Untitled - Notepad"}
  │                     │                     │ ]})
  │                     │                     │
  │                     │                     │ LLM: "3 events since last turn.
  │                     │                     │       A dialog is open."
  │                     │                     │ → reconsider next operation
```

**Push vs. Poll**:

```
  ┌─────────────────────────────────────────────────────────┐
  │ Clients supporting MCP notifications (Claude Desktop)   │
  │                                                         │
  │   event-bus ──notifications/message──> client           │
  │                                         ↓              │
  │                                  auto-injected at       │
  │                                  next turn start        │
  └─────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────┐
  │ Clients without notification support                    │
  │                                                         │
  │   LLM calls events_poll() at start of every turn        │
  │   → retrieves buffered event delta                      │
  │   → effectively the same information                    │
  └─────────────────────────────────────────────────────────┘
```

---

## Phase 4 — Intent-Based Composite Operations (Separate Plan)

Plan after observing real usage post-Phase 3. Candidates:
- `fill_form(window, fields)` — atomic composition of multiple `set_element_value` calls
- `navigate_to(window, url)` — sugar for `browser_navigate` + `wait_until(ready_state)`
- `workspace_scene` — named workspace (currently only single `DESKTOP_TOUCH_DOCK_TITLE`)
- `notifications/progress` push for macro mid-execution state

Once Phase 0–3 are in place, many intent operations can be composed by the LLM using `run_macro` + `wait_until`, so real-world usage will be observed before committing to a plan.

---

## Key Files to Modify

| File | Primary Change | Phase |
|---|---|---|
| `src/tools/_types.ts` | ToolSuccess / ToolFailure types, ok / fail helpers | 0 |
| `src/engine/poll.ts` (new) | pollUntil consolidation | 0 |
| `src/tools/browser.ts:664`, `workspace.ts:204`, `dock.ts:314` | Replace with pollUntil | 0 |
| `src/tools/_errors.ts` (new) | ToolError, failWith, suggest dictionary | 1 |
| `src/index.ts:175-185` | Integrate failsafe wrapper with ToolError | 1 |
| `src/engine/layer-buffer.ts:296-307` | Wire existing UIA cache API, add identity check | 1 |
| `src/engine/window-cache.ts:46-49` | Classify invalidation reason (vanished/reused/restarted) | 1 |
| `src/engine/uia-bridge.ts:275` | `cached?` option, delta response on cache hit | 1 |
| Win32 bridge (pid / processStartTimeMs) | Add function to derive identity from HWND | 1 |
| `src/tools/ui-elements.ts`, `keyboard.ts`, `mouse.ts`, `browser.ts` | Register wait_until, add post field | 1–2 |
| `src/tools/macro.ts:35-59` | Add wait_until to TOOL_REGISTRY | 1 |
| `src/tools/_post.ts` (new) | withPostState, ring buffer | 2 |
| `src/tools/screenshot.ts:428-442` | Extend hints with state, OCR confidence | 2 |
| `src/engine/ocr-bridge.ts` | Expose OcrLine.Confidence | 2 |
| `src/tools/context.ts` (new) | get_context / get_history / get_document_state handlers | 3 |
| `src/engine/uia-bridge.ts` | Synthetic confidence, diff for rich narration | 3 |
| `src/engine/event-bus.ts` (new) | HWND polling + notifications/message dispatch | 3 |
| `src/tools/events.ts` (new) | events_subscribe / events_poll handlers | 3 |
| `src/index.ts:21-167` | Update LLM instruction text to match new shapes | Each phase |

---

## Verification Plan

For each phase, run the following:

1. **Build**: `npm run build` (tsc) passes cleanly
2. **Existing E2E**: All 4 tests in `tests/e2e/` (`browser-cdp.test.ts` / `dock-auto.test.ts` / `dock-window.test.ts` / `process-tree.test.ts`) are green
3. **MCP hands-on verification** (using the desktop-touch MCP itself):
   - **Phase 0**: Run a `run_macro` scenario with a failing step → verify structured error returns in `ToolError` shape
   - **Phase 1 (1.1)**: `click_element` with non-existent window title → `code:"WindowNotFound"` + suggest array returned
   - **Phase 1 (1.2.a)**: `get_ui_elements(cached=false)` then `get_ui_elements(cached=true)` on Calculator → second call returns `hints.uiaCached:true` + delta response
   - **Phase 1 (1.2.b/c)**: Operate Calculator → confirm baseline held → close and restart Calculator → `screenshot(diffMode=true)` returns `invalidatedBy:"process_restarted"` and `previousTarget`. `hints.target.pid` is the new pid
   - **Phase 1 (1.2.c)**: `screenshot(diffMode=true)` after 90s wait → `invalidatedBy:"ttl"`. Immediately after `workspace_snapshot` → `invalidatedBy:"workspace_snapshot"`
   - **Phase 1 (1.3)**: Fire `wait_until({condition:"window_appears", target:{windowTitle:"Calculator"}})`, manually launch Calculator → observed contains Calculator window info
   - **Phase 2 (2.1)**: `click_element("5")` on Calculator → `post.focusedWindow:"Calculator"`, `post.focusedElement` updated
   - **Phase 2 (2.2)**: `click_element` on a disabled button → `ElementDisabled` error
   - **Phase 2 (2.3)**: Force OCR with low-resolution screenshot → low-confidence items have suggest
   - **Phase 3 (3.1.a)**: Call `get_context()` and compare token count to `screenshot(detail='meta')` (more semantic info, order of magnitude fewer tokens). Focused and cursor dimensions returned separately
   - **Phase 3 (3.1.b)**: After several operations, call `get_history(n=3)` → post list returned in chronological order
   - **Phase 3 (3.1.c)**: With Chrome connected via CDP, call `get_document_state()` → URL / readyState / selection returned
   - **Phase 3 (3.2)**: `click_element("Submit", narrate:"rich")` → `post.rich.valueDeltas` lists the changes
   - **Phase 3 (3.3)**: automationId match and fuzzy match produce different confidence values
   - **Phase 3 (3.4)**: `events_subscribe({types:["window_appeared"]})` → manually launch Notepad → `events_poll` returns appeared event
4. **New unit tests**: Add to `tests/unit/` for each phase (create vitest config if needed). Key tests:
   - `poll.test.ts` (Phase 0)
   - `errors.test.ts` — suggest dictionary mapping (Phase 1)
   - `post-narration.test.ts` (Phase 2)

---

## How to Proceed

1. Start with Phase 0.1 (output types) → 0.2 (pollUntil) to lay the foundation
2. Then Phase 1.1 → 1.2 → 1.3 to inject P0
3. Run MCP hands-on verification at each phase to confirm forward progress before moving on
4. Phase 3.4 (async push) is tackled last in Phase 3 — evaluate the practical value of push after the preceding elements are proven useful
