import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveWindow } from "../engine/nutjs.js";
import { getWindowTitleW, enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { getVirtualDesktopStatus } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";

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
    updateWindowCache(wins);
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
    // Use enumWindowsInZOrder (Win32-based) so minimized windows are also included.
    const windows = enumWindowsInZOrder();
    updateWindowCache(windows);
    const query = title.toLowerCase();

    for (const win of windows) {
      if (!win.title.toLowerCase().includes(query)) continue;

      // SW_RESTORE is a no-op for non-minimized windows, so this is safe to call unconditionally.
      // Returns the actual rect after restoration (important for previously-minimized windows).
      const region = restoreAndFocusWindow(win.hwnd);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            focused: win.title,
            region,
          }),
        }],
      };
    }

    return failWith(`Window not found: "${title}"`, "focus_window", { title });
  } catch (err) {
    return failWith(err, "focus_window", { title });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWindowTools(server: McpServer): void {
  server.tool(
    "get_windows",
    "List all visible windows with titles, screen positions, Z-order, active state, and virtual desktop membership. zOrder=0 is frontmost; isActive=true is the keyboard-focused window; isOnCurrentDesktop=false means the window is on another virtual desktop and cannot be interacted with without switching. Use before screenshot to determine whether a specific window needs capturing. Caveats: Returns only top-level visible windows — child windows and system tray items are excluded.",
    getWindowsSchema,
    getWindowsHandler
  );

  server.tool(
    "get_active_window",
    "Return the title, hwnd, and bounds of the currently focused window.",
    getActiveWindowSchema,
    getActiveWindowHandler
  );

  server.tool(
    "focus_window",
    "Bring a window to the foreground by partial title match (case-insensitive). Required before keyboard_* when the dock is pinned — otherwise keystrokes go to the pinned overlay. Returns WindowNotFound if no match exists; call get_windows to see available titles. Caveats: On some apps focus may be immediately stolen back (modal dialogs, UAC prompts) — verify with get_context after focusing.",
    focusWindowSchema,
    focusWindowHandler
  );
}
