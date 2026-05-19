/**
 * process-health.ts — diagnostic snapshot of the MCP process internals.
 *
 * Surfaced through `server_status` so external samplers can observe dormant /
 * shutdown progression that is otherwise invisible (issue #365):
 *   - dormant: thread/handle/WS shrinks but no log signal — needs poll path
 *   - shutdown: stdin EOF deferred grace (60s) is silent unless caller asks
 *
 * server-windows.ts is the source of truth for shutdown / inflight state and
 * pushes updates via the setters below. This module never reads server-windows
 * state directly (avoids a cycle and keeps tool layer testable).
 */

let _lastRpcReceivedAt: number | null = null;
let _lastRpcMethod: string | null = null;
let _shutdownPending = false;
let _shutdownGraceMs: number | null = null;
let _inflightCount = 0;

const _initialCpu = process.cpuUsage();

export function recordRpcReceived(method: string): void {
  _lastRpcReceivedAt = Date.now();
  _lastRpcMethod = method;
}

export function setInflightCount(n: number): void {
  _inflightCount = n;
}

export function setShutdownPending(graceMs: number): void {
  _shutdownPending = true;
  _shutdownGraceMs = graceMs;
}

export function clearShutdownPending(): void {
  _shutdownPending = false;
  _shutdownGraceMs = null;
}

export interface ProcessHealth {
  uptimeSec: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  cpu: {
    userUs: number;
    systemUs: number;
  };
  shutdown: {
    pending: boolean;
    graceMs: number | null;
    inflightCount: number;
  };
  lastRpc: {
    receivedAt: string | null;
    method: string | null;
  };
}

export function getProcessHealth(): ProcessHealth {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage(_initialCpu);
  return {
    uptimeSec: Math.floor(process.uptime()),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
    cpu: {
      userUs: cpu.user,
      systemUs: cpu.system,
    },
    shutdown: {
      pending: _shutdownPending,
      graceMs: _shutdownGraceMs,
      inflightCount: _inflightCount,
    },
    lastRpc: {
      receivedAt:
        _lastRpcReceivedAt !== null
          ? new Date(_lastRpcReceivedAt).toISOString()
          : null,
      method: _lastRpcMethod,
    },
  };
}

/** Test-only: reset module-level state. Not exposed via index. */
export function _resetProcessHealthForTest(): void {
  _lastRpcReceivedAt = null;
  _lastRpcMethod = null;
  _shutdownPending = false;
  _shutdownGraceMs = null;
  _inflightCount = 0;
}
