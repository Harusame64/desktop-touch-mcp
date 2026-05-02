import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration } from "./_narration.js";
import { makeCommitWrapper, withEnvelopeIncludeSchema } from "./_envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const notificationShowSchema = {
  title: z.string().max(200).describe("Notification title"),
  body: z.string().max(500).describe("Notification body text"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const notificationShowHandler = async ({
  title,
  body,
}: {
  title: string;
  body: string;
}): Promise<ToolResult> => {
  try {
    // Escape single quotes in user-supplied strings for PowerShell embedding
    const safeTitle = title.replace(/'/g, "''");
    const safeBody = body.replace(/'/g, "''");

    // System.Windows.Forms.NotifyIcon balloon tip — no WinRT dependency,
    // no external modules. Works on Windows 10 / 11.
    // The sleep ensures the balloon stays alive before the PowerShell process exits.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$icon = [System.Drawing.SystemIcons]::Information",
      "$notify = New-Object System.Windows.Forms.NotifyIcon",
      "$notify.Icon = $icon",
      "$notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info",
      `$notify.BalloonTipTitle = '${safeTitle}'`,
      `$notify.BalloonTipText = '${safeBody}'`,
      "$notify.Visible = $true",
      "$notify.ShowBalloonTip(6000)",
      "Start-Sleep -Milliseconds 6500",
      "$notify.Dispose()",
    ].join("; ");

    // Fire-and-forget — spawn PowerShell, unref immediately so Node doesn't wait for it.
    // The 6.5 s sleep inside the PS script keeps the balloon alive without blocking MCP.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 15000 }
      );
      child.on("spawn", () => {
        // Detach from the Node process lifecycle — child runs independently
        child.unref();
        resolve();
      });
      child.on("error", (err) => reject(err));
    });

    return ok({ ok: true, title, body });
  } catch (err) {
    return failWith(err, "notification_show");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `notification_show` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — `leaseValidator` omitted; OS-level balloon tip without a lease
 * 4-tuple, mirroring PR #126 clipboard pattern for OS-level tools).
 *
 * `windowTitleKey` is omitted because notification_show has no window-scoped
 * target (system tray balloon is OS-level regardless of foreground window).
 * `withRichNarration` falls through to `withPostState` only since `narrate`
 * isn't in the schema.
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.notification_show` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 */
export const notificationShowRegistrationSchema = withEnvelopeIncludeSchema(notificationShowSchema);

export const notificationShowRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "notification_show",
    notificationShowHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "notification_show",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

export function registerNotificationTools(server: McpServer): void {
  server.tool(
    "notification_show",
    "Show a Windows system tray balloon notification to alert the user. Use at the end of a long-running task so the user knows it finished without watching the screen. Caveats: Focus Assist (Do Not Disturb) mode suppresses balloon tips; the tool still returns ok:true in that case. Uses System.Windows.Forms — no external modules needed.",
    notificationShowRegistrationSchema,
    notificationShowRegistrationHandler as typeof notificationShowHandler
  );
}
