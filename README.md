# desktop-touch-mcp

[日本語](README.ja.md)

> **Stop pasting screenshots. Let Claude see and control your desktop directly.**

An MCP server that gives Claude eyes and hands on Windows — 25 tools covering screenshots, mouse, keyboard, and Windows UI Automation, designed from the ground up for LLM efficiency.

> *Applies MPEG P-frame diffing to window capture: only changed windows are sent after the first frame, cutting token usage by ~60–80% in typical automation loops.*

---

## Features

- **LLM-native design** — Built around how LLMs think, not how humans click. `run_macro` batches multiple operations into a single API call; `diffMode` sends only the windows that changed since the last frame. Minimal tokens, minimal round-trips.
- **Full CJK support** — Uses Win32 `GetWindowTextW` for window titles, avoiding nut-js garbling. IME bypass input supported for Japanese/Chinese/Korean environments.
- **3-tier token reduction** — `detail="image"` (~443 tok) / `detail="text"` (~100–300 tok) / `diffMode=true` (~160 tok). Send pixels only when you actually need to see them.
- **1:1 coordinate mode** — `dotByDot=true` captures at native resolution (WebP). Image pixel = screen coordinate — no scale math needed.
- **UIA element extraction** — `detail="text"` returns button names and `clickAt` coords as JSON. Claude can click the right element without ever looking at a screenshot.
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
git clone https://github.com/yourname/desktop-touch-mcp.git
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

**No system prompt needed.** The command reference is automatically injected into Claude via the MCP `initialize` response's `instructions` field.

---

## Tools (25 total)

### Screenshot (4)
| Tool | Description |
|---|---|
| `screenshot` | Main capture. Supports `detail`, `dotByDot`, `diffMode` |
| `screenshot_background` | Capture a background window without focusing it (PrintWindow API) |
| `get_screen_info` | Monitor layout, DPI, cursor position |
| `scroll_capture` | Full-page stitch by scrolling |

### Window management (3)
| Tool | Description |
|---|---|
| `get_windows` | List all windows in Z-order |
| `get_active_window` | Info about the focused window |
| `focus_window` | Bring a window to foreground by partial title match |

### Mouse (5)
| Tool | Description |
|---|---|
| `mouse_move` / `mouse_click` / `mouse_drag` | Move, click, drag |
| `scroll` | Scroll in any direction |
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

## `screenshot` key parameters

```
detail="image"   — PNG/WebP pixels (default)
detail="text"    — UIA element JSON + clickAt coords (no image, ~100–300 tok)
detail="meta"    — Title + region only (cheapest, ~20 tok/window)
dotByDot=true    — 1:1 WebP; image_px + origin = screen_px
diffMode=true    — I-frame first call, P-frame (changed windows only) after (~160 tok)
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

## Known limitations

| Limitation | Detail | Workaround |
|---|---|---|
| Games / video players may return black or hang in background capture | DirectX fullscreen apps may not work even with `PW_RENDERFULLCONTENT` | Retry with `screenshot_background(fullContent=false)`; if still black, use foreground `screenshot` |
| UIA call overhead | ~300ms per call via PowerShell; `workspace_snapshot` uses a 2s timeout internally | Batch with `workspace_snapshot` upfront, then use `diffMode` for incremental checks |
| Chrome / WinUI3 UIA elements are empty | Chromium exposes only limited UIA | Use `screenshot(detail="image")` for visual inspection, then click by coordinates |
| Layer buffer TTL | Buffer auto-clears after 90s of inactivity → next `diffMode` becomes an I-frame | After long waits, call `workspace_snapshot` to explicitly reset the buffer |

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
