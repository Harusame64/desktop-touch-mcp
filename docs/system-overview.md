# desktop-touch-mcp — System Overview

MCP (Model Context Protocol) server that lets Claude CLI drive any Windows desktop application.

---

## Architecture

```
Claude CLI
    │  stdio (MCP protocol)
    ▼
desktop-touch-mcp (Node.js / TypeScript)
    ├── Layer 1: Engine
    │   ├── nutjs.js        — mouse / keyboard / screen capture (nut-js)
    │   ├── win32.ts        — Win32 API via koffi: window enum, DPI, PrintWindow, SetWindowPos
    │   ├── uia-bridge.ts   — Windows UI Automation (PowerShell): element tree, click, set-value,
    │   │                     GetFocusedElement, ElementFromPoint
    │   ├── uia-diff.ts     — UIA snapshot diff (appeared / disappeared / valueDeltas)
    │   ├── image.ts        — image encode (sharp): PNG / WebP 1:1 / crop
    │   ├── layer-buffer.ts — per-window layer buffer: frame-diff detection (MPEG P-frame style)
    │   ├── cdp-bridge.ts   — Chrome DevTools Protocol: WebSocket sessions + DOM→screen coords
    │   ├── window-cache.ts — window-position cache used by the homing-correction path (dx,dy)
    │   └── poll.ts         — shared pollUntil utility
    └── Layer 2: 46 MCP tools
        screenshot(4) + window(3) + mouse(5) + keyboard(2) + ui_elements(4) +
        browser_cdp(11) + workspace(2) + pin(2) + dock(1) + macro(1) +
        scroll_capture(1) + context(3) + terminal(2) + events(4) + wait_until(1)
```

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

#### `get_screen_info`
Monitor list: resolution, position, DPI, cursor position.

---

### 🖥️ Window management

#### `get_windows`
All windows in Z-order.
```json
{ "zOrder": 0, "title": "Notepad", "region": {"x":78,"y":78,"w":976,"h":618},
  "isActive": true, "isMinimized": false, "isOnCurrentDesktop": true }
```

#### `get_active_window`
Information about the currently-focused window.

#### `focus_window`
Bring a window to the foreground by partial title match.
```
focus_window(title="Notepad")
```

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
Click (`left` / `right` / `middle`). `doubleClick=true` for a double click.

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
The raw UIA tree. Use this when you need an `automationId`.

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

#### `browser_get_dom`
`outerHTML` of an element (or `document.body`), truncated to `maxLength`. Missing-element errors come back as a structured `{"__cdpError":"…"}` so the caller can distinguish "no match" from "empty HTML".

#### `browser_get_interactive`
Enumerates interactive elements with `clickAt` coords — the browser analogue of `screenshot(detail="text")`.
Also **ARIA-aware**: surfaces `role=switch` / `checkbox` / `radio` / `tab` / `menuitem` / `option` custom controls with a `state` block carrying `checked` / `pressed` / `selected` / `expanded` derived from the matching `aria-*` attributes. Use this when a page (Radix / shadcn / MUI / Headless UI / GitHub) renders toggles as ARIA buttons instead of native `<input>`.

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
Scrolls a window top-to-bottom and stitches a full-height screenshot — useful for long pages / documents.

Output is size-guarded to fit the MCP 1 MB envelope: PNG is tried first; if the raw bytes exceed 700 KB, the image falls back to WebP (q70 → q55 → q40) and then iterative ×0.75 downscaling. When compression is applied, the `summary` object includes a `sizeReduced` field (e.g. `"webp_q55"`) and a `tip` suggesting `maxScrolls` reduction or `grayscale=true`.

---

## Param coercion for LLM-friendly spellings

Boolean / object parameters accept the string spellings some MCP clients emit by accident:

- **boolean**: `"true"` / `"false"` (case-insensitive, whitespace trimmed) or `0` / `1` → real boolean
- **object**: a JSON-stringified object (`"{}"` or `'{"windowTitle":"x"}'`) is parsed before validation

Ambiguous input (`"yes"`, arbitrary strings) is still rejected so a typo cannot silently flip a flag. Numbers are **not** coerced here — use `z.coerce.number()` at the call site when you explicitly want it.

Touch points: `browser_navigate.waitForLoad` / `browser_search.visibleOnly|inViewportOnly|caseSensitive` / `events.drain` / `keyboard_*.forceFocus|trackFocus` / `wait_until.target` (and its nested `target.regex`).

---

## Layer buffer — MPEG P-frame strategy

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
| UIA timeout | 2 s inside `workspace_snapshot`, 8 s elsewhere |
| PrintWindow flag | `0` — GPU / DX windows come back black (known limitation) |
| Default WebP quality | `60` — the lowest quality at which text stays readable |
| Layer-buffer TTL | Auto-cleared after 90 s |
| focus_window filter | Skips helper windows with width < 50 or height < 50 |
| UIA element search | Recursive `FindAll(Children)` — `FindAll(Descendants)` misses items on some WinUI3 apps |
| CDP command timeout | 15 s (`CMD_TIMEOUT_MS`); WebSocket connect timeout 5 s (`CONNECT_TIMEOUT_MS`) |
| CDP fetch timeout | `AbortSignal.timeout(5s)` — handles a hung `/json` endpoint |
| window-cache TTL | 60 s — prevents stale-HWND mis-correction after reuse |
| Homing Tier 3 gate | Fires only when `delta > 200px` or `sizeChanged=true` |
| `post.focusedElement` timeout | 800 ms — cap for apps that don't answer UIA queries |
| UIA diff caps | 5 for `appeared` / `disappeared`, 3 for `valueDeltas` — overflow count lives in `truncated` |
| `narrate:"rich"` settle | 120 ms wait between the action and the after-snapshot |
| tab-context cache (browser tools) | 500 ms keyed by `(port, tabId)` — chained calls share one `getTabContext` round-trip |
| `--disable-extensions` exclusion | Chrome 147+ with this flag fails to bind the CDP port; removed from the E2E launcher |

---

## Install / registration

Registered as `desktop-touch` under `mcpServers` in `~/.claude.json` (stdio). Auto-starts / stops with the Claude CLI.

Build: `cd D:\git\desktop-touch-mcp && npm install` (the `prepare` hook runs `tsc` automatically).
