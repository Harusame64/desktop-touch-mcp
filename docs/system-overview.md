# desktop-touch-mcp — System Overview

MCP (Model Context Protocol) server that lets Claude CLI drive any Windows desktop application.

> This document is the canonical overview of the **current implementation**. For the
> user-facing quick start and per-tool tables, see the top-level [README.md](../README.md);
> for design notes and remaining work, see the files under [`docs/`](./).

---

## Architecture

```
Claude CLI
    │  stdio (MCP protocol)
    ▼
desktop-touch-mcp (Node.js / TypeScript)
    ├── Layer 0: Rust Native Engine (.node addon — @harusame64/desktop-touch-engine)
    │   │  Loaded automatically; transparent PowerShell fallback if unavailable
    │   │
    │   ├── UIA Engine (napi-rs + windows-rs 0.62)
    │   │   ├── Dedicated COM thread: OnceLock<Sender<UiaTask>> singleton, MTA initialized
    │   │   ├── UiaContext: IUIAutomation + TreeWalker + CacheRequest (7 props + 6 patterns)
    │   │   ├── Batch BFS: FindAllBuildCache(TreeScope_Children) — 1 RPC per tree level
    │   │   ├── 13 napi exports: tree(2) + focus(2) + actions(3) + search(2) + text(1) + scroll(3)
    │   │   └── AsyncTask: compute() on libuv worker thread → non-blocking Promise
    │   │
    │   ├── Image Engine (SSE2 SIMD)
    │   │   ├── computeChangeFraction — 8×8 block pixel diff (0.26 ms @ 1080p)
    │   │   ├── dHash — 64-bit perceptual hash (0.09 ms)
    │   │   └── hammingDistance — bitwise comparison
    │   │
    │   └── Image Processing Engine (SoM pipeline — v0.15.4)
    │       ├── preprocessImage() — grayscale (BT.601 u8) + bilinear upscale (2×/3×, Q16 fixed-point) + contrast stretch
    │       └── drawSomLabels()  — red bounding boxes + 5×7 bitmap-font ID badges ([1],[2],…) on RGBA buffer
    │
    ├── Layer 1: Engine (TypeScript)
    │   ├── nutjs.js        — mouse / keyboard / screen capture (nut-js)
    │   ├── win32.ts        — Win32 API via koffi: window enum, DPI, PrintWindow, SetWindowPos,
    │   │                     getForegroundHwnd, getWindowClassName, isWindowTopmost, getWindowOwner
    │   ├── uia-bridge.ts   — UIA bridge: routes to Rust native → PowerShell fallback
    │   │                     13 functions: getUiElements, clickElement, setElementValue, etc.
    │   │                     detectUiaBlind(): sparsity guard (< 5 elements OR single giant Pane ≥ 90% with < 5 other actionable elements)
    │   ├── ocr-bridge.ts   — Windows OCR runner + SoM pipeline (v0.15.4)
    │   │                     runSomPipeline(): Hybrid Non-CDP pipeline (8 stages)
    │   │                       capture → preprocess (Rust) → OCR → cluster → drawSomLabels (Rust)
    │   │                     clusterOcrWords(): 2-stage merge (char→word→element) via proximity heuristics
    │   ├── uia-diff.ts     — UIA snapshot diff (appeared / disappeared / valueDeltas)
    │   ├── image.ts        — image encode (sharp): PNG / WebP 1:1 / crop
    │   ├── layer-buffer.ts — per-window layer buffer: frame-diff detection (MPEG P-frame style)
    │   │                     Uses Rust SSE2 engine for computeChangeFraction / dHash when available
    │   ├── cdp-bridge.ts   — Chrome DevTools Protocol: WebSocket sessions + DOM→screen coords
    │   ├── window-cache.ts — window-position cache used by the homing-correction path (dx,dy)
    │   ├── event-bus.ts    — Win32 window-state event bus used by perception sensors
    │   ├── identity-tracker.ts — processStartTimeMs-based window identity; detects restarts
    │   ├── poll.ts         — shared pollUntil utility
    │   └── perception/     — Reactive Perception Graph (v0.11)
    │       ├── types.ts            — pure types: Observation / Fluent / PerceptionLens / GuardResult / PerceptionEnvelope
    │       ├── evidence.ts         — makeEvidence / isStale / confidenceFor (win32=0.98, image=0.60, inferred=0.50)
    │       ├── fluent-store.ts     — FluentStore: TMS-lite reconcile (newer seq wins; higher confidence wins)
    │       ├── dependency-graph.ts — fluentKey → Set<lensId> reverse index
    │       ├── lens.ts             — compileLens / resolveBindingFromSnapshot / expandFluentKeys
    │       ├── guards.ts           — 4 pure guards: identityStable / keyboardTarget / clickCoordinates / stable.rect
    │       ├── envelope.ts         — projectEnvelope: attention derivation + token-budget trimming
    │       ├── sensors-win32.ts    — only impure module; piggybacks event-bus 500 ms tick
    │       └── registry.ts         — central coordinator; max 16 lenses (LRU evict)
    └── Layer 2: 29 public MCP tools (27 stub catalog + 2 dynamic v2)
        See [CHANGELOG.md](D:/git/desktop-touch-mcp/CHANGELOG.md) Phase 1+2+3+4 sections for the per-phase mapping. ADR-015 v1.5.0 adds the `excel` tool (invariant 6 explicit carve-out, see `docs/layer-constraints.md` §6.3 Note).
```

### Surface status

- **Current public surface (v1.8.0)**: 29 tools — 27 stub catalog + 2 dynamic v2 (`desktop_discover` / `desktop_act`)
- **Tool surface reduction (Phase 1–4) — shipped**: naming redesign, family merge dispatchers, browser rearrangement, privatize/absorb. Pre-Phase-1 surface was 65 tools.
- Phase design references (all Implemented):
  - [tool-surface-phase1-naming-design.md](D:/git/desktop-touch-mcp/docs/tool-surface-phase1-naming-design.md)
  - [tool-surface-phase2-family-merge-design.md](D:/git/desktop-touch-mcp/docs/tool-surface-phase2-family-merge-design.md)
  - [tool-surface-phase3-browser-rearrangement-design.md](D:/git/desktop-touch-mcp/docs/tool-surface-phase3-browser-rearrangement-design.md)
  - [tool-surface-phase4-privatize-absorb-design.md](D:/git/desktop-touch-mcp/docs/tool-surface-phase4-privatize-absorb-design.md)

### Rust Native Engine — Data Flow

```
[MCP Tool call]
    │
    ▼
uia-bridge.ts
    │  nativeUia?.uiaGetElements(opts)    ← existence check
    │  ├── Success → return result
    │  └── Error / null → runPS(script)   ← PowerShell fallback
    │
    ▼ (Rust path)
lib.rs  #[napi] uia_get_elements(opts) → AsyncTask<UiaGetElementsTask>
    │
    ▼ (libuv worker thread)
AsyncTask::compute()
    │  execute_with_timeout(8s, |ctx: &UiaContext| { ... })
    │
    ▼ (crossbeam channel → COM thread)
UIA Dedicated Thread (MTA)
    │  ctx.automation / ctx.walker / ctx.cache_request
    │  FindAllBuildCache(TreeScope_Children, ControlViewCondition, CacheRequest)
    │
    ▼ (bounded(1) reply channel)
Result<Vec<UiElement>> → napi Promise → JavaScript
```

### Performance (v0.15)

#### UIA Bridge — Rust Native vs PowerShell

| Operation | Rust Native | PowerShell | Speedup |
|---|---|---|---|
| `getFocusedElement` | **2.2 ms** | 366 ms | **163.9×** |
| `getUiElements` (Explorer ~60 elements) | **106.5 ms** | 346 ms | **3.3×** |
| **UIA weighted average** | | | **~82×** |

#### Image Diff Engine — Rust SSE2 vs TypeScript

| Operation | Rust SSE2 | TypeScript | Speedup |
|---|---|---|---|
| `computeChangeFraction` (1920×1080) | **0.26 ms** | 3.8 ms | **~15×** |
| `dHash` (perceptual hash) | **0.09 ms** | 1.2 ms | **~13×** |

---

## Action response shape (the `post` block)

Every action tool (`mouse_click`, `keyboard(action='press')`, `click_element`, …) returns a `post` block on success.

```json
{
  "ok": true,
  "post": {
    "focusedWindow": "Notepad",
    "focusedElement": { "name": "Text editor", "type": "Document", "value": "Hello" },
    "windowChanged": false,
    "elapsedMs": 42,
    "rich": {
      "diffSource": "uia",
      "appeared":  [{ "name": "Save dialog", "type": "Dialog" }],
      "disappeared": [],
      "valueDeltas": [{ "name": "File name", "before": "", "after": "memo.txt" }]
    },
    "perception": {
      "lens": "perc-1",
      "seq": 7,
      "attention": "ok",
      "guards": { "target.identityStable": true, "safe.keyboardTarget": true },
      "latest": {
        "target": { "title": "Untitled - Notepad", "foreground": true, "rect": {"x":78,"y":78,"width":976,"height":618} }
      },
      "changed": []
    }
  }
}
```

| Field | Meaning |
|---|---|
| `focusedWindow` | Foreground window title after the action |
| `focusedElement` | UIA focused element (name / control type / value). `null` when UIA is unavailable |
| `windowChanged` | Whether the foreground window changed between before and after |
| `elapsedMs` | Wall-clock duration of the action |
| `rich` | **Opt-in** — present only when the caller passed `narrate:"rich"`. UIA diff block |
| `perception` | **Opt-in** — present only when the caller passed a `lensId`. Perception envelope (see below) |

### `narrate` parameter

Mouse / keyboard / UI-element tools take a `narrate` parameter.

| Value | Behaviour |
|---|---|
| `"minimal"` (default) | Just the `post` block; zero added cost |
| `"rich"` | Diffs a UIA snapshot before and after the action; result lands in `post.rich`. Lets callers skip the confirmation screenshot |

For `keyboard(action='press')`, rich mode only fires for state-transitioning keys (Enter / Tab / Esc / F5). Single-character keys silently downgrade to minimal.

---

## Tool catalogue

The 29 public tools group into six families. The **World-Graph V2** pair is the
recommended dispatch path; the coordinate / UIA / browser tools remain for
fallback and specialised work.

### 🌐 World-Graph V2 — discover-then-act (primary path)

The recommended way to operate any window, browser tab, or terminal. Instead of
guessing screen coordinates, you *discover* interactive entities (each carrying a
short-lived lease) and then *act* on an entity by its lease.

#### `desktop_discover`
Observe a target and return interactive entities with leases — no raw screen
coordinates. One surface spans four lanes: UIA (native windows / dialogs), CDP
(Chrome / Edge tabs), terminal, and a visual GPU lane (Set-of-Marks) for windows
UIA cannot see. Each entity carries a lease (`expiresAtMs` is the correctness
wall; `softExpiresAtMs` ≈ 60 % of TTL is the soft re-discover hint). TTL adapts
to `view` mode (`action` / `explore` / `debug`), entity count, and payload size,
capped at 60 s. Warnings (`visual_provider_unavailable`, `visual_provider_warming`,
`cdp_provider_failed`, …) tell the caller when a lane is degraded.

#### `desktop_act`
Act on an entity returned by `desktop_discover` (`click` / `type` / `drag` /
`select`, …). The lease is validated before execution, and the response carries a
semantic diff (`entity_disappeared`, `modal_appeared`, `focus_shifted`, …) plus
the `attention` signal — so the caller can decide the next step without another
screenshot. On `ok:false` read `reason` and follow the recovery path:

| `reason` | Recovery |
|---|---|
| `lease_expired` / `lease_generation_mismatch` / `lease_digest_mismatch` / `entity_not_found` | re-call `desktop_discover` |
| `modal_blocking` | `response.blockingElement` names the blocker → `click_element(name=…)` then retry |
| `entity_outside_viewport` | `scroll(action='to_element' | 'raw')` then re-call `desktop_discover` |
| `executor_failed` | fall back to `click_element` / `mouse_click` / `browser_click` |

> **Kill switch:** `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` hides `desktop_discover` /
> `desktop_act` from the catalogue and re-registers three V1 fallback tools
> (`get_windows` / `get_ui_elements` / `set_element_value`) for troubleshooting.
> The deprecated opt-in `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2` is still accepted but
> no longer required (V2 is default-on).

### 📸 Screenshot family

#### `screenshot`
The most important tool. Three orthogonal modes.

| Parameter | Meaning |
|---|---|
| `windowTitle` | Narrow to a specific window |
| `displayId` | Target a monitor |
| `region` | Rectangle on the screen (with `windowTitle`, this becomes window-relative — handy to exclude the browser chrome) |
| `maxDimension` | Upscale cap (default 768 px, PNG mode) |
| `dotByDot` | **1:1 pixel mode** — WebP, no coord conversion needed |
| `dotByDotMaxDimension` | Long-edge cap under dotByDot. When set, the response carries `scale`; recover a screen coord via `screen_x = origin_x + image_x / scale` |
| `grayscale` | Grayscale cuts image size by ~50% — good for text-heavy captures |
| `webpQuality` | WebP quality 1–100 (default 60) |
| `diffMode` | **Layer diff mode** — only windows that changed are sent |
| `detail` | `"image"` / `"text"` / `"meta"` |
| `ocrFallback` | `"auto"` (default: OCR when UIA is sparse/empty or the foreground is Chromium) / `"always"` / `"never"` |

**Picking `detail`:**

```
detail="image"  (default) — pixel image. Use when you need visual confirmation.
detail="text"             — UIA element-tree JSON. Inspect and operate on buttons / fields.
detail="meta"             — title + rectangle only. Cheap layout orientation.
```

**Coordinate modes at a glance:**

| Mode | Tokens | Coord math |
|---|---|---|
| Default (768 px PNG) | ~443 | `screen = window_origin + img_px / scale` |
| `dotByDot=true` (WebP) | ~800–2765 | `screen = origin + img_px` (no conversion) |
| `diffMode=true` | ~160 (deltas only) | Only changed windows are sent |
| `detail="text"` | ~100–300 | Coords arrive as `clickAt` — no math at all |

**Recommended workflow:**
```
# Kick-off: see the whole desktop
workspace_snapshot()                     → I-frame + actionable elements for every window

# Efficient operate loop
screenshot(detail="text", windowTitle=X) → click via actionable[].clickAt
mouse_click(clickAt.x, clickAt.y)
screenshot(diffMode=true)                → only the windows that changed (~160 tok)

# Reach for pixels only when you really need them
screenshot(dotByDot=true, windowTitle=X) → 1:1 WebP, no coord conversion
```

#### `screenshot(mode='background')`
Explicit Win32 PrintWindow capture, retained for back-compat and explicit selection. As of v1.4.4 the default `mode='normal'` window-targeted route already uses PrintWindow (with automatic BitBlt fallback when PrintWindow returns no data / an all-black frame), so most callers no longer need this flag. Use it to force the PrintWindow result without the BitBlt fallback layer when the target window is legitimately all-black (terminal / dark editor / video frame).
- `dotByDot=true` emits 1:1 WebP.
- `PW_RENDERFULLCONTENT` is the default flag (set `fullContent=false` for the legacy flag-0 mode when a GPU game / video window hangs PrintWindow).

> Word-level Windows OCR (`Windows.Media.Ocr`) is reached through `screenshot`
> itself — `detail="text"` with `ocrFallback="auto"` (default) fires OCR when UIA
> is sparse/empty or the foreground is Chromium; `ocrFallback="always"` forces it.
> The standalone `screenshot_ocr` / `get_screen_info` tools were absorbed during
> the Phase 1–4 surface consolidation.

#### `screenshot(detail="text")` — SoM fallback
When `detectUiaBlind()` fires (fewer than 5 UIA elements, or a single Pane covering ≥ 90% of the window with fewer than 5 other actionable elements), `screenshot(detail="text")` automatically activates the Hybrid Non-CDP pipeline instead of returning an empty element list:

1. Capture window via PrintWindow → RGBA buffer
2. Rust `preprocessImage()`: grayscale (BT.601 u8) + bilinear 2×/3× upscale + contrast stretch. Auto-clamps to scale=1 at >8 MP or ≥144 DPI.
3. Windows OCR → word list with bounding boxes
4. Two-stage clustering: char→word merges (gap ≤ max(12px, 0.5× glyph height)) then word→element merges (gap ≤ 35px)
5. Rust `drawSomLabels()`: red 2px bounding boxes + white badge with black ID number
6. Returns `somImage` (base64 PNG) + `elements[]` with `{ id, text, clickAt, region }`

Sharp library is the transparent fallback for `preprocessImage` if the native `.node` engine is unavailable (no feature loss, only performance difference). When `drawSomLabels` is unavailable (Rust engine not built), `somImage` is `null` — the `elements[]` list with `clickAt` coords is still returned, but without the visual annotation PNG. If the SoM pipeline fails at any stage, `screenshot(detail="text")` transparently falls back to the regular OCR word-list path.

---

### 🖥️ Window management

> The Z-order window list and active-window info that `get_windows` /
> `get_active_window` used to return are now part of `desktop_state.windows`
> (and `desktop_discover`). The two standalone getters were privatized in the
> Phase 1–4 consolidation.

#### `focus_window`
Bring a window to the foreground by partial title match.
```
focus_window(title="Notepad")
focus_window(title="Chrome", chromeTabUrlContains="github.com")  # activate a specific tab first
```
`chromeTabUrlContains` activates the matching Chrome/Edge tab by URL substring before focusing the HWND. If CDP is unavailable, the parameter is silently skipped and `hints.warnings` surfaces `"cdpUnavailable"`.

#### `window_dock(action='pin')` / `window_dock(action='unpin')`
Toggle always-on-top; `duration_ms` for an auto-release timer.

#### `window_dock(action='dock')`
Parks any window in a screen corner while keeping it topmost. Handy for keeping the Claude CLI visible while other tools work.
```
window_dock(action='dock')({title:'Claude Code', corner:'bottom-right', width:480, height:360, pin:true})
```
Parameters: `corner` (top-left / top-right / bottom-left / bottom-right), `width` / `height`, `pin`, `monitorId`, `margin`. Minimized / maximized windows are restored before docking.

**MCP-startup auto-dock via environment:**

| Env var | Meaning |
|---|---|
| `DESKTOP_TOUCH_DOCK_TITLE` | Required. `"@parent"` walks the MCP process's parent tree to auto-detect the terminal (title-independent; recommended) |
| `DESKTOP_TOUCH_DOCK_CORNER` | Default `bottom-right` |
| `DESKTOP_TOUCH_DOCK_WIDTH` / `HEIGHT` | `"480"` (px) or `"25%"` (workArea ratio). Auto-follows on 4K/8K |
| `DESKTOP_TOUCH_DOCK_PIN` | Default `true` |
| `DESKTOP_TOUCH_DOCK_MONITOR` | Monitor ID (default primary) |
| `DESKTOP_TOUCH_DOCK_SCALE_DPI` | `true` scales px values by `dpi/96` (opt-in) |

---

### 🖱️ Mouse

All mouse tools take `speed` plus `homing` / `windowTitle` / `elementName` / `elementId`. Success responses carry the `post` block (`narrate:"rich"` adds a UIA diff).

#### `mouse_click`
Click (`left` / `right` / `middle`). `doubleClick=true` for a double-click; `tripleClick=true` for a triple-click (selects a full line of text). If both are set, `tripleClick` wins.

**Homing correction (traction control):** compensates for window movement / occlusion that happens between the screenshot and the click.

| Tier | Trigger | Latency | Effect |
|---|---|---|---|
| 1 | Always (if cache) | <1 ms | `GetWindowRect` delta → (dx,dy) correction |
| 2 | `windowTitle` given | ~100 ms | `restoreAndFocusWindow` if the target went behind |
| 3 | `elementName`/`Id` + `windowTitle` + resize detected | 1–3 s | Re-query fresh coords via UIA `getElementBounds` |

```
mouse_click(x, y, windowTitle="Notepad")    # Tier 1 + 2
mouse_click(x, y, homing=false)             # correction off
```

The cache is refreshed automatically by `screenshot` / `desktop_discover` / `focus_window` / `workspace_snapshot`. A 60-second TTL keeps HWND reuse from steering the wrong window.

#### `mouse_drag`
Drag (startX,startY) → (endX,endY). When homing is active, the end-point gets the same delta as the start. Both endpoints are guarded; cross-window / desktop drags are blocked unless `allowCrossWindowDrag:true`.

#### `scroll`
The unified scroll dispatcher. `scroll(action='raw')` takes `direction` (`up` / `down` / `left` / `right`) and `amount` (step count, internally multiplied by 3 because nut-js's single step is tiny). The richer `action='to_element'` / `'smart'` / `'capture'` modes are documented under **Macro / scroll** and **SmartScroll** below.

---

### ⌨️ Keyboard

Responses carry the `post` block; `narrate:"rich"` attaches a UIA diff (state-transitioning keys only).

#### `keyboard(action='type')`
Text input.
- `use_clipboard=true` routes via PowerShell + clipboard, **bypassing any Japanese IME**. Required when typing URLs / paths under an active IME.
- Also required for text that contains em-dash (`—`), en-dash (`–`), smart quotes, or other non-ASCII punctuation — these can be intercepted as keyboard accelerators by Chrome/Edge. `keyboard(action='type')` detects these characters automatically and upgrades to clipboard mode (`method:'clipboard-auto'`). Opt out with `forceKeystrokes=true`.
- `replaceAll=true` sends Ctrl+A before typing to replace any existing content (requires the field to already be focused).

#### `keyboard(action='press')`
Key combos.
```
keyboard(action='press')(keys="ctrl+c")
keyboard(action='press')(keys="alt+f4")
keyboard(action='press')(keys="ctrl+shift+s")
```

> **⚠️ Input routing gotcha (when `window_dock(action='dock')` is pinned)**
> `keyboard(action='type')` / `keyboard(action='press')` send to **whichever window is currently focused**. If `window_dock(action='dock')(pin=true)` has pinned the Claude CLI topmost, keystrokes can land on the CLI instead of the target app.
> Always call `focus_window(title=…)` first, then verify with `screenshot(detail='meta')` that `isActive=true` on the target. Canonical pattern: `focus_window → keyboard(action='press')/type → screenshot(diffMode=true)`.

---

### 🔍 UI Automation (UIA)

> **v0.15:** All UIA operations route through the Rust native engine by default (direct COM calls, 2–100 ms). PowerShell fallback activates automatically if the native engine is unavailable.

`click_element` returns the `post` block; `narrate:"rich"` adds a UIA diff.

#### `screenshot(detail="text")` ← recommended
Action-oriented element extraction. Every entry carries `clickAt` coords.

```json
{
  "window": "Notepad",
  "actionable": [
    { "action": "click", "name": "Settings", "type": "Button",
      "clickAt": {"x": 1025, "y": 136}, "id": "SettingsButton" },
    { "action": "type", "name": "Text editor", "type": "Document",
      "clickAt": {"x": 566, "y": 405}, "value": "Current text…" }
  ],
  "texts": [
    { "content": "Ln 1, Col 1", "at": {"x": 100, "y": 666} }
  ]
}
```

#### `click_element`
Click by name / ID via UIA `InvokePattern` — no coords needed.
```
click_element(windowTitle="Notepad", name="Settings", controlType="Button")
```

> The raw UIA tree (`get_ui_elements`), direct field setter (`set_element_value`),
> and single-element zoom (`scope_element`) were privatized in the Phase 1–4
> consolidation. `get_ui_elements` / `set_element_value` are re-registered as V1
> fallback tools only when `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` is set. For
> normal automation, `desktop_discover` (entity tree with leases) and
> `screenshot(detail="text")` (`actionable[]` with `clickAt` + `automationId`)
> cover the same ground.

---

### 🚀 Workspace

#### `workspace_snapshot`
The whole desktop in one call.
- Thumbnails (WebP) of every window
- `uiSummary.actionable` — interactive elements + `clickAt` per window
- Resets the layer buffer → becomes the I-frame for subsequent `screenshot(diffMode=true)` calls

```json
{
  "windows": [{
    "title": "Notepad",
    "region": {"x":78,"y":78,"width":976,"height":618},
    "uiSummary": {
      "actionable": [
        { "action": "click", "name": "Settings", "clickAt": {"x":1025,"y":136} },
        { "action": "type",  "name": "Text editor", "clickAt": {"x":566,"y":405}, "value": "…" }
      ],
      "texts": [{ "content": "UTF-8", "at": {"x":913,"y":666} }]
    }
  }]
}
```

#### `workspace_launch`
Launch an app + auto-detect the new window (diffs the window set before and after — handles localized UWP titles).

---

### 📊 Context & history

#### `desktop_state`
Lightweight OS + app context. See the current state without a screenshot.

```json
{
  "focusedWindow": "Notepad — Untitled",
  "focusedElement": { "name": "Text editor", "type": "Document", "value": "Hello" },
  "cursorPos": {"x": 523, "y": 401},
  "cursorOverElement": { "name": "Text editor", "type": "Document" },
  "windows": [...]
}
```

| Field | Meaning |
|---|---|
| `focusedElement` | UIA `GetFocusedElement` — the element with keyboard focus (name / type / value) |
| `cursorOverElement` | UIA `ElementFromPoint` — the UIA element directly under the cursor |
| `windows` | Z-ordered window list (the same `{title, region, isActive, …}` shape `desktop_discover` reports) |

On Chromium windows UIA is sparse, so `focusedElement` / `cursorOverElement` can be `null` — reach for the CDP tools there.

> The standalone `get_history` (recent-action ring buffer) and
> `get_document_state` (active CDP tab state) tools were privatized in the
> Phase 1–4 consolidation. The same data is now opt-in on any response via the
> `include` argument (`your_last_action` / `events` / the `working` /
> `episodic` memory layers, since v1.2/v1.3), and active-tab state comes back
> from `browser_open` / `browser_eval`.

---

### ⏱️ wait_until

#### `wait_until`
Server-side polling until a condition is met — no round trips from the LLM.

```
wait_until(condition="window_appears",          target={windowTitle:"Save complete"}, timeoutMs=10000)
wait_until(condition="window_disappears",       target={windowTitle:"Loading…"})
wait_until(condition="element_appears",         target={windowTitle:"Notepad", elementName:"Save"})
wait_until(condition="focus_changes",           target={windowTitle:"Notepad"})
wait_until(condition="value_matches",           target={windowTitle:"Notepad", elementName:"File name", pattern:"memo"})
wait_until(condition="page_ready",              target={windowTitle:"Chrome"})
wait_until(condition="terminal_output_contains", target={windowTitle:"PowerShell", pattern:"Done"})
wait_until(condition="element_matches",         target={windowTitle:"Notepad", selector:"#status", pattern:"ready"})
```

| Parameter | Meaning |
|---|---|
| `condition` | One of the values above |
| `target` | Condition-specific descriptor (`windowTitle` / `elementName` / `pattern` …). **Also accepts a JSON-stringified object** (see *Param coercion*) |
| `timeoutMs` | Default 10000 |
| `pollMs` | Default 500 |

---

### 🖥️ Terminal

`terminal` is a unified dispatcher over `run` / `read` / `send`.

#### `terminal(action='run')`
Sends a command, waits for it to complete, and reads the output in one call. How
"complete" is decided is controlled by `until`:

| Mode | Waits for | Best for |
|---|---|---|
| `quiet` (default) | output to fall silent for `quietMs` | short interactive commands |
| `pattern` | a string/regex you expect in the output (optional `quietMs` settle fallback) | long commands with a known final marker |
| `exit` | the command to actually **finish** — returns the real process exit code | when you need completion or the exit code |

`mode:'exit'` appends a completion marker whose *printed* form differs from its
*typed* form, so it never matches the echoed command line (even for multi-line
input). Pass `shell` explicitly (`'bash'` / `'powershell'`); `cmd.exe` is not yet
supported. Unsafe input (unterminated quote / here-doc / `$(…)` / trailing `\` or
backtick) is rejected up front rather than hanging.

```js
terminal({ action:'run', windowTitle:'pwsh', input:'npm run build',
           until:{ mode:'exit', shell:'powershell' } })
// → completion: { reason:'exited', exitCode:0, elapsedMs:… }, output: real output only
```

#### `terminal(action='read')`
Reads the current buffer of PowerShell / cmd / Windows Terminal via UIA `TextPattern`, falling back to OCR.

```json
{ "text": "PS C:\\> echo hello\nhello\nPS C:\\> ", "source": "uia" }
```

#### `terminal(action='send')`
Sends raw input to a terminal. `waitForPrompt` blocks until the next prompt reappears.

---

### 📊 Office (Excel)

#### `excel`
Author and run Excel VBA macros over COM late binding — the headline differentiator
against formula-only assistants that cannot execute VBA.

- `action='run_vba'` writes a `Sub` into a managed Trusted Location
  (`%LOCALAPPDATA%\desktop-touch-mcp\trusted-vba`), opens it, and `Application.Run`s
  the macro. `macroName` must appear as `Sub <name>(…)` in `code` (else
  `VbaMacroNotFound`).
- `action='check_access_vbom'` is a read-only preflight returning
  `{ trusted, lockedByPolicy, scope }` — run it first so the remediation hint
  pre-empts an opaque COM failure inside `run_vba`.
- One-time setup: `node scripts/enable-access-vbom.mjs` registers the Trusted
  Location and the required HKCU trust keys; Excel must be restarted afterwards.
  Excel COM is single-threaded, so calls serialise through the bridge's worker
  thread.

```js
excel({ action:'check_access_vbom' })                       // → { trusted:true, scope:'hkcu' }
excel({ action:'run_vba',
        code:'Sub Demo()\n  Range("A1").Value = "Hello"\nEnd Sub' })
```

---

### 🩺 Diagnostics

#### `server_status`
Reports native-engine health and feature activation — whether the Rust UIA / image
engine loaded, which fallbacks are active, and version / capability flags. Use it to
confirm the native path is live (vs the PowerShell fallback) when latency looks off.

---

### 🌐 Browser CDP (Chrome / Edge)

Available once Chrome / Edge is running with `--remote-debugging-port=9222`.

```bash
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

#### `browser_open`
Connect to CDP and list tabs. The returned `tabId` pins subsequent calls to a specific tab. Each tab carries an `active` flag, and the top-level response surfaces the currently-focused tab.

Pass `launch:{}` (or `launch:{browser, userDataDir, url, waitMs}` overrides) to auto-spawn Chrome / Edge / Brave in debug mode when no CDP endpoint is live on the target port. The launch step is **idempotent**: if an endpoint is already live, the spawn is skipped and connect proceeds. Omit `launch` for pure connect (fail if no endpoint).

#### `browser_locate`
CSS selector → physical pixel coords.
Formula: `physX = (screenX + chromeW/2 + rect.left) * dpr`, with the browser chrome (tab strip + address bar) and `devicePixelRatio` already baked in.
`inViewport` is judged from the element's centre point, so a 1-pixel overflow does not flip it to `false`.

#### `browser_click`
`getElementScreenCoords` + `ensureBrowserFocused` + nut-js click in one step. If the element is out of the viewport, returns a message telling the caller to scroll it into view instead of guessing.

#### `browser_eval`
Discriminated dispatcher with three actions:
- **`action:'js'`** — Evaluate JS via `Runtime.evaluate` (CDP). `awaitPromise=true`, so `await` works. Exceptions from the page surface as `JS exception in tab: …`.
- **`action:'dom'`** — Return `outerHTML` of an element (or `document.body`), truncated to `maxLength`. Missing-element errors come back as a structured `{"__cdpError":"…"}` so the caller can distinguish "no match" from "empty HTML".
- **`action:'appState'`** — One CDP call that scans the well-known places SPAs stash their hydration payloads (see `appState` section below).

All three actions share the dispatcher's `withPostState` wrap, so guards run and `post.perception` is attached when a `lensId` is supplied.

> **Caveat — React / Vue / Svelte controlled inputs:** Setting `element.value = ...` via `browser_eval(action:'js')` does **not** update the framework's internal state. Use `browser_fill(selector, value)` instead — it uses the native prototype setter + `InputEvent` which does trigger React/Vue/Svelte state updates.

#### `browser_overview`
Enumerates interactive elements with `clickAt` coords — the browser analogue of `screenshot(detail="text")`. Each element includes `viewportPosition` (`'in-view'|'above'|'below'|'left'|'right'`) — use it to decide whether `scroll(action='to_element')` is needed before clicking.
Also **ARIA-aware**: surfaces `role=switch` / `checkbox` / `radio` / `tab` / `menuitem` / `option` custom controls with a `state` block carrying `checked` / `pressed` / `selected` / `expanded` derived from the matching `aria-*` attributes. Use this when a page (Radix / shadcn / MUI / Headless UI / GitHub) renders toggles as ARIA buttons instead of native `<input>`.

**Form-state verification (preferred over screenshot for button/toggle state):** Call this after form submission to check button, checkbox, and ARIA toggle states — structured JSON, no image tokens. For inputs, `text` reflects the empty-field hint text when set (takes priority over any typed value); to read the actual typed content use `browser_eval('document.querySelector(sel).value')`.

#### `browser_fill`
Fill a React/Vue/Svelte controlled input via CDP without breaking framework state. Uses native prototype setter + `InputEvent` dispatch (not `execCommand`). Obtain `selector` from `browser_form` / `browser_overview` / `browser_locate` first. `actual` in the response reflects what the element's `value` property reads after fill — verify it matches. Does not work on `contenteditable` rich-text editors.

#### `browser_form`
Inspect every form field (`input` / `select` / `textarea` / `button`) inside a CSS-selector container and return each field's name, type, id, current value, hint text, disabled / readOnly state, and resolved label (via `for[id]` → ancestor `<label>` → `aria-labelledby` → `aria-label`). Call this *before* `browser_fill` to discover exact selectors and avoid targeting the wrong input (e.g. a global search bar). `type=hidden` fields are excluded unless `includeHidden:true`.

#### `browser_eval(action:'appState')`
One CDP call that scans the well-known places SPAs stash their hydration payloads:
`__NEXT_DATA__` / `__NUXT_DATA__` / `__NUXT__` / `__REMIX_CONTEXT__` / `__APOLLO_STATE__` / GitHub react-app `[data-target$="embeddedData"]` / JSON-LD / `window.__INITIAL_STATE__`. Returns `{found:[{selector, framework, sizeBytes, truncated, payload}], notFound:[…]}`.
Use this *before* `action:'js'` / `action:'dom'` on SPA pages where the HTML is sparse but the state is rich. Override with `selectors:['script#my-data', 'window:__MY_KEY__']`.

#### `browser_navigate`
`Page.navigate` (CDP). Only `http://` / `https://` are accepted (`javascript:` / `file:` rejected). `waitForLoad:true` (default) blocks until `document.readyState === "complete"` and returns `{title, url, readyState, elapsedMs}`. On timeout the call stays `ok:true` with `hints.warnings:["NavigateTimeout"]` so callers can continue.

#### `browser_search`
Grep the DOM by text / regex / role / ariaLabel / CSS selector with confidence ranking. `scope` limits the search; `offset` / `maxResults` paginate.

**Response annotations shared by the DOM-touching tools**
(`browser_eval` (any action) / `browser_locate` / `browser_overview`)
- On success the response ends with `activeTab:{id,title,url}` + `readyState:"complete"` so callers can detect tab drift.
- Pass `includeContext:false` to drop those two trailing lines (saves ~150 tokens per call when chaining invocations in one tab).
- Even at `includeContext:true`, consecutive calls within 500 ms reuse one internal `getTabContext` round-trip.

**Session management**
`sessions: Map<"port:tabId", CdpSession>` caches live sessions. `connecting: Map` deduplicates concurrent connects to the same tab. On error / close the session flips `_closed=true`, blocking further commands.

---

### 📜 Macro / scroll

#### `run_macro`
Runs up to 50 tools sequentially in a single MCP call. A `sleep` pseudo-command waits up to 10 000 ms. No recursion.

```json
{
  "steps": [
    { "tool": "focus_window",    "params": {"title": "Notepad"} },
    { "tool": "sleep",           "params": {"ms": 300} },
    { "tool": "keyboard(action='type')",   "params": {"text": "Hello!", "use_clipboard": true} },
    { "tool": "screenshot",      "params": {"windowTitle": "Notepad", "detail": "text"} }
  ]
}
```

#### `scroll(action='capture')`
Scrolls a window top-to-bottom and stitches a full-height screenshot — useful for **whole-page content overview** (long pages / documents).

Output is size-guarded to fit the MCP 1 MB envelope: PNG is tried first; if the raw bytes exceed 700 KB, the image falls back to WebP (q70 → q55 → q40) and then iterative ×0.75 downscaling. When compression is applied, the `summary` object includes a `sizeReduced` field (e.g. `"webp_q55"`) and a `tip` suggesting `maxScrolls` reduction or `grayscale=true`.

> **When not to use:** For partial verification or locating a specific element, prefer `scroll` + `screenshot(detail='text')` — you get `actionable[]` with `clickAt` coords and pay only per-viewport token cost. `scroll(action='capture')` returns a stitched image (not clickable elements) that is expensive in tokens regardless of the 1 MB guard.

---

### 📋 Clipboard

#### `clipboard(action='read')`
Return the current Windows clipboard text.
```json
{ "ok": true, "text": "Hello, clipboard!" }
```
Non-text payloads (images, file paths copied as shell objects) return `text: ""` — not an error.

#### `clipboard(action='write')`
Place text on the Windows clipboard. Full Unicode / emoji / CJK support via UTF-16LE base64 encoding.
```
clipboard(action='write')(text="Hello — smart quotes: "test"")
```
Overwrites any existing clipboard content; non-text formats (images, files) are cleared.

---

### 🔔 Notification

#### `notification_show`
Show a Windows system tray balloon notification. Useful to alert the user when a long-running automated task finishes without them needing to watch the screen.
```
notification_show(title="Build complete", body="All 42 tests passed in 18s")
```
Uses `System.Windows.Forms.NotifyIcon` — no external modules or WinRT dependency. Fire-and-forget: returns immediately; the balloon stays visible for ~6 s.
**Caveat:** Focus Assist (Do Not Disturb) suppresses balloon tips. The tool still returns `ok:true` in that case.

---

### 🎯 Scroll to Element

#### `scroll(action='to_element')`
Scroll a named element into the visible viewport without computing scroll amounts manually.

Two paths:

| Path | Required args | Mechanism |
|---|---|---|
| Chrome/Edge (CDP) | `selector` | `el.scrollIntoView({block, behavior:'instant'})` — coords stabilize immediately |
| Native (UIA) | `name` + `windowTitle` | `ScrollItemPattern.ScrollIntoView()` |

```
scroll(action='to_element')({selector: '#submit-btn'})                    # Chrome path
scroll(action='to_element')({name: 'OK', windowTitle: 'Settings'})        # native UIA path
scroll(action='to_element')({selector: '.hero', block: 'start'})          # align to top of viewport
```

`block` controls vertical alignment (`start` / `center` / `end` / `nearest`, default `center`) — Chrome path only.

Returns `scrolled:true` on success; `scrolled:false` if the element doesn't expose `ScrollItemPattern` (fall back to `scroll` + `screenshot`). Pairs well with `browser_overview` / `screenshot(detail='text')` to confirm `viewportPosition:'in-view'` after scrolling.

---

### 🚀 SmartScroll

#### `scroll(action='smart')`

Unified scroll dispatcher that handles the cases where `scroll(action='to_element')` falls short:

| Situation | What `scroll(action='smart')` does |
|---|---|
| Virtualised list (TanStack, React Virtualized) | TanStack API → `data-index` DOM → proportional bisect (≤6 iterations) |
| Nested scroll containers | Walks ancestor chain (CDP or UIA), scrolls outer → inner |
| Sticky header occlusion | Detects fixed/sticky header overlap, compensates `scrollTop` |
| `overflow:hidden` ancestor | Returns `OverflowHiddenAncestor` error; `expandHidden:true` unlocks |
| No CDP/UIA (image-only) | Win32 `GetScrollInfo` + scrollbar-strip pixel sampling + dHash binary-search |

**Scroll verification:** `verifyWithHash:true` (auto-enabled for image path) computes a 64-bit perceptual hash before and after each attempt — if Hamming distance < 5, the page didn't move (virtual scroll boundary or swallowed input). Reported as `scrolled:false`.

**Unified response:** `{ ok, path:"cdp"|"uia"|"image", attempts, pageRatio, scrolled, ancestors[], viewportPosition, occludedBy?, warnings? }`

`pageRatio` (0..1): normalised vertical position of the target element on the full page (0 = top, 1 = bottom).

**Scroll resolution priority:** `strategy:"auto"` (default) tries CDP → UIA → image in order, falling through on failure or no-op.

```
# CDP: nested scroll + virtualised list
scroll(action='smart')({target: '[data-index]', virtualIndex: 500, virtualTotal: 10000})

# UIA: native app
scroll(action='smart')({target: 'Create Release', windowTitle: 'File Explorer', strategy: 'uia'})

# Image: binary-search with LLM hint
scroll(action='smart')({target: 'readme section', windowTitle: 'MyApp', strategy: 'image', hint: 'below'})

# Sticky-header-compensated CDP scroll
scroll(action='smart')({target: '#footer-nav'})  # detects and compensates automatically
```

`pageRatio` is also emitted per-element by `browser_overview` (injected JS now computes `(scrollY + rect.top) / scrollHeight`).

---

### 👁️ Auto-Perception — attention signal & guards

Low-cost situational awareness for repeated desktop actions. This is an **always-on
internal layer**, not a tool family: every `desktop_state` and `desktop_act`
response carries an `attention` signal, and action tools auto-guard whenever you
pass a `windowTitle` / `tabId`. The server verifies target identity, focus,
readiness, modal obstruction, and click safety *before* the action, then attaches
a compact `post.perception` envelope *after* it — without forcing another
`screenshot` or `desktop_state` round trip.

The internal unit of tracking is a `PerceptionLens`: a live state tracker for one
task-relevant target. It is not a screenshot cache and not a raw event stream — it
maintains only the structured state needed to decide whether the next action is
still safe.

> **Retired tools:** the explicit `perception_register` / `perception_read` /
> `perception_forget` / `perception_list` tools were privatized in the Phase 1–4
> consolidation — manual lens registration is no longer needed. The registry, hot
> target cache, and sensor loop are unchanged; they are now driven automatically.
> The `perception://lens/{id}/{summary|guards|debug|events}` MCP resources remain
> available behind `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` for inspection.

#### Fluents tracked per target

| Fluent | What it tracks |
|---|---|
| `target.exists` | Is the HWND still visible? |
| `target.title` | Current window title |
| `target.foreground` | Is the window in the foreground? |
| `target.zOrder` | Z-order index (0 = topmost) |
| `target.rect` | Window bounding rect (pixels) |
| `target.identity` | `{ hwnd, pid, processName, processStartTimeMs }` |
| `modal.above` | Is a topmost/dialog-class window above the target? |
| `browser.url` | Current browser tab URL for `browserTab` lenses |
| `browser.title` | Current browser tab title for `browserTab` lenses |
| `browser.readyState` | Current document readiness for `browserTab` lenses |

#### Guards

| Guard | Blocks when |
|---|---|
| `target.identityStable` | `pid` or `processStartTimeMs` differs from registration time (app restarted / different process) |
| `safe.keyboardTarget` | Window is not foreground, OR a modal is above it, OR identity is unstable |
| `safe.clickCoordinates` | Click point is outside the target rect (or rect is stale >500 ms) |
| `stable.rect` | Rect changed in the last 250 ms (window moving / resizing) |
| `browser.ready` | Browser tab is not yet ready for DOM-oriented actions |

#### Perception envelope shape (`post.perception`)

```json
{
  "lens": "perc-1",
  "seq": 12,
  "attention": "ok",
  "guards": { "target.identityStable": true, "safe.keyboardTarget": true },
  "latest": {
    "target": {
      "title": "Untitled - Notepad",
      "foreground": true,
      "rect": { "x": 78, "y": 78, "width": 976, "height": 618 },
      "identity": { "hwnd": "...", "pid": 1234, "processName": "notepad.exe" }
    },
    "modal": { "above": false }
  },
  "changed": []
}
```

`attention` values: `"ok"` / `"changed"` / `"dirty"` / `"settling"` / `"stale"` / `"guard_failed"` / `"identity_changed"` / `"needs_escalation"`

#### Usage example

```
# Auto guard: just pass windowTitle. Guards + envelope are automatic.
keyboard(action='type')({text:"hello", windowTitle:"Notepad"})
→ post.perception: {attention:"ok", guards:{...}, latest:{target:{title, rect, foreground}}}

# When the app restarts (different pid), the identity guard fires closed:
keyboard(action='type')({text:"x", windowTitle:"Notepad"})
→ {ok:false, code:"GuardFailed", suggest:[...]}
```

For advanced pinned-target workflows the `lensId` parameter is still opt-in on:
`keyboard(action='type')`, `keyboard(action='press')`, `mouse_click`, `mouse_drag`,
`click_element`, `browser_click`, `browser_navigate`, `browser_eval`, `desktop_act`.
Omitting `lensId` uses the normal Auto-Perception path.

**Limits:** max 16 active lenses (LRU eviction). Sensor work is staged by cost:
cheap Win32/CDP state is refreshed first; UIA focus, OCR, and screenshots remain
escalation paths rather than baseline perception. `safe.clickCoordinates` validates
window bounds, not pixel-level occlusion.

#### Capabilities surfaced through Auto-Perception

**Auto guard**: Action tools guard automatically when `windowTitle` / `tabId` is passed — no manual registration needed. The `lensId` path remains for advanced pinned-target workflows.

**SuggestedFix**: When a guard blocks with `unsafe_coordinates` / `identity_changed`, the response may carry a one-shot `suggestedFix.fixId` (expires in 15 s). Pass it back to `mouse_click`, `keyboard(action='type')`, `click_element`, or `browser_click` to approve the recovery; the server revalidates the stored target fingerprint (process pid + start-time for windows; a fresh guard for browser tabs) before executing.

**Target-identity timeline**: The server maintains a per-target semantic event timeline (event kinds such as `target_bound`, `action_succeeded`, `action_blocked`, `title_changed`, `rect_changed`, `foreground_changed`, `navigation`, `modal_appeared`, `identity_changed`, `target_closed`). Storage is a per-target ring (32) plus a global cap (256); sensor events are 200 ms leading-edge debounced. It surfaces via the opt-in `include` envelope (`your_last_action` / `events` / the `episodic` memory layer) and the `perception://lens/{id}/events` resource (flag `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1`).

**Browser readiness policies**: `browser_click` passes with a warn-note when `readyState !== "complete"` but the selector is already in-viewport (policy: `selectorInViewport`). `browser_navigate` accepts `interactive` (policy: `navigationGate`). `browser_eval` remains strict.

**mouse_drag endpoint guard**: Both start and end coordinates are guarded. Cross-window / desktop drags are blocked by default; opt in with `allowCrossWindowDrag:true`.

**browser_eval structured mode**: Pass `withPerception:true` to receive `{ok, result, post}` JSON instead of raw text. Circular references, functions, and BigInt in eval results are safely serialized via a WeakSet-based replacer.

---

## Param coercion for LLM-friendly spellings

Boolean / object parameters accept the string spellings some MCP clients emit by accident:

- **boolean**: `"true"` / `"false"` (case-insensitive, whitespace trimmed) or `0` / `1` → real boolean
- **object**: a JSON-stringified object (`"{}"` or `'{"windowTitle":"x"}'`) is parsed before validation

Ambiguous input (`"yes"`, arbitrary strings) is still rejected so a typo cannot silently flip a flag. Numbers are **not** coerced here — use `z.coerce.number()` at the call site when you explicitly want it.

Touch points: `browser_navigate.waitForLoad` / `browser_search.visibleOnly|inViewportOnly|caseSensitive` / `events.drain` / `keyboard_*.forceFocus|trackFocus` / `wait_until.target` (and its nested `target.regex`).

---

## Layer buffer — MPEG P-frame strategy

> **v0.15:** The pixel-comparison kernel (`computeChangeFraction`) and perceptual hash (`dHash`) now run via the Rust SSE2 SIMD engine when available, achieving **13–15× throughput** over the TypeScript implementation.

```
workspace_snapshot()
    │  → capture every window, store in the buffer (I-frame)
    │
action (click, type, …)
    │
screenshot(diffMode=true)
    │  → re-capture every window
    │  → 8×8-block pixel compare (noise threshold = 16)
    │  → change ratio <2%:   unchanged (no image sent)
    │  → change ratio 2–100%: content_changed (only that window sent)
    │  → position change:    moved (coords only, no image)
    │  → new window:         new (full capture)
    └  → window closed:      closed (notification only)
```

**Net effect:** a confirmation after one click drops from ~443 tok (full) to ~160 tok (diff).

---

## Engineering notes

| Item | Detail |
|---|---|
| Window title | `GetWindowTextW` via koffi — nut-js mangles CJK |
| Scroll amount | nut-js's single step is tiny → multiplied internally by `SCROLL_MULTIPLIER=3` |
| UIA timeout | 8 s default; 500 ms for `getFocusedElement`; 2 s inside `workspace_snapshot` |
| UIA engine | Rust native (napi-rs + windows-rs 0.62) → PowerShell fallback. Native path: dedicated COM thread (MTA), batch BFS with `FindAllBuildCache(TreeScope_Children)` |
| UIA focus latency | **2.2 ms** (Rust) vs ~366 ms (PowerShell) |
| UIA tree latency | **~100 ms** (Rust, Explorer ~60 elements) vs ~346 ms (PowerShell) |
| Image diff engine | Rust SSE2 SIMD: `computeChangeFraction` 0.26 ms, `dHash` 0.09 ms (1080p) |
| PrintWindow flag | `2` (`PW_RENDERFULLCONTENT`) — captures GPU / Chrome / Electron / WinUI3 surfaces. Window-targeted `screenshot(detail='image')` calls fall back to BitBlt automatically when PrintWindow returns no data or an all-black + zero-variance frame; the route and fallback reason are surfaced via `hints.captureSource` / `hints.captureFallbackReason` |
| Default WebP quality | `60` — the lowest quality at which text stays readable |
| Layer-buffer TTL | Auto-cleared after 90 s |
| focus_window filter | Skips helper windows with width < 50 or height < 50 |
| focus_window / Chrome tabs | Chrome/Edge uses one HWND per browser window; only the active tab title is visible to the OS. `WindowNotFound` on a tab title → use `browser_open` to list tabs and switch via CDP instead |
| UIA element search | Rust: batch BFS with `FindAllBuildCache(TreeScope_Children)` + `maxElements` early exit. PowerShell fallback: recursive `FindAll(Children)` — `FindAll(Descendants)` misses items on some WinUI3 apps |
| CDP command timeout | 15 s (`CMD_TIMEOUT_MS`); WebSocket connect timeout 5 s (`CONNECT_TIMEOUT_MS`) |
| CDP fetch timeout | `AbortSignal.timeout(5s)` — handles a hung `/json` endpoint |
| window-cache TTL | 60 s — prevents stale-HWND mis-correction after reuse |
| Homing Tier 3 gate | Fires only when `delta > 200px` or `sizeChanged=true` |
| `post.focusedElement` timeout | 800 ms — cap for apps that don't answer UIA queries |
| UIA diff caps | 5 for `appeared` / `disappeared`, 3 for `valueDeltas` — overflow count lives in `truncated` |
| `narrate:"rich"` settle | 120 ms wait between the action and the after-snapshot |
| tab-context cache (browser tools) | 500 ms keyed by `(port, tabId)` — chained calls share one `getTabContext` round-trip |
| `--disable-extensions` exclusion | Chrome 147+ with this flag fails to bind the CDP port; removed from the E2E launcher |
| Perception lens limit | Max 16 active lenses; least-recently-used evicted (LRU since v0.13; FIFO in v0.12) |
| Perception sensor timer | Drains event-bus every 250 ms via a separate 250 ms `setInterval` on top of the event-bus's 500 ms Win32 polling tick; no extra `EnumWindows` calls |
| HWND type (koffi) | koffi `intptr` returns JS `number` at runtime; compared as strings (`String(w.hwnd) === hwnd`) to avoid `number === bigint` always-false |
| Perception confidence | `confidenceFor()` uses evidence SOURCE base (win32=0.98, image=0.60, inferred=0.50) — NOT the stored numeric observation value |
| `post.perception` strip | Included in the LLM-visible tool response (current call only); stripped from the history ring buffer only. Stored in `PostState.perception` for the duration of the current tool call |

---

## Install / registration

Registered as `desktop-touch` under `mcpServers` in `~/.claude.json` (stdio). Auto-starts / stops with the Claude CLI.

Build: `cd D:\git\desktop-touch-mcp && npm install` (the `prepare` hook runs `tsc` automatically).

The Rust native engine (`@harusame64/desktop-touch-engine`) is included in the release zip. It loads as a `.node` addon at startup — no Rust toolchain required for end users. If the addon is missing or fails to load, all UIA and image-diff operations fall back to TypeScript/PowerShell transparently.
