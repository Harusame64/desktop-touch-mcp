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
> **2.1** reads UI Automation by element count instead of depth: Chrome, Edge and VS Code pages, Explorer and Settings values, and Word's body are read and can be acted on, and what UIA still cannot see falls back to OCR and Set-of-Marks as before. `desktop_act` also types into Word's body, and into Windows Terminal after asking the user. **2.0** refuses an action that cannot be done, with a reason, instead of reporting it done, and an action aimed by `hwnd` reaches that window only. See the [CHANGELOG](CHANGELOG.md).

---

## Features

- **🔁 Every act reports what it did** — `desktop_act` answers with what changed: elements that appeared or disappeared, a modal, a focus move, the screen's repaint (`observation`), and with `narrate:"rich"` the values and names that changed. The agent reads the result of its click from the reply instead of taking another screenshot. On UIA-blind targets it can also attach a PNG of just the region that changed (`roiCapture`; on by default for a visible change, `returnCapture:"never"` to suppress, `"always"` to force).
- **🛑 An act that cannot be done is refused, not reported as done** — input that would not reach the field, a window blocked by a dialog, a closed window, a window on another virtual desktop: nothing is sent, and the reply names the reason and what to do next. An act aimed by `hwnd` never lands in another window with the same title.
- **🌐 Reads deep windows (2.1)** — The UI Automation read goes to depth 64 and 500 elements. Chrome, Edge and VS Code pages, which 2.0 called blind, Explorer and Settings values it left out, and Word's body are read and can be acted on (a Chrome page: 6 elements in 387 ms → 45 in 186 ms).
- **🎯 Set-of-Marks (SoM) visual fallback** — Games, RDP sessions and apps with no accessibility tree still return clickable elements: when UIA is blind, `desktop_discover` and `screenshot(detail="text")` switch to a Hybrid Non-CDP pipeline — Rust-powered grayscale + bilinear upscale → Windows OCR → clustering → red bounding boxes with numbered badges (`[1]`, `[2]`…). Two representations come back: a PNG for spatial orientation and an `elements[]` list with `clickAt` coords — no CDP required.
- **⌨️ Types where background input does not reach** — Windows Terminal, after asking the user each time (needs an MCP client with elicitation, over stdio), and Word's body, at Word's caret whether it is in front or behind.
- **🔐 Key Locker — the terminal autofills your SSH / sudo passwords** — Save a credential once into the locker's own secure dialog (stored encrypted on your machine with Windows DPAPI; never shown to the assistant), then run `ssh` / `sudo` in a console opened by `key_locker(action='launch_console')` — the password is filled in automatically when the hidden prompt appears, with a per-fill confirmation prompt by default. See [Key Locker](docs/guide.md#key-locker-terminal-credential-autofill).
- **⚡ Rust native core** — The UIA bridge and image diffing are a Rust native addon (`napi-rs` + `windows-rs`): UIA is called over COM from a dedicated thread instead of spawning PowerShell, and image diffs use SSE2 SIMD. Without the addon, every function falls back to PowerShell transparently. The npm launcher fetches only the GitHub Release matching its version and verifies the Windows runtime zip before extracting it.
- **LLM-native design** — Built around how LLMs think, not how humans click. `run_macro` batches multiple operations into a single API call; `diffMode` sends only the windows that changed since the last frame. Minimal tokens, minimal round-trips.
- **Reactive Perception Graph** — Register a `lensId` for a window or browser tab, pass it to action tools, and get guard-checked `post.perception` feedback after each action. It reduces repeated `screenshot` / `desktop_state` calls and prevents wrong-window typing or stale-coordinate clicks.
- **Full CJK support** — Uses Win32 `GetWindowTextW` for window titles, avoiding nut-js garbling. IME bypass input supported for Japanese/Chinese/Korean environments.
- **3-tier token reduction** — `detail="image"` (~443 tok) / `detail="text"` (~100–300 tok) / `diffMode=true` (~160 tok). Send pixels only when you actually need to see them.
- **1:1 coordinate mode** — `dotByDot=true` captures at native resolution (WebP). Image pixel = screen coordinate — no scale math needed. With `origin`+`scale` passed to `mouse_click`, the server converts coords for you — eliminating off-by-one / scale bugs.
- **Browser capture data reduction** — `grayscale=true` (~50% size), `dotByDotMaxDimension=1280` (auto-scaled with coord preservation), and `windowTitle + region` sub-crops help exclude browser chrome and other irrelevant pixels. Typical reduction for heavy captures: 50–70%.
- **Chromium smart fallback** — `detail="text"` on Chrome/Edge/Brave auto-skips UIA (prohibitively slow there) and runs Windows OCR. `hints.chromiumGuard` + `hints.ocrFallbackFired` flag the path taken.
- **UIA element extraction** — `detail="text"` returns button names and `clickAt` coords as JSON. Claude can click the right element without ever looking at a screenshot.
- **Auto-dock CLI** — `window_dock(action='dock')` snaps any window to a screen corner with always-on-top. Set `DESKTOP_TOUCH_DOCK_TITLE='@parent'` to auto-dock the terminal hosting Claude on MCP startup — the process-tree walker finds the right window regardless of title.
- **Emergency stop (Failsafe)** — Park the mouse in the **top-left corner of the primary monitor** (within 10px of 0,0) for 500ms to trigger the emergency stop.

---

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (64-bit). **macOS 14+ on Apple Silicon: limited preview, 4 tools only** — see [macOS (preview)](#macos-preview) |
| Node.js | v20+ recommended (tested on v22+) — **to develop or run the test suite, `^22.12 || ^24 || >=26`** — the test runner's own range since #658, which excludes odd majors such as 23 and 25 |
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

The npm launcher resolves runtime strictly by npm package version. For package `X.Y.Z`, it fetches only GitHub Release tag `vX.Y.Z`, downloads the zip for your platform (`desktop-touch-mcp-windows.zip`, or `desktop-touch-mcp-macos-arm64.zip` on an Apple Silicon Mac), verifies its SHA256 digest, and only then expands it under `%USERPROFILE%\.desktop-touch-mcp` (`~/.desktop-touch-mcp` on macOS). Verified cached releases are reused on later runs.

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

> **Does your host give up before the launcher finishes?** Some desktop hosts
> allow a plugin a fixed budget — 60 seconds is common — to become ready, and a
> launcher waiting on an unreachable GitHub can spend all of it. Two environment
> variables cover that case.
>
> `DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS` (default `15000`) bounds how long the
> launcher waits without hearing from GitHub. It applies to the release lookup
> and to the download; for the download it counts silence rather than total
> time, so a large runtime still installs over a slow connection. A value that
> is not a positive number of milliseconds is ignored with a warning.
>
> `DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1` lets the launcher start a release that
> is already installed when GitHub cannot be reached at all. It is off by
> default. GitHub is always contacted first, so a reachable network still
> re-downloads and repairs a damaged install; only a network failure reaches the
> fallback, which starts the copy of your version on disk — without
> re-verification — or, when that version was never installed, the newest older
> release that completed a verified install. Answers that are not network
> failures (a 404, the API rate limit, a mismatched integrity hash) still stop
> startup loudly. Leave it off unless a host timeout forces your hand: while it
> is set, a corrupted install of your current version is reused instead of being
> repaired.
>
> The two work together: with the fallback on, startup still waits out the
> timeout before falling back, so lower `DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS` if
> your host's budget is tight. Note also that a download which is still
> arriving, however slowly, is never interrupted — the fallback answers when the
> network has gone silent, not when it is merely slow.

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


## macOS (preview)

> **Limited preview.** The macOS build has only 4 of the tools — a small subset of the Windows build — and its behaviour may change between releases.

On an Apple Silicon Mac (macOS 14 or later) the same `npx` command starts a macOS server with four tools: `desktop_state`, `desktop_discover`, `desktop_act` (press, replace or append text) and `screenshot` (one window). The other tools are Windows-only and are not listed on macOS.

- Grant **Accessibility** — and **Screen Recording** for window titles and screenshots — to the app that runs the server (Terminal, iTerm, VS Code, the Claude app, …) in System Settings › Privacy & Security. On recent macOS the Accessibility pane can have another name; these commands open the two panes directly:
  ```bash
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  ```
  Then **restart the MCP server** — restart or reconnect it in your client, or restart the app that runs it: a server that was already running did not see a new Accessibility grant. If screenshots still fail after granting Screen Recording, quit and reopen that app. Until then the tools answer `PermissionRequired` and say what to grant.
- Install with `npx` only: a release zip downloaded with a browser is refused by Gatekeeper (the native module is not notarized).
- stdio only (`--http` is not available yet). Intel Macs and Linux are not supported.

---

## Tools (32 Optimized Tools)

> 📖 **Full Reference**: [`docs/system-overview.md`](docs/system-overview.md) — Exhaustive guide on parameters, return schemas, and coordinate math.

### 🌐 World-Graph V2 (Primary Path)
| Tool | Description |
|---|---|
| `desktop_discover` | Observe the desktop. Returns interactive entities with leases (UIA, CDP, Terminal, Visual SoM). |
| `desktop_act` | Perform actions (click, type, set a value, select) on entities via lease validation. Returns semantic diffs — plus an optional `roiCapture` (changed-region PNG + next-target preview) on visual-only targets. |

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
| `terminal` | Unified command execution: `run` (send + wait + read), `read` (OCR/UIA), and `send`. `run` completion modes: `quiet`, `pattern`, and `exit` (waits for the command to finish + returns its exit code — see [Terminal command completion](docs/guide.md#terminal-command-completion-until)). |
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

Recovery hints for each refusal, and how leases expire: [Guide → Recovery hints and leases](docs/guide.md#recovery-hints-and-leases).

---

## More in the guide

The details live in the [guide](docs/guide.md):

- [Recovery hints and leases](docs/guide.md#recovery-hints-and-leases)
- [Terminal command completion (`until`)](docs/guide.md#terminal-command-completion-until)
- [Key Locker (terminal credential autofill)](docs/guide.md#key-locker-terminal-credential-autofill)
- [Browser CDP automation](docs/guide.md#browser-cdp-automation)
- [Auto-dock CLI on startup](docs/guide.md#auto-dock-cli-on-startup)
- [Mouse homing correction](docs/guide.md#mouse-homing-correction)
- [`screenshot` key parameters](docs/guide.md#screenshot-key-parameters)
- [Security](docs/guide.md#security)
- [Mouse movement speed](docs/guide.md#mouse-movement-speed)
- [Force-Focus (AttachThreadInput)](docs/guide.md#force-focus-attachthreadinput)
- [Auto Guard](docs/guide.md#auto-guard)
- [Diagnostic log](docs/guide.md#diagnostic-log)
- [Advanced response options](docs/guide.md#advanced-response-options)
- [Performance of the native engine (measured at v0.15)](docs/guide.md#performance-of-the-native-engine-measured-at-v015)
- [UI Operating Layer (V2)](docs/guide.md#ui-operating-layer-v2)
- [Token cost reference](docs/guide.md#token-cost-reference)

---

## Known limitations

| Limitation | Detail | Workaround |
|---|---|---|
| Games / video players may return black or hang in PrintWindow capture | DirectX fullscreen apps may not redraw under `PW_RENDERFULLCONTENT`. Window-targeted `screenshot(detail='image')` already falls back to BitBlt automatically when PrintWindow returns no data or an all-black + zero-variance frame, but DirectX surfaces that hang the call don't surface as fallback. | Retry with `screenshot({mode:'background', fullContent:false})` to switch to the legacy PrintWindow flag; if still black, the BitBlt fallback path (default `mode='normal'`) will at least return the on-screen rect — `hints.captureFallbackReason` will say `printwindow-all-black` |
| UIA call overhead | ~2 ms (focus) / ~100 ms (tree) via Rust native engine; ~300 ms via PowerShell fallback | Rust engine loads automatically; `workspace_snapshot` uses a 2 s timeout internally |
| `screenshot(detail='text')` returns few UIA elements on Chrome / WinUI3 | That read stays shallow on Chromium (`desktop_discover` reads the page's controls since 2.1) | `screenshot(detail='text')` auto-detects Chromium and falls back to Windows OCR (`hints.chromiumGuard=true`). Use `desktop_discover` for the page's controls, or `browser_open` + `browser_locate` for DOM access |
| Chromium title-regex misses when sites rewrite `document.title` | Guard relies on the ` - Google Chrome` suffix being present; some sites push it off the end of a long title | Title is treated as plain Chrome (UIA runs). OCR path is still reachable via `ocrFallback='always'` or when UIA returns `<5` elements (`uiaSparse`) |
| `browser_*` CDP tools need Chrome launched with `--remote-debugging-port` | If Chrome is already running on the default profile without the flag, `browser_open` fails. The CDP E2E suite (`tests/e2e/browser-cdp.test.ts`) will also fail in that state | Close Chrome first, then `browser_open({launch:{}})` will relaunch it in debug mode, or start Chrome manually with `--remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp` |
| Layer buffer TTL | Buffer auto-clears after 90s of inactivity → next `diffMode` becomes an I-frame | After long waits, call `workspace_snapshot` to explicitly reset the buffer |
| `keyboard(action='type')` / `keyboard(action='press')` follow focus | When `window_dock(action='dock')(pin=true)` keeps another window on top (e.g. Claude CLI), keystrokes may be absorbed by that window | Call `focus_window(title=...)` first and verify `isActive=true` via `screenshot(detail='meta')` before sending keys |
| `keyboard(action='type')` em-dash / smart quotes in Chrome/Edge | Non-ASCII punctuation (em-dash `—`, en-dash `–`, smart quotes `"" ''`) can be intercepted as keyboard accelerators, shifting focus to the address bar | Always use `use_clipboard=true` when the text contains such characters |
| `browser_eval(action='js')` on React / Vue / Svelte inputs | Setting `element.value = ...` or dispatching synthetic events does not update the framework's internal state | Use `browser_fill(selector, value)` — it uses native prototype setter + InputEvent which does update React/Vue/Svelte state |

---

## Thanks

Huge thanks to everyone who tried a desktop-automation MCP server, filed issues,
opened PRs, and shared what broke. Every bug report made the next release better.
Thank you for building with me!

---

## License

MIT
