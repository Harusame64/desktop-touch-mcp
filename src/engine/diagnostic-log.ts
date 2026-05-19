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

// Review R1 P2-3: cap stack trace size so a runaway stack doesn't write MB-
// scale records and slow down a synchronous appendFileSync just before exit.
// Review R2 P3 (Opus): named CHARS not BYTES — `slice` / `.length` are UTF-16
// code-unit operations, not byte counts. For ASCII stacks this is bit-equal;
// stack frames with multi-byte path chars (Japanese / emoji) will be capped
// by char count not byte count. Acceptable for the diagnostic goal (we only
// need bounded record size, not exact byte truncation).
const STACK_TRUNCATE_CHARS = 4096;

/**
 * `_disabled`, `_resolvedPath`, and `_dirEnsured` are memoized on first read.
 *
 * **Runtime mutation contract**: the `DESKTOP_TOUCH_DIAGNOSTIC_LOG_*` env vars
 * are read once at first log site and cached for the process lifetime. Changing
 * them mid-process has no effect. This matches how the rest of the server
 * resolves env (process-health.ts / nativeEventsEnabled) and avoids a per-write
 * env lookup hit on the hot path. Tests use `_resetDiagnosticLogForTest()` to
 * force a re-read.
 */
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
    }
  | {
      kind: "dormancy_transition";
      state: "enter" | "exit";
      // For "enter": idle_ms = elapsed since lastRpc that triggered the stop.
      // For "exit": elapsed_ms = wall-clock cost of the wake (sidecar spawn etc).
      idle_ms?: number;
      elapsed_ms?: number;
      inflight: number;
    };

/**
 * Append one diagnostic event as a JSONL line. Best-effort: never throws.
 * Synchronous so events written just before `process.exit` reach disk.
 *
 * Review R1 P2-3: large `stack` fields are truncated to keep each line
 * bounded; an unbounded stack on a hot uncaught path would extend the
 * synchronous write past the OS pipe drain window and risk losing the
 * preceding log entries on `process.exit`.
 */
export function logDiagnostic(event: DiagnosticEvent): void {
  if (isDisabled()) return;
  const path = getDiagnosticLogPath();
  ensureDir(path);
  const safeEvent =
    "stack" in event && typeof event.stack === "string" && event.stack.length > STACK_TRUNCATE_CHARS
      ? { ...event, stack: event.stack.slice(0, STACK_TRUNCATE_CHARS) + "…[truncated]" }
      : event;
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    uptime_ms: Math.round(process.uptime() * 1000),
    ...safeEvent,
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
 * Best-effort JSON serialization that never throws. Falls back through
 * `JSON.stringify` → `String(value)` → literal `"<unstringifiable>"`. Used by
 * the uncaught handlers in `server-windows.ts` to normalize circular /
 * exotic thrown values before constructing an `Error` for logging.
 *
 * (Review R1 P1-2 — extracted to this module in R2 for testability.)
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "<unstringifiable>";
    }
  }
}

/**
 * Normalize an arbitrary thrown value into an `Error` instance so the
 * `uncaughtException` / `unhandledRejection` handlers can safely read
 * `.name` / `.message` / `.stack`. Node passes the *exact* value that was
 * thrown to listeners — including `null`, `undefined`, numbers, or circular
 * objects — and dereferencing properties on those would re-enter the
 * handler.
 *
 * (Codex Review R1 P2-2 for `unhandledRejection`; Codex R2 follow-up for the
 * symmetric `uncaughtException` path.)
 */
export function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(safeStringify(value));
}

/**
 * Wrap tool handler args (s.tool / s.registerTool signature) so that calls
 * exceeding `thresholdMs` are logged via `slow_tool` events. Mirrors
 * `wrapHandlerArg` in `utils/failsafe-wrap.ts` — both wrappers can be chained.
 *
 * Review R1 P3-3: only wrap when `toolArgs[0]` is a string (the conventional
 * tool name). For any other shape we skip the wrap so the log doesn't get
 * filled with literal `"undefined"` / `"[object Object]"` from upstream
 * misuse — keeping the failure-mode equivalent to `wrapHandlerArg`.
 */
export function wrapHandlerArgWithTiming(
  toolArgs: unknown[],
  thresholdMs = 1000,
): unknown[] {
  if (toolArgs.length === 0) return toolArgs;
  const toolName = toolArgs[0];
  if (typeof toolName !== "string") return toolArgs;
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
