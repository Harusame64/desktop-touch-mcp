import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { getEngineStatus } from "../engine/status.js";
import { getProcessHealth } from "../engine/process-health.js";
import { getAdvisoryEmitCount } from "./_advisory.js";
import { makeQueryWrapper, withEnvelopeIncludeSchema, genericQueryCausedByProjector, defaultQuerySessionId } from "./_envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const serverStatusSchema = {};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const serverStatusHandler = async (): Promise<ToolResult> => {
  try {
    const status = getEngineStatus();
    const health = getProcessHealth();
    // ADR-022 / issue #352: cumulative count of success-path advisories emitted
    // (process lifetime). The only objective fire-rate signal — surfaced so
    // dogfood can see whether advisories fire at all (under-fire risk).
    const counters = { advisoryEmitted: getAdvisoryEmitCount() };
    return ok({ engine: status, health, counters });
  } catch (err) {
    return failWith(err, "server_status");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper):
 * `server_status` is wrapped via `makeQueryWrapper`. PR #122 screenshot 同型
 * pattern (read-only diagnostic snapshot、L1 events 不発、causedByProjector
 * 省略 fast path)。server_status は `run_macro` から呼び出されない (macro.ts
 * 内 comment 「not callable from macros — diagnostic」のため TOOL_REGISTRY
 * 改修不要)。
 */
export const serverStatusRegistrationSchema = withEnvelopeIncludeSchema(serverStatusSchema);

export const serverStatusRegistrationHandler = makeQueryWrapper(
  (serverStatusHandler as unknown as (args: Record<string, unknown>) => Promise<ToolResult>),
  "server_status",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export function registerServerStatusTool(server: McpServer): void {
  server.tool(
    "server_status",
    "Return MCP server status. engine: native engine availability — uia: 'native' = Rust UIA addon (~2 ms focus / ~100 ms tree); 'powershell' = PS fallback (~366 ms focus). imageDiff: 'native' = Rust SSE2 SIMD (0.26 ms @ 1080p); 'typescript' = TS fallback (~3.8 ms). health: process diagnostic snapshot (issue #365) — uptimeSec, memory.{rssBytes,heapUsedBytes,heapTotalBytes}, cpu.{userUs,systemUs} (cumulative since startup), shutdown.{pending,graceMs,inflightCount} (pending=true means stdin EOF received and grace timer is running), lastRpc.{receivedAt(ISO),method} (last JSON-RPC request observed on stdio transport; HTTP transport is not tracked). Diagnostic metadata — do not surface unless the user asks about performance/troubleshooting. engine values are stable for the process lifetime; health values change per call.",
    serverStatusRegistrationSchema,
    serverStatusRegistrationHandler as typeof serverStatusHandler
  );
}
