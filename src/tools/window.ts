import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveWindow } from "../engine/nutjs.js";
import { getWindowTitleW, enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { getVirtualDesktopStatus } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { listTabs, activateTab, DEFAULT_CDP_PORT } from "../engine/cdp-bridge.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration } from "./_narration.js";
import { makeCommitWrapper, withEnvelopeIncludeSchema } from "./_envelope.js";

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

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `focus_window` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — `leaseValidator` omitted; focus_window is title-driven without
 * a lease 4-tuple, mirroring PR #121 mouse_click raw shape pattern).
 *
 * `withRichNarration` (inner) → `makeCommitWrapper` (outer):
 *   - withRichNarration enriches the handler's ToolResult with post.* state
 *     (rich-narrate UIA-diff path is unreachable since `narrate` isn't in
 *     the focus_window schema — falls through to withPostState only)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 *
 * `windowTitleKey: "title"` mirrors the focus_window arg shape (the partial
 * window title is passed as `title`, not `windowTitle`, unique among the
 * commit family — sub-plan §3.1 step 4 "windowTitleKey is the literal field
 * name of the target window title in this tool's schema").
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.focus_window` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 *
 * Trunk pattern conformance: engine-perception layer 改変ゼロ
 * (expansion-pr-guard.yml + check-expansion-disjoint.mjs)、handler internal
 * logic + Zod schema + 戻り値 shape 不変 (ADR-010 §1.5)。
 */
export const focusWindowRegistrationSchema = withEnvelopeIncludeSchema(focusWindowSchema);

export const focusWindowRegistrationHandler = makeCommitWrapper(
  withRichNarration("focus_window", focusWindowHandler, { windowTitleKey: "title" }) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "focus_window",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

export function registerWindowTools(server: McpServer): void {
  // Phase 4: get_windows / get_active_window privatized — handlers retained
  // as internal exports. desktop_discover returns the windows list (with
  // zOrder / title / hwnd / region / isActive / processName) and
  // desktop_state.focusedWindow covers the active-window case.
  // (memory: feedback_disable_via_entry_block.md)

  server.tool(
    "focus_window",
    "Bring a window to the foreground by partial title match (case-insensitive). Use when a tool does not accept a windowTitle param, or when you need to switch focus before a sequence of actions. Use chromeTabUrlContains to activate a specific Chrome/Edge tab by URL substring before focusing — only the active tab's title appears in the windows list. If CDP is unavailable, chromeTabUrlContains is silently skipped — check response.hints.warnings. Returns WindowNotFound if no match exists; call desktop_discover to see available titles. Caveats: On some apps focus may be immediately stolen back (modal dialogs, UAC prompts) — verify with desktop_state after focusing.",
    focusWindowRegistrationSchema,
    focusWindowRegistrationHandler as typeof focusWindowHandler
  );
}
