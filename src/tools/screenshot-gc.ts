import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration } from "./_narration.js";
import { gcCache, envDefaultPolicy } from "../engine/screenshot-cache.js";
import type { GcPolicy } from "../engine/screenshot-cache.js";
import { makeCommitWrapper, withEnvelopeIncludeSchema } from "./_envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema (ADR-026 Phase 3 — reclaim disk-cached screenshots by retention policy)
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotGcSchema = {
  dryRun: z
    .boolean()
    .optional()
    .describe("Default true: only LIST what would be deleted, delete nothing. Set false (with confirm:true) to actually delete."),
  confirm: z
    .boolean()
    .optional()
    .describe("Safety gate: deletion happens ONLY when dryRun:false AND confirm:true. Otherwise the call is forced to a dry run."),
  maxAgeMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Delete captures older than this many milliseconds (opt-in; can clear even the newest)."),
  maxCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Keep only the newest N captures; delete the rest. The single newest is always kept."),
  maxTotalBytes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Keep the newest captures under this total byte budget; delete older ones beyond it. The newest is always kept."),
  tag: z
    .string()
    .optional()
    .describe("Limit deletion to captures under this tag (case-insensitive). Other tags are never touched."),
  includeOrphans: z
    .boolean()
    .optional()
    .describe("Default true: also reclaim leftover on-disk image files that have no index entry (crash/fold residue)."),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotGcHandler = async (args: {
  dryRun?: boolean;
  confirm?: boolean;
  maxAgeMs?: number;
  maxCount?: number;
  maxTotalBytes?: number;
  tag?: string;
  includeOrphans?: boolean;
}): Promise<ToolResult> => {
  try {
    const dryRun = args.dryRun ?? true;
    const confirm = args.confirm ?? false;
    // Double gate: a real delete requires BOTH dryRun:false AND confirm:true.
    // Any other combination is forced back to a dry run (nothing is deleted).
    const effectiveDryRun = !(dryRun === false && confirm === true);

    // Start from the env retention defaults (so a bare gc still bounds the cache),
    // then override with any explicit caps the caller passed.
    const policy: GcPolicy = {
      ...envDefaultPolicy(),
      ...(args.maxAgeMs !== undefined ? { maxAgeMs: args.maxAgeMs } : {}),
      ...(args.maxCount !== undefined ? { maxCount: args.maxCount } : {}),
      ...(args.maxTotalBytes !== undefined ? { maxTotalBytes: args.maxTotalBytes } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
    };

    const result = gcCache({
      dryRun: effectiveDryRun,
      policy,
      includeOrphans: args.includeOrphans ?? true,
      now: Date.now(),
    });

    return ok({ ...result, requested: { dryRun, confirm } });
  } catch (err) {
    return failWith(err, "screenshot_gc");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OS-level maintenance mutation (deletes disk-cache files, no desktop world-graph
 * effect, no lease) — wrapped via `makeCommitWrapper` lease-less, matching the
 * notification_show / clipboard / workspace_launch OS-level pattern
 * (`withRichNarration` with no windowTitleKey → no window-scoped post-state). Not
 * callable from `run_macro` (a maintenance surface), so no TOOL_REGISTRY entry.
 */
export const screenshotGcRegistrationSchema = withEnvelopeIncludeSchema(screenshotGcSchema);

export const screenshotGcRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "screenshot_gc",
    screenshotGcHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "screenshot_gc",
  {
    // leaseValidator omitted = lease-less commit variant (OS-level, no lease 4-tuple)
  },
);

export function registerScreenshotGcTool(server: McpServer): void {
  server.tool(
    "screenshot_gc",
    "Reclaim disk space from cached screenshots by retention policy. By DEFAULT this is a " +
      "dry run: it returns the captures that WOULD be deleted (candidates) plus a count/size " +
      "of leftover orphan files, and deletes nothing. To actually delete, pass BOTH " +
      "dryRun:false AND confirm:true. Retention caps (all optional): maxCount (keep newest N), " +
      "maxTotalBytes (keep newest under a byte budget), maxAgeMs (delete older than). When you " +
      "pass none, the cache's env defaults apply (newest 200 / 256 MiB). Scope to a single tag " +
      "with tag (other tags are never touched); includeOrphans (default true) also reclaims " +
      "leftover on-disk files with no index entry. The newest capture is always kept by the " +
      "count/byte caps. Only ever touches files inside the screenshot cache — never any other path.",
    screenshotGcRegistrationSchema,
    screenshotGcRegistrationHandler as typeof screenshotGcHandler
  );
}
