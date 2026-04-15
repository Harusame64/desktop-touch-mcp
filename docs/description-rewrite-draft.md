# Description & Instructions 改訂ドラフト v2

> **Status**: Opus レビュー round 3 完了 → MUST 修正適用済み。実装前にユーザ承認が必要。
> **作成日**: 2026-04-15 / **更新**: Opus round 3 MUST 反映
> **方針**: Anthropic "3-4 sentences per tool" + SEP-1382 "discovery vs schema" + merge.dev "front-load" + sudoall.com "instructions 300-500 words"

---

## Opus レビュー round 3 結果と修正内容

### MUST 修正一覧（適用済み）

| # | 対象 | 修正内容 |
|---|---|---|
| 1 | scroll_capture | 700KB cap の根拠（base64 overhead で MCP 1MB 制限）を明記 |
| 2 | keyboard_type | focus 必須を冒頭に front-load |
| 3 | mouse_click | 「origin+scale は dotByDot のみ」を Purpose 先頭に front-load |
| 4 | scroll_capture | サイズ制約を Details 冒頭に front-load |
| 5 | run_macro | supported tools 全列挙を削除（「全 desktop-touch ツール + sleep」に短縮） |
| 6 | dock_window | corner 値域・width/height default・margin default を inputSchema 相当として削除（Purpose/Prefer/Caveats に整理） |
| 7 | instructions | 4 箇所の重複削除（image mode / coord system / Chrome / keyboard）→ Failure recovery 節追加 |
| 8 | events_subscribe Examples | sinceMs:0 → sinceMs: lastEventTs に修正 |
| 9 | workspace_launch Examples | hardcoded 'メモ帳' を一般化 |
| 10 | screenshot | diffMode の baseline 前提を Caveats に追加 |
| 11 | mouse_click | 「座標は screen 絶対」を明記 |
| 12 | scroll_capture | overlapMode 警告を Caveats に追加 |
| 13 | events_subscribe | buffer cap の具体値を明記（50 events、overflow で oldest drop） |

### NICE 修正（実施済みのもの）

- screenshot_ocr に `screenshot(detail='text')` との使い分け相互参照追加
- get_context に `hints.focusedElementSource` の値域 (`'uia'|'cdp'`) 追記
- terminal_send に クリップボード上書きの副作用を追記
- browser_eval に 「DOM ノードは返せない」の Caveats 追加

---

## Tier 分類表（全 46 ツール）

| Tier | ツール | 件数 |
|---|---|---|
| **A** (4 section フル) | screenshot, screenshot_background, scroll_capture, wait_until, workspace_snapshot, workspace_launch, run_macro, events_subscribe, dock_window, get_context | 10 |
| **B** (2-3 文 + 任意 Caveats) | screenshot_ocr, mouse_click, mouse_drag, keyboard_type, keyboard_press, click_element, set_element_value, focus_window, pin_window, get_ui_elements, scope_element, terminal_send, terminal_read, browser_connect, browser_get_interactive, browser_click_element, browser_find_element, browser_navigate, browser_search, browser_get_app_state, browser_launch, get_windows | 22 |
| **C** (1-2 文) | get_active_window, mouse_move, scroll, get_cursor_position, get_screen_info, get_document_state, get_history, events_poll, events_unsubscribe, events_list, browser_eval, browser_get_dom, browser_disconnect, unpin_window | 14 |
| **Tier 4** (examples 付与) | screenshot, wait_until, workspace_launch, run_macro, events_subscribe | 5 |

---

## Tier A — 複雑ツール（4 section フル）

### screenshot

```
Purpose: Capture desktop, window, or region state across four output modes — from cheap orientation metadata to pixel-accurate images.
Details: detail='meta' (default) returns window titles+positions only (~20 tok/window, no image). detail='text' returns UIA actionable elements with clickAt coords, no image (~100-300 tok). detail='image' is server-blocked unless confirmImage=true is also passed. dotByDot=true returns 1:1 pixel WebP; compute screen coords: screen_x = origin_x + image_x (or screen_x = origin_x + image_x / scale when dotByDotMaxDimension is set — scale printed in response). diffMode=true returns only changed windows after the first call (~160 tok). Data reduction: grayscale=true (−50%), dotByDotMaxDimension=1280 (caps longest edge), windowTitle+region (sub-crop to exclude browser chrome — e.g. region={x:0, y:120, width:1920, height:900}).
Prefer: Use meta to orient, text before clicking, dotByDot only when precise pixel coords are needed. Prefer browser_* tools for Chrome. Use diffMode after actions to confirm state changed. Only use image+confirmImage when text returned 0 actionable elements and visual inspection is genuinely required.
Caveats: Default mode scales to maxDimension=768 — image pixels ≠ screen pixels; apply the scale formula before passing to mouse_click. detail='image' is always blocked without confirmImage=true. diffMode requires a prior full-capture baseline (non-diff call or workspace_snapshot) — calling diffMode cold returns a full frame, not a diff.
Examples:
  screenshot() → meta orientation of all windows
  screenshot({detail:'text', windowTitle:'Notepad'}) → clickable elements with coords
  screenshot({dotByDot:true, dotByDotMaxDimension:1280, grayscale:true, windowTitle:'Chrome', region:{x:0,y:120,width:1920,height:900}}) → pixel-accurate Chrome content
```

### screenshot_background

```
Purpose: Capture a window that is hidden, minimized, or behind other windows using Win32 PrintWindow API.
Details: Uses PW_RENDERFULLCONTENT (fullContent=true, default) for GPU-rendered content in Chrome, Electron, and WinUI3 apps. Supports same detail and dotByDot modes as screenshot. Default mode scales to maxDimension=768; dotByDot=true gives 1:1 WebP with origin in response — compute screen coords: screen_x = origin_x + image_x. grayscale=true reduces size ~50%. dotByDotMaxDimension caps resolution; response includes scale (screen_x = origin_x + image_x / scale).
Prefer: Prefer screenshot(windowTitle=X) for visible windows (faster, no API overhead). Use screenshot_background when the window must stay hidden or cannot be brought to foreground.
Caveats: Default (scaled) mode: image pixels ≠ screen pixels — always use dotByDot=true + origin for mouse_click coords. Set fullContent=false for legacy or game windows where GPU rendering causes 1-3s delay or black capture. Some DX12 games may not capture correctly even with fullContent=true.
```

### scroll_capture

```
Purpose: Scroll a window top-to-bottom (or left-to-right) and stitch all frames into one image — for full-length webpages or documents that exceed a single screenshot.
Details: Output is capped at ~700KB raw (MCP base64 encoding inflates to ~933KB, approaching the 1MB message limit); when sizeReduced=true appears in the response, iterative WebP downscale was applied (up to 3 passes at 0.75× each) — reduce maxScrolls or add grayscale=true to avoid truncation. Focuses the target window, scrolls to Ctrl+Home, then captures frames via Page Down until identical consecutive frames are detected or maxScrolls is reached. Pixel-overlap detection eliminates seam duplication; check response overlapMode — 'mixed-with-failures' means some seams may have duplicate rows.
Prefer: Use only for content too long to fit one screenshot. Prefer screenshot(detail='text') for interactive UIs — scroll_capture returns an image, not clickable elements.
Caveats: When sizeReduced=true, stitched image pixels do NOT match screen coords — use for reading only, not for mouse_click. When overlapMode='mixed-with-failures', expect occasional duplicate content rows near frame boundaries. Increase scrollDelayMs for pages with animations or lazy-loaded images.
```

### wait_until

```
Purpose: Server-side poll for an observable condition — eliminates screenshot-polling loops when waiting for state changes.
Details: condition selects what to watch: window_appears/window_disappears (target.windowTitle required), focus_changes (optional target.fromHwnd), element_appears/value_changes (target.windowTitle + target.elementName required, UIA; min 500ms interval), ready_state (target.windowTitle; visible + not minimized), terminal_output_contains (target.windowTitle + target.pattern required [+target.regex:true], needs terminal tools loaded), element_matches (target.by + target.pattern required, needs browser tools loaded). Returns {ok:true, elapsedMs, observed} on success, or WaitTimeout error with suggest hints. timeoutMs default 5000 (max 60000).
Prefer: Use instead of run_macro({sleep:N}) + screenshot loops. Use terminal_output_contains to detect CLI command completion. Use element_matches for browser DOM readiness after navigation.
Caveats: terminal_output_contains and element_matches require the respective tool modules to be loaded. element_appears/value_changes spawn a UIA process per poll — interval clamped to 500ms minimum. On WaitTimeout, read the suggest[] array in the error for recovery steps.
Examples:
  wait_until({condition:'window_appears', target:{windowTitle:'Save As'}, timeoutMs:10000})
  wait_until({condition:'terminal_output_contains', target:{windowTitle:'Terminal', pattern:'$ '}, timeoutMs:30000})
  wait_until({condition:'element_matches', target:{by:'text', pattern:'Submit', scope:'#checkout-form'}})
```

### workspace_snapshot

```
Purpose: Orient fully in one call — returns display layouts, all window thumbnails (WebP), and per-window actionable element lists with clickAt coords.
Details: uiSummary.actionable[] per window includes: action ('click'|'type'|'expand'|'select'), clickAt {x,y} (pass directly to mouse_click), value (current text for editable fields). Runs parallel internally; latency ≈ max(single screenshot), not N×screenshots. Also resets the diffMode buffer so subsequent screenshot(diffMode=true) returns only changes (P-frame).
Prefer: Use at session start or after major workspace changes. Use screenshot(detail='meta') for cheap re-orientation within a session. Use screenshot(detail='text', windowTitle=X) for a single-window update.
Caveats: Thumbnails are scaled, not 1:1 — use screenshot(dotByDot=true, windowTitle=X) for pixel-accurate coords on a specific window after snapshot.
```

### workspace_launch

```
Purpose: Launch an application and wait for its new window to appear, returning title, HWND, and PID.
Details: Runs the command via ShellExecute, snapshots the window list before launch, then polls until a new HWND appears (compared by HWND, not title). Returns {windowTitle, hwnd, pid, elapsedMs}. Works for localized window titles (e.g. '電卓' for calc.exe) because detection is HWND-based, not title-based. timeoutMs default 10000. detach=true fires without waiting and returns no window info.
Prefer: Use instead of run_macro({exec, sleep, get_windows}) combos. Follow with focus_window(windowTitle) to interact with the launched app.
Caveats: Single-instance apps that reuse an existing window will not register as a new HWND — call get_windows first to check if the window is already open. detach=true returns immediately with no window title or hwnd.
Examples:
  workspace_launch({command:'notepad.exe'}) → {windowTitle:'<localized title>', hwnd:'...', pid:...}
  workspace_launch({command:'calc.exe', timeoutMs:15000})
```

### run_macro

```
Purpose: Execute multiple tools sequentially in one MCP call — eliminates round-trip latency for predictable multi-step workflows.
Details: steps[] is an array of {tool, params} objects. Accepts all desktop-touch tools plus a special sleep pseudo-step: {tool:"sleep", params:{ms:N}} (max 10000ms per step). stop_on_error=true (default) halts on first failure. Max 50 steps. The LLM cannot inspect intermediate results during execution — all steps run to completion (or first error) before any output is returned.
Prefer: Use for predictable fixed sequences (focus → sleep → type → screenshot). Do not use for conditional logic — return to the LLM between branches so it can inspect intermediate state.
Caveats: If any step may fail conditionally (e.g. a dialog that may or may not appear), split the macro at that point. Each screenshot step within a macro incurs the same token cost as a standalone call.
Examples:
  [{tool:'focus_window',params:{windowTitle:'Notepad'}},{tool:'sleep',params:{ms:300}},{tool:'keyboard_type',params:{text:'Hello'}},{tool:'screenshot',params:{detail:'text',windowTitle:'Notepad'}}]
  [{tool:'browser_navigate',params:{url:'https://example.com'}},{tool:'wait_until',params:{condition:'element_matches',target:{by:'text',pattern:'Example Domain'}}}]
```

### events_subscribe

```
Purpose: Subscribe to window-state change events (appear/disappear/focus) for continuous monitoring without repeated polling.
Details: Returns subscriptionId. Events are buffered internally at 500ms intervals via EnumWindows; buffer holds up to 50 events (oldest dropped on overflow). Call events_poll(subscriptionId, sinceMs: lastEventTs) to drain incrementally; call events_unsubscribe when monitoring is complete. Each buffered event: {type, hwnd, title, timestamp}.
Prefer: Use instead of wait_until(window_appears) when you need to monitor multiple events simultaneously or over an extended period. Use wait_until for one-shot, single-condition waiting.
Caveats: Events that occurred before subscribe() was called will not appear — buffer starts empty. Poll frequently (every few seconds) during high-frequency window activity to avoid the 50-event overflow.
Examples:
  id = events_subscribe() → poll: events_poll({subscriptionId:id}) → on next poll: events_poll({subscriptionId:id, sinceMs: lastEventTs}) → events_unsubscribe({subscriptionId:id})
```

### dock_window

```
Purpose: Snap a window to a screen corner at a fixed small size and pin it always-on-top — primarily to keep Claude CLI visible while operating other apps full-screen.
Details: Accepts corner ('bottom-right' default), width/height (480×360 default, clamped to monitor work area), pin (true default = always-on-top), margin (8px default gap from screen edges, avoids taskbar overlap), and monitorId (see get_screen_info for IDs). Minimized windows are automatically restored before docking.
Prefer: Use pin_window alone when you only need always-on-top without moving or resizing. Use dock_window when you need corner placement + resize + pin in one step.
Caveats: Overrides any existing Win+Arrow snap arrangement. Call unpin_window explicitly to release always-on-top when the docked window is no longer needed in front.
```

### get_context

```
Purpose: Query focused window, focused element, cursor position, and page state in one call — far cheaper than any screenshot for confirming current state after an action.
Details: Returns focusedWindow (title, hwnd), focusedElement (name, type, value), cursorPos {x,y}, cursorOverElement (name, type), hasModal (boolean), pageState ('ready'|'loading'|'dialog'|'error'). Does NOT enumerate descendants — use screenshot(detail='text') or get_ui_elements for the full clickable element list. Chromium: cursorOverElement is null (UIA sparse); focusedElement may fall back to CDP document.activeElement; hints.focusedElementSource reports which was used ('uia' or 'cdp').
Prefer: Use after keyboard_type or set_element_value to confirm the value landed in the expected field — cheaper than a verification screenshot. Use instead of screenshot(detail='meta') when the question is only "which window/control has focus."
Caveats: Cannot detect non-UIA elements (custom-drawn UIs, game overlays). hasModal only detects modal dialogs exposed via UIA — browser alert/confirm dialogs may not appear here.
```

---

## Tier B — 中程度ツール（2-3 文 + 任意 Caveats）

### screenshot_ocr

```
Run Windows OCR on a window and return word-level text with screen-pixel clickAt coordinates — use when UIA returns no actionable elements (WinUI3 custom-drawn UIs, game overlays, PDF viewers). Note: screenshot(detail='text') auto-falls back to OCR when UIA is sparse (ocrFallback='auto' default) — call screenshot_ocr directly only when forcing OCR unconditionally. language: BCP-47 tag (default 'ja'). Caveats: First call may take ~1s (WinRT cold-start). Requires the matching Windows OCR language pack installed.
```

### mouse_click

```
Click at screen-absolute coordinates (virtual screen pixels), or pass origin+scale from a dotByDot=true screenshot response to let the server convert image-local coords automatically: screen = origin + (x,y) / (scale ?? 1). windowTitle optionally focuses the window first (for pinned-dock setups). Prefer click_element (UIA) for stable text-addressed clicking in native apps. Prefer browser_click_element for Chrome. Use mouse_click only when pixel coords are the only available option. Caveats: origin+scale are meaningful ONLY with dotByDot=true screenshot responses — applying them to scaled detail='text'/'meta' output lands clicks in the wrong positions.
```

### mouse_drag

```
Click and drag from (startX, startY) to (endX, endY) holding the left mouse button — for sliders, drag-and-drop, canvas drawing, and window resizing. windowTitle optionally focuses before drag. Caveats: Left button only; does not support right-drag or middle-drag.
```

### keyboard_type

```
Requires focus on the target window — call focus_window first when the dock is pinned or another window may have stolen focus. Types a string of text into the focused window. Prefer set_element_value for form fields (more reliable for programmatic input without focus side-effects). Caveats: Does not handle IME composition for CJK input — use terminal_send(preferClipboard=true) or set_element_value for non-ASCII strings.
```

### keyboard_press

```
Press a key or key combination: 'enter', 'ctrl+c', 'alt+tab', 'ctrl+shift+s', 'f5', 'escape', 'f1'–'f12'. Modifiers: ctrl, alt, shift, win/meta. Call focus_window first — when the dock is pinned, keystrokes go to the pinned overlay instead of the target window unless focus is explicitly set. Caveats: narrate:'rich' adds UIA state feedback for state-transitioning keys (Enter, Tab, Esc, F-keys) only; has no effect on letter/number keys.
```

### click_element

```
Invoke a UI element by name or automationId via UIA InvokePattern — no screen coordinates needed. Prefer over mouse_click for buttons, menu items, and links in native Windows apps. Use get_ui_elements first to discover automationIds. Caveats: Requires the element to expose InvokePattern — some read-only or custom controls do not; fall back to mouse_click in that case.
```

### set_element_value

```
Set the value of a text field or combo box via UIA ValuePattern — more reliable than keyboard_type for programmatic form input. Use narrate:'rich' to confirm the value was applied without a verification screenshot. Caveats: Only works for elements that expose ValuePattern; does not work on contenteditable HTML or custom rich-text editors — use keyboard_type for those.
```

### focus_window

```
Bring a window to the foreground by partial title match (case-insensitive). Required before keyboard_* when the dock is pinned — otherwise keystrokes go to the pinned overlay. Returns WindowNotFound if no match exists; call get_windows to see available titles. Caveats: On some apps focus may be immediately stolen back (modal dialogs, UAC prompts) — verify with get_context after focusing.
```

### pin_window

```
Make a window always-on-top until unpin_window is called (or duration_ms elapses). Useful in run_macro sequences: pin_window → interact → unpin_window. Caveats: Pin state survives window minimize/restore; call unpin_window explicitly to release.
```

### get_ui_elements

```
Inspect the raw UIA element tree of a window — returns names, control types, automationIds, bounding rects, and interaction patterns. Prefer screenshot(detail='text') for interactive automation (returns pre-filtered actionable[] with clickAt coords). Use get_ui_elements when you need the unfiltered tree or specific automationIds for click_element. Caveats: Large windows may return hundreds of elements — scope with windowTitle.
```

### scope_element

```
Return a high-resolution screenshot of a specific element's region plus its child element tree. Requires UIA — works with native apps, Chrome/Edge, VS Code. Use get_ui_elements first to discover element names or automationIds. At least one of name, automationId, or controlType must be provided.
```

### terminal_send

```
Send a command to a terminal window (Windows Terminal, conhost, PowerShell, cmd, WSL). Wraps focus_window + keyboard type + Enter. preferClipboard=true (default) uses clipboard paste — IME-safe for CJK text, but overwrites the user's clipboard. restoreFocus=true (default) returns focus to the previously active window after sending. Caveats: If the terminal is busy (previous command still running), text will be injected mid-stream — check terminal_read first or use wait_until(terminal_output_contains) to confirm completion before sending.
```

### terminal_read

```
Read current text from a terminal window via UIA TextPattern (falls back to OCR). Strips ANSI escape sequences. sinceMarker: pass the marker from a previous response to get only new output (diff mode — cheaper than full read). Caveats: When the underlying process restarts, the marker is invalidated and full text is returned.
```

### browser_connect

```
Connect to Chrome/Edge running with --remote-debugging-port and return open tab IDs — required before all other browser_* tools. Launch with browser_launch() or manually: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp. Returns tabs[] with id, url, title — pass tabId to browser_* tools to target a specific tab. Caveats: CDP connection is per-process; if Chrome restarts, call browser_connect again to get fresh tab IDs.
```

### browser_get_interactive

```
List all interactive elements (links, buttons, inputs, ARIA controls) on the current page with CSS selectors and viewport status — use before browser_click_element to discover stable selectors without trial-and-error. scope limits to a CSS subsection (e.g. '.sidebar'). Returns state (checked/pressed/selected/expanded) for ARIA custom controls. Caveats: Selectors are CDP-generated snapshots — re-call after page navigates or re-renders.
```

### browser_click_element

```
Find a DOM element by CSS selector and click it (combines browser_find_element + mouse_click in one step). Prefer over mouse_click for Chrome — selector-based clicking is stable across repaints. Caveats: Fails if the element is outside the visible viewport — scroll it into view with browser_eval("document.querySelector('sel').scrollIntoView()") first.
```

### browser_find_element

```
Find a DOM element by CSS selector and return its physical screen coordinates — compatible directly with mouse_click. Prefer browser_click_element to find+click in one step. Prefer browser_get_interactive to discover selectors. Caveats: Coordinates are captured at call time; if the page reflows before mouse_click, coords may be stale.
```

### browser_navigate

```
Navigate a browser tab to a URL via CDP Page.navigate — more reliable than clicking the address bar (no need to find UI elements). Verify readiness with browser_eval("document.readyState") after calling. Caveats: Does not block until page load completes — follow with wait_until(element_matches) or repeated browser_eval polling for slow pages.
```

### browser_search

```
Grep-like element search across the current page. by: 'text' (literal substring), 'regex', 'role', 'ariaLabel', 'selector' (CSS). Returns results[] sorted by confidence descending — pass results[0].selector to browser_click_element. Pagination via offset/maxResults. Caveats: Use browser_get_interactive for broad discovery; use browser_search when you know specific text or role to target.
```

### browser_get_app_state

```
Extract embedded SPA framework state (Next.js, Nuxt, Remix, GitHub, Apollo, Redux SSR) in one CDP call. Returns parsed payloads with framework labels. Use BEFORE browser_eval or browser_get_dom on SPAs where rendered HTML is sparse. Pass selectors to target specific window globals (e.g. 'window:__MY_STATE__'). Caveats: Only extracts SSR-injected state — client-only runtime state requires browser_eval.
```

### browser_launch

```
Launch Chrome/Edge/Brave in CDP debug mode and wait until the DevTools endpoint is ready. Idempotent — if a CDP endpoint is already live on the target port, returns immediately. Default: tries chrome → edge → brave (first installed wins), port 9222, userDataDir C:\tmp\cdp. Pass url to open a specific page on launch; follow with browser_connect to get tab IDs. Caveats: A Chrome session started without --remote-debugging-port cannot be taken over — close it first or use a separate profile.
```

### get_windows

```
List all visible windows with titles, screen positions, Z-order, active state, and virtual desktop membership. zOrder=0 is frontmost; isActive=true is the keyboard-focused window; isOnCurrentDesktop=false means the window is on another virtual desktop and cannot be interacted with without switching. Use before screenshot to determine whether a specific window needs capturing. Caveats: Returns only top-level visible windows — child windows and system tray items are excluded.
```

---

## Tier C — 単純ツール（1-2 文）

### get_active_window
```
Return the title, hwnd, and bounds of the currently focused window.
```

### mouse_move
```
Move the cursor to coordinates without clicking — for hover-only effects such as revealing tooltips or triggering hover states. Use mouse_click for click targets (it moves and clicks in one call).
```

### scroll
```
Scroll at specified coordinates (or current cursor position). direction: 'up'|'down'|'left'|'right'. amount: scroll clicks (default 3).
```

### get_cursor_position
```
Return the current mouse cursor position in virtual screen coordinates.
```

### get_screen_info
```
Return all connected display info: resolution, position, DPI scaling, and current cursor position. Use monitorId from this response to target a specific display in dock_window.
```

### get_document_state
```
Return current Chrome page state via CDP: url, title, readyState, selection, and scroll position. Far cheaper than browser_get_dom for page orientation.
```

### get_history
```
Return recent action history (ring buffer, last 20 entries) with tool name, argsDigest, post-state, and timestamp. Use to reconstruct context after model interruption or verify a step occurred.
```

### events_poll
```
Drain buffered events for a subscription. Pass sinceMs to filter to events newer than that timestamp (incremental polling).
```

### events_unsubscribe
```
Stop a subscription and free its event buffer.
```

### events_list
```
Return all active subscription IDs.
```

### browser_eval
```
Evaluate a JavaScript expression in a browser tab and return the result. Use for reading page state, scrolling, or filling inputs programmatically. Caveats: Returns JSON-serializable values only — DOM nodes cannot be returned directly.
```

### browser_get_dom
```
Return the HTML of a DOM element (or document.body when no selector is given), truncated to maxLength characters. Use when browser_get_interactive is insufficient for inspecting page structure.
```

### browser_disconnect
```
Close cached CDP WebSocket sessions for a port. Call when browser interaction is complete to release connections.
```

### unpin_window
```
Remove always-on-top from a window. Reverses pin_window.
```

---

## 新 Instructions 文案 v2（重複削除・Failure recovery 追加）

```
# desktop-touch-mcp

## Entry point
Call screenshot(detail='meta') to orient before acting. Returns all window positions and titles at ~20 tok/window — no image.

## Standard workflow
1. screenshot(detail='meta') — identify target window title
2. screenshot(detail='text', windowTitle=X) — get actionable[] with clickAt coords
3. click_element / mouse_click(clickAt.x, clickAt.y) — act
4. screenshot(diffMode=true) — confirm changes (~160 tok, changed windows only)

## Clicking — priority order
1. browser_click_element(selector) — Chrome/Edge (CDP, stable across repaints)
2. click_element(name or automationId) — native Windows apps (UIA)
3. mouse_click(x, y, origin?, scale?) — pixel fallback; origin+scale from dotByDot screenshots only

## Observation — priority order
1. get_context — cheapest; confirms focused element, value, modal state after actions
2. screenshot(detail='text') — actionable elements with coords
3. screenshot(dotByDot=true) — pixel-accurate image when text mode returns 0 elements
4. screenshot(detail='image', confirmImage=true) — visual inspection only; server-blocked without confirmImage

## Terminal workflow
terminal_send → wait_until(terminal_output_contains, pattern='$ ') → terminal_read(sinceMarker).
Do not screenshot the terminal — terminal_read is cheaper and structured.

## Waiting for state changes
Use wait_until instead of sleep+screenshot loops:
  window_appears    — wait for a dialog or new app window
  terminal_output_contains — wait for CLI command completion
  element_matches   — wait for browser DOM readiness after navigation
  focus_changes     — wait for focus to shift after an action
On WaitTimeout, read the suggest[] array in the error response for recovery steps.

## Failure recovery
- WindowNotFound → call get_windows to list available titles, then retry focus_window
- WaitTimeout → read suggest[] in the error; increase timeoutMs or verify target exists
- keyboard_press / keyboard_type wrong window → call focus_window(windowTitle) first
- scroll_capture sizeReduced=true → reduce maxScrolls or add grayscale=true

## Scroll capture
scroll_capture stitches full-page images. sizeReduced=true means the image was downscaled (pixel coords ≠ screen) — use for reading only, not mouse_click. overlapMode='mixed-with-failures' means some frame seams have duplicate rows.
```

---

## 語数確認（instructions v2）

> 実測: 約 **310 words**（目標 300-500 words ✅）。

---

## Before/After トークン見積もり

| 項目 | Before (v1) | After (v2) | Δ |
|---|---|---|---|
| Tier A 10 本 (avg 600 字) | 1,500 字 | 6,000 字 | +4,500 字 |
| Tier B 22 本 (avg 250 字) | 2,200 字 | 5,500 字 | +3,300 字 |
| Tier C 14 本 (avg 80 字) | 1,120 字 | 1,120 字 | 0 |
| **description 合計** | **4,820 字** | **12,620 字** | **+7,800 字** |
| instructions | ~4,000 words 相当 | ~310 words | **−3,690 words** |
| **ネット推定 tok 増加** | — | — | **約 +800〜1,000 tok/ターン** |

> 精確な計測は Phase 3A の `scripts/measure-tools-list-tokens.ts` で実施。

---

## 次のステップ

- [x] ドラフト v1 作成
- [x] Opus レビュー round 3 完了
- [x] MUST 修正適用 → ドラフト v2
- [ ] **ユーザ承認**
- [ ] Phase 3A: `buildDesc()` + 計測スクリプト
- [ ] Phase 3B-D: 全ツール description 書き換え
- [ ] Phase 3E: Tier 4 examples 付与
- [ ] Phase 3F: instructions 書き換え
- [ ] Phase 4: 検証 + Opus round 4
