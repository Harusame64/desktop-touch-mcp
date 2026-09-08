/**
 * tests/unit/diagnostic-log.test.ts
 *
 * Unit tests for the JSONL diagnostic event log (issue #365).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  logDiagnostic,
  getDiagnosticLogPath,
  isDiagnosticLogEnabled,
  estimateArgsSize,
  safeStringify,
  normalizeThrown,
  wrapHandlerArgWithTiming,
  parseMaxLogBytes,
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

  it("does not throw on an event that cannot be serialized (Codex R2 P2)", () => {
    // `exit.extra` is `Record<string, unknown>`, so callers this module cannot
    // see may hand it a circular reference, a BigInt, or a throwing `toJSON`.
    // `logDiagnostic` runs from the uncaughtException and shutdown handlers,
    // where throwing is the failure the never-throw contract exists to prevent.
    // Fails if `JSON.stringify` sits outside the try, as it did while rotation
    // was being added.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwingToJson = {
      toJSON() {
        throw new Error("no");
      },
    };

    for (const extra of [
      circular,
      { big: BigInt(1) } as unknown as Record<string, unknown>,
      { bad: throwingToJson },
    ]) {
      expect(() =>
        logDiagnostic({
          kind: "exit",
          trigger: "SIGINT",
          exitCode: 0,
          inflight: 0,
          shutdownPending: false,
          extra,
        }),
      ).not.toThrow();
    }

    // Dropped, not half-written: whatever is on disk is still valid JSONL.
    expect(() => readLines()).not.toThrow();
    expect(readLines()).toHaveLength(0);

    // And the log is still usable afterwards.
    logDiagnostic({ kind: "exit", trigger: "after", exitCode: 0, inflight: 0, shutdownPending: false });
    expect(readLines()).toHaveLength(1);
  });

  it("isDiagnosticLogEnabled tracks the disable switch", () => {
    // Nine suites mock this export and none tested it. Producers use it to skip
    // hashing and Win32 reads entirely, so a wrong answer here is silent work
    // on a disabled log, or a silently empty one.
    expect(isDiagnosticLogEnabled()).toBe(true);

    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE = "1";
    _resetDiagnosticLogForTest();
    expect(isDiagnosticLogEnabled()).toBe(false);

    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE = "0"; // only "1" disables
    _resetDiagnosticLogForTest();
    expect(isDiagnosticLogEnabled()).toBe(true);
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


/**
 * Rotation (the 18.5 GB defect).
 *
 * The log was append-only with no ceiling; on the maintainer's machine it
 * reached 18,548,383,199 bytes / 34,811,118 lines over ~3.5 months of ordinary
 * traffic (measured 2026-09-07). These tests pin the ceiling AND that the
 * ceiling is load-bearing — several of them are mutation checks, marked as
 * such, that stay green on an unbounded file unless the specific line they
 * guard is present.
 *
 * The ceiling used here is MIN_CEILING (1 MiB) because anything smaller is
 * clamped by the floor, so records are padded to REC_BYTES to keep the tests
 * fast: ~16 records fill one generation.
 */
describe("diagnostic-log rotation", () => {
  let tmp: string;
  let logPath: string;
  const savedEnv = { ...process.env };

  const MIN_CEILING = 1024 * 1024;
  const REC_BYTES = 64 * 1024;
  /** `MAX_RECORD_BYTES` = the floor / 8; every record must fit under it. */
  const MAX_RECORD = MIN_CEILING / 8;
  /** `KEPT_GENERATIONS + 1` — the live file plus what it keeps behind it. */
  const KEPT_GENERATIONS_PLUS_ONE = 3;
  /** Where this process parks the live file mid-roll. The pid is load-bearing. */
  const staging = (): string => `${logPath}.${process.pid}.rotating`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diagrot-"));
    logPath = join(tmp, "sub", "diag.log");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = logPath;
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE;
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_MAX_BYTES = String(MIN_CEILING);
    _resetDiagnosticLogForTest();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    _resetDiagnosticLogForTest();
  });

  /** One fat record, so a generation fills in ~16 writes rather than ~8000. */
  function write(n: number, tag = "t"): void {
    for (let i = 0; i < n; i++) {
      logDiagnostic({
        kind: "slow_tool",
        tool: `${tag}${i}` + "p".repeat(REC_BYTES),
        elapsed_ms: i,
        args_size: 0,
      });
    }
  }

  describe("parseMaxLogBytes", () => {
    const DEFAULT = 64 * 1024 * 1024;

    it("accepts a positive integer at or above the floor", () => {
      expect(parseMaxLogBytes(String(4 * 1024 * 1024))).toBe(4 * 1024 * 1024);
      expect(parseMaxLogBytes(`  ${4 * 1024 * 1024}  `)).toBe(4 * 1024 * 1024);
    });

    it("falls back to the default for every malformed value — a typo must not restore unbounded growth", () => {
      for (const raw of [undefined, "", "   ", "abc", "0", "-1", "1.5", "Infinity", "NaN", "1e400"]) {
        expect(parseMaxLogBytes(raw)).toBe(DEFAULT);
      }
    });

    it('"0" is not a disable switch — DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE is', () => {
      expect(parseMaxLogBytes("0")).toBe(DEFAULT);
    });

    it("clamps an absurdly large ceiling to the roof — the same MiB confusion in the other direction", () => {
      // The floor catches `64` meant as MiB. Nothing caught `640000` meant as
      // MiB, which is 640 GB of bytes: accepted verbatim, rotation never fires
      // again, and the variable's own documentation says a typo cannot do that.
      const ROOF = 1024 * 1024 * 1024;
      expect(parseMaxLogBytes("640000000000")).toBe(ROOF);
      // `Number.isInteger(1e21)` is true and it is past MAX_SAFE_INTEGER, so
      // the arithmetic downstream would stop being exact as well.
      expect(parseMaxLogBytes("1e21")).toBe(ROOF);
      expect(parseMaxLogBytes(String(ROOF))).toBe(ROOF);
      expect(parseMaxLogBytes(String(ROOF - 1))).toBe(ROOF - 1);
    });

    it("clamps an unusably small ceiling to the floor — 64 read as MiB must not become 64 bytes", () => {
      // Otherwise a reader who takes the variable for MiB gets one rename per
      // record on the synchronous exit path, every generation holding a single
      // line: the log destroyed rather than bounded.
      expect(parseMaxLogBytes("64")).toBe(MIN_CEILING);
      expect(parseMaxLogBytes("1")).toBe(MIN_CEILING);
      expect(parseMaxLogBytes(String(MIN_CEILING))).toBe(MIN_CEILING);
    });
  });

  it("rolls the live file to .1 once it passes the ceiling", () => {
    write(1);
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(false);

    write(24);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(logPath).size).toBeLessThanOrEqual(MIN_CEILING);
  });

  /** Every file the log owns, found by listing rather than by guessing names. */
  function logFiles(): string[] {
    const dir = join(tmp, "sub");
    return readdirSync(dir)
      .filter((f) => f.startsWith("diag.log"))
      .map((f) => join(dir, f));
  }

  it("keeps at most KEPT_GENERATIONS rotated files — total disk stays bounded", () => {
    write(80);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    // The third generation is the one that must never appear.
    expect(existsSync(`${logPath}.3`)).toBe(false);

    // Listed, not enumerated by name. The earlier version checked three
    // hardcoded paths, so a file the rotation left under any OTHER name — a
    // staged one stranded by a half-done roll, say — was invisible to it, and
    // that is exactly the defect it failed to catch.
    const total = logFiles().reduce((n, f) => n + statSync(f).size, 0);
    expect(logFiles().length).toBeLessThanOrEqual(3);
    expect(total).toBeLessThanOrEqual((KEPT_GENERATIONS_PLUS_ONE * MIN_CEILING) + REC_BYTES * 2);
  });

  it("seeds its byte estimate from a file that already exists, so a restart does not start the count over", () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    // One record is far under the ceiling, but the pre-existing MiB puts the
    // pair over it — only a seeded counter notices.
    write(1);
    expect(existsSync(`${logPath}.1`)).toBe(true);
  });

  it("never loses the newest events: whatever the rotation did, the last record written is in the live file", () => {
    write(40);
    logDiagnostic({ kind: "slow_tool", tool: "LAST", elapsed_ms: 1, args_size: 0 });

    expect(readFileSync(logPath, "utf8")).toContain('"tool":"LAST"');
  });

  it("MUTATION: without rotation the file grows past the ceiling — this is the assertion that fails if rotateIfNeeded is removed", () => {
    write(40);

    // Assert the ceiling directly rather than inferring it from a .1 file, so
    // this stays meaningful if the rotation scheme is ever reshaped.
    expect(statSync(logPath).size).toBeLessThanOrEqual(MIN_CEILING);
  });

  it("MUTATION: rotation is amortized — the records right after a roll do not roll again", () => {
    // Catches a lost `_bytesOnDisk = 0` after rotation. Without it every
    // subsequent record re-runs the whole three-syscall rotation, on the
    // synchronous process.exit path, while every other assertion here still
    // passes: .1 and .2 still appear and the live file is still small.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    // SMALL records throughout, deliberately — including the one that triggers
    // the roll. A fat record leaves `_bytesSinceStat` above the refresh
    // interval (ceiling/16), so the periodic re-stat corrects a stale estimate
    // on the very next write and hides the missing reset entirely: measured,
    // this test passes with the reset removed when the records are 64 KiB.
    // Real traffic is ~400-byte records, where a stale estimate means a full
    // three-syscall rotation per record until the interval is finally reached.
    const small = (i: number): void => {
      logDiagnostic({ kind: "slow_tool", tool: `small${i}`, elapsed_ms: i, args_size: 0 });
    };

    small(0); // the file is already at the ceiling, so this one rolls it
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(false);

    small(1);
    small(2);
    expect(existsSync(`${logPath}.2`)).toBe(false); // no second roll
  });

  it("reconciles with the file's real size, so a second writer cannot push it past the ceiling unnoticed", () => {
    // The estimate counts only this process's own bytes. Another server sharing
    // the path is invisible to it, and that undercount is the direction that
    // breaks the bound — so the estimate is re-read from the file periodically.
    // Simulated here by appending behind the module's back.
    write(1); // creates the file, seeds the estimate at ~one record
    expect(existsSync(`${logPath}.1`)).toBe(false);

    appendFileSync(logPath, "y".repeat(MIN_CEILING), "utf8");

    // One refresh interval is ceiling/16 = 64 KiB, so a couple of fat records
    // are enough to trigger the reconciliation.
    write(4);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(logPath).size).toBeLessThanOrEqual(MIN_CEILING);
  });

  it("records a rotation failure once, so an unbounded log can explain itself", () => {
    // A live file that can never be renamed grows at full speed — the exact
    // state this module exists to prevent — so the failure must not be silent.
    // Forced here by making the rotation destination a non-empty directory.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    // Both destinations must be blocked: with only .1 taken, the promotion
    // step happily renames that directory to .2 and the rotation succeeds.
    for (const gen of [1, 2]) {
      mkdirSync(`${logPath}.${gen}`, { recursive: true });
      writeFileSync(join(`${logPath}.${gen}`, "blocker"), "no", "utf8");
    }
    _resetDiagnosticLogForTest();

    write(6);

    const failures = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.includes('"log_rotation_failed"'));
    expect(failures.length).toBe(1); // once, not once per record
    expect(existsSync(logPath)).toBe(true); // and events keep being written
  });

  /** Larger than the ceiling itself, so rotation cannot make room for it. */
  function logOversizedRecord(filler = "p"): void {
    logDiagnostic({
      kind: "slow_tool",
      tool: "OVERSIZE" + filler.repeat(MIN_CEILING * 2),
      elapsed_ms: 1,
      args_size: 0,
    });
  }

  it("MUTATION: a record larger than the ceiling cannot walk straight through a rotation", () => {
    // Rotation shrinks the file, not the record: the roll happens, the fresh
    // live file is empty, and the oversized line is appended anyway. Without a
    // record cap one event puts the directory past the bound by any amount, and
    // every other rotation assertion here still passes.
    logOversizedRecord();

    expect(statSync(logPath).size).toBeLessThanOrEqual(MIN_CEILING);
  });

  it("a capped record keeps its kind, its real size, and a readable head", () => {
    logOversizedRecord();

    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;

    // `kind` survives, so a grep for the event still finds it.
    expect(rec.kind).toBe("slow_tool");
    expect(rec.record_truncated).toBe(true);
    expect(rec.original_bytes).toBeGreaterThan(MIN_CEILING);
    // The head is a prefix of the original JSON, so the offending field is
    // still identifiable.
    expect(String(rec.head)).toContain('"tool":"OVERSIZE');
    expect(rec.ts).toBeTruthy();
    expect(rec.pid).toBe(process.pid);
  });

  it("worst-case byte expansion: a multi-byte payload still fits the cap", () => {
    // The head is counted in UTF-16 code units and the cap is in bytes, so the
    // two only agree after re-encoding. Control characters are the wrong probe:
    // the head is sliced from text that is ALREADY JSON, where a control
    // character is six plain ASCII characters and costs ~1 byte per unit. What
    // actually sets the worst case is `JSON.stringify` passing non-ASCII
    // through unescaped, at 3 UTF-8 bytes per BMP unit. A quote-heavy payload
    // is the other direction: each one is re-escaped on the way in.
    for (const [name, filler] of [
      ["multi-byte pass-through", "\u3042"],
      ["re-escaped quotes", '"'],
      ["control characters", "\u0001"],
    ] as const) {
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(join(tmp, "sub"), { recursive: true });
      _resetDiagnosticLogForTest();

      logOversizedRecord(filler);

      const size = statSync(logPath).size;
      expect(size, name).toBeLessThanOrEqual(MAX_RECORD);
      expect(size, name).toBeGreaterThan(0);
    }
  });

  it("MUTATION: the kind echoed into a capped record is bounded at runtime, not by the type", () => {
    // `DiagnosticEvent` bounds `kind` at compile time and every call site in
    // this repo passes a literal - but this is the one record whose whole job
    // is to be provably small, so the bound has to hold at runtime too. Cast
    // past the union the way an unchecked producer eventually will.
    logDiagnostic({
      kind: "k".repeat(200_000),
      tool: "t",
      elapsed_ms: 1,
      args_size: 0,
    } as unknown as DiagnosticEvent);

    expect(statSync(logPath).size).toBeLessThanOrEqual(MAX_RECORD);
  });

  it("MUTATION: a live file that can never be renamed costs no history at all, however many times it is retried", () => {
    // The natural order - make room, then fill it - destroys the archive it is
    // meant to protect. With the shift first, a live file that cannot be moved
    // still gets `.2` unlinked and `.1` promoted into it on EVERY attempt, so a
    // persistent failure ends with an oversized log and no retained history:
    // worse than the unbounded growth this module was written to stop. Staging
    // the live file first makes a failure cost nothing.
    //
    // The live rename is blocked here by putting a non-empty directory at the
    // staging path, which is the one destination that move must use.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1-KEEP-ME", "utf8");
    writeFileSync(`${logPath}.2`, "GEN2-KEEP-ME", "utf8");
    mkdirSync(staging(), { recursive: true });
    writeFileSync(join(staging(), "blocker"), "no", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    // Several rounds, because one attempt is not what erodes the history - the
    // retries are. Each `write` here is far more than one ceiling's worth.
    write(20, "a");
    write(20, "b");

    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("GEN1-KEEP-ME");
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("GEN2-KEEP-ME");
    expect(readFileSync(logPath, "utf8")).toContain("log_rotation_failed");
  });

  it("files a staged file left behind by an interrupted roll instead of replacing it", () => {
    // A crash between staging the live file and filing it leaves records that
    // are NEWER than `.1`. Staging the next live file on top of them would
    // throw those records away, so the leftover is filed first.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(staging(), "INTERRUPTED-ROLL", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "z"); // rolls: the leftover is filed as .1, then pushed to .2

    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("INTERRUPTED-ROLL");
    expect(readFileSync(`${logPath}.1`, "utf8")).toContain("x".repeat(64));
    expect(existsSync(staging())).toBe(false); // and nothing is left staged
  });

  it("MUTATION: a leftover of our own that a viewer holds open costs no generation — it is proved movable before the shift", async (ctx) => {
    // The own-leftover branch files a `.rotating` file nobody has claimed: it
    // has been on disk since a roll of ours failed, which is exactly when a
    // viewer may have opened it. Shifting first replaced `.2` with `.1` and
    // emptied `.1`, THEN the install threw, and the outer recovery declined
    // because the live file was still there. So `fileStagedInto` proves the
    // file can move before it shifts anything; this pin removes that proof.
    //
    // Node cannot hold a file against rename — libuv always opens with delete
    // sharing — which is why this looked unpinnable. .NET can: `FileShare.Read`
    // omits it, and renaming the held file then fails with EBUSY (measured
    // 2026-09-08). So the viewer is a PowerShell process. Windows only, and it
    // skips, saying so, where the hold cannot be established.
    if (process.platform !== "win32") ctx.skip("share-mode locks are a Windows thing");
    const REC = 100 * 1000; // past the back-off (max(ceiling/16, 128 KiB)) in two records
    const rec = (tag: string): void => {
      logDiagnostic({ kind: "slow_tool", tool: tag + "z".repeat(REC), elapsed_ms: 1, args_size: 0 });
    };

    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1-KEEP-ME", "utf8");
    writeFileSync(`${logPath}.2`, "GEN2-KEEP-ME", "utf8");
    writeFileSync(staging(), "OUR-UNFILED-LEFTOVER", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    const psPath = staging().replace(/'/g, "''");
    const viewer = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$h = [IO.File]::Open('${psPath}', 'Open', 'Read', 'Read'); ` +
          "[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); Start-Sleep -Seconds 60",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = new Promise<void>((resolve) => viewer.once("exit", () => resolve()));
    try {
      const held = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 15_000);
        viewer.stdout?.on("data", (d: Buffer) => {
          if (String(d).includes("HELD")) {
            clearTimeout(timer);
            resolve(true);
          }
        });
        viewer.once("exit", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (!held) ctx.skip("PowerShell could not be started to hold the file");
      // Verify the injector rather than assume it: the held file must refuse a
      // rename to ANOTHER name. (Put back if it did not, so a skip leaves the
      // directory as it was found.)
      let refused = false;
      try {
        renameSync(staging(), `${staging()}.probe`);
        renameSync(`${staging()}.probe`, staging());
      } catch {
        refused = true;
      }
      if (!refused) ctx.skip("a FileShare.Read handle does not block rename here");

      rec("held"); // the roll is attempted and fails before anything has moved

      expect(readFileSync(`${logPath}.1`, "utf8")).toBe("GEN1-KEEP-ME");
      expect(readFileSync(`${logPath}.2`, "utf8")).toBe("GEN2-KEEP-ME");
      expect(readFileSync(staging(), "utf8")).toBe("OUR-UNFILED-LEFTOVER");
      const live = readFileSync(logPath, "utf8");
      expect(live).toContain('"tool":"held');
      expect(live).toContain("log_rotation_failed");
    } finally {
      viewer.kill();
      await exited;
    }

    // Released, the next roll files it: delayed, not lost.
    rec("released"); // past the back-off — one roll, and it succeeds
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("OUR-UNFILED-LEFTOVER");
    expect(readFileSync(`${logPath}.1`, "utf8")).toContain("x".repeat(64));
    expect(existsSync(staging())).toBe(false);
  });

  it("MUTATION: another process's staged log is left alone — the staging name carries the pid", () => {
    // Servers share one log by default. With a single fixed staging name, the
    // "is anything staged?" check and the rename after it are a race that ends
    // destructively: this process sees nothing staged, another moves its whole
    // live log to the shared name, and this one's rename replaces it — up to a
    // full ceiling of the newest history gone. A name only this process writes
    // cannot be taken from under another one.
    // Two files, and the FIRST is the one that discriminates: it sits at the
    // name a shared scheme would pick, so a shared name makes this process
    // adopt another server's staged log as its own leftover and file it away.
    // The second belongs to a server that is genuinely RUNNING — taking that
    // one would cost it the history it is mid-roll with.
    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const atSharedName = `${logPath}.rotating`;
      const atLivePid = `${logPath}.${alive.pid}.rotating`;

      mkdirSync(join(tmp, "sub"), { recursive: true });
      writeFileSync(atSharedName, "ANOTHER-SERVERS-STAGED-LOG", "utf8");
      writeFileSync(atLivePid, "A-RUNNING-SERVERS-STAGED-LOG", "utf8");
      writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
      _resetDiagnosticLogForTest();

      write(1, "z"); // rolls

      expect(readFileSync(atSharedName, "utf8")).toBe("ANOTHER-SERVERS-STAGED-LOG");
      expect(readFileSync(atLivePid, "utf8")).toBe("A-RUNNING-SERVERS-STAGED-LOG");
    } finally {
      alive.kill();
    }
  });

  it("MUTATION: a notice whose own write failed does not survive a recovery and re-latch the reset", (ctx) => {
    // The reordering that keeps a failed notice retriable and the reset that
    // re-arms reporting after a recovery interact: a notice can still be
    // pending when rotation starts working again. Written then, it describes a
    // failure that is over AND sets the latch the reset just cleared, so the
    // next episode is suppressed and the re-arm accomplishes nothing.
    //
    // Reaching that state needs the EVENT append to fail while the file stays
    // measurable and movable, because a successful append consumes the notice
    // immediately. The read-only attribute does exactly that: `appendFileSync`
    // gives EPERM, `statSync` still reports the real size, and `renameSync`
    // still works (measured on this machine, 2026-09-08).
    //
    // It does NOT hold for a process that ignores discretionary permissions —
    // root on POSIX, which is how this repo's container runs — so the injector
    // is verified before it is relied on rather than assumed to work. No
    // portable injector exists: every other way to make one append fail also
    // breaks something the state needs (a directory at the path has no size
    // to roll on; an immutable file cannot be renamed either; a mode bit is
    // the very thing root ignores). The pin runs where the suite is run before
    // a merge — the maintainer's Windows machine; CI does not run the unit
    // suite (see .github/workflows/ci.yml) — and skips, saying so, elsewhere.
    const probe = join(tmp, "ro-probe");
    writeFileSync(probe, "x", "utf8");
    chmodSync(probe, 0o444);
    let readOnlyBlocksAppend = false;
    try {
      appendFileSync(probe, "y");
    } catch {
      readOnlyBlocksAppend = true;
    }
    chmodSync(probe, 0o666);
    if (!readOnlyBlocksAppend) {
      ctx.skip("read-only does not block appends here (root?), so the state cannot be set up");
    }
    const blockStaging = (): void => {
      mkdirSync(staging(), { recursive: true });
      writeFileSync(join(staging(), "blocker"), "no", "utf8");
    };
    const REC = 100 * 1000; // must exceed the re-stat interval (ceiling/16 = 64 KiB)
    const rec = (tag: string): void => {
      logDiagnostic({ kind: "slow_tool", tool: tag + "z".repeat(REC), elapsed_ms: 1, args_size: 0 });
    };

    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1", "utf8");
    // TWICE the ceiling on purpose: the back-off after a failed roll is now at
    // least one whole record, so a live file merely AT the ceiling can never
    // re-attempt a roll without a successful append in between - and that
    // append is exactly what consumes the notice. Starting well over the
    // ceiling is the only way the retry happens with the notice still pending.
    writeFileSync(logPath, "x".repeat(2 * MIN_CEILING), "utf8");
    blockStaging();
    chmodSync(logPath, 0o444);
    _resetDiagnosticLogForTest();

    // Episode 1: the roll is blocked, and the append that would carry its
    // notice fails too, so the notice stays pending across the call.
    rec("blocked");
    // Read rather than stat: a `statSync` here and a `readFileSync` of the same
    // path below are a check-then-use pair, which is a real shape even if the
    // attacker in this temp directory is imaginary. One read answers both.
    expect(readFileSync(logPath, "utf8").length).toBe(2 * MIN_CEILING); // nothing appended

    // Recovery IN ONE CALL: the staging name is free, so this call rotates
    // successfully first and only then appends - into a file the roll just
    // created, which is where a stale notice would land.
    rmSync(staging(), { recursive: true, force: true });
    rec("recovered");

    const live = readFileSync(logPath, "utf8");
    expect(live).toContain('"tool":"recovered');
    expect(live).not.toContain("log_rotation_failed");

    chmodSync(`${logPath}.1`, 0o666); // the rolled file kept the attribute
  });

  it("MUTATION: a second failure episode is reported even though an earlier one already was", () => {
    // The notice is suppressed after the first one so a persistent failure does
    // not write one per record — but that suppression has to end when rotation
    // starts working again. Latched for the process lifetime it silences every
    // later episode, and the notice that justified the latch does not survive
    // either: the successful rotations in between carry it into .1, then .2,
    // then off the end. A viewer that starts holding the file open hours later
    // would leave an oversized log with nothing in it to say why.
    const block = (): void => {
      // A successful rotation leaves `.2` behind as a FILE, so clear it before
      // putting a non-empty directory in its place.
      rmSync(`${logPath}.2`, { recursive: true, force: true });
      mkdirSync(`${logPath}.2`, { recursive: true }); // blocks .1 -> .2
      writeFileSync(join(`${logPath}.2`, "blocker"), "no", "utf8");
    };
    const unblock = (): void => rmSync(`${logPath}.2`, { recursive: true, force: true });

    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    writeFileSync(`${logPath}.1`, "GEN1", "utf8"); // a source for the promotion
    block();
    _resetDiagnosticLogForTest();

    write(1, "a"); // episode 1: rotation blocked
    expect(readFileSync(logPath, "utf8")).toContain("log_rotation_failed");

    unblock();
    write(20, "b"); // rotation works again — and carries episode 1's notice away
    expect(readFileSync(logPath, "utf8")).not.toContain("log_rotation_failed");

    block();
    write(20, "c"); // episode 2 must be reported on its own
    expect(readFileSync(logPath, "utf8")).toContain("log_rotation_failed");
  });

  it("MUTATION: claiming an orphan does not overwrite this process's own staged leftover", () => {
    // `renameSync` replaces its destination — this module depends on that two
    // lines later — so claiming an orphan while our own leftover still sits at
    // the staging name destroys a full live file's worth of the newest history.
    //
    // The end state hides it: with one orphan and one live file there are three
    // candidates for two kept slots, so our leftover is aged out either way.
    // What discriminates is interrupting the sequence AFTER our leftover has
    // been filed — `.2` is a non-empty directory, so the orphan's own shift
    // throws — and asking what is in `.1`. Filed first, it is ours; overwritten,
    // it is the orphan's.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const orphan = `${logPath}.${dead.pid}.rotating`;

    mkdirSync(join(tmp, "sub"), { recursive: true });
    // No `.1`: the first shift then has nothing to promote and does not throw.
    mkdirSync(`${logPath}.2`, { recursive: true });
    writeFileSync(join(`${logPath}.2`, "blocker"), "no", "utf8");
    writeFileSync(staging(), "OUR-OWN-LEFTOVER", "utf8");
    writeFileSync(orphan, "ANOTHER-SERVERS-CRASH", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "z");

    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("OUR-OWN-LEFTOVER");
  });

  it("MUTATION: a staging file older than any roll is reclaimed even while its pid is in use", () => {
    // Pids are reused. `isProcessAlive` deliberately answers "alive" for
    // anything but ESRCH, so a crashed server's pid handed to an unrelated
    // process would keep its leftover out of reach for good — one ceiling of
    // disk per occurrence, which is the growth this module exists to stop and
    // the opposite of what the README promises. Age overrides the pid: the
    // window between staging a file and filing it is two adjacent renames.
    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const orphan = `${logPath}.${alive.pid}.rotating`;
      mkdirSync(join(tmp, "sub"), { recursive: true });
      writeFileSync(orphan, "FROM-A-PID-SINCE-REUSED", "utf8");
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(orphan, twoHoursAgo, twoHoursAgo);
      writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
      _resetDiagnosticLogForTest();

      write(1, "z");

      expect(existsSync(orphan)).toBe(false); // reclaimed despite the live pid
      expect(readFileSync(`${logPath}.2`, "utf8")).toBe("FROM-A-PID-SINCE-REUSED");
    } finally {
      alive.kill();
    }
  });

  it("MUTATION: an orphan that cannot be claimed leaves the generations untouched", () => {
    // Filing an orphan shifts generations to make room. Doing that BEFORE
    // proving the orphan can be moved is the same defect the live file's own
    // ordering exists to avoid, re-introduced inside the fix for it: a viewer
    // holding a crash-left file open makes the rename throw with `.2` already
    // replaced and `.1` emptied, and the outer restore does not cover it
    // because nothing of ours was staged.
    //
    // The orphan is a real file — a directory would be filtered out before the
    // claim is even attempted. What blocks it is the CLAIM DESTINATION: a
    // non-empty directory sitting at this process's own staging name.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const orphan = `${logPath}.${dead.pid}.rotating`;

    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1-KEEP-ME", "utf8");
    writeFileSync(`${logPath}.2`, "GEN2-KEEP-ME", "utf8");
    writeFileSync(orphan, "CRASHED-SERVERS-LOG", "utf8");
    mkdirSync(staging(), { recursive: true });
    writeFileSync(join(staging(), "blocker"), "no", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "z");

    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("GEN1-KEEP-ME");
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("GEN2-KEEP-ME");
  });

  it("MUTATION: the newest crash log is the one kept when several orphans are filed", () => {
    // Each orphan filed pushes the previous one down a generation, so the LAST
    // one filed is the one that survives behind the live file. Filed in the
    // order `readdirSync` hands them back, two crashed servers can retain the
    // older log and evict the newer — backwards from how every other
    // generation here is kept.
    //
    // The discriminator is built against the LISTING, not against the pids.
    // `readdirSync` here returns name order (measured: `.11111.` lists before
    // `.99991.`), and name order agrees with numeric order only while the two
    // pids have the same number of digits — so a test that hangs the ages on
    // "the pid spawned second" can, on the strength of two numbers it does not
    // control, put the newer file first in the listing and pass with the sort
    // removed. Two earlier versions of this test did exactly that. So: list
    // the directory, and give the NEWER timestamp to whichever file comes
    // FIRST. An implementation that files in listing order then retains the
    // older one, whatever the pids happen to be.
    const a = spawnSync(process.execPath, ["-e", "0"]);
    const b = spawnSync(process.execPath, ["-e", "0"]);
    expect(a.pid).not.toBe(b.pid);

    const dir = join(tmp, "sub");
    mkdirSync(dir, { recursive: true });
    for (const p of [a, b]) writeFileSync(`${logPath}.${p.pid}.rotating`, "", "utf8");
    const listed = readdirSync(dir)
      .filter((f) => f.endsWith(".rotating"))
      .map((f) => join(dir, f));
    expect(listed).toHaveLength(2);
    const [newer, older] = listed; // newer = listed FIRST, on purpose
    writeFileSync(older, "OLDER-CRASH", "utf8");
    writeFileSync(newer, "NEWER-CRASH", "utf8");
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "z"); // rolls: older filed, then newer, then the live file

    // Live file in .1, the NEWER crash log behind it, the older one aged out.
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("NEWER-CRASH");
    expect(logFiles().length).toBeLessThanOrEqual(3);
  });

  it("MUTATION: a roll that keeps failing does not list the directory on every retry — the sweep waits for a roll that has succeeded", () => {
    // The reclaim sweep is the one part of a roll that costs a `readdir`. A
    // live file that cannot be rolled retries once per back-off — at the
    // smallest ceiling, every few hundred records — and each retry paid for a
    // listing of a directory the operator chose, synchronously, on the
    // `uncaughtException` path. So after a failed roll the sweep is skipped
    // until a roll succeeds.
    //
    // Observable without counting calls: an orphan that appears DURING the
    // failed episode is not noticed by the roll that recovers (no listing),
    // and IS noticed by the roll after that (the skip ends with the success).
    // Both halves are asserted. The first is the skip; the second is the flag
    // being cleared — skipping forever would be a file the ceiling does not
    // count, kept for good, which is what the sweep exists to stop.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const orphan = `${logPath}.${dead.pid}.rotating`;

    mkdirSync(join(tmp, "sub"), { recursive: true });
    // Block the staging name so the roll fails without having moved anything.
    mkdirSync(staging(), { recursive: true });
    writeFileSync(join(staging(), "blocker"), "no", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "a"); // the roll is attempted and fails
    expect(readFileSync(logPath, "utf8")).toContain("log_rotation_failed");

    // The episode ends, and a crashed server's leftover lands meanwhile.
    rmSync(staging(), { recursive: true, force: true });
    writeFileSync(orphan, "CRASHED-DURING-THE-EPISODE", "utf8");
    write(2, "b"); // past the back-off; exactly one roll, and it succeeds
    expect(existsSync(`${logPath}.1`)).toBe(true); // it rolled
    expect(existsSync(orphan)).toBe(true); // without listing the directory

    write(20, "c"); // the roll after it sweeps
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("CRASHED-DURING-THE-EPISODE");
    expect(logFiles().length).toBeLessThanOrEqual(3);
  });

  it("MUTATION: a roll does not delete the oldest generation it is not going to promote into", () => {
    // The shift used to unlink `.2` before promoting `.1` into it. With `.1`
    // absent — nothing to promote — the unlink still ran, so a roll destroyed
    // an old generation for no reason at all. The same ordering is what loses
    // `.2` when `.1` exists but cannot be moved, which is the case a Windows
    // viewer holding `.1` without delete sharing produces and which no test
    // here can stage; this is the reachable half of it.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.2`, "OLDEST-KEEP-ME", "utf8"); // and no .1
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "z"); // rolls

    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("OLDEST-KEEP-ME");
    expect(existsSync(`${logPath}.1`)).toBe(true); // the live file took .1
  });

  it("MUTATION: a staged log from a server that has exited is filed, not left on disk forever", () => {
    // A crash between staging the live file and filing it leaves one behind,
    // and the pid in the name means the restarted server — new pid — never
    // looks at it again. One up-to-a-ceiling file per crashed pid, kept
    // forever, is growth without a limit: the exact thing this module exists
    // to stop, hiding under a name the ceiling does not count.
    //
    // `spawnSync` returns only once the child has exited, so its pid is a pid
    // that is definitely gone rather than one guessed to be free.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    expect(dead.pid).toBeGreaterThan(0);
    const orphan = `${logPath}.${dead.pid}.rotating`;

    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(orphan, "CRASHED-SERVERS-LOG", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    write(1, "z"); // rolls

    expect(existsSync(orphan)).toBe(false); // no longer outside the chain
    // Filed rather than deleted: a staged file IS a generation, and it is older
    // than the live file this roll is filing, so it ends up behind it.
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("CRASHED-SERVERS-LOG");
    // And the directory is back to what the ceiling actually counts.
    expect(logFiles().length).toBeLessThanOrEqual(3);
  });

  it("MUTATION: a roll that fails AFTER staging puts the live file back instead of stranding it", () => {
    // Staging succeeds and the shift after it throws — a viewer holding `.1`
    // open is enough. Without the restore, the whole live file is left under
    // the staging name and the append starts a fresh empty one: the newest
    // generation ends up outside the `.1`/`.2` chain, reclaimed only by a later
    // roll from this same pid and never by another server, so every occurrence
    // adds a full ceiling to the directory for good.
    //
    // The blocker is on `.2` rather than on the staging name, which is the
    // whole point: the earlier pin blocked staging, the one path where this
    // state cannot arise.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1-KEEP-ME", "utf8");
    mkdirSync(`${logPath}.2`, { recursive: true });
    writeFileSync(join(`${logPath}.2`, "blocker"), "no", "utf8");
    writeFileSync(logPath, "OLD-HISTORY" + "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    logDiagnostic({ kind: "slow_tool", tool: "after", elapsed_ms: 1, args_size: 0 });

    const live = readFileSync(logPath, "utf8");
    expect(live).toContain("OLD-HISTORY"); // the live file kept its content
    expect(live).toContain('"tool":"after"'); // and is still being written to
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("GEN1-KEEP-ME");
    // Nothing stranded under any other name.
    expect(existsSync(staging())).toBe(false);
  });

  it("MUTATION: a promotion that fails for any reason but absence aborts the roll instead of overwriting .1", () => {
    // `.1` -> `.2` can fail with `.1` still on disk: `.2` locked, or `.2` a
    // directory. Treating that like "the source was absent" and carrying on
    // means the live file's rename REPLACES the surviving `.1` - the newest
    // retained generation thrown away, and nothing recorded to say so. Only a
    // missing source is ordinary; everything else has to abort the rotation.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1-KEEP-ME", "utf8");
    mkdirSync(`${logPath}.2`, { recursive: true }); // blocks both unlink and rename
    writeFileSync(join(`${logPath}.2`, "blocker"), "no", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING), "utf8");
    _resetDiagnosticLogForTest();

    logDiagnostic({ kind: "slow_tool", tool: "after", elapsed_ms: 1, args_size: 0 });

    // The generation that was there is still there, byte for byte.
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("GEN1-KEEP-ME");
    // And the aborted rotation is on record rather than silent.
    const live = readFileSync(logPath, "utf8");
    expect(live).toContain("log_rotation_failed");
    expect(live).toContain('"tool":"after"');
  });

  it("MUTATION: a roll on a live file that is gone must not destroy the generations that are there", () => {
    // The generation shift is destructive - it unlinks the oldest and promotes
    // the rest - so it must not run on the strength of an estimate that turns
    // out to describe a file that is not there. Discovering the absence only
    // when the final rename fails is too late: by then .2 is unlinked and .1
    // has been moved into it, which is exactly the concurrent case the module
    // plans for (another writer rolled the file, and this one shreds its fresh
    // .1). Every other assertion in this block still passes without the check.
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(`${logPath}.1`, "GEN1-KEEP-ME", "utf8");
    writeFileSync(`${logPath}.2`, "GEN2-KEEP-ME", "utf8");
    writeFileSync(logPath, "x".repeat(MIN_CEILING - 45 * 1000), "utf8");
    _resetDiagnosticLogForTest();

    const CHUNK = 30 * 1000;
    const chunk = (tag: string): void => {
      logDiagnostic({ kind: "slow_tool", tool: tag + "z".repeat(CHUNK), elapsed_ms: 1, args_size: 0 });
    };
    chunk("first"); // seeds the estimate from the pre-existing file; no roll yet
    rmSync(logPath);
    chunk("second"); // the estimate says "over the ceiling"; the file is gone

    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("GEN1-KEEP-ME");
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("GEN2-KEEP-ME");
  });

  it("a live file deleted underneath the process is not reported as a rotation failure", () => {
    // The estimate is only re-read from disk every ceiling/16 bytes, so a log
    // deleted by hand stays invisible for a while and the next roll renames a
    // file that is not there. That is not a failure, and calling it one puts a
    // `log_rotation_failed` record in a log that is rotating correctly.
    //
    // Sizes are chosen so the deleted file is still missing when the roll is
    // attempted: two 30 KB records leave the estimate ~15 KB past the ceiling
    // (so the second one rolls) while their 60 KB total stays under the 64 KiB
    // re-stat interval (so the stale estimate is what drives it). A record
    // small enough to be recreated by an append first would never reach the
    // branch, and one large enough to trip the re-stat would correct it.
    const CHUNK = 30 * 1000;
    const chunk = (tag: string): void => {
      logDiagnostic({ kind: "slow_tool", tool: tag + "z".repeat(CHUNK), elapsed_ms: 1, args_size: 0 });
    };

    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(logPath, "x".repeat(MIN_CEILING - 45 * 1000), "utf8");
    _resetDiagnosticLogForTest();

    chunk("first"); // seeds the estimate from the pre-existing file; no roll yet
    expect(existsSync(`${logPath}.1`)).toBe(false);

    rmSync(logPath);
    chunk("second"); // the estimate now says "over the ceiling"; the file is gone

    const live = readFileSync(logPath, "utf8");
    expect(live).not.toContain("log_rotation_failed");
    expect(existsSync(`${logPath}.1`)).toBe(false); // nothing was there to roll
    expect(live).toContain('"tool":"second');
  });
});
