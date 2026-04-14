/**
 * server-linux-stub.ts — minimal MCP server for non-Windows hosts.
 *
 * desktop-touch-mcp is Windows-native (uses koffi → user32/gdi32, nut-js,
 * UIA via PowerShell). On Linux / macOS the underlying APIs simply do not
 * exist, so we cannot do anything useful. But we still need the process to
 * boot and answer `tools/list` so directory hosts (e.g. Glama) can complete
 * their automated safety / quality checks.
 *
 * This stub:
 *   - registers all 46 tool names with a minimal pass-through schema
 *   - every tool call returns a structured `UnsupportedPlatform` error
 *   - boots fast, never imports any native module
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOOL_NAMES: string[] = [
  // screenshot family
  "screenshot",
  "screenshot_background",
  "screenshot_ocr",
  "get_screen_info",
  // mouse
  "mouse_move",
  "mouse_click",
  "mouse_drag",
  "scroll",
  "get_cursor_position",
  // keyboard
  "keyboard_type",
  "keyboard_press",
  // window
  "get_windows",
  "get_active_window",
  "focus_window",
  // ui-elements
  "get_ui_elements",
  "click_element",
  "set_element_value",
  "scope_element",
  // workspace
  "workspace_snapshot",
  "workspace_launch",
  // pin
  "pin_window",
  "unpin_window",
  // macro
  "run_macro",
  // scroll-capture
  "scroll_capture",
  // dock
  "dock_window",
  // context
  "get_context",
  "get_history",
  "get_document_state",
  // terminal
  "terminal_read",
  "terminal_send",
  // events
  "events_subscribe",
  "events_poll",
  "events_unsubscribe",
  "events_list",
  // wait_until
  "wait_until",
  // browser CDP
  "browser_launch",
  "browser_connect",
  "browser_find_element",
  "browser_click_element",
  "browser_eval",
  "browser_get_dom",
  "browser_get_interactive",
  "browser_get_app_state",
  "browser_search",
  "browser_navigate",
  "browser_disconnect",
];

const server = new McpServer(
  { name: "desktop-touch", version: "0.6.2" },
  {
    instructions: [
      `desktop-touch-mcp is a Windows-native MCP server. The current host`,
      `(${process.platform}) is not supported — every tool call will return`,
      `UnsupportedPlatform. Run the server on Windows 11 to operate.`,
    ].join(" "),
  }
);

const stubResponse = (toolName: string) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        ok: false,
        code: "UnsupportedPlatform",
        error: `${toolName}: desktop-touch-mcp requires Windows. Current platform: ${process.platform}.`,
        suggest: [
          "Run the MCP server on a Windows 11 host (Node.js >= 20).",
          "See https://github.com/Harusame64/desktop-touch-mcp for installation instructions.",
        ],
      }),
    },
  ],
});

const stubDescription = (name: string): string =>
  `${name} — Windows-only tool. Returns UnsupportedPlatform on non-Windows hosts (current: ${process.platform}). See repository README for details.`;

for (const name of TOOL_NAMES) {
  server.tool(
    name,
    stubDescription(name),
    // Accept anything — we never inspect the args.
    { _stub: z.unknown().optional().describe("Stub tool — arguments ignored.") },
    async () => stubResponse(name)
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[desktop-touch] non-Windows stub server running (stdio). Platform: ${process.platform}. ` +
  `${TOOL_NAMES.length} tools advertised, all return UnsupportedPlatform.`
);
