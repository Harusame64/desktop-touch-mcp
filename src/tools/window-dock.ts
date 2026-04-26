import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { pinWindowHandler, unpinWindowHandler } from "./pin.js";
import { dockWindowHandler } from "./dock.js";

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher schema (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

export const windowDockSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pin"),
    title: z.string().describe("Partial window title (case-insensitive)"),
    duration_ms: z.coerce.number().int().min(0).max(60000).optional().describe(
      "Auto-unpin after this many ms (0–60000). Omit to pin indefinitely."
    ),
  }),
  z.object({
    action: z.literal("unpin"),
    title: z.string().describe("Partial window title (case-insensitive)"),
  }),
  z.object({
    action: z.literal("dock"),
    title: z
      .string()
      .describe(
        "Partial window title to dock (case-insensitive). Matches the first visible window containing this text. " +
        "Example: 'Claude Code', 'メモ帳'."
      ),
    corner: z
      .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
      .default("bottom-right")
      .describe("Screen corner to snap the window to. Default 'bottom-right'."),
    width: z.coerce.number().int().positive().default(480).describe("Window width in pixels after docking. Default 480."),
    height: z.coerce.number().int().positive().default(360).describe("Window height in pixels after docking. Default 360."),
    pin: z
      .boolean()
      .default(true)
      .describe(
        "If true, set always-on-top so the docked window stays visible on top of other windows. " +
        "Use window_dock(action='unpin') to remove the topmost flag later. Default true."
      ),
    monitorId: z.coerce.number().int().min(0).optional().describe("Monitor to dock on (from desktop_state({includeScreen:true})). Omit for primary monitor."),
    margin: z.coerce.number().int().min(0).default(8).describe("Pixel padding between the window and the screen edge. Default 8."),
  }),
]);

export type WindowDockArgs = z.infer<typeof windowDockSchema>;

export const windowDockHandler = async (args: WindowDockArgs): Promise<ToolResult> => {
  switch (args.action) {
    case "pin": return pinWindowHandler(args);
    case "unpin": return unpinWindowHandler(args);
    case "dock": return dockWindowHandler(args);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWindowDockTools(server: McpServer): void {
  server.registerTool(
    "window_dock",
    {
      description: buildDesc({
        purpose: "Decorate a window: pin (always-on-top), unpin, or dock (move + resize + optional pin).",
        details: "action='pin' makes window always-on-top until unpin/duration_ms. action='unpin' removes always-on-top. action='dock' positions to corner with width/height (default 480×360 bottom-right) and optionally pins. Minimized windows are automatically restored before docking.",
        prefer: "Use action='dock' for terminal/CLI window auto-positioning at session start. Use action='pin' alone when you only need always-on-top without moving or resizing.",
        caveats: "Pin survives minimize/restore; explicit action='unpin' needed to release. Dock fails on elevated processes. Dock overrides any existing Win+Arrow snap arrangement.",
        examples: [
          "window_dock({action:'dock', title:'PowerShell', corner:'bottom-right', width:480, height:360})",
          "window_dock({action:'pin', title:'Settings', duration_ms:5000})",
          "window_dock({action:'unpin', title:'Settings'})",
        ],
      }),
      inputSchema: windowDockSchema,
    },
    windowDockHandler
  );
}
