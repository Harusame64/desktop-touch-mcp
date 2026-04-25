import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { getEngineStatus } from "../engine/status.js";

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const serverStatusHandler = async (): Promise<ToolResult> => {
  try {
    const status = getEngineStatus();
    return ok({ engine: status });
  } catch (err) {
    return failWith(err, "server_status");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerServerStatusTool(server: McpServer): void {
  server.tool(
    "server_status",
    "Return MCP server status: version / native engine availability / Auto Perception state / v2 activation. uia: 'native' = Rust UIA addon (fast, ~2 ms focus / ~100 ms tree); 'powershell' = PS fallback (~366 ms focus). imageDiff: 'native' = Rust SSE2 SIMD (0.26 ms @ 1080p); 'typescript' = TS fallback (~3.8 ms). Diagnostic metadata — do not surface these values to the user unless they ask about performance or troubleshooting. Call once per session if you need to know which path is active; the result is stable for the lifetime of the server process.",
    {},
    serverStatusHandler
  );
}
