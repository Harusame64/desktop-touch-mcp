/**
 * tests/unit/diagnostic-log.test.ts
 *
 * Unit tests for the JSONL diagnostic event log (issue #365).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logDiagnostic,
  getDiagnosticLogPath,
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

  it("keeps at most KEPT_GENERATIONS rotated files — total disk stays bounded", () => {
    write(80);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    // The third generation is the one that must never appear.
    expect(existsSync(`${logPath}.3`)).toBe(false);

    for (const f of [logPath, `${logPath}.1`, `${logPath}.2`]) {
      expect(statSync(f).size).toBeLessThanOrEqual(MIN_CEILING + REC_BYTES * 2);
    }
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
