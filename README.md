# desktop-touch-mcp

[![desktop-touch-mcp MCP server](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp/badges/card.svg)](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp)

[日本語](README.ja.md)

> **Computer-use MCP server for Windows.** Lets Claude, Cursor, or any MCP client see and operate your Windows 10/11 desktop — screenshots, UI Automation, Chrome CDP, keyboard / mouse, terminal — with **semantic discover-then-act targeting** that avoids pixel-coordinate guessing, and **per-action perception guards** that catch wrong-window typing before it happens.

```bash
npx -y @harusame64/desktop-touch-mcp
```

32 tools, native Rust engine (UIA in 2 ms), zero-config PowerShell fallback, full CJK support, MIT licensed. Add the snippet above to your Claude / Cursor / VS Code Copilot config and Claude can drive Notepad, Excel, Chrome, Windows Terminal, and any other app on your machine.

> **Why this over pixel-clicking?** Two ideas run through every tool: **discover-then-act** — `desktop_discover` returns interactive entities with short-lived leases instead of raw coordinates, so `desktop_act` operates on *what* you mean, not *where* it was — and **per-action perception guards** that verify the target window's identity and bounds before input lands, catching wrong-window typing and stale-coordinate clicks before they happen.
>
> Under the hood: an **82× average speedup** from the Rust native engine (UIA focus queries in 2 ms, SSE2-accelerated image diffing at 13–15×), with a transparent PowerShell fallback when the engine is absent. The npm launcher fetches only the GitHub Release tag matching the installed version and verifies the Windows runtime zip before extraction.

---

## Features

- **⚡ High-performance Rust Native Core** — The UIA bridge and image-diff engine are written in Rust (`napi-rs` + `windows-rs`) and loaded as a native `.node` addon. Direct COM calls from a dedicated MTA thread eliminate PowerShell process spawning — `getFocusedElement` completes in **2 ms** (160× faster), and `getUiElements` returns full trees in **~100 ms** with a batch BFS algorithm that minimizes cross-process RPC. Image-diff operations use **SSE2 SIMD** for 13–15× throughput. When the native engine is unavailable, every function transparently falls back to PowerShell — zero config required.
- **🎯 Set-of-Marks (SoM) visual fallback** — Games, RDP sessions, and non-accessible Electron apps return clickable elements even when UIA is completely blind. `screenshot(detail="text")` automatically detects UIA sparsity and activates a Hybrid Non-CDP pipeline: Rust-powered grayscale + bilinear upscale → Windows OCR → clustering → red bounding-box annotation with numbered badges (`[1]`, `[2]`…). Two parallel representations returned: a visual PNG for spatial orientation and a semantic `elements[]` list with `clickAt` coords — no CDP required.
- **🔁 One-call confirmation on visual-only targets** — On UIA-blind targets (Electron, PWAs, games, custom canvases, RDP windows), `desktop_act` can fold the post-action confirmation into its own response: an optional `roiCapture` carrying a PNG crop of *just the region that changed* plus a lease-less preview of the controls now visible there. The agent confirms what its click did and finds the next target without a separate `desktop_state` + `screenshot`. On visual-only targets it is **on by default** for a visible change (`returnCapture:"on-change"`); pass `returnCapture:"never"` to suppress it, or `"always"` to force it. Never attached on structured targets (browser/CDP, UIA-rich native), where `desktop_state` is cheaper and exact — so those responses are unchanged.
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

> **Note (Key Locker):** The credential helper Key Locker uses is an unsigned executable, so on
> some machines Windows SmartScreen or antivirus may show an "unknown publisher" warning the
> first time it runs. This is expected — the helper ships with desktop-touch-mcp and runs locally
> on your machine; you can allow it to proceed. Code signing is planned for a future release.

---

## Installation

```bash
npx -y @harusame64/desktop-touch-mcp
```

The npm launcher resolves runtime strictly by npm package version. For package `X.Y.Z`, it fetches only GitHub Release tag `vX.Y.Z`, downloads `desktop-touch-mcp-windows.zip`, verifies its SHA256 digest, and only then expands it under `%USERPROFILE%\.desktop-touch-mcp`. Verified cached releases are reused on later runs.

Set `DESKTOP_TOUCH_MCP_HOME` to override the cache root directory.

> **On a shared or CI network?** The first run reads the GitHub Releases API to
> locate the runtime zip. The anonymous limit is 60 requests/hour per IP, which a
> shared public address (CI runners, office NAT) can exhaust before your download
> even starts. Set `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment and the
> launcher authenticates the request, raising the limit to 5,000 requests/hour.
> No token is needed on an ordinary home connection.

> **Running the launcher from a source checkout?** A source build's
> `bin/launcher.js` carries a placeholder integrity hash (`sha256: "PENDING"`)
> instead of a finalized one. Rather than download and run an unverified runtime,
> the launcher fails closed — this guard stops an accidentally published or
> unfinalized launcher from silently starting unverified code. Published npm
> releases always ship a real SHA256, so end users never see this. If you are
> intentionally running the launcher from source, set
> `DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED=1` to skip integrity verification
> (development only).

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

## Tools (32 Optimized Tools)

> 📖 **Full Reference**: [`docs/system-overview.md`](docs/system-overview.md) — Exhaustive guide on parameters, return schemas, and coordinate math.

### 🌐 World-Graph V2 (Primary Path)
| Tool | Description |
|---|---|
| `desktop_discover` | Observe the desktop. Returns interactive entities with leases (UIA, CDP, Terminal, Visual SoM). |
| `desktop_act` | Perform actions (click, type, drag, select) on entities via lease validation. Returns semantic diffs — plus an optional `roiCapture` (changed-region PNG + next-target preview) on visual-only targets. |

### 👁️ Observation & State
| Tool | Description |
|---|---|
| `desktop_state` | Lightweight check of focus, active window, cursor, and Auto-Perception attention signal. |
| `screenshot` | Multi-mode capture: `detail='text'` (UIA/OCR), `diffMode` (P-frame), `dotByDot` (1:1), and `background`. Returns a cheap `screenshot://by-ref/{id}` link to the saved image instead of inlining pixels every time. |
| `screenshot_query` / `screenshot_gc` | Inspect and prune the on-disk screenshot cache behind the by-ref links: `screenshot_query` lists saved captures without re-reading pixels; `screenshot_gc` reclaims space by retention policy (dry-run by default). |
| `workspace_snapshot` | Instant session orientation: all window thumbnails + UI summaries in one call. |
| `server_status` | Diagnostic check for native engine health and feature activation. |

### ⌨️ Input & Control
| Tool | Description |
|---|---|
| `keyboard` | Send keyboard input. Supports background input (WM_CHAR) and IME-safe clipboard bypass. |
| `mouse_click` / `mouse_drag` | Precision coordinate-based interaction with homing and force-focus protection. |
| `scroll` | Multi-strategy: `raw` (notches), `to_element`, `smart` (virtual lists), and `capture` (stitch). |
| `click_element` | Legacy UIA-based click by name/ID (fallback when entities are unavailable). |

### 🌐 Browser CDP (Chrome/Edge/Brave)
| Tool | Description |
|---|---|
| `browser_open` / `browser_navigate` | Idempotent debug-mode launch and reliable navigation. |
| `browser_click` / `browser_fill` / `browser_form` | High-level DOM interaction stable across repaints and framework re-renders. |
| `browser_eval` | Deep inspection via `js` (scripting), `dom` (HTML), and `appState` (SPA data extraction). |
| `browser_overview` / `browser_search` / `browser_locate` | Semantic discovery, grep-like DOM search, and pixel-accurate coordinate lookup. |

### 🛠️ Utilities & Workflow
| Tool | Description |
|---|---|
| `terminal` | Unified command execution: `run` (send + wait + read), `read` (OCR/UIA), and `send`. `run` completion modes: `quiet`, `pattern`, and `exit` (waits for the command to finish + returns its exit code — see [Terminal command completion](#terminal-command-completion-until)). |
| `wait_until` | Efficient server-side polling for window, focus, text, or URL state changes. |
| `window_dock` / `focus_window` | Window management: `pin` (always-on-top), `unpin`, `dock` (corner snap), and `focus`. |
| `workspace_launch` | Launch apps and auto-detect new HWNDs (supports localized titles). |
| `run_macro` | Batch up to 50 operations into a single round-trip for maximum efficiency. |
| `clipboard` / `notification_show` | System-level text exchange and user alerts. |
| `key_locker` | Manage credentials the terminal autofills for you (SSH key passphrases, sudo / login passwords). Secrets are entered once into the locker's own secure dialog and stored encrypted on this machine (Windows DPAPI); they are never shown to the assistant. `action='launch_console'` opens an autofill-capable console (returns a `paneId` to drive `ssh`/`sudo` into via `terminal`); `save` / `list` / `forget` / `set_policy` / `status` manage bindings. Autofill only fires in a console opened by `launch_console`. Disable with `DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1`. |

### 📊 Office (Excel)
| Tool | Description |
|---|---|
| `excel` | Author and run Excel VBA macros via COM. `action='run_vba'` writes a macro into a managed Trusted Location and runs it; `action='check_access_vbom'` is a read-only preflight. Runs VBA where formula-only tools cannot. One-time setup: `node scripts/enable-access-vbom.mjs`. |

---

## Standard workflow (v1.0.0)

The v2 World-Graph surface (`desktop_discover` / `desktop_act`) is the recommended dispatch path. The four-call shape works for native apps, browsers, and terminals identically.

```
desktop_state          → orient: focused window/element, modal, attention signal
desktop_discover       → find actionable entities (returns lease + windows[])
desktop_act(lease, …)  → act on entity (returns attention + post.perception)
desktop_state          → confirm the world changed as expected
```

Clicking — priority order:

```
browser_click(selector)               → Chrome / Edge (CDP, stable across repaints)
desktop_act(lease, action='click')    → native / dialog / visual (entity-based; use after desktop_discover)
click_element(name | automationId)    → native UIA fallback if desktop_act returns ok:false
mouse_click(x, y, origin?, scale?)    → pixel last resort; origin+scale from dotByDot screenshots only
```

Recovery hints — read `response.attention` after every observation and `response.warnings[]` on `desktop_discover` / `desktop_act`. Common reasons:

- `lease_expired` / `lease_generation_mismatch` / `lease_digest_mismatch` / `entity_not_found` → re-call `desktop_discover`
- `modal_blocking` → `response.blockingElement` (when present) names the blocking modal; dismiss via `click_element(name=blockingElement.name)` then retry
- `entity_outside_viewport` → `scroll(action='to_element' | 'raw')`, then re-call `desktop_discover`
- `executor_failed` → fall back to `click_element` / `mouse_click` / `browser_click`

Lease lifecycle:

- Each `desktop_discover` response carries `softExpiresAtMs` (≈ 60 % of the TTL window). Past that timestamp the LLM should consider re-calling `desktop_discover` even though the lease is still technically valid — `lease.expiresAtMs` is the only correctness wall.
- TTL adapts to `view` mode (`action`/`explore`/`debug`), entity count, and response payload size. Cap is 60 s.
- Set `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` to fall back to the v1 tool surface (`get_windows` / `get_ui_elements` / `set_element_value`) for troubleshooting only — V2 is the recommended default.

---

## Terminal command completion (`until`)

`terminal(action='run')` sends a command, waits for it to complete, and reads the
output in one call. How it decides "complete" is controlled by `until`:

| Mode | Waits for | Best for |
|---|---|---|
| `quiet` (default) | output to fall silent for `quietMs` | short interactive commands |
| `pattern` | a string/regex you expect in the output | long commands with a known final marker |
| `exit` | the command to actually **finish** | when you need completion or the exit code |

> **Anchoring caveat (#384):** a command whose final line has no trailing newline
> glues the marker to the next prompt with no line boundary (`printf X` →
> `Xuser@host:~$`), so an end-anchored `pattern` (`X\s*\n` / `X$`) can never bind.
> For *completion* use `mode:'exit'`; for *content* matching use a bare marker
> (no `\n`/`$`). `mode:'pattern'` also accepts an optional `quietMs` settle
> fallback: `until:{mode:'pattern', pattern, quietMs:1000}` completes with
> `reason:'quiet'` (no `matchedPattern`) once output is stable for that long
> without a match — instead of hanging until `timeoutMs`. It is opt-in (omit
> `quietMs` to keep waiting for the pattern; long commands with mid-run silent
> gaps are unaffected).

### `until:{mode:'exit'}` — real completion + exit code

The heuristic modes can misfire on the common "append a sentinel" idiom
(`some-task; echo DONE` matched by `DONE`): the sentinel also shows up in the
**echoed command line**, and for multi-line commands there is no reliable way to
tell that echo apart from real output. `mode:'exit'` removes the guesswork — the
server appends its own completion marker whose *printed* form differs from its
*typed* form, so it never matches the echoed command (even for multi-line input),
and it returns the real process exit code:

```js
terminal({
  action: 'run',
  windowTitle: 'pwsh',
  input: 'npm run build',
  until: { mode: 'exit', shell: 'powershell' },
})
// → completion: { reason: 'exited', exitCode: 0, elapsedMs: … }
//   output: just the command's real output (the injected marker is stripped)
```

- **Pass `shell` explicitly** (`'bash'` or `'powershell'`). `shell:'auto'` detects
  the shell from the terminal window, but it cannot see a shell running *inside*
  SSH or WSL — the window still looks like its local host — so for remote/nested
  sessions pass the remote side's shell (`auto` otherwise warns and may pick the
  outer shell). A window whose process is genuinely unidentifiable (e.g. Windows
  Terminal) returns `ExitModeShellAmbiguous`.
- **First-class shells:** `bash` and `powershell`. `cmd.exe` is not supported yet
  (`ExitModeShellUnsupported`).
- **Unsafe input is rejected up front** (`ExitModeUnsafeInput`) rather than
  hanging: a command ending mid-construct (unterminated quote, here-doc, `$(…)`,
  a trailing `\` or PowerShell backtick).
- Exit mode controls its own delivery, so delivery-shaping `sendOptions`
  (`method` / `preferClipboard` / `pressEnter` / `chunkSize` / `pasteKey`) are
  rejected with `InvalidArgs`; focus options remain accepted.

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

### Screenshot cache (by-ref storage)

`screenshot` and the other visual results return a cheap `screenshot://by-ref/{id}` link to an image saved on disk instead of inlining the pixels every time, so routine look-act-confirm loops cost far fewer tokens. The cache bounds itself automatically and `screenshot_query` / `screenshot_gc` let you inspect and prune it. Tune the storage with:

| Env var | Default | Notes |
|---|---|---|
| `DESKTOP_TOUCH_SCREENSHOTS_DIR` | *(per-user cache dir)* | Pin the cache to a specific folder. If the default folder can't be created or written (e.g. corporate policy blocking new folders under your profile), the server auto-probes this → the runtime dir → an OS temp folder and uses the first writable one instead of giving up on the cache. |
| `DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT` | `200` | Keep at most this many captures in the cache. |
| `DESKTOP_TOUCH_SCREENSHOT_MAX_BYTES` | `256 MiB` | Cap the total cache size on disk. |
| `DESKTOP_TOUCH_SCREENSHOT_MAX_AGE_MS` | *(off)* | Drop captures older than this many milliseconds (opt-in). |
| `DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE` | `on` | Auto-trim the cache as new captures are saved. Set `0` to disable. |
| `DESKTOP_TOUCH_SCREENSHOT_MIN_EVICT_AGE_MS` | `60000` | Never auto-evict a capture younger than this (ms), so a by-ref link you were just handed survives long enough to open even when another AI/process on the same PC is also capturing. `0` disables. |

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

If the force attempt is refused despite `AttachThreadInput`, the response is `ok:false` with `code: "ForegroundRestricted"` (issue #202 unification — same shape as `focus_window`, `keyboard`, `terminal_send`, `mouse_click`). The action itself is **suppressed** so the keystrokes / click never land on the wrong window. Recover via `focus_window`'s auto-escalate ladder before retrying. The legacy `hints.warnings: ["ForceFocusRefused"]` shape is no longer emitted.

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

## Auto Guard

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

## Advanced response options

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
| `desktop_act` | Interact with an entity returned by `desktop_discover`. Validates the lease before executing. Returns a semantic diff (`entity_disappeared`, `modal_appeared`, `focus_shifted`, …). On visual-only targets a successful act can bundle a `roiCapture` (a PNG crop of the changed region + a lease-less next-target preview) so you confirm the result and find the next target in one call — controlled by `returnCapture` (`on-change`, the default on a visible change; `never` to suppress; `always` to force). |

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

| `DISABLE_FUKUWARAI_V2` | V2 state |
|---|---|
| unset / not `"1"` | **ON** (default) |
| `"1"` | **OFF** (kill switch) |

### Removed: `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2`

This was the opt-in switch in v0.16.x. V2 is on by default since v0.17, so the flag no longer has any effect and is safe to delete from your config. To turn V2 off, set `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1`.

### Recovery when V2 fails

If `desktop_act` returns `ok: false`, read `reason` and follow the built-in recovery hints in the tool description. Common paths:

- `lease_expired` / `*_mismatch` / `entity_not_found` → re-call `desktop_discover`
- `modal_blocking` → `response.blockingElement` (when present) carries `{ name, role, automationId? }`; dismiss with `click_element(name=blockingElement.name)`, then retry
- `entity_outside_viewport` → `scroll` / `scroll(action='to_element')`, then re-call `desktop_discover`
- `executor_failed` → fall back to `click_element` / `mouse_click` / `browser_click`

For `desktop_discover` warnings (`visual_provider_unavailable`, `visual_provider_warming`, `cdp_provider_failed`, …), the coordinate-based tools (`screenshot(detail='text')`, `click_element`, `mouse_click`, `terminal`, …) remain available as an escape hatch.

---

## Known limitations

| Limitation | Detail | Workaround |
|---|---|---|
| Games / video players may return black or hang in PrintWindow capture | DirectX fullscreen apps may not redraw under `PW_RENDERFULLCONTENT`. Window-targeted `screenshot(detail='image')` already falls back to BitBlt automatically when PrintWindow returns no data or an all-black + zero-variance frame, but DirectX surfaces that hang the call don't surface as fallback. | Retry with `screenshot({mode:'background', fullContent:false})` to switch to the legacy PrintWindow flag; if still black, the BitBlt fallback path (default `mode='normal'`) will at least return the on-screen rect — `hints.captureFallbackReason` will say `printwindow-all-black` |
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

## 🚀 3,000+ Downloads!

This project just passed **3,000+ downloads**. Huge thanks to everyone who
tried an experimental desktop-automation MCP server, filed issues, opened PRs,
and shared what broke. Every bug report made the next release better.
Thank you for building with me!

---

## License

MIT
