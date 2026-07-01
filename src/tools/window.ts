import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveWindow } from "../engine/nutjs.js";
import { getWindowTitleW, enumWindowsInZOrder, restoreAndFocusWindow, isExcludedWindowHandle } from "../engine/win32.js";
import { getVirtualDesktopStatus } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { listTabs, activateTab, DEFAULT_CDP_PORT } from "../engine/cdp-bridge.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
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
  forceFocus: coercedBoolean().optional().describe(
    "When set, use AttachThreadInput-based foreground escalation on the first attempt. " +
    "When omitted (default), focus_window first tries the standard SetForegroundWindow path " +
    "and auto-escalates to force-focus only if Win11 refused the default attempt (issue #197). " +
    "Override env: DESKTOP_TOUCH_FORCE_FOCUS=1 sets the implicit default to true. " +
    "If both default and force paths fail, focus_window now returns ok:false code:'ForegroundRestricted' " +
    "instead of the previous silent ok:true with windowChanged:false."
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
    // R3: getActiveWindow() is nut-js's UNWRAPPED foreground read (bypasses resolveWindowTarget's
    // @active refusal). If the key locker's dialog is foreground, refuse rather than surfacing its
    // title + exact rect (a by-identity observation that would feed coordinate targeting). Only a
    // non-null handle — a null/absent foreground handle is never the locker (null-sentinel: Codex P2).
    if (hwnd != null && isExcludedWindowHandle(hwnd)) {
      return failWith(
        "The active window is the desktop-touch key locker, which is excluded from automation tools.",
        "get_active_window",
      );
    }
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
  forceFocus,
}: {
  title: string;
  chromeTabUrlContains?: string;
  cdpPort: number;
  forceFocus?: boolean;
}): Promise<ToolResult> => {
  // Issue #197: caller-explicit forceFocus wins; otherwise honor the env
  // override (same convention as keyboard / mouse_click / terminal_send).
  const force = forceFocus ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
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

      // ── Issue #197: foreground-transfer auto-escalation ─────────────────
      // Pre-fix behaviour was: call SetForegroundWindow once and return
      // ok:true regardless of whether Win11 actually transferred the
      // foreground. Win11 silently refuses SetForegroundWindow when the
      // calling thread is not foreground (a regular condition for an MCP
      // server proxied by another process), so callers got ok:true +
      // windowChanged:false and acted on the wrong target.
      //
      // New contract (mirrors keyboard.ts:344-395 focusWindowForKeyboard):
      //   1. Try restoreAndFocusWindow(hwnd, { force }) — honors caller
      //      flag (or DESKTOP_TOUCH_FORCE_FOCUS env). SW_RESTORE is a
      //      no-op for non-minimized windows.
      //   2. Wait 100ms for the window manager to settle.
      //   3. Re-enum and check whether the target hwnd is now isActive.
      //   4. If not, and the first attempt was NOT force, escalate to
      //      restoreAndFocusWindow(hwnd, { force:true }) (AttachThreadInput
      //      bypass) and retry steps 2-3.
      //   5. If still not foreground, return ok:false with
      //      `ForegroundRestricted` (typed via _errors.ts:SUGGESTS) —
      //      callers stop trusting a silent ok:true and choose a fallback.
      let region = restoreAndFocusWindow(win.hwnd, { force });
      await new Promise<void>((r) => setTimeout(r, 100));
      let active = enumWindowsInZOrder().find((w) => w.isActive);
      let reachedForeground = !!active && active.hwnd === win.hwnd;
      let escalated = false;

      if (!reachedForeground && !force) {
        region = restoreAndFocusWindow(win.hwnd, { force: true });
        await new Promise<void>((r) => setTimeout(r, 100));
        active = enumWindowsInZOrder().find((w) => w.isActive);
        reachedForeground = !!active && active.hwnd === win.hwnd;
        escalated = true;
      }

      if (!reachedForeground) {
        // suggest[] from _errors.ts:SUGGESTS.ForegroundRestricted (SSOT).
        // failWith treats the 3rd arg as flat: only ROOT_HOISTED_KEYS
        // (_perceptionForPost / _richForPost / hints) are lifted to the
        // root, everything else goes into `context: {...}` automatically.
        return failWith(
          new Error("ForegroundRestricted"),
          "focus_window",
          {
            title,
            hint: "Win11 refused both default SetForegroundWindow and the AttachThreadInput escalation",
            attemptedForce: force,
            autoEscalated: escalated,
            ...(active && { actualForeground: active.title }),
          }
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            focused: win.title,
            region,
            ...(activatedTab && { activatedTab }),
            ...((cdpUnavailable || escalated) && {
              hints: {
                ...(cdpUnavailable && { warnings: ["cdpUnavailable — chromeTabUrlContains was ignored; use browser_open first"] }),
                ...(escalated && { forceFocusEscalated: true }),
              },
            }),
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
    "Bring a window to the foreground by partial title match (case-insensitive). Use when a tool does not accept a windowTitle param, or when you need to switch focus before a sequence of actions. Use chromeTabUrlContains to activate a specific Chrome/Edge tab by URL substring before focusing — only the active tab's title appears in the windows list. If CDP is unavailable, chromeTabUrlContains is silently skipped — check response.hints.warnings. Returns WindowNotFound if no match exists; call desktop_discover to see available titles. Caveats: On some apps focus may be immediately stolen back (modal dialogs, UAC prompts) — verify with desktop_state after focusing. Win11 foreground refusal (UIPI cross-elevation / admin-only target / call from a background process or service) returns code:'ForegroundRestricted' ok:false instead of silently failing — recover by switching to a tool that does not require foreground transfer: desktop_act / click_element use UIA InvokePattern (no foreground needed); keyboard BG path bypasses foreground for terminal-class targets only (Windows Terminal / cmd / PowerShell — keyboard with windowTitle on non-terminal apps still hits the same ForegroundRestricted refusal). browser_* tools target by tabId/selector, not windowTitle.",
    focusWindowRegistrationSchema,
    focusWindowRegistrationHandler as typeof focusWindowHandler
  );
}
