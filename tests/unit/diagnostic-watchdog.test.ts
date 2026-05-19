/**
 * tests/unit/diagnostic-watchdog.test.ts
 *
 * Unit tests for the self-CPU watchdog (issue #365).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCpuWatchdog } from "../../src/engine/diagnostic-watchdog.js";
import { _resetDiagnosticLogForTest } from "../../src/engine/diagnostic-log.js";

describe("diagnostic-watchdog", () => {
  let tmp: string;
  let logPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diagwd-"));
    logPath = join(tmp, "diag.log");
    process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH = logPath;
    delete process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE;
    delete process.env.DESKTOP_TOUCH_CPU_WATCHDOG_DISABLE;
    delete process.env.DESKTOP_TOUCH_CPU_WATCHDOG_THRESHOLD_PCT;
    delete process.env.DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS;
    _resetDiagnosticLogForTest();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    _resetDiagnosticLogForTest();
  });

  function readLines(): Array<Record<string, unknown>> {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
  }

  it("returns null when DESKTOP_TOUCH_CPU_WATCHDOG_DISABLE=1", () => {
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_DISABLE = "1";
    const h = startCpuWatchdog();
    expect(h).toBeNull();
  });

  it("returns a handle when enabled", () => {
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS = "60000"; // long window so it doesn't fire in test
    const h = startCpuWatchdog();
    expect(h).not.toBeNull();
    h?.stop();
  });

  it("logs a cpu_spike event when CPU exceeds threshold inside the window", async () => {
    // Review R1 P3-2: short window + very low threshold so a busy loop reliably
    // fires even on slow CI runners where the interval may be delayed.
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS = "100";
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_THRESHOLD_PCT = "1";
    const h = startCpuWatchdog();
    expect(h).not.toBeNull();

    // Burn CPU for ~150ms so the watchdog's 100ms window captures heavy work.
    const burnUntil = Date.now() + 150;
    while (Date.now() < burnUntil) {
      // tight loop — intentionally
    }
    // Yield so the watchdog interval fires.
    await new Promise((r) => setTimeout(r, 120));
    h?.stop();

    const lines = readLines();
    const spike = lines.find((l) => l.kind === "cpu_spike");
    expect(spike).toBeDefined();
    expect(typeof spike?.cpu_pct).toBe("number");
    expect((spike?.cpu_pct as number) >= 1).toBe(true);
    expect(typeof spike?.rss_mb).toBe("number");
    expect(spike?.lastRpcMethod).toBeDefined();
  });

  it("does not log when CPU stays under threshold", async () => {
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS = "50";
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_THRESHOLD_PCT = "99";
    const h = startCpuWatchdog();
    // Stay idle through a couple windows.
    await new Promise((r) => setTimeout(r, 200));
    h?.stop();
    const spikes = readLines().filter((l) => l.kind === "cpu_spike");
    expect(spikes.length).toBe(0);
  });

  it("invalid env values fall back to defaults", () => {
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_THRESHOLD_PCT = "not-a-number";
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS = "-5";
    // Should not throw; falls back to defaults internally.
    const h = startCpuWatchdog();
    expect(h).not.toBeNull();
    h?.stop();
  });
});
