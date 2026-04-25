# Beyond Coordinate Roulette

Why UI automation should not feel like coordinate roulette.

---

## In one sentence

**Beyond Coordinate Roulette** is the idea that interface automation should operate on meaning, not on blind guesses over coordinates.

---

## Why this framing?

Too much UI automation still behaves like this:

- click somewhere around here
- hope this is still the same button
- trust the old screenshot
- patch the failure with another click

That kind of loop can look automated, but it is not truly grounded.

Internally, I sometimes use the codename `Anti-Fukuwarai` for this idea.  
For a public English page, **Beyond Coordinate Roulette** is a clearer way to say the same thing.

---

## The thing it is pushing against

The problem is not just “using coordinates.”

Coordinates are sometimes necessary.

The real problem is this mindset:

> **the interface is treated as a flat picture, and action is chosen as a rough positional guess**

That usually leads to systems that are brittle in exactly the same way:

- they break when layout changes
- they break when focus changes
- they break when a modal appears
- they break when the target is re-rendered

---

## What Beyond Coordinate Roulette wants instead

It pushes toward a different model of interaction.

### See entities

A UI should not be treated as just a bitmap.  
It should be treated as a world containing things.

### See affordances

It is not enough to know where something is.  
It matters what can be done with it.

### Keep trust bounded

A target should not be assumed valid forever.  
Trust should be temporary and revocable.

### Compare semantically

After an action, the important question is not only “did pixels move?”  
It is also “what changed in meaning?”

---

## Where this connects to this project

Inside `desktop-touch-mcp`, this is not one single feature.

It is the design direction behind things like:

- `desktop_see`
- `desktop_touch`
- entity leases
- guarded execution
- semantic diffs
- event-first invalidation

So Beyond Coordinate Roulette is best understood as a product and research philosophy:

> **do not hide coordinate guessing behind a more polished API**

---

## Relationship to RPG

Reactive Perception Graph and Beyond Coordinate Roulette are related, but not identical.

### Beyond Coordinate Roulette

Focuses on the shape of interaction:

- entities
- affordances
- semantic outcomes

### RPG

Focuses on the time dimension of interaction:

- provisional state
- dirty / stale tracking
- lease validation
- guards before action

You can think of it this way:

- Beyond Coordinate Roulette asks: **what should UI interaction be grounded in?**
- RPG asks: **how should that grounding survive time and change?**

---

## A compact contrast

### Fukuwarai-like interaction

- I saw something clickable
- I remember roughly where it was
- I will click there

### Beyond Coordinate Roulette interaction

- I saw an entity
- I know what it affords
- I trust it only for now
- I check again before acting

---

## Why this matters beyond desktop

This is not only about Windows.

The same problem appears in:

- browser agents
- API workflows
- robotics
- multimodal assistants

Any system that acts on an external world can drift into a Fukuwarai-like pattern if it treats perception as static truth.

---

## One line to remember

> **Good automation does not just know where to click. It knows what it is touching, why it can touch it, and whether that is still true right now.**

---

## Link-out ideas

- `Back to project top`
- `Read the RPG explainer`
- `Browse the repository`
- `See figure drafts`
