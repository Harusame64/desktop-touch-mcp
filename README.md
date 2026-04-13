# desktop-touch-mcp

[日本語](README.ja.md)

[Glama Link](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp)

> **Stop pasting screenshots. Let Claude see and control your desktop directly.**

An MCP server that gives Claude eyes and hands on Windows — 25 tools covering screenshots, mouse, keyboard, and Windows UI Automation, designed from the ground up for LLM efficiency.

> *Applies MPEG P-frame diffing to window capture: only changed windows are sent after the first frame, cutting token usage by ~60–80% in typical automation loops.*

---

## Features

- **LLM-native design** — Built around how LLMs think, not how humans click. `run_macro` batches multiple operations into a single API call; `diffMode` sends only the windows that changed since the last frame. Minimal tokens, minimal round-trips.
- **Full CJK support** — Uses Win32 `GetWindowTextW` for window titles, avoiding nut-js garbling. IME bypass input supported for Japanese/Chinese/Korean environments.
- **3-tier token reduction** — `detail="image"` (~443 tok) / `detail="text"` (~100–300 tok) / `diffMode=true` (~160 tok). Send pixels only when you actually need to see them.
- **1:1 coordinate mode** — `dotByDot=true` captures at native resolution (WebP). Image pixel = screen coordinate — no scale math needed. With `origin`+`scale` passed to `mouse_click`, the server converts coords for you — eliminating off-by-one / scale bugs.
- **Chrome / AWS data reduction** — `grayscale=true` (~50% size), `dotByDotMaxDimension=1280` (auto-scaled with coord preservation), `windowTitle + region` sub-crop (exclude browser chrome). Targeted at heavy dotByDot captures. Typical token reduction: 50–70%.
- **Chromium smart fallback** — `detail="text"` on Chrome/Edge/Brave auto-skips UIA (prohibitively slow there) and runs Windows OCR. `hints.chromiumGuard` + `hints.ocrFallbackFired` flag the path taken.
- **UIA element extraction** — `detail="text"` returns button names and `clickAt` coords as JSON. Claude can click the right element without ever looking at a screenshot.
- **Auto-dock CLI** — `dock_window` snaps any window to a screen corner with always-on-top. Set `DESKTOP_TOUCH_DOCK_TITLE='@parent'` to auto-dock the terminal hosting Claude on MCP startup — the process-tree walker finds the right window regardless of title.
- **Emergency stop (Failsafe)** — Move the mouse to the **top-left corner (within 10px of 0,0)** to immediately terminate the MCP server.

---

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| Node.js | v20+ recommended (tested on v22+) |
| PowerShell | 5.1+ (bundled with Windows) |
| Claude CLI | `claude` command must be available |

> **Note:** nut-js native bindings require the Visual C++ Redistributable.
> Download from [Microsoft](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) if not already installed.

---

## Installation

```bash
git clone https://github.com/Harusame64/desktop-touch-mcp.git
cd desktop-touch-mcp
npm install
npm run build
```

### Register with Claude CLI

Add to `~/.claude.json` under `mcpServers`:

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

**No system prompt needed.** The command reference is automatically injected into Claude via the MCP `initialize` response's `instructions` field.

---

## Tools (34 total)

### Screenshot (5)
| Tool | Description |
|---|---|
| `screenshot` | Main capture. Supports `detail`, `dotByDot`, `dotByDotMaxDimension`, `grayscale`, `region` sub-crop, `diffMode` |
| `screenshot_background` | Capture a background window without focusing it (PrintWindow API) |
| `screenshot_ocr` | Windows.Media.Ocr on a window; returns word-level text + screen clickAt coords |
| `get_screen_info` | Monitor layout, DPI, cursor position |
| `scroll_capture` | Full-page stitch by scrolling (MAE overlap detection + 10% fallback) |

### Window management (4)
| Tool | Description |
|---|---|
| `get_windows` | List all windows in Z-order |
| `get_active_window` | Info about the focused window |
| `focus_window` | Bring a window to foreground by partial title match |
| `dock_window` | Snap a window to a screen corner at a small size + always-on-top (for keeping CLI visible) |

### Mouse (5)
| Tool | Description |
|---|---|
| `mouse_move` / `mouse_click` / `mouse_drag` | Move, click, drag. Accept `speed` and `homing` parameters |
| `scroll` | Scroll in any direction. Accepts `speed` and `homing` parameters |
| `get_cursor_position` | Current cursor coordinates |

### Keyboard (2)
| Tool | Description |
|---|---|
| `keyboard_type` | Type text (`use_clipboard=true` bypasses IME) |
| `keyboard_press` | Key combos (`ctrl+c`, `alt+f4`, etc.) |

### UI Automation (4)
| Tool | Description |
|---|---|
| `get_ui_elements` | Full UIA element tree for a window |
| `click_element` | Click a button by name or automationId — no coordinates needed |
| `set_element_value` | Write directly to a text field |
| `scope_element` | High-res zoom crop of an element + its child tree |

### Browser CDP (7)
| Tool | Description |
|---|---|
| `browser_connect` | Connect to Chrome/Edge via CDP; lists open tabs |
| `browser_find_element` | CSS selector → exact physical screen coords |
| `browser_click_element` | Find DOM element + click in one step |
| `browser_eval` | Evaluate JS expression in the browser tab |
| `browser_get_dom` | Get outerHTML of element or `document.body` |
| `browser_navigate` | Navigate via CDP `Page.navigate` (no address bar needed) |
| `browser_disconnect` | Close cached CDP WebSocket sessions |

### Workspace (2)
| Tool | Description |
|---|---|
| `workspace_snapshot` | All windows: thumbnails + UI summaries in one call |
| `workspace_launch` | Launch an app and auto-detect the new window |

### Pin / Macro (3)
| Tool | Description |
|---|---|
| `pin_window` / `unpin_window` | Always-on-top toggle |
| `run_macro` | Execute up to 50 steps sequentially in one MCP call |

---

## Browser CDP automation

For web automation, connect Chrome or Edge with the remote debugging port enabled — no Selenium or Playwright needed.

```bash
# Launch Chrome in CDP mode
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

```
browser_connect()                       → list open tabs + get tabIds
browser_find_element("#submit")         → CSS selector → physical screen coords
browser_click_element("#submit")        → find + click in one step (auto-focuses browser)
browser_eval("document.title")          → evaluate JS, returns result
browser_get_dom("#main", maxLength=5000)→ outerHTML, truncated to maxLength chars
browser_navigate("https://example.com") → navigate via CDP (no address bar interaction)
browser_disconnect()                    → clean up WebSocket sessions
```

Coordinates returned by `browser_find_element` account for the browser chrome (tab strip + address bar height) and `devicePixelRatio`, so they can be passed directly to `mouse_click` without any scaling.

**Recommended web workflow:**
```
browser_connect() → browser_get_dom() → browser_find_element(selector) → browser_click_element(selector)
```

---

## Auto-dock CLI on startup

Keep Claude CLI visible while operating other apps full-screen. Set env vars in your MCP config and the docked window auto-snaps into place every MCP startup.

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/desktop-touch-mcp/dist/index.js"],
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
| `DESKTOP_TOUCH_DOCK_MONITOR` | primary | Monitor id from `get_screen_info` |
| `DESKTOP_TOUCH_DOCK_SCALE_DPI` | `false` | If true, multiply px values by `dpi / 96` (opt-in per-monitor scaling) |
| `DESKTOP_TOUCH_DOCK_MARGIN` | `8` | Screen-edge padding (px) |
| `DESKTOP_TOUCH_DOCK_TIMEOUT_MS` | `5000` | Max wait for the target window to appear |

> **Input routing gotcha:** when a pinned window is active (e.g. Claude CLI), `keyboard_type` / `keyboard_press` send keys to it, **not** the app you wanted to type into. Always call `focus_window(title=...)` before keyboard operations, then verify `isActive=true` via `screenshot(detail='meta')`.

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
mouse_click(x=500, y=300, windowTitle="メモ帳")

# Tier 1 + 2 + 3: also re-query UIA if window resized
mouse_click(x=500, y=300, windowTitle="メモ帳", elementName="保存")

# Traction control OFF — no correction
mouse_click(x=500, y=300, homing=false)
```

The `homing` parameter is available on `mouse_click`, `mouse_move`, `mouse_drag`, and `scroll`. The cache is updated automatically on every `screenshot()`, `get_windows()`, `focus_window()`, and `workspace_snapshot()` call.

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

**`keyboard_press` blocklist:**
`Win+R` (Run dialog), `Win+X` (admin menu), `Win+S` (search), `Win+L` (lock screen) are blocked.

### PowerShell injection protection

All `-like` patterns in the UIA bridge are sanitized with `escapeLike()`, which escapes wildcard characters (`*`, `?`, `[`, `]`) before they reach PowerShell.

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

All mouse tools (`mouse_move`, `mouse_click`, `mouse_drag`, `scroll`) accept an optional `speed` parameter:

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
      "command": "node",
      "args": ["D:/path/to/desktop-touch-mcp/dist/index.js"],
      "env": {
        "DESKTOP_TOUCH_MOUSE_SPEED": "3000"
      }
    }
  }
}
```

Common values: `0` = teleport, `1500` = default gentle, `3000` = fast, `5000` = very fast.

---

## Known limitations

| Limitation | Detail | Workaround |
|---|---|---|
| Games / video players may return black or hang in background capture | DirectX fullscreen apps may not work even with `PW_RENDERFULLCONTENT` | Retry with `screenshot_background(fullContent=false)`; if still black, use foreground `screenshot` |
| UIA call overhead | ~300ms per call via PowerShell; `workspace_snapshot` uses a 2s timeout internally | Batch with `workspace_snapshot` upfront, then use `diffMode` for incremental checks |
| Chrome / WinUI3 UIA elements are empty | Chromium exposes only limited UIA | `screenshot(detail='text')` auto-detects Chromium and falls back to Windows OCR (`hints.chromiumGuard=true`). For richer DOM access use `browser_connect` + `browser_find_element` |
| Chromium title-regex misses when sites rewrite `document.title` | Guard relies on the ` - Google Chrome` suffix being present; some sites push it off the end of a long title | Title is treated as plain Chrome (UIA runs). OCR path is still reachable via `ocrFallback='always'` or when UIA returns `<5` elements (`uiaSparse`) |
| `browser_*` CDP tools need Chrome launched with `--remote-debugging-port` | If Chrome is already running on the default profile without the flag, `browser_launch` / `browser_connect` fail. The CDP E2E suite (`tests/e2e/browser-cdp.test.ts`) will also fail in that state | Close Chrome first, then `browser_launch` will relaunch it in debug mode, or start Chrome manually with `--remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp` |
| Layer buffer TTL | Buffer auto-clears after 90s of inactivity → next `diffMode` becomes an I-frame | After long waits, call `workspace_snapshot` to explicitly reset the buffer |
| `keyboard_type` / `keyboard_press` follow focus | When `dock_window(pin=true)` keeps another window on top (e.g. Claude CLI), keystrokes may be absorbed by that window | Call `focus_window(title=...)` first and verify `isActive=true` via `screenshot(detail='meta')` before sending keys |

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
