import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerScreenshotTools } from "./tools/screenshot.js";
import { registerMouseTools } from "./tools/mouse.js";
import { registerKeyboardTools } from "./tools/keyboard.js";
import { registerWindowTools } from "./tools/window.js";
import { registerUiElementTools } from "./tools/ui-elements.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerPinTools } from "./tools/pin.js";
import { registerMacroTools } from "./tools/macro.js";
import { registerScrollCaptureTools } from "./tools/scroll-capture.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerDockTools, autoDockFromEnv } from "./tools/dock.js";
import { registerWaitUntilTool } from "./tools/wait-until.js";
import { registerContextTools } from "./tools/context.js";
import { registerTerminalTools } from "./tools/terminal.js";
import { registerEventTools } from "./tools/events.js";
import { startTray, stopTray } from "./utils/tray.js";
import { checkFailsafe, FailsafeError } from "./utils/failsafe.js";

const server = new McpServer(
  { name: "desktop-touch", version: "0.1.0" },
  {
    instructions: [
      "# desktop-touch-mcp — Command Reference",
      "",
      "## Screenshot rules (mandatory)",
      "- DEFAULT detail is 'meta' (window positions only). Call screenshot() with no args for cheap orientation.",
      "- For UI interaction: screenshot(detail='text', windowTitle=X) → returns actionable[] with clickAt coords. No image.",
      "- After any action: screenshot(diffMode=true) → only changed windows sent (~160 tok).",
      "- For pixel-perfect coords: screenshot(dotByDot=true, windowTitle=X) → 1:1 WebP.",
      "- detail='image' is BLOCKED server-side unless confirmImage=true is passed. Only use when",
      "  visual inspection is genuinely required (e.g. text mode returned 0 actionable elements).",
      "- detail='text' auto-fires Windows OCR when actionable[]=[] OR hints.uiaSparse=true (ocrFallback='auto', default).",
      "  OCR items have source='ocr'. Disable with ocrFallback='never'. Force with ocrFallback='always'.",
      "- hints.winui3=true means WinUI3 app detected. hints.uiaSparse=true means UIA returned <5 elements.",
      "  hints.ocrFallbackFired=true means OCR was used to supplement UIA results.",
      "  hints.chromiumGuard=true means UIA was skipped for Chromium (direct OCR path).",
      "",
      "## Chrome / AWS console — data-reduction (use these to cut token cost 50-70%)",
      "- browser_* tools (CDP) are the FIRST choice when Chrome is the target — use over screenshot(dotByDot).",
      "- When CDP is unavailable, use this combo for minimal payload:",
      "    screenshot(dotByDot=true, dotByDotMaxDimension=1280, grayscale=true, windowTitle='Chrome',",
      "               region={x:0, y:120, width:1920, height:900})",
      "  Explanation: dotByDotMaxDimension caps to 1280px longest edge; grayscale cuts ~50%; region excludes browser chrome.",
      "  Adjust region.y to match your Chrome toolbar height (typically 80-130px).",
      "- detail='text' on Chromium skips UIA automatically (chromiumGuard) and goes straight to OCR — no 8s timeout.",
      "- When dotByDotMaxDimension is set, response includes: scale: N | screen_x = origin_x + image_x / scale",
      "  IMPORTANT: always use the scale formula for coord math, or clicks will land in the wrong position.",
      "",
      "## Coordinate rules",
      "- detail='text'       → actionable[].clickAt is already a screen coordinate. Pass directly to mouse_click.",
      "- dotByDot (1:1):     → screen_x = origin_x + image_x  (origin printed in response text)",
      "- dotByDot + scale:   → screen_x = origin_x + image_x / scale  (scale printed in response)",
      "- Default PNG (scaled)→ screen_x = window.x + image_x * (window.width / image.width)",
      "",
      "### PREFERRED: let mouse_click do the coord conversion",
      "- For dotByDot captures, copy origin/scale from screenshot response into mouse_click.",
      "  mouse_click(x=imageX, y=imageY, origin={x:ORIG_X, y:ORIG_Y}, scale=SCALE, windowTitle='...')",
      "- Server computes: screen = origin + (x,y) / (scale ?? 1). Eliminates manual math → eliminates off-by-one",
      "  and scale-factor bugs that cause clicks to land outside the target window.",
      "- If you ever see the cursor drift outside the app after a dotByDot screenshot, you likely did the math",
      "  manually and got it wrong — use the origin/scale params instead.",
      "",
      "## Standard automation loop",
      "workspace_snapshot() → screenshot(detail='text', windowTitle=X) → mouse_click(clickAt) / keyboard_type → screenshot(diffMode=true)",
      "",
      "## Japanese / IME input",
      "Always use keyboard_type(use_clipboard=true) when typing URLs, paths, or ASCII under a Japanese IME.",
      "Omitting this causes IME to convert characters incorrectly.",
      "",
      "## Window management",
      "get_windows() — list all windows in Z-order (zOrder 0 = frontmost).",
      "focus_window(title=X) — bring window to foreground.",
      "pin_window / unpin_window — always-on-top toggle.",
      "workspace_launch(command='calc.exe') — launch app, returns foundWindow with title/region.",
      "dock_window(title, corner='bottom-right', width=480, height=360, pin=true) — snap a window to a screen",
      "  corner and optionally pin it on top. Use to keep Claude CLI visible while operating other apps:",
      "    dock_window({ title: 'Claude Code', corner: 'bottom-right' })",
      "  Then unpin_window({ title: 'Claude Code' }) to release. Minimized windows are restored first.",
      "  Auto-dock on MCP startup — set env vars in your MCP client config to skip the manual call:",
      "    DESKTOP_TOUCH_DOCK_TITLE='@parent'      (auto-detect: walks up the process tree to find",
      "                                             the terminal window hosting Claude Code. Recommended.)",
      "    DESKTOP_TOUCH_DOCK_TITLE='Claude Code'  (alternative: title substring match)",
      "    (unset = feature off)",
      "    DESKTOP_TOUCH_DOCK_CORNER=bottom-right  (default bottom-right)",
      "    DESKTOP_TOUCH_DOCK_WIDTH=480 or '25%'   (px or ratio of work area)",
      "    DESKTOP_TOUCH_DOCK_HEIGHT=360 or '25%'",
      "    DESKTOP_TOUCH_DOCK_PIN=true             (default true)",
      "    DESKTOP_TOUCH_DOCK_MONITOR=0            (optional; default primary)",
      "    DESKTOP_TOUCH_DOCK_SCALE_DPI=true       (opt-in: multiply px values by dpi/96)",
      "",
      "## Mouse & keyboard",
      "mouse_move / mouse_click / mouse_drag / scroll — standard pointer ops.",
      "  speed param: 0=instant teleport, N=px/sec animation, omit=default (DESKTOP_TOUCH_MOUSE_SPEED env, default 1500).",
      "  homing param (default true): corrects stale coordinates if the window moved since the last screenshot.",
      "    Tier 1 (<1ms): auto-applies (dx,dy) offset from window-cache when window moved.",
      "    Tier 2 (~100ms): add windowTitle='...' hint → auto-focus window if it went behind another.",
      "    Tier 3 (1-3s):  add elementName/elementId + windowTitle → UIA re-query on resize.",
      "    homing=false: disable all correction (traction control OFF).",
      "  Recommended: always pass windowTitle when you know it. e.g. mouse_click(x, y, windowTitle='Notepad')",
      "keyboard_type(text, use_clipboard=false) — type text. Set use_clipboard=true under Japanese IME.",
      "keyboard_press(keys) — key combos ('ctrl+c', 'alt+f4', 'enter', etc.).",
      "",
      "### Input routing — CRITICAL when dock_window is pinned",
      "keyboard_type / keyboard_press send keystrokes to the CURRENTLY FOCUSED window,",
      "not to any specific app. When Claude CLI (or any other window) is pinned always-on-top",
      "via dock_window, it often steals focus before your keystrokes land — they end up",
      "typed into the CLI instead of the target app.",
      "  ALWAYS call focus_window(title='...') BEFORE keyboard_press/keyboard_type when",
      "  targeting a specific app. Verify with screenshot(detail='meta') — the target window",
      "  should have isActive=true.",
      "  Safe pattern: focus_window(X) → keyboard_press/keyboard_type → screenshot(diffMode=true)",
      "",
      "### focusLost detection (mouse_click / keyboard_type / keyboard_press / terminal_send)",
      "When a pinned window steals focus after an action, the response includes:",
      "  focusLost:{afterMs, expected, stolenBy, stolenByProcessName}",
      "This means keystrokes / clicks after this action may have missed the target.",
      "  → Retry with forceFocus:true, or call focus_window before the next action.",
      "  trackFocus:false to opt out (skips 300ms settle wait).",
      "",
      "### Force-Focus — AttachThreadInput opt-in",
      "mouse_click / keyboard_type / keyboard_press / terminal_send all accept forceFocus:boolean.",
      "  forceFocus:true — uses AttachThreadInput to bypass Windows foreground-stealing protection.",
      "  Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (set to '1' for global default true).",
      "  If force was refused: hints.warnings:['ForceFocusRefused'] appears in the response.",
      "  Use when dock_window is pinned and focus keeps being stolen by the CLI window.",
      "",
      "## UI Automation (UIA)",
      "get_ui_elements(windowTitle=X) — full UIA element tree for a window.",
      "click_element(windowTitle=X, name=N) — click button/control by name (no coordinates needed).",
      "set_element_value(windowTitle=X, name=N, value=V) — write to text field directly.",
      "scope_element(windowTitle=X, name=N) — high-res crop of element + child tree.",
      "",
      "## OCR fallback (WinUI3 / custom-drawn UIs)",
      "screenshot_ocr(windowTitle, language?, region?) — Windows.Media.Ocr: word-level text + clickAt coords.",
      "  Use when UIA returns 0 actionable (e.g. Paint brush strip, custom WinUI3 controls).",
      "  language: BCP-47 tag (default 'ja'). First call ~1s due to WinRT cold-start.",
      "  Requires matching Windows OCR language pack installed in Windows Settings.",
      "",
      "## Utilities",
      "get_screen_info() — monitor layout, DPI, cursor position.",
      "get_active_window() — focused window info.",
      "get_cursor_position() — current mouse coordinates.",
      "scroll_capture(windowTitle=X) — scroll-stitch a full-page screenshot (long pages/lists).",
      "screenshot_background(windowTitle=X) — capture a background window without focusing it.",
      "  fullContent=true (default): PW_RENDERFULLCONTENT — works for Chrome/Electron/WinUI3.",
      "  fullContent=false: legacy flag — use if call hangs on games or video players.",
      "",
      "## Browser automation via CDP (Chrome/Edge)",
      "browser_launch(browser?, url?)  — Launch debug-mode Chrome/Edge/Brave + wait for CDP. Idempotent if already running.",
      "browser_get_interactive(scope?) — List all links/buttons/inputs with selector+text. Use BEFORE clicking to avoid selector trial-and-error.",
      "  → ARIA-aware: also surfaces role=switch/checkbox/radio/tab/menuitem/option with state.{checked,pressed,selected,expanded}.",
      "  → Use when the page renders custom toggles (Radix, shadcn, MUI, Headless UI, GitHub) instead of native <input>.",
      "browser_get_app_state(selectors?, maxBytes=4000)",
      "  → One-call SPA state extractor. Scans __NEXT_DATA__ / __NUXT_DATA__ / __REMIX_CONTEXT__ / __APOLLO_STATE__ /",
      "    GitHub react-app embeddedData / JSON-LD / window.__INITIAL_STATE__. Returns {found:[{selector,framework,payload}],notFound:[]}.",
      "  → Use BEFORE browser_eval / browser_get_dom on SPAs where the rendered HTML is sparse but the state is rich.",
      "  → Override with selectors:['script#my-data','window:__MY_KEY__'].",
      "browser_connect(port?)          — Connect to Chrome/Edge; lists open tabs with active:true/false. Default port 9222.",
      "  → tabs[].active / top-level 'active': immediately shows which tab has focus — no guessing needed.",
      "browser_find_element(selector)  — CSS selector → exact screen coords (no SS scaling needed).",
      "browser_click_element(selector) — find + click in one step.",
      "browser_eval(expression)        — run JS in the page; returns result.",
      "browser_get_dom(selector?)      — get outerHTML of element or body.",
      "browser_navigate(url, waitForLoad=true, loadTimeoutMs=15000)",
      "  → waits for document.readyState==='complete' by default, returns title/url/readyState/elapsedMs.",
      "  → on timeout: ok:true + hints.warnings:['NavigateTimeout'] (not an error, page partially loaded).",
      "  → waitForLoad:false for legacy instant-return behavior.",
      "browser_disconnect(port?)       — close cached CDP WebSocket sessions.",
      "browser_eval, browser_find/click_element, browser_get_dom, browser_search, browser_get_interactive, browser_get_app_state",
      "  → appends activeTab:{id,title,url} + readyState:'complete' to successful responses (detect tab drift).",
      "  → includeContext:false skips those two trailing lines (saves ~150 tok/call when chaining in one tab).",
      "  → includeContext:true is still cheap: consecutive calls within 500ms share one internal getTabContext round-trip.",
      "",
      "## Param coercion for LLM-friendly spellings",
      "Boolean / object params accept the string spellings some MCP clients emit by accident:",
      "  boolean : 'true' / 'false' (case-insensitive, whitespace trimmed) / 0 / 1  → real boolean",
      "  object  : JSON-stringified object ('{}' or '{\"windowTitle\":\"x\"}')        → parsed before validation",
      "  Ambiguous input ('yes', arbitrary strings) is still rejected — prevents a typo from silently flipping a flag.",
      "",
      "## CDP setup",
      "browser_launch()                       — Auto-launch Chrome/Edge/Brave in debug mode; idempotent.",
      "browser_launch(browser='edge')         — Force a specific browser.",
      "browser_launch(url='https://...')      — Launch and navigate in one step.",
      "Manual (fallback): chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\tmp\\cdp",
      "",
      "## Virtual desktops (Windows 11)",
      "get_windows() shows isOnCurrentDesktop per window.",
      "Switch desktops: keyboard_press('ctrl+win+left') / keyboard_press('ctrl+win+right').",
      "New desktop: keyboard_press('ctrl+win+d')  |  Close: keyboard_press('ctrl+win+f4').",
      "",
      "## Browser UI shortcuts (more reliable than finding UI elements)",
      "Navigate:    browser_navigate(url)  — or: keyboard_press('ctrl+l') → keyboard_type(url) → keyboard_press('enter').",
      "Back/Fwd:   keyboard_press('alt+left') / keyboard_press('alt+right').",
      "New tab:    keyboard_press('ctrl+t').",
      "DevTools:   keyboard_press('f12').",
      "",
      "## Batching with run_macro",
      "Group sequential operations into a single run_macro call to eliminate API round-trips.",
      "Max 50 steps. Use sleep pseudo-command for waits (max 10000ms).",
      "",
      "## Wait — server-side polling (replaces screenshot loops)",
      "wait_until(condition, target, timeoutMs?, intervalMs?) — server polls until a condition is true.",
      "Conditions: window_appears | window_disappears | focus_changes | element_appears |",
      "            value_changes | ready_state | terminal_output_contains | element_matches.",
      "Returns elapsedMs + observed; on timeout returns code:'WaitTimeout' with suggest[].",
      "",
      "## Lightweight context (no screenshot needed)",
      "get_context()       — focusedWindow, cursorPos, hasModal, pageState (cheap, ~80 tok).",
      "get_history(n=5)    — last N action posts (tool, args digest, post-state, tsMs).",
      "get_document_state(port?, tabId?) — Chrome url/title/readyState/selection/scroll via CDP.",
      "",
      "## Action post-state (always-on narration)",
      "Action tools (click_element, set_element_value, keyboard_type/press, mouse_click/drag,",
      " browser_click_element/navigate/eval, terminal_send) include `post` in the response:",
      "  { focusedWindow, focusedElement, windowChanged, elapsedMs }",
      "Use this to skip confirmation screenshots after actions.",
      "",
      "## Identity tracking — detect process restarts",
      "screenshot(detail='text', windowTitle=…) responses include hints.target {hwnd,pid,processName,",
      " processStartTimeMs,titleResolved} and hints.caches {diffBaseline,uiaCache,windowLayout}.",
      "If hints.target.pid changes between calls → the app was restarted. Prior history is invalid.",
      "If hints.caches.diffBaseline.invalidatedBy === 'process_restarted' / 'hwnd_reused' → re-orient.",
      "",
      "## Terminal — read & write external terminal windows",
      "terminal_read(windowTitle, lines?, sinceMarker?, stripAnsi?, source?) — UIA TextPattern with OCR fallback.",
      "  Pass marker from previous response in sinceMarker for diff-only output.",
      "  hints.terminalMarker.invalidatedBy='process_restarted' on shell restart.",
      "terminal_send(windowTitle, input, pressEnter=true, focusFirst=true, restoreFocus=true, pasteKey='auto') — focus + type + restore.",
      "  pasteKey: 'auto' picks ctrl+shift+v for bash/wsl/mintty/alacritty/wezterm, ctrl+v elsewhere. Override with 'ctrl+v' / 'ctrl+shift+v'.",
      "screenshot(detail='text') on terminal hosts auto-uses TextPattern (hints.terminalGuard=true).",
      "Composite: macro [terminal_send → wait_until(terminal_output_contains) → terminal_read(sinceMarker)].",
      "",
      "## Browser search — grep DOM with confidence ranking",
      "browser_search(by, pattern, scope?, maxResults=50, offset=0, visibleOnly=true, inViewportOnly=false, caseSensitive=false)",
      "  by: 'text' | 'regex' | 'role' | 'ariaLabel' | 'selector'.",
      "  Returns results[] sorted by confidence desc — pass results[0].selector to browser_click_element.",
      "  Failure codes: BrowserSearchNoResults / BrowserSearchTimeout / ScopeNotFound (each with suggest[]).",
      "",
      "## Inter-turn events (window appearance / focus changes)",
      "events_subscribe(types) → subscriptionId.",
      "events_poll(subscriptionId, sinceMs?) → drains buffered events.",
      "events_unsubscribe(subscriptionId).",
      "Use at the start of a turn to detect what changed since the previous turn.",
      "",
      "## Confidence — comparable across UIA and OCR (0..1)",
      "actionable[].confidence is on the same scale for source:'uia' and source:'ocr'.",
      "  UIA: automationId=1.0 / Name exact=0.95 / substring=0.7 / class-only=0.5.",
      "  OCR: word=0.7 / single char=0.55 / control char=0.45 / replacement char=0.2 (suggests dotByDot retry).",
      "Sort actionable by confidence desc to pick the most reliable candidate.",
      "",
      "## Emergency stop (Failsafe)",
      "Move mouse to the top-left corner of the screen (within 10px of 0,0) to immediately terminate the MCP server.",
    ].join("\n"),
  }
);

// ─── Inject failsafe pre-check into every tool handler ───────────────────────
// Wraps server.tool so that checkFailsafe() runs before each handler,
// without touching individual tool files.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _originalTool = server.tool.bind(server) as (...args: any[]) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(server as any).tool = function (...toolArgs: any[]) {
  const lastIdx = toolArgs.length - 1;
  const originalHandler = toolArgs[lastIdx] as (...args: unknown[]) => Promise<unknown>;
  toolArgs[lastIdx] = async (...handlerArgs: unknown[]) => {
    await checkFailsafe();
    return originalHandler(...handlerArgs);
  };
  return _originalTool(...toolArgs);
};

registerScreenshotTools(server);
registerMouseTools(server);
registerKeyboardTools(server);
registerWindowTools(server);
registerUiElementTools(server);
registerWorkspaceTools(server);
registerPinTools(server);
registerMacroTools(server);
registerScrollCaptureTools(server);
registerBrowserTools(server);
registerDockTools(server);
registerWaitUntilTool(server);
registerContextTools(server);
registerTerminalTools(server);
registerEventTools(server);

// ─── Failsafe background monitor (backup for long-running operations) ─────────
// Primary check: per-tool call via the wrapper above.
// Backup: catches cases where a tool is mid-execution (e.g. long PowerShell call).
const failsafeTimer = setInterval(async () => {
  try {
    await checkFailsafe();
  } catch (err) {
    if (err instanceof FailsafeError) {
      console.error("[desktop-touch] FAILSAFE triggered: mouse at top-left corner. Exiting.");
      stopTray();
      process.exit(1);
    }
  }
}, 500);
failsafeTimer.unref(); // don't keep process alive for this alone

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(): void {
  console.error("[desktop-touch] Shutting down...");
  stopTray();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);

// Start tray icon (non-critical)
startTray();

// Connect MCP transport
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[desktop-touch] MCP server running (stdio)");

// Auto-dock CLI window if DESKTOP_TOUCH_DOCK_TITLE is set (opt-in).
// Detached so a missing window or poll timeout doesn't delay server readiness.
void autoDockFromEnv().catch((err) => {
  console.error("[desktop-touch] auto-dock error:", err);
});
