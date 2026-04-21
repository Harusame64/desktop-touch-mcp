import { describe, it, expect, vi } from "vitest";
import { GpuWarmupManager } from "../../src/engine/vision-gpu/warmup.js";

describe("GpuWarmupManager", () => {
  it("starts cold", () => {
    const m = new GpuWarmupManager();
    expect(m.getState()).toBe("cold");
  });

  it("transitions cold → warming → warm", async () => {
    const m = new GpuWarmupManager({ coldWarmupMs: 0 });
    const p = m.ensureWarm({ kind: "game", id: "game-1" });
    expect(m.getState()).toBe("warming");
    await p;
    expect(m.getState()).toBe("warm");
  });

  it("second ensureWarm for same target returns warm immediately without re-running warmup", async () => {
    let calls = 0;
    const m = new GpuWarmupManager({
      warmupFn: async () => { calls++; },
    });
    await m.ensureWarm({ kind: "game", id: "game-1" });
    await m.ensureWarm({ kind: "game", id: "game-1" });
    expect(calls).toBe(1);
    expect(m.getState()).toBe("warm");
  });

  it("concurrent ensureWarm calls coalesce into one warmup", async () => {
    let calls = 0;
    const m = new GpuWarmupManager({
      warmupFn: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    const [s1, s2] = await Promise.all([
      m.ensureWarm({ kind: "game", id: "game-1" }),
      m.ensureWarm({ kind: "game", id: "game-1" }),
    ]);
    expect(calls).toBe(1);
    expect(s1).toBe("warm");
    expect(s2).toBe("warm");
  });

  it("warm path is faster than cold path", async () => {
    const COLD_MS = 30;
    const m = new GpuWarmupManager({ coldWarmupMs: COLD_MS });

    const t0 = performance.now();
    await m.ensureWarm({ kind: "game", id: "g" });
    const coldMs = performance.now() - t0;

    const t1 = performance.now();
    await m.ensureWarm({ kind: "game", id: "g" });
    const warmMs = performance.now() - t1;

    expect(coldMs).toBeGreaterThanOrEqual(COLD_MS - 5);
    expect(warmMs).toBeLessThan(coldMs / 2);
  });

  it("dispose transitions to evicted", async () => {
    const m = new GpuWarmupManager({ coldWarmupMs: 0 });
    await m.ensureWarm({ kind: "game", id: "g" });
    await m.dispose();
    expect(m.getState()).toBe("evicted");
  });

  it("after dispose, ensureWarm re-warms", async () => {
    let calls = 0;
    const m = new GpuWarmupManager({ warmupFn: async () => { calls++; } });
    await m.ensureWarm({ kind: "game", id: "g" });
    await m.dispose();
    await m.ensureWarm({ kind: "game", id: "g" });
    expect(calls).toBe(2);
    expect(m.getState()).toBe("warm");
  });

  it("dispose() during in-flight warmup wins the race — state stays evicted", async () => {
    let resolveWarmup!: () => void;
    const m = new GpuWarmupManager({
      warmupFn: () => new Promise<void>((r) => { resolveWarmup = r; }),
    });
    const warmPromise = m.ensureWarm({ kind: "game", id: "g" });
    // dispose while warmup is still in flight
    await m.dispose();
    expect(m.getState()).toBe("evicted");
    // now let warmup finish
    resolveWarmup();
    await warmPromise;
    // state must not flip back to warm
    expect(m.getState()).toBe("evicted");
  });
});
