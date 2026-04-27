# Reactive Perception Graph

Why screenshots are not enough.

---

## Hero

### Headline

**Why screenshots are not enough**

### Subheadline

By the time an LLM acts, the world may already be different.  
Reactive Perception Graph is one way to deal with that.

### Opening lines

When an LLM touches the outside world, the biggest danger is not only bad reasoning.

The bigger danger is often this:
the model still trusts something it saw a moment ago, even though the world has already changed.

### Hero figure

At the top of the article, start with the comparison figure:

`../assets/figures/01-snapshot-vs-rpg.mmd`

---

## 1. The basic problem

Many LLM agents implicitly follow a loop like this:

1. observe the interface
2. think
3. act

That sounds harmless.  
In a dynamic interface, it is fragile.

While the model is thinking:

- the user may focus another window
- a modal may appear
- the UI may re-render
- the target may move or disappear

So the real problem is the time gap between **seeing** and **touching**.

### Suggested figure

A simple diagram where `observe -> think -> act` is interrupted by `world changed`.

### Figure asset

`../assets/figures/01-snapshot-vs-rpg.mmd`

---

## 2. A tiny accident story

Suppose an LLM is trying to type `hello` into Notepad.

1. It observes Notepad
2. It decides where to type
3. Another window comes to the front
4. It sends `hello` anyway

The result is subtle:
the agent may execute the intended action correctly, but on the wrong target.

That is not mainly an intelligence failure.  
It is a stale-assumption failure.

---

## 3. Snapshot-and-Act is fragile

A lot of agents still look roughly like this:

```ts
const snapshot = observeWorld();
const plan = think(snapshot);
execute(plan);
```

The weakness is not the syntax.

The weakness is that `snapshot` silently becomes the foundation for later action.  
If the snapshot is stale, even a good plan can become an unsafe action.

---

## 4. RPG in one sentence

In one sentence:

> **Reactive Perception Graph is a layer that treats external state as provisional and re-checks the assumptions behind action before the action fires.**

So RPG is not just “a smarter perception model.”  
It is a different contract between the agent and the world.

### Suggested emphasis

Add a small note here:

> RPG is not a screenshot cache.

That line helps prevent one of the most common misunderstandings.

---

## 5. Four ideas behind RPG

### 5.1 Provisional state

Observed state should not be stored as timeless truth.

Instead, it should carry an explicit freshness status such as:

- fresh
- dirty
- stale

The point is to represent not only **what** the agent believes, but also **how much it should still trust that belief**.

### 5.2 Lens

A lens is a watchpoint on something the agent currently cares about.

It helps answer:

- what am I watching?
- what changed?
- what now needs refresh or validation?

### 5.3 Guard

A guard is the safety layer before action.

It asks questions like:

- is the expected target still in front?
- did a modal appear?
- is this click or keystroke still safe?

If the answer is no, the action should not quietly continue.

### 5.4 Lease

A lease is a temporary trust contract for an external target.

It means:

> this target may be trusted for now, under bounded conditions

It is not meant to be permanent.  
It can expire, mismatch, or be revoked.

### Figure asset

`../assets/figures/02-rpg-four-ideas.mmd`

---

## 6. What happens before an action

In simplified form, the RPG-style flow looks like this:

1. observe a target
2. issue a lease
3. keep state as provisional
4. collect dirty or stale signals
5. propose an action
6. validate the lease
7. run guards
8. execute or block

A concept-level code sketch might look like this:

```ts
const lease = issueLease(target);
const state = rememberAsProvisional(target);

if (!validateLease(lease, state)) {
  return refresh();
}

if (!guardsPass(state)) {
  return block();
}

return execute();
```

The key idea is that `execute()` is the final step, not the default step.

### Figure asset

`../assets/figures/03-pre-action-flow.mmd`

---

## 7. Why this matters beyond desktop GUI

This idea is not only about Windows desktop automation.

### Browser agents

A DOM observed earlier may no longer match the live page.

### Workflow or API agents

A previously fetched resource handle may no longer be valid.

### Embodied agents

An object seen a moment ago may no longer be where the agent assumes it is.

So this is really a broader contract problem:

> **How should an LLM agent act when external state is uncertain, delayed, and revocable?**

---

## 8. How it maps to this project

Inside `desktop-touch-mcp`, these ideas currently show up through several connected pieces:

- `Reactive Perception Graph`
- `lease-based touch`
- `guarded execution`
- `differential observation`

You do not need to read all of the code to get the main point.

The main point is that these are not isolated conveniences.  
They are parts of a single design approach for avoiding actions based on stale assumptions.

### Implementation anchors

- `Reactive Perception Graph` -> `src/engine/perception/`
- `lease-based touch` -> `src/tools/desktop.ts`
- `guarded execution` -> `src/engine/world-graph/guarded-touch.ts`
- `differential observation` -> `src/engine/layer-buffer.ts`

---

## 9. The Initial MVP: Proving the Reflex Arc

Before building the full "nervous system," we spent considerable time in a trial-and-error phase with a Minimum Viable Product (MVP). The goal was to prove the **reflex arc**—the immediate, low-level loop that protects an action—without the overhead of a complex graph.

### The MVP Scope
- **Cheap Fluents**: We focused only on high-signal, low-cost facts: Is the window still there? Is it still in the foreground? Has its rectangle moved?
- **Basic Guards**: We implemented simple "fail-closed" predicates for identity stability and coordinate validity.
- **Intentional Omissions**: To avoid early bottlenecks and noise, we consciously excluded "heavy" sensors like full UIA tree traversals, OCR, or continuous screenshot diffing.

This stage was crucial for finding the right balance between latency and safety. It taught us that most "accidents" could be prevented by just checking a few Win32-level fluents right before the motor command fires.

---

## 10. Failure cases we care about

RPG is motivated by concrete failure modes such as:

- focus theft
- modal insertion
- window drift
- entity replacement
- delayed action

All of them share the same structure:

the assumptions that were valid at observation time are no longer valid at action time.

---

## 11. What still needs validation

The design is intuitive, but intuition is not enough.

To validate this direction, we still need to measure things such as:

- unsafe action rate
- re-observation count
- token-heavy observation count
- task success rate
- recovery steps

The project is being shaped so these can later be collected and published in a reasonably automated way.

---

## 12. One line to remember

If there is only one idea to keep from this page, it is this:

> **Screenshots are not truth. External state should be treated as provisional.**

---

## Link-out ideas

- `Back to project top`
- `Read Beyond Coordinate Roulette`
- `Read the original design specification (GitHub)` (../../docs/reactive-perception-graph.md)
- `Read the preprint draft`
- `Browse the repository`
- `See planned evaluation`
- `View figure drafts`

---

## Figure placement summary

1. `01-snapshot-vs-rpg.mmd`
   - Hero
   - Section 1
2. `02-rpg-four-ideas.mmd`
   - Section 5
3. `03-pre-action-flow.mmd`
   - Section 6
4. `04-beyond-coordinate-roulette-map.mmd`
   - linked from the project top or the Beyond Coordinate Roulette article
