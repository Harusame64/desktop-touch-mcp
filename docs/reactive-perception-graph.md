# Reactive Perception Graph

LLM-facing desktop perception algorithm for desktop-touch-mcp.

This document defines the final design for change-detection-driven situational awareness in MCP. The goal is not to add another polling API. The goal is to give the MCP server an external working memory that keeps the LLM's relevant assumptions alive across actions.

## Summary

`Reactive Perception Graph` (RPG) is a demand-driven, self-adjusting perception layer.

The stronger framing is:

```text
LLM desktop automation needs a sensorimotor substrate, not just more tools.
```

RPG is intended to become that substrate. It is the layer that keeps task-relevant perception, proprioception, reflexes, and safety constraints alive while the LLM performs higher-level reasoning.

Instead of:

```text
LLM calls screenshot/get_context
LLM remembers the result internally
LLM later calls another tool and hopes the world is still the same
```

RPG changes the loop to:

```text
LLM registers what it cares about
MCP maintains only the dependent perception state
MCP evaluates safety guards before actions
MCP attaches perception updates to tool responses
LLM explicitly reads state only when uncertainty exceeds budget
```

The key distinction is that the registered object is not an event subscription. It is a standing perception query: a tracked target, its relevant fluents, and the guards that make future actions safe.

## Sensorimotor Framing

Current MCP desktop automation resembles this:

```text
LLM = cortex
MCP tools = eyes and hands
LLM repeatedly asks to see, decides, then moves
```

RPG changes the architecture to:

```text
LLM = cortex
RPG = peripheral nervous system + proprioception + reflex arc + attention system
MCP tools = eyes and hands
```

Humans do not visually re-confirm every detail before every small motor action. A lower-level sensorimotor system keeps short-lived body/world state active: hand position, object location, contact risk, obstruction, and whether the current movement remains safe.

RPG applies the same idea to desktop automation:

| RPG concept | Nervous-system analogue |
|---|---|
| `Fluent` | Proprioceptive/world state. |
| `Evidence` | Sensory input and its reliability. |
| `PerceptionLens` | Attention directed at a task-relevant target. |
| `Guard` | Reflex/safety predicate before action. |
| `Perception Envelope` | Sensory feedback returned to the cortex. |
| `Sensor Escalation` | Use cheap senses first; look harder only when needed. |
| `Truth Maintenance` | Reconcile conflicting sensory evidence. |

This framing is important because it changes the design target. The goal is not "faster screenshots" or "better polling". The goal is to give the LLM an external sensorimotor organ that preserves task-relevant assumptions across action boundaries.

## Design Goal

RPG should reduce repeated observe-act-confirm cycles without eagerly capturing large screenshots or traversing entire UI trees.

The server should answer questions like:

- Is the target window still the same entity?
- Is it still safe to type into the target?
- Did a modal appear above the target?
- Are the click coordinates still valid after window movement?
- Did the target's relevant state change since the LLM last saw it?
- Is the current cached belief reliable enough, or should the server escalate to UIA, CDP, OCR, or screenshot?

These answers should be available in ordinary tool responses whenever possible, not only through a separate `observe_read` call.

## Non-Goals

- RPG is not a full desktop recorder.
- RPG is not a screenshot cache.
- RPG is not a raw event stream API.
- RPG does not keep every UIA tree fresh.
- RPG does not assume Win32, UIA, CDP, and image sensors have the same reliability or latency.

## Core Idea

RPG treats the desktop as a set of time-varying facts called fluents.

Examples:

```text
window:123.title = "main.ts - Visual Studio Code"
window:123.rect = { x: 0, y: 0, width: 1600, height: 1000 }
window:123.foreground = true
window:123.identity = { hwnd, pid, processStartTime, className }
focus.activeWindow = window:123
modal.above(window:123) = false
browser:tabA.readyState = "complete"
```

Sensors produce observations. Observations update fluents. Perception lenses depend on fluents. Guards evaluate whether a future operation is safe.

```text
Raw sensors
  -> Observations
  -> Fluent store with evidence
  -> Dependency graph
  -> Perception lenses
  -> Guards
  -> Tool response envelope / resource update / explicit read
```

## Algorithm Name

The proposed algorithm is `Reactive Perception Graph`.

The name is intentional:

- `Reactive`: changes push dirty marks through the graph.
- `Perception`: the output is what the agent needs to perceive, not raw OS events.
- `Graph`: dependencies are explicit, incremental, and reusable.

## Conceptual Foundations

RPG combines several established ideas.

| Idea | Role in RPG |
|---|---|
| Event Calculus | Separate events from time-varying fluents. |
| Self-adjusting computation | Recompute only outputs affected by changed inputs. |
| Demand-driven incremental computation | Keep only requested perceptions alive. |
| Rete-style matching | Match many standing lenses against many changing facts efficiently. |
| Truth Maintenance System | Store beliefs with evidence and revise them when sensors disagree. |
| Push-pull FRP | Push dirty signals, pull expensive values only when needed. |

This combination matters because desktop automation has asymmetric costs. Win32 metadata is cheap. UIA focus is medium-cost. UIA tree, OCR, and screenshots are expensive. A pure push system would do too much work. A pure pull system would keep the current LLM round-trip problem. RPG uses push for invalidation and pull for expensive materialization.

## Data Model

### EntityRef

An entity is anything the server can track.

```ts
type EntityRef =
  | { kind: "window"; id: string }
  | { kind: "browserTab"; id: string }
  | { kind: "uiaElement"; id: string }
  | { kind: "cursor"; id: "cursor" }
  | { kind: "modal"; id: string };
```

For windows, the runtime row key can be `hwnd`, but identity must be stronger than `hwnd`.

```ts
type WindowIdentity = {
  hwnd: string;
  pid: number;
  processStartTime?: number;
  processName: string;
  className?: string;
  titleFingerprint?: string;
};
```

If the same `hwnd` appears with a different process identity, RPG treats it as identity invalidation, not an ordinary update.

### Observation

An observation is a sensor report.

```ts
type Observation = {
  seq: number;
  tsMs: number;
  source: "win32" | "uia" | "cdp" | "image" | "ocr" | "inferred";
  entity: EntityRef;
  property: string;
  value: unknown;
  confidence: number;
  evidence: Evidence;
};
```

Observations are not directly exposed to the LLM except during debugging. They are normalized into fluents.

### Evidence

Evidence records why the server believes a fluent.

```ts
type Evidence = {
  source: "win32" | "uia" | "cdp" | "image" | "ocr" | "inferred";
  observedAtSeq: number;
  observedAtMs: number;
  cost: "cheap" | "medium" | "expensive";
  ttlMs?: number;
  notes?: string[];
};
```

Evidence is necessary because UIA, CDP, Win32, and image sensors can disagree or become stale at different rates.

### Fluent

A fluent is the maintained current belief about a property.

```ts
type Fluent = {
  entity: EntityRef;
  property: string;
  value: unknown;
  validFromSeq: number;
  validToSeq?: number;
  confidence: number;
  support: Evidence[];
  contradictions: Evidence[];
  status: "observed" | "inferred" | "dirty" | "stale" | "contradicted" | "invalidated";
};
```

Examples:

```text
window:123.rect
window:123.foreground
window:123.zOrder
window:123.title
window:123.identity
focus.activeWindow
target.editor.focusedElement
modal.above(target.editor)
browser.activeTab.readyState
```

### PerceptionLens

A lens is the LLM's registered interest.

```ts
type PerceptionLens = {
  id: string;
  name: string;
  bind: Record<string, EntitySelector>;
  maintain: FluentSelector[];
  guards: GuardSpec[];
  delivery: DeliverySpec;
  budget: PerceptionBudget;
  salience: "critical" | "normal" | "background";
};
```

Example:

```json
{
  "name": "target-editor",
  "bind": {
    "target": {
      "kind": "window",
      "match": { "titleIncludes": "Visual Studio Code" },
      "identity": "hwnd+pid+processStartTime"
    }
  },
  "maintain": [
    "target.exists",
    "target.identity",
    "target.title",
    "target.rect",
    "target.foreground",
    "target.zOrder",
    "target.focusedElement",
    "modal.above(target)"
  ],
  "guards": [
    "safe.keyboardTarget(target)",
    "safe.clickCoordinates(target)",
    "stable.rect(target, 250ms)"
  ],
  "delivery": {
    "toolEnvelope": true,
    "resource": true,
    "notifyOn": ["guardChanged", "identityChanged", "attentionChanged"]
  },
  "budget": {
    "maxEnvelopeTokens": 120,
    "maxEagerCost": "uia-focus",
    "image": "never-unless-requested"
  },
  "salience": "critical"
}
```

### Guard

A guard is a maintained safety predicate.

```ts
type GuardResult = {
  id: string;
  ok: boolean;
  confidence: number;
  reason?: string;
  evidence: Evidence[];
  suggestedAction?: "continue" | "focus" | "refresh" | "ask" | "screenshot" | "block";
};
```

Core guards:

| Guard | Purpose |
|---|---|
| `target.exists` | The tracked entity has not disappeared. |
| `target.identityStable` | HWND/PID/process identity still matches. |
| `safe.keyboardTarget(target)` | Keyboard input will reach the intended target. |
| `safe.clickCoordinates(target, x, y)` | Coordinates still refer to the same target. |
| `stable.rect(target, ms)` | Window geometry has not changed recently. |
| `modal.above(target)` | No modal/topmost dialog blocks the target. |
| `browser.ready(target)` | Browser document is ready enough for DOM action. |

## Runtime Algorithm

### Register Lens

```ts
function registerLens(spec: PerceptionLensSpec): RegisteredLens {
  const lens = compileLens(spec);
  const bindings = resolveInitialBindings(lens.bind);
  const initialFluents = materializeWithinBudget(lens, bindings);

  dependencyGraph.add(lens, initialFluents.dependencies);
  matcher.add(lens.selectors);
  fluentStore.apply(initialFluents);

  return {
    lensId: lens.id,
    seq: fluentStore.seq,
    digest: digestLensAnswer(lens),
  };
}
```

### Ingest Observation

```ts
function ingest(observations: Observation[]): void {
  const facts = observations.flatMap(normalizeObservation);
  const deltas = reconcileWithTruthMaintenance(facts, fluentStore);

  fluentStore.apply(deltas);

  const affected = dependencyGraph.lookup(deltas);
  for (const lens of affected) {
    markDirty(lens, deltas);

    if (shouldEagerlyRefresh(lens, deltas)) {
      refreshAffectedNodesOnly(lens, deltas);
    }

    if (shouldEnqueueDelivery(lens, deltas)) {
      enqueuePerceptionEnvelope(lens, deltas);
    }
  }
}
```

### Tool Execution

```ts
async function runToolWithPerception(toolName: string, args: unknown) {
  const relevant = selectRelevantLenses(toolName, args);

  for (const lens of relevant) {
    await refreshCriticalDirtyNodes(lens);
    const guard = evaluatePreToolGuards(lens, toolName, args);

    if (!guard.ok && guard.suggestedAction === "block") {
      return blockedToolResult(toolName, guard);
    }

    if (!guard.ok && guard.suggestedAction === "focus") {
      await applySafeCorrection(guard);
    }
  }

  const result = await runTool(toolName, args);

  const envelope = buildPerceptionEnvelope(relevant, {
    maxTokens: envelopeBudget(toolName, args),
  });

  return attachPerceptionEnvelope(result, envelope);
}
```

### Explicit Read

```ts
async function perceptionRead(req: PerceptionReadRequest) {
  const lens = getLens(req.lensId);

  if (lens.dirty) {
    await refreshWithinBudget(lens, req.budgetOverride);
  }

  return {
    lensId: lens.id,
    seq: fluentStore.seq,
    answer: projectLensAnswer(lens, req.projection),
    changesSince: summarizeChanges(lens, req.sinceSeq),
    guards: evaluateGuards(lens),
    confidence: summarizeConfidence(lens),
  };
}
```

## Push-Pull Policy

RPG separates invalidation from materialization.

| Operation | Policy | Reason |
|---|---|---|
| Win32 foreground/title/rect/z-order | Eager push | Cheap and safety-critical. |
| CDP URL/title/readyState | Eager push when connected | Cheap after session exists. |
| Cursor position | Optional push with debounce | High-frequency and noisy. |
| UIA focused element | Eager only for critical lenses | Medium cost and useful for keyboard safety. |
| UIA subtree | Lazy pull | Expensive and often unnecessary. |
| OCR words | Lazy pull | Expensive and language-dependent. |
| Screenshot/image hash | Dirty bit first, image only on demand | Large payload. |

This is the core algorithmic compromise, but it is not an API compromise. The graph is reactive; only expensive values are materialized lazily.

## Perception Envelope

The primary delivery mechanism is a small block attached to ordinary tool responses.

Example:

```json
{
  "ok": true,
  "post": {
    "focusedWindow": "main.ts - Visual Studio Code",
    "windowChanged": false
  },
  "perception": {
    "seq": 913,
    "lens": "target-editor",
    "attention": "ok",
    "changed": [
      "target.focusedElement changed"
    ],
    "guards": {
      "target.exists": true,
      "target.identityStable": true,
      "safe.keyboardTarget": true,
      "modal.above": false
    },
    "latest": {
      "target": {
        "title": "main.ts - Visual Studio Code",
        "rect": { "x": 0, "y": 0, "width": 1600, "height": 1000 },
        "foreground": true,
        "confidence": 0.98
      }
    }
  }
}
```

This is what removes a round trip in the common case. The LLM does not need to call `get_context` after every action if the relevant perception envelope already says the target, guards, and important changed fluents are valid.

## Attention State

Each lens produces an attention state.

```ts
type AttentionState =
  | "ok"
  | "changed"
  | "dirty"
  | "stale"
  | "guard_failed"
  | "identity_changed"
  | "needs_escalation";
```

Meaning:

| State | Meaning |
|---|---|
| `ok` | Maintained fluents are fresh enough and guards pass. |
| `changed` | Something meaningful changed, but guards still pass. |
| `dirty` | A dependency changed and has not been fully refreshed. |
| `stale` | Required evidence exceeded TTL. |
| `guard_failed` | A safety predicate failed. |
| `identity_changed` | The tracked entity is no longer the same target. |
| `needs_escalation` | Cheap sensors cannot answer with enough confidence. |

## Sensor Escalation

RPG uses a cost ladder.

```text
Level 0: cached fluent
Level 1: Win32 cheap refresh
Level 2: CDP or UIA focused-element refresh
Level 3: UIA subtree or browser interactive list
Level 4: OCR / image hash / screenshot diff
Level 5: full screenshot image
```

Escalation is controlled by lens budget and guard criticality.

Example for `keyboard_type`:

```text
Need safe.keyboardTarget(target)
  -> use cached foreground fluent if fresh
  -> if dirty, refresh active window via Win32
  -> if target foreground true, optionally refresh focused element via UIA/CDP
  -> if modal/topmost uncertainty exists, refresh modal candidates
  -> if still uncertain, block or ask for explicit refresh
```

Example for `mouse_click(x, y)`:

```text
Need safe.clickCoordinates(target, x, y)
  -> check cached target rect and z-order
  -> refresh target rect via Win32 if stale or dirty
  -> if rect moved, apply homing correction
  -> if another top-level window covers point, block or refocus
  -> if target identity changed, invalidate coordinates
```

## MCP Surface

RPG should expose MCP tools and resources, but tools are not the core abstraction.

### Tools

```ts
perception_register(spec) -> { lensId, seq, digest }
perception_read({ lensId, sinceSeq?, projection?, maxTokens? }) -> PerceptionReadResult
perception_forget({ lensId }) -> { removed: boolean }
perception_list() -> { lenses: LensSummary[] }
```

### Resources

Potential resource URIs:

```text
desktop://perception
desktop://perception/{lensId}
desktop://perception/{lensId}/guards
desktop://perception/{lensId}/changes
```

Resource subscription can be used to notify the host that a lens changed. The tool response envelope remains the main round-trip reducer because it piggybacks information onto actions the LLM is already taking.

### Compatibility Wrappers

Existing tools can be mapped onto RPG:

| Existing tool | RPG interpretation |
|---|---|
| `get_context` | Read a default focus lens. |
| `events_poll` | Read coalesced changes for a lens. |
| `screenshot(detail='meta')` | Force materialization of desktop/window fluents. |
| `screenshot(diffMode=true)` | Visual escalation for dirty visual state. |
| `get_history` | Tool envelope history. |
| `window-cache` | Cheap fluent backing store for rect/z-order. |
| `identity-tracker` | Entity identity and invalidation module. |
| `_post.ts` | Envelope injection point. |

## Implementation Mapping

Recommended new modules:

```text
src/engine/perception/
  evidence.ts
  fluent-store.ts
  lens.ts
  dependency-graph.ts
  matcher.ts
  guards.ts
  sensors-win32.ts
  sensors-cdp.ts
  sensors-uia.ts
  envelope.ts

src/tools/perception.ts
```

Current modules that should be reused:

| Module | Use |
|---|---|
| `win32.ts` | Cheap window facts and identity. |
| `event-bus.ts` | Early sensor source or compatibility layer. |
| `window-cache.ts` | Rect cache, later folded into fluent store. |
| `identity-tracker.ts` | Target identity and invalidation logic. |
| `uia-bridge.ts` | Medium/expensive sensor escalation. |
| `cdp-bridge.ts` | Browser fluents. |
| `layer-buffer.ts` | Visual dirty/image diff escalation. |
| `_post.ts` | Attach perception envelope to action responses. |
| `_narration.ts` | Can become a rich lens refresh path. |

## Initial MVP

The MVP should still implement the algorithm, not just an event API.

The MVP is the first reflex arc:

```text
tracked target
  -> cheap perception fluents
  -> pre-action guard
  -> safe correction or fail-closed
  -> perception feedback in the tool response
```

This is enough to prove the sensorimotor architecture without building the entire nervous system.

MVP scope:

```text
Lens:
  target window by title or hwnd

Fluents:
  target.exists
  target.identity
  target.title
  target.rect
  target.zOrder
  target.foreground
  modal.above(target)

Guards:
  target.identityStable
  safe.keyboardTarget
  safe.clickCoordinates
  stable.rect

Delivery:
  perception envelope on mouse/keyboard/window tools
  perception_read for explicit inspection

Sensors:
  Win32 polling or existing event-bus tick
  optional UIA focused-element only for keyboard guard
```

Out of MVP:

```text
UIA tree standing maintenance
OCR standing maintenance
image standing maintenance
full browser DOM diff
native SetWinEventHook helper
resource subscription
```

## Future Phases

### Phase 1: Fluent Core

- Add `FluentStore`.
- Add `Evidence`.
- Add `PerceptionLens`.
- Add dependency tracking.
- Add `perception_register/read/forget/list`.
- Add Win32 window fluents.

### Phase 2: Tool Envelope

- Attach `perception` blocks to action responses.
- Select relevant lenses by `windowTitle`, `hwnd`, or click coordinates.
- Add envelope token budgeting.
- Store envelope history for debugging.

### Phase 3: Guards

- Evaluate `safe.keyboardTarget`.
- Evaluate `safe.clickCoordinates`.
- Evaluate `target.identityStable`.
- Block or correct dangerous actions.
- Surface guard failures as structured MCP errors.

### Phase 4: Push-Pull Sensors

- Add UIA focused-element refresh for critical lenses.
- Add CDP active-tab/document fluents.
- Add modal/topmost obstruction detection.
- Add dirty marks for visual state.

### Phase 5: Native Events

- Add a native WinEvent sensor using `SetWinEventHook`.
- Keep EnumWindows polling as reconciliation fallback.
- Coalesce high-frequency move/location changes.

### Phase 6: MCP Resources

- Expose lens state as MCP resources.
- Emit resource-updated notifications for host-level integrations.
- Keep tool envelopes as the default LLM-facing delivery path.

## Coalescing Rules

RPG must not expose noisy raw change streams.

Rules:

```text
move(A->B), move(B->C) => move(A->C)
focus(A->B), focus(B->C) => focus(A->C)
title(A->B), title(B->C) => title(A->C)
remove(X), upsert(X with same identity) => upsert/change
remove(X), upsert(X with different identity) => identity_changed
dirty, refreshed ok => changed or ok
dirty, ttl exceeded => stale
```

Summaries should be semantic:

```text
Foreground changed: Terminal -> Visual Studio Code
Target window moved by +24,+0; click coordinates corrected
Modal appeared above target: "Save changes?"
Target identity changed; previous coordinates invalid
Browser navigation completed
```

## Confidence Model

Confidence is not a decorative score. It controls escalation and guard behavior.

Suggested defaults:

| Source | Base confidence |
|---|---:|
| Fresh Win32 foreground/rect/title | 0.98 |
| Fresh CDP document state | 0.96 |
| Fresh UIA focused element | 0.90 |
| UIA tree snapshot | 0.88 |
| OCR text | 0.65 |
| Image hash dirty bit | 0.60 |
| Inferred state | 0.50 |
| TTL-expired state | max 0.40 |

Guard thresholds:

| Guard class | Required confidence |
|---|---:|
| destructive keyboard action | 0.95 |
| ordinary keyboard action | 0.90 |
| click by corrected coordinates | 0.90 |
| informational read | 0.60 |

## Failure Behavior

RPG should fail closed for actions and fail open for reads.

For actions:

```text
guard_failed + no safe correction => block action
identity_changed => block coordinate-based action
stale critical fluent => refresh; if still stale, block or ask
modal.above(target) => block keyboard/mouse action unless target is modal
```

For reads:

```text
stale data => return with stale status and suggested refresh
contradicted data => return competing evidence
needs_escalation => return cheapest current answer plus next sensor suggestion
```

## Example Workflows

### Keyboard Input

```text
LLM registers target-editor lens
LLM calls keyboard_type(windowTitle="Visual Studio Code", text="hello")
RPG checks safe.keyboardTarget
RPG refreshes foreground via Win32 if dirty
RPG refreshes focusedElement via UIA/CDP if required
Tool executes
Response includes perception envelope
LLM does not call get_context unless envelope says dirty/stale/guard_failed
```

### Mouse Click

```text
LLM received click coordinates from prior text/detail view
Window moves before click
RPG sees target.rect dirty
mouse_click selects relevant target lens
RPG refreshes rect and computes delta
If same identity and no occlusion, click is corrected
Response says coordinates were corrected
```

### Modal Appears

```text
Target lens has modal.above(target)
Win32 sensor sees new topmost/dialog-like window
RPG marks modal.above dirty/true
Next keyboard_type is blocked
Response explains modal title and suggested next action
```

### Browser Navigation

```text
Browser lens tracks active tab
CDP Page.lifecycleEvent / title/url changes update browser fluents
browser_click_element response includes readyState/url/title changes
LLM does not need screenshot(diffMode=true) to confirm navigation completed
```

## Why This Is Not Just a Better Cache

A cache stores values.

RPG stores:

- values
- evidence
- dependencies
- confidence
- dirty state
- safety guards
- delivery policies
- escalation policies

The unit of maintenance is not "all desktop state". The unit is "the perception required for the LLM's current task".

## Why This Is Not Just Events

Events answer:

```text
What happened?
```

RPG answers:

```text
What does that mean for the target and the next action?
```

The LLM should not have to interpret every low-level foreground, move, title, UIA, CDP, or image-dirty event. RPG coalesces and projects them through lenses and guards.

## Architectural Concerns And Design Responses

The main objections to RPG are valid. They are not reasons to avoid the design. They are reasons RPG must be implemented as a sensorimotor layer rather than as a raw event subscription or ordinary cache.

### Concern: Win32/UIA Event Noise And Race Conditions

Win32 and UIA events can be noisy, delayed, duplicated, or delivered before the visual/application state has fully settled. A naive event-driven implementation can flood the Node.js event loop or act on stale intermediate state.

RPG response:

- Raw events are never exposed directly to the LLM.
- Events only mark dependent fluents dirty.
- High-frequency signals such as move/location changes are coalesced.
- Critical guards refresh cheap Win32 state synchronously before action.
- UIA focus is treated as medium-confidence evidence, not absolute truth.
- Guard evaluation can require a short stability window, such as `stable.rect(target, 250ms)`.

Design rule:

```text
Events are invalidation hints, not truth.
Truth is a refreshed fluent with evidence, age, and confidence.
```

### Concern: Fluent Store Drift Can Induce LLM Hallucination

If `target.exists = true` remains in the store after the target crashed, the LLM may trust the perception envelope and act incorrectly.

RPG response:

- Every fluent has TTL, confidence, and evidence.
- Safety-critical guards fail closed when required fluents are stale.
- Critical action paths perform forced Level 1 Win32 synchronization before execution.
- Identity mismatch is represented as `identity_changed`, not as a normal update.
- Envelope output must include attention state: `ok`, `dirty`, `stale`, `guard_failed`, or `identity_changed`.

Design rule:

```text
Cached state may guide reads.
Freshly validated state gates actions.
```

For example, `keyboard_type` may use cached state for envelope summaries, but it must not type secrets into a target unless `safe.keyboardTarget` passes against fresh enough evidence.

### Concern: Existing Tool Surface Makes Full Refactor Expensive

desktop-touch-mcp already has many tools. Wrapping every tool in a perception runtime at once would be a high-risk refactor.

RPG response:

- RPG can be introduced as an overlay, not a rewrite.
- Start with action tools where the value is highest: keyboard, mouse, focus, and window tools.
- Use `_post.ts` as the first envelope injection point.
- Keep existing tools functional; add perception only when a relevant lens exists.
- Treat `get_context`, `events_poll`, and `screenshot` as compatibility paths and escalation tools.

Design rule:

```text
Do not retrofit the whole tool catalog first.
Build the reflex arc first.
```

The first useful slice is:

```text
target identity + target rect + foreground + modal obstruction
  -> keyboard/mouse guards
  -> perception envelope
```

This validates the architecture without destabilizing the whole MCP server.

### Concern: Node.js Is Not A Real-Time Event Runtime

Node.js should not be treated as a hard real-time perception engine. Long UIA calls, OCR, image work, or event floods can block ordinary MCP responsiveness.

RPG response:

- Expensive sensors are never part of the default hot path.
- UIA tree, OCR, and screenshot are escalation stages, not baseline perception.
- Dirty marking is cheap and synchronous; materialization is budgeted and demand-driven.
- Sensor workers can be isolated later if needed.
- Per-lens budgets define maximum eager cost.

Design rule:

```text
The graph may be reactive.
The expensive senses must remain demand-driven.
```

### Reframed Objection

The strongest response to these concerns is:

```text
Noise, latency, stale state, and races are exactly why RPG is necessary.
Raw events cannot solve them. More screenshots cannot solve them cheaply.
They require fluents, evidence, guards, confidence, and escalation.
```

## References

- Self-adjusting computation: https://www.cambridge.org/core/journals/journal-of-functional-programming/article/consistent-semantics-of-selfadjusting-computation/441A28C813BDA23B57F1ED2BB1A7E36E
- Adapton and demand-driven incremental computation: https://www.cs.umd.edu/users/mwh/papers/hammer13adaptontr.html
- Push-pull functional reactive programming: https://www.researchgate.net/publication/221562986_Push-pull_functional_reactive_programming
- Event Calculus overview: https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S1574652607030179
- Rete algorithm: https://www.sciencedirect.com/science/article/abs/pii/0004370282900200
- Truth Maintenance System: https://www.sciencedirect.com/science/article/abs/pii/0004370279900080
- Microsoft UI Automation events: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsoverview
- Microsoft SetWinEventHook: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook
- Chrome DevTools Protocol DOM domain: https://chromedevtools.github.io/devtools-protocol/tot/DOM/
- Chrome DevTools Protocol Page domain: https://chromedevtools.github.io/devtools-protocol/tot/Page/
- MCP resources specification: https://modelcontextprotocol.io/specification/2025-11-25/schema
