# desktop-touch-mcp — System Overview

MCP (Model Context Protocol) server that lets Claude CLI drive any Windows desktop application.

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
    │   │                     detectUiaBlind(): sparsity guard (< 5 elements OR single giant Pane ≥ 90%)
    │   ├── ocr-bridge.ts   — Windows OCR runner + SoM pipeline (v0.15.4)
    │   │                     runSomPipeline(): 11-stage Hybrid Non-CDP pipeline
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
    │       └── registry.ts         — central coordinator; max 16 lenses (FIFO evict)
    └── Layer 2: 57 MCP tools
        screenshot(4) + window(3) + mouse(5) + keyboard(2) + ui_elements(4) +
        browser_cdp(12) + workspace(2) + pin(2) + dock(1) + macro(1) +
        scroll_capture(1) + context(3) + terminal(2) + events(4) + wait_until(1) +
        clipboard(2) + notification(1) + scroll_to_element(1) + smart_scroll(1) +
        perception(4) + engine_status(1)
```

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

Every action tool (`mouse_click`, `keyboard_press`, `click_element`, …) returns a `post` block on success.

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

For `keyboard_press`, rich mode only fires for state-transitioning keys (Enter / Tab / Esc / F5). Single-character keys silently downgrade to minimal.

---

## Tool catalogue

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

#### `screenshot_background`
Captures a window even when it is behind another (PrintWindow API).
- `dotByDot=true` emits 1:1 WebP.
- Known limitation: GPU-rendered apps (Chrome / WinUI3) come back black.

#### `screenshot_ocr`
Word-level text with on-screen coords via Windows OCR (`Windows.Media.Ocr`). Fallback for apps where UIA is sparse.

#### `screenshot(detail="text")` — SoM fallback (v0.15.4)
When `detectUiaBlind()` fires (fewer than 5 UIA elements, or a single Pane covering ≥ 90% of the window), `screenshot(detail="text")` automatically activates the Hybrid Non-CDP pipeline instead of returning an empty element list:

1. Capture window via PrintWindow → RGBA buffer
2. Rust `preprocessImage()`: grayscale (BT.601 u8) + bilinear 2×/3× upscale + contrast stretch. Auto-clamps to scale=1 at >8 MP or ≥144 DPI.
3. Windows OCR → word list with bounding boxes
4. Two-stage clustering: char→word merges (gap < 0.5× char height) then word→element merges (gap < 2× line height)
5. Rust `drawSomLabels()`: red 2px bounding boxes + white badge with black ID number
6. Returns `somImage` (base64 PNG) + `elements[]` with `{ id, text, clickAt, region }`

Sharp library is the transparent fallback if the native `.node` engine is unavailable (no feature loss, only performance difference).

#### `get_screen_info`
Monitor list: resolution, position, DPI, cursor position.

---

### 🖥️ Window management

#### `get_windows`
All windows in Z-order.
```json
{ "zOrder": 0, "title": "Notepad", "region": {"x":78,"y":78,"width":976,"height":618},
  "isActive": true, "isMinimized": false, "isOnCurrentDesktop": true }
```

#### `get_active_window`
Information about the currently-focused window.

#### `focus_window`
Bring a window to the foreground by partial title match.
```
focus_window(title="Notepad")
focus_window(title="Chrome", chromeTabUrlContains="github.com")  # activate a specific tab first
```
`chromeTabUrlContains` activates the matching Chrome/Edge tab by URL substring before focusing the HWND. If CDP is unavailable, the parameter is silently skipped and `hints.warnings` surfaces `"cdpUnavailable"`.

#### `pin_window` / `unpin_window`
Toggle always-on-top; `duration_ms` for an auto-release timer.

#### `dock_window`
Parks any window in a screen corner while keeping it topmost. Handy for keeping the Claude CLI visible while other tools work.
```
dock_window({title:'Claude Code', corner:'bottom-right', width:480, height:360, pin:true})
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

#### `mouse_move`
Move the cursor.

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

The cache is refreshed automatically by `screenshot` / `get_windows` / `focus_window` / `workspace_snapshot`. A 60-second TTL keeps HWND reuse from steering the wrong window.

#### `mouse_drag`
Drag (startX,startY) → (endX,endY). When homing is active, the end-point gets the same delta as the start.

#### `scroll`
`direction`: `up` / `down` / `left` / `right`; `amount` is the step count. Internally multiplied by 3 because nut-js's single step is tiny.

#### `get_cursor_position`
Current cursor coords.

---

### ⌨️ Keyboard

Responses carry the `post` block; `narrate:"rich"` attaches a UIA diff (state-transitioning keys only).

#### `keyboard_type`
Text input.
- `use_clipboard=true` routes via PowerShell + clipboard, **bypassing any Japanese IME**. Required when typing URLs / paths under an active IME.
- Also required for text that contains em-dash (`—`), en-dash (`–`), smart quotes, or other non-ASCII punctuation — these can be intercepted as keyboard accelerators by Chrome/Edge. `keyboard_type` detects these characters automatically and upgrades to clipboard mode (`method:'clipboard-auto'`). Opt out with `forceKeystrokes=true`.
- `replaceAll=true` sends Ctrl+A before typing to replace any existing content (requires the field to already be focused).

#### `keyboard_press`
Key combos.
```
keyboard_press(keys="ctrl+c")
keyboard_press(keys="alt+f4")
keyboard_press(keys="ctrl+shift+s")
```

> **⚠️ Input routing gotcha (when `dock_window` is pinned)**
> `keyboard_type` / `keyboard_press` send to **whichever window is currently focused**. If `dock_window(pin=true)` has pinned the Claude CLI topmost, keystrokes can land on the CLI instead of the target app.
> Always call `focus_window(title=…)` first, then verify with `screenshot(detail='meta')` that `isActive=true` on the target. Canonical pattern: `focus_window → keyboard_press/type → screenshot(diffMode=true)`.

---

### 🔍 UI Automation (UIA)

> **v0.15:** All UIA operations route through the Rust native engine by default (direct COM calls, 2–100 ms). PowerShell fallback activates automatically if the native engine is unavailable.

Action tools (`click_element` / `set_element_value`) return the `post` block; `narrate:"rich"` adds a UIA diff.

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

#### `get_ui_elements`
The raw UIA tree. Use this when you need an `automationId`. Each element includes `viewportPosition` (`'in-view'|'above'|'below'|'left'|'right'`) relative to the window client region — use it to decide whether `scroll_to_element` is needed before clicking. Results are capped at `maxElements` (default 80, max 200).

#### `click_element`
Click by name / ID via UIA `InvokePattern` — no coords needed.
```
click_element(windowTitle="Notepad", name="Settings", controlType="Button")
```

#### `set_element_value`
Set a text field directly via UIA `ValuePattern`.
```
set_element_value(windowTitle="Notepad", name="Text editor", value="Hello!")
```

#### `scope_element`
Zoomed (1280 px) capture of one element + its child tree.

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

#### `get_context`
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
| `windows` | Z-ordered window list (same shape as `get_windows`) |

On Chromium windows UIA is sparse, so `focusedElement` / `cursorOverElement` can be `null` — reach for the CDP tools there.

#### `get_history`
Summaries of the most recent actions (default 5, max 20).

```json
[
  { "tool": "mouse_click", "ok": true,
    "post": { "focusedWindow": "Notepad", "windowChanged": false, "elapsedMs": 35 },
    "tsMs": 1744600000000 }
]
```

Useful inside loops / repeated operations to check what the previous step actually did. `post.rich` is not stored in the ring buffer (keeps it small).

#### `get_document_state`
CDP state for the active tab (Chrome / Edge).

```json
{
  "title": "Google",
  "url": "https://www.google.com/",
  "readyState": "complete",
  "activeTab": { "id": "abc123", "port": 9222 }
}
```

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

#### `terminal_read`
Reads the current buffer of PowerShell / cmd / Windows Terminal via UIA `TextPattern`, falling back to OCR.

```json
{ "text": "PS C:\\> echo hello\nhello\nPS C:\\> ", "source": "uia" }
```

#### `terminal_send`
Sends input to a terminal (SendKeys). `waitForPrompt` blocks until the next prompt reappears.

---

### 📡 Async events

#### `events_subscribe`
Subscribe to window / focus / browser-navigation changes. Returns a `subscriptionId`.

#### `events_poll`
Drain the queue for a subscription (up to `maxEvents`). Long-poll style.

#### `events_unsubscribe`
Drop a subscription.

#### `events_list`
List active subscriptions.

**Event kinds:** `window_appeared` / `window_disappeared` / `window_moved` / `focus_changed` / `browser_navigated`

---

### 🌐 Browser CDP (Chrome / Edge)

Available once Chrome / Edge is running with `--remote-debugging-port=9222`.

```bash
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

#### `browser_launch`
Launch Chrome / Edge / Brave in debug mode and wait for the CDP endpoint. Idempotent: if an endpoint is already live on the target port, returns immediately. `url` sets an initial page.

#### `browser_connect`
Connect to CDP and list tabs. The returned `tabId` pins subsequent calls to a specific tab. Each tab carries an `active` flag, and the top-level response surfaces the currently-focused tab.

#### `browser_find_element`
CSS selector → physical pixel coords.
Formula: `physX = (screenX + chromeW/2 + rect.left) * dpr`, with the browser chrome (tab strip + address bar) and `devicePixelRatio` already baked in.
`inViewport` is judged from the element's centre point, so a 1-pixel overflow does not flip it to `false`.

#### `browser_click_element`
`getElementScreenCoords` + `ensureBrowserFocused` + nut-js click in one step. If the element is out of the viewport, returns a message telling the caller to scroll it into view instead of guessing.

#### `browser_eval`
Evaluate JS via `Runtime.evaluate` (CDP). `awaitPromise=true`, so `await` works. Exceptions from the page surface as `JS exception in tab: …`.

> **Caveat — React / Vue / Svelte controlled inputs:** Setting `element.value = ...` via `browser_eval` does **not** update the framework's internal state. Use `browser_fill_input(selector, value)` instead — it uses the native prototype setter + `InputEvent` which does trigger React/Vue/Svelte state updates.

#### `browser_get_dom`
`outerHTML` of an element (or `document.body`), truncated to `maxLength`. Missing-element errors come back as a structured `{"__cdpError":"…"}` so the caller can distinguish "no match" from "empty HTML".

#### `browser_get_interactive`
Enumerates interactive elements with `clickAt` coords — the browser analogue of `screenshot(detail="text")`. Each element includes `viewportPosition` (`'in-view'|'above'|'below'|'left'|'right'`) — use it to decide whether `scroll_to_element` is needed before clicking.
Also **ARIA-aware**: surfaces `role=switch` / `checkbox` / `radio` / `tab` / `menuitem` / `option` custom controls with a `state` block carrying `checked` / `pressed` / `selected` / `expanded` derived from the matching `aria-*` attributes. Use this when a page (Radix / shadcn / MUI / Headless UI / GitHub) renders toggles as ARIA buttons instead of native `<input>`.

**Form-state verification (preferred over screenshot for button/toggle state):** Call this after form submission to check button, checkbox, and ARIA toggle states — structured JSON, no image tokens. For inputs, `text` reflects the empty-field hint text when set (takes priority over any typed value); to read the actual typed content use `browser_eval('document.querySelector(sel).value')`.

#### `browser_fill_input`
Fill a React/Vue/Svelte controlled input via CDP without breaking framework state. Uses native prototype setter + `InputEvent` dispatch (not `execCommand`). Obtain `selector` from `browser_get_interactive` or `browser_find_element` first. `actual` in the response reflects what the element's `value` property reads after fill — verify it matches. Does not work on `contenteditable` rich-text editors.

#### `browser_get_app_state`
One CDP call that scans the well-known places SPAs stash their hydration payloads:
`__NEXT_DATA__` / `__NUXT_DATA__` / `__NUXT__` / `__REMIX_CONTEXT__` / `__APOLLO_STATE__` / GitHub react-app `[data-target$="embeddedData"]` / JSON-LD / `window.__INITIAL_STATE__`. Returns `{found:[{selector, framework, sizeBytes, truncated, payload}], notFound:[…]}`.
Use this *before* `browser_eval` / `browser_get_dom` on SPA pages where the HTML is sparse but the state is rich. Override with `selectors:['script#my-data', 'window:__MY_KEY__']`.

#### `browser_navigate`
`Page.navigate` (CDP). Only `http://` / `https://` are accepted (`javascript:` / `file:` rejected). `waitForLoad:true` (default) blocks until `document.readyState === "complete"` and returns `{title, url, readyState, elapsedMs}`. On timeout the call stays `ok:true` with `hints.warnings:["NavigateTimeout"]` so callers can continue.

#### `browser_search`
Grep the DOM by text / regex / role / ariaLabel / CSS selector with confidence ranking. `scope` limits the search; `offset` / `maxResults` paginate.

#### `browser_disconnect`
Close every cached WebSocket session for a port. Call this before the target HWND goes away.

**Response annotations shared by the DOM-touching tools**
(`browser_eval` / `browser_find_element` / `browser_get_dom` / `browser_get_interactive` / `browser_get_app_state`)
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
    { "tool": "keyboard_type",   "params": {"text": "Hello!", "use_clipboard": true} },
    { "tool": "screenshot",      "params": {"windowTitle": "Notepad", "detail": "text"} }
  ]
}
```

#### `scroll_capture`
Scrolls a window top-to-bottom and stitches a full-height screenshot — useful for **whole-page content overview** (long pages / documents).

Output is size-guarded to fit the MCP 1 MB envelope: PNG is tried first; if the raw bytes exceed 700 KB, the image falls back to WebP (q70 → q55 → q40) and then iterative ×0.75 downscaling. When compression is applied, the `summary` object includes a `sizeReduced` field (e.g. `"webp_q55"`) and a `tip` suggesting `maxScrolls` reduction or `grayscale=true`.

> **When not to use:** For partial verification or locating a specific element, prefer `scroll` + `screenshot(detail='text')` — you get `actionable[]` with `clickAt` coords and pay only per-viewport token cost. `scroll_capture` returns a stitched image (not clickable elements) that is expensive in tokens regardless of the 1 MB guard.

---

### 📋 Clipboard

#### `clipboard_read`
Return the current Windows clipboard text.
```json
{ "ok": true, "text": "Hello, clipboard!" }
```
Non-text payloads (images, file paths copied as shell objects) return `text: ""` — not an error.

#### `clipboard_write`
Place text on the Windows clipboard. Full Unicode / emoji / CJK support via UTF-16LE base64 encoding.
```
clipboard_write(text="Hello — smart quotes: "test"")
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

#### `scroll_to_element`
Scroll a named element into the visible viewport without computing scroll amounts manually.

Two paths:

| Path | Required args | Mechanism |
|---|---|---|
| Chrome/Edge (CDP) | `selector` | `el.scrollIntoView({block, behavior:'instant'})` — coords stabilize immediately |
| Native (UIA) | `name` + `windowTitle` | `ScrollItemPattern.ScrollIntoView()` |

```
scroll_to_element({selector: '#submit-btn'})                    # Chrome path
scroll_to_element({name: 'OK', windowTitle: 'Settings'})        # native UIA path
scroll_to_element({selector: '.hero', block: 'start'})          # align to top of viewport
```

`block` controls vertical alignment (`start` / `center` / `end` / `nearest`, default `center`) — Chrome path only.

Returns `scrolled:true` on success; `scrolled:false` if the element doesn't expose `ScrollItemPattern` (fall back to `scroll` + `screenshot`). Pairs well with `browser_get_interactive` / `screenshot(detail='text')` to confirm `viewportPosition:'in-view'` after scrolling.

---

### 🚀 SmartScroll

#### `smart_scroll`

Unified scroll dispatcher that handles the cases where `scroll_to_element` falls short:

| Situation | What `smart_scroll` does |
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
smart_scroll({target: '[data-index]', virtualIndex: 500, virtualTotal: 10000})

# UIA: native app
smart_scroll({target: 'Create Release', windowTitle: 'File Explorer', strategy: 'uia'})

# Image: binary-search with LLM hint
smart_scroll({target: 'readme section', windowTitle: 'MyApp', strategy: 'image', hint: 'below'})

# Sticky-header-compensated CDP scroll
smart_scroll({target: '#footer-nav'})  # detects and compensates automatically
```

`pageRatio` is also emitted per-element by `browser_get_interactive` (injected JS now computes `(scrollY + rect.top) / scrollHeight`).

---

### 👁️ Reactive Perception Graph (v0.11)

Low-cost situational awareness for repeated desktop actions. Register a perception lens on a target window or browser tab, then pass `lensId` to action tools. The server verifies target identity, focus, readiness, modal obstruction, and click safety before the action, then attaches a compact `post.perception` envelope after the action — without forcing another `screenshot` or `get_context` round trip.

The unit of tracking is a `PerceptionLens`: a live state tracker for one task-relevant target. It is not a screenshot cache and not a raw event stream. It maintains only the structured state needed to decide whether the next action is still safe.

#### `perception_register`

Register a live perception lens on a target window or browser tab. Returns a `lensId`.

```
perception_register({
  name: "editor",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  guards: ["target.identityStable", "safe.keyboardTarget"],
  guardPolicy: "block",   // "warn" | "block" (default: "block")
  maxEnvelopeTokens: 120,
})
→ { lensId: "perc-1", seq: 1, digest: "..." }
```

The server resolves the target (foreground-preferred for duplicate window titles), populates structured fluents, and keeps them fresh through Win32/CDP/UIA sensors. Subsequent action tool calls with `lensId` will:
1. **Guard check** — refresh relevant state and evaluate guards before the action. If `guardPolicy:"block"` and a guard fails, the action fails closed with `{ok:false, code:"GuardFailed", suggest:[...]}`.
2. **Envelope** — attach `post.perception` to the success response with attention, guard states, changed fields, and the latest known target state.

#### `perception_read`

Force-refresh a lens and return its current perception envelope. Use when `post.perception.attention` is `dirty`, `stale`, `settling`, `guard_failed`, or `identity_changed`, or when you want fresh structured state without performing an action.

```
perception_read({ lensId: "perc-1" })
→ PerceptionEnvelope
```

#### `perception_forget`

Deregister a lens. When all lenses are deregistered the sensor loop stops automatically.

```
perception_forget({ lensId: "perc-1" }) → { ok: true }
```

#### `perception_list`

List all active lenses with their binding, seq, and attention state.

#### Fluents maintained per lens

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
# Register once
perception_register({name:"editor", target:{kind:"window", match:{titleIncludes:"Notepad"}}})
→ {lensId:"perc-1"}

# Pass lensId to any action tool. Guards + envelope are automatic.
keyboard_type({text:"hello", windowTitle:"Notepad", lensId:"perc-1"})
→ post.perception: {attention:"ok", guards:{...}, latest:{target:{title, rect, foreground}}}

# When the app restarts (different pid), identity guard fires:
keyboard_type({text:"x", lensId:"perc-1"})
→ {ok:false, code:"GuardFailed", suggest:["Re-register lens for the new process instance"]}
```

`lensId` is opt-in on: `keyboard_type`, `keyboard_press`, `mouse_click`, `mouse_drag`, `click_element`, `set_element_value`, `browser_click_element`, `browser_navigate`, `browser_eval`. Omitting `lensId` preserves existing behavior exactly.

**Limits:** max 16 active lenses (LRU eviction — see below). Sensor work is staged by cost: cheap Win32/CDP state is refreshed first; UIA focus, OCR, and screenshots remain escalation paths rather than baseline perception. `safe.clickCoordinates` validates window bounds, not pixel-level occlusion.

#### v0.13 — Auto Perception (v3 closure)

**Auto guard (v0.12+)**: Action tools guard automatically when `windowTitle`/`tabId` is passed — no `perception_register` needed. The `lensId` path remains for advanced pinned-lens workflows.

**Manual Lens LRU (v0.13)**: Lens eviction is now LRU (least-recently-used). Using a lens via `perception_read`, evaluatePreToolGuards, or buildEnvelopeFor promotes it to MRU. Idle lenses are evicted first. Max 16 unchanged.

**SuggestedFix — all 4 tools (v0.13)**: `fixId` approval is now supported by `mouse_click`, `keyboard_type`, `click_element`, and `browser_click_element`. The server revalidates the stored target fingerprint (process pid + start-time for windows; subsequent guard for browser tabs) before executing.

**Target-Identity Timeline (v0.13)**: The server maintains a per-target semantic event timeline. 13 event kinds (`target_bound`, `action_attempted`, `action_succeeded`, `action_blocked`, `title_changed`, `rect_changed`, `foreground_changed`, `navigation`, `modal_appeared`, `modal_dismissed`, `identity_changed`, `target_closed`, `compacted`). Storage: per-target ring (32), global FIFO cap (256). Sensor events are 200ms leading-edge debounced; action/post events are not. Exposed via:
- `get_history` → `recentTargetKeys` (3 keys, no event bodies)
- `perception_read(lensId)` → `recentEvents` (up to 10 per target)
- `perception://target/{targetKey}/timeline` + `perception://targets/recent` (flag: `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1`)

**Browser readiness policies (v0.13)**: `browser_click_element` passes with a warn-note when `readyState !== "complete"` but the selector is already in-viewport (policy: `selectorInViewport`). `browser_navigate` accepts `interactive` (policy: `navigationGate`). `browser_eval` remains strict.

**mouse_drag endpoint guard (v0.13)**: Both start and end coordinates are guarded. Cross-window / desktop drags blocked by default; opt in with `allowCrossWindowDrag:true`.

**browser_eval structured mode (v0.13)**: Pass `withPerception:true` to receive `{ok, result, post}` JSON instead of raw text. Circular references, functions, and BigInt in eval results are safely serialized via WeakSet-based replacer.

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
| PrintWindow flag | `0` — GPU / DX windows come back black (known limitation) |
| Default WebP quality | `60` — the lowest quality at which text stays readable |
| Layer-buffer TTL | Auto-cleared after 90 s |
| focus_window filter | Skips helper windows with width < 50 or height < 50 |
| focus_window / Chrome tabs | Chrome/Edge uses one HWND per browser window; only the active tab title is visible to the OS. `WindowNotFound` on a tab title → use `browser_connect` to list tabs and switch via CDP instead |
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
