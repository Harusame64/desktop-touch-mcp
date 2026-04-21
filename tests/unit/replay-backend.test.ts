import { describe, it, expect } from "vitest";
import { ReplayBackend } from "../../src/engine/vision-gpu/replay-backend.js";
import { BenchmarkHarness } from "../../src/engine/vision-gpu/benchmark.js";

const FIXTURE_KEY = "window:game-window";

const GAME_FIXTURE = {
  [FIXTURE_KEY]: [
    {
      source: "visual_gpu" as const,
      target: { kind: "window" as const, id: "game-window" },
      label: "Start Match",
      role: "button",
      locator: { visual: { trackId: "track-start" } },
      actionability: ["invoke", "click"] as Array<"invoke" | "click">,
      confidence: 0.94,
      observedAtMs: 0,
      provisional: false,
    },
    {
      source: "visual_gpu" as const,
      target: { kind: "window" as const, id: "game-window" },
      label: "Settings",
      role: "button",
      locator: { visual: { trackId: "track-settings" } },
      actionability: ["invoke", "click"] as Array<"invoke" | "click">,
      confidence: 0.91,
      observedAtMs: 0,
      provisional: false,
    },
  ],
};

describe("ReplayBackend — warmup lifecycle", () => {
  it("starts cold", () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 0 });
    expect(b.getWarmState()).toBe("cold");
  });

  it("transitions cold → warming → warm", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 10 });
    const p = b.ensureWarm({ kind: "game", id: "g" });
    expect(b.getWarmState()).toBe("warming");
    await p;
    expect(b.getWarmState()).toBe("warm");
    await b.dispose();
  });

  it("second ensureWarm returns warm immediately (no re-warmup)", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 10 });
    await b.ensureWarm({ kind: "game", id: "g" });
    const t0 = performance.now();
    await b.ensureWarm({ kind: "game", id: "g" });
    expect(performance.now() - t0).toBeLessThan(5); // sub-ms warm path
    await b.dispose();
  });

  it("concurrent ensureWarm calls coalesce into one warmup", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 20 });
    const [s1, s2] = await Promise.all([
      b.ensureWarm({ kind: "game", id: "g" }),
      b.ensureWarm({ kind: "game", id: "g" }),
    ]);
    expect(s1).toBe("warm");
    expect(s2).toBe("warm");
    await b.dispose();
  });
});

describe("ReplayBackend — candidate snapshot", () => {
  it("returns [] when cold", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 0 });
    const result = await b.getStableCandidates(FIXTURE_KEY);
    expect(result).toHaveLength(0);
    await b.dispose();
  });

  it("returns fixture candidates when warm", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 0, warmFetchMs: 0 });
    await b.ensureWarm({ kind: "game", id: "g" });
    const result = await b.getStableCandidates(FIXTURE_KEY);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("Start Match");
    expect(result[1].label).toBe("Settings");
    await b.dispose();
  });

  it("returns [] for unknown target key", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 0, warmFetchMs: 0 });
    await b.ensureWarm({ kind: "game", id: "g" });
    expect(await b.getStableCandidates("window:unknown")).toHaveLength(0);
    await b.dispose();
  });

  it("getFixtureKeys lists fixture target keys", () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE);
    expect(b.getFixtureKeys()).toContain(FIXTURE_KEY);
  });

  it("returns a copy (mutation of result does not affect store)", async () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: 0, warmFetchMs: 0 });
    await b.ensureWarm({ kind: "game", id: "g" });
    const result = await b.getStableCandidates(FIXTURE_KEY);
    result.length = 0; // mutate the copy
    const result2 = await b.getStableCandidates(FIXTURE_KEY);
    expect(result2).toHaveLength(2); // original unaffected
    await b.dispose();
  });
});

describe("ReplayBackend — dirty signals", () => {
  it("triggerDirty fires listeners", () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE);
    const received: string[] = [];
    b.onDirty((key) => received.push(key));
    b.triggerDirty(FIXTURE_KEY);
    expect(received).toContain(FIXTURE_KEY);
  });

  it("unsubscribe stops listener", () => {
    const b = ReplayBackend.fromRecord(GAME_FIXTURE);
    const received: string[] = [];
    const unsub = b.onDirty((key) => received.push(key));
    unsub();
    b.triggerDirty(FIXTURE_KEY);
    expect(received).toHaveLength(0);
  });
});

describe("ReplayBackend — fromFile (fixture file)", () => {
  it("loads game fixture from JSON file", async () => {
    const b = await ReplayBackend.fromFile(
      "tests/fixtures/benchmark/game/candidates.json",
      { coldWarmupMs: 0, warmFetchMs: 0 }
    );
    await b.ensureWarm({ kind: "game", id: "g" });
    const result = await b.getStableCandidates("window:game-window");
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.label)).toContain("Start Match");
    expect(result.map((c) => c.label)).toContain("Settings");
    expect(result.map((c) => c.label)).toContain("Exit");
    await b.dispose();
  });
});

describe("ReplayBackend — cold/warm latency measurable with BenchmarkHarness", () => {
  it("cold path is slower than warm path (latency gap confirmed)", async () => {
    const COLD_MS = 50;
    const WARM_MS = 5;
    const b = ReplayBackend.fromRecord(GAME_FIXTURE, { coldWarmupMs: COLD_MS, warmFetchMs: WARM_MS });
    const harness = new BenchmarkHarness();

    const coldResult = await harness.measure("game", "cold", async () => {
      await b.ensureWarm({ kind: "game", id: "g" });
      await b.getStableCandidates(FIXTURE_KEY);
    });

    const warmResult = await harness.measure("game", "warm", async () => {
      await b.ensureWarm({ kind: "game", id: "g" });
      await b.getStableCandidates(FIXTURE_KEY);
    });

    // Cold includes warmup (≥ COLD_MS); warm skips it (≈ WARM_MS)
    expect(coldResult.latencyMs).toBeGreaterThan(warmResult.latencyMs);
    expect(warmResult.latencyMs).toBeLessThan(COLD_MS / 2);

    const result = harness.toResult();
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics[0].mode).toBe("cold");
    expect(result.metrics[1].mode).toBe("warm");

    await b.dispose();
  });
});
