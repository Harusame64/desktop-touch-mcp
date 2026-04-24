/**
 * visual-gpu-model-registry.test.ts
 *
 * Phase 4a (ADR-005 D4') — verifies ModelRegistry.selectVariant logic.
 *
 * Coverage:
 *   1. No manifest loaded → selectVariant returns null
 *   2. Unknown model name → null
 *   3. EP gate: variant requires "TensorRT" but profile has only DirectML → null
 *   4. EP gate: variant requires DirectML and profile has it → returned
 *   5. bench_ms ascending sort: faster variant wins
 *   6. size_mb tie-breaker: smaller wins when bench_ms equal/missing
 *   7. arch_floor gate: variant requires RDNA4 but profile is RDNA3 → null
 *   8. min_os gate: variant requires win11_24h2 but profile is older Win → null
 *   9. AMD-first device key resolution: rx9070xt key picks the bench
 *
 * No file I/O. Manifests injected directly via setManifest().
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ModelRegistry, type ModelManifest } from "../../src/engine/vision-gpu/model-registry.js";
import type { NativeCapabilityProfile } from "../../src/engine/native-types.js";

function profile(overrides: Partial<NativeCapabilityProfile> = {}): NativeCapabilityProfile {
  return {
    os: "windows",
    osBuild: 26100,
    gpuVendor: "AMD",
    gpuDevice: "Radeon RX 9070 XT",
    gpuArch: "RDNA4",
    gpuVramMb: 16384,
    winml: true,
    directml: true,
    rocm: false,
    cuda: false,
    tensorrt: false,
    cpuIsa: ["avx2", "avx"],
    backendBuilt: true,
    epsBuilt: ["directml"],
    ...overrides,
  };
}

function manifest(variants: ModelManifest["models"][string]["variants"]): ModelManifest {
  return {
    schema: "1.0",
    models: { "test-model": { task: "ui_detector", variants } },
  };
}

describe("ModelRegistry.selectVariant", () => {
  let registry: ModelRegistry;
  beforeEach(() => {
    registry = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
  });

  it("returns null when no manifest is loaded", () => {
    expect(registry.selectVariant("test-model", profile())).toBeNull();
  });

  it("returns null for unknown model names", () => {
    registry.setManifest(manifest([
      { name: "dml-fp16", ep: ["DirectML"], url: "u", sha256: "0".repeat(64), size_mb: 32 },
    ]));
    expect(registry.selectVariant("nonexistent", profile())).toBeNull();
  });

  it("EP gate filters out variants whose EP is unavailable", () => {
    registry.setManifest(manifest([
      { name: "trt-fp8", ep: ["TensorRT"], url: "u", sha256: "0".repeat(64), size_mb: 18 },
    ]));
    expect(registry.selectVariant("test-model", profile({ tensorrt: false }))).toBeNull();
  });

  it("returns a variant whose EP matches", () => {
    registry.setManifest(manifest([
      { name: "dml-fp16", ep: ["DirectML"], url: "u", sha256: "0".repeat(64), size_mb: 32 },
    ]));
    const v = registry.selectVariant("test-model", profile());
    expect(v?.name).toBe("dml-fp16");
  });

  it("sorts by bench_ms ascending — faster variant wins", () => {
    registry.setManifest(manifest([
      { name: "slow", ep: ["DirectML"], url: "u1", sha256: "0".repeat(64), size_mb: 32, bench_ms: { rx9070xt: 80 } },
      { name: "fast", ep: ["DirectML"], url: "u2", sha256: "1".repeat(64), size_mb: 32, bench_ms: { rx9070xt: 20 } },
    ]));
    expect(registry.selectVariant("test-model", profile())?.name).toBe("fast");
  });

  it("size_mb is the tie-breaker when bench_ms is equal/missing", () => {
    registry.setManifest(manifest([
      { name: "big",   ep: ["DirectML"], url: "u1", sha256: "0".repeat(64), size_mb: 64 },
      { name: "small", ep: ["DirectML"], url: "u2", sha256: "1".repeat(64), size_mb: 18 },
    ]));
    expect(registry.selectVariant("test-model", profile())?.name).toBe("small");
  });

  it("arch gate rejects variants whose min_arch is above the profile arch", () => {
    registry.setManifest(manifest([
      { name: "rdna4-only", ep: ["DirectML"], url: "u", sha256: "0".repeat(64), size_mb: 32, min_arch: "RDNA4" },
    ]));
    expect(registry.selectVariant("test-model", profile({ gpuArch: "RDNA3" }))).toBeNull();
  });

  it("arch gate accepts when profile arch >= min_arch", () => {
    registry.setManifest(manifest([
      { name: "rdna3-or-higher", ep: ["DirectML"], url: "u", sha256: "0".repeat(64), size_mb: 32, min_arch: "RDNA3" },
    ]));
    expect(registry.selectVariant("test-model", profile())?.name).toBe("rdna3-or-higher");
  });

  it("min_os=win11_24h2 rejects older Win builds", () => {
    registry.setManifest(manifest([
      { name: "needs-24h2", ep: ["DirectML"], url: "u", sha256: "0".repeat(64), size_mb: 32, min_os: "win11_24h2" },
    ]));
    expect(registry.selectVariant("test-model", profile({ osBuild: 22631 }))).toBeNull();
  });

  it("AMD RDNA4 profile uses 'rx9070xt' bench_ms key", () => {
    registry.setManifest(manifest([
      { name: "fast-on-amd",    ep: ["DirectML"], url: "u1", sha256: "0".repeat(64), size_mb: 32, bench_ms: { rx9070xt: 20, rtx4090: 80 } },
      { name: "fast-on-nvidia", ep: ["DirectML"], url: "u2", sha256: "1".repeat(64), size_mb: 32, bench_ms: { rx9070xt: 80, rtx4090: 12 } },
    ]));
    expect(registry.selectVariant("test-model", profile())?.name).toBe("fast-on-amd");
  });

  it("CPU EP is always available in the cascade", () => {
    registry.setManifest(manifest([
      { name: "cpu-int8", ep: ["CPU"], url: "u", sha256: "0".repeat(64), size_mb: 12 },
    ]));
    // Profile with NO GPU EPs — CPU still wins.
    expect(registry.selectVariant("test-model", profile({
      directml: false, winml: false, rocm: false, cuda: false, tensorrt: false, gpuVramMb: 0,
    }))?.name).toBe("cpu-int8");
  });
});

describe("ModelRegistry.pathFor", () => {
  it("uses .onnx extension for default format", () => {
    const r = new ModelRegistry({ cacheRoot: "C:/tmp/models" });
    const v = { name: "dml-fp16", ep: ["DirectML"] as const, url: "u", sha256: "0".repeat(64), size_mb: 32 };
    expect(r.pathFor("foo", v).endsWith("dml-fp16.onnx")).toBe(true);
  });

  it("uses .param extension for ncnn format", () => {
    const r = new ModelRegistry({ cacheRoot: "C:/tmp/models" });
    const v = { name: "vulkan-ncnn", ep: ["Vulkan"] as const, url: "u", sha256: "0".repeat(64), size_mb: 30, format: "ncnn" as const };
    expect(r.pathFor("foo", v).endsWith("vulkan-ncnn.param")).toBe(true);
  });
});

describe("ModelRegistry manifest validation", () => {
  it("rejects schema other than '1.0'", () => {
    const r = new ModelRegistry();
    expect(() => r.setManifest({ schema: "2.0" as unknown as "1.0", models: {} })).toThrow();
  });

  it("rejects models with empty variants", () => {
    const r = new ModelRegistry();
    expect(() => r.setManifest({
      schema: "1.0",
      models: { broken: { task: "x", variants: [] } },
    })).toThrow();
  });

  it("rejects variants missing required fields", () => {
    const r = new ModelRegistry();
    expect(() => r.setManifest({
      schema: "1.0",
      models: {
        bad: { task: "x", variants: [{ name: "v", ep: [] as never, url: "u", sha256: "", size_mb: 0 } as unknown as never] },
      },
    } as ModelManifest)).toThrow();
  });
});
