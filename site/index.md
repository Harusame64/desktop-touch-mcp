# desktop-touch-mcp

An experimental project for giving LLM agents a safer contract with the outside world.

---

## Hero

### Headline

**A safer way for LLM agents to touch the outside world**

### Subheadline

`desktop-touch-mcp` is an experimental MCP server for giving LLM agents eyes, hands, and a better safety contract with dynamic interfaces.

### Short lead

`desktop-touch-mcp` lets LLMs interact with Windows applications through screenshots, keyboard, mouse, Windows UI Automation, and Chrome DevTools Protocol.

But the real goal is not just “look at a screenshot and click some coordinates.”  
This project is exploring how LLM agents can interact with changing interfaces in a way that is more semantic, more bounded, and less fragile.

For the public site, it is better to say this plainly:

> **For now, treat this as Windows 11 only. Multi-OS support is not implemented yet.**

### CTA ideas

- `Open client setup`
- `Read the RPG explainer`
- `Browse the repository`
- `Read the preprint draft`

### Hero figure

![Snapshot-and-Act versus RPG](./assets/figures/hero-accident.svg)

The left panel shows the classic failure mode: an agent trusts an old view of the world.  
The right panel shows the alternative: treat state as provisional and validate trust before acting.

---

## What This Project Is

`desktop-touch-mcp` is a Windows MCP server.  
It gives LLMs access to screenshots, keyboard and mouse input, Windows UI Automation, Chrome DevTools Protocol, and related desktop-control tools.

But this project is not mainly about building a bigger tool catalog.

The deeper question behind it is:

> **How should an LLM agent interact safely with an external world that may already have changed while it was thinking?**

---

## Current Scope

For the public-facing site, the simplest honest message is:

- Windows 11 only for now
- not yet a multi-OS tool
- examples and setup flow are written for Windows-first local usage

---

## Quick Start

If you want to try the project first, the shortest path is:

```bash
npx -y @harusame64/desktop-touch-mcp
```

On first run, the launcher downloads the matching Windows runtime from GitHub Releases,
verifies it, and caches it locally.

If you want ready-to-paste client config examples, add a dedicated setup page:

- `site/articles/client-setup.md`

---

## Experimental Note

This project is experimental by design.

- Some parts are already practical and useful today
- Some parts are still design hypotheses being tested in code
- Evaluation and benchmarking are still in progress

This page is not trying to present a finished product.  
It is trying to document an active line of engineering and research.

---

## Milestones

As the project evolves, we document major architectural shifts and milestones here.

### v1.0: Less Surface, More Meaning
A significant consolidation of the tool surface (65 → 28 tools) and the transition to World-Graph and Auto-Perception as the default interaction model.
- [Read the v1.0 Milestone Article](./articles/v1.0-milestone.html)

---

## Why This Exists

Many GUI agents implicitly follow a simple loop:

1. Look at the screen
2. Think for a moment
3. Act using that remembered view

That sounds reasonable.  
On a real desktop, it is often wrong.

While the LLM is thinking:

- another window may come to the front
- a modal dialog may appear
- a button may move
- the target element may disappear

So the problem is not only whether the model is intelligent enough.  
The problem is also whether it is acting on assumptions that are already stale.

---

## Beyond Coordinate Roulette

One of the design ideas behind this project is what I publicly describe as **Beyond Coordinate Roulette**.

The phrase points at a familiar failure mode in UI automation:
the interface is treated as a flat picture, and action becomes a positional guess.

That usually sounds like this:

- maybe click somewhere around here
- maybe this is the right control
- maybe the old screenshot is still good enough

This project pushes in the opposite direction.

- See entities, not just coordinates
- See affordances, not just pixels
- Compare before and after in semantic terms
- Treat trust in external state as temporary, not permanent

In one sentence:

> **UI automation should not be a hidden version of coordinate roulette.**

### Suggested figure

`site/assets/figures/04-beyond-coordinate-roulette-map.mmd`

This figure contrasts two mindsets:

- coordinate-driven interaction on the left
- entity, affordance, lease, and guard on the right

---

## Core Ideas

This project keeps returning to four ideas.

### Provisional state

Do not keep observed state as timeless truth.  
Keep it as something that is probably true for now.

### Leased trust

Do not trust a target forever.  
Trust it through a short-lived lease.

### Guarded action

Before acting, check whether the assumptions behind that action are still valid.

### Demand-driven perception

Do not spend expensive perception on every step.  
Escalate only when the situation actually demands it.

---

## One Concrete Example: RPG

One concrete expression of these ideas is the **Reactive Perception Graph (RPG)**.

RPG is a layer that keeps external state provisional, tracks when that state becomes dirty or stale, and evaluates safety checks before an action is allowed to fire.

The intuition is simple:

> **Screenshots are not truth.**

### Suggested figure

`site/assets/figures/01-snapshot-vs-rpg.mmd`

On the top page, this figure should do just one job:
show how a conventional loop differs from an uncertainty-aware one.

---

## What You Can Explore Here

### Client setup

Copy-paste configuration examples for Claude, GitHub Copilot CLI, VS Code / Copilot Chat, OpenAI Codex, ChatGPT Developer mode, and Gemini CLI.

### RPG explainer

A more accessible, diagram-heavy explanation of `Reactive Perception Graph`.

### Beyond Coordinate Roulette

A short explainer for the design philosophy behind entity-based, meaning-first UI interaction.

### Preprint draft

A more research-oriented write-up centered on `provisional state`, `leased trust`, and `guarded action`.

### Planned evaluation

What we want to measure, which failure modes matter, and how results will be published.

### Repository

The implementation itself, including desktop automation, perception, guarded execution, and entity-lease mechanics.

---

## Get In Touch

For the public site, the safest and simplest contact path is:

- bugs: GitHub Issues
- integration questions: GitHub Issues
- ideas and discussion starters: GitHub Issues first

Do not publish a direct personal email on the page for now.  
If a private contact path becomes necessary later, it can be added separately.

Suggested copy:

> Questions, bugs, or ideas? Start with GitHub.

Suggested links:

- `https://github.com/Harusame64/desktop-touch-mcp/issues`
- `https://github.com/Harusame64/desktop-touch-mcp/issues/new/choose`

---

## Current Status

This project currently mixes:

- features that already work in practice
- features that are experimental but promising
- ideas that still need clearer evaluation

So this is not a polished product page.  
It is a page about a system that is still being built and tested in public.

---

## What Comes Next

Things planned for this site:

- a failure-case gallery
- an evaluation dashboard
- more explainer articles
- stronger visual diagrams for Beyond Coordinate Roulette and RPG

### Planned additions

- `site/articles/planned-evaluation.md`
- `site/assets/eval/*.json`
- `site/assets/figures/failure-cases/*.svg`

---

## Footer Link Ideas

- `GitHub Repository`
- `Beyond Coordinate Roulette`
- `RPG Explainer`
- `Preprint Draft`
- `Planned Evaluation`
- `Figure drafts`
