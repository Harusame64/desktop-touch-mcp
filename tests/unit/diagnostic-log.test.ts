/**
 * tests/unit/diagnostic-log.test.ts
 *
 * Unit tests for the JSONL diagnostic event log (issue #365).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logDiagnostic,
  getDiagnosticLogPath,
  estimateArgsSize,
  safeStringify,
  normalizeThrown,
  wrapHandlerArgWithTiming,
  _resetDiagnosticLogForTest,
  type DiagnosticEvent,
} from "../../src/engine/diagnostic-log.js";

describe("diagnostic-log", () => {
  let tmp: string;
  let logPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diaglog-"));
    logPath = join(tmp, "sub", "diag.log");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = logPath;
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE;
    _resetDiagnosticLogForTest();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    _resetDiagnosticLogForTest();
  });

  function readLines(): unknown[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
  }

  it("logDiagnostic appends one JSONL line per call", () => {
    logDiagnostic({
      kind: "exit",
      trigger: "SIGINT",
      exitCode: 0,
      inflight: 0,
      shutdownPending: false,
    });
    logDiagnostic({
      kind: "slow_tool",
      tool: "screenshot",
      elapsed_ms: 1234,
      args_size: 100,
    });
    const lines = readLines() as Array<Record<string, unknown>>;
    expect(lines.length).toBe(2);
    expect(lines[0].kind).toBe("exit");
    expect(lines[0].trigger).toBe("SIGINT");
    expect(lines[1].kind).toBe("slow_tool");
    expect(lines[1].tool).toBe("screenshot");
  });

  it("each record contains ts (ISO), pid, uptime_ms", () => {
    logDiagnostic({
      kind: "drain_oversize",
      batch_size: 200,
      overflow: false,
    });
    const [rec] = readLines() as Array<Record<string, unknown>>;
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.uptime_ms).toBe("number");
  });

  it("creates parent directory if missing", () => {
    expect(existsSync(join(tmp, "sub"))).toBe(false);
    logDiagnostic({
      kind: "uncaught",
      type: "uncaughtException",
      msg: "boom",
    });
    expect(existsSync(logPath)).toBe(true);
  });

  it("DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE=1 disables logging", () => {
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE = "1";
    _resetDiagnosticLogForTest();
    logDiagnostic({
      kind: "exit",
      trigger: "SIGINT",
      exitCode: 0,
      inflight: 0,
      shutdownPending: false,
    });
    expect(existsSync(logPath)).toBe(false);
  });

  it("does not throw if path is invalid (best-effort)", () => {
    // Use a path that cannot be created (e.g. a regular file masquerading as a dir)
    const blockingFile = join(tmp, "blocker");
    writeFileSync(blockingFile, "x");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = join(blockingFile, "child", "diag.log");
    _resetDiagnosticLogForTest();
    expect(() =>
      logDiagnostic({
        kind: "exit",
        trigger: "SIGINT",
        exitCode: 0,
        inflight: 0,
        shutdownPending: false,
      }),
    ).not.toThrow();
  });

  it("getDiagnosticLogPath defaults to homedir-based path when env unset", () => {
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH;
    _resetDiagnosticLogForTest();
    const p = getDiagnosticLogPath();
    expect(p).toMatch(/\.desktop-touch-mcp[\\/]logs[\\/]diagnostic\.log$/);
  });

  it("estimateArgsSize returns -1 on circular reference", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(estimateArgsSize([obj])).toBe(-1);
  });

  it("estimateArgsSize returns positive length on normal payload", () => {
    expect(estimateArgsSize([{ a: 1, b: "x" }])).toBeGreaterThan(0);
  });

  it("truncates large stack traces to keep records bounded (R1 P2-3)", () => {
    const bigStack = "x".repeat(8000);
    logDiagnostic({
      kind: "uncaught",
      type: "uncaughtException",
      msg: "boom",
      stack: bigStack,
    });
    const [rec] = readLines() as Array<Record<string, unknown>>;
    expect((rec.stack as string).length).toBeLessThanOrEqual(4096 + 20);
    expect(rec.stack as string).toContain("…[truncated]");
  });

  it("does not truncate a normal-sized stack", () => {
    const normalStack = "Error: x\n    at foo (file.ts:1:1)";
    logDiagnostic({
      kind: "uncaught",
      type: "uncaughtException",
      msg: "boom",
      stack: normalStack,
    });
    const [rec] = readLines() as Array<Record<string, unknown>>;
    expect(rec.stack).toBe(normalStack);
  });
});

describe("wrapHandlerArgWithTiming", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diaglog-timing-"));
    logPath = join(tmp, "diag.log");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = logPath;
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE;
    _resetDiagnosticLogForTest();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    _resetDiagnosticLogForTest();
  });

  function readLines(): Array<Record<string, unknown>> {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
  }

  it("logs slow_tool when handler exceeds threshold", async () => {
    const slowHandler = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    };
    const args: unknown[] = ["my_tool", "desc", {}, slowHandler];
    const wrapped = wrapHandlerArgWithTiming(args, 10);
    const handler = wrapped[wrapped.length - 1] as (...a: unknown[]) => Promise<unknown>;
    const result = await handler({ x: 1 });
    expect(result).toEqual({ ok: true });
    const lines = readLines();
    expect(lines.length).toBe(1);
    expect(lines[0].kind).toBe("slow_tool");
    expect(lines[0].tool).toBe("my_tool");
    expect(lines[0].elapsed_ms as number).toBeGreaterThanOrEqual(10);
  });

  it("does not log when handler completes under threshold", async () => {
    const fastHandler = async () => ({ ok: true });
    const args: unknown[] = ["fast_tool", fastHandler];
    const wrapped = wrapHandlerArgWithTiming(args, 1000);
    const handler = wrapped[wrapped.length - 1] as (...a: unknown[]) => Promise<unknown>;
    await handler({});
    expect(readLines().length).toBe(0);
  });

  it("logs slow_tool even when handler throws", async () => {
    const throwingHandler = async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("boom");
    };
    const args: unknown[] = ["throwing_tool", throwingHandler];
    const wrapped = wrapHandlerArgWithTiming(args, 10);
    const handler = wrapped[wrapped.length - 1] as (...a: unknown[]) => Promise<unknown>;
    await expect(handler()).rejects.toThrow("boom");
    const lines = readLines();
    expect(lines.length).toBe(1);
    expect(lines[0].tool).toBe("throwing_tool");
  });

  it("returns args unchanged if last entry is not a function", () => {
    const args: unknown[] = ["tool", "not a function"];
    const wrapped = wrapHandlerArgWithTiming(args);
    expect(wrapped).toBe(args);
    expect(wrapped[1]).toBe("not a function");
  });

  it("returns empty args unchanged", () => {
    const args: unknown[] = [];
    expect(wrapHandlerArgWithTiming(args)).toBe(args);
  });

  it("returns args unchanged when toolArgs[0] is not a string (R1 P3-3)", async () => {
    // Upstream misuse: if the first arg is not a string tool name we skip wrap
    // to avoid emitting literal "[object Object]" / "undefined" in slow_tool logs.
    const handler = async () => ({ ok: true });
    const argsBad: unknown[] = [{ not: "a name" }, handler];
    const wrappedBad = wrapHandlerArgWithTiming(argsBad, 1);
    expect(wrappedBad).toBe(argsBad);
    // The handler at the last index should still be the original, untouched.
    expect(wrappedBad[1]).toBe(handler);
  });
});

describe("safeStringify (R1 P1-2 / R2 extract)", () => {
  it("returns JSON for plain object", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });
  it("returns String() fallback for circular object", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(safeStringify(obj)).toBe("[object Object]");
  });
  it("handles undefined → null per JSON.stringify, then falls back via ??", () => {
    // JSON.stringify(undefined) === undefined → ?? falls back to String(undefined) === "undefined"
    expect(safeStringify(undefined)).toBe("undefined");
  });
  it("handles symbol → String() fallback", () => {
    // JSON.stringify(symbol) returns undefined → falls back
    const sym = Symbol("x");
    expect(safeStringify(sym)).toBe(String(sym));
  });
});

describe("normalizeThrown (Codex R1 P2-2 / R2 symmetric fix)", () => {
  it("returns Error instance unchanged", () => {
    const orig = new Error("boom");
    expect(normalizeThrown(orig)).toBe(orig);
  });
  it("wraps string in Error", () => {
    const e = normalizeThrown("plain string");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("plain string");
  });
  it("wraps null in Error (no property dereference)", () => {
    // The critical case: `throw null` previously crashed handlers that read err.name.
    const e = normalizeThrown(null);
    expect(e).toBeInstanceOf(Error);
    expect(typeof e.message).toBe("string");
  });
  it("wraps undefined in Error", () => {
    const e = normalizeThrown(undefined);
    expect(e).toBeInstanceOf(Error);
    expect(typeof e.message).toBe("string");
  });
  it("wraps numeric throw", () => {
    const e = normalizeThrown(42);
    expect(e.message).toBe("42");
  });
  it("wraps circular object without throwing", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => normalizeThrown(obj)).not.toThrow();
    const e = normalizeThrown(obj);
    expect(e).toBeInstanceOf(Error);
  });
});

describe("DiagnosticEvent type discrimination", () => {
  it("all event kinds are accepted by logDiagnostic signature", () => {
    // Type-only check: this test passes by virtue of compilation.
    const events: DiagnosticEvent[] = [
      { kind: "exit", trigger: "x", exitCode: 0, inflight: 0, shutdownPending: false },
      { kind: "uncaught", type: "uncaughtException", msg: "x" },
      { kind: "slow_tool", tool: "t", elapsed_ms: 1, args_size: 0 },
      { kind: "cpu_spike", cpu_pct: 50, window_ms: 10000, rss_mb: 200, inflight: 0, lastRpcMethod: null },
      { kind: "drain_oversize", batch_size: 100, overflow: false },
    ];
    expect(events.length).toBe(5);
  });
});
