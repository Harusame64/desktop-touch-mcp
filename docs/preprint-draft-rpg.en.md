# Preprint Draft — RPG / Lease / Guard (English)

Created: 2026-04-25

This document is the English draft of a preprint centered on `Reactive Perception Graph`.
Its goal is to fix the paper narrative before quantitative evaluation is filled in.

---

## 0. One-line claim

```text
LLM agents operating in uncertain external environments should treat world state
as provisional, trust external entities through leases, and guard actions against
stale assumptions.
```

---

## 1. Title candidates

### Candidate A

**Provisional State, Leased Trust, and Guarded Action: A Substrate for LLM Agents in Uncertain External Environments**

### Candidate B

**Beyond Snapshot-and-Act: Reactive Perception for Safe LLM Agents in Dynamic Interfaces**

### Candidate C

**Reactive Perception Graph for Guarded Action under Stale External State**

---

## 2. Paper image

### What this paper is

- A paper about **general principles for LLM agents acting in uncertain external environments**
- A concrete instantiation of those principles in `desktop-touch-mcp`

### What this paper is not

- Not a GUI grounding SOTA paper
- Not a new VLM paper
- Not a product-style catalog of tools

### Core thesis

- External state is **provisional belief**, not persistent truth
- Action should be **guarded execution**
- Trust in external entities should be **lease-based**
- Expensive perception should be **demand-driven**

---

## 3. Abstract draft

LLM agents interacting with external interfaces often rely on a fragile snapshot-and-act loop:
they observe once, retain state implicitly in context, and later act as if the world has remained
unchanged. This assumption breaks in dynamic environments, where focus changes, windows move,
modal dialogs appear, and interface entities become stale between perception and action. We argue
that external state should be treated as provisional rather than persistent. Based on this view, we
present a substrate centered on reactive perception, lease-based trust, and guarded action execution.
The substrate maintains explicit provisional world state, validates action preconditions against stale
assumptions, and binds external entities through revocable leases. We instantiate these ideas in a
desktop interaction system and show how they structure safer and more observation-efficient agent
behavior in uncertain external environments.

---

## 4. Full Introduction Draft

Large language model (LLM) agents are increasingly expected to interact with environments that are
not purely symbolic. Desktop applications, browser interfaces, terminal sessions, and mixed
human-facing control surfaces all expose state that is external to the model, only partially
observable, and subject to change without the agent's consent. In such environments, the agent acts
on a world that can drift while the model is still thinking.

Despite this, many current agent implementations still follow a snapshot-and-act loop. The agent
issues an observation request, retains the result in context, reasons for some amount of time, and
then executes a later action under the implicit assumption that the observed state has remained
valid. This assumption is fragile. A foreground window can change, a modal dialog can appear, a
scroll container can move the target out of view, or an apparently stable entity can be replaced by
a different one before the action fires. The result is not only lower task success, but also a
deeper systems problem: observation and trust are conflated.

We argue that this is the wrong contract between LLM agents and external environments. External state
should be treated as provisional rather than persistent. An observation should be a time-bounded
belief backed by evidence, not a durable truth that remains valid until overwritten. Likewise, trust
in an external entity should not be implicit and permanent. It should be explicit, lease-based, and
revocable. Finally, actions should not execute merely because the model has decided upon them. They
should execute only when safety-critical assumptions still hold.

This paper presents a substrate built around these ideas. The substrate combines three mechanisms.
First, it maintains explicit provisional world state through a reactive perception layer that tracks
which state remains fresh, which has become dirty, and which must be refreshed only on demand.
Second, it binds external entities through leases that carry bounded validity rather than unlimited
trust. Third, it guards action execution against stale assumptions by validating preconditions such
as identity stability, focus correctness, coordinate validity, and blocking overlays before
executing input.

We instantiate these ideas in a desktop interaction system, but the claim of the paper is broader
than desktop automation alone. Browser agents, workflow agents, and other external-world LLM systems
face the same structural problem: they must act on world models that are partial, aging, and
externally mutable. The contribution of this paper is therefore not a collection of GUI utilities,
but a design principle for reliable LLM action under uncertainty.

### Contributions

1. We formulate unreliable external action in LLM agents as a contract problem between observation,
state validity, and execution.
2. We propose a substrate centered on provisional state maintenance, lease-based trust, and guarded
action execution.
3. We instantiate the substrate in a working desktop interaction system and provide an evaluation
path against snapshot-and-act baselines.

---

## 5. Problem Setting

We consider LLM agents that interact with external environments through observation and action
interfaces rather than through direct symbolic state access. In such environments, the state that
matters for action is external to the model, only partially observable, and may change independently
of the agent between an observation and a later action.

This setting has four defining properties. First, observation is partial. Second, observation is
aging. Third, action is risky. Fourth, perception is asymmetric in cost. Under these conditions,
the naive snapshot-and-act loop becomes unreliable.

We focus on five recurring failure modes:

1. observation-to-action delay
2. focus theft
3. modal insertion or overlay appearance
4. entity drift or replacement
5. coordinate or viewport drift

Our goal is not to solve perception in general, nor to propose a more accurate grounding model. It
is to define a substrate under which an agent can treat external state as provisional, bind trust
explicitly, and avoid executing actions on invalid assumptions.

---

## 6. Design Principles

**P1. External state is provisional.**  
An observation should be represented as a belief with bounded validity, not as a durable truth.

**P2. Trust in external entities is leased.**  
An object that was actionable at one moment should not be assumed actionable forever.

**P3. Actions are guarded, not merely decided.**  
An LLM's chosen action is only a proposal. Before execution, the system must validate whether the
assumptions required by that action still hold.

**P4. Expensive perception is demand-driven.**  
The system should not eagerly re-perceive everything after every action. It should refresh cheap
state first and defer expensive sensing until uncertainty matters.

Taken together, these principles separate observation, trust, and execution.

---

## 7. System Section Draft

### 7.1 Overview

The proposed contract is instantiated through four cooperating layers: a reactive perception layer
for maintaining provisional state, a lease layer for temporary trust in external entities, a guarded
execution layer for validating action preconditions, and an observation reduction layer for
controlling expensive refreshes.

### 7.2 Reactive Perception as Provisional State Maintenance

The system maintains task-relevant properties such as target identity, foreground status, geometry,
modal blocking state, browser readiness, and focused element state as fluents with associated
evidence. A fluent may be observed, dirty, settling, stale, contradicted, or invalidated. This is
how the system distinguishes "has been seen" from "is still safe to trust." The projected envelope
returns compact state summaries plus uncertainty signals to the caller.

### 7.3 Lease-Based Entity Trust

The system does not expose raw coordinate references as durable commitments. Instead, it binds
external entities through leases. A lease carries the entity identity, the current view generation,
an expiration time, and an evidence digest derived from the entity's observed state. Trust becomes
explicit, bounded, and revocable.

### 7.4 Guarded Action Execution

The LLM's chosen action is treated as an intention, not an immediate command. Before execution, the
system evaluates whether the trusted target still denotes the same entity, whether focus or viewport
conditions still hold, whether a blocking overlay has appeared, and whether geometry used for the
action remains valid. If these assumptions fail, the system blocks, refreshes, or recovers instead
of executing blindly.

### 7.5 Demand-Driven Observation Reduction

The system manages expensive perception asymmetrically. Cheap state is refreshed aggressively enough
to support guards, while more expensive state is deferred until it is necessary for uncertainty
resolution. Differential observation is used to refresh only changed state when possible.

---

## 8. Implementation Section Draft

We instantiate the substrate in `desktop-touch-mcp`, a Windows-oriented LLM interaction system that
combines Win32 metadata, UI Automation (UIA), browser-side state, OCR-derived observations, and
image-based differential capture.

### Concept-to-artifact mapping

- perception substrate
  - `src/engine/perception/`
- entity observation and lease issuance
  - `src/tools/desktop.ts`
  - `src/engine/world-graph/lease-store.ts`
- guarded execution and semantic diff
  - `src/engine/world-graph/guarded-touch.ts`
- differential observation
  - `src/engine/layer-buffer.ts`

### Implementation notes

- `Reactive Perception Graph` maintains fluents with evidence, confidence, and freshness metadata
- `desktop_see` binds temporary trust through leases carrying generation, expiration, and digest
- `desktop_touch` revalidates leases and action preconditions against a live snapshot before acting
- `layer-buffer` supports differential refresh and selective observation

The implementation is platform-specific in its backends, but the proposed contract is intended to be
backend-agnostic.

---

## 9. Evaluation Skeleton

### Evaluation questions

**Q1. Safety**  
Does the substrate reduce unsafe or invalid external actions under dynamic world change?

**Q2. Observation efficiency**  
Does the substrate reduce unnecessary re-observation and token-heavy confirmation compared with a
snapshot-and-act baseline?

**Q3. Bounded trust and recovery**  
When the agent's assumptions become invalid, does the substrate fail in a more structured and
recoverable way than a naive action loop?

### Baselines

**Baseline A: Snapshot-and-Act**

- observe once
- keep state only implicitly in model context
- perform later action without explicit lease validation

**Proposed: RPG + Lease + Guard**

- maintain provisional state explicitly
- bind trusted entities through leases
- validate preconditions at action time
- refresh state in a staged, demand-driven way

### Task families

1. focus-sensitive input
2. modal-sensitive interaction
3. entity-validity interaction
4. geometry-sensitive interaction
5. post-action confirmation

### Perturbations

- focus theft
- modal insertion
- window move / resize
- entity replacement
- stale observation delay

### Primary metrics

- unsafe action rate
- invalid action attempt rate
- blocked-before-harm rate
- re-observation count per task
- token-heavy observation count per task
- expensive perception escalation count
- task success rate
- mean recovery steps

### Table skeletons

#### Table 1. Main comparison

| Method | Unsafe action rate | Task success rate | Re-observation count | Token-heavy observations | Recovery steps |
|---|---:|---:|---:|---:|---:|
| Snapshot-and-Act | [ ] | [ ] | [ ] | [ ] | [ ] |
| Proposed | [ ] | [ ] | [ ] | [ ] | [ ] |

#### Table 2. Perturbation breakdown

| Scenario | Snapshot-and-Act unsafe rate | Proposed unsafe rate | Snapshot-and-Act success | Proposed success |
|---|---:|---:|---:|---:|
| Focus theft | [ ] | [ ] | [ ] | [ ] |
| Modal insertion | [ ] | [ ] | [ ] | [ ] |
| Window drift | [ ] | [ ] | [ ] | [ ] |
| Entity replacement | [ ] | [ ] | [ ] | [ ] |
| Delayed action | [ ] | [ ] | [ ] | [ ] |

### Case studies

- Focus theft
- Entity replacement

### Honest scope statement

This evaluation should be presented as an initial validation of the contract rather than as a
complete benchmark for all external-world agents.
