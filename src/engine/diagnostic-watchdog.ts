/**
 * diagnostic-watchdog.ts — passive self-CPU watchdog (issue #365).
 *
 * Samples `process.cpuUsage()` once per window and emits a `cpu_spike` event
 * when single-core CPU% exceeds the threshold. Passive in the sense that the
 * sample itself costs microseconds (no `tools/call` round-trip), so polling
 * does not bloat the process the way the PR #366 phase 1 polling did.
 *
 * Env vars:
 *   DESKTOP_TOUCH_CPU_WATCHDOG_DISABLE      — set to "1" to disable entirely
 *   DESKTOP_TOUCH_CPU_WATCHDOG_THRESHOLD_PCT — default 30 (single-core %)
 *   DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS     — default 10_000 (sample window)
 */

import { logDiagnostic } from "./diagnostic-log.js";
import { getProcessHealth } from "./process-health.js";

const DEFAULT_THRESHOLD_PCT = 30;
const DEFAULT_WINDOW_MS = 10_000;

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface CpuWatchdogHandle {
  stop(): void;
}

/**
 * Start the watchdog. Returns a handle whose `stop()` clears the timer.
 * Returns `null` if disabled via env var (caller can ignore safely).
 */
export function startCpuWatchdog(): CpuWatchdogHandle | null {
  if (process.env.DESKTOP_TOUCH_CPU_WATCHDOG_DISABLE === "1") return null;

  const thresholdPct = parsePositiveNumber(
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_THRESHOLD_PCT,
    DEFAULT_THRESHOLD_PCT,
  );
  const windowMs = parsePositiveNumber(
    process.env.DESKTOP_TOUCH_CPU_WATCHDOG_WINDOW_MS,
    DEFAULT_WINDOW_MS,
  );

  let prevCpu = process.cpuUsage();
  let prevHr = process.hrtime.bigint();

  const timer = setInterval(() => {
    const cpu = process.cpuUsage(prevCpu);
    const hr = process.hrtime.bigint();
    const wallNs = Number(hr - prevHr);
    prevCpu = process.cpuUsage();
    prevHr = hr;

    // wallNs can be 0 in pathological clock edge cases — guard before divide.
    if (wallNs <= 0) return;
    const cpuNs = (cpu.user + cpu.system) * 1000; // us → ns
    const cpuPct = (cpuNs / wallNs) * 100;

    if (cpuPct >= thresholdPct) {
      const health = getProcessHealth();
      logDiagnostic({
        kind: "cpu_spike",
        cpu_pct: Math.round(cpuPct * 10) / 10,
        window_ms: Math.round(wallNs / 1e6),
        rss_mb: Math.round(health.memory.rssBytes / (1024 * 1024)),
        inflight: health.shutdown.inflightCount,
        lastRpcMethod: health.lastRpc.method,
      });
    }
  }, windowMs);
  if (timer.unref) timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
