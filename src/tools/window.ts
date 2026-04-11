import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWindows, getActiveWindow } from "../engine/nutjs.js";
import { getWindowTitleW, enumWindowsInZOrder } from "../engine/win32.js";
import { getVirtualDesktopStatus } from "../engine/uia-bridge.js";
import type { ToolResult } from "./_types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getWindowsSchema = {};

export const getActiveWindowSchema = {};

export const focusWindowSchema = {
  title: z.string().describe("Partial window title to search for (case-insensitive)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const getWindowsHandler = async (): Promise<ToolResult> => {
  try {
    const wins = enumWindowsInZOrder();
    const hwndStrings = wins.map((w) => String(w.hwnd));
    const vdStatus = await getVirtualDesktopStatus(hwndStrings);

    const results = wins.map((w, i) => ({
      zOrder: w.zOrder,
      title: w.title,
      region: w.region,
      isActive: w.isActive,
      isMinimized: w.isMinimized,
      isMaximized: w.isMaximized,
      isOnCurrentDesktop: vdStatus[hwndStrings[i]!] ?? true,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ count: results.length, windows: results }, null, 2),
        },
      ],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `get_windows failed: ${String(err)}` }] };
  }
};

export const getActiveWindowHandler = async (): Promise<ToolResult> => {
  try {
    const win = await getActiveWindow();
    const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
    const title = hwnd ? getWindowTitleW(hwnd) : await win.title;
    const reg = await win.region;
    const info = {
      title,
      region: { x: reg.left, y: reg.top, width: reg.width, height: reg.height },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `get_active_window failed: ${String(err)}` }] };
  }
};

export const focusWindowHandler = async ({ title }: { title: string }): Promise<ToolResult> => {
  try {
    const windows = await getWindows();
    const query = title.toLowerCase();

    for (const win of windows) {
      try {
        const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
        const winTitle = hwnd ? getWindowTitleW(hwnd) : await win.title;
        if (!winTitle.toLowerCase().includes(query)) continue;
        const reg = await win.region;
        if (reg.width < 50 || reg.height < 50) continue;
        await win.focus();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              focused: winTitle,
              region: { x: reg.left, y: reg.top, width: reg.width, height: reg.height },
            }),
          }],
        };
      } catch {
        // Skip
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: `No window found matching: "${title}"` }),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `focus_window failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWindowTools(server: McpServer): void {
  server.tool(
    "get_windows",
    [
      "List all visible windows with their titles, screen positions, Z-order, and virtual desktop status.",
      "",
      "zOrder: 0 = frontmost window, higher = further behind.",
      "isActive: true = the window currently receiving keyboard input.",
      "isMinimized / isMaximized: window state.",
      "isOnCurrentDesktop: false = window exists on a different virtual desktop (cannot interact without switching).",
      "",
      "Use this to understand the window stack before deciding whether a screenshot is needed.",
    ].join("\n"),
    getWindowsSchema,
    getWindowsHandler
  );

  server.tool(
    "get_active_window",
    "Get information about the currently focused window.",
    getActiveWindowSchema,
    getActiveWindowHandler
  );

  server.tool(
    "focus_window",
    "Bring a window to the foreground by finding it by title (partial, case-insensitive match).",
    focusWindowSchema,
    focusWindowHandler
  );
}
