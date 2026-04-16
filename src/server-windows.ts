import { createServer, type Server as HttpServer } from "node:http";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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
import { registerClipboardTools } from "./tools/clipboard.js";
import { registerNotificationTools } from "./tools/notification.js";
import { registerScrollToElementTools } from "./tools/scroll-to-element.js";
import { registerSmartScrollTools } from "./tools/smart-scroll.js";
import { registerPerceptionTools } from "./tools/perception.js";
import { registerPerceptionResources } from "./tools/perception-resources.js";
import { stopNativeRuntime } from "./engine/perception/registry.js";
import { startTray, stopTray, type TrayOptions } from "./utils/tray.js";
import { checkFailsafe, FailsafeError } from "./utils/failsafe.js";
import { SERVER_VERSION } from "./version.js";

// Resolve assets/icons directory (works both in dev: dist/ and release: dist/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const icoDir = join(__dirname, "..", "assets", "icons");
const icoOk = existsSync(join(icoDir, "tray_ok.ico")) ? join(icoDir, "tray_ok.ico") : undefined;

const server = new McpServer(
  { name: "desktop-touch", version: SERVER_VERSION },
  {
    instructions: [
      "# desktop-touch-mcp",
      "",
      "## Entry point",
      "Call screenshot(detail='meta') to orient before acting. Returns all window positions and titles at ~20 tok/window — no image.",
      "",
      "## Standard workflow",
      "1. screenshot(detail='meta') — identify target window title",
      "2. screenshot(detail='text', windowTitle=X) — get actionable[] with clickAt coords",
      "3. click_element / mouse_click(clickAt.x, clickAt.y) — act",
      "4. screenshot(diffMode=true) — confirm changes (~160 tok, changed windows only)",
      "",
      "## Clicking — priority order",
      "1. browser_click_element(selector) — Chrome/Edge (CDP, stable across repaints)",
      "2. click_element(name or automationId) — native Windows apps (UIA)",
      "3. mouse_click(x, y, origin?, scale?) — pixel fallback; origin+scale from dotByDot screenshots only",
      "",
      "## Observation — priority order",
      "1. get_context — cheapest; confirms focused element, value, modal state after actions",
      "2. screenshot(detail='text') — actionable elements with coords",
      "3. screenshot(dotByDot=true) — pixel-accurate image when text mode returns 0 elements",
      "4. screenshot(detail='image', confirmImage=true) — visual inspection only; server-blocked without confirmImage",
      "",
      "## Terminal workflow",
      "terminal_send → wait_until(terminal_output_contains, pattern='$ ') → terminal_read(sinceMarker).",
      "Do not screenshot the terminal — terminal_read is cheaper and structured.",
      "",
      "## Waiting for state changes",
      "Use wait_until instead of sleep+screenshot loops:",
      "  window_appears    — wait for a dialog or new app window",
      "  terminal_output_contains — wait for CLI command completion",
      "  element_matches   — wait for browser DOM readiness after navigation",
      "  focus_changes     — wait for focus to shift after an action",
      "On WaitTimeout, read the suggest[] array in the error response for recovery steps.",
      "",
      "## Failure recovery",
      "- WindowNotFound → call get_windows to list available titles, then retry focus_window",
      "- WaitTimeout → read suggest[] in the error; increase timeoutMs or verify target exists",
      "- keyboard_press / keyboard_type wrong window → call focus_window(windowTitle) first",
      "- scroll_capture sizeReduced=true → reduce maxScrolls or add grayscale=true",
      "",
      "## Scroll capture",
      "scroll_capture stitches full-page images. sizeReduced=true means the image was downscaled (pixel coords ≠ screen) — use for reading only, not mouse_click. overlapMode='mixed-with-failures' means some frame seams have duplicate rows.",
      "",
      "## Auto-dock CLI window (optional)",
      "Set env vars in your MCP client config to auto-dock Claude CLI on startup:",
      "  DESKTOP_TOUCH_DOCK_TITLE='@parent'  — auto-detect the hosting terminal (recommended)",
      "  DESKTOP_TOUCH_DOCK_CORNER=bottom-right  DESKTOP_TOUCH_DOCK_WIDTH=480  DESKTOP_TOUCH_DOCK_HEIGHT=360",
      "",
      "## Emergency stop (Failsafe)",
      "Move mouse to the top-left corner of the screen (within 10px of 0,0) to immediately terminate the MCP server.",
      "",
      "## Reactive Perception (lensId-based workflow)",
      "For repeated work on the same window or browser tab, register a perception lens before acting.",
      "A lens is a lightweight live state tracker. Pass its lensId to action tools so the server can verify focus, identity, readiness, modal obstruction, and click safety before the action, then return post.perception after the action.",
      "",
      "Use this workflow:",
      "1. perception_register — create a lens for the target window/tab",
      "2. Pass lensId to keyboard/mouse/browser action tools",
      "3. Read post.perception.attention after each action",
      "4. If attention is dirty, stale, settling, guard_failed, or identity_changed, follow suggestedAction or call perception_read",
      "5. perception_forget when the workflow is done",
      "",
      "Attention values and recommended actions:",
      "  ok           — safe to act",
      "  changed      — state updated; verify before acting",
      "  dirty        — evidence pending; call perception_read first",
      "  settling     — window in motion; wait then call perception_read",
      "  stale        — evidence may be old; call perception_read to refresh",
      "  guard_failed — unsafe; read failedGuard.suggestedAction before proceeding",
      "  identity_changed — window was replaced; re-register the lens",
      "",
      "Prefer perception_read over screenshot/get_context when a lens already exists. Screenshots are a fallback for visual details, not the default state check.",
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
registerClipboardTools(server);
registerNotificationTools(server);
registerScrollToElementTools(server);
registerSmartScrollTools(server);
registerPerceptionTools(server);

// ─── Perception resources (opt-in: DESKTOP_TOUCH_PERCEPTION_RESOURCES=1) ──────
if (process.env.DESKTOP_TOUCH_PERCEPTION_RESOURCES === "1") {
  registerPerceptionResources(server);
}

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
let httpServerRef: HttpServer | null = null;
let httpTransportRef: StreamableHTTPServerTransport | null = null;

function shutdown(): void {
  console.error("[desktop-touch] Shutting down...");
  stopNativeRuntime();
  stopTray();
  httpServerRef?.close();
  void httpTransportRef?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);

// ─── Parse CLI flags ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`desktop-touch-mcp v${SERVER_VERSION}

Usage: desktop-touch-mcp [options]

Options:
  --http          Use Streamable HTTP transport (default: stdio)
  --port <port>   HTTP port (default: 23847, requires --http)
  -h, --help      Show this help message

HTTP endpoint: http://127.0.0.1:<port>/mcp
Health check:  http://127.0.0.1:<port>/health`);
  process.exit(0);
}

const useHttp = args.includes("--http");
const portIndex = args.indexOf("--port");
const httpPort = portIndex !== -1 && args[portIndex + 1] ? parseInt(args[portIndex + 1], 10) : 23847;
const httpUrl = useHttp ? `http://127.0.0.1:${httpPort}/mcp` : undefined;

// ─── Start tray icon ─────────────────────────────────────────────────────────
const trayOptions: TrayOptions = { httpUrl, icoPath: icoOk, version: SERVER_VERSION };
startTray(trayOptions);

// ─── Connect MCP transport ───────────────────────────────────────────────────
if (useHttp) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  httpTransportRef = transport;

  const httpServer = createServer((req, res) => {
    // DNS rebinding protection
    const host = req.headers.host ?? "";
    if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")
        && host !== "127.0.0.1" && host !== "localhost") {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // CORS for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, MCP-Protocol-Version");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url?.startsWith("/mcp")) {
      transport.handleRequest(req, res);
    } else if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: "desktop-touch-mcp", version: SERVER_VERSION }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServerRef = httpServer;
  await server.connect(transport);
  httpServer.listen(httpPort, "127.0.0.1", () => {
    console.error(`[desktop-touch] MCP server running (http) on ${httpUrl}`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[desktop-touch] MCP server running (stdio)");
}

// Auto-dock CLI window if DESKTOP_TOUCH_DOCK_TITLE is set (opt-in).
// Detached so a missing window or poll timeout doesn't delay server readiness.
void autoDockFromEnv().catch((err) => {
  console.error("[desktop-touch] auto-dock error:", err);
});


