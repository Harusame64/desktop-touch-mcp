/**
 * diagnostic-log.ts — append-only JSONL diagnostic event log (issue #365).
 *
 * Captures runtime events that are normally invisible to external samplers so
 * that post-hoc grep can answer:
 *   - why did the MCP process disappear? (`exit` + `uncaught` events)
 *   - which tool was running when the fan kicked in? (`slow_tool` + `cpu_spike`)
 *   - is the perception drain backlog growing? (`drain_oversize`)
 *
 * Design:
 *   - sync append (`appendFileSync`) so events written just before `process.exit`
 *     are not lost in Node's writable-stream buffer
 *   - best-effort: every write is wrapped in try/catch and never throws to the
 *     caller — diagnostic logging must not become a new crash source
 *   - env overrides:
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH    — override default path
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE — set to "1" to disable entirely
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

const DEFAULT_FILENAME = "diagnostic.log";
const DEFAULT_DIR = ".desktop-touch-mcp/logs";

let _resolvedPath: string | null = null;
let _disabled: boolean | null = null;
let _dirEnsured = false;

function isDisabled(): boolean {
  if (_disabled === null) {
    _disabled = process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE === "1";
  }
  return _disabled;
}

export function getDiagnosticLogPath(): string {
  if (_resolvedPath !== null) return _resolvedPath;
  const override = process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH;
  if (override && override.length > 0) {
    _resolvedPath = override;
  } else {
    _resolvedPath = join(homedir(), DEFAULT_DIR, DEFAULT_FILENAME);
  }
  return _resolvedPath;
}

function ensureDir(path: string): void {
  if (_dirEnsured) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    _dirEnsured = true;
  } catch {
    // best-effort; appendFileSync below will surface the real error if any
  }
}

export type DiagnosticEvent =
  | {
      kind: "exit";
      trigger: string;
      exitCode: number;
      inflight: number;
      shutdownPending: boolean;
      extra?: Record<string, unknown>;
    }
  | {
      kind: "uncaught";
      type: "uncaughtException" | "unhandledRejection";
      name?: string;
      msg: string;
      stack?: string;
    }
  | {
      kind: "slow_tool";
      tool: string;
      elapsed_ms: number;
      args_size: number;
    }
  | {
      kind: "cpu_spike";
      cpu_pct: number;
      window_ms: number;
      rss_mb: number;
      inflight: number;
      lastRpcMethod: string | null;
    }
  | {
      kind: "drain_oversize";
      batch_size: number;
      overflow: boolean;
    };

/**
 * Append one diagnostic event as a JSONL line. Best-effort: never throws.
 * Synchronous so events written just before `process.exit` reach disk.
 */
export function logDiagnostic(event: DiagnosticEvent): void {
  if (isDisabled()) return;
  const path = getDiagnosticLogPath();
  ensureDir(path);
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    uptime_ms: Math.round(process.uptime() * 1000),
    ...event,
  };
  try {
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch {
    // Disk full / permission denied / path invalid — silently drop.
    // We deliberately do NOT log to stderr here because uncaughtException
    // handler also writes diagnostics and a stderr write that itself throws
    // could re-enter the handler.
  }
}

/**
 * Estimate the serialized size of tool arguments without doing a full
 * JSON.stringify (which can be expensive for large screenshot payloads).
 * Returns a rough byte count.
 */
export function estimateArgsSize(args: unknown[]): number {
  try {
    return JSON.stringify(args).length;
  } catch {
    return -1;
  }
}

/**
 * Wrap tool handler args (s.tool / s.registerTool signature) so that calls
 * exceeding `thresholdMs` are logged via `slow_tool` events. Mirrors
 * `wrapHandlerArg` in `utils/failsafe-wrap.ts` — both wrappers can be chained.
 */
export function wrapHandlerArgWithTiming(
  toolArgs: unknown[],
  thresholdMs = 1000,
): unknown[] {
  if (toolArgs.length === 0) return toolArgs;
  const toolName = String(toolArgs[0]);
  const lastIdx = toolArgs.length - 1;
  const originalHandler = toolArgs[lastIdx];
  if (typeof originalHandler !== "function") return toolArgs;
  toolArgs[lastIdx] = async (...handlerArgs: unknown[]) => {
    const start = performance.now();
    try {
      return await (originalHandler as (...a: unknown[]) => Promise<unknown>)(
        ...handlerArgs,
      );
    } finally {
      const elapsed = performance.now() - start;
      if (elapsed > thresholdMs) {
        logDiagnostic({
          kind: "slow_tool",
          tool: toolName,
          elapsed_ms: Math.round(elapsed),
          args_size: estimateArgsSize(handlerArgs),
        });
      }
    }
  };
  return toolArgs;
}

/** Test-only: reset module-level memoization. Not exposed via index. */
export function _resetDiagnosticLogForTest(): void {
  _resolvedPath = null;
  _disabled = null;
  _dirEnsured = false;
}
