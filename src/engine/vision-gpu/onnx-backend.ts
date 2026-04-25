/**
 * onnx-backend.ts — Phase 4b-5 (ADR-005 D1' / D5') VisualBackend implementation.
 *
 * Thin TypeScript wrapper around the Rust-internal vision_backend module
 * exposed via napi-rs. Inference runs on a libuv worker thread (compute) and
 * resolves on V8 main (resolve), exactly mirroring the existing
 * `UiaGetElementsTask` pattern in `src/lib.rs`.
 *
 * Phase 4b-5 behaviour:
 *   - `ensureWarm` loads `assets/models.json` manifest, selects one variant per
 *     stage model, and calls `visionInitSession` for each stage. Sessions are
 *     stored in the Rust-side VisionSessionPool. If any stage fails, transitions
 *     to "evicted".
 *   - `recognizeRois` calls `runStagePipeline` (stage-pipeline.ts) which
 *     orchestrates 3 serial `visionRecognizeRois` calls (Stage 1 Florence-2 /
 *     Stage 2 OmniParser-v2 / Stage 3 PaddleOCR-v4). Each stage is currently
 *     a stub on the Rust side (4b-5a/b/c will add real inference).
 *   - `getStableCandidates` returns per-target snapshot from last recognise call.
 *   - `onDirty` listeners fire when `recognizeRois` produces a new snapshot.
 *   - `dispose` clears TS-side state (Rust pool entries remain until process exit).
 *
 * Failure handling (L5 process isolation):
 *   - If the native addon is missing OR the Rust panic-isolation barrier
 *     surfaces an Err, we log and return [] / "evicted". The MCP server never
 *     dies because of inference failure.
 *
 * When the Rust binding is unavailable (e.g. native addon missing on dev
 * machine), `OnnxBackend` is NOT attached and `desktop-register.ts` falls
 * back to `PocVisualBackend` automatically.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nativeVision, type NativeRawCandidate } from "../native-engine.js";
import type { VisualBackend } from "./backend.js";
import { ModelRegistry, type ModelVariant } from "./model-registry.js";
import { runStagePipeline, type StageSessionKeys, type StagePipelineInput } from "./stage-pipeline.js";
import type { RoiInput, UiEntityCandidate, WarmState, WarmTarget } from "./types.js";
import type { NativeCapabilityProfile, NativeSessionInit } from "../native-types.js";

// Manifest path: dist/engine/vision-gpu/onnx-backend.js → ../../.. = project root
const ASSETS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets");
const MANIFEST_PATH = join(ASSETS_DIR, "models.json");

export interface OnnxBackendOptions {
  /** Optional override for the captured frame dimensions when known by the caller. */
  defaultFrameWidth?: number;
  defaultFrameHeight?: number;
}

export class OnnxBackend implements VisualBackend {
  private state: WarmState = "cold";
  private readonly snapshots = new Map<string, UiEntityCandidate[]>();
  private readonly listeners = new Set<(targetKey: string) => void>();
  private readonly opts: OnnxBackendOptions;
  private stageKeys: StageSessionKeys | null = null;
  private readonly registry = new ModelRegistry();

  constructor(opts: OnnxBackendOptions = {}) {
    this.opts = opts;
  }

  /** True when the native vision addon is built and loaded. */
  static isAvailable(): boolean {
    return nativeVision !== null && typeof nativeVision.visionRecognizeRois === "function";
  }

  async ensureWarm(_target: WarmTarget): Promise<WarmState> {
    if (!OnnxBackend.isAvailable()) {
      this.state = "evicted";
      return this.state;
    }
    // Idempotent: if already warm with session keys, short-circuit.
    if (this.state === "warm" && this.stageKeys !== null) return "warm";

    // 4b-5c: typeof visionInitSession guard removed (B1 cleanup).
    // visionInitSession is always available in post-4b-5c builds; if absent,
    // OnnxBackend.isAvailable() already catches the case via visionRecognizeRois
    // check, or the session init below fails gracefully → evicted transition.

    // Load bundled manifest (fallback gracefully if missing — treat as evicted).
    try {
      this.registry.loadManifestFromFile(MANIFEST_PATH);
    } catch (err) {
      console.error("[onnx-backend] manifest load failed:", err);
      this.state = "evicted";
      return this.state;
    }

    const profile = nativeVision!.detectCapability!();
    const stage1Model = "florence-2-base";
    const stage2Model = "omniparser-v2-icon-detect";
    const stage3Model = "paddleocr-v4-server";

    const stage1Variant = this.registry.selectVariant(stage1Model, profile);
    const stage2Variant = this.registry.selectVariant(stage2Model, profile);
    const stage3Variant = this.registry.selectVariant(stage3Model, profile);

    if (!stage1Variant || !stage2Variant || !stage3Variant) {
      console.error("[onnx-backend] selectVariant returned null for one or more stages");
      this.state = "evicted";
      return this.state;
    }

    const keys = await this.initStageSessions(
      stage1Model, stage1Variant,
      stage2Model, stage2Variant,
      stage3Model, stage3Variant,
    );
    if (!keys) {
      this.state = "evicted";
      return this.state;
    }
    this.stageKeys = keys;
    this.state = "warm";
    return this.state;
  }

  private async initStageSessions(
    s1Name: string, s1: ModelVariant,
    s2Name: string, s2: ModelVariant,
    s3Name: string, s3: ModelVariant,
  ): Promise<StageSessionKeys | null> {
    const profile = nativeVision!.detectCapability!();
    const results = await Promise.all([
      this.initOne(s1Name, s1, profile),
      this.initOne(s2Name, s2, profile),
      this.initOne(s3Name, s3, profile),
    ]);
    if (results.some((r) => r === null)) return null;
    return { stage1: results[0]!, stage2: results[1]!, stage3: results[2]! };
  }

  /**
   * Initialise one ORT session via visionInitSession. Returns the session_key
   * on success, null on artifact absence / session init failure. The Rust side
   * is panic-isolated (L5) so this never throws for inference failures.
   *
   * Artifact absence path: if the model file is not on disk, we still invoke
   * visionInitSession — the native side attempts to commit_from_file and returns
   * `ok: false, error: "..."`. We treat that as soft-failure for the stage.
   */
  private async initOne(
    modelName: string,
    variant: ModelVariant,
    profile: NativeCapabilityProfile,
  ): Promise<string | null> {
    const modelPath = this.registry.pathFor(modelName, variant);
    const sessionKey = `${modelName}:${variant.name}`;
    try {
      const res = await nativeVision!.visionInitSession!({
        modelPath,
        profile,
        sessionKey,
      } as NativeSessionInit);
      if (!res.ok) {
        console.error(`[onnx-backend] session init failed for ${sessionKey}: ${res.error ?? "unknown"}`);
        return null;
      }
      return res.sessionKey;
    } catch (err) {
      console.error(`[onnx-backend] visionInitSession threw for ${sessionKey}:`, err);
      return null;
    }
  }

  async getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]> {
    return this.snapshots.get(targetKey) ?? [];
  }

  onDirty(cb: (targetKey: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async recognizeRois(
    targetKey: string,
    rois: RoiInput[],
    frameWidth?: number,
    frameHeight?: number,
    frameBuffer?: Buffer,  // Phase 4b-5a-1 addition (optional, backward-compat)
  ): Promise<UiEntityCandidate[]> {
    if (!OnnxBackend.isAvailable() || !nativeVision?.visionRecognizeRois) return [];
    if (rois.length === 0) return [];

    const effectiveBuffer = frameBuffer ?? Buffer.alloc(0);

    const nativeRois = rois.map((r) => ({
      trackId: r.trackId,
      rect: { ...r.rect },
      classHint: r.classHint ?? null,
    }));

    let raw: NativeRawCandidate[];

    if (this.state !== "warm" || this.stageKeys === null) {
      // 4b-5 post-review B1 fix: warm 未達 → [] 返却
      // (4b-1 時代の legacy sessionKey="" fallback path は 4b-5c で除去)
      return [];
    }

    // Phase 4b-5 path: run 3-stage pipeline via stage-pipeline.ts
    {
      const input: StagePipelineInput = {
        targetKey,
        rois: nativeRois,
        frameWidth: frameWidth ?? this.opts.defaultFrameWidth ?? 0,
        frameHeight: frameHeight ?? this.opts.defaultFrameHeight ?? 0,
        frameBuffer: effectiveBuffer,
        nowMs: Date.now(),
      };
      try {
        raw = await runStagePipeline(
          this.stageKeys,
          input,
          (req) => nativeVision!.visionRecognizeRois!(req),
        );
      } catch (err) {
        console.error("[onnx-backend] runStagePipeline failed:", err);
        return [];
      }
    }

    const candidates = raw.map((c) => mapRawToCandidate(c, targetKey));
    this.snapshots.set(targetKey, candidates);
    for (const cb of this.listeners) {
      try { cb(targetKey); } catch { /* one bad listener must not break others */ }
    }
    return candidates;
  }

  /** Directly inject a snapshot (mirrors PocVisualBackend.updateSnapshot for migration). */
  updateSnapshot(targetKey: string, candidates: UiEntityCandidate[]): void {
    this.snapshots.set(targetKey, candidates);
    for (const cb of this.listeners) {
      try { cb(targetKey); } catch { /* swallow */ }
    }
  }

  getWarmState(): WarmState {
    return this.state;
  }

  async dispose(): Promise<void> {
    // Phase 4b-5: clear TS-side state. Rust pool entries persist until process
    // exit (vision_retire_session will be added in 4b-5c for full cleanup).
    this.stageKeys = null;
    this.snapshots.clear();
    this.listeners.clear();
    this.state = "evicted";
  }
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/**
 * Convert a Rust-side `NativeRawCandidate` into a `UiEntityCandidate` that the
 * existing pipeline (CandidateProducer / TrackStore / resolver) understands.
 *
 * The mapping intentionally uses the `visual_gpu` source so downstream
 * dedup/digest logic treats it consistently with Phase 1 (OcrVisualAdapter)
 * outputs. The detector class becomes `role` after a small normalisation.
 */
function mapRawToCandidate(raw: NativeRawCandidate, targetKey: string): UiEntityCandidate {
  const target = parseTargetKey(targetKey);
  const role = normaliseClass(raw.class);
  const actionability = actionabilityFor(role);
  return {
    source: "visual_gpu",
    target,
    sourceId: raw.trackId,
    role,
    label: raw.label || undefined,
    rect: { ...raw.rect },
    actionability,
    confidence: raw.confidence,
    observedAtMs: Date.now(),
    provisional: raw.provisional,
  };
}

function parseTargetKey(key: string): UiEntityCandidate["target"] {
  if (key.startsWith("tab:")) return { kind: "browserTab", id: key.slice(4) };
  if (key.startsWith("window:")) return { kind: "window", id: key.slice(7) };
  if (key.startsWith("title:")) return { kind: "window", id: key.slice(6) };
  return { kind: "window", id: key };
}

/** Map detector classes to the resolver's role taxonomy. */
function normaliseClass(cls: string): string {
  switch (cls) {
    case "text":     return "label";
    case "button":   return "button";
    case "checkbox": return "checkbox";
    case "radio":    return "radio";
    case "dropdown": return "combobox";
    case "slider":   return "slider";
    case "tab":      return "tab";
    case "label":    return "label";
    case "title":    return "label";
    case "icon":     return "button"; // icons are usually clickable
    case "image":    return "image";
    case "mixed":    return "unknown";
    default:         return "unknown";
  }
}

function actionabilityFor(role: string): UiEntityCandidate["actionability"] {
  switch (role) {
    case "button":
    case "checkbox":
    case "radio":
    case "tab":
      return ["click", "invoke"];
    case "combobox":
    case "slider":
      return ["click", "invoke", "type"];
    case "label":
    case "image":
    case "unknown":
      return ["read"];
    default:
      return ["click", "read"];
  }
}
