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
  registerLens,
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
  target: z.object({
    kind: z.literal("window"),
    match: z.object({
      titleIncludes: z.string().min(1).describe(
        "Case-insensitive substring that must appear in the window title. " +
        "The foreground window is preferred when multiple windows match."
      ),
    }),
  }).describe("Target entity to track. MVP supports window targets only."),
  maintain: z.array(z.enum(FLUENT_KINDS))
    .default([...FLUENT_KINDS])
    .describe(
      "Fluents to keep alive. Defaults to all MVP fluents: exists, identity, title, rect, " +
      "foreground, zOrder, modal.above."
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
  target: { kind: "window"; match: { titleIncludes: string } };
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

    const result = registerLens(spec);
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
    const envelope = readLens(params.lensId, { maxTokens: params.maxTokens });
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

const perceptionRegisterDesc = buildDesc({
  purpose:
    "Register a standing perception lens on a target window. " +
    "The MCP server will maintain Win32-backed fluents (position, foreground, identity, modal " +
    "obstruction) and evaluate safety guards before actions that reference this lens.",
  details:
    "Creates a PerceptionLens bound to the first foreground window whose title matches " +
    "titleIncludes. Immediately reads Win32 state to populate fluents (exists, identity, " +
    "title, rect, foreground, zOrder, modal.above). Returns a lensId to pass to action tools " +
    "(keyboard_type, mouse_click, etc.) via the lensId parameter. When lensId is provided, " +
    "the tool: (1) refreshes fluents just before acting, (2) evaluates guards, (3) blocks " +
    "(guardPolicy:'block') or warns (guardPolicy:'warn') if any guard fails, and (4) attaches " +
    "a perception envelope to post.perception in the response so the LLM can see what changed " +
    "without an extra get_context call. The sensor runs on the existing 500 ms event-bus tick " +
    "(no new polling timer). Maximum 16 active lenses; oldest is evicted when exceeded.",
  prefer:
    "Use when you need keyboard/mouse safety across multiple actions on the same window: " +
    "prevents typing into wrong window after focus changes, detects moved windows before " +
    "coordinate clicks, and surfaces modal dialogs before they cause errors. Not needed for " +
    "single one-shot actions.",
  caveats:
    "Win32 sensors + modal owner-chain detection. modal.above uses disabled-owner, direct ownership, " +
    "#32770 class, and WS_EX_TOPMOST rules (cloaked/tooltip windows filtered). " +
    "No UIA focused-element push or CDP navigation events yet. " +
    "safe.clickCoordinates uses rect containment only (no pixel-level z-order hit test). " +
    "Browser tab-level fluents (readyState, URL) defer to a future release.",
  examples: [
    "perception_register({name:'editor', target:{kind:'window', match:{titleIncludes:'Visual Studio Code'}}})" +
      " → {lensId:'perc-1', ...}",
    "keyboard_type({windowTitle:'Visual Studio Code', text:'hello', lensId:'perc-1'})" +
      " → includes post.perception.{attention, guards, latest}",
    "perception_read({lensId:'perc-1'})" +
      " → explicit refresh + full envelope when you want to inspect state without acting",
  ],
});

const perceptionReadDesc =
  "Force-refresh Win32 fluents for a lens and return a full perception envelope. " +
  "Use after an action that may have changed window state, or when post.perception.attention " +
  "is 'dirty' or 'stale'. Returns {ok, seq, attention, guards, latest, changed}.";

const perceptionForgetDesc =
  "Deregister a lens by lensId. Removes it from the dependency graph and cleans up its " +
  "event-bus subscription when no other lenses remain. Returns {ok, removed, lensId}.";

const perceptionListDesc =
  "List all currently active perception lenses with their lensId, name, target window, " +
  "guardPolicy, salience, and registration time. Returns {ok, count, lenses[]}.";

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerPerceptionTools(server: McpServer): void {
  server.tool(
    "perception_register",
    buildDesc({
      purpose:
        "Register a standing perception lens on a target window. " +
        "The MCP server will maintain Win32-backed fluents (position, foreground, identity, modal " +
        "obstruction) and evaluate safety guards before actions that reference this lens.",
      details:
        "Creates a PerceptionLens bound to the first foreground window whose title matches " +
        "titleIncludes. Immediately reads Win32 state to populate fluents (exists, identity, " +
        "title, rect, foreground, zOrder, modal.above). Returns a lensId to pass to action tools " +
        "(keyboard_type, mouse_click, etc.) via the lensId parameter. When lensId is provided, " +
        "the tool: (1) refreshes fluents just before acting, (2) evaluates guards, (3) blocks " +
        "(guardPolicy:'block') or warns (guardPolicy:'warn') if any guard fails, and (4) attaches " +
        "a perception envelope to post.perception in the response so the LLM can see what changed " +
        "without an extra get_context call. The sensor runs on the existing 500 ms event-bus tick " +
        "(no new polling timer). Maximum 16 active lenses; oldest is evicted when exceeded.",
      prefer:
        "Use when you need keyboard/mouse safety across multiple actions on the same window: " +
        "prevents typing into wrong window after focus changes, detects moved windows before " +
        "coordinate clicks, and surfaces modal dialogs before they cause errors. Not needed for " +
        "single one-shot actions.",
      caveats:
        "MVP (v0.9): Win32 sensors only — no UIA focused-element push, no CDP navigation events. " +
        "modal.above uses title-regex + WS_EX_TOPMOST heuristic (may miss some native modals). " +
        "safe.clickCoordinates uses rect containment only (no pixel-level z-order hit test). " +
        "Browser tab-level fluents (readyState, URL) defer to a future release.",
      examples: [
        "perception_register({name:'editor', target:{kind:'window', match:{titleIncludes:'Visual Studio Code'}}})" +
          " → {lensId:'perc-1', ...}",
        "keyboard_type({windowTitle:'Visual Studio Code', text:'hello', lensId:'perc-1'})" +
          " → includes post.perception.{attention, guards, latest}",
        "perception_read({lensId:'perc-1'})" +
          " → explicit refresh + full envelope when you want to inspect state without acting",
      ],
    }),
    perceptionRegisterSchema,
    perceptionRegisterHandler
  );
  server.tool(
    "perception_read",
    "Force-refresh Win32 fluents for a lens and return a full perception envelope. " +
    "Use after an action that may have changed window state, or when post.perception.attention " +
    "is 'dirty' or 'stale'. Returns {ok, seq, attention, guards, latest, changed}.",
    perceptionReadSchema,
    perceptionReadHandler
  );
  server.tool(
    "perception_forget",
    "Deregister a lens by lensId. Removes it from the dependency graph and cleans up its " +
    "event-bus subscription when no other lenses remain. Returns {ok, removed, lensId}.",
    perceptionForgetSchema,
    perceptionForgetHandler
  );
  server.tool(
    "perception_list",
    "List all currently active perception lenses with their lensId, name, target window, " +
    "guardPolicy, salience, and registration time. Returns {ok, count, lenses[]}.",
    perceptionListSchema,
    perceptionListHandler
  );
}
