import { describe, it, expect } from "vitest";
import { BenchmarkHarness } from "../../src/engine/vision-gpu/benchmark.js";

describe("BenchmarkHarness", () => {
  it("measure records latency and returns metrics", async () => {
    const h = new BenchmarkHarness();
    const m = await h.measure("game", "cold", async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(m.target).toBe("game");
    expect(m.mode).toBe("cold");
    expect(m.latencyMs).toBeGreaterThanOrEqual(5);
    expect(m.timestampMs).toBeGreaterThan(0);
  });

  it("measure accepts extras and merges them", async () => {
    const h = new BenchmarkHarness();
    const m = await h.measure("chrome", "warm", async () => {}, {
      textRecall: 0.95,
      textPrecision: 0.92,
    });
    expect(m.textRecall).toBe(0.95);
    expect(m.textPrecision).toBe(0.92);
  });

  it("record adds metrics directly", () => {
    const h = new BenchmarkHarness();
    h.record({ target: "terminal", mode: "idle", latencyMs: 5, timestampMs: Date.now() });
    expect(h.getMetrics()).toHaveLength(1);
    expect(h.getMetrics()[0].target).toBe("terminal");
  });

  it("toResult includes all three targets in one run", async () => {
    const h = new BenchmarkHarness();
    await h.measure("game", "cold", async () => {});
    await h.measure("chrome", "warm", async () => {});
    await h.measure("terminal", "idle", async () => {});
    const result = h.toResult();
    expect(result.metrics).toHaveLength(3);
    const targets = result.metrics.map((m) => m.target);
    expect(targets).toContain("game");
    expect(targets).toContain("chrome");
    expect(targets).toContain("terminal");
  });

  it("getMetrics returns a copy — mutations do not affect the harness", async () => {
    const h = new BenchmarkHarness();
    await h.measure("game", "cold", async () => {});
    const copy = h.getMetrics();
    copy.push({ target: "terminal", mode: "idle", latencyMs: 0, timestampMs: 0 });
    expect(h.getMetrics()).toHaveLength(1);
  });
});
