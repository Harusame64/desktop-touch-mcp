import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { showBalloonTip } from "../utils/balloon.js";
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
    // ADR-030 Phase 1 W2: the raw NotifyIcon helper lives in
    // `src/utils/balloon.ts` (shared with the failsafe notification paths);
    // this handler is a thin tool wrapper around it.
    await showBalloonTip(title, body);

    return ok({
      ok: true,
      title,
      body,
      hints: {
        verifyDelivery: {
          status: "unverifiable",
          reason: "user_visible_side_effect_uninspectable",
          channel: "win32_balloon_tip",
        },
      },
    });
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
    'Show a Windows system tray balloon notification to alert the user. Use at the end of a long-running task so the user knows it finished without watching the screen. Caveats: toast の user reach は原理的に観測不能 (matrix §3.1 line 158 規範整合)。Focus Assist (Do Not Disturb) / Notifications-off setting / consent UI sink いずれも tool 側からは判別不能のため、successful response は常に hints.verifyDelivery を含む (status="unverifiable", reason="user_visible_side_effect_uninspectable", channel="win32_balloon_tip" — 全 double-quoted JSON literal)。caller は user 側の post-notification behavior (例: wait_until(focus_changes)) で間接観測することが望ましい。Uses System.Windows.Forms — no external modules needed.',
    notificationShowRegistrationSchema,
    notificationShowRegistrationHandler as typeof notificationShowHandler
  );
}
