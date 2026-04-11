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
import { startTray, stopTray } from "./utils/tray.js";
import { checkFailsafe, FailsafeError } from "./utils/failsafe.js";

const server = new McpServer(
  { name: "desktop-touch", version: "0.1.0" },
  {
    instructions: [
      "# desktop-touch-mcp — Command Reference",
      "",
      "## Data retrieval priority (minimize token usage)",
      "1. workspace_snapshot()                      — Start of session or full orientation needed.",
      "2. screenshot(detail='text', windowTitle=X)  — UI interaction: returns actionable[] with clickAt coords. No image.",
      "3. screenshot(diffMode=true)                 — Post-action check: only changed windows sent (~160 tok).",
      "4. screenshot(dotByDot=true, windowTitle=X)  — When pixel-perfect coords are needed (1:1 WebP).",
      "5. screenshot(detail='image')                — Visual check only. Heaviest option; avoid unless necessary.",
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
      "keyboard_type(text, use_clipboard=false) — type text. Set use_clipboard=true under Japanese IME.",
      "keyboard_press(keys) — key combos ('ctrl+c', 'alt+f4', 'enter', etc.).",
      "",
      "## UI Automation (UIA)",
      "get_ui_elements(windowTitle=X) — full UIA element tree for a window.",
      "click_element(windowTitle=X, name=N) — click button/control by name (no coordinates needed).",
      "set_element_value(windowTitle=X, name=N, value=V) — write to text field directly.",
      "scope_element(windowTitle=X, name=N) — high-res crop of element + child tree.",
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
