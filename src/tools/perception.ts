/**
 * Reactive Perception Graph — MCP tool surface.
 *
 * 4 tools: perception_register / perception_read / perception_forget / perception_list
 *
 * Models src/tools/events.ts — same handler pattern, Tier A description for
 * register, Tier C short strings for the others.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, buildDesc } from "./_types.js";
import { failWith, failArgs } from "./_errors.js";
import {
  registerLensAsync,
  forgetLens,
  listLenses,
  readLens,
} from "../engine/perception/registry.js";
import { FLUENT_KINDS, GUARD_KINDS } from "../engine/perception/types.js";
import type { LensSpec } from "../engine/perception/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const perceptionRegisterSchema = {
  name: z.string().min(1).max(80).describe(
    "Human-readable name for this lens (e.g. 'target-editor'). Helps identify it in perception_list."
  ),
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("window"),
      match: z.object({
        titleIncludes: z.string().min(1).describe(
          "Case-insensitive substring that must appear in the window title. " +
          "The foreground window is preferred when multiple windows match."
        ),
      }),
    }),
    z.object({
      kind: z.literal("browserTab"),
      match: z.object({
        urlIncludes: z.string().min(1).optional().describe(
          "Case-insensitive substring that must appear in the tab URL."
        ),
        titleIncludes: z.string().min(1).optional().describe(
          "Case-insensitive substring that must appear in the tab title."
        ),
      }).refine(m => m.urlIncludes || m.titleIncludes, {
        message: "browserTab match requires at least urlIncludes or titleIncludes",
      }),
    }),
  ]).describe(
    "Target entity to track. 'window' targets use Win32; 'browserTab' targets use CDP " +
    "(requires Chrome/Edge running with --remote-debugging-port=9222)."
  ),
  maintain: z.array(z.enum(FLUENT_KINDS))
    .default([...FLUENT_KINDS])
    .describe(
      "Fluents to keep alive. Defaults to all fluents; irrelevant kinds for the target type are " +
      "silently ignored (e.g., browser.* fluents are skipped on window lenses)."
    ),
  guards: z.array(z.enum(GUARD_KINDS))
    .default([...GUARD_KINDS])
    .describe(
      "Guards to evaluate before actions that pass this lensId. Defaults to all guards. " +
      "Remove guards you don't need to reduce false blocks."
    ),
  guardPolicy: z.enum(["warn", "block"]).default("block").describe(
    "How guard failures are handled. 'block' (default) returns {ok:false, code:'GuardFailed'}. " +
    "'warn' allows the action through and sets attention:'guard_failed' in the envelope."
  ),
  maxEnvelopeTokens: z.number().int().min(20).max(500).default(120).describe(
    "Maximum token budget for the perception envelope attached to tool responses. " +
    "Fields are dropped in priority order when the budget is exceeded."
  ),
  salience: z.enum(["critical", "normal", "background"]).default("normal").describe(
    "Lens salience hint. 'critical' lenses are refreshed more eagerly (future use)."
  ),
};

export const perceptionReadSchema = {
  lensId: z.string().describe("Lens ID returned by perception_register."),
  maxTokens: z.number().int().min(20).max(500).optional().describe(
    "Override maxEnvelopeTokens for this read. Useful to get a richer snapshot on demand."
  ),
};

export const perceptionForgetSchema = {
  lensId: z.string().describe("Lens ID to deregister. Active sensor subscriptions are cleaned up."),
};

export const perceptionListSchema = {};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const perceptionRegisterHandler = async (params: {
  name: string;
  target: LensSpec["target"];
  maintain: string[];
  guards: string[];
  guardPolicy: "warn" | "block";
  maxEnvelopeTokens: number;
  salience: "critical" | "normal" | "background";
}) => {
  try {
    if (!params.name?.trim()) {
      return failArgs("name must not be blank", "perception_register");
    }

    const spec: LensSpec = {
      name: params.name.trim(),
      target: params.target,
      maintain: params.maintain as LensSpec["maintain"],
      guards: params.guards as LensSpec["guards"],
      guardPolicy: params.guardPolicy,
      maxEnvelopeTokens: params.maxEnvelopeTokens,
      salience: params.salience,
    };

    const result = await registerLensAsync(spec);
    return ok({
      ok: true,
      lensId: result.lensId,
      seq: result.seq,
      digest: result.digest,
      name: params.name.trim(),
      hint: `Pass lensId:'${result.lensId}' to keyboard/mouse/click tools to get guards and perception envelope.`,
    });
  } catch (err) {
    return failWith(err, "perception_register");
  }
};

export const perceptionReadHandler = async (params: {
  lensId: string;
  maxTokens?: number;
}) => {
  try {
    const envelope = await readLens(params.lensId, { maxTokens: params.maxTokens });
    return ok({ ok: true, ...envelope });
  } catch (err) {
    return failWith(err, "perception_read");
  }
};

export const perceptionForgetHandler = async (params: { lensId: string }) => {
  try {
    const removed = forgetLens(params.lensId);
    return ok({ ok: true, removed, lensId: params.lensId });
  } catch (err) {
    return failWith(err, "perception_forget");
  }
};

export const perceptionListHandler = async (_params: Record<string, never>) => {
  try {
    const lenses = listLenses();
    return ok({ ok: true, count: lenses.length, lenses });
  } catch (err) {
    return failWith(err, "perception_list");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Descriptions
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerPerceptionTools(server: McpServer): void {
  server.tool(
    "perception_register",
    buildDesc({
      purpose:
        "Register a perception lens, a lightweight live state tracker for one window or browser tab. " +
        "Use it before repeated actions so later tool calls can verify target identity, focus, " +
        "readiness, modal obstruction, and click safety without taking another screenshot.",
      details:
        "Returns a lensId that can be passed to action tools such as keyboard_type, keyboard_press, " +
        "mouse_click, browser_click_element, and browser_navigate. When a tool receives lensId, " +
        "desktop-touch refreshes the tracked state, evaluates safety guards, and attaches a compact " +
        "post.perception envelope to the response. The envelope reports attention, guard status, " +
        "recent changes, and the latest known target state, reducing get_context/screenshot round trips.",
      prefer:
        "Use for multi-step workflows on the same app window or browser tab, especially before " +
        "typing, clicking coordinates, navigating browser tabs, or acting after focus may have changed. " +
        "It is most useful when mistakes would be costly, such as typing into the wrong window or " +
        "clicking stale coordinates.",
      caveats:
        "A lens is not a visual recognition model. It tracks structured state from Win32, CDP, and " +
        "optional UIA sensors. safe.clickCoordinates checks window bounds, not pixel-level occlusion. " +
        "browserTab lenses require Chrome/Edge with --remote-debugging-port=9222. If attention is " +
        "dirty, stale, settling, guard_failed, or identity_changed, follow the suggested action before " +
        "continuing. Maximum 16 active lenses are kept; old lenses may be evicted.",
      examples: [
        "perception_register({name:'editor', target:{kind:'window', match:{titleIncludes:'Visual Studio Code'}}})" +
          " → {lensId:'perc-1'}",
        "keyboard_type({windowTitle:'Visual Studio Code', text:'hello', lensId:'perc-1'})" +
          " → response includes post.perception",
        "perception_read({lensId:'perc-1'})" +
          " → force a fresh envelope when attention is dirty/stale",
        "perception_forget({lensId:'perc-1'})" +
          " → release tracking when the workflow is done",
      ],
    }),
    perceptionRegisterSchema,
    perceptionRegisterHandler
  );
  server.tool(
    "perception_read",
    "Force-refresh a registered perception lens and return a full perception envelope. " +
    "Use when post.perception.attention is dirty, stale, settling, guard_failed, or identity_changed, " +
    "or when you need fresh structured state before the next action. Returns attention, guard results, " +
    "latest target/browser state, changed fields, and suggested recovery actions. Prefer this over " +
    "screenshot/get_context when a lens already exists.",
    perceptionReadSchema,
    perceptionReadHandler
  );
  server.tool(
    "perception_forget",
    "Deregister a perception lens and release its tracking resources. Use when a workflow is complete, " +
    "when attention is identity_changed, or before re-registering a target that was closed, restarted, " +
    "or replaced. Removes the lens from guard evaluation, resource listings, and sensor subscriptions. " +
    "Returns whether a lens was removed.",
    perceptionForgetSchema,
    perceptionForgetHandler
  );
  server.tool(
    "perception_list",
    "List all active perception lenses. Use when you need to find an existing lensId, verify which " +
    "windows or browser tabs are being tracked, or clean up stale lenses before starting a new workflow. " +
    "Returns lensId, name, target kind, guardPolicy, salience, attention, and registration metadata.",
    perceptionListSchema,
    perceptionListHandler
  );
}
