# LLM-First Auto Perception Plan

Date: 2026-04-17

This supersedes the earlier "auto lens policy parameter" idea. The direction was
right, but still exposed too much state management to the model.

## Core UX Decision

Do not add a new model-facing perception mode parameter.

The LLM should keep using the existing action tools:

```text
screenshot/detail text -> mouse_click
browser_get_interactive -> browser_click_element
keyboard_type(windowTitle)
click_element(windowTitle, name)
```

The server should make those actions guarded by default when enough target
evidence is already present.

`lensId` remains available, but it becomes an advanced/debug/pinned-target API.
Normal LLM behavior should not require it.

## Why This Is Simpler

LLMs use desktop tools in a few repeated patterns:

1. Visual discovery, then one click.
2. Click a field, then type.
3. Browser DOM/selector operation.
4. Native UIA named control operation.
5. Multi-app workflow where the active target changes.
6. Recovery after a failed click, focus steal, modal, or navigation.

The model already supplies enough target hints in these flows:

- `windowTitle`
- `selector`
- `tabId`
- `chromeTabUrlContains`
- `name` / `automationId`
- click coordinates plus screenshot/window cache

Asking the model to additionally call `perception_register`, remember a
`lensId`, pass it through later calls, and explicitly forget it is the wrong UX.
The reliable design is to use those existing target hints as the guard input.

## External Research Constraints

- MCP tools are model-controlled: models can discover and invoke tools
  automatically, but the protocol does not impose an interaction pattern. So
  safety that depends on a model choosing a separate setup tool is fragile.
- MCP resources are application-driven, so they are good for inspection and
  host integration, not primary behavior control.
- Anthropic tool guidance emphasizes detailed descriptions, consolidation, and
  high-signal responses. Adding more optional control parameters works against
  that unless the parameter is absolutely necessary.
- OpenAI function/tool guidance recommends strict schemas and clear tool
  definitions. It also shows that models use tools in a loop where tool outputs
  drive the next action. That favors compact, actionable post-action feedback.
- OpenAI and Anthropic computer-use docs both normalize a screenshot/action loop
  for GUI control. Trying to fight that loop is less practical than making the
  loop safer.
- Anthropic computer-use limitations explicitly call out coordinate mistakes and
  tool-selection mistakes. The guard layer should compensate for these classes
  of failures without relying on perfect model planning.
- UI Automation events can be noisy; native events should invalidate cached
  belief, while synchronous pre-action refresh should gate unsafe input.

## New Mental Model

Public model-facing idea:

```text
Use normal desktop-touch action tools. If you pass windowTitle, selector, tabId,
or coordinates from a recent observation, desktop-touch guards the action and
returns post.perception.
```

Internal implementation idea:

```text
ActionGuard = target inference + pre-action refresh + guard + action + post-check
```

Manual PerceptionLens remains:

```text
perception_register = pin a target for advanced long-running or diagnostic use.
```

## Architecture

Add a hidden `ActionGuard` layer below action tools and above low-level
mouse/keyboard/CDP/UIA execution.

```text
tool handler
  -> infer ActionTarget from existing args and recent observation cache
  -> pre-action synchronous refresh
  -> evaluate guard for this action kind
  -> execute action
  -> post-action lightweight check
  -> attach compact post.perception
```

This layer can reuse existing RPG sensors and guard logic, but it should not
force every automatic target into the long-lived lens registry.

## Three Target Lifetimes

### 1. Action-Scoped Target

Used for one action only.

Examples:

- coordinate-only mouse click
- `mouse_move`
- scroll at current cursor

No registry lens. No TTL. No resource. It only runs sync validation.

### 2. Hidden Hot Target

Used for recent repeated actions on the same target.

Examples:

- `keyboard_type(windowTitle:"Notepad")`
- repeated `mouse_click(windowTitle:"Chrome", ...)`
- repeated `browser_click_element(tabId, selector)`

Stored in a small hidden cache:

```ts
interface HotTargetSlot {
  key: string;
  kind: "window" | "browserTab";
  descriptor: TargetDescriptor;
  identity?: WindowIdentity | BrowserTabIdentity;
  lastRect?: Rect;
  lastUsedAtMs: number;
  createdAtMs: number;
  useCount: number;
  attention: "ok" | "changed" | "dirty" | "stale" | "identity_changed" | "not_found";
}
```

Hot targets are not model-facing. The model never sees or passes a hot target
ID. A hidden slot may optionally be backed by a real `PerceptionLens`, but it
does not have to be.

### 3. Manual Lens

Created by `perception_register`.

Use cases:

- user/model wants to pin a specific window identity
- long-running workflow with explicit inspection
- debugging RPG state
- host/resource integration

Manual lenses remain identity-bound and fail closed on identity changes.

## Public API Changes

Minimal:

1. Keep `lensId` on action tools, but describe it as advanced:

   ```text
   Advanced: pass lensId only when you already registered a pinned perception
   lens. Normally omit it; desktop-touch automatically guards actions with
   windowTitle/selector/tabId/coordinates.
   ```

2. Do not add `perception`, `autoPerception`, or `targetHandle` parameters.

3. Add optional debug only later if needed:

   ```ts
   perceptionDebug?: boolean
   ```

   This should be hidden from normal descriptions if possible.

## ActionTarget Inference

Use existing arguments. Do not ask the model for a new structure.

### Window Target

Inputs:

- `windowTitle`
- `elementName` / `elementId` with `windowTitle`
- `name` / `automationId` plus `windowTitle`
- `chromeTabUrlContains` for `focus_window`

Resolution:

1. Enumerate windows.
2. Prefer active matching window.
3. Else prefer single title match.
4. Else if multiple matches, fail for keyboard and UIA actions; for mouse clicks
   only continue if final coordinate is inside exactly one matching window.
5. Build current identity and rect.

### Browser Target

Inputs:

- `tabId`
- active CDP tab
- `urlIncludes`
- `titleIncludes`
- selector action scoped to current tab

Resolution:

1. If `tabId` exists, bind exact tab.
2. Else if URL/title match has one candidate, bind it.
3. Else use active CDP tab for browser-only actions.
4. Never let a browser-tab-only target authorize OS keyboard input unless the
   browser window focus is also verified.

### Coordinate Target

Inputs:

- final screen coordinates after origin/scale conversion
- final homed coordinates after window-delta correction
- current window cache

Resolution:

1. Find top-level visible containing window at final coordinate.
2. If `windowTitle` exists, require containing window to match it.
3. If no containing window, do not guard as a target.
4. Coordinate targets are action-scoped. Do not keep them as hot targets unless
   a `windowTitle` was also supplied.

## Guard Policy By Action

### Keyboard

`keyboard_type` and `keyboard_press`:

1. If explicit `lensId`, use existing pinned-lens guard.
2. Else if `windowTitle`, focus target, then refresh foreground identity and
   guard `safe.keyboardTarget`.
3. Else use existing behavior, but return a short warning:

   ```json
   "perception": {"status":"unguarded", "next":"Pass windowTitle for guarded typing"}
   ```

Do not auto-bind coordinate-only or active-window-only keyboard actions. That
does not prevent wrong-window typing.

### Mouse Click/Drag

1. Convert image-local coordinates to screen coordinates first.
2. Apply homing.
3. Infer target from final coordinate and optional `windowTitle`.
4. Guard final coordinate against current target rect and identity.
5. Execute click.
6. Post-check foreground/window movement only if useful.

Important: the existing code currently evaluates explicit lens guards before
origin conversion and homing. Auto guard should validate the final coordinate,
not stale input coordinates.

### UIA Named Actions

`click_element` / `set_element_value`:

1. Resolve `windowTitle`.
2. Refresh identity and optionally focused element/control existence.
3. Invoke UIA action.
4. Attach compact result.

These are already semantically higher-level than pixel clicks, so they should
be preferred in descriptions over manual lens workflows.

### Browser CDP Actions

`browser_click_element`, `browser_eval`, `browser_navigate`:

1. Resolve tab.
2. Refresh URL/title/readyState.
3. Guard tab identity and readiness.
4. Execute action.
5. Return post-check readyState and URL/title changes.

Do not require a separate browserTab lens for normal use.

## Post Response Shape

Keep it very small. LLMs need actionability, not evidence dumps.

```json
{
  "post": {
    "perception": {
      "status": "ok",
      "target": "window:Visual Studio Code",
      "canContinue": true,
      "next": "continue"
    }
  }
}
```

Failure/uncertain examples:

```json
{
  "post": {
    "perception": {
      "status": "ambiguous_target",
      "canContinue": false,
      "next": "Call get_windows or pass a more specific windowTitle"
    }
  }
}
```

```json
{
  "post": {
    "perception": {
      "status": "unguarded",
      "canContinue": true,
      "next": "Pass windowTitle for guarded typing"
    }
  }
}
```

Reserve detailed fields behind `perception_read` or debug resources.

## Forgetting And Budgets

The previous concern about `MAX_LENSES = 16` is valid only if every auto target
becomes a full registry lens. Do not do that.

Recommended budgets:

```ts
const MAX_MANUAL_LENSES = 16;       // existing perception_register lenses
const MAX_HOT_TARGETS = 6;          // hidden auto cache only
const HOT_TARGET_IDLE_TTL_MS = 90_000;
const HOT_TARGET_HARD_TTL_MS = 10 * 60_000;
const HOT_TARGET_BAD_TTL_MS = 15_000;
```

Hot target eviction:

1. Expired by hard TTL.
2. Expired by idle TTL.
3. `identity_changed`, `not_found`, or `ambiguous` older than bad TTL.
4. LRU.

Manual lens eviction:

- Keep existing max 16 initially.
- Manual lenses should not be evicted because of hot target churn.
- Later, replace FIFO with LRU/touch semantics, but that is separate from auto
  guard.

TTL extension:

- Extend hot target TTL only when a model action uses the target.
- Do not extend TTL because background sensors saw activity.
- Coordinate-only action-scoped targets are never cached.

## Rebinding Rules

Manual lens:

- Identity-bound.
- If identity changes, fail closed and ask for explicit re-register.

Hidden hot target:

- Descriptor-bound.
- On each action, re-resolve from descriptor.
- If exactly one high-confidence target matches, update identity and continue.
- If ambiguous or no target, fail before unsafe action.

This distinction is important. A model that says `keyboard_type(windowTitle:
"Notepad")` is asking for the current Notepad-like target, not necessarily the
same HWND registered five minutes ago. Pinned identity semantics belong to
manual `lensId`, not automatic action guards.

## Implementation Plan

### Phase A: ActionGuard Without Registry Changes

Create `src/tools/_action-guard.ts`:

```ts
inferActionTarget(toolName, args, phase)
preflightActionGuard(target, actionKind, finalArgs)
buildActionPerceptionSummary(...)
```

Start with sync Win32/CDP checks only. Do not create registry lenses.

Integrate:

- `keyboard_type`
- `keyboard_press`
- `mouse_click`
- `click_element`
- `set_element_value`
- `browser_click_element`
- `browser_navigate`

### Phase B: Hidden HotTargetCache

Add small cache only for target descriptors that recur.

Use it to compare previous identity/rect and produce `changed` or
`identity_changed` summaries, but still gate actions on fresh sync reads.

### Phase C: Manual Lens Cleanup

Improve existing registry separately:

- touch manual lens on use
- LRU instead of FIFO
- optional manual TTL only if configured
- keep `MAX_MANUAL_LENSES = 16`

### Phase D: Prompt Surface

Move instructions from "lensId workflow" to "automatic guard behavior":

```text
For normal work, use action tools directly. When you pass windowTitle, selector,
tabId, or recent screenshot coordinates, desktop-touch guards the action and
returns post.perception. Use lensId only for pinned advanced tracking.
```

Downgrade `perception_register` in descriptions:

```text
Advanced/debug: pin a target identity across many actions. Normal action tools
already run automatic perception guards when target hints are available.
```

## Tests

Unit:

- target inference from `windowTitle`
- ambiguous title blocks keyboard
- coordinate-only target is not cached
- hot target TTL and LRU
- manual lens unaffected by hot target churn
- browserTab target does not authorize OS keyboard

E2E:

- `keyboard_type(windowTitle)` returns `post.perception` without `lensId`
- `keyboard_type` without `windowTitle` returns `unguarded` warning
- `mouse_click(windowTitle, origin, scale)` validates final converted/homed coords
- repeated actions reuse hidden hot target and report `changed`
- ambiguous title fails before typing
- manual `lensId` still works exactly as before

## Final Product Rule

If the model has to remember `lensId`, the default UX has failed.

The default must be:

```text
Pass a target hint to the normal action tool. The server handles perception.
```

