# desktop-touch-mcp

[![desktop-touch-mcp MCP server](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp/badges/card.svg)](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp)

[日本語](README.ja.md)

> **Stop pasting screenshots. Let Claude see and control your desktop directly.**

> **Project site:** [harusame64.github.io/desktop-touch-mcp](https://harusame64.github.io/desktop-touch-mcp/)  
> Start here for the public explainer, client setup guides, and the Reactive Perception Graph overview.

An MCP server that gives Claude eyes and hands on Windows — 28 public tools (26 stub catalog + 2 dynamic v2 World-Graph: `desktop_discover` / `desktop_act`) covering screenshots, mouse, keyboard, Windows UI Automation, Chrome DevTools Protocol, clipboard, desktop notifications, SmartScroll, and a Reactive Perception Graph for safe multi-step automation, designed from the ground up for LLM efficiency.

> *v0.15: **82× average speedup** via Rust native engine — UIA focus queries in 2 ms, SSE2-accelerated image diffing at 13–15× native speed. Zero-config: the engine auto-loads when present, with transparent PowerShell fallback.*
> *v0.15.5: **Pinned release verification** — the npm launcher now fetches only the matching GitHub Release tag and verifies the Windows runtime zip before extraction.*

---

## Features

- **⚡ High-performance Rust Native Core** — The UIA bridge and image-diff engine are written in Rust (`napi-rs` + `windows-rs`) and loaded as a native `.node` addon. Direct COM calls from a dedicated MTA thread eliminate PowerShell process spawning — `getFocusedElement` completes in **2 ms** (160× faster), and `getUiElements` returns full trees in **~100 ms** with a batch BFS algorithm that minimizes cross-process RPC. Image-diff operations use **SSE2 SIMD** for 13–15× throughput. When the native engine is unavailable, every function transparently falls back to PowerShell — zero config required.
- **🎯 Set-of-Marks (SoM) visual fallback** — Games, RDP sessions, and non-accessible Electron apps return clickable elements even when UIA is completely blind. `screenshot(detail="text")` automatically detects UIA sparsity and activates a Hybrid Non-CDP pipeline: Rust-powered grayscale + bilinear upscale → Windows OCR → clustering → red bounding-box annotation with numbered badges (`[1]`, `[2]`…). Two parallel representations returned: a visual PNG for spatial orientation and a semantic `elements[]` list with `clickAt` coords — no CDP required.
- **LLM-native design** — Built around how LLMs think, not how humans click. `run_macro` batches multiple operations into a single API call; `diffMode` sends only the windows that changed since the last frame. Minimal tokens, minimal round-trips.
- **Reactive Perception Graph** — Register a `lensId` for a window or browser tab, pass it to action tools, and get guard-checked `post.perception` feedback after each action. It reduces repeated `screenshot` / `desktop_state` calls and prevents wrong-window typing or stale-coordinate clicks.
- **Full CJK support** — Uses Win32 `GetWindowTextW` for window titles, avoiding nut-js garbling. IME bypass input supported for Japanese/Chinese/Korean environments.
- **3-tier token reduction** — `detail="image"` (~443 tok) / `detail="text"` (~100–300 tok) / `diffMode=true` (~160 tok). Send pixels only when you actually need to see them.
- **1:1 coordinate mode** — `dotByDot=true` captures at native resolution (WebP). Image pixel = screen coordinate — no scale math needed. With `origin`+`scale` passed to `mouse_click`, the server converts coords for you — eliminating off-by-one / scale bugs.
- **Browser capture data reduction** — `grayscale=true` (~50% size), `dotByDotMaxDimension=1280` (auto-scaled with coord preservation), and `windowTitle + region` sub-crops help exclude browser chrome and other irrelevant pixels. Typical reduction for heavy captures: 50–70%.
- **Chromium smart fallback** — `detail="text"` on Chrome/Edge/Brave auto-skips UIA (prohibitively slow there) and runs Windows OCR. `hints.chromiumGuard` + `hints.ocrFallbackFired` flag the path taken.
- **UIA element extraction** — `detail="text"` returns button names and `clickAt` coords as JSON. Claude can click the right element without ever looking at a screenshot.
- **Auto-dock CLI** — `window_dock(action='dock')` snaps any window to a screen corner with always-on-top. Set `DESKTOP_TOUCH_DOCK_TITLE='@parent'` to auto-dock the terminal hosting Claude on MCP startup — the process-tree walker finds the right window regardless of title.
- **Emergency stop (Failsafe)** — Move the mouse to the **top-left corner (within 10px of 0,0)** to immediately terminate the MCP server.

---

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| Node.js | v20+ recommended (tested on v22+) |
| PowerShell | 5.1+ (bundled with Windows) — used only as fallback when the Rust native engine is unavailable |
| Claude CLI | `claude` command must be available |

> **Note:** nut-js native bindings require the Visual C++ Redistributable.
> Download from [Microsoft](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) if not already installed.

---

## Installation

```bash
npx -y @harusame64/desktop-touch-mcp
```

The npm launcher resolves runtime strictly by npm package version. For package `X.Y.Z`, it fetches only GitHub Release tag `vX.Y.Z`, downloads `desktop-touch-mcp-windows.zip`, verifies its SHA256 digest, and only then expands it under `%USERPROFILE%\.desktop-touch-mcp`. Verified cached releases are reused on later runs.

Set `DESKTOP_TOUCH_MCP_HOME` to override the cache root directory.

### Register with Claude CLI

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"]
    }
  }
}
```

**No system prompt needed.** The command reference is automatically injected into Claude via the MCP `initialize` response's `instructions` field.

### Register with other clients (HTTP mode)

Clients that require an HTTP endpoint (GPT Desktop, VS Code Copilot, Cursor, etc.) can use the built-in Streamable HTTP transport:

```bash
npx -y @harusame64/desktop-touch-mcp --http
# or with a custom port:
npx -y @harusame64/desktop-touch-mcp --http --port 8080
```

The server starts at `http://127.0.0.1:23847/mcp` (localhost only). Register the URL in your MCP client settings. A health check is available at `http://127.0.0.1:<port>/health`.

In HTTP mode the system tray icon shows the active URL and provides quick-copy and open-in-browser shortcuts.

### Development install

```bash
git clone https://github.com/Harusame64/desktop-touch-mcp.git
cd desktop-touch-mcp
npm install
```

Build after install:

```bash
npm run build
```

For a local checkout, register the built server directly:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/desktop-touch-mcp/dist/index.js"]
    }
  }
}
```

> **Note:** Replace `D:/path/to/desktop-touch-mcp` with the actual path where you cloned this repository.

---

## Tools (28 total — 26 stub catalog + 2 dynamic v2)

> 📖 **Full command reference**: [`docs/system-overview.md`](docs/system-overview.md) — every tool's parameters, response shape, coordinate math, layer-buffer strategy, and engineering notes in one place.


### Screenshot (1)
| Tool | Description |
|---|---|
| `screenshot` | Main capture. Supports `detail` (`meta`/`text`/`image`/`som`/`ocr`), `mode` (`normal`/`background` — Phase 4 absorbs former screenshot_background), `region` sub-crop (Phase 4 absorbs former scope_element after `desktop_discover` gives you element bounds), `dotByDot`, `dotByDotMaxDimension`, `grayscale`, `diffMode`. `detail='text'` auto-activates the SoM pipeline when UIA is blind. `detail='ocr'` (Phase 4 absorbs former screenshot_ocr) returns Windows OCR words with screen-pixel clickAt coords. `scroll(action='capture')` provides full-page stitched capture. |

### Observation (1) — World-Graph core
| Tool | Description |
|---|---|
| `desktop_state` | Cheapest read-only observation. Always returns focused window, focused element, modal flag, attention signal. Phase 4: `includeCursor:true` adds `cursor.{x,y,monitorId}` (former get_cursor_position); `includeScreen:true` adds `screen.{displays[],...}` (former get_screen_info); `includeDocument:true` adds `document.{url,title,readyState,scroll,...}` via CDP (former get_document_state). focusedWindow always covers the former get_active_window response. |

### Discovery + Action — World-Graph dispatchers (2 dynamic)
| Tool | Description |
|---|---|
| `desktop_discover` | Find actionable entities and emit leases. Returns `entities[]` (former `get_ui_elements` equivalent — `entityId`/`label`/`role`/`confidence`/`sources`/`primaryAction`/`lease`, plus `rect` when `debug:true`) + `windows[]` (former `get_windows` equivalent — `zOrder`/`title`/`hwnd`/`region`/`isActive`/`isMinimized`/`isMaximized`/`processName`). Pre-Phase-1 `desktop_see`. |
| `desktop_act` | Lease-consuming action (`click` / `type` / `setValue` / `scroll` / `select`). Phase 4: `action='setValue'` absorbs former set_element_value via UIA ValuePattern (UIA entities) or CDP fill (browser entities). Pre-Phase-1 `desktop_touch`. |

### Window management (1)
| Tool | Description |
|---|---|
| `focus_window` | Bring a window to foreground by partial title match. Use `desktop_discover` to list available titles. |
| `window_dock(action='dock')` | Snap a window to a screen corner at a small size + always-on-top (for keeping CLI visible) |

### Mouse (2)
| Tool | Description |
|---|---|
| `mouse_click` / `mouse_drag` | Click, drag. `doubleClick` / `tripleClick` (line-select). Accept `speed` and `homing` parameters. (`mouse_move` privatized in Phase 4.) |
| `scroll` | Scroll in any direction (`action='raw'` / `'to_element'` / `'smart'` / `'capture'`). Accepts `speed` and `homing` parameters. |

### Keyboard (1)
| Tool | Description |
|---|---|
| `keyboard` | Send keyboard input. `action='type'` for text (`use_clipboard=true` bypasses IME / required for em-dash / smart quotes; `replaceAll=true` sends Ctrl+A before typing). `action='press'` for key combos (`ctrl+c`, `alt+f4`, etc.). |

### UI Automation (1)
| Tool | Description |
|---|---|
| `click_element` | Click a button by name or automationId — no coordinates needed. Use `desktop_discover` to find target entities. (`get_ui_elements` / `set_element_value` / `scope_element` privatized in Phase 4 — see desktop_discover / desktop_act / screenshot.region.) |

### Browser CDP (9)
| Tool | Description |
|---|---|
| `browser_open` | Connect to Chrome/Edge via CDP; lists open tabs with `active:true/false`. Pass `launch:{}` (or with overrides) to auto-spawn a debug-mode browser when no CDP endpoint is live (idempotent) |
| `browser_locate` | CSS selector → exact physical screen coords |
| `browser_click` | Find DOM element + click in one step |
| `browser_eval` | Inspect or operate on a tab via 3 actions: `js` (evaluate JS), `dom` (get HTML), `appState` (extract SSR-injected SPA state — `__NEXT_DATA__`, `__NUXT_DATA__`, `__REMIX_CONTEXT__`, `__APOLLO_STATE__`, GitHub `react-app`, JSON-LD, Redux SSR) |
| `browser_fill` | Fill React/Vue/Svelte controlled inputs via CDP — works where `browser_eval(action='js')` value assignment doesn't update framework state |
| `browser_form` | Inspect form fields (input/select/textarea/button) with name, type, value, label resolved via for/aria/ancestor LABEL |
| `browser_overview` | Enumerate links / buttons / inputs + **ARIA toggles** with `state.{checked,pressed,selected,expanded}`; each element includes `viewportPosition` |
| `browser_search` | Grep DOM by text / regex / role / ariaLabel / selector with confidence ranking |
| `browser_navigate` | Navigate via CDP `Page.navigate`; `waitForLoad:true` (default) returns once `readyState==='complete'` |

All `browser_*` tools that touch the DOM accept `includeContext:false` to omit the trailing `activeTab:` / `readyState:` lines (saves ~150 tok/call on chained invocations). Within a 500 ms window, consecutive calls reuse one tab-context fetch automatically.

### Workspace (2)
| Tool | Description |
|---|---|
| `workspace_snapshot` | All windows: thumbnails + UI summaries in one call |
| `workspace_launch` | Launch an app and auto-detect the new window |

### Wait / Status (2)
| Tool | Description |
|---|---|
| `wait_until` | Server-side wait for window/focus/terminal/browser DOM state changes. Replaces the former events_* polling family — use `condition='window_appears'` / `'terminal_output_contains'` / `'element_matches'` / `'focus_changes'` for one-shot waits. |
| `server_status` | Returns which backend is active: `uia` (native Rust or powershell) and `imageDiff` (native Rust SSE2 or typescript). Diagnostic — call once per session when troubleshooting performance. |

### Terminal (2)
| Tool | Description |
|---|---|
| `terminal(action='read')` | Read text from Windows Terminal / PowerShell / cmd / WSL via UIA/OCR. Supports `sinceMarker` for diff reads |
| `terminal(action='send')` | Send commands to a terminal. Uses clipboard paste by default for IME safety |

### Pin / Macro (2)
| Tool | Description |
|---|---|
| `window_dock(action='pin'\|'unpin'\|'dock')` | Always-on-top toggle / docking |
| `run_macro` | Execute up to 50 steps sequentially in one MCP call. Phase 4: DSL accepts the v1.0.0 dispatcher names (`keyboard({action:'type'})` etc.) only. |

### Clipboard (2)
| Tool | Description |
|---|---|
| `clipboard(action='read')` | Read the current Windows clipboard text (non-text payloads return empty string) |
| `clipboard(action='write')` | Write text to the Windows clipboard; full Unicode / emoji / CJK support |

### Notification (1)
| Tool | Description |
|---|---|
| `notification_show` | Show a Windows system tray balloon notification — useful to alert the user when a long-running task finishes |

### Scroll (2)
| Tool | Description |
|---|---|
| `scroll(action='to_element')` | Scroll a named element into the viewport without computing scroll amounts. Chrome path: `selector` + `block` alignment. Native path: `name` + `windowTitle` via UIA ScrollItemPattern |
| `scroll(action='smart')` | **SmartScroll** — unified scroll dispatcher: CDP → UIA → image binary-search fallback. Handles nested containers, virtualised lists (TanStack/React Virtualized), sticky-header occlusion, and image-only environments. Returns `pageRatio`, `ancestors[]`, and hash-verified `scrolled` |

---

## Browser CDP automation

For web automation, connect Chrome or Edge with the remote debugging port enabled — no Selenium or Playwright needed.

```bash
# Launch Chrome in CDP mode
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

```
browser_open({launch:{}})                          → spawn-if-needed Chrome in debug mode + list tabs (idempotent)
browser_open()                                     → connect-only (fail if no CDP endpoint live)
browser_locate({selector:"#submit"})               → CSS selector → physical screen coords
browser_click({selector:"#submit"})                → find + click in one step (auto-focuses browser)
browser_eval({action:"js", expression:"document.title"})  → evaluate JS, returns result
browser_eval({action:"dom", selector:"#main", maxLength:5000})  → outerHTML, truncated to maxLength chars
browser_eval({action:"appState"})                  → one-shot SPA state (Next/Nuxt/Remix/Apollo/GitHub react-app/Redux SSR)
browser_fill({selector:"#email", value:"user@example.com"})  → fill React/Vue/Svelte controlled input (state-safe)
browser_overview()                                 → links/buttons/inputs + ARIA toggles + viewportPosition per element
browser_search({by:"text", pattern:"..."})         → grep DOM with confidence ranking
browser_navigate({url:"https://example.com"})      → navigate via CDP (no address bar interaction)
```

For chained calls in the same tab, pass `includeContext:false` to omit the activeTab/readyState annotation (~150 tok/call saved). Boolean / object params accept the LLM-friendly string spellings (`"true"`, `"{}"`).

Coordinates returned by `browser_locate` account for the browser chrome (tab strip + address bar height) and `devicePixelRatio`, so they can be passed directly to `mouse_click` without any scaling.

**Recommended web workflow:**
```
browser_open({launch:{}}) → browser_eval({action:"dom"}) → browser_locate(selector) → browser_click(selector)
```

---

## Auto-dock CLI on startup

Keep Claude CLI visible while operating other apps full-screen. Set env vars in your MCP config and the docked window auto-snaps into place every MCP startup.

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {
        "DESKTOP_TOUCH_DOCK_TITLE": "@parent",
        "DESKTOP_TOUCH_DOCK_CORNER": "bottom-right",
        "DESKTOP_TOUCH_DOCK_WIDTH": "480",
        "DESKTOP_TOUCH_DOCK_HEIGHT": "360",
        "DESKTOP_TOUCH_DOCK_PIN": "true"
      }
    }
  }
}
```

| Env var | Default | Notes |
|---|---|---|
| `DESKTOP_TOUCH_DOCK_TITLE` | *(unset = off)* | `@parent` walks the MCP process tree to find the hosting terminal — immune to title / branch / project changes. Or use a literal substring. |
| `DESKTOP_TOUCH_DOCK_CORNER` | `bottom-right` | `top-left` / `top-right` / `bottom-left` / `bottom-right` |
| `DESKTOP_TOUCH_DOCK_WIDTH` / `HEIGHT` | `480` / `360` | px (`"480"`) or ratio of work area (`"25%"`) — 4K/8K auto-adapts |
| `DESKTOP_TOUCH_DOCK_PIN` | `true` | Always-on-top toggle |
| `DESKTOP_TOUCH_DOCK_MONITOR` | primary | Monitor id from `desktop_state({includeScreen:true})` |
| `DESKTOP_TOUCH_DOCK_SCALE_DPI` | `false` | If true, multiply px values by `dpi / 96` (opt-in per-monitor scaling) |
| `DESKTOP_TOUCH_DOCK_MARGIN` | `8` | Screen-edge padding (px) |
| `DESKTOP_TOUCH_DOCK_TIMEOUT_MS` | `5000` | Max wait for the target window to appear |

> **Input routing gotcha:** when a pinned window is active (e.g. Claude CLI), `keyboard(action='type')` / `keyboard(action='press')` send keys to it, **not** the app you wanted to type into. Always call `focus_window(title=...)` before keyboard operations, then verify `isActive=true` via `screenshot(detail='meta')`.

### Auto Perception (always-on)

Phase 4 privatizes the explicit `perception_*` tool family — the v0.12 Auto
Perception layer attaches an `attention` signal to every `desktop_state` and
`desktop_act` response automatically. Action tools also auto-guard when given
a `windowTitle`. There is no longer a need to register / read / forget lenses
manually.

```
# desktop_state always returns the attention signal
desktop_state() → {focusedWindow, focusedElement, modal, attention:"ok", ...}

# Action tools auto-guard when windowTitle is given:
keyboard({action:"type", text:"hello", windowTitle:"Notepad"})
→ post.perception:{status:"ok"}  // unsafe input blocked if guards fail

# When attention is dirty / stale / settling, refresh with desktop_state:
desktop_state()  // re-evaluates attention via Auto Perception
```

For advanced pinned-target workflows, the `lensId` parameter remains on action
tools (`keyboard`, `mouse_click`, `mouse_drag`, `click_element`,
`browser_click`, `browser_navigate`, `browser_eval`, `desktop_act`). Omit
`lensId` for the normal Auto Perception path. The underlying registry, hot
target cache, and sensor loop are unchanged; only the explicit
`perception_register / perception_read / perception_forget / perception_list`
tools were retired.

---

## Mouse homing correction

When Claude calls `screenshot(detail='text')` to read coordinates and then `mouse_click` seconds later, the target window may have moved. The homing system corrects this automatically.

| Tier | How to enable | Latency | What it does |
|------|--------------|---------|--------------|
| 1 | Always-on (if cache exists) | <1ms | Applies (dx, dy) offset when window moved |
| 2 | Pass `windowTitle` hint | ~100ms | Auto-focuses window if it went behind another |
| 3 | Pass `elementName`/`elementId` + `windowTitle` | 1–3s | UIA re-query for fresh coords on resize |

```
# Tier 1 only (automatic)
mouse_click(x=500, y=300)

# Tier 1 + 2: also bring window to front if hidden
mouse_click(x=500, y=300, windowTitle="Notepad")

# Tier 1 + 2 + 3: also re-query UIA if window resized
mouse_click(x=500, y=300, windowTitle="Notepad", elementName="Save")

# Traction control OFF — no correction
mouse_click(x=500, y=300, homing=false)
```

The `homing` parameter is available on `mouse_click`, `mouse_drag`, and `scroll`. The cache is updated automatically on every `screenshot()`, `desktop_discover()`, `focus_window()`, and `workspace_snapshot()` call.

### `mouse_click` image-local coords (origin + scale)

When you take a `dotByDot` screenshot with `dotByDotMaxDimension`, the response prints the `origin` and `scale` values. Instead of computing screen coords manually, copy them into `mouse_click`:

```
# Screenshot response:
#   origin: (0, 120) | scale: 0.6667
#   To click image pixel (ix, iy): mouse_click(x=ix, y=iy, origin={x:0, y:120}, scale=0.6667)

mouse_click(x=640, y=300, origin={x:0, y:120}, scale=0.6667, windowTitle="Chrome")
# Server converts: screen = (0 + 640/0.6667, 120 + 300/0.6667) = (960, 570)
```

This eliminates a whole class of off-by-one and scale bugs. Without origin/scale, `x`/`y` remain absolute screen pixels (unchanged behavior).

---

## `screenshot` key parameters

```
detail="image"          — PNG/WebP pixels (default)
detail="text"           — UIA element JSON + clickAt coords (no image, ~100–300 tok)
detail="meta"           — Title + region only (cheapest, ~20 tok/window)
dotByDot=true           — 1:1 WebP; image_px + origin = screen_px
dotByDotMaxDimension=N  — cap longest edge (response includes scale for coord math)
grayscale=true          — ~50% smaller for text-heavy captures (code/AWS console)
region={x,y,w,h}        — with windowTitle: window-local coords (exclude browser chrome)
                          without: virtual screen coords
diffMode=true           — I-frame first call, P-frame (changed windows only) after (~160 tok)
ocrFallback="auto"      — detail='text' auto-fires Windows OCR on uiaSparse or empty
```

**Recommended Chrome combo** (50–70% data reduction):
```
screenshot(windowTitle="Chrome",
           dotByDot=true, dotByDotMaxDimension=1280, grayscale=true,
           region={x:0, y:120, width:1920, height:900})  # skip browser chrome
```

**Recommended workflow:**
```
workspace_snapshot()                     → full orientation (resets diff buffer)
screenshot(detail="text", windowTitle=X) → get actionable[].clickAt coords
mouse_click(x, y)                        → click directly, no math needed
screenshot(diffMode=true)                → check only what changed (~160 tok)
```

---

## Security

### Emergency stop (Failsafe)

**Move the mouse to the top-left corner of the screen (within 10px of 0,0) to immediately terminate the MCP server.**

- **Per-tool check**: `checkFailsafe()` runs before every tool handler
- **Background monitor**: 500ms polling as a backup for long-running operations
- Trigger radius: 10px

### Blocked operations

**`workspace_launch` blocklist:**
`cmd.exe`, `powershell.exe`, `pwsh.exe`, `wscript.exe`, `cscript.exe`, `mshta.exe`, `regsvr32.exe`, `rundll32.exe`, `msiexec.exe`, `bash.exe`, `wsl.exe` are blocked.
Script extensions (`.bat`, `.ps1`, `.vbs`, etc.) are rejected. Arguments containing `;`, `&`, `|`, `` ` ``, `$(`, `${` are also rejected.

**`keyboard(action='press')` blocklist:**
`Win+R` (Run dialog), `Win+X` (admin menu), `Win+S` (search), `Win+L` (lock screen) are blocked.

### PowerShell injection protection

All `-like` patterns in the UIA bridge PowerShell fallback path are sanitized with `escapeLike()`, which escapes wildcard characters (`*`, `?`, `[`, `]`) before they reach PowerShell. When the Rust native engine is active, PowerShell is not invoked for UIA operations.

### Allowlist for `workspace_launch`

Shell interpreters are blocked by default. To allow specific executables, create an allowlist file:

**File locations (searched in order):**
1. Path in `DESKTOP_TOUCH_ALLOWLIST` environment variable
2. `~/.claude/desktop-touch-allowlist.json`
3. `desktop-touch-allowlist.json` in the server's working directory

**Format:**
```json
{
  "allowedExecutables": [
    "pwsh.exe",
    "C:\\Tools\\myapp.exe"
  ]
}
```

Changes take effect immediately — no restart needed.

---

## Mouse movement speed

All mouse tools (`mouse_click`, `mouse_drag`, `scroll`) accept an optional `speed` parameter:

| Value | Behavior |
|---|---|
| Omitted | Uses the configured default (see below) |
| `0` | Instant teleport — `setPosition()`, no animation |
| `1–N` | Animated movement at N px/sec |

**Default speed** is 1500 px/sec. Change it permanently via the `DESKTOP_TOUCH_MOUSE_SPEED` environment variable:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {
        "DESKTOP_TOUCH_MOUSE_SPEED": "3000"
      }
    }
  }
}
```

Common values: `0` = teleport, `1500` = default gentle, `3000` = fast, `5000` = very fast.

---

## Force-Focus (AttachThreadInput)

Windows foreground-stealing protection can prevent `SetForegroundWindow` from succeeding when another window (such as a pinned Claude CLI) is in the foreground. This causes subsequent keystrokes or clicks to land in the wrong window — a silent failure.

`mouse_click`, `keyboard(action='type')`, `keyboard(action='press')`, and `terminal(action='send')` all accept a `forceFocus` parameter that bypasses this protection using `AttachThreadInput`:

```json
{
  "name": "mouse_click",
  "arguments": {
    "x": 500,
    "y": 300,
    "windowTitle": "Google Chrome",
    "forceFocus": true
  }
}
```

If the force attempt is refused despite `AttachThreadInput`, the response includes `hints.warnings: ["ForceFocusRefused"]`.

**Global default via environment variable:**

```json
{
  "mcpServers": {
    "desktop-touch": {
      "env": {
        "DESKTOP_TOUCH_FORCE_FOCUS": "1"
      }
    }
  }
}
```

Setting `DESKTOP_TOUCH_FORCE_FOCUS=1` makes `forceFocus: true` the default for all four tools without changing each call.

**Known tradeoffs:**

- During the ~10ms `AttachThreadInput` window, key state and mouse capture are shared between the two threads. In rapid macro sequences this can cause a race condition (rare in practice).
- Disable `forceFocus` (or unset the env var) when the user is manually operating another app to avoid unexpected focus shifts.

---

## Auto Guard (v0.12+)

Action tools (`mouse_click`, `mouse_drag`, `keyboard(action='type'/'press')`, `click_element`, `desktop_act`, `browser_click`, `browser_navigate`) automatically guard each action when you pass `windowTitle` / `tabId`:

- Verifies target window identity (process restart / HWND replacement detected)
- Confirms click coordinates are inside the target window rect
- Returns `post.perception.status` on every response — including failures — so the LLM can recover without a screenshot

**Disabling auto guard** — set `DESKTOP_TOUCH_AUTO_GUARD=0` to restore v0.11.12 behavior (no auto guard):

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {
        "DESKTOP_TOUCH_AUTO_GUARD": "0"
      }
    }
  }
}
```

When auto guard is enabled (default), `post.perception.status` will be one of:

| Status | Meaning |
|---|---|
| `ok` | Guard passed — target verified |
| `unguarded` | `windowTitle` not provided; action ran without guard |
| `target_not_found` | No window matched the given title |
| `ambiguous_target` | Multiple windows matched; use a more specific title |
| `identity_changed` | Window was replaced (process restart / HWND change) |
| `unsafe_coordinates` | Click coordinates are outside the target window rect |
| `needs_escalation` | Use `browser_click` or specify `windowTitle` |

When `unsafe_coordinates` or `identity_changed` is returned, the response may include a `suggestedFix.fixId`. Pass that `fixId` to the relevant tool call to approve the recovery:

```json
{ "name": "mouse_click",           "arguments": { "fixId": "fix-..." } }
{ "name": "keyboard(action='type')",         "arguments": { "fixId": "fix-...", "text": "hello" } }
{ "name": "click_element",         "arguments": { "fixId": "fix-..." } }
{ "name": "browser_click", "arguments": { "fixId": "fix-..." } }
```

The fix is one-shot and expires in 15 seconds. The server revalidates the target process identity before executing.

---

## v0.13 Additions

### Target-Identity Timeline

The server tracks a semantic timeline of what happened to each target window/tab. Recent events are included in:

- `get_history` → `recentTargetKeys`: array of 3 most recently active target keys (compact, no event bodies)
- `perception_read(lensId)` → `recentEvents`: up to 10 events for that lens's target, each with `tsMs`, `semantic`, `summary`

Enable the MCP resources below to browse timelines:

```json
{ "env": { "DESKTOP_TOUCH_PERCEPTION_RESOURCES": "1" } }
```

MCP resources available when enabled:

| URI | Content |
|---|---|
| `perception://target/{targetKey}/timeline` | Semantic event timeline for a target |
| `perception://targets/recent` | Most recently active target keys |
| `perception://lens/{lensId}/summary` | Lens attention/guard state |

### Manual Lens Eviction: FIFO → LRU

Manual lenses (created via `perception_register`) are now evicted by **least-recently-used** instead of insertion order. Using `perception_read`, `evaluatePreToolGuards`, or `buildEnvelopeFor` on a lens promotes it. The hard limit of 16 active lenses is unchanged.

### browser_eval Structured Mode

Pass `withPerception: true` to receive a structured JSON response with `post.perception` instead of raw text:

```json
{ "name": "browser_eval", "arguments": { "expression": "document.title", "withPerception": true } }
```

Returns `{ ok: true, result: "...", post: { perception: { status: "ok", ... } } }`.

### mouse_drag Cross-Window Guard

`mouse_drag` now guards both start and end coordinates. Drags that cross window boundaries (or reach the desktop wallpaper) are blocked by default. To allow intentional cross-window or range-selection drags:

```json
{ "name": "mouse_drag", "arguments": { "startX": 100, "startY": 100, "endX": 900, "endY": 900, "allowCrossWindowDrag": true } }
```

---

## Performance (v0.15 — Rust Native Engine)

The Rust native engine (`@harusame64/desktop-touch-engine`) replaces PowerShell process spawning with direct COM calls over a persistent MTA thread. It loads automatically as a `.node` addon — no configuration needed.

### UIA Benchmark (vs PowerShell baseline)

| Function | Rust Native | PowerShell | Speedup |
|---|---|---|---|
| `getFocusedElement` | **2.2 ms** | 366 ms | **163.9×** |
| `getUiElements` (Explorer, ~60 elements) | **106.5 ms** | 346 ms | **3.3×** |
| **Weighted average** | | | **~82×** |

### Image Diff Benchmark (SSE2 SIMD)

| Function | Rust (SSE2) | TypeScript | Speedup |
|---|---|---|---|
| `computeChangeFraction` (1920×1080) | **0.26 ms** | 3.8 ms | **~15×** |
| `dHash` (perceptual hash) | **0.09 ms** | 1.2 ms | **~13×** |

### Architecture

```
Claude CLI / MCP Client
    │  stdio or HTTP (MCP protocol)
    ▼
desktop-touch-mcp (TypeScript)
    │
    ├── Rust Native Engine (.node addon)          ← NEW in v0.15
    │   ├── UIA: 13 functions via napi-rs + windows-rs 0.62
    │   │   └── Dedicated COM thread (MTA) + batch BFS algorithm
    │   └── Image: SSE2 SIMD pixel diff + perceptual hashing
    │
    └── PowerShell Fallback (automatic)
        └── Activates transparently if .node is unavailable
```

### Why `getUiElements` is 3.3× (not 160×)

The 160× speedup on `getFocusedElement` comes from eliminating PowerShell process startup (~200 ms) and .NET assembly loading. For `getUiElements`, the bottleneck shifts to the **UIA provider** inside the target application (e.g., Explorer) — it must enumerate its UI tree regardless of who asks. The Rust engine uses a **batch BFS algorithm** (`FindAllBuildCache` + `TreeScope_Children`) that minimizes cross-process RPC calls and supports `maxElements` early exit, making it dramatically faster on large trees (VS Code, browsers with 1000+ elements).

---

## UI Operating Layer (V2)

> **Status: Default ON since v0.17.** `desktop_discover` and `desktop_act` are available out of the box.

V2 introduces two new tools that replace coordinate-based clicking with entity-based interaction:

| Tool | Description |
|---|---|
| `desktop_discover` | Observe a window or browser tab. Returns interactive entities with leases — no raw screen coordinates. Supports UIA (native), CDP (browser), terminal, and visual GPU lanes. |
| `desktop_act` | Interact with an entity returned by `desktop_discover`. Validates the lease before executing. Returns a semantic diff (`entity_disappeared`, `modal_appeared`, `focus_shifted`, …). |

### Clicking — priority order

When multiple tools could perform the same click, prefer them in this order:

1. `browser_click(selector)` — Chrome / Edge over CDP (stable across repaints)
2. `desktop_act(lease)` — native windows, dialogs, visual-only targets (entity-based; use after `desktop_discover`)
3. `click_element(name | automationId)` — native UIA fallback when `desktop_act` returns `ok:false`
4. `mouse_click(x, y)` — pixel-level last resort (`origin` + `scale` from `dotByDot` screenshots only)

### Disabling V2 (kill switch)

To hide `desktop_discover` / `desktop_act` from the tool catalog, add the disable flag and restart:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {
        "DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2": "1"
      }
    }
  }
}
```

All V1 tools continue to work without interruption — no reinstall required. Remove the env entry and restart to re-enable.

Flag semantics (exact-match: only the literal string `"1"` counts):

| `DISABLE_FUKUWARAI_V2` | `ENABLE_FUKUWARAI_V2` | V2 state |
|---|---|---|
| unset / not `"1"` | unset / not `"1"` | **ON** (default) |
| unset / not `"1"` | `"1"` | ON (legacy flag — see below) |
| `"1"` | any | **OFF** — DISABLE wins |

### Deprecated: `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2`

This was the opt-in switch in v0.16.x. From v0.17 it is accepted for compatibility but no longer required — the server prints a deprecation warning on startup when it is set. It will be removed in v0.18. Remove it from your config when you upgrade.

### Recovery when V2 fails

If `desktop_act` returns `ok: false`, read `reason` and follow the built-in recovery hints in the tool description. Common paths:

- `lease_expired` / `*_mismatch` / `entity_not_found` → re-call `desktop_discover`
- `modal_blocking` → dismiss the modal with `click_element`, then retry
- `entity_outside_viewport` → `scroll` / `scroll(action='to_element')`, then re-call `desktop_discover`
- `executor_failed` → fall back to `click_element` / `mouse_click` / `browser_click`

For `desktop_discover` warnings (`visual_provider_unavailable`, `visual_provider_warming`, `cdp_provider_failed`, …), V1 tools (`screenshot`, `click_element`, `get_ui_elements`, `terminal(action='send')`, …) remain available as an escape hatch.

---

## Known limitations

| Limitation | Detail | Workaround |
|---|---|---|
| Games / video players may return black or hang in background capture | DirectX fullscreen apps may not work even with `PW_RENDERFULLCONTENT` | Retry with `screenshot_background(fullContent=false)`; if still black, use foreground `screenshot` |
| UIA call overhead | ~2 ms (focus) / ~100 ms (tree) via Rust native engine; ~300 ms via PowerShell fallback | Rust engine loads automatically; `workspace_snapshot` uses a 2 s timeout internally |
| Chrome / WinUI3 UIA elements are empty | Chromium exposes only limited UIA | `screenshot(detail='text')` auto-detects Chromium and falls back to Windows OCR (`hints.chromiumGuard=true`). For richer DOM access use `browser_open` + `browser_locate` |
| Chromium title-regex misses when sites rewrite `document.title` | Guard relies on the ` - Google Chrome` suffix being present; some sites push it off the end of a long title | Title is treated as plain Chrome (UIA runs). OCR path is still reachable via `ocrFallback='always'` or when UIA returns `<5` elements (`uiaSparse`) |
| `browser_*` CDP tools need Chrome launched with `--remote-debugging-port` | If Chrome is already running on the default profile without the flag, `browser_open` fails. The CDP E2E suite (`tests/e2e/browser-cdp.test.ts`) will also fail in that state | Close Chrome first, then `browser_open({launch:{}})` will relaunch it in debug mode, or start Chrome manually with `--remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp` |
| Layer buffer TTL | Buffer auto-clears after 90s of inactivity → next `diffMode` becomes an I-frame | After long waits, call `workspace_snapshot` to explicitly reset the buffer |
| `keyboard(action='type')` / `keyboard(action='press')` follow focus | When `window_dock(action='dock')(pin=true)` keeps another window on top (e.g. Claude CLI), keystrokes may be absorbed by that window | Call `focus_window(title=...)` first and verify `isActive=true` via `screenshot(detail='meta')` before sending keys |
| `keyboard(action='type')` em-dash / smart quotes in Chrome/Edge | Non-ASCII punctuation (em-dash `—`, en-dash `–`, smart quotes `"" ''`) can be intercepted as keyboard accelerators, shifting focus to the address bar | Always use `use_clipboard=true` when the text contains such characters |
| `browser_eval(action='js')` on React / Vue / Svelte inputs | Setting `element.value = ...` or dispatching synthetic events does not update the framework's internal state | Use `browser_fill(selector, value)` — it uses native prototype setter + InputEvent which does update React/Vue/Svelte state |

---

## Token cost reference

| Mode | Tokens | Use case |
|---|---|---|
| `screenshot` (768px PNG) | ~443 tok | General visual check |
| `screenshot(dotByDot=true)` window | ~800 tok | Precise clicking (no coordinate math) |
| `screenshot(diffMode=true)` | ~160 tok | Post-action diff |
| `screenshot(detail="text")` | ~100–300 tok | UI interaction (no image) |
| `workspace_snapshot` | ~2000 tok | Full session orientation |

---

## License

MIT
