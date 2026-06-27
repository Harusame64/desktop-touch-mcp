import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { queryCaptures } from "../engine/screenshot-cache.js";
import {
  makeQueryWrapper,
  withEnvelopeIncludeSchema,
  genericQueryCausedByProjector,
  defaultQuerySessionId,
} from "./_envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema (ADR-026 Phase 3 — read-only listing of the screenshot disk-cache)
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotQuerySchema = {
  tag: z
    .string()
    .optional()
    .describe("Filter to captures stored under this tag (case-insensitive). Omit to list all."),
  windowUuid: z
    .string()
    .optional()
    .describe("Filter to captures of a specific window (the window's stable id)."),
  since: z
    .number()
    .int()
    .optional()
    .describe("Only captures taken at/after this time (epoch milliseconds, inclusive)."),
  until: z
    .number()
    .int()
    .optional()
    .describe("Only captures taken at/before this time (epoch milliseconds, inclusive)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum rows to return, newest first (default 50, max 500)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rows to skip from the newest end, for paging (default 0)."),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotQueryHandler = async (args: {
  tag?: string;
  windowUuid?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}): Promise<ToolResult> => {
  try {
    const result = queryCaptures({
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
      ...(args.windowUuid !== undefined ? { windowUuid: args.windowUuid } : {}),
      ...(args.since !== undefined ? { since: args.since } : {}),
      ...(args.until !== undefined ? { until: args.until } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    });
    return ok(result);
  } catch (err) {
    return failWith(err, "screenshot_query");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only diagnostic listing of the screenshot disk-cache — wrapped via
 * `makeQueryWrapper` (PR #122 server_status pattern: no L1 events, generic
 * causedBy projector, default query session id). Not callable from `run_macro`
 * (a maintenance/diagnostic surface, like server_status), so no TOOL_REGISTRY
 * entry is added.
 */
export const screenshotQueryRegistrationSchema = withEnvelopeIncludeSchema(screenshotQuerySchema);

export const screenshotQueryRegistrationHandler = makeQueryWrapper(
  screenshotQueryHandler as unknown as (args: Record<string, unknown>) => Promise<ToolResult>,
  "screenshot_query",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export function registerScreenshotQueryTool(server: McpServer): void {
  server.tool(
    "screenshot_query",
    "List screenshots already saved in the disk-cache WITHOUT re-reading any pixels. " +
      "The screenshot tools return each capture as a cheap by-ref link " +
      "(screenshot://by-ref/{captureId}); this lists what is in the cache — captureId + " +
      "by-ref uri, dimensions, size in bytes, timestamp, and tag/window — so you can find " +
      "and re-open a specific earlier capture, or check how much the cache holds before " +
      "reclaiming space with screenshot_gc. The response also carries whole-cache totals " +
      "(totalCaptures / totalBytes). Reading a capture's bytes still costs tokens, so open " +
      "a by-ref link only when you actually need to inspect the pixels. Filter by tag " +
      "(case-insensitive) / windowUuid / since / until; page with limit (default 50) and " +
      "offset. Results are newest-first and never include a filesystem path.",
    screenshotQueryRegistrationSchema,
    screenshotQueryRegistrationHandler as typeof screenshotQueryHandler
  );
}
