/**
 * tests/unit/perception-dormancy.test.ts
 *
 * Issue #365 Phase 3 — idle-aware perception dormancy. Verifies the watcher
 * decision logic (when to enter dormancy) and the wake path's diagnostic
 * event emission. The actual sidecar lifecycle (`ensureNativeEventRuntime`
 * / `stopNativeRuntime`) is exercised indirectly through `isPerceptionDormant`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startPerceptionDormancyWatcher,
  wakePerceptionRuntime,
  isPerceptionDormant,
  _resetDormancyForTest,
} from "../../src/engine/perception/registry.js";
import { _resetDiagnosticLogForTest } from "../../src/engine/diagnostic-log.js";

describe("perception dormancy watcher", () => {
  let tmp: string;
  let logPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dormancy-"));
    logPath = join(tmp, "diag.log");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = logPath;
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE;
    delete process.env.DESKTOP_TOUCH_PERCEPTION_DORMANCY_DISABLE;
    delete process.env.DESKTOP_TOUCH_PERCEPTION_IDLE_MS;
    _resetDiagnosticLogForTest();
    _resetDormancyForTest();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    _resetDormancyForTest();
    _resetDiagnosticLogForTest();
  });

  function readLines(): Array<Record<string, unknown>> {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
  }

  it("returns null when DESKTOP_TOUCH_PERCEPTION_DORMANCY_DISABLE=1", () => {
    process.env.DESKTOP_TOUCH_PERCEPTION_DORMANCY_DISABLE = "1";
    const h = startPerceptionDormancyWatcher(
      () => Date.now() - 999_999,
      () => 0,
    );
    expect(h).toBeNull();
  });

  it("returns a handle when dormancy is enabled", () => {
    const h = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h).not.toBeNull();
    h?.stop();
  });

  it("is idempotent — second start while one is active returns null", () => {
    const h1 = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h1).not.toBeNull();
    const h2 = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h2).toBeNull();
    h1?.stop();
  });

  it("isPerceptionDormant is false initially", () => {
    expect(isPerceptionDormant()).toBe(false);
  });

  it("wakePerceptionRuntime is a no-op when not dormant", () => {
    expect(isPerceptionDormant()).toBe(false);
    wakePerceptionRuntime();
    // Should not log anything (no transition emitted).
    expect(readLines().length).toBe(0);
    expect(isPerceptionDormant()).toBe(false);
  });

  it(
    "watcher does not enter dormancy when lastRpc is null (no RPC yet)",
    async () => {
      // Short idle threshold so the test does not need to wait long.
      process.env.DESKTOP_TOUCH_PERCEPTION_IDLE_MS = "1";
      const h = startPerceptionDormancyWatcher(
        () => null,
        () => 0,
      );
      // Even the first tick of the 10s interval would fire — but the watcher
      // logic short-circuits on `lastRpc === null`. Force a manual check by
      // letting some real time pass; we can't easily synthesize a tick
      // without exposing internals, so we just verify state stays clean for
      // a short window.
      await new Promise((r) => setTimeout(r, 50));
      expect(isPerceptionDormant()).toBe(false);
      expect(readLines().filter((l) => l.kind === "dormancy_transition").length).toBe(0);
      h?.stop();
    },
  );

  it("invalid IDLE_MS env value falls back to default", () => {
    process.env.DESKTOP_TOUCH_PERCEPTION_IDLE_MS = "not-a-number";
    const h = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h).not.toBeNull();
    h?.stop();
  });

  it("negative IDLE_MS env value falls back to default", () => {
    process.env.DESKTOP_TOUCH_PERCEPTION_IDLE_MS = "-5";
    const h = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h).not.toBeNull();
    h?.stop();
  });

  it("watcher handle stop() clears the interval cleanly", () => {
    const h = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h).not.toBeNull();
    h?.stop();
    // After stop, a fresh start should succeed (interval slot is empty again).
    const h2 = startPerceptionDormancyWatcher(
      () => null,
      () => 0,
    );
    expect(h2).not.toBeNull();
    h2?.stop();
  });
});

describe("DiagnosticEvent — dormancy_transition shape", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dormancy-shape-"));
    logPath = join(tmp, "diag.log");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = logPath;
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE;
    _resetDiagnosticLogForTest();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    _resetDiagnosticLogForTest();
  });

  it("accepts both enter and exit transitions", async () => {
    const { logDiagnostic } = await import("../../src/engine/diagnostic-log.js");
    logDiagnostic({
      kind: "dormancy_transition",
      state: "enter",
      idle_ms: 65_000,
      inflight: 0,
    });
    logDiagnostic({
      kind: "dormancy_transition",
      state: "exit",
      elapsed_ms: 42,
      inflight: 0,
    });
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
    expect(lines.length).toBe(2);
    expect(lines[0].kind).toBe("dormancy_transition");
    expect(lines[0].state).toBe("enter");
    expect(lines[0].idle_ms).toBe(65_000);
    expect(lines[1].state).toBe("exit");
    expect(lines[1].elapsed_ms).toBe(42);
  });
});
