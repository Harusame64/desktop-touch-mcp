/**
 * stage-pipeline.test.ts — Phase 4b-5 orchestration tests.
 *
 * Verifies the 3-stage serial pipeline (runStagePipeline) with a fully mocked
 * visionRecognize function. No real native binding needed.
 *
 * Coverage (§6.1 minimum 6 cases):
 *   1. Stage1→Stage2 only (no text-class → stage3 skipped)
 *   2. All 3 stages invoked when stage2 yields text-class candidates
 *   3. Early exit when stage1 returns empty
 *   4. Stage2 output returned as-is when stage3 returns empty
 *   5. Subset trackId merge (stage3 labels merged by trackId)
 *   6. Rejection propagation from any stage
 */

import { describe, it, expect } from "vitest";
import {
  runStagePipeline,
  type StageSessionKeys,
  type StagePipelineInput,
  type VisionRecognizeFn,
} from "../../src/engine/vision-gpu/stage-pipeline.js";
import type { NativeRawCandidate } from "../../src/engine/native-types.js";

const BASE_INPUT: StagePipelineInput = {
  targetKey: "window:1",
  rois: [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 50 }, classHint: null }],
  frameWidth: 1920,
  frameHeight: 1080,
  frameBuffer: Buffer.alloc(0),
  nowMs: 0,
};

const KEYS: StageSessionKeys = { stage1: "s1", stage2: "s2", stage3: "s3" };

// Helper to build a NativeRawCandidate with defaults
function makeCandidate(
  trackId: string,
  cls: string,
  label = "",
  rect = { x: 0, y: 0, width: 100, height: 50 },
): NativeRawCandidate {
  return { trackId, rect, label, class: cls, confidence: 0.5, provisional: true };
}

describe("runStagePipeline (Phase 4b-5)", () => {
  it("invokes stage1 then stage2, skipping stage3 when no text-class candidates", async () => {
    const calls: Array<{ sessionKey: string }> = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push({ sessionKey: req.sessionKey });
      return req.rois.map((r) => makeCandidate(r.trackId, r.classHint ?? "other"));
    };
    const out = await runStagePipeline(KEYS, BASE_INPUT, recognize);
    expect(calls.map((c) => c.sessionKey)).toEqual(["s1", "s2"]); // no s3
    expect(out).toHaveLength(1);
    expect(out[0]!.class).toBe("other");
  });

  it("invokes all 3 stages when stage2 yields text-class candidates", async () => {
    let nth = 0;
    const calls: string[] = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push(req.sessionKey);
      nth++;
      return req.rois.map((r, idx) => ({
        trackId: r.trackId,
        rect: r.rect,
        label: nth === 3 ? `ocr-${idx}` : "",
        class: nth === 2 ? "text" : r.classHint ?? "other",
        confidence: 0.5,
        provisional: true,
      }));
    };
    const out = await runStagePipeline(KEYS, BASE_INPUT, recognize);
    expect(calls).toEqual(["s1", "s2", "s3"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("ocr-0"); // stage3 label merged into stage2
    expect(out[0]!.class).toBe("text");   // stage2 class retained
  });

  it("returns [] when stage1 returns empty (early exit)", async () => {
    const calls: string[] = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push(req.sessionKey);
      return [];
    };
    const out = await runStagePipeline(KEYS, BASE_INPUT, recognize);
    expect(calls).toEqual(["s1"]); // no stage2, no stage3
    expect(out).toEqual([]);
  });

  it("returns stage2 output when stage2 has candidates but stage3 returns empty", async () => {
    let nth = 0;
    const recognize: VisionRecognizeFn = async (req) => {
      nth++;
      if (nth === 3) return []; // stage3 returns empty
      return req.rois.map((r) => makeCandidate(r.trackId, "text"));
    };
    const out = await runStagePipeline(KEYS, BASE_INPUT, recognize);
    expect(out).toHaveLength(1);
    expect(out[0]!.class).toBe("text");
    expect(out[0]!.label).toBe(""); // stage3 produced no label
  });

  it("merges stage3 labels by trackId (subset match)", async () => {
    const input: StagePipelineInput = {
      ...BASE_INPUT,
      rois: [
        { trackId: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, classHint: null },
        { trackId: "b", rect: { x: 0, y: 0, width: 10, height: 10 }, classHint: null },
      ],
    };
    let nth = 0;
    const recognize: VisionRecognizeFn = async (req) => {
      nth++;
      if (nth === 1) {
        return req.rois.map((r) => makeCandidate(r.trackId, "region", "", r.rect));
      }
      if (nth === 2) {
        return [
          { trackId: "a", rect: req.rois[0]!.rect, label: "", class: "text", confidence: 0.5, provisional: true },
          { trackId: "b", rect: req.rois[1]!.rect, label: "", class: "button", confidence: 0.5, provisional: true },
        ];
      }
      // stage3: only "a" is text, returns OCR label
      return [{ trackId: "a", rect: req.rois[0]!.rect, label: "Submit", class: "text", confidence: 0.8, provisional: false }];
    };
    const out = await runStagePipeline(KEYS, input, recognize);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.trackId === "a")?.label).toBe("Submit");
    expect(out.find((c) => c.trackId === "b")?.label).toBe(""); // untouched
  });

  it("propagates rejection from any stage (caller handles)", async () => {
    const recognize: VisionRecognizeFn = async () => {
      throw new Error("simulated ort panic");
    };
    await expect(runStagePipeline(KEYS, BASE_INPUT, recognize)).rejects.toThrow(/simulated/);
  });
});

// Phase 4b-6: cross-check stage3b tests
describe("runStagePipeline (Phase 4b-6 cross-check)", () => {
  it("invokes stage3b in addition to stage3 when stage3b key is set (cross-check)", async () => {
    const calls: string[] = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push(req.sessionKey);
      return req.rois.map((r) => ({
        trackId: r.trackId, rect: r.rect, label: "ocr", class: "text",
        confidence: 0.5, provisional: true,
      }));
    };
    const keys: StageSessionKeys = {
      stage1: "s1", stage2: "s2", stage3: "s3", stage3b: "s3b",
    };
    await runStagePipeline(keys, BASE_INPUT, recognize);
    expect(calls).toContain("s3");
    expect(calls).toContain("s3b");
  });

  it("skips stage3b when keys.stage3b is undefined (default no-cross-check)", async () => {
    const calls: string[] = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push(req.sessionKey);
      return req.rois.map((r) => ({
        trackId: r.trackId, rect: r.rect, label: "ocr", class: "text",
        confidence: 0.5, provisional: true,
      }));
    };
    const keys: StageSessionKeys = { stage1: "s1", stage2: "s2", stage3: "s3" };
    await runStagePipeline(keys, BASE_INPUT, recognize);
    expect(calls).not.toContain("s3b");
  });
});
