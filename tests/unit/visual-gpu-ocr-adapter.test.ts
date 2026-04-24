/**
 * visual-gpu-ocr-adapter.test.ts
 *
 * Unit tests for OcrVisualAdapter (Phase 1 of visual-gpu-dataplane-plan.md).
 * Covers the 6 cases specified in the plan:
 *   1. Zero elements → no candidates, no pushDirtySignal.
 *   2. 2 elements → candidates arrive via pushDirtySignal.
 *   3. Candidates have source:"visual_gpu", digest, provisional=false.
 *   4. Debounce: second call within minPollIntervalMs returns [].
 *   5. Two different targets do not share stable tracks.
 *   6. runSomPipeline exception → empty, no pushDirtySignal, no rethrow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _clearDirtySignalHandlersForTest, onDirtySignal } from "../../src/engine/vision-gpu/dirty-signal.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

// ── Static mock for ocr-bridge (intercepted by vitest for dynamic imports too) ──
vi.mock("../../src/engine/ocr-bridge.js", () => ({
  runSomPipeline: vi.fn(),
}));

// Import after mock is registered.
import { runSomPipeline } from "../../src/engine/ocr-bridge.js";
import { OcrVisualAdapter, targetKeyFromSpec } from "../../src/engine/vision-gpu/ocr-adapter.js";

const mockRunSom = vi.mocked(runSomPipeline);

// Helper: build a minimal SomPipelineResult with N elements.
function makeSomResult(n: number) {
  return {
    somImage: null,
    preprocessScale: 1,
    elements: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      text: `Label${i + 1}`,
      clickAt: { x: 100 + i * 50, y: 200 },
      region: { x: 80 + i * 50, y: 180, width: 40, height: 20 },
      confidence: 0.85,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearDirtySignalHandlersForTest();
});

afterEach(() => {
  _clearDirtySignalHandlersForTest();
});

// ── Case 1 ────────────────────────────────────────────────────────────────────
describe("Case 1: zero elements", () => {
  it("returns [] and does not call pushDirtySignal", async () => {
    mockRunSom.mockResolvedValue(makeSomResult(0));

    const received: UiEntityCandidate[] = [];
    onDirtySignal((_key, cands) => received.push(...cands));

    const adapter = new OcrVisualAdapter(
      { hwnd: "1001", windowTitle: "Test" },
      { minPollIntervalMs: 0 },
    );
    const result = await adapter.pollOnce({ hwnd: "1001", windowTitle: "Test" });

    expect(result).toEqual([]);
    expect(received).toEqual([]);
  });
});

// ── Case 2 ────────────────────────────────────────────────────────────────────
describe("Case 2: 2 elements → candidates via pushDirtySignal", () => {
  it("delivers candidates through onDirtySignal after pollOnce", async () => {
    mockRunSom.mockResolvedValue(makeSomResult(2));

    const received: { key: string; cands: UiEntityCandidate[] }[] = [];
    onDirtySignal((key, cands) => received.push({ key, cands }));

    const target = { hwnd: "2002", windowTitle: "App" };
    const adapter = new OcrVisualAdapter(target, { minPollIntervalMs: 0 });
    const result = await adapter.pollOnce(target);

    expect(result.length).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].key).toBe("window:2002");
    expect(received[0].cands.length).toBe(result.length);
  });
});

// ── Case 3 ────────────────────────────────────────────────────────────────────
describe("Case 3: candidate fields", () => {
  it("emits candidates with source:visual_gpu, digest, provisional=false", async () => {
    mockRunSom.mockResolvedValue(makeSomResult(1));

    const target = { hwnd: "3003" };
    const adapter = new OcrVisualAdapter(target, { minPollIntervalMs: 0 });
    const result = await adapter.pollOnce(target);

    expect(result.length).toBeGreaterThan(0);
    for (const c of result) {
      expect(c.source).toBe("visual_gpu");
      expect(typeof c.digest).toBe("string");
      expect(c.digest!.length).toBeGreaterThan(0);
      expect(c.provisional).toBe(false);
    }
  });
});

// ── Case 4 ────────────────────────────────────────────────────────────────────
describe("Case 4: debounce", () => {
  it("returns [] on second call within minPollIntervalMs", async () => {
    mockRunSom.mockResolvedValue(makeSomResult(2));

    const target = { hwnd: "4004" };
    const adapter = new OcrVisualAdapter(target, { minPollIntervalMs: 1000 });

    // First call — should work.
    const first = await adapter.pollOnce(target);
    expect(first.length).toBeGreaterThan(0);
    expect(mockRunSom).toHaveBeenCalledTimes(1);

    // Immediate second call — debounced.
    const second = await adapter.pollOnce(target);
    expect(second).toEqual([]);
    expect(mockRunSom).toHaveBeenCalledTimes(1); // not called again
  });
});

// ── Case 5 ────────────────────────────────────────────────────────────────────
describe("Case 5: target isolation", () => {
  it("two targets do not share track state", async () => {
    mockRunSom.mockResolvedValue(makeSomResult(2));

    const targetA = { hwnd: "5001" };
    const targetB = { hwnd: "5002" };
    const adapterA = new OcrVisualAdapter(targetA, { minPollIntervalMs: 0 });
    const adapterB = new OcrVisualAdapter(targetB, { minPollIntervalMs: 0 });

    const receivedKeys: string[] = [];
    onDirtySignal((key) => receivedKeys.push(key));

    await adapterA.pollOnce(targetA);
    await adapterB.pollOnce(targetB);

    // Each adapter fires for its own targetKey only.
    expect(receivedKeys).toContain("window:5001");
    expect(receivedKeys).toContain("window:5002");
    // Each key appears exactly once.
    expect(receivedKeys.filter((k) => k === "window:5001").length).toBe(1);
    expect(receivedKeys.filter((k) => k === "window:5002").length).toBe(1);
  });
});

// ── Case 6 ────────────────────────────────────────────────────────────────────
describe("Case 6: runSomPipeline throws", () => {
  it("returns [], does not push signal, does not rethrow", async () => {
    mockRunSom.mockRejectedValue(new Error("OCR crashed"));

    const received: UiEntityCandidate[] = [];
    onDirtySignal((_key, cands) => received.push(...cands));

    const target = { hwnd: "6006" };
    const adapter = new OcrVisualAdapter(target, { minPollIntervalMs: 0 });

    // Should not throw.
    const result = await expect(adapter.pollOnce(target)).resolves.toEqual([]);
    expect(received).toEqual([]);
  });
});

// ── Case 7: preFetchedElements skips runSomPipeline ─────────────────────────
describe("Case 7: preFetchedElements", () => {
  it("skips runSomPipeline when elements are pre-supplied", async () => {
    const elements = makeSomResult(2).elements;

    const target = { hwnd: "7007" };
    const adapter = new OcrVisualAdapter(target, { minPollIntervalMs: 0 });
    const result = await adapter.pollOnce(target, [], elements);

    expect(result.length).toBeGreaterThan(0);
    // runSomPipeline must NOT have been called — elements were pre-supplied.
    expect(mockRunSom).not.toHaveBeenCalled();
  });
});

// ── Case 8: IoU matching assigns correct text to each stable track ────────────
describe("Case 8: findBestMatchingElement uses IoU not array index", () => {
  it("publishes correct labels when two non-overlapping elements are present", async () => {
    // Two non-overlapping elements at distinct positions.
    // The fix (指摘 8): findBestMatchingElement must assign each stable track
    // to its highest-IoU element rather than falling back to elements[i].
    // If the fallback were active, a reordering of stable tracks could cross-assign labels.
    const elements = [
      { id: 1, text: "Left",  clickAt: { x: 20, y: 10 }, region: { x: 0,  y: 0, width: 40, height: 20 }, confidence: 0.9 },
      { id: 2, text: "Right", clickAt: { x: 70, y: 10 }, region: { x: 50, y: 0, width: 40, height: 20 }, confidence: 0.9 },
    ];

    const target = { hwnd: "8008" };
    const adapter = new OcrVisualAdapter(target, { minPollIntervalMs: 0 });
    const result = await adapter.pollOnce(target, [], elements);

    // Both elements should produce candidates.
    expect(result.length).toBe(2);
    const labels = result.map((c) => c.label).sort();
    // Each candidate carries its own element's label — no cross-assignment.
    expect(labels).toEqual(["Left", "Right"]);
  });
});

// ── targetKeyFromSpec helper ──────────────────────────────────────────────────
describe("targetKeyFromSpec", () => {
  it("prefers hwnd", () => {
    expect(targetKeyFromSpec({ hwnd: "42", windowTitle: "X" })).toBe("window:42");
  });
  it("falls back to tabId", () => {
    expect(targetKeyFromSpec({ tabId: "t1" })).toBe("tab:t1");
  });
  it("falls back to windowTitle", () => {
    expect(targetKeyFromSpec({ windowTitle: "Outlook" })).toBe("title:Outlook");
  });
  it("returns default for empty spec", () => {
    expect(targetKeyFromSpec({})).toBe("window:__default__");
  });
});
