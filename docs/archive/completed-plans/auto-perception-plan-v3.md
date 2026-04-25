# [Final] LLM-First Auto Perception Plan (v3)

Date: 2026-04-17

Languages: English first, Japanese version included in the second half of this
same document.

This document defines the next evolution of the perception layer in
`desktop-touch-mcp`. It keeps the core v3 direction: the LLM should use normal
action tools, while the server infers target intent from existing arguments and
guards the action automatically.

The important refinement is that the design now separates:

- immediate action safety,
- explicit target attention,
- semantic recall of what happened to a target over time.

This avoids pushing `lensId` management onto the LLM while preserving the
advanced pinned-target API for workflows that need it.

## 1. Core Product Rule

**Pass a target hint to the normal action tool. The server handles perception.**

Normal use should look like this:

```text
keyboard_type(windowTitle:"Notepad", text:"hello")
mouse_click(windowTitle:"Notepad", x:..., y:...)
browser_click_element(tabId:"...", selector:"#submit")
click_element(windowTitle:"Settings", name:"Save")
```

The model should not need to call `perception_register`, remember a `lensId`,
thread that ID through every action, and explicitly forget it. If the default UX
requires that, the default UX has failed.

`lensId` remains available, but it becomes an advanced/debug/pinned-target API.

## 2. Design Rationale

This plan supersedes the earlier "auto lens policy parameter" idea. That
direction was correct in spirit, but it still exposed too much state management
to the model.

LLMs use desktop tools in a few repeated patterns:

- visual discovery, then one click;
- click a field, then type;
- browser DOM/selector operation;
- native UIA named-control operation;
- multi-app workflow where the active target changes;
- recovery after a failed click, focus steal, modal, or navigation.

In those flows the model already supplies enough target evidence through normal
tool arguments. Asking it to additionally register a lens, remember a `lensId`,
pass it through every subsequent action, and clean it up later is fragile.

The protocol and model-behavior constraints point in the same direction:

- MCP tools are model-controlled, so safety that depends on a model choosing a
  separate setup tool is unreliable.
- MCP resources are useful for inspection and host integration, but they are not
  a good primary behavior-control channel.
- Modern tool guidance favors strict schemas, compact responses, and
  high-signal post-action feedback.
- Computer-use workflows naturally follow an observe/action loop; the practical
  design is to make that loop safer, not to require a separate perception setup
  loop.
- Coordinate mistakes and tool-selection mistakes are expected failure classes.
  The guard layer should compensate for them when target evidence is available.
- Native UI events are noisy. They should invalidate cached belief, while
  synchronous pre-action refresh should gate unsafe input.

## 3. Core UX Decisions

### 3.1 Freedom From Lens Management

The LLM keeps using existing action tools. The server infers the target from
existing arguments:

- `windowTitle`
- `selector`
- `tabId`
- `port`
- `chromeTabUrlContains`
- `name` / `automationId`
- final click coordinates
- recent screenshot/window-cache evidence

No new default `perception` mode parameter should be added.

### 3.2 Implicit Guarding

When an action includes enough target evidence, the server automatically builds
an `ActionGuard`.

Internal flow:

```text
tool handler
  -> explicit lensId guard, if provided
  -> infer ActionTarget from existing args
  -> pre-action synchronous refresh
  -> evaluate guard for the action kind
  -> execute action
  -> post-action lightweight check
  -> attach compact post.perception
  -> update hidden target memory / timeline
```

Manual lenses are not used as the default implementation vehicle for automatic
guards. Automatic targets must not consume the manual lens budget.

### 3.3 Approve Model

The Approve Model remains part of the target experience.

When a guard detects a recoverable displacement, the server can return a
time-limited `suggestedFix`. The model should be able to approve that fix with
minimal effort.

The implementation will not add a new `approve_suggested_fix` tool initially.
Instead, Phase C will evaluate a minimal existing-tool parameter:

```ts
mouse_click({ fixId: "fix-..." })
```

The tool that receives `fixId` resolves the stored fix, revalidates it, and then
executes the normal guarded path.

### 3.4 Explicit Escalation

When the server cannot resolve a situation safely, it should ask the model to
return to conscious perception:

- `screenshot`
- `get_windows`
- `get_context`
- `browser_get_interactive`
- `perception_read` for manual lenses

The server should fail before unsafe action and provide a short, concrete next
step.

## 4. ActionTarget Inference

`ActionTarget` is internal. The LLM does not pass this object directly.

```ts
type ActionKind =
  | "keyboard"
  | "mouseClick"
  | "mouseDrag"
  | "uiaInvoke"
  | "uiaSetValue"
  | "browserCdp";

type ActionTargetDescriptor =
  | { kind: "window"; titleIncludes: string }
  | {
      kind: "browserTab";
      tabId?: string;
      port: number;
      urlIncludes?: string;
      titleIncludes?: string;
    }
  | { kind: "coordinate"; x: number; y: number; windowTitle?: string };

type ActionGuardSummary = {
  status:
    | "ok"
    | "unguarded"
    | "ambiguous_target"
    | "target_not_found"
    | "identity_changed"
    | "blocked_by_modal"
    | "unsafe_coordinates"
    | "browser_not_ready"
    | "needs_escalation";
  canContinue: boolean;
  target?: string;
  next: string;
};
```

### 4.1 Window Target

Inputs:

- `windowTitle`
- `elementName` / `elementId` with `windowTitle`
- `name` / `automationId` with `windowTitle`
- `chromeTabUrlContains` on `focus_window`

Resolution:

1. Enumerate visible top-level windows.
2. Prefer the active matching window.
3. Else accept a single matching window.
4. If multiple windows match:
   - keyboard and UIA actions should fail closed;
   - mouse actions may continue only if the final coordinate is inside exactly
     one matching window.
5. Build a current window identity:
   - HWND
   - PID
   - process name
   - process start time
   - resolved title
   - rect
   - foreground state
   - modal state

### 4.2 Browser Target

Inputs:

- `tabId`
- active CDP tab
- `port`
- URL/title hints
- selector actions scoped to a CDP tab

Resolution:

1. If `tabId` exists, bind that exact tab.
2. Else if URL/title matching has one candidate, bind it.
3. Else use the active/first CDP page tab for browser-only actions.
4. Browser-tab identity must never by itself authorize OS keyboard input. OS
   keyboard tools require foreground browser-window verification as well.

Browser readiness should be action-sensitive:

- for `browser_navigate`, readiness is important after navigation;
- for `browser_eval`, readiness may block reads that depend on a loaded page;
- for `browser_click_element`, a resolved in-viewport selector may be enough to
  warn rather than block when `readyState !== "complete"`.

### 4.3 Coordinate Target

Inputs:

- final screen coordinates after `origin` / `scale` conversion
- final coordinates after homing
- optional `windowTitle`
- current window list

Resolution:

1. Convert image-local coordinates to screen coordinates first.
2. Apply homing correction.
3. Infer the containing top-level window from the final coordinate.
4. If `windowTitle` exists, require the containing window to match it.
5. Coordinate-only targets are action-scoped and are not cached unless
   `windowTitle` is also supplied.

This fixes a critical ordering problem: guard evaluation must validate the final
converted/homed click coordinate, not the stale input coordinate.

## 5. Guard Policy By Action

### 5.1 Keyboard

`keyboard_type` and `keyboard_press`:

1. If explicit `lensId` is provided, use the existing pinned-lens guard.
2. Else if `windowTitle` is provided:
   - resolve the window target;
   - focus the target as the tool already does;
   - refresh foreground identity;
   - guard `safe.keyboardTarget`.
3. Else continue existing behavior, but return:

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

Do not auto-bind keyboard tools to the currently active window without an
explicit target hint. That does not prevent wrong-window typing.

### 5.2 Mouse Click / Drag

`mouse_click` Phase A order:

1. Convert `origin` / `scale` image-local coordinates to screen coordinates.
2. Apply homing correction.
3. Infer the target from final coordinates and optional `windowTitle`.
4. Evaluate `target.identityStable`, `stable.rect`, and
   `safe.clickCoordinates` against the final coordinate.
5. Execute the click.
6. Post-check focus/window movement.
7. Attach compact `post.perception`.

`mouse_drag` should use the same target resolution for the start point and apply
the same delta to the end point. The start point is the safety-critical click
down coordinate.

### 5.3 UIA Named Actions

`click_element` and `set_element_value`:

1. Resolve `windowTitle`.
2. Guard target identity and modal obstruction.
3. Invoke UIA action.
4. Attach compact result.

These tools are semantically stronger than pixel clicks and should remain
preferred in descriptions for native apps.

### 5.4 Browser CDP Actions

`browser_click_element`, `browser_eval`, and `browser_navigate`:

1. Resolve the target tab.
2. Refresh URL/title/readyState.
3. Guard tab identity/readiness according to action kind.
4. Execute CDP/mouse action.
5. Attach URL/title/readyState changes where response shape allows it.

`browser_eval` currently returns raw text. Phase A may guard it without attaching
full `post.perception`. A later phase can add a compact status line if needed
without breaking compatibility.

## 6. Three-Tier Memory Strategy

The memory model is not one cache with three names. Each tier has a different
responsibility and different rebinding semantics.

### 6.1 Reflexive Memory: HotTargetCache

Purpose: short-term safety for the next action.

Lifetime:

- idle TTL: 90 seconds
- hard TTL: 10 minutes
- bad/failed target TTL: 15 seconds
- max slots: 6

Stored fields:

```ts
interface HotTargetSlot {
  key: string;
  kind: "window" | "browserTab";
  descriptor: ActionTargetDescriptor;
  identity?: WindowIdentity | BrowserTabIdentity;
  lastRect?: { x: number; y: number; width: number; height: number };
  lastUsedAtMs: number;
  createdAtMs: number;
  useCount: number;
  attention:
    | "ok"
    | "changed"
    | "dirty"
    | "stale"
    | "identity_changed"
    | "not_found"
    | "ambiguous";
}
```

Rules:

- Hidden from the model.
- Descriptor-bound, not identity-bound.
- Re-resolved on each action.
- TTL extends only when a model action uses the target.
- Background sensor activity must not extend TTL.
- Coordinate-only targets are never cached.
- Does not consume manual lens budget.

If the same descriptor resolves to a single high-confidence target, the slot may
update its identity and continue. If it becomes ambiguous or missing, fail before
unsafe action.

### 6.2 Attentional Memory: Manual Lens

Purpose: explicit pinned attention for a workflow or debugging session.

Implementation: existing `perception_register`, `perception_read`,
`perception_forget`, and `perception_list`.

Rules:

- Model/user explicitly creates it.
- Identity-bound.
- Fails closed on identity change.
- Does not automatically rebind.
- Not affected by HotTargetCache churn.
- Max manual lenses remains 16 initially.
- Later improvement: LRU/touch semantics instead of FIFO eviction.

Manual lenses are the right tool when the caller wants to pin one exact HWND/tab
identity across many actions.

### 6.3 Episodic Memory: Target-Identity Timeline

Purpose: semantic recall of what happened to a target over its lifetime.

This is not merely `get_history`. It is a target-scoped timeline of meaningful
events, keyed by target identity and descriptor. It lets the LLM recall:

- "I clicked Save."
- "The same target then changed title."
- "A modal appeared above that target."
- "Navigation happened in this tab."
- "The previous target closed and a different identity replaced it."

The timeline should store compressed semantic facts, not raw screenshots,
complete `post` blocks, or full perception envelopes.

```ts
type TargetIdentityTimelineEvent = {
  eventId: string;
  tsMs: number;
  targetKey: string;
  identity: WindowIdentity | BrowserTabIdentity;
  descriptor?: ActionTargetDescriptor;
  source: "action_guard" | "manual_lens" | "post_check" | "sensor";
  semantic:
    | "target_bound"
    | "action_attempted"
    | "action_succeeded"
    | "action_blocked"
    | "title_changed"
    | "rect_changed"
    | "foreground_changed"
    | "navigation"
    | "modal_appeared"
    | "modal_dismissed"
    | "identity_changed"
    | "target_closed";
  summary: string;
  tool?: string;
  result?: "ok" | "blocked" | "failed";
};
```

Retention:

- session duration by default;
- bounded ring per target;
- global cap to prevent unbounded memory;
- old events may be compacted into summaries.

Exposure:

- `get_history` may include target keys and short semantic summaries;
- `perception_read(lensId)` may include recent timeline events for that target;
- MCP resources may later expose `perception://target/{targetKey}/timeline` or a
  session-level recent-targets resource, behind the existing resource flags.

The key point: episodic memory is semantic and target-scoped. It should help the
LLM reason about consequences without relying on stale coordinates or an
imperfect verbal memory of previous screenshots.

## 7. SuggestedFix And fixId Approval

### 7.1 SuggestedFix Shape

When a guard blocks a recoverable action, the server may return:

```ts
type SuggestedFix = {
  fixId: string;
  tool: "mouse_click" | "keyboard_type" | "browser_click_element" | "click_element";
  args: Record<string, unknown>;
  targetFingerprint: {
    kind: "window" | "browserTab";
    descriptorKey: string;
    hwnd?: string;
    pid?: number;
    processStartTimeMs?: number;
    tabId?: string;
    url?: string;
  };
  createdAtMs: number;
  expiresAtMs: number;
  reason: string;
};
```

Example failure:

```json
{
  "ok": false,
  "code": "UnsafeCoordinates",
  "post": {
    "perception": {
      "status": "unsafe_coordinates",
      "canContinue": false,
      "next": "Approve the suggested fix or take a new screenshot"
    }
  },
  "suggestedFix": {
    "fixId": "fix-abc123",
    "tool": "mouse_click",
    "args": { "x": 1024, "y": 512, "windowTitle": "Notepad" },
    "expiresAtMs": 1776420000000,
    "reason": "Target window moved by +120,-8 after the screenshot"
  }
}
```

### 7.2 Approval Via Existing Tool Parameter

Phase C will evaluate adding `fixId` to selected action tools:

```ts
mouse_click({ fixId: "fix-abc123" })
```

Execution rules:

1. The `fixId` must exist and be within TTL.
2. The called tool must match `SuggestedFix.tool`.
3. The target fingerprint must still match or re-resolve safely.
4. The stored args must be re-run through normal `ActionGuard`.
5. The fix is one-shot and is consumed after use.
6. A failed revalidation must not execute the action.
7. The response must say whether the fix was approved, consumed, expired, or
   rejected.

Initial scope:

- start with `mouse_click({ fixId })`;
- defer keyboard approval until after click approval proves safe;
- do not add a separate approval tool in the initial design.

This keeps the "approve and continue" agent experience while preserving the
same pre-action safety guarantees as normal actions.

## 8. Post Response Shape

Default `post.perception` must be compact and actionable.

Success:

```json
{
  "post": {
    "perception": {
      "status": "ok",
      "target": "window:Notepad",
      "canContinue": true,
      "next": "continue"
    }
  }
}
```

Ambiguous target:

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

Unguarded keyboard action:

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

Detailed evidence remains behind `perception_read`, debug resources, or future
timeline resources.

## 9. Implementation Roadmap

### Phase A: ActionGuard Middleware

Goals:

- add hidden `ActionGuard` below action tool handlers;
- keep manual `lensId` behavior working;
- do not introduce HotTargetCache yet;
- do not introduce `fixId` yet.

Initial integrations:

- `keyboard_type`
- `keyboard_press`
- `mouse_click`
- `mouse_drag`
- `click_element`
- `set_element_value`
- `browser_click_element`
- `browser_navigate`

Critical Phase A fix:

- `mouse_click` guard must run after `origin` / `scale` conversion and homing,
  using the final click coordinate.

### Phase B: Hidden HotTargetCache

Goals:

- add descriptor-bound short-term slots;
- detect changed target identity/rect/title across repeated actions;
- produce compact `changed` / `identity_changed` summaries;
- keep action gating based on fresh synchronous reads.

Do not back every hot target with a registry lens unless a later performance
profile proves it is needed.

### Phase C: SuggestedFixStore And fixId Approval

Goals:

- add bounded in-memory `SuggestedFixStore`;
- return `suggestedFix` for recoverable guard failures;
- implement `mouse_click({ fixId })` first;
- revalidate before execution;
- consume fixes after one use.

Keyboard `fixId` support is explicitly deferred until mouse approval behavior is
stable.

### Phase D: Target-Identity Timeline

Goals:

- add semantic target-scoped timeline events;
- record action attempts, successes, blocks, title changes, navigation, modal
  transitions, identity changes, and target closure;
- expose recent target events through `get_history` and `perception_read`;
- optionally expose timeline resources behind resource flags.

The timeline should store compressed facts, not raw envelopes.

### Phase E: Manual Lens Cleanup And Prompt Surface

Goals:

- touch manual lenses on use;
- replace FIFO eviction with LRU;
- keep `MAX_MANUAL_LENSES = 16`;
- update action tool descriptions to explain automatic guarding;
- downgrade `perception_register` wording to advanced/debug/pinned-target usage.

Example description direction:

```text
Normally omit lensId. When you pass windowTitle, selector, tabId, or recent
screenshot coordinates, desktop-touch automatically guards the action and
returns post.perception. Use lensId only when you have registered a pinned
perception lens for advanced tracking.
```

## 10. Implementation Source Map

This section maps the design to the current source tree. Line numbers reflect
the codebase at the time this document was written.

### 10.1 Highest-Priority Phase A Fix

The first Phase A change is in `src/tools/mouse.ts`.

- `src/tools/mouse.ts:295` — `mouseClickHandler` starts here.
- `src/tools/mouse.ts:308` — current `lensId` perception guard is evaluated here.
- `src/tools/mouse.ts:319` — image-local coordinates are converted with
  `origin` / `scale`.
- `src/tools/mouse.ts:339` — `applyHoming()` runs here and produces the final
  click coordinates.
- `src/tools/mouse.ts:380` — success response builds the current
  `buildEnvelopeFor()` payload.

Current order:

```text
guard(x,y) -> origin/scale conversion -> homing -> click
```

Required Phase A order:

```text
origin/scale conversion -> homing -> guard(final tx,ty) -> click
```

The guard must validate the final converted/homed coordinate, not the stale
input coordinate.

### 10.2 Action Tool Integration Points

The proposed `src/tools/_action-guard.ts` should be called from the existing
handlers below.

Keyboard:

- `src/tools/keyboard.ts:184` — `keyboardTypeHandler`.
- `src/tools/keyboard.ts:208` — current `keyboard_type` explicit `lensId` guard.
- `src/tools/keyboard.ts:221` — `focusWindowForKeyboard()` runs here; automatic
  keyboard guard should verify foreground after this.
- `src/tools/keyboard.ts:279` — `keyboardPressHandler`.
- `src/tools/keyboard.ts:297` — current `keyboard_press` explicit `lensId` guard.

Mouse:

- `src/tools/mouse.ts:295` — `mouseClickHandler`.
- `src/tools/mouse.ts:394` — `mouseDragHandler`.
- `src/tools/mouse.ts:417` — drag homing path; the start point is the
  safety-critical mouse-down coordinate.

UIA named actions:

- `src/tools/ui-elements.ts:77` — `clickElementHandler`.
- `src/tools/ui-elements.ts:85` — current `click_element` explicit `lensId`
  guard.
- `src/tools/ui-elements.ts:109` — `setElementValueHandler`.
- `src/tools/ui-elements.ts:117` — current `set_element_value` explicit
  `lensId` guard.

Browser actions:

- `src/tools/browser.ts:503` — `browserClickElementHandler`.
- `src/tools/browser.ts:518` — current `browser_click_element` explicit
  `lensId` guard.
- `src/tools/browser.ts:604` — `browserEvalHandler`.
- `src/tools/browser.ts:619` — current `browser_eval` explicit `lensId` guard.
- `src/tools/browser.ts:690` — `browserNavigateHandler`.
- `src/tools/browser.ts:709` — current `browser_navigate` explicit `lensId`
  guard.

### 10.3 Existing Perception Core To Reuse

Automatic guards should reuse existing perception logic, but they should not
register every automatic target as a manual lens.

- `src/engine/perception/registry.ts:621` — `evaluatePreToolGuards()`, current
  explicit `lensId` guard entry point.
- `src/engine/perception/registry.ts:662` — `buildEnvelopeFor()`, current manual
  lens envelope projection.
- `src/engine/perception/registry.ts:696` — `readLens()`, explicit refresh and
  envelope read.
- `src/engine/perception/guards.ts:21` — `GuardContext`.
- `src/engine/perception/guards.ts:98` — `evalKeyboardTarget()`.
- `src/engine/perception/guards.ts:202` — `evalClickCoordinates()`.
- `src/engine/perception/guards.ts:367` — `evalBrowserReady()`.
- `src/engine/perception/guards.ts:404` — `evaluateGuard()`.
- `src/engine/perception/guards.ts:420` — `evaluateGuards()`.
- `src/engine/perception/types.ts:19` — `WindowIdentity`.
- `src/engine/perception/types.ts:141` — `LensSpec`.
- `src/engine/perception/types.ts:154` — `BrowserTabIdentity`.
- `src/engine/perception/types.ts:166` — `PerceptionLens`.
- `src/engine/perception/types.ts:224` — `PerceptionEnvelope`.

### 10.4 Target Resolution And Refresh Helpers

Useful existing helpers for `ActionTarget` inference:

- `src/engine/perception/lens.ts:73` — `resolveBindingFromSnapshot()`, existing
  title-to-window binding logic.
- `src/engine/perception/lens.ts:92` — `resolveBrowserTabBindingFromTabs()`,
  existing browser tab matching logic.
- `src/engine/perception/lens.ts:111` — `buildBrowserTabIdentity()`.
- `src/engine/perception/sensors-win32.ts:123` — `refreshWin32Fluents()`,
  synchronous window refresh for identity, foreground, rect, and modal state.
- `src/engine/perception/sensors-win32.ts:193` — `buildWindowIdentity()`.
- `src/engine/window-cache.ts:76` — `findContainingWindow()`, useful for
  coordinate target inference.
- `src/engine/window-cache.ts:95` — `getCachedWindowByTitle()`.
- `src/engine/window-cache.ts:114` — `computeWindowDelta()`, existing homing
  primitive.
- `src/engine/identity-tracker.ts:101` — `observeTarget()`.
- `src/engine/identity-tracker.ts:266` — `buildHintsForTitle()`.

### 10.5 Suggested New Files

Recommended new modules:

- `src/tools/_action-guard.ts` — tool-facing action-guard module. Exposes
  `runActionGuard()` as the primary entry point; all Phase A handlers
  (mouse / keyboard / ui-elements / browser) call it directly so each
  handler can keep its own ordering (e.g. mouse: conversion → homing →
  guard → click) and its own `lensId` branching. Also exports
  `withActionGuard<T>()` as a middleware wrapper retained for future
  use (Phase B HotTargetCache integration, Phase E prompt-surface work)
  and as the reference implementation of the guard contract covered by
  `tests/unit/action-guard.test.ts`. Phase A itself does not use
  `withActionGuard` from any handler.
- `src/engine/perception/action-target.ts` — pure-ish target inference from
  `windowTitle`, `tabId`, selector context, and final coordinates.
- `src/engine/perception/hot-target-cache.ts` — Phase B hidden descriptor-bound
  target cache.
- `src/engine/perception/suggested-fix-store.ts` — Phase C TTL-bound one-shot
  `fixId` store.
- `src/engine/perception/target-timeline.ts` — Phase D Target-Identity Timeline.

### 10.6 History And Timeline Integration

Target-Identity Timeline should store semantic facts, not full envelopes.

- `src/tools/_post.ts:44` — `HistoryEntry`.
- `src/tools/_post.ts:60` — `recordHistory()`.
- `src/tools/_post.ts:65` — `getHistorySnapshot()`.
- `src/tools/_post.ts:170` — current code strips `rich` and `perception` from
  history to avoid bloat. Timeline should keep only compressed semantic facts.
- `src/tools/context.ts:192` — `get_history` response.
- `src/tools/perception.ts:138` — `perceptionReadHandler`; Phase D can include
  recent target timeline events here.

### 10.7 Manual Lens Cleanup Points

Manual lens cleanup is separate from automatic guard work.

- `src/engine/perception/registry.ts:79` — `MAX_LENSES = 16`.
- `src/engine/perception/registry.ts:269` — `evictOldestIfNeeded()` currently
  evicts by insertion order.
- `src/engine/perception/registry.ts:490` — `registerLens()`.
- `src/engine/perception/registry.ts:551` — `registerLensAsync()`.

Phase E can add touch/LRU behavior here without coupling it to HotTargetCache.

## 11. Tests

### Unit

- target inference from `windowTitle`;
- ambiguous `windowTitle` blocks keyboard/UIA;
- coordinate-only target is not cached;
- `mouse_click` guard validates final converted/homed coordinates;
- HotTargetCache TTL, bad TTL, hard TTL, and LRU;
- manual lens budget is unaffected by hot target churn;
- browserTab target does not authorize OS keyboard tools;
- SuggestedFix TTL and one-shot consume;
- `fixId` rejects mismatched tool names;
- Target-Identity Timeline compacts semantic events per target.

### E2E

- `keyboard_type(windowTitle)` returns `post.perception` without `lensId`;
- `keyboard_type` without `windowTitle` returns `unguarded`;
- ambiguous title fails before typing;
- `mouse_click(windowTitle, origin, scale)` guards final coordinates;
- repeated actions report target title/rect changes through hot target summaries;
- `mouse_click` receives a recoverable `suggestedFix`;
- `mouse_click({ fixId })` revalidates and consumes the fix;
- manual `lensId` workflows still work as before;
- `perception_read(lensId)` can recall recent semantic target events.

## 12. Open Design Decisions

1. Default-on timing:
   - ship auto guard default-on immediately, or add
     `DESKTOP_TOUCH_AUTO_GUARD=0` as a rollback switch?

2. Ambiguous title policy:
   - keyboard/UIA should fail closed;
   - mouse can continue only when final coordinates identify exactly one
     matching target.

3. Browser readiness policy:
   - decide per browser tool whether `readyState !== "complete"` blocks or only
     warns.

4. Timeline resource surface:
   - start with `get_history` and `perception_read`;
   - add MCP resources only after the event model stabilizes.

5. Keyboard fix approval:
   - defer until mouse fix approval is proven safe.

## 13. Final Product Rule

The LLM should not have to remember perception internals.

Default:

```text
Pass a target hint to the normal action tool. The server handles perception.
```

Advanced:

```text
Use perception_register only when you need to pin a specific identity or debug
the perception layer.
```

---

# [最終版] LLM-First Auto Perception Plan (v3) 日本語版

日付: 2026-04-17

この文書は `desktop-touch-mcp` の perception layer を次段階へ進めるための
設計書である。v3 の中心方針は維持する。LLM は通常の action tool を使い、
サーバー側が既存引数からターゲット意図を推論し、自動的に action をガード
する。

今回の改定では、以下の3つを明確に分離する。

- 直近 action の安全性
- 明示的に注視しているターゲット
- ターゲットに対して何が起きたかの意味論的な想起

これにより、通常利用で LLM に `lensId` 管理を押し付けずに済む。一方で、
長時間の固定監視やデバッグが必要な場合には、従来の pinned-target API を
advanced 機能として残す。

## 1. コアプロダクトルール

**通常の action tool にターゲットヒントを渡す。perception はサーバーが処理する。**

通常利用は次のような形にする。

```text
keyboard_type(windowTitle:"Notepad", text:"hello")
mouse_click(windowTitle:"Notepad", x:..., y:...)
browser_click_element(tabId:"...", selector:"#submit")
click_element(windowTitle:"Settings", name:"Save")
```

モデルが `perception_register` を呼び、`lensId` を覚え、以後の全 action に
渡し、最後に明示的に忘れる、という操作を通常経路にしてはいけない。default
UX がそれを要求するなら、その default UX は失敗である。

`lensId` は残す。ただし advanced/debug/pinned-target API と位置付ける。

## 2. 設計根拠

この計画は、以前の「auto lens policy parameter」案を置き換える。方向性は
正しかったが、まだモデル側に状態管理を露出しすぎていた。

LLM の desktop tool 利用は、概ね以下の反復パターンに収束する。

- visual discovery の後に1クリックする
- フィールドをクリックしてから入力する
- browser DOM / selector 操作を行う
- native UIA の名前付き control を操作する
- 複数アプリをまたぎ、active target が変わる
- クリック失敗、focus steal、modal、navigation の後に復旧する

これらの流れでは、モデルは既に通常の tool 引数を通じて十分なターゲット
証拠を渡している。そこにさらに lens 登録、`lensId` 記憶、各 action への
引き回し、cleanup を要求するのは脆い。

プロトコルとモデル挙動の制約から見ても、同じ結論になる。

- MCP tools はモデル制御であり、安全性が「モデルが別の setup tool を選ぶ」
  ことに依存すると不安定になる。
- MCP resources は inspection や host integration には向くが、主たる挙動
  制御チャネルには向かない。
- 現代の tool guidance は strict schema、compact response、高信号な
  post-action feedback を重視する。
- computer-use workflow は自然に observe/action loop になる。この loop と
  戦うより、loop 自体を安全にする方が実用的である。
- 座標ミスと tool 選択ミスは想定すべき失敗クラスである。guard layer は
  ターゲット証拠がある時にそれを補正すべきである。
- native UI event は noisy である。event は cached belief を invalidate し、
  unsafe input の gate は同期的な pre-action refresh で行うべきである。

## 3. コアUX決定

### 3.1 Lens 管理からの解放

LLM は既存 action tool を使い続ける。サーバーは既存引数からターゲットを
推論する。

- `windowTitle`
- `selector`
- `tabId`
- `port`
- `chromeTabUrlContains`
- `name` / `automationId`
- 最終クリック座標
- 直近 screenshot / window-cache evidence

新しい default `perception` mode parameter は追加しない。

### 3.2 暗黙のガード

action が十分な target evidence を含む場合、サーバーが自動的に
`ActionGuard` を構築する。

内部フロー:

```text
tool handler
  -> explicit lensId guard, if provided
  -> infer ActionTarget from existing args
  -> pre-action synchronous refresh
  -> evaluate guard for the action kind
  -> execute action
  -> post-action lightweight check
  -> attach compact post.perception
  -> update hidden target memory / timeline
```

自動 guard の実装手段として manual lens を使うことを default にしない。
automatic target は manual lens budget を消費してはいけない。

### 3.3 Approve Model

Approve Model は target experience の一部として維持する。

guard が復旧可能なズレを検出した場合、サーバーは TTL 付きの
`suggestedFix` を返せる。モデルは最小の手間でその fix を承認できるべきで
ある。

初期実装では新しい `approve_suggested_fix` tool は追加しない。Phase C で、
既存 tool の最小パラメータとして以下を検討する。

```ts
mouse_click({ fixId: "fix-..." })
```

`fixId` を受け取った tool は、保存済み fix を解決し、再検証し、通常の
guarded path で実行する。

### 3.4 明示的なエスカレーション

サーバーが安全に解決できない場合、モデルを conscious perception に戻す。

- `screenshot`
- `get_windows`
- `get_context`
- `browser_get_interactive`
- manual lens に対する `perception_read`

unsafe action の前に fail し、短く具体的な next step を返す。

## 4. ActionTarget 推論

`ActionTarget` は内部表現である。LLM が直接この object を渡すことはない。

```ts
type ActionKind =
  | "keyboard"
  | "mouseClick"
  | "mouseDrag"
  | "uiaInvoke"
  | "uiaSetValue"
  | "browserCdp";

type ActionTargetDescriptor =
  | { kind: "window"; titleIncludes: string }
  | {
      kind: "browserTab";
      tabId?: string;
      port: number;
      urlIncludes?: string;
      titleIncludes?: string;
    }
  | { kind: "coordinate"; x: number; y: number; windowTitle?: string };

type ActionGuardSummary = {
  status:
    | "ok"
    | "unguarded"
    | "ambiguous_target"
    | "target_not_found"
    | "identity_changed"
    | "blocked_by_modal"
    | "unsafe_coordinates"
    | "browser_not_ready"
    | "needs_escalation";
  canContinue: boolean;
  target?: string;
  next: string;
};
```

### 4.1 Window Target

入力:

- `windowTitle`
- `elementName` / `elementId` with `windowTitle`
- `name` / `automationId` with `windowTitle`
- `focus_window` の `chromeTabUrlContains`

解決手順:

1. visible top-level windows を列挙する。
2. active な matching window を優先する。
3. それ以外では、matching window が1つなら採用する。
4. 複数 window が一致した場合:
   - keyboard / UIA action は fail closed;
   - mouse action は、final coordinate が一致候補のうちちょうど1つの window
     内にある場合のみ続行できる。
5. current window identity を構築する:
   - HWND
   - PID
   - process name
   - process start time
   - resolved title
   - rect
   - foreground state
   - modal state

### 4.2 Browser Target

入力:

- `tabId`
- active CDP tab
- `port`
- URL / title hints
- CDP tab に scope された selector action

解決手順:

1. `tabId` があれば、その exact tab に bind する。
2. URL / title matching が1候補なら bind する。
3. それ以外では browser-only action に限り active / first CDP page tab を使う。
4. browser-tab identity だけで OS keyboard input を許可してはいけない。OS
   keyboard tool では browser window foreground の検証も必要である。

browser readiness は action-sensitive に扱う。

- `browser_navigate` では navigation 後の readiness が重要。
- `browser_eval` では loaded page に依存する read なら readiness を強めに見る。
- `browser_click_element` では selector が解決済みで viewport 内にあるなら、
  `readyState !== "complete"` は block ではなく warning から始めてもよい。

### 4.3 Coordinate Target

入力:

- `origin` / `scale` 変換後の final screen coordinates
- homing 後の final coordinates
- optional `windowTitle`
- current window list

解決手順:

1. image-local coordinates を screen coordinates へ変換する。
2. homing correction を適用する。
3. final coordinate を含む top-level window を推論する。
4. `windowTitle` があれば、含有 window がその title に一致することを要求する。
5. coordinate-only target は action-scoped とし、`windowTitle` がない限り cache
   しない。

これは重要な順序修正である。guard evaluation は stale input coordinate では
なく、変換と homing を経た final coordinate を検証しなければならない。

## 5. Action 別 Guard Policy

### 5.1 Keyboard

`keyboard_type` と `keyboard_press`:

1. explicit `lensId` があれば既存 pinned-lens guard を使う。
2. `windowTitle` があれば:
   - window target を解決する;
   - 既存 tool と同じように target を focus する;
   - foreground identity を refresh する;
   - `safe.keyboardTarget` を guard する。
3. それ以外では既存挙動を維持しつつ、次を返す。

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

明示的な target hint なしで、現在 active な window を keyboard target として
自動 bind してはいけない。それでは wrong-window typing を防げない。

### 5.2 Mouse Click / Drag

`mouse_click` の Phase A 順序:

1. `origin` / `scale` による image-local coordinates を screen coordinates に
   変換する。
2. homing correction を適用する。
3. final coordinates と optional `windowTitle` から target を推論する。
4. final coordinate に対して `target.identityStable`, `stable.rect`,
   `safe.clickCoordinates` を評価する。
5. click を実行する。
6. focus / window movement を post-check する。
7. compact `post.perception` を添付する。

`mouse_drag` も start point に同じ target resolution を適用し、同じ delta を
end point に適用する。safety-critical なのは mouse down する start point で
ある。

### 5.3 UIA Named Actions

`click_element` と `set_element_value`:

1. `windowTitle` を解決する。
2. target identity と modal obstruction を guard する。
3. UIA action を実行する。
4. compact result を添付する。

これらは pixel click より意味論的に強い tool なので、native app では
引き続き description 上も優先する。

### 5.4 Browser CDP Actions

`browser_click_element`, `browser_eval`, `browser_navigate`:

1. target tab を解決する。
2. URL / title / readyState を refresh する。
3. action kind に応じて tab identity / readiness を guard する。
4. CDP / mouse action を実行する。
5. response shape が許す範囲で URL / title / readyState changes を添付する。

`browser_eval` は現状 raw text を返す。Phase A では full `post.perception` を
添付せず guard のみ実行してよい。必要なら後続 phase で互換性を壊さない
compact status line を追加する。

## 6. 3段階メモリ戦略

この memory model は、1つの cache に3つの名前を付けたものではない。それぞれ
責務と rebinding semantics が異なる。

### 6.1 Reflexive Memory: HotTargetCache

目的: 次の action のための短期安全補助。

Lifetime:

- idle TTL: 90 seconds
- hard TTL: 10 minutes
- bad/failed target TTL: 15 seconds
- max slots: 6

保持フィールド:

```ts
interface HotTargetSlot {
  key: string;
  kind: "window" | "browserTab";
  descriptor: ActionTargetDescriptor;
  identity?: WindowIdentity | BrowserTabIdentity;
  lastRect?: { x: number; y: number; width: number; height: number };
  lastUsedAtMs: number;
  createdAtMs: number;
  useCount: number;
  attention:
    | "ok"
    | "changed"
    | "dirty"
    | "stale"
    | "identity_changed"
    | "not_found"
    | "ambiguous";
}
```

Rules:

- モデルには見せない。
- identity-bound ではなく descriptor-bound。
- 各 action で再解決する。
- TTL はモデル action がその target を使った時だけ延長する。
- background sensor activity で TTL を延長しない。
- coordinate-only target は cache しない。
- manual lens budget を消費しない。

同じ descriptor が単一の高信頼 target に解決できるなら、slot は identity を
更新して続行してよい。ambiguous または missing になった場合は unsafe action
の前に fail する。

### 6.2 Attentional Memory: Manual Lens

目的: workflow または debugging session のための明示的な pinned attention。

実装: 既存の `perception_register`, `perception_read`, `perception_forget`,
`perception_list`。

Rules:

- model / user が明示的に作る。
- identity-bound。
- identity change では fail closed。
- 自動 rebind しない。
- HotTargetCache churn の影響を受けない。
- manual lens の上限は当初16のまま。
- 後続改善として FIFO eviction を LRU / touch semantics に置き換える。

manual lens は、呼び出し側が1つの exact HWND / tab identity を多くの action に
渡って pin したい場合に使う。

### 6.3 Episodic Memory: Target-Identity Timeline

目的: target の lifetime 上で何が起きたかを意味論的に想起する。

これは単なる `get_history` ではない。target identity と descriptor で key された、
意味のある event timeline である。LLM は以下を思い出せるようになる。

- "Save をクリックした"
- "その同じ target の title が変わった"
- "その target の上に modal が現れた"
- "この tab で navigation が起きた"
- "前の target が閉じ、別 identity に置き換わった"

timeline は compressed semantic facts を保存する。raw screenshot、完全な
`post` block、full perception envelope は保存しない。

```ts
type TargetIdentityTimelineEvent = {
  eventId: string;
  tsMs: number;
  targetKey: string;
  identity: WindowIdentity | BrowserTabIdentity;
  descriptor?: ActionTargetDescriptor;
  source: "action_guard" | "manual_lens" | "post_check" | "sensor";
  semantic:
    | "target_bound"
    | "action_attempted"
    | "action_succeeded"
    | "action_blocked"
    | "title_changed"
    | "rect_changed"
    | "foreground_changed"
    | "navigation"
    | "modal_appeared"
    | "modal_dismissed"
    | "identity_changed"
    | "target_closed";
  summary: string;
  tool?: string;
  result?: "ok" | "blocked" | "failed";
};
```

Retention:

- default は session duration;
- target ごとに bounded ring;
- unbounded memory を防ぐ global cap;
- 古い events は summaries に compact できる。

Exposure:

- `get_history` は target keys と短い semantic summaries を含められる。
- `perception_read(lensId)` はその target の recent timeline events を含められる。
- MCP resources は将来的に `perception://target/{targetKey}/timeline` または
  session-level recent-targets resource を、既存 resource flag 配下で公開できる。

重要なのは、episodic memory が semantic かつ target-scoped であること。stale
coordinates や、前回 screenshot の曖昧な言語記憶に頼らず、action の結果を
推論できるようにする。

## 7. SuggestedFix と fixId 承認

### 7.1 SuggestedFix Shape

guard が復旧可能な action を block した場合、サーバーは以下を返せる。

```ts
type SuggestedFix = {
  fixId: string;
  tool: "mouse_click" | "keyboard_type" | "browser_click_element" | "click_element";
  args: Record<string, unknown>;
  targetFingerprint: {
    kind: "window" | "browserTab";
    descriptorKey: string;
    hwnd?: string;
    pid?: number;
    processStartTimeMs?: number;
    tabId?: string;
    url?: string;
  };
  createdAtMs: number;
  expiresAtMs: number;
  reason: string;
};
```

失敗例:

```json
{
  "ok": false,
  "code": "UnsafeCoordinates",
  "post": {
    "perception": {
      "status": "unsafe_coordinates",
      "canContinue": false,
      "next": "Approve the suggested fix or take a new screenshot"
    }
  },
  "suggestedFix": {
    "fixId": "fix-abc123",
    "tool": "mouse_click",
    "args": { "x": 1024, "y": 512, "windowTitle": "Notepad" },
    "expiresAtMs": 1776420000000,
    "reason": "Target window moved by +120,-8 after the screenshot"
  }
}
```

### 7.2 既存 tool parameter による承認

Phase C では、選択した action tools に `fixId` を追加することを検討する。

```ts
mouse_click({ fixId: "fix-abc123" })
```

実行ルール:

1. `fixId` が存在し、TTL 内である。
2. 呼ばれた tool が `SuggestedFix.tool` と一致する。
3. target fingerprint が現在も一致する、または安全に再解決できる。
4. 保存済み args を通常の `ActionGuard` に再投入する。
5. fix は one-shot であり、使用後に consume する。
6. revalidation に失敗した場合、action は実行しない。
7. response は fix が approved / consumed / expired / rejected のどれかを示す。

初期 scope:

- まず `mouse_click({ fixId })` から始める。
- click approval が安定するまで keyboard approval は defer する。
- 初期設計では separate approval tool を追加しない。

これにより、「approve and continue」という agent experience を保ちながら、
通常 action と同じ pre-action safety guarantees を維持できる。

## 8. Post Response Shape

default `post.perception` は compact かつ actionable でなければならない。

Success:

```json
{
  "post": {
    "perception": {
      "status": "ok",
      "target": "window:Notepad",
      "canContinue": true,
      "next": "continue"
    }
  }
}
```

Ambiguous target:

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

Unguarded keyboard action:

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

詳細 evidence は `perception_read`、debug resources、または将来の timeline
resources に残す。

## 9. Implementation Roadmap

### Phase A: ActionGuard Middleware

Goals:

- action tool handler の下に hidden `ActionGuard` を追加する。
- manual `lensId` behavior は維持する。
- HotTargetCache はまだ導入しない。
- `fixId` はまだ導入しない。

Initial integrations:

- `keyboard_type`
- `keyboard_press`
- `mouse_click`
- `mouse_drag`
- `click_element`
- `set_element_value`
- `browser_click_element`
- `browser_navigate`

Critical Phase A fix:

- `mouse_click` guard は `origin` / `scale` 変換と homing の後、final click
  coordinate を使って実行する。

### Phase B: Hidden HotTargetCache

Goals:

- descriptor-bound の短期 slots を追加する。
- repeated actions 間で target identity / rect / title の変化を検知する。
- compact な `changed` / `identity_changed` summaries を返す。
- action gating は引き続き fresh synchronous reads に基づける。

全ての hot target を registry lens で裏打ちしない。必要性が performance profile
で示されるまでは、hidden cache として扱う。

### Phase C: SuggestedFixStore And fixId Approval

Goals:

- bounded in-memory `SuggestedFixStore` を追加する。
- recoverable guard failures に `suggestedFix` を返す。
- まず `mouse_click({ fixId })` を実装する。
- 実行前に revalidate する。
- fix は one-shot consume する。

Keyboard `fixId` support は、mouse approval behavior が安定するまで明示的に
defer する。

### Phase D: Target-Identity Timeline

Goals:

- semantic target-scoped timeline events を追加する。
- action attempts, successes, blocks, title changes, navigation, modal
  transitions, identity changes, target closure を記録する。
- `get_history` と `perception_read` から recent target events を公開する。
- 必要なら resource flags 配下で timeline resources を公開する。

timeline は compressed facts を保存する。raw envelopes は保存しない。

### Phase E: Manual Lens Cleanup And Prompt Surface

Goals:

- manual lenses を use 時に touch する。
- FIFO eviction を LRU に置き換える。
- `MAX_MANUAL_LENSES = 16` は維持する。
- action tool descriptions を automatic guarding 前提へ更新する。
- `perception_register` の説明を advanced/debug/pinned-target 用に下げる。

description 方針例:

```text
Normally omit lensId. When you pass windowTitle, selector, tabId, or recent
screenshot coordinates, desktop-touch automatically guards the action and
returns post.perception. Use lensId only when you have registered a pinned
perception lens for advanced tracking.
```

## 10. Implementation Source Map

この章は設計を現行ソースツリーへ対応付ける。行番号は本ドキュメント作成時点の
もの。

### 10.1 最優先 Phase A 修正

最初の Phase A 変更は `src/tools/mouse.ts` にある。

- `src/tools/mouse.ts:295` — `mouseClickHandler` の開始位置。
- `src/tools/mouse.ts:308` — 現在の `lensId` perception guard 評価位置。
- `src/tools/mouse.ts:319` — `origin` / `scale` による image-local coordinates
  の変換開始位置。
- `src/tools/mouse.ts:339` — `applyHoming()` の実行位置。ここで final click
  coordinates が決まる。
- `src/tools/mouse.ts:380` — 成功時に current `buildEnvelopeFor()` payload を
  構築している位置。

現在の順序:

```text
guard(x,y) -> origin/scale conversion -> homing -> click
```

Phase A で必要な順序:

```text
origin/scale conversion -> homing -> guard(final tx,ty) -> click
```

guard は stale input coordinate ではなく、変換と homing 後の final coordinate
を検証しなければならない。

### 10.2 Action Tool Integration Points

提案する `src/tools/_action-guard.ts` は、以下の既存 handlers から呼び出す。

Keyboard:

- `src/tools/keyboard.ts:184` — `keyboardTypeHandler`。
- `src/tools/keyboard.ts:208` — 現在の `keyboard_type` explicit `lensId` guard。
- `src/tools/keyboard.ts:221` — `focusWindowForKeyboard()` の実行位置。automatic
  keyboard guard はこの後に foreground を検証する。
- `src/tools/keyboard.ts:279` — `keyboardPressHandler`。
- `src/tools/keyboard.ts:297` — 現在の `keyboard_press` explicit `lensId` guard。

Mouse:

- `src/tools/mouse.ts:295` — `mouseClickHandler`。
- `src/tools/mouse.ts:394` — `mouseDragHandler`。
- `src/tools/mouse.ts:417` — drag homing path。start point が safety-critical な
  mouse-down coordinate である。

UIA named actions:

- `src/tools/ui-elements.ts:77` — `clickElementHandler`。
- `src/tools/ui-elements.ts:85` — 現在の `click_element` explicit `lensId` guard。
- `src/tools/ui-elements.ts:109` — `setElementValueHandler`。
- `src/tools/ui-elements.ts:117` — 現在の `set_element_value` explicit `lensId`
  guard。

Browser actions:

- `src/tools/browser.ts:503` — `browserClickElementHandler`。
- `src/tools/browser.ts:518` — 現在の `browser_click_element` explicit `lensId`
  guard。
- `src/tools/browser.ts:604` — `browserEvalHandler`。
- `src/tools/browser.ts:619` — 現在の `browser_eval` explicit `lensId` guard。
- `src/tools/browser.ts:690` — `browserNavigateHandler`。
- `src/tools/browser.ts:709` — 現在の `browser_navigate` explicit `lensId` guard。

### 10.3 再利用する既存 Perception Core

automatic guards は既存 perception logic を再利用する。ただし、automatic target
を全て manual lens registry に登録してはいけない。

- `src/engine/perception/registry.ts:621` — `evaluatePreToolGuards()`。現在の
  explicit `lensId` guard entry point。
- `src/engine/perception/registry.ts:662` — `buildEnvelopeFor()`。現在の manual
  lens envelope projection。
- `src/engine/perception/registry.ts:696` — `readLens()`。explicit refresh と
  envelope read。
- `src/engine/perception/guards.ts:21` — `GuardContext`。
- `src/engine/perception/guards.ts:98` — `evalKeyboardTarget()`。
- `src/engine/perception/guards.ts:202` — `evalClickCoordinates()`。
- `src/engine/perception/guards.ts:367` — `evalBrowserReady()`。
- `src/engine/perception/guards.ts:404` — `evaluateGuard()`。
- `src/engine/perception/guards.ts:420` — `evaluateGuards()`。
- `src/engine/perception/types.ts:19` — `WindowIdentity`。
- `src/engine/perception/types.ts:141` — `LensSpec`。
- `src/engine/perception/types.ts:154` — `BrowserTabIdentity`。
- `src/engine/perception/types.ts:166` — `PerceptionLens`。
- `src/engine/perception/types.ts:224` — `PerceptionEnvelope`。

### 10.4 Target Resolution And Refresh Helpers

`ActionTarget` 推論に使える既存 helper:

- `src/engine/perception/lens.ts:73` — `resolveBindingFromSnapshot()`。既存の
  title-to-window binding logic。
- `src/engine/perception/lens.ts:92` — `resolveBrowserTabBindingFromTabs()`。
  既存の browser tab matching logic。
- `src/engine/perception/lens.ts:111` — `buildBrowserTabIdentity()`。
- `src/engine/perception/sensors-win32.ts:123` — `refreshWin32Fluents()`。
  identity, foreground, rect, modal state の synchronous window refresh。
- `src/engine/perception/sensors-win32.ts:193` — `buildWindowIdentity()`。
- `src/engine/window-cache.ts:76` — `findContainingWindow()`。coordinate target
  inference に使える。
- `src/engine/window-cache.ts:95` — `getCachedWindowByTitle()`。
- `src/engine/window-cache.ts:114` — `computeWindowDelta()`。既存 homing
  primitive。
- `src/engine/identity-tracker.ts:101` — `observeTarget()`。
- `src/engine/identity-tracker.ts:266` — `buildHintsForTitle()`。

### 10.5 Suggested New Files

推奨する新規 modules:

- `src/tools/_action-guard.ts` — tool-facing action-guard モジュール。
  主エントリは `runActionGuard()` で、Phase A の全 handler
  (mouse / keyboard / ui-elements / browser) から直接呼び出す。これにより
  各 handler が独自順序 (mouse: 変換 → homing → guard → click) と
  `lensId` 分岐を自然に維持できる。`withActionGuard<T>()` は middleware
  ラッパーとして export を残し、Phase B (HotTargetCache) や Phase E
  (prompt surface) での将来利用と、`tests/unit/action-guard.test.ts` が
  検証する guard 契約の参照実装として保持する。Phase A では どの handler
  からも `withActionGuard` を呼ばない。
- `src/engine/perception/action-target.ts` — `windowTitle`, `tabId`,
  selector context, final coordinates から target を推論する。
- `src/engine/perception/hot-target-cache.ts` — Phase B hidden descriptor-bound
  target cache。
- `src/engine/perception/suggested-fix-store.ts` — Phase C TTL-bound one-shot
  `fixId` store。
- `src/engine/perception/target-timeline.ts` — Phase D Target-Identity Timeline。

### 10.6 History And Timeline Integration

Target-Identity Timeline は full envelopes ではなく semantic facts を保存する。

- `src/tools/_post.ts:44` — `HistoryEntry`。
- `src/tools/_post.ts:60` — `recordHistory()`。
- `src/tools/_post.ts:65` — `getHistorySnapshot()`。
- `src/tools/_post.ts:170` — 現在、history bloat を避けるために `rich` と
  `perception` を history から取り除いている。Timeline では compressed
  semantic facts のみ保持する。
- `src/tools/context.ts:192` — `get_history` response。
- `src/tools/perception.ts:138` — `perceptionReadHandler`。Phase D で recent
  target timeline events を含める候補。

### 10.7 Manual Lens Cleanup Points

manual lens cleanup は automatic guard work とは分離する。

- `src/engine/perception/registry.ts:79` — `MAX_LENSES = 16`。
- `src/engine/perception/registry.ts:269` — `evictOldestIfNeeded()`。現在は
  insertion order で evict する。
- `src/engine/perception/registry.ts:490` — `registerLens()`。
- `src/engine/perception/registry.ts:551` — `registerLensAsync()`。

Phase E では、HotTargetCache と結合せずに touch / LRU behavior を追加できる。

## 11. Tests

### Unit

- `windowTitle` からの target inference。
- ambiguous `windowTitle` が keyboard / UIA を block する。
- coordinate-only target が cache されない。
- `mouse_click` guard が final converted / homed coordinates を検証する。
- HotTargetCache TTL, bad TTL, hard TTL, LRU。
- manual lens budget が hot target churn の影響を受けない。
- browserTab target が OS keyboard tools を許可しない。
- SuggestedFix TTL と one-shot consume。
- `fixId` が mismatched tool names を reject する。
- Target-Identity Timeline が target ごとの semantic events を compact する。

### E2E

- `keyboard_type(windowTitle)` が `lensId` なしで `post.perception` を返す。
- `keyboard_type` without `windowTitle` が `unguarded` を返す。
- ambiguous title が typing 前に fail する。
- `mouse_click(windowTitle, origin, scale)` が final coordinates を guard する。
- repeated actions が hot target summaries 経由で target title / rect changes を返す。
- `mouse_click` が recoverable `suggestedFix` を受け取る。
- `mouse_click({ fixId })` が revalidate して fix を consume する。
- manual `lensId` workflows が従来通り動く。
- `perception_read(lensId)` が recent semantic target events を想起できる。

## 12. Open Design Decisions

1. Default-on timing:
   - auto guard を即 default-on で ship するか、
     rollback switch として `DESKTOP_TOUCH_AUTO_GUARD=0` を追加するか。

2. Ambiguous title policy:
   - keyboard / UIA は fail closed;
   - mouse は final coordinates がちょうど1つの matching target を特定できる時
     のみ続行可能。

3. Browser readiness policy:
   - browser tool ごとに `readyState !== "complete"` を block にするか warning
     にするかを決める。

4. Timeline resource surface:
   - 最初は `get_history` と `perception_read` から始める。
   - event model が安定してから MCP resources を追加する。

5. Keyboard fix approval:
   - mouse fix approval が安全に動くことを確認するまで defer する。

## 13. 最終プロダクトルール

LLM が perception internals を覚える必要があってはならない。

Default:

```text
Pass a target hint to the normal action tool. The server handles perception.
```

Advanced:

```text
Use perception_register only when you need to pin a specific identity or debug
the perception layer.
```
