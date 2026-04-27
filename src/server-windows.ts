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
import { registerWindowTools, getWindowsHandler, getWindowsSchema } from "./tools/window.js";
import {
  registerUiElementTools,
  getUiElementsHandler,
  getUiElementsSchema,
  setElementValueHandler,
  setElementValueSchema,
} from "./tools/ui-elements.js";
import { withRichNarration } from "./tools/_narration.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerMacroTools } from "./tools/macro.js";
import { registerBrowserTools } from "./tools/browser.js";
import { autoDockFromEnv } from "./tools/dock.js";
import { registerWindowDockTools } from "./tools/window-dock.js";
import { registerScrollTools } from "./tools/scroll.js";
import { registerWaitUntilTool } from "./tools/wait-until.js";
import { registerDesktopStateTools } from "./tools/desktop-state.js";
import { registerTerminalTools } from "./tools/terminal.js";
import { registerEventTools } from "./tools/events.js";
import { registerClipboardTools } from "./tools/clipboard.js";
import { registerNotificationTools } from "./tools/notification.js";
import { registerPerceptionTools } from "./tools/perception.js";
import { registerPerceptionResources } from "./tools/perception-resources.js";
import { registerServerStatusTool } from "./tools/server-status.js";
import { logAutoGuardStartup } from "./tools/_action-guard.js";
import { stopNativeRuntime } from "./engine/perception/registry.js";
import { startTray, stopTray, type TrayOptions } from "./utils/tray.js";
import { checkFailsafe, FailsafeError } from "./utils/failsafe.js";
import { wrapHandlerArg } from "./utils/failsafe-wrap.js";
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
        "  entity_outside_viewport → scroll via scroll(action='raw') or scroll(action='to_element'), then re-call desktop_discover;",
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
        "Preferred: terminal(action='run', input='cmd', until={mode:'pattern', pattern:'$ '}) — send + wait + read in one call.",
        "Manual: terminal(action='send') → wait_until(terminal_output_contains, pattern='$ ') → terminal(action='read', sinceMarker).",
        "Do not screenshot the terminal — terminal(action='read') is cheaper and structured.",
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
        "- WindowNotFound → call desktop_discover to list available titles, then retry focus_window",
        "- WaitTimeout → read suggest[] in the error; increase timeoutMs or verify target exists",
        "- keyboard(action='press') or keyboard(action='type') wrong window → call focus_window(windowTitle) first",
        "- scroll(action='capture') sizeReduced=true → reduce maxScrolls or add grayscale=true",
        "",
        "## Scroll capture",
        "scroll(action='capture') stitches full-page images. sizeReduced=true means the image was downscaled (pixel coords ≠ screen) — use for reading only, not mouse_click. overlapMode='mixed-with-failures' means some frame seams have duplicate rows.",
        "",
        "## Auto-dock CLI window (optional)",
        "Set env vars in your MCP client config to auto-dock Claude CLI on startup (uses window_dock(action='dock') internally):",
        "  DESKTOP_TOUCH_DOCK_TITLE='@parent'  — auto-detect the hosting terminal (recommended)",
        "  DESKTOP_TOUCH_DOCK_CORNER=bottom-right  DESKTOP_TOUCH_DOCK_WIDTH=480  DESKTOP_TOUCH_DOCK_HEIGHT=360",
        "",
        "## Emergency stop (Failsafe)",
        "Move mouse to the top-left corner of the screen (within 10px of 0,0) to immediately terminate the MCP server.",
      ].join("\n"),
    }
  );

  // Inject failsafe pre-check into every tool handler.
  //
  // Both s.tool() and s.registerTool() take the handler as the LAST argument
  // (s.tool: (name, [desc], [schema], handler); s.registerTool: (name, config, handler)).
  // Wrapping that last arg gives every public tool — including Phase 2/3
  // dispatchers (keyboard / clipboard / window_dock / scroll / terminal /
  // browser_eval) registered via registerTool — the same emergency-stop gate
  // as the legacy s.tool() registrations. (Codex PR #40 P1)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _originalTool = s.tool.bind(s) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s as any).tool = function (...toolArgs: any[]) {
    return _originalTool(...wrapHandlerArg(toolArgs, checkFailsafe));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _originalRegisterTool = s.registerTool.bind(s) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s as any).registerTool = function (...toolArgs: any[]) {
    return _originalRegisterTool(...wrapHandlerArg(toolArgs, checkFailsafe));
  };

  registerScreenshotTools(s);
  registerMouseTools(s);
  registerKeyboardTools(s);
  registerWindowTools(s);
  registerUiElementTools(s);
  registerWorkspaceTools(s);
  registerMacroTools(s);
  registerScrollTools(s);
  registerBrowserTools(s);
  registerWindowDockTools(s);
  registerWaitUntilTool(s);
  registerDesktopStateTools(s);
  registerTerminalTools(s);
  registerEventTools(s);
  registerClipboardTools(s);
  registerNotificationTools(s);
  registerPerceptionTools(s);
  registerServerStatusTool(s);

  // Perception resources (opt-in: DESKTOP_TOUCH_PERCEPTION_RESOURCES=1)
  if (process.env.DESKTOP_TOUCH_PERCEPTION_RESOURCES === "1") {
    registerPerceptionResources(s);
  }

  // Anti-Fukuwarai v2: desktop_discover / desktop_act (default-on; kill switch DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1)
  // _desktopV2 is pre-loaded at module init time (top-level await below) so registration
  // is synchronous here — no race window between createMcpServer() and tool availability.
  if (_desktopV2) {
    _desktopV2.registerDesktopTools(s);
  } else {
    // Phase 4 kill-switch V1 fallback (Codex PR #41 round 6 P1×2):
    // when v2 is disabled, re-publish the V1 tools whose capability is
    // ONLY available through the dispatcher path so the operator does not
    // lose function coverage by flipping the kill switch.
    //   - get_windows: enumerate visible HWNDs (no other tool exposes hwnd
    //     listing for title-collision / hwnd-targeted workflows)
    //   - get_ui_elements: raw UIA tree (screenshot(detail='text') is the
    //     screenshot-time alternative but does not return the unfiltered tree)
    //   - set_element_value: UIA ValuePattern (keyboard(action='type') is
    //     keyboard-driven and does not work for programmatic value set)
    // The other Phase 4 privatizations have non-v2 replacements (desktop_state
    // include* flags / screenshot dispatcher / wait_until) and stay private.
    s.tool(
      "get_windows",
      "[V1 fallback — registered only when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1] List all visible windows with titles, screen positions, Z-order, active state, and virtual desktop membership. zOrder=0 is frontmost; isActive=true is the keyboard-focused window; isOnCurrentDesktop=false means the window is on another virtual desktop. Use before screenshot to determine whether a specific window needs capturing.",
      getWindowsSchema,
      getWindowsHandler
    );
    s.tool(
      "get_ui_elements",
      "[V1 fallback — registered only when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1] Inspect the raw UIA element tree of a window — returns names, control types, automationIds, bounding rects, and interaction patterns. Prefer screenshot(detail='text') for normal automation; this fallback is here so kill-switch deployments retain access to the unfiltered tree.",
      getUiElementsSchema,
      getUiElementsHandler
    );
    s.tool(
      "set_element_value",
      "[V1 fallback — registered only when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1] Set the value of a text field or combo box via UIA ValuePattern. The server auto-guards using windowTitle and returns post.perception.status. More reliable than keyboard(action='type') for programmatic form input.",
      setElementValueSchema,
      withRichNarration("set_element_value", setElementValueHandler, { windowTitleKey: "windowTitle" })
    );
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
  // CLI usage on stdout — process.exit(0) below, so MCP JSON-RPC never starts.
  // eslint-disable-next-line no-console
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

    // CORS — only echo Origin for localhost requests. The DNS rebinding check
    // above bounds Host to localhost; the Origin check here bounds the
    // BROWSER side: a malicious cross-origin tab can still reach the server
    // via the user's loopback, but without a matching Allow-Origin the
    // browser will not expose the response to JS — preventing a tab on
    // evil.com from exfiltrating the MCP surface.
    const origin = req.headers.origin;
    if (typeof origin === "string" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
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


