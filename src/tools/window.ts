import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveWindow } from "../engine/nutjs.js";
import { getWindowTitleW, enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { getVirtualDesktopStatus } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { listTabs, activateTab, DEFAULT_CDP_PORT } from "../engine/cdp-bridge.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getWindowsSchema = {};

export const getActiveWindowSchema = {};

export const focusWindowSchema = {
  title: z.string().describe("Partial window title to search for (case-insensitive)"),
  chromeTabUrlContains: z.string().optional().describe(
    "When set, activate the Chrome/Edge tab whose URL contains this substring before focusing the window. " +
    "Requires Chrome/Edge running with --remote-debugging-port (default 9222). " +
    "Use this when the target is a Chrome tab that is not currently active — " +
    "the active tab title is the only one visible in the window title list."
  ),
  cdpPort: z.coerce.number().int().min(1).max(65535).default(DEFAULT_CDP_PORT).describe(
    `CDP port for chromeTabUrlContains (default ${DEFAULT_CDP_PORT})`
  ),
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

export const focusWindowHandler = async ({
  title,
  chromeTabUrlContains,
  cdpPort,
}: {
  title: string;
  chromeTabUrlContains?: string;
  cdpPort: number;
}): Promise<ToolResult> => {
  try {
    // If chromeTabUrlContains is set, activate the matching Chrome tab first via CDP
    let activatedTab: string | undefined;
    let cdpUnavailable: boolean | undefined;
    if (chromeTabUrlContains) {
      try {
        const tabs = await listTabs(cdpPort);
        const target = tabs.find(
          (t) => t.type === "page" && t.url.includes(chromeTabUrlContains)
        );
        if (target) {
          await activateTab(target.id, cdpPort);
          activatedTab = target.title;
          // Brief settle so Chrome updates the HWND title to the newly active tab
          await new Promise<void>((r) => setTimeout(r, 200));
        }
      } catch {
        // CDP unavailable — fall through to title-based window match, but surface the fact
        cdpUnavailable = true;
      }
    }

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
            ...(activatedTab && { activatedTab }),
            ...(cdpUnavailable && { hints: { warnings: ["cdpUnavailable — chromeTabUrlContains was ignored; use browser_open first"] } }),
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
    "Bring a window to the foreground by partial title match (case-insensitive). Use when a tool does not accept a windowTitle param, or when you need to switch focus before a sequence of actions. Use chromeTabUrlContains to activate a specific Chrome/Edge tab by URL substring before focusing — only the active tab's title appears in get_windows. If CDP is unavailable, chromeTabUrlContains is silently skipped — check response.hints.warnings. Returns WindowNotFound if no match exists; call get_windows to see available titles. Caveats: On some apps focus may be immediately stolen back (modal dialogs, UAC prompts) — verify with desktop_state after focusing.",
    focusWindowSchema,
    focusWindowHandler
  );
}
