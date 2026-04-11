import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { enumWindowsInZOrder, setWindowTopmost, clearWindowTopmost } from "../engine/win32.js";
import type { ToolResult } from "./_types.js";

function findWindowHwnd(titleQuery: string): { hwnd: unknown; title: string } | null {
  const query = titleQuery.toLowerCase();
  for (const win of enumWindowsInZOrder()) {
    if (!win.title.toLowerCase().includes(query)) continue;
    if (win.region.width < 50 || win.region.height < 50) continue;
    return { hwnd: win.hwnd, title: win.title };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const pinWindowSchema = {
  title: z.string().describe("Partial window title to search for (case-insensitive)"),
  duration_ms: z
    .coerce.number()
    .int()
    .min(0)
    .max(60000)
    .optional()
    .describe("Auto-unpin after this many milliseconds (0–60000). Omit to pin indefinitely."),
};

export const unpinWindowSchema = {
  title: z.string().describe("Partial window title to search for (case-insensitive)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const pinWindowHandler = async ({
  title,
  duration_ms,
}: { title: string; duration_ms?: number }): Promise<ToolResult> => {
  try {
    const found = findWindowHwnd(title);
    if (!found) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `No window found matching: "${title}"` }),
        }],
      };
    }

    setWindowTopmost(found.hwnd);

    if (duration_ms !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, duration_ms));
      clearWindowTopmost(found.hwnd);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, title: found.title, action: `pinned for ${duration_ms}ms, now unpinned` }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: true, title: found.title, action: "pinned (call unpin_window to remove)" }),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `pin_window failed: ${String(err)}` }] };
  }
};

export const unpinWindowHandler = async ({ title }: { title: string }): Promise<ToolResult> => {
  try {
    const found = findWindowHwnd(title);
    if (!found) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `No window found matching: "${title}"` }),
        }],
      };
    }

    clearWindowTopmost(found.hwnd);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: true, title: found.title, action: "unpinned" }),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `unpin_window failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerPinTools(server: McpServer): void {
  server.tool(
    "pin_window",
    [
      "Make a window always-on-top (keep it in front of all other windows).",
      "",
      "If duration_ms is specified, the window is pinned for that duration then automatically unpinned.",
      "If duration_ms is omitted, the window stays pinned until unpin_window is called.",
      "",
      "Useful in run_macro sequences: pin_window → interact → unpin_window.",
    ].join("\n"),
    pinWindowSchema,
    pinWindowHandler
  );

  server.tool(
    "unpin_window",
    "Remove always-on-top from a window. Reverses pin_window.",
    unpinWindowSchema,
    unpinWindowHandler
  );
}
