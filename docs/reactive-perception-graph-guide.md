# Reactive Perception Graph — Beginner's Guide

> **TL;DR** — While the LLM is thinking, the user can switch windows. By the time a keyboard or mouse action fires, the target may no longer be in front — and there is no cheap way to know. RPG solves this: register a window once, and every action that carries `lensId` will automatically verify the window is still correct before firing, then report what changed — no extra round-trip needed.

---

## Contents

1. [The Problem RPG Solves](#1-the-problem-rpg-solves)
2. [Key Concepts in Plain Language](#2-key-concepts-in-plain-language)
3. [How It All Fits Together](#3-how-it-all-fits-together)
4. [The 4 RPG Tools](#4-the-4-rpg-tools)
5. [Walkthrough: Typing Safely into a Window](#5-walkthrough-typing-safely-into-a-window)
6. [Reading the Perception Envelope](#6-reading-the-perception-envelope)
7. [Guard Reference](#7-guard-reference)
8. [Attention States](#8-attention-states)
9. [Roadmap](#9-roadmap)
10. [Further Reading](#10-further-reading)

---

## 1. The Problem RPG Solves

### Without RPG: the classic race condition

```
LLM                        MCP Server                 Your Desktop
 │                               │                          │
 │── screenshot() ──────────────>│                          │
 │<── "Notepad is in front" ─────│                          │
 │                               │                          │
 │   [LLM thinks for 2 seconds]  │  [User clicks on a       │
 │                               │   different window]      │
 │                               │                          │
 │── keyboard_type("hello") ────>│                          │
 │                               │──── types "hello" ──────>│
 │<── ok ────────────────────────│      ⚠️ into the WRONG   │
 │                               │         window!          │
```

The LLM took a snapshot, decided to type, but by the time the action fires the world has changed. There is no way to know without taking another screenshot — which costs tokens, latency, and another round-trip.

### With RPG: pre-action guard evaluation

```
LLM                        MCP Server                 Your Desktop
 │                               │                          │
 │── perception_register() ─────>│                          │
 │<── { lensId: "perc-1" } ──────│                          │
 │                               │<── Win32 events ─────────│
 │                               │   (monitors every 250ms) │
 │                               │                          │
 │   [LLM thinks for 2 seconds]  │  [User clicks on a       │
 │                               │   different window]      │
 │                               │   ← guard marked dirty   │
 │                               │                          │
 │── keyboard_type(              │                          │
 │     lensId: "perc-1") ───────>│                          │
 │                               │── guard check:           │
 │                               │   "Is Notepad still      │
 │                               │    foreground?" ────────>│
 │                               │<── No                    │
 │<── GuardFailed: target not ───│                          │
 │    foreground                 │   (typing blocked) ✅    │
```

**One registration, persistent safety.**

---

## 2. Key Concepts in Plain Language

### Lens

A **lens** is "the thing you're paying attention to."

You register a lens once by saying *"watch this window"*. The server tracks that window's state in the background and automatically checks its safety before every action that carries `lensId`.

```
perception_register({
  name: "my-editor",
  target: { kind: "window", match: { titleIncludes: "Visual Studio Code" } }
})
→ { lensId: "perc-1" }
```

Think of it like a **watchlist entry** the server keeps permanently alive until you remove it.

> Each action still needs `lensId` passed explicitly. Omitting `lensId` uses the existing behavior exactly as before — no perception layer is involved.

---

### Fluent

A **fluent** is a "currently-believed live variable" about the target.

> The name comes from Event Calculus (a fact whose value *flows* over time). Don't worry about the jargon — just think "live variable."

The server maintains several fluents per lens automatically:

```
┌───────────────────────────────────────────────────────────┐
│  Lens "perc-1" — tracking "Visual Studio Code"            │
│                                                            │
│  Fluent                     Current value                 │
│  ─────────────────────────  ──────────────────────────    │
│  target.exists              true                          │
│  target.title               "main.ts - VS Code"           │
│  target.foreground          true                          │
│  target.rect                {x:0, y:0, width:1600,        │
│                              height:900}                  │
│  target.zOrder              0                             │
│  target.identity            {hwnd, pid, processName}      │
│  modal.above                false                         │
└───────────────────────────────────────────────────────────┘
```

Fluents are **not** exposed raw to the LLM — they power the guards and the envelope.

---

### Guard

A **guard** is a yes/no safety check that runs just before an action fires.

```
 keyboard_type()
      │
      ▼
 ┌──────────────────────────────────────────────┐
 │  Guard evaluation (runs every time)          │
 │                                              │
 │  target.identityStable?  ✅ same process     │
 │  safe.keyboardTarget?    ✅ window is in     │
 │                            foreground        │
 │  modal.above = false?    ✅ no dialog on top │
 │                                              │
 │  All pass → action proceeds                  │
 └──────────────────────────────────────────────┘
      │
      ▼
 types text into the correct window
```

If any guard fails, the action is **blocked** (or warned, depending on `guardPolicy`) and the response tells you exactly which guard failed and why.

---

### Envelope

The **perception envelope** is the small status report that comes back inside every tool response when you use `lensId`.

Instead of just `{ ok: true }`, you get:

```
{
  "ok": true,
  "post": {
    ...normal post state...,
    "perception": {            ← this is the envelope
      "attention": "ok",
      "guards": { "target.identityStable": true, ... },
      "latest": { "target": { "title": "main.ts - VS Code", ... } },
      "changed": []
    }
  }
}
```

The envelope tells you the current state **without a separate `get_context` call**.

> `post.perception` is visible to the LLM in the current tool response. It is stripped from the history ring buffer to keep context lean.

---

### Evidence

Every fluent carries an **evidence** tag recording *how fresh* the data is and *which sensor* produced it. Guards will refuse to pass if the evidence is too old or too uncertain.

```
Win32 fresh rect      → confidence 0.98  (very reliable)
UIA focused element   → confidence 0.90  (reliable)
OCR text              → confidence 0.65  (best-effort)
TTL-expired data      → confidence ≤0.40 (treated as stale)
```

---

### Quick Recap

Before moving on:

```
Lens      = what window you're watching  (you register it, get a lensId back)
Fluent    = a live variable the server tracks for you  (title, rect, foreground…)
Guard     = a pre-action yes/no safety check           (does it fail → block/warn)
Envelope  = the status report attached to each response (saves a round-trip)
Evidence  = freshness tag on each fluent               (stale? → guard refuses)
```

---

## 3. How It All Fits Together

### Data flow

```
  ┌─────────────┐  every 250 ms   ┌──────────────────┐
  │  Win32 API  │ ──────────────> │   Observations   │
  │ (foreground │                 │  (raw readings)  │
  │  rect,title │                 └────────┬─────────┘
  │  z-order…)  │                          │
  └─────────────┘                          ▼
                                  ┌──────────────────┐
                                  │   Fluent Store   │  ← TTL / confidence
                                  │  (live variables)│    tracked here
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ Dependency Graph  │
                                  │  lens → fluents  │
                                  └────────┬─────────┘
                                           │
                        ┌──────────────────┴────────────────────┐
                        ▼  (lensId passed)                       ▼  (explicit)
               ┌─────────────────┐                   ┌──────────────────────┐
               │  Action tool    │                   │  perception_read()   │
               │  keyboard_type  │                   │  (read-only path,    │
               │  mouse_click    │                   │   no guards fired)   │
               │  etc.           │                   └──────────┬───────────┘
               └────────┬────────┘                              │
                        │                                       ▼
                        ▼                              Perception envelope
               ┌─────────────────┐                    (returned directly)
               │ Guard evaluate  │
               └────────┬────────┘
              pass ─────┤───── fail
               │                │
               ▼                ▼
          execute        block / warn
          + attach        + return reason
          envelope
               │
               ▼
          Tool response
        + Perception Envelope
```

### Sensor cost ladder

RPG uses cheap sensors first and only escalates when necessary:

```
Level 0  cached fluent                               (free)
Level 1  Win32 cheap refresh  ← used for most guards (cheap)
Level 2  UIA focused element  ← keyboard target check (medium)
Level 3  UIA subtree / CDP interactive list           (expensive)
Level 4  OCR / image hash diff                        (expensive)
Level 5  full screenshot                              (heavy)
```

By default, RPG stays at Levels 0–1 for every action. Higher levels only activate on explicit request or sensor escalation.

---

## 4. The 4 RPG Tools

### `perception_register` — Start watching a window

```
perception_register({
  name: "editor",
  target: {
    kind: "window",
    match: { titleIncludes: "Visual Studio Code" }
  },
  guardPolicy: "block"   // "block" (default) or "warn"
})
→ {
    lensId: "perc-1",
    seq: 1,
    digest: "e3b0c44...",   // hash of the lens config; changes if spec changes
    binding: { windowTitle: "main.ts - Visual Studio Code", hwnd: "0x00230A1C" }
  }
```

Returns a `lensId`. Pass this to any action tool via `lensId: "perc-1"`.

**Limits:** max 16 active lenses. The oldest lens is evicted (FIFO) when the limit is exceeded. Lenses persist until `perception_forget` is called or the server restarts. Currently, each action tool accepts one `lensId` at a time.

---

### `perception_read` — Inspect current state on demand

```
perception_read({ lensId: "perc-1" })
→ {
    ok: true,
    attention: "ok",
    guards: { "target.identityStable": true, "safe.keyboardTarget": true, ... },
    latest: { target: { title: "...", foreground: true, rect: {...} } },
    changed: []
  }
```

Use this when:
- `post.perception.attention` is `"dirty"` or `"stale"` after an action
- You want to verify the state before a risky sequence of actions

Note: `perception_read` does **not** evaluate guards — it only refreshes fluents and returns the envelope.

---

### `perception_forget` — Stop watching

```
perception_forget({ lensId: "perc-1" })
→ { ok: true, removed: true, lensId: "perc-1" }
```

Frees the lens slot. Call this when your task is done and the window no longer needs monitoring.

---

### `perception_list` — See all active lenses

```
perception_list()
→ {
    ok: true,
    count: 2,
    lenses: [
      { lensId: "perc-1", name: "editor", windowTitle: "VS Code", ... },
      { lensId: "perc-2", name: "terminal", windowTitle: "Windows Terminal", ... }
    ]
  }
```

---

## 5. Walkthrough: Typing Safely into a Window

Here is a complete example session from the LLM's perspective.

### Step 1 — Register the lens

```
→ perception_register({ name: "editor", target: { kind: "window",
                         match: { titleIncludes: "Notepad" } } })
← { lensId: "perc-1", seq: 1, binding: { windowTitle: "Untitled - Notepad" } }
```

The server immediately reads Win32 to seed the fluents.

### Step 2 — Do an action with lensId

```
→ keyboard_type({ windowTitle: "Notepad", text: "Hello!", lensId: "perc-1" })
```

Internally, before typing:

```
  Guard checks (synchronous, Win32-level):
  ├─ target.identityStable?  ✅  same HWND, same PID
  ├─ safe.keyboardTarget?    ✅  Notepad is foreground
  └─ modal.above?            ✅  no dialog on top
```

Response:

```json
{
  "ok": true,
  "post": {
    "focusedWindow": "Untitled - Notepad",
    "perception": {
      "lens": "perc-1",
      "seq": 3,
      "attention": "ok",
      "guards": {
        "target.identityStable": true,
        "safe.keyboardTarget": true,
        "stable.rect": true
      },
      "latest": {
        "target": {
          "title": "Untitled - Notepad",
          "foreground": true,
          "rect": { "x": 100, "y": 100, "width": 800, "height": 600 }
        }
      },
      "changed": []
    }
  }
}
```

No extra `get_context` needed — the envelope already confirms everything is fine.

### Step 3 — What happens if a modal appears?

While the LLM is planning the next action, a "Save As" dialog pops up.

```
  Guard checks on next keyboard_type:
  ├─ target.identityStable?  ✅
  ├─ safe.keyboardTarget?    ✅  Notepad is still foreground
  └─ modal.above?            ❌  "Save As" dialog detected above target
```

Response:

```json
{
  "ok": false,
  "error": "GuardFailed",
  "suggests": ["dismiss the modal or interact with it first"],
  "guard": { "id": "modal.above", "reason": "modal above target detected" }
}
```

The action is blocked, and you know exactly why.

---

## 6. Reading the Perception Envelope

Every action that carries `lensId` appends a `post.perception` block. Here is what each field means:

```
"perception": {
  "lens":      "perc-1",      ← which lens this came from
  "seq":       42,            ← monotonic counter; if seq jumped, changes occurred
                                while the LLM wasn't looking
  "attention": "ok",          ← overall status (see table below)

  "guards": {                 ← result of each safety check (true = passed)
    "target.identityStable": true,
    "safe.keyboardTarget":   true,
    "stable.rect":           true
  },

  "latest": {                 ← snapshot of maintained fluents
    "target": {
      "title":      "Untitled - Notepad",
      "foreground": true,
      "rect":       { "x": 100, "y": 100, "width": 800, "height": 600 },
      "identity":   { "hwnd": "0x00230A1C", "pid": 1234,
                      "processName": "notepad.exe" }
    },
    "modal": { "above": false }
  },

  "changed": [                ← fluents that changed since the last action
    "target.rect"             (empty array = nothing changed)
  ]
}
```

### When to call `perception_read` explicitly

| `attention` value | Meaning | What to do |
|---|---|---|
| `ok` | All good | Continue |
| `changed` | Something changed, guards still pass | Check `changed[]`; usually safe to continue |
| `dirty` | A dependency updated, not yet re-evaluated | Call `perception_read` to force refresh |
| `stale` | Evidence exceeded TTL | Call `perception_read` |
| `guard_failed` | Safety check failed | Read the guard details and fix the situation |
| `identity_changed` | The target window was replaced by a different process | Call `perception_forget` then re-register |
| `needs_escalation` | Win32 alone can't answer with enough confidence | Use `screenshot` or `get_context` |

---

## 7. Guard Reference

| Guard | What it checks | Applies to |
|---|---|---|
| `target.identityStable` | HWND, PID, and process start time still match | keyboard, mouse, UI element actions |
| `safe.keyboardTarget` | Window is foreground and no modal is above it | keyboard_type, keyboard_press |
| `safe.clickCoordinates` | Click point falls inside the target window's rect | mouse_click, mouse_drag |
| `stable.rect` | Window hasn't moved or resized in the last ~250 ms | mouse_click (coordinate safety) |

### `guardPolicy` behavior

- **`block`** (default) — guard fails → action does **not** execute → error response
- **`warn`** — guard fails → action **still executes** → `attention: "guard_failed"` in envelope

> **Warning about `warn`:** With `guardPolicy: "warn"`, a keyboard action can still type into the wrong window if the guard fails. Use `warn` for low-risk diagnostic scenarios only. For anything that sends text or clicks, keep the default `block`.

---

## 8. Attention States

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                     Attention State Machine                      │
  │                                                                  │
  │  perception_register()                                           │
  │         │                                                        │
  │         ▼                                                        │
  │      [ ok ] ◄──────── perception_read() / fresh Win32 data       │
  │         │                    ▲               ▲                   │
  │         │        ┌───────────┘               │                   │
  │         ├─ fluent changes, guards pass ──► [changed]             │
  │         │                       └── next passing action ──► [ok]│
  │         │                                                        │
  │         ├─ fluent changes, guard fails ──► [guard_failed]        │
  │         │                   └── fix + perception_read() ──► [ok]│
  │         │                                                        │
  │         ├─ dependency updated, not refreshed ─► [dirty]          │
  │         │                   └── perception_read() ──────► [ok]  │
  │         │                                                        │
  │         ├─ evidence TTL exceeded ──────────► [stale]             │
  │         │                   └── perception_read() ──────► [ok]  │
  │         │                                                        │
  │         ├─ HWND/PID mismatch ─────────────► [identity_changed]  │
  │         │                   └── perception_forget + re-register  │
  │         │                                                        │
  │         └─ Win32 can't decide ─────────────► [needs_escalation] │
  │                             └── screenshot / get_context         │
  └─────────────────────────────────────────────────────────────────┘
```

---

## 9. Roadmap

### What's shipped in v0.9 (current)

```
✅  Phase 1 — Fluent Core
    FluentStore, Evidence, dependency graph, sensors-win32

✅  Phase 2 — Tool Envelope
    post.perception on keyboard / mouse / browser / UI element actions

✅  Phase 3 — Guards
    target.identityStable, safe.keyboardTarget, safe.clickCoordinates,
    stable.rect — block or warn before actions fire

✅  4 perception tools
    perception_register / read / forget / list
```

### Coming next

```
🔜  Phase 4 — Push-Pull Sensors
    ├── UIA focused-element push for critical lenses
    │   (today: Win32 only; UIA improves keyboard-target accuracy)
    ├── CDP active-tab / readyState / URL fluents
    │   (browser navigation state without extra browser_eval calls)
    └── modal/topmost obstruction detection improvements
        (today: WS_EX_TOPMOST heuristic; next: WinEvent-based)

🔜  Phase 5 — Native Events (SetWinEventHook)
    ├── Replace 250 ms polling with OS-push events
    │   (lower latency, fewer Win32 calls when nothing changes)
    └── Keep EnumWindows as reconciliation fallback

🔜  Phase 6 — MCP Resources
    ├── desktop://perception/{lensId}  (readable resource)
    └── resource-changed notifications to the MCP host
        (Claude Desktop can surface alerts without tool calls)
```

For longer-term ideas (UIA tree maintenance, OCR dirty bit, browser DOM diff, multi-lens coordination), see the [full design spec](./reactive-perception-graph.md).

---

## 10. Further Reading

| Document | What's in it |
|---|---|
| [`reactive-perception-graph.md`](./reactive-perception-graph.md) | Full design spec: data model, algorithm, push-pull policy, architectural concerns |
| [`system-overview.md`](./system-overview.md) | All 56 tools with descriptions, including `perception_*` |
