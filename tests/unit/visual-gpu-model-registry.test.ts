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

import path from "node:path";
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
    const v = { name: "webgpu-ncnn", ep: ["WebGPU"] as const, url: "u", sha256: "0".repeat(64), size_mb: 30, format: "ncnn" as const };
    expect(r.pathFor("foo", v).endsWith("webgpu-ncnn.param")).toBe(true);
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

describe("ModelRegistry loads bundled assets/models.json", () => {
  const manifestPath = path.join(process.cwd(), "assets", "models.json");

  it("loadManifestFromFile parses bundled manifest without error", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    expect(() => r.loadManifestFromFile(manifestPath)).not.toThrow();
    const m = r.getManifest();
    expect(m?.schema).toBe("1.0");
    expect(Object.keys(m?.models ?? {}).length).toBeGreaterThanOrEqual(4);
  });

  it("contains florence-2-base, omniparser-v2-icon-detect, paddleocr-v4-server, paddleocr-v4-mobile", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    const models = r.getManifest()!.models;
    expect(models["florence-2-base"]).toBeDefined();
    expect(models["omniparser-v2-icon-detect"]).toBeDefined();
    expect(models["paddleocr-v4-server"]).toBeDefined();
    expect(models["paddleocr-v4-mobile"]).toBeDefined();
  });

  it("selectVariant on RX 9070 XT profile picks WinML or DirectML first for omniparser-v2-icon-detect", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    // bench_ms が空なので size_mb tie-breaker で最小 = winml-fp16 か dml-fp16 のどちらか
    // (同 size なら入力順序で winml が先)
    const profile: NativeCapabilityProfile = {
      os: "windows", osBuild: 26100,
      gpuVendor: "AMD", gpuDevice: "Radeon RX 9070 XT", gpuArch: "RDNA4", gpuVramMb: 16384,
      winml: true, directml: true, rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2", "avx"], backendBuilt: true, epsBuilt: ["directml"],
    };
    const v = r.selectVariant("omniparser-v2-icon-detect", profile);
    expect(v).not.toBeNull();
    expect(["winml-fp16", "dml-fp16"]).toContain(v!.name);
  });

  it("selectVariant falls back to cpu-int8 for CPU-only profile", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    const profile: NativeCapabilityProfile = {
      os: "windows", osBuild: 26100,
      gpuVendor: "Unknown", gpuDevice: "", gpuArch: "Unknown", gpuVramMb: 0,
      winml: false, directml: false, rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: [],
    };
    const v = r.selectVariant("omniparser-v2-icon-detect", profile);
    expect(v?.name).toBe("cpu-int8");
  });

  it("paddleocr-v4-mobile has fewer variants than paddleocr-v4-server", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    const mobile = r.getManifest()!.models["paddleocr-v4-mobile"]!;
    const server = r.getManifest()!.models["paddleocr-v4-server"]!;
    expect(mobile.variants.length).toBeLessThan(server.variants.length);
  });
});

describe("WebGPU EP is recognized (Phase 4b-4 rename from Vulkan)", () => {
  it("selectVariant picks webgpu-fp16 when only GPU VRAM is available", () => {
    const r = new ModelRegistry();
    r.setManifest({
      schema: "1.0",
      models: {
        "t": {
          task: "ui_detector",
          variants: [
            { name: "webgpu-fp16", ep: ["WebGPU"], url: "u", sha256: "0".repeat(64), size_mb: 30 },
            { name: "cpu-int8",    ep: ["CPU"],     url: "u", sha256: "0".repeat(64), size_mb: 12 },
          ],
        },
      },
    });
    const p: NativeCapabilityProfile = {
      os: "windows", osBuild: 26100,
      gpuVendor: "Intel", gpuDevice: "Arc A770", gpuArch: "Alchemist", gpuVramMb: 16384,
      winml: false, directml: false, rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: [],
    };
    // DirectML=false なので WebGPU が唯一の GPU lane、選ばれるべき
    expect(r.selectVariant("t", p)?.name).toBe("webgpu-fp16");
  });
});
