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
      "- detail='text' auto-fires Windows OCR when actionable[]=[] (ocrFallback='auto', default).",
      "  OCR items have source='ocr'. Disable with ocrFallback='never'. Force with ocrFallback='always'.",
      "- hints.winui3=true means WinUI3 app detected. hints.uiaSparse=true means UIA returned <5 elements.",
      "  hints.ocrFallbackFired=true means OCR was used to supplement UIA results.",
      "",
      "## Coordinate rules",
      "- detail='text'  → actionable[].clickAt is already a screen coordinate. Pass directly to mouse_click.",
      "- dotByDot=true  → screen_x = origin_x + image_x  (origin printed in response text)",
      "- Default PNG    → screen_x = window.x + image_x * (window.width / image.width)",
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
      "",
      "## Mouse & keyboard",
      "mouse_move / mouse_click / mouse_drag / scroll — standard pointer ops.",
      "  speed param: 0=instant teleport, N=px/sec animation, omit=default (DESKTOP_TOUCH_MOUSE_SPEED env, default 1500).",
      "  homing param (default true): corrects stale coordinates if the window moved since the last screenshot.",
      "    Tier 1 (<1ms): auto-applies (dx,dy) offset from window-cache when window moved.",
      "    Tier 2 (~100ms): add windowTitle='...' hint → auto-focus window if it went behind another.",
      "    Tier 3 (1-3s):  add elementName/elementId + windowTitle → UIA re-query on resize.",
      "    homing=false: disable all correction (traction control OFF).",
      "  Recommended: always pass windowTitle when you know it. e.g. mouse_click(x, y, windowTitle='メモ帳')",
      "keyboard_type(text, use_clipboard=false) — type text. Set use_clipboard=true under Japanese IME.",
      "keyboard_press(keys) — key combos ('ctrl+c', 'alt+f4', 'enter', etc.).",
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
      "browser_connect(port?)          — Connect to Chrome/Edge; lists open tabs. Default port 9222.",
      "browser_find_element(selector)  — CSS selector → exact screen coords (no SS scaling needed).",
      "browser_click_element(selector) — find + click in one step.",
      "browser_eval(expression)        — run JS in the page; returns result.",
      "browser_get_dom(selector?)      — get outerHTML of element or body.",
      "browser_navigate(url)           — CDP Page.navigate; no address bar interaction needed.",
      "browser_disconnect(port?)       — close cached CDP WebSocket sessions.",
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
