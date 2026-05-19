/**
 * tests/unit/process-health.test.ts
 *
 * Unit tests for the diagnostic snapshot module exposed via server_status (issue #365).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRpcReceived,
  setInflightCount,
  setShutdownPending,
  clearShutdownPending,
  getProcessHealth,
  _resetProcessHealthForTest,
} from "../../src/engine/process-health.js";

describe("process-health", () => {
  beforeEach(() => {
    _resetProcessHealthForTest();
  });

  it("initial snapshot has null lastRpc and zero/false shutdown state", () => {
    const h = getProcessHealth();
    expect(h.lastRpc.receivedAt).toBeNull();
    expect(h.lastRpc.method).toBeNull();
    expect(h.shutdown.pending).toBe(false);
    expect(h.shutdown.graceMs).toBeNull();
    expect(h.shutdown.inflightCount).toBe(0);
  });

  it("snapshot exposes process-level fields with sane types/ranges", () => {
    const h = getProcessHealth();
    expect(h.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(h.memory.rssBytes).toBeGreaterThan(0);
    expect(h.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(h.memory.heapTotalBytes).toBeGreaterThanOrEqual(h.memory.heapUsedBytes);
    expect(h.cpu.userUs).toBeGreaterThanOrEqual(0);
    expect(h.cpu.systemUs).toBeGreaterThanOrEqual(0);
  });

  it("recordRpcReceived updates lastRpc and uses ISO timestamp", () => {
    recordRpcReceived("tools/call");
    const h = getProcessHealth();
    expect(h.lastRpc.method).toBe("tools/call");
    expect(h.lastRpc.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("recordRpcReceived overwrites previous record", () => {
    recordRpcReceived("initialize");
    recordRpcReceived("tools/list");
    const h = getProcessHealth();
    expect(h.lastRpc.method).toBe("tools/list");
  });

  it("setInflightCount reflects in shutdown.inflightCount", () => {
    setInflightCount(3);
    expect(getProcessHealth().shutdown.inflightCount).toBe(3);
    setInflightCount(0);
    expect(getProcessHealth().shutdown.inflightCount).toBe(0);
  });

  it("setShutdownPending sets pending=true and records graceMs", () => {
    setShutdownPending(60_000);
    const h = getProcessHealth();
    expect(h.shutdown.pending).toBe(true);
    expect(h.shutdown.graceMs).toBe(60_000);
  });

  it("clearShutdownPending resets pending state without touching inflight/lastRpc", () => {
    recordRpcReceived("ping");
    setInflightCount(2);
    setShutdownPending(60_000);
    clearShutdownPending();
    const h = getProcessHealth();
    expect(h.shutdown.pending).toBe(false);
    expect(h.shutdown.graceMs).toBeNull();
    // inflight and lastRpc untouched
    expect(h.shutdown.inflightCount).toBe(2);
    expect(h.lastRpc.method).toBe("ping");
  });
});
