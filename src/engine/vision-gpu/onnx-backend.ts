/**
 * onnx-backend.ts — Phase 4a (ADR-005 D1') VisualBackend implementation.
 *
 * Thin TypeScript wrapper around the Rust-internal vision_backend module
 * exposed via napi-rs. Inference runs on a libuv worker thread (compute) and
 * resolves on V8 main (resolve), exactly mirroring the existing
 * `UiaGetElementsTask` pattern in `src/lib.rs`.
 *
 * Phase 4a behaviour:
 *   - `ensureWarm` resolves to "warm" without loading any model (no real
 *     ORT session yet — that comes in Phase 4b).
 *   - `recognizeRois` calls into `nativeVision.visionRecognizeRois` and maps
 *     `NativeRawCandidate[]` → `UiEntityCandidate[]`.
 *   - `getStableCandidates` returns a per-target snapshot built from the most
 *     recent recognise call (kept here in TS so the Rust side stays stateless
 *     for Phase 4a; Phase 4b will move snapshots into the session pool).
 *   - `onDirty` listeners fire when `recognizeRois` produces a new snapshot,
 *     mirroring `PocVisualBackend.updateSnapshot` semantics.
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

import { nativeVision, type NativeRawCandidate, type NativeRecognizeRequest } from "../native-engine.js";
import type { VisualBackend } from "./backend.js";
import type { RoiInput, UiEntityCandidate, WarmState, WarmTarget } from "./types.js";

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

  constructor(opts: OnnxBackendOptions = {}) {
    this.opts = opts;
  }

  /** True when the native vision addon is built and loaded. */
  static isAvailable(): boolean {
    return nativeVision !== null && typeof nativeVision.visionRecognizeRois === "function";
  }

  async ensureWarm(_target: WarmTarget): Promise<WarmState> {
    // Phase 4b-1: defer real session init until a model is requested.
    // Mark warm because the binding is loaded; Phase 4b-4 changes this to
    // actually load the detector model via `visionInitSession` and gate on success.
    // `visionInitSession` is now available on `nativeVision` (Phase 4b-1 wired it),
    // but calling it here requires a model path — that comes in Phase 4b-4.
    if (!OnnxBackend.isAvailable()) {
      this.state = "evicted";
      return this.state;
    }
    this.state = "warm";
    return this.state;
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
  ): Promise<UiEntityCandidate[]> {
    if (!OnnxBackend.isAvailable() || !nativeVision?.visionRecognizeRois) {
      return [];
    }
    if (rois.length === 0) return [];

    const req: NativeRecognizeRequest = {
      targetKey,
      rois: rois.map((r) => ({
        trackId: r.trackId,
        rect: { ...r.rect },
        classHint: r.classHint ?? null,
      })),
      frameWidth: frameWidth ?? this.opts.defaultFrameWidth ?? 0,
      frameHeight: frameHeight ?? this.opts.defaultFrameHeight ?? 0,
      nowMs: Date.now(),
    };

    let raw: NativeRawCandidate[];
    try {
      raw = await nativeVision.visionRecognizeRois(req);
    } catch (err) {
      // Rust catch_unwind already converted panics to Err here. Log and bail —
      // never throw out: the visual lane stays operational via fallback paths.
      console.error("[onnx-backend] visionRecognizeRois failed:", err);
      return [];
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
