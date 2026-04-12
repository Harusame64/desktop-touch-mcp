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
  findAncestorWindow,
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

interface DockResult {
  ok: boolean;
  error?: string;
  title?: string;
  corner?: Corner;
  monitorId?: number;
  requested?: { x: number; y: number; width: number; height: number };
  actual?: { x: number; y: number; width: number; height: number };
  pinned?: boolean;
  hint?: string;
}

/**
 * Low-level dock: position + resize + pin a window given its HWND and title.
 * Shared by the MCP tool handler (which finds the HWND via title) and the
 * auto-dock flow (which may resolve the HWND via process-tree walk for @parent).
 */
function dockKnownWindow(
  win: { hwnd: unknown; title: string; isMinimized: boolean; isMaximized: boolean },
  opts: { corner: Corner; width: number; height: number; pin: boolean; monitorId?: number; margin: number }
): DockResult {
  const { corner, width, height, pin, monitorId, margin } = opts;

  // Restore minimized/maximized windows first — SetWindowPos is unreliable otherwise.
  if (win.isMinimized || win.isMaximized) {
    restoreAndFocusWindow(win.hwnd);
  }

  const monitors = enumMonitors();
  const mon = pickMonitor(monitors, monitorId);
  if (!mon) return { ok: false, error: "No monitors detected" };

  const wa = mon.workArea;
  const maxW = Math.max(100, wa.width - margin * 2);
  const maxH = Math.max(100, wa.height - margin * 2);
  const finalW = Math.min(width, maxW);
  const finalH = Math.min(height, maxH);

  const { x, y } = computeCornerPosition(wa, corner, finalW, finalH, margin);

  const moved = setWindowBounds(win.hwnd, x, y, finalW, finalH);
  if (!moved) {
    return {
      ok: false,
      title: win.title,
      error: "SetWindowPos failed — window may belong to an elevated process, or Windows denied the request",
    };
  }

  let pinned = false;
  if (pin) pinned = setWindowTopmost(win.hwnd);
  else clearWindowTopmost(win.hwnd);

  const actual = getWindowRectByHwnd(win.hwnd) ?? { x, y, width: finalW, height: finalH };
  const pinNote = pin && !pinned ? " (pin requested but failed)" : "";

  return {
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
  };
}

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
    const win = findWindow(title);
    if (!win) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `No window found matching: "${title}"` }),
        }],
      };
    }
    const result = dockKnownWindow(win, { corner, width, height, pin, monitorId, margin });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `dock_window failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-dock from environment variables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a dimension spec ("480", "25%", undefined) to pixels.
 * - "NN%": ratio of the work-area dimension
 * - "NN":  absolute pixels; if scaleDpi, multiplied by (dpi / 96)
 * - undefined: fallback, also DPI-scaled if scaleDpi
 */
export function resolveDimSpec(
  spec: string | undefined,
  fallbackPx: number,
  workAreaDim: number,
  dpi: number,
  scaleDpi: boolean
): number {
  if (spec && spec.trim().endsWith("%")) {
    const pct = parseFloat(spec);
    if (Number.isFinite(pct) && pct > 0) {
      return Math.max(100, Math.round((workAreaDim * pct) / 100));
    }
  }
  const raw = spec !== undefined && spec.trim() !== "" ? parseFloat(spec) : fallbackPx;
  const px = Number.isFinite(raw) && raw > 0 ? raw : fallbackPx;
  return Math.round(scaleDpi ? (px * dpi) / 96 : px);
}

export function parseCorner(s: string | undefined): Corner {
  switch ((s ?? "").toLowerCase()) {
    case "top-left":
    case "top-right":
    case "bottom-left":
    case "bottom-right":
      return s!.toLowerCase() as Corner;
    default:
      return "bottom-right";
  }
}

export function parseBoolEnv(s: string | undefined, fallback: boolean): boolean {
  if (s === undefined) return fallback;
  const v = s.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Auto-dock a window based on environment variables. No-op if DESKTOP_TOUCH_DOCK_TITLE is unset.
 *
 * Env vars (all optional except DOCK_TITLE which acts as the on/off switch):
 *   DESKTOP_TOUCH_DOCK_TITLE     — partial title match, OR "@parent" to auto-detect
 *                                  the terminal window hosting this MCP server via the
 *                                  process-tree walk. "@parent" is more robust because
 *                                  it survives project / branch / title changes.
 *   DESKTOP_TOUCH_DOCK_CORNER    — top-left | top-right | bottom-left | bottom-right (default bottom-right)
 *   DESKTOP_TOUCH_DOCK_WIDTH     — px ("480") or ratio ("25%") of work area (default 480)
 *   DESKTOP_TOUCH_DOCK_HEIGHT    — px ("360") or ratio ("25%") of work area (default 360)
 *   DESKTOP_TOUCH_DOCK_PIN       — true/false (default true)
 *   DESKTOP_TOUCH_DOCK_MONITOR   — monitor id (default primary)
 *   DESKTOP_TOUCH_DOCK_MARGIN    — px padding from screen edge (default 8)
 *   DESKTOP_TOUCH_DOCK_SCALE_DPI — scale px values by dpi/96 (default false). Ratio values are unaffected.
 *   DESKTOP_TOUCH_DOCK_TIMEOUT_MS — how long to wait for the target window (default 5000)
 */
export async function autoDockFromEnv(): Promise<void> {
  const title = process.env.DESKTOP_TOUCH_DOCK_TITLE;
  if (!title || title.trim() === "") return; // feature disabled

  const corner = parseCorner(process.env.DESKTOP_TOUCH_DOCK_CORNER);
  const pin = parseBoolEnv(process.env.DESKTOP_TOUCH_DOCK_PIN, true);
  const scaleDpi = parseBoolEnv(process.env.DESKTOP_TOUCH_DOCK_SCALE_DPI, false);
  const marginRaw = process.env.DESKTOP_TOUCH_DOCK_MARGIN;
  const timeoutMs = (() => {
    const t = parseInt(process.env.DESKTOP_TOUCH_DOCK_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(t) && t > 0 ? t : 5000;
  })();
  const monitorIdRaw = process.env.DESKTOP_TOUCH_DOCK_MONITOR;
  const monitorId = monitorIdRaw !== undefined && monitorIdRaw.trim() !== ""
    ? parseInt(monitorIdRaw, 10)
    : undefined;

  // Resolve which window to dock. "@parent" = walk up the process tree from this
  // MCP server to find the terminal window hosting Claude Code. Anything else = title match.
  const useParent = title.trim() === "@parent";

  let win: WindowZInfo | { hwnd: bigint; title: string; region: { x: number; y: number; width: number; height: number }; isMinimized: boolean; isMaximized: boolean } | null = null;
  const pollInterval = 200;
  const deadline = Date.now() + timeoutMs;

  if (useParent) {
    // findAncestorWindow returns immediately; our parent terminal is almost
    // always already visible when the MCP server starts, but retry briefly
    // in case of race conditions on cold start.
    while (Date.now() < deadline) {
      const found = findAncestorWindow(process.pid);
      if (found) {
        win = { ...found, isMinimized: false, isMaximized: false };
        break;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    if (!win) {
      console.error(
        `[desktop-touch] auto-dock: no ancestor window found for pid ${process.pid} within ${timeoutMs}ms — skipping`
      );
      return;
    }
  } else {
    while (Date.now() < deadline) {
      win = findWindow(title);
      if (win) break;
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    if (!win) {
      console.error(`[desktop-touch] auto-dock: window "${title}" not found within ${timeoutMs}ms — skipping`);
      return;
    }
  }

  // Resolve dimensions against the chosen monitor's workArea + DPI
  const monitors = enumMonitors();
  const mon = pickMonitor(monitors, Number.isFinite(monitorId) ? monitorId : undefined);
  if (!mon) {
    console.error("[desktop-touch] auto-dock: no monitors detected — skipping");
    return;
  }

  const width = resolveDimSpec(process.env.DESKTOP_TOUCH_DOCK_WIDTH, 480, mon.workArea.width, mon.dpi, scaleDpi);
  const height = resolveDimSpec(process.env.DESKTOP_TOUCH_DOCK_HEIGHT, 360, mon.workArea.height, mon.dpi, scaleDpi);
  const margin = (() => {
    const m = parseInt(marginRaw ?? "", 10);
    return Number.isFinite(m) && m >= 0 ? m : 8;
  })();

  try {
    // Call the low-level dock directly — we already have the exact HWND from
    // findWindow() / findAncestorWindow() above, so there's no need to re-resolve by title.
    const result = dockKnownWindow(win, {
      corner,
      width,
      height,
      pin,
      monitorId: mon.id,
      margin,
    });
    if (result.ok) {
      const mode = useParent ? "@parent" : `title="${title}"`;
      console.error(
        `[desktop-touch] auto-dock: ${mode} → "${result.title}" @ ${corner} ` +
        `${result.actual?.width}x${result.actual?.height} on monitor ${mon.id} ` +
        `(dpi ${mon.dpi}, scaleDpi=${scaleDpi}, pinned=${result.pinned})`
      );
    } else {
      console.error(`[desktop-touch] auto-dock failed: ${result.error}`);
    }
  } catch (err) {
    console.error("[desktop-touch] auto-dock threw:", err);
  }
}

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
