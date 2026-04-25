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
import { registerDesktopStateTools } from "./tools/desktop-state.js";
import { registerTerminalTools } from "./tools/terminal.js";
import { registerEventTools } from "./tools/events.js";
import { registerClipboardTools } from "./tools/clipboard.js";
import { registerNotificationTools } from "./tools/notification.js";
import { registerScrollToElementTools } from "./tools/scroll-to-element.js";
import { registerSmartScrollTools } from "./tools/smart-scroll.js";
import { registerPerceptionTools } from "./tools/perception.js";
import { registerPerceptionResources } from "./tools/perception-resources.js";
import { registerServerStatusTool } from "./tools/server-status.js";
import { logAutoGuardStartup } from "./tools/_action-guard.js";
import { stopNativeRuntime } from "./engine/perception/registry.js";
import { startTray, stopTray, type TrayOptions } from "./utils/tray.js";
import { checkFailsafe, FailsafeError } from "./utils/failsafe.js";
import { SERVER_VERSION } from "./version.js";
import { resolveV2Activation } from "./tools/desktop-activation.js";

// Resolve assets/icons directory (works both in dev: dist/ and release: dist/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const icoDir = join(__dirname, "..", "assets", "icons");
const icoOk = existsSync(join(icoDir, "tray_ok.ico")) ? join(icoDir, "tray_ok.ico") : undefined;

// ─── Anti-Fukuwarai v2 feature flag ──────────────────────────────────────────
// v0.17+: default-on. Kill switch: DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1.
// Priority: DISABLE=1 > ENABLE=1 > default(ON).
// Exact-match semantics: only the literal string "1" counts; "true"/"yes"/"0"/" " are unset.
// See docs/anti-fukuwarai-v2-activation-policy.md for the full env matrix.
const { enabled: _v2Enabled, disabledByFlag: _v2Disabled, legacyEnableSet: _v2LegacySet } =
  resolveV2Activation(process.env);

if (_v2Enabled) {
  console.error("[desktop-touch] v2 tools: enabled (default-on)");
} else {
  console.error("[desktop-touch] v2 tools: disabled (DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1)");
}

// ENABLE=1 is deprecated since v0.17. Warn regardless of whether v2 ends up ON or OFF.
if (_v2LegacySet) {
  console.error(
    "[desktop-touch] DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2 is deprecated in v0.17; " +
    "remove it from your MCP env. Use DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 to opt out."
  );
}

// Pre-load the v2 module at startup so registerDesktopTools() is synchronous inside
// createMcpServer(). Dynamic import keeps zero side-effects on flag-OFF path.
// Top-level await is valid in ES modules (NodeNext, Node 20+).
const _desktopV2 = _v2Enabled
  ? await import("./tools/desktop-register.js").catch((err) => {
      // Registration failure must not crash the server.
      console.error("[desktop-touch] Failed to load desktop v2 module:", err);
      return null;
    })
  : null;

// ─── MCP server factory ───────────────────────────────────────────────────────
// Returns a fully-configured McpServer with all tools registered.
// Called once for STDIO mode, and once per HTTP request for stateless HTTP mode.
function createMcpServer(): McpServer {
  const s = new McpServer(
    { name: "desktop-touch", version: SERVER_VERSION },
    {
      instructions: [
        "# desktop-touch-mcp",
        "",
        "## Standard workflow",
        "1. desktop_state — orient: focused window/element, modal, attention signal",
        "2. desktop_discover — find actionable entities (returns lease)",
        "3. desktop_act(lease, action) — act on entity (returns attention)",
        "4. desktop_state — confirm",
        "",
        "## Clicking — priority order",
        "1. browser_click(selector) — Chrome/Edge (CDP, stable across repaints)",
        "2. desktop_act(lease, action='click') — native/dialog/visual (entity-based; use after desktop_discover)",
        "3. click_element(name or automationId) — native UIA fallback if desktop_act ok=false",
        "4. mouse_click(x, y, origin?, scale?) — pixel last resort; origin+scale from dotByDot screenshots only",
        "",
        "## When desktop_act returns ok:false",
        "Read reason and follow the recovery path:",
        "  lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found → re-call desktop_discover;",
        "  modal_blocking → dismiss modal via click_element, then retry;",
        "  entity_outside_viewport → scroll via scroll/scroll_to_element, then re-call desktop_discover;",
        "  executor_failed → fall back to click_element / mouse_click / browser_click",
        "",
        "## Observation — priority order",
        "1. desktop_state — cheapest; focused element, modal, attention",
        "2. desktop_discover — actionable entities + lease (when action target needed)",
        "3. screenshot(detail='text') — actionable elements with coords (visual fallback)",
        "4. screenshot(dotByDot=true) — pixel-accurate image when text mode returns 0 elements",
        "5. screenshot(detail='image', confirmImage=true) — visual inspection only",
        "",
        "## Attention signal (auto-perception)",
        "desktop_state and desktop_act responses always include attention. Read it after each action:",
        "  ok               — safe to act",
        "  changed          — state updated; verify before next action",
        "  dirty            — evidence pending; call desktop_state to refresh",
        "  settling         — UI in motion; wait then call desktop_state",
        "  stale            — evidence may be old; call desktop_state",
        "  guard_failed     — unsafe; read suggestedAction in response",
        "  identity_changed — window was replaced; re-discover with desktop_discover",
        "",
        "## Terminal workflow",
        "// Phase 2 will update: terminal(action='run') unification pending",
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
        "// Phase 2 will update: scroll parameter unification pending",
        "scroll_capture stitches full-page images. sizeReduced=true means the image was downscaled (pixel coords ≠ screen) — use for reading only, not mouse_click. overlapMode='mixed-with-failures' means some frame seams have duplicate rows.",
        "",
        "## Auto-dock CLI window (optional)",
        "// Phase 2 will update: window_dock(action='dock') unification pending",
        "Set env vars in your MCP client config to auto-dock Claude CLI on startup:",
        "  DESKTOP_TOUCH_DOCK_TITLE='@parent'  — auto-detect the hosting terminal (recommended)",
        "  DESKTOP_TOUCH_DOCK_CORNER=bottom-right  DESKTOP_TOUCH_DOCK_WIDTH=480  DESKTOP_TOUCH_DOCK_HEIGHT=360",
        "",
        "## Emergency stop (Failsafe)",
        "Move mouse to the top-left corner of the screen (within 10px of 0,0) to immediately terminate the MCP server.",
      ].join("\n"),
    }
  );

  // Inject failsafe pre-check into every tool handler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _originalTool = s.tool.bind(s) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s as any).tool = function (...toolArgs: any[]) {
    const lastIdx = toolArgs.length - 1;
    const originalHandler = toolArgs[lastIdx] as (...args: unknown[]) => Promise<unknown>;
    toolArgs[lastIdx] = async (...handlerArgs: unknown[]) => {
      await checkFailsafe();
      return originalHandler(...handlerArgs);
    };
    return _originalTool(...toolArgs);
  };

  registerScreenshotTools(s);
  registerMouseTools(s);
  registerKeyboardTools(s);
  registerWindowTools(s);
  registerUiElementTools(s);
  registerWorkspaceTools(s);
  registerPinTools(s);
  registerMacroTools(s);
  registerScrollCaptureTools(s);
  registerBrowserTools(s);
  registerDockTools(s);
  registerWaitUntilTool(s);
  registerDesktopStateTools(s);
  registerTerminalTools(s);
  registerEventTools(s);
  registerClipboardTools(s);
  registerNotificationTools(s);
  registerScrollToElementTools(s);
  registerSmartScrollTools(s);
  registerPerceptionTools(s);
  registerServerStatusTool(s);

  // Perception resources (opt-in: DESKTOP_TOUCH_PERCEPTION_RESOURCES=1)
  if (process.env.DESKTOP_TOUCH_PERCEPTION_RESOURCES === "1") {
    registerPerceptionResources(s);
  }

  // Anti-Fukuwarai v2: desktop_see / desktop_touch (opt-in: DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1)
  // _desktopV2 is pre-loaded at module init time (top-level await below) so registration
  // is synchronous here — no race window between createMcpServer() and tool availability.
  if (_desktopV2) {
    _desktopV2.registerDesktopTools(s);
  }

  return s;
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
let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("[desktop-touch] Shutting down...");
  stopNativeRuntime();
  stopTray();
  httpServerRef?.close();
  // In-flight requests clean up their own server/transport instances via res.on("close").
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

// ─── Log auto-guard startup status ───────────────────────────────────────────
logAutoGuardStartup();

// ─── Start tray icon ─────────────────────────────────────────────────────────
const trayOptions: TrayOptions = {
  httpUrl,
  icoPath: icoOk,
  version: SERVER_VERSION,
  onExitRequested: shutdown,
};
startTray(trayOptions);

// ─── Connect MCP transport ───────────────────────────────────────────────────
if (useHttp) {
  // Stateless mode: each HTTP request gets its own McpServer + Transport instance.
  // This is required by the MCP SDK — server.connect() can only be called once per
  // McpServer instance, so we must create fresh instances per request.
  const httpServer = createServer(async (req, res) => {
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
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url?.startsWith("/mcp")) {
      const reqServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless — no session management
        enableJsonResponse: true,
      });
      // Clean up when the HTTP response closes.
      res.on("close", () => {
        transport.close().catch(() => {});
        reqServer.close().catch(() => {});
      });
      try {
        await reqServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("[desktop-touch] handleRequest error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    } else if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: "desktop-touch-mcp", version: SERVER_VERSION }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServerRef = httpServer;
  httpServer.listen(httpPort, "127.0.0.1", () => {
    console.error(`[desktop-touch] MCP server running (http) on ${httpUrl}`);
  });
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Detect parent process exit: stdin EOF when the client's write-end closes.
  // The MCP SDK only listens for 'data' and 'error', not 'end'.
  process.stdin.on("end", () => {
    console.error("[desktop-touch] stdin closed — parent exited. Shutting down.");
    shutdown();
  });

  // Fallback: catch broken-pipe when writing responses after parent exits.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
      console.error("[desktop-touch] stdout broken pipe — parent exited. Shutting down.");
      shutdown();
    }
  });

  console.error("[desktop-touch] MCP server running (stdio)");
}

// Auto-dock CLI window if DESKTOP_TOUCH_DOCK_TITLE is set (opt-in).
// Detached so a missing window or poll timeout doesn't delay server readiness.
void autoDockFromEnv().catch((err) => {
  console.error("[desktop-touch] auto-dock error:", err);
});


