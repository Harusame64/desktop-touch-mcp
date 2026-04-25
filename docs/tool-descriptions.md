# MCP Tool Descriptions (LLMに渡すdescriptionリスト)

LLMのtools/listで渡される全ツールのdescription一覧。合計58ツール。

| # | Tool Name | Description |
|---|-----------|-------------|
| 1 | `screenshot` | Capture desktop, window, or region state across four output modes — from cheap orientation metadata to pixel-accurate images. |
| 2 | `screenshot_background` | Capture a window that is hidden, minimized, or behind other windows using Win32 PrintWindow API. |
| 3 | `screenshot_ocr` | Run Windows OCR on a window and return word-level text with screen-pixel clickAt coordinates. |
| 4 | `get_screen_info` | Return all connected display info: resolution, position, DPI scaling, and current cursor position. |
| 5 | `mouse_move` | Move the cursor to coordinates without clicking — for hover-only effects such as revealing tooltips. |
| 6 | `mouse_click` | Click at screen coordinates with auto-guard verification of target identity, foreground, and bounds. |
| 7 | `mouse_drag` | Click and drag from start to end position holding the left mouse button — for sliders, drag-and-drop, canvas drawing. |
| 8 | `scroll` | Send raw mouse-wheel notches at coordinates or current cursor with direction and amount control. |
| 9 | `get_cursor_position` | Return the current mouse cursor position in virtual screen coordinates. |
| 10 | `keyboard_type` | Type a string into the focused window with auto-focus and auto-guard verification. |
| 11 | `keyboard_press` | Press a key or key combination with auto-focus and auto-guard verification before pressing. |
| 12 | `get_windows` | List all visible windows with titles, screen positions, Z-order, active state, and virtual desktop membership. |
| 13 | `get_active_window` | Return the title, hwnd, and bounds of the currently focused window. |
| 14 | `focus_window` | Bring a window to the foreground by partial title match (case-insensitive). |
| 15 | `get_ui_elements` | Inspect the raw UIA element tree of a window with control types, automationIds, bounding rects. |
| 16 | `click_element` | Invoke a UI element by name or automationId via UIA InvokePattern. |
| 17 | `set_element_value` | Set the value of a text field or combo box via UIA ValuePattern. |
| 18 | `scope_element` | Return a high-resolution screenshot of a specific element's region plus its child element tree. |
| 19 | `workspace_snapshot` | Orient fully in one call with display layouts, window thumbnails, and per-window actionable elements. |
| 20 | `workspace_launch` | Launch an application and wait for its new window to appear, returning title, HWND, and PID. |
| 21 | `pin_window` | Make a window always-on-top until unpin_window is called or duration_ms elapses. |
| 22 | `unpin_window` | Remove always-on-top from a window. Reverses pin_window. |
| 23 | `scroll_capture` | Scroll a window top-to-bottom and stitch all frames into one image for full-length webpages. |
| 24 | `scroll_to_element` | Scroll a named element into the visible viewport without manually computing scroll amounts. |
| 25 | `smart_scroll` | Scroll any element into the viewport handling nested scroll layers, virtualised lists, and sticky headers. |
| 26 | `dock_window` | Snap a window to a screen corner at a fixed small size and pin it always-on-top. |
| 27 | `run_macro` | Execute multiple tools sequentially in one MCP call to eliminate round-trip latency. |
| 28 | `wait_until` | Server-side poll for an observable condition to eliminate screenshot-polling loops. |
| 29 | `get_context` | Query focused window, focused element, cursor position, and page state in one cheap call. |
| 30 | `get_history` | Return recent action history (ring buffer, last 20 entries) with tool name, argsDigest, and post-state. |
| 31 | `get_document_state` | Return current Chrome page state via CDP: url, title, readyState, selection, and scroll position. |
| 32 | `terminal_read` | Read current text from a terminal window via UIA TextPattern with OCR fallback. |
| 33 | `terminal_send` | Send a command to a terminal window (Windows Terminal, conhost, PowerShell, cmd, WSL). |
| 34 | `browser_connect` | Connect to Chrome/Edge running with --remote-debugging-port and return open tab IDs. |
| 35 | `browser_search` | Grep-like element search across the current page by text, regex, role, or ariaLabel. |
| 36 | `browser_get_interactive` | List all interactive elements on the current page with CSS selectors and viewport status. |
| 37 | `browser_get_app_state` | Extract embedded SPA framework state (Next.js, Nuxt, Remix, GitHub, Apollo, Redux SSR). |
| 38 | `browser_launch` | Launch Chrome/Edge/Brave in CDP debug mode and wait until the DevTools endpoint is ready. |
| 39 | `browser_find_element` | Find a DOM element by CSS selector and return its physical screen coordinates. |
| 40 | `browser_click_element` | Find a DOM element by CSS selector and click it in one step. |
| 41 | `browser_eval` | Evaluate a JavaScript expression in a browser tab and return raw text. |
| 42 | `browser_get_dom` | Return the HTML of a DOM element or document.body, truncated to maxLength characters. |
| 43 | `browser_navigate` | Navigate a browser tab to a URL via CDP Page.navigate. |
| 44 | `browser_disconnect` | Close cached CDP WebSocket sessions for a port. |
| 45 | `browser_fill_input` | Fill a form input with a value via CDP — works on React/Vue/Svelte controlled inputs. |
| 46 | `browser_get_form` | Inspect all form fields within a container and return their name, type, id, value, and label text. |
| 47 | `clipboard_read` | Return the current text content of the Windows clipboard. |
| 48 | `clipboard_write` | Place text on the Windows clipboard. |
| 49 | `notification_show` | Show a Windows system tray balloon notification to alert the user. |
| 50 | `events_subscribe` | Subscribe to window-state change events (appear/disappear/focus) for continuous monitoring. |
| 51 | `events_poll` | Drain buffered events for a subscription with optional filtering by timestamp. |
| 52 | `events_unsubscribe` | Stop an events_subscribe subscription and free its buffer. |
| 53 | `events_list` | Return all active subscription IDs. |
| 54 | `perception_register` | Register a named perception lens that pins a specific HWND or browser tab identity. |
| 55 | `perception_read` | Force-refresh a registered perception lens and return a full perception envelope. |
| 56 | `perception_forget` | Deregister a perception lens and release its tracking resources. |
| 57 | `perception_list` | List all active perception lenses. |
| 58 | `engine_status` | Returns which backend engine is active for each subsystem (diagnostic metadata). |
