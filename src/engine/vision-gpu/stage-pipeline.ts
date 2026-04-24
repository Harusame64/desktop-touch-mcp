/**
 * stage-pipeline.ts — Stage 1→2→3 serial orchestrator (Phase 4b-5).
 *
 * Runs three `visionRecognizeRois` calls in sequence, feeding rects from each
 * stage's output into the next. The resulting candidates merge stage 2's
 * rect/class with stage 3's label.
 *
 * Phase 4b-5 scope: orchestration only. Each stage's inference is currently
 * stubbed on the Rust side (returns input ROIs echoed back). Sub-batches
 * 4b-5a (Florence-2) / 4b-5b (OmniParser-v2) / 4b-5c (PaddleOCR-v4) drop in
 * the real preprocess/postprocess per stage without touching this module.
 */

import type { NativeRecognizeRequest, NativeRawCandidate } from "../native-types.js";

export interface StageSessionKeys {
  /** Session key for the Stage 1 model (region proposer, e.g. florence-2-base). */
  stage1: string;
  /** Session key for the Stage 2 model (UI detector, e.g. omniparser-v2-icon-detect). */
  stage2: string;
  /** Session key for the Stage 3 model (OCR recognizer, e.g. paddleocr-v4-server). */
  stage3: string;
}

export interface StagePipelineInput {
  targetKey: string;
  rois: NativeRecognizeRequest["rois"];
  frameWidth: number;
  frameHeight: number;
  /** Captured frame RGBA bytes forwarded to Rust per-stage (empty Buffer → legacy dummy path). */
  frameBuffer: Buffer;
  nowMs: number;
}

export type VisionRecognizeFn = (req: NativeRecognizeRequest) => Promise<NativeRawCandidate[]>;

/**
 * Run the 3-stage pipeline. Returns Stage 2 candidates with Stage 3 labels
 * merged in by trackId. Throws only when visionRecognizeRois itself rejects
 * (caller wraps in try/catch — see onnx-backend.ts recognizeRois).
 */
export async function runStagePipeline(
  keys: StageSessionKeys,
  input: StagePipelineInput,
  visionRecognize: VisionRecognizeFn,
): Promise<NativeRawCandidate[]> {
  // Stage 1: region proposals
  const stage1 = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage1,
    rois: input.rois,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    frameBuffer: input.frameBuffer,
    nowMs: input.nowMs,
  });
  if (stage1.length === 0) return [];

  // Stage 2: fine UI element detection inside each region
  const stage2 = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage2,
    rois: stage1.map((c) => ({
      trackId: c.trackId,
      rect: c.rect,
      classHint: c.class || null,
    })),
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    frameBuffer: input.frameBuffer,
    nowMs: input.nowMs,
  });
  if (stage2.length === 0) return [];

  // Stage 3: OCR over text-class candidates only (class-aware dispatch)
  const textCandidates = stage2.filter((c) => isTextClass(c.class));
  if (textCandidates.length === 0) {
    // No text to OCR — return stage 2 as final output unchanged.
    return stage2;
  }
  const stage3 = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage3,
    rois: textCandidates.map((c) => ({
      trackId: c.trackId,
      rect: c.rect,
      classHint: c.class || null,
    })),
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    frameBuffer: input.frameBuffer,
    nowMs: input.nowMs,
  });

  // Merge stage 3 labels into stage 2 candidates keyed by trackId.
  const labelByTrackId = new Map<string, string>();
  for (const c of stage3) {
    if (c.label) labelByTrackId.set(c.trackId, c.label);
  }
  return stage2.map((c) => {
    const ocrLabel = labelByTrackId.get(c.trackId);
    return ocrLabel ? { ...c, label: ocrLabel } : c;
  });
}

function isTextClass(cls: string): boolean {
  // Matches ADR D3' class-aware dispatch — text / label / icon classes get OCR
  // (icon for short description read by VLM). Phase 4b-5a/b/c may refine.
  return cls === "text" || cls === "label" || cls === "title" || cls === "icon" || cls === "mixed";
}
