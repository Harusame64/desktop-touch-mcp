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
import { ok } from "./_types.js";
import { failWith, failArgs } from "./_errors.js";
import {
  registerLensAsync,
  forgetLens,
  listLenses,
  readLens,
  getLens,
} from "../engine/perception/registry.js";
import { listEventsForTarget, deriveLensTargetKey } from "../engine/perception/target-timeline.js";
import { FLUENT_KINDS, GUARD_KINDS } from "../engine/perception/types.js";
import type { LensSpec } from "../engine/perception/types.js";
import { resolveWindowTarget } from "./_resolve-window.js";

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
        titleIncludes: z.string().min(1).optional().describe(
          "Case-insensitive substring that must appear in the window title. " +
          "The foreground window is preferred when multiple windows match. " +
          "Use '@active' to target the current foreground window."
        ),
        hwnd: z.string().max(20).optional().describe(
          "Direct window handle ID. Takes precedence over titleIncludes. " +
          "String to avoid 64-bit precision issues. Obtain from desktop_discover (windows[].hwnd)."
        ),
      }).refine(m => m.titleIncludes || m.hwnd, {
        message: "window match requires at least titleIncludes or hwnd",
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

// Extended target type that includes optional hwnd for resolution before creating the spec
type PerceptionRegisterTarget =
  | { kind: "window"; match: { titleIncludes?: string; hwnd?: string } }
  | { kind: "browserTab"; match: { urlIncludes?: string; titleIncludes?: string } };

export const perceptionRegisterHandler = async (params: {
  name: string;
  target: PerceptionRegisterTarget;
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

    // Resolve hwnd / @active → titleIncludes for window lenses
    let resolvedTarget: LensSpec["target"];
    const resolveWarnings: string[] = [];
    if (params.target.kind === "window") {
      const match = params.target.match;
      const hwndStr = match.hwnd;
      const titleIn = match.titleIncludes;
      if (hwndStr || titleIn === "@active") {
        const resolved = await resolveWindowTarget({ hwnd: hwndStr, windowTitle: titleIn });
        if (resolved) {
          resolvedTarget = { kind: "window", match: { titleIncludes: resolved.title } };
          if (resolved.warnings.length > 0) {
            resolveWarnings.push(...resolved.warnings);
          }
        } else {
          resolvedTarget = { kind: "window", match: { titleIncludes: titleIn ?? "" } };
        }
      } else {
        resolvedTarget = { kind: "window", match: { titleIncludes: titleIn ?? "" } };
      }
    } else {
      resolvedTarget = params.target as LensSpec["target"];
    }

    const spec: LensSpec = {
      name: params.name.trim(),
      target: resolvedTarget,
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
      ...(resolveWarnings.length > 0 && { hints: { warnings: resolveWarnings } }),
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
    // D-5b: include up to 10 recent timeline events for this lens's target
    const lens = getLens(params.lensId);
    const recentEvents = lens
      ? listEventsForTarget(deriveLensTargetKey(lens), 10).map(ev => ({
          tsMs:     ev.tsMs,
          semantic: ev.semantic,
          summary:  ev.summary,
          ...(ev.tool   ? { tool:   ev.tool   } : {}),
          ...(ev.result ? { result: ev.result } : {}),
        }))
      : [];
    return ok({ ok: true, ...envelope, ...(recentEvents.length > 0 && { recentEvents }) });
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

// Phase 4: perception_* tools privatized — entry-point removed, handlers
// retained as internal exports. v0.12 Auto Perception attaches the attention
// signal to desktop_state / desktop_act responses automatically, so explicit
// lens management is no longer the primary access path. The engine layer
// (perception/registry.ts, hot-target-cache, sensor loop) is unchanged; a
// facade can be re-introduced in a later phase if dogfood shows the explicit
// lens workflow is still needed.
// (memory: feedback_disable_via_entry_block.md)
export function registerPerceptionTools(_server: McpServer): void {
  // intentionally empty — handlers above remain exported.
}
