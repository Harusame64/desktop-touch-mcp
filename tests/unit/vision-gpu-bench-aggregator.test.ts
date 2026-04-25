import { describe, it, expect } from "vitest";
import {
  aggregate,
  aggregateOne,
  formatMarkdownTable,
  formatBenchMarkdown,
} from "../../src/engine/vision-gpu/bench-aggregator.js";
import type { BenchmarkResult } from "../../src/engine/vision-gpu/benchmark.js";

function syntheticResult(opts: {
  vendor?: string; arch?: string; device?: string;
  warmLatencies?: number[]; cold?: number; notes?: string;
}): BenchmarkResult {
  const metrics = [];
  if (opts.cold !== undefined) {
    metrics.push({ target: "chrome" as const, mode: "cold" as const, latencyMs: opts.cold, timestampMs: 0, notes: opts.notes });
  }
  for (const ms of opts.warmLatencies ?? []) {
    metrics.push({ target: "chrome" as const, mode: "warm" as const, latencyMs: ms, timestampMs: 0 });
  }
  return {
    runId: "test", startedAtMs: 0, metrics,
    capabilityProfile: opts.vendor ? {
      os: "windows", osBuild: 26100,
      gpuVendor: opts.vendor,
      gpuDevice: opts.device ?? "Test GPU",
      gpuArch: opts.arch ?? "Test",
      gpuVramMb: 8192, winml: false, directml: true,
      rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: ["directml"],
    } : undefined,
  };
}

describe("aggregateOne", () => {
  it("computes warm p99 and cold latency for a healthy run", () => {
    const r = syntheticResult({
      vendor: "AMD", arch: "RDNA4", device: "RX 9070 XT",
      cold: 240, warmLatencies: [15, 16, 17, 18, 19, 20],
    });
    const row = aggregateOne(r, "rx9070xt.json");
    expect(row.label).toContain("AMD");
    expect(row.label).toContain("RDNA4");
    expect(row.warmSamples).toBe(6);
    expect(row.ranWarm).toBe(true);
    expect(row.coldMs).toBe(240);
    expect(row.warmP99Ms).toBeGreaterThanOrEqual(15);
    expect(row.warmP99Ms).toBeLessThanOrEqual(20);
  });

  it("marks evicted run with ranWarm=false", () => {
    const r = syntheticResult({
      vendor: "Unknown", cold: 5, notes: "evicted (state=evicted)",
    });
    const row = aggregateOne(r, "evicted.json");
    expect(row.ranWarm).toBe(false);
    expect(row.warmP99Ms).toBeNull();
    expect(row.warmSamples).toBe(0);
    expect(row.notes).toMatch(/evicted/);
  });

  it("falls back to source label when capabilityProfile missing", () => {
    const r = syntheticResult({ warmLatencies: [10] });
    const row = aggregateOne(r, "no-profile.json");
    expect(row.label).toContain("Unknown");
    expect(row.label).toContain("no-profile.json");
  });
});

describe("aggregate", () => {
  it("sorts by warm p99 ascending (faster first)", () => {
    const slow = syntheticResult({ vendor: "Slow", warmLatencies: [50, 50, 50] });
    const fast = syntheticResult({ vendor: "Fast", warmLatencies: [10, 10, 10] });
    const rows = aggregate([
      { result: slow, source: "slow.json" },
      { result: fast, source: "fast.json" },
    ]);
    expect(rows[0]!.label).toContain("Fast");
    expect(rows[1]!.label).toContain("Slow");
  });

  it("places evicted rows last", () => {
    const evicted = syntheticResult({ vendor: "Evicted", cold: 5 });
    const ok = syntheticResult({ vendor: "OK", warmLatencies: [10] });
    const rows = aggregate([
      { result: evicted, source: "e.json" },
      { result: ok, source: "ok.json" },
    ]);
    expect(rows[0]!.label).toContain("OK");
    expect(rows[1]!.label).toContain("Evicted");
    expect(rows[1]!.ranWarm).toBe(false);
  });

  it("returns empty array on empty input", () => {
    expect(aggregate([])).toEqual([]);
  });
});

describe("formatMarkdownTable", () => {
  it("returns placeholder for empty rows", () => {
    expect(formatMarkdownTable([])).toMatch(/no benchmark inputs/);
  });

  it("escapes pipe characters in labels and notes", () => {
    const rows = [{
      label: "Acme | Inc.",
      source: "x.json",
      warmP99Ms: 10, coldMs: 100, warmSamples: 5,
      ranWarm: true, notes: "good | run",
    }];
    const md = formatMarkdownTable(rows);
    expect(md).toContain("Acme \\| Inc.");
    expect(md).toContain("good \\| run");
  });

  it("renders evicted rows with em-dash and italic note", () => {
    const rows = [{
      label: "Test",
      source: "x.json",
      warmP99Ms: null, coldMs: null, warmSamples: 0,
      ranWarm: false,
    }];
    const md = formatMarkdownTable(rows);
    expect(md).toContain("_evicted_");
    expect(md).toMatch(/—/); // em-dash for missing values
  });
});

describe("formatBenchMarkdown", () => {
  it("includes ADR-005 L1/L4/L6 callouts", () => {
    const md = formatBenchMarkdown([]);
    expect(md).toMatch(/L1.*30ms/);
    expect(md).toMatch(/L4.*25%/);
    expect(md).toMatch(/L6.*portability/);
  });
});
