import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  enumWindowsInZOrder,
  enumMonitors,
  setWindowBounds,
  setWindowTopmost,
  clearWindowTopmost,
  restoreAndFocusWindow,
  getWindowRectByHwnd,
} from "../engine/win32.js";
import type { WindowZInfo, MonitorInfo } from "../engine/win32.js";
import type { ToolResult } from "./_types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Find the first visible window whose title contains the query (case-insensitive). */
function findWindow(titleQuery: string): WindowZInfo | null {
  const query = titleQuery.toLowerCase();
  for (const win of enumWindowsInZOrder()) {
    if (!win.title.toLowerCase().includes(query)) continue;
    // Accept minimized windows too — we restore them before docking.
    if (!win.isMinimized && (win.region.width < 50 || win.region.height < 50)) continue;
    return win;
  }
  return null;
}

/** Pick a monitor: explicit id if given, else primary, else first. */
function pickMonitor(monitors: MonitorInfo[], monitorId?: number): MonitorInfo | null {
  if (monitors.length === 0) return null;
  if (monitorId !== undefined) {
    return monitors.find((m) => m.id === monitorId) ?? null;
  }
  return monitors.find((m) => m.primary) ?? monitors[0];
}

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * Compute absolute (x, y) for the window top-left based on work area + corner.
 * Uses workArea (not bounds) so the taskbar is avoided automatically.
 */
function computeCornerPosition(
  workArea: { x: number; y: number; width: number; height: number },
  corner: Corner,
  width: number,
  height: number,
  margin: number
): { x: number; y: number } {
  switch (corner) {
    case "top-left":
      return { x: workArea.x + margin, y: workArea.y + margin };
    case "top-right":
      return { x: workArea.x + workArea.width - width - margin, y: workArea.y + margin };
    case "bottom-left":
      return { x: workArea.x + margin, y: workArea.y + workArea.height - height - margin };
    case "bottom-right":
      return {
        x: workArea.x + workArea.width - width - margin,
        y: workArea.y + workArea.height - height - margin,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const dockWindowSchema = {
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
  width: z
    .coerce.number()
    .int()
    .positive()
    .default(480)
    .describe("Window width in pixels after docking. Default 480."),
  height: z
    .coerce.number()
    .int()
    .positive()
    .default(360)
    .describe("Window height in pixels after docking. Default 360."),
  pin: z
    .boolean()
    .default(true)
    .describe(
      "If true, set always-on-top so the docked window stays visible on top of other windows. " +
      "Use unpin_window to remove the topmost flag later. Default true."
    ),
  monitorId: z
    .coerce.number()
    .int()
    .min(0)
    .optional()
    .describe("Monitor to dock on (from get_screen_info). Omit for primary monitor."),
  margin: z
    .coerce.number()
    .int()
    .min(0)
    .default(8)
    .describe("Pixel padding between the window and the screen edge. Default 8."),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const dockWindowHandler = async ({
  title,
  corner,
  width,
  height,
  pin,
  monitorId,
  margin,
}: {
  title: string;
  corner: Corner;
  width: number;
  height: number;
  pin: boolean;
  monitorId?: number;
  margin: number;
}): Promise<ToolResult> => {
  try {
    // 1. Find the target window
    const win = findWindow(title);
    if (!win) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `No window found matching: "${title}"` }),
        }],
      };
    }

    // 2. Restore if minimized OR maximized.
    //    SetWindowPos on minimized windows only updates the "restore rect" without
    //    actually moving them. On maximized windows, many apps (Chrome, Electron,
    //    Explorer) silently ignore the resize and stay maximized. SW_RESTORE handles
    //    both states.
    if (win.isMinimized || win.isMaximized) {
      restoreAndFocusWindow(win.hwnd);
    }

    // 3. Pick the target monitor and clamp sizes to its work area
    const monitors = enumMonitors();
    const mon = pickMonitor(monitors, monitorId);
    if (!mon) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: "No monitors detected" }),
        }],
      };
    }

    const wa = mon.workArea;
    // Clamp the requested size to fit within the work area (minus two margins).
    // The 100px floor guarantees a usable minimum even on tiny monitors / huge margins.
    const maxW = Math.max(100, wa.width - margin * 2);
    const maxH = Math.max(100, wa.height - margin * 2);
    const finalW = Math.min(width, maxW);
    const finalH = Math.min(height, maxH);

    // 4. Compute corner-anchored position
    const { x, y } = computeCornerPosition(wa, corner, finalW, finalH, margin);

    // 5. Move and resize
    const moved = setWindowBounds(win.hwnd, x, y, finalW, finalH);
    if (!moved) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "SetWindowPos failed — window may belong to an elevated process, or Windows denied the request",
            title: win.title,
          }),
        }],
      };
    }

    // 6. Toggle always-on-top per `pin` — capture actual result so we don't lie about the state
    let pinned = false;
    if (pin) {
      pinned = setWindowTopmost(win.hwnd);
    } else {
      clearWindowTopmost(win.hwnd);
    }

    // 7. Read back the actual rect for confirmation (may differ slightly on high-DPI)
    const actual = getWindowRectByHwnd(win.hwnd) ?? { x, y, width: finalW, height: finalH };

    const pinNote = pin && !pinned ? " (pin requested but failed)" : "";
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          title: win.title,
          corner,
          monitorId: mon.id,
          requested: { x, y, width: finalW, height: finalH },
          actual,
          pinned,
          hint: pinned
            ? "Window pinned always-on-top. Call unpin_window to release."
            : `Window positioned (not pinned)${pinNote}.`,
        }, null, 2),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `dock_window failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerDockTools(server: McpServer): void {
  server.tool(
    "dock_window",
    [
      "Snap a window to a screen corner at a small size and (optionally) pin it always-on-top.",
      "",
      "Primary use case: keep Claude CLI visible while operating other apps full-screen.",
      "Example: dock_window({ title: 'Claude Code', corner: 'bottom-right' })",
      "         → Claude CLI becomes a 480x360 window in the bottom-right corner, always-on-top.",
      "",
      "Behaviour:",
      "- title:      partial match against window titles (case-insensitive).",
      "- corner:     top-left / top-right / bottom-left / bottom-right. Default bottom-right.",
      "- width/height: default 480x360. Clamped to fit the target monitor's work area.",
      "- pin=true:   always-on-top (default). Call unpin_window to release.",
      "- monitorId:  optional — target a specific monitor (see get_screen_info).",
      "- margin:     pixels between the window and the screen edge (default 8). Avoids taskbar overlap.",
      "",
      "Minimized windows are automatically restored before docking.",
      "Snap (Win+Arrow) arrangements will be overridden.",
    ].join("\n"),
    dockWindowSchema,
    dockWindowHandler
  );
}
