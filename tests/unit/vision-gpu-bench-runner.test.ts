import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmP99, defaultBenchPath } from "../../src/engine/vision-gpu/bench-runner.js";
import type { BenchmarkResult } from "../../src/engine/vision-gpu/benchmark.js";

describe("BenchmarkRunner", () => {
  beforeEach(() => vi.resetModules());

  it("records evicted metric when ensureWarm fails", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        detectCapability: vi.fn().mockReturnValue({ gpuVendor: "AMD", gpuArch: "RDNA4" }),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "evicted"; }
        async dispose() {}
        async recognizeRois() { return []; }
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const runner = new BenchmarkRunner();
    const result = await runner.run({ target: "chrome", warmFrames: 5 });
    expect(result.metrics.length).toBe(1);
    expect(result.metrics[0]!.mode).toBe("cold");
    expect(result.metrics[0]!.notes).toMatch(/evicted/);
  });

  it("records cold + warm + idle metrics on successful warm-up", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue(undefined) },
      nativeEngine: null,
      nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const runner = new BenchmarkRunner();
    const result = await runner.run({ target: "chrome", warmFrames: 3 });
    const cold = result.metrics.filter((m) => m.mode === "cold");
    const warm = result.metrics.filter((m) => m.mode === "warm");
    const idle = result.metrics.filter((m) => m.mode === "idle");
    expect(cold).toHaveLength(1);
    expect(warm).toHaveLength(3);
    expect(idle).toHaveLength(1);
  });

  it("captures capability profile in result", async () => {
    const profile = { gpuVendor: "AMD", gpuArch: "RDNA4" };
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue(profile) },
      nativeEngine: null,
      nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const result = await new BenchmarkRunner().run({ target: "chrome", warmFrames: 1 });
    expect(result.capabilityProfile).toMatchObject({ gpuVendor: "AMD" });
  });

  it("captures null capability profile when nativeVision is null", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: null,
      nativeEngine: null,
      nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "evicted"; }
        async dispose() {}
        async recognizeRois() { return []; }
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const result = await new BenchmarkRunner().run({ target: "terminal", warmFrames: 1 });
    // capabilityProfile should be undefined (nativeVision is null)
    expect(result.capabilityProfile).toBeUndefined();
    expect(result.metrics[0]!.notes).toMatch(/evicted/);
  });

  it("warmP99 returns -1 for empty metrics", () => {
    expect(warmP99({ runId: "x", startedAtMs: 0, metrics: [] })).toBe(-1);
  });

  it("warmP99 picks the 99th-percentile latency", () => {
    const metrics = Array.from({ length: 100 }, (_, i) => ({
      target: "chrome" as const,
      mode: "warm" as const,
      latencyMs: i + 1, // 1..100
      timestampMs: 0,
    }));
    const result: BenchmarkResult = { runId: "x", startedAtMs: 0, metrics };
    // 99th percentile of [1..100]: floor(100*0.99) = 99 → sorted[99] = 100
    const p99 = warmP99(result);
    expect(p99).toBeGreaterThanOrEqual(99);
    expect(p99).toBeLessThanOrEqual(100);
  });

  it("warmP99 ignores cold/idle metrics", () => {
    const result: BenchmarkResult = {
      runId: "x",
      startedAtMs: 0,
      metrics: [
        { target: "chrome" as const, mode: "cold" as const, latencyMs: 1000, timestampMs: 0 },
        { target: "chrome" as const, mode: "warm" as const, latencyMs: 20, timestampMs: 0 },
        { target: "chrome" as const, mode: "idle" as const, latencyMs: 50, timestampMs: 0 },
      ],
    };
    expect(warmP99(result)).toBe(20);
  });

  it("defaultBenchPath produces ~/.desktop-touch-mcp/bench.json", () => {
    const p = defaultBenchPath();
    expect(p).toMatch(/\.desktop-touch-mcp[/\\]bench\.json$/);
  });

  it("runAndWrite writes JSON to specified path", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue({ gpuVendor: "AMD" }) },
      nativeEngine: null,
      nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const tmpDir = (await import("node:os")).tmpdir();
    const { join } = await import("node:path");
    const fs = await import("node:fs");
    const outputPath = join(tmpDir, `bench-test-${Date.now()}.json`);
    const { runAndWrite } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const { path } = await runAndWrite({ target: "chrome", warmFrames: 1, outputPath });
    expect(path).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(parsed.runId).toBeDefined();
    fs.unlinkSync(outputPath);
  });

  it("runAndWrite result contains correct metric counts for warmFrames=2", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue({ gpuVendor: "NVIDIA" }) },
      nativeEngine: null,
      nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const tmpDir = (await import("node:os")).tmpdir();
    const { join } = await import("node:path");
    const fs = await import("node:fs");
    const outputPath = join(tmpDir, `bench-test2-${Date.now()}.json`);
    const { runAndWrite } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const { result } = await runAndWrite({ target: "game", warmFrames: 2, outputPath });
    expect(result.metrics.filter((m) => m.mode === "warm")).toHaveLength(2);
    expect(result.metrics.filter((m) => m.mode === "cold")).toHaveLength(1);
    expect(result.metrics.filter((m) => m.mode === "idle")).toHaveLength(1);
    fs.unlinkSync(outputPath);
  });
});
