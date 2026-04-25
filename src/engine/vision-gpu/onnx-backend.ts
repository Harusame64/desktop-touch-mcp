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
 *
 * Phase 4b-6: DESKTOP_TOUCH_VISUAL_CROSS_CHECK=1 enables 2-way OCR voting
 * (PaddleOCR-v4-server + PaddleOCR-v4-mobile). win-ocr.exe (Tier ∞) is wired
 * as final fallback when both engines produce empty labels.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import sharp from "sharp";

import { nativeVision, type NativeRawCandidate } from "../native-engine.js";
import type { VisualBackend } from "./backend.js";
import { ModelRegistry, type ModelVariant } from "./model-registry.js";
import { runStagePipeline, type StageSessionKeys, type StagePipelineInput } from "./stage-pipeline.js";
import type { WinOcrFallbackFn } from "./cross-check.js";
import type { RoiInput, UiEntityCandidate, WarmState, WarmTarget } from "./types.js";
import type { NativeCapabilityProfile, NativeSessionInit } from "../native-types.js";

// Resolve bin/win-ocr.exe relative to this file (dist/engine/vision-gpu/ → ../../../bin/)
const WIN_OCR_EXE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
  "win-ocr.exe",
);

/**
 * Tier ∞ fallback (Phase 4b-6 post-review B1 fix): crop the frame buffer to
 * the candidate's rect, encode as PNG, and feed to win-ocr.exe via stdin.
 * Uses the existing convention from `src/engine/ocr-bridge.ts::runOcrExe`
 * (PNG bytes on stdin → JSON on stdout, language "ja").
 *
 * Returns the concatenated word texts, or empty string on any failure
 * (ENOENT / timeout / parse error / out-of-bounds rect — all treated as
 * silent fallback per L5 robustness).
 */
const winOcrTierInfinity: WinOcrFallbackFn = async (
  _targetKey,
  rect,
  frameBuffer,
  frameWidth,
  frameHeight,
) => {
  if (frameBuffer.length === 0 || frameWidth === 0 || frameHeight === 0) return "";
  try {
    // Clip rect to frame bounds (defensive — rect may be out-of-bounds after upstream scaling)
    const x = Math.max(0, Math.min(rect.x, frameWidth - 1));
    const y = Math.max(0, Math.min(rect.y, frameHeight - 1));
    const w = Math.max(1, Math.min(rect.width, frameWidth - x));
    const h = Math.max(1, Math.min(rect.height, frameHeight - y));

    // Crop raw RGBA → PNG using sharp (already a dependency from ocr-bridge).
    const pngBytes = await sharp(frameBuffer, {
      raw: { width: frameWidth, height: frameHeight, channels: 4 },
    })
      .extract({ left: x, top: y, width: w, height: h })
      .png()
      .toBuffer();

    // Spawn win-ocr.exe and feed PNG bytes (mirrors ocr-bridge.ts::runOcrExe pattern).
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(WIN_OCR_EXE_PATH, ["ja"], { windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("win-ocr.exe timed out (2000ms)"));
      }, 2000);
      let buf = "";
      child.stdout.on("data", (d: Buffer) => { buf += d.toString("utf8"); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !buf) reject(new Error(`win-ocr.exe exited ${String(code)}`));
        else resolve(buf.trim());
      });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.stdin.on("error", () => { /* swallow EPIPE */ });
      const ok = child.stdin.write(pngBytes);
      if (ok) child.stdin.end();
      else child.stdin.once("drain", () => { child.stdin.end(); });
    });

    if (!stdout) return "";
    const parsed = JSON.parse(stdout) as { words?: Array<{ text: string }> };
    const words = parsed.words ?? [];
    return words.map((w) => w.text).join(" ").trim();
  } catch (err) {
    // Silent fallback per L5: ENOENT (exe missing on non-Windows), timeout,
    // sharp crop error (out-of-bounds), JSON parse failure all treated as empty.
    console.warn("[onnx-backend] winOcrTierInfinity failed:", err);
    return "";
  }
};

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
    const stage3bModel = "paddleocr-v4-mobile";

    // Phase 4b-6: cross-check env var evaluated at ensureWarm time (not instantiate time)
    const crossCheckEnabled = process.env.DESKTOP_TOUCH_VISUAL_CROSS_CHECK === "1";

    const stage1Variant = this.registry.selectVariant(stage1Model, profile);
    const stage2Variant = this.registry.selectVariant(stage2Model, profile);
    const stage3Variant = this.registry.selectVariant(stage3Model, profile);
    const stage3bVariant = crossCheckEnabled
      ? this.registry.selectVariant(stage3bModel, profile)
      : null;

    if (!stage1Variant || !stage2Variant || !stage3Variant) {
      console.error("[onnx-backend] selectVariant returned null for one or more stages");
      this.state = "evicted";
      return this.state;
    }

    // stage3b is optional: if cross-check is enabled but mobile variant is missing,
    // log a warning and continue without stage3b (primary-only mode).
    if (crossCheckEnabled && !stage3bVariant) {
      console.warn("[onnx-backend] cross-check enabled but paddleocr-v4-mobile variant not found — running primary-only");
    }

    const keys = await this.initStageSessions(
      stage1Model, stage1Variant,
      stage2Model, stage2Variant,
      stage3Model, stage3Variant,
      stage3bVariant ? { name: stage3bModel, variant: stage3bVariant } : null,
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
    s3b: { name: string; variant: ModelVariant } | null = null,
  ): Promise<StageSessionKeys | null> {
    const profile = nativeVision!.detectCapability!();
    const results = await Promise.all([
      this.initOne(s1Name, s1, profile),
      this.initOne(s2Name, s2, profile),
      this.initOne(s3Name, s3, profile),
      s3b ? this.initOne(s3b.name, s3b.variant, profile) : Promise.resolve(null as string | null),
    ]);
    // Required stages: stage1, stage2, stage3 (indices 0-2)
    if (results[0] === null || results[1] === null || results[2] === null) return null;
    const keys: StageSessionKeys = {
      stage1: results[0],
      stage2: results[1],
      stage3: results[2],
    };
    // stage3b is optional: null means cross-check disabled or variant missing
    if (results[3] !== null) {
      keys.stage3b = results[3];
    }
    return keys;
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
        // Phase 4b-6: Tier ∞ win-ocr fallback (only active when stage3b cross-check runs)
        winOcrFallback: winOcrTierInfinity,
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
