/**
 * model-registry.ts — TypeScript-side model variant resolver and cache (ADR-005 D4').
 *
 * Phase 4a scope (this file):
 *   - `ModelManifest` schema (JSON shape stored at GitHub Releases)
 *   - `selectVariant(modelName, profile)` — picks the best variant for a given
 *     `NativeCapabilityProfile` from the manifest
 *   - `pathFor(modelName, variantName)` — resolves the on-disk cache path
 *   - sha256 verification helper
 *   - LRU eviction is **not** implemented in 4a (just naive cap)
 *
 * Phase 4b scope (deferred):
 *   - HTTP download from multi-mirror (GitHub Releases → HuggingFace Hub → R2)
 *   - Streaming sha256 verify during download
 *   - Background variant pre-fetch
 *   - LRU eviction policy
 *   - Manifest signature verification (separate ADR if needed)
 *
 * The native (Rust) side mirrors `pathFor` in `src/vision_backend/registry.rs`
 * so both halves agree on where the model file lives. All actual file IO and
 * download orchestration lives here in TypeScript — keeping the Rust side
 * stateless about file management.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { NativeCapabilityProfile } from "../native-engine.js";

// ── Manifest schema ──────────────────────────────────────────────────────────

export interface ModelManifest {
  schema: "1.0";
  generated_at?: string;
  models: Record<string, ModelEntry>;
}

export interface ModelEntry {
  /** "ui_detector" | "text_recognizer" | "icon_classifier" | "state_classifier" | ... */
  task: string;
  variants: ModelVariant[];
}

export interface ModelVariant {
  /** Variant identifier, e.g. "winml-fp16", "dml-fp16", "rocm-fp16", "vulkan-ncnn", "cpu-int8". */
  name: string;
  /** EP names this variant requires. ANY one of them must be available. */
  ep: ReadonlyArray<EpName>;
  /** Default "onnx". "ncnn" indicates a `.param` + `.bin` pair. */
  format?: "onnx" | "ncnn";
  url: string;
  sha256: string;
  size_mb: number;
  /** Optional architecture floor: e.g. "ada", "ampere", "rdna3", "rdna4". */
  min_arch?: string;
  /** Optional OS floor: e.g. "win11_24h2". */
  min_os?: string;
  /** Optional ROCm version floor: e.g. "7.2.1". */
  min_rocm?: string;
  /** Measured warm latency in ms keyed by device label (e.g. "rx9070xt"). */
  bench_ms?: Record<string, number>;
}

export type EpName =
  | "WinML" | "DirectML" | "ROCm" | "MIGraphX"
  | "CUDA" | "TensorRT" | "Vulkan" | "CoreML" | "OpenVINO" | "CPU";

// ── Public surface ───────────────────────────────────────────────────────────

export interface ModelRegistryOptions {
  cacheRoot?: string;
  /** Maximum total cache size in MB (Phase 4a: enforced only at warning level). */
  maxSizeMb?: number;
}

export class ModelRegistry {
  readonly cacheRoot: string;
  readonly maxSizeMb: number;
  private manifest: ModelManifest | null = null;

  constructor(opts: ModelRegistryOptions = {}) {
    this.cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
    this.maxSizeMb = opts.maxSizeMb ?? 5120;
    if (!existsSync(this.cacheRoot)) {
      try { mkdirSync(this.cacheRoot, { recursive: true }); } catch { /* swallow — registry usable in read-only mode */ }
    }
  }

  /** Load and validate a `models.json` manifest from a local file path. */
  loadManifestFromFile(path: string): ModelManifest {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const m = validateManifest(parsed);
    this.manifest = m;
    return m;
  }

  /** Inject a manifest directly (tests / pre-loaded scenarios). */
  setManifest(m: ModelManifest): void {
    this.manifest = validateManifest(m as unknown);
  }

  getManifest(): ModelManifest | null { return this.manifest; }

  /**
   * Choose the best variant for a model given the runtime capability profile.
   *
   * Selection order (ADR-005 D2'):
   *   1. EP availability gate (variant.ep must intersect profile EP set)
   *   2. min_arch / min_os / min_rocm gates
   *   3. bench_ms[device] ascending (faster first); fall back to size_mb ascending
   *
   * Returns null when no variant is compatible — caller falls back to Tier ∞
   * (win-ocr.exe) or Vulkan/ncnn lane.
   */
  selectVariant(modelName: string, profile: NativeCapabilityProfile): ModelVariant | null {
    if (!this.manifest) return null;
    const entry = this.manifest.models[modelName];
    if (!entry) return null;

    const supportedEps = collectAvailableEps(profile);
    const deviceKey = profile.gpuVendor === "AMD" && profile.gpuArch === "RDNA4" ? "rx9070xt"
      : profile.gpuVendor === "NVIDIA" && profile.gpuArch === "Ada" ? "rtx4090"
      : profile.gpuVendor === "Intel" ? "iris_xe"
      : "cpu";

    const compatible = entry.variants.filter((v) => isVariantCompatible(v, profile, supportedEps));
    if (compatible.length === 0) return null;

    compatible.sort((a, b) => {
      const benchA = a.bench_ms?.[deviceKey] ?? Number.POSITIVE_INFINITY;
      const benchB = b.bench_ms?.[deviceKey] ?? Number.POSITIVE_INFINITY;
      if (benchA !== benchB) return benchA - benchB;
      return a.size_mb - b.size_mb;
    });
    return compatible[0]!;
  }

  /** Resolve on-disk path for `<cache>/<model>/<variant>.{onnx|param}`. */
  pathFor(modelName: string, variant: ModelVariant): string {
    const ext = variant.format === "ncnn" ? "param" : "onnx";
    return join(this.cacheRoot, modelName, `${variant.name}.${ext}`);
  }

  /**
   * Check if a variant is present locally and its sha256 matches.
   * Returns the path on success, null otherwise. Phase 4a: no auto-download.
   * Phase 4b will trigger an HTTP download here when missing.
   */
  verifyLocal(modelName: string, variant: ModelVariant): string | null {
    const p = this.pathFor(modelName, variant);
    if (!existsSync(p)) return null;
    try {
      const buf = readFileSync(p);
      const got = createHash("sha256").update(buf).digest("hex");
      if (got.toLowerCase() === variant.sha256.toLowerCase()) return p;
      console.error(`[model-registry] sha256 mismatch for ${modelName}/${variant.name} (got ${got.slice(0, 12)}…, want ${variant.sha256.slice(0, 12)}…)`);
      return null;
    } catch (err) {
      console.error(`[model-registry] read failed for ${p}:`, err);
      return null;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultCacheRoot(): string {
  return join(homedir(), ".desktop-touch-mcp", "models");
}

function validateManifest(input: unknown): ModelManifest {
  if (typeof input !== "object" || input === null) throw new Error("manifest must be an object");
  const m = input as ModelManifest;
  if (m.schema !== "1.0") throw new Error(`unsupported manifest schema: ${String(m.schema)}`);
  if (typeof m.models !== "object") throw new Error("manifest.models must be an object");
  for (const [name, entry] of Object.entries(m.models)) {
    if (!Array.isArray(entry.variants) || entry.variants.length === 0) {
      throw new Error(`model ${name}: variants must be a non-empty array`);
    }
    for (const v of entry.variants) {
      if (!v.name || !Array.isArray(v.ep) || !v.url || !v.sha256 || typeof v.size_mb !== "number") {
        throw new Error(`model ${name} variant ${String(v.name)}: missing required fields`);
      }
    }
  }
  return m;
}

function collectAvailableEps(profile: NativeCapabilityProfile): Set<EpName> {
  const eps = new Set<EpName>();
  if (profile.winml)     eps.add("WinML");
  if (profile.directml)  eps.add("DirectML");
  if (profile.rocm)      eps.add("ROCm");
  if (profile.rocm)      eps.add("MIGraphX"); // MIGraphX requires ROCm
  if (profile.cuda)      eps.add("CUDA");
  if (profile.tensorrt)  eps.add("TensorRT");
  // Vulkan EP availability is not currently reported by the profile (Phase 4b
  // adds Vulkan compute device probe). Conservatively assume Vulkan exists on
  // any non-zero-VRAM GPU until proper detection is added.
  if (profile.gpuVramMb > 0) eps.add("Vulkan");
  eps.add("CPU"); // always
  return eps;
}

function isVariantCompatible(
  v: ModelVariant,
  profile: NativeCapabilityProfile,
  eps: ReadonlySet<EpName>,
): boolean {
  // EP gate
  if (!v.ep.some((e) => eps.has(e))) return false;
  // Arch gate
  if (v.min_arch && !archMeets(profile.gpuArch, v.min_arch)) return false;
  // OS gate (only "win11_24h2" supported for now)
  if (v.min_os === "win11_24h2" && (profile.os !== "windows" || profile.osBuild < 26100)) return false;
  // ROCm gate
  if (v.min_rocm && !profile.rocm) return false;
  return true;
}

const ARCH_ORDER: Record<string, number> = {
  "RDNA1": 1, "RDNA2": 2, "RDNA3": 3, "RDNA4": 4,
  "Turing": 1, "Ampere": 2, "Ada": 3, "Blackwell": 4,
  "Alchemist": 1, "Battlemage": 2,
  "GCN5": 1,
  "Xe": 1,
};
function archMeets(actual: string, required: string): boolean {
  const a = ARCH_ORDER[actual];
  const r = ARCH_ORDER[required.charAt(0).toUpperCase() + required.slice(1).toLowerCase()] ?? ARCH_ORDER[required];
  if (a === undefined || r === undefined) return true; // unknown → permissive
  return a >= r;
}
