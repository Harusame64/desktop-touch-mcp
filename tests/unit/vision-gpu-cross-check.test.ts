/**
 * vision-gpu-cross-check.test.ts — Phase 4b-6 cross-check unit tests.
 *
 * Coverage (§5.1 minimum 8 cases):
 *   Levenshtein: identical / disjoint / empty / both-empty / normalized
 *   crossCheckLabels: agreement / disagreement / secondary-only / no-secondary / fallback / fallback-throws
 *   CROSS_CHECK_AGREEMENT_THRESHOLD constant
 */

import { describe, it, expect, vi } from "vitest";
import {
  levenshteinDistance,
  crossCheckLabels,
  CROSS_CHECK_AGREEMENT_THRESHOLD,
} from "../../src/engine/vision-gpu/cross-check.js";
import type { NativeRawCandidate } from "../../src/engine/native-types.js";

function candidate(trackId: string, label: string, confidence = 0.7, provisional = false): NativeRawCandidate {
  return {
    trackId, rect: { x: 0, y: 0, width: 10, height: 10 },
    label, class: "text", confidence, provisional,
  };
}

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });
  it("returns 1 for totally disjoint strings of equal length", () => {
    // "abc" vs "xyz" distance 3, max length 3 → normalized 1.0
    expect(levenshteinDistance("abc", "xyz")).toBe(1);
  });
  it("returns 1 when one string is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(1);
    expect(levenshteinDistance("xyz", "")).toBe(1);
  });
  it("returns 0 when both strings are empty", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });
  it("normalizes by max length", () => {
    // "cat" vs "cut" — 1 substitution, max length 3 → 1/3
    expect(levenshteinDistance("cat", "cut")).toBeCloseTo(1 / 3, 5);
  });
});

describe("crossCheckLabels agreement path", () => {
  it("promotes confidence when distance < threshold", async () => {
    const p = [candidate("t1", "hello", 0.7, true)];
    const s = [candidate("t1", "hello", 0.8, true)];
    const out = await crossCheckLabels(p, s);
    expect(out[0]!.label).toBe("hello");
    expect(out[0]!.provisional).toBe(false);
    expect(out[0]!.confidence).toBe(0.8);
  });

  it("marks provisional when distance >= threshold", async () => {
    const p = [candidate("t1", "abc", 0.7)];
    const s = [candidate("t1", "xyz", 0.7)];  // distance 1.0
    const out = await crossCheckLabels(p, s);
    expect(out[0]!.label).toBe("abc"); // primary wins label
    expect(out[0]!.provisional).toBe(true);
  });
});

describe("crossCheckLabels fallback paths", () => {
  it("uses secondary when primary label is empty", async () => {
    const p = [candidate("t1", "", 0.3)];
    const s = [candidate("t1", "hello", 0.7)];
    const out = await crossCheckLabels(p, s);
    expect(out[0]!.label).toBe("hello");
  });

  it("keeps primary unchanged when no secondary counterpart", async () => {
    const p = [candidate("t1", "hello", 0.7)];
    const s: NativeRawCandidate[] = [];
    const out = await crossCheckLabels(p, s);
    expect(out[0]!.label).toBe("hello");
  });

  it("invokes winOcrFallback when both empty", async () => {
    const p = [candidate("t1", "", 0.2)];
    const s = [candidate("t1", "", 0.2)];
    const fallback = vi.fn().mockResolvedValue("ocr-result");
    const out = await crossCheckLabels(p, s, {
      winOcrFallback: fallback, targetKey: "w:1",
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(out[0]!.label).toBe("ocr-result");
    expect(out[0]!.provisional).toBe(true);
  });

  it("preserves primary when fallback throws", async () => {
    const p = [candidate("t1", "", 0.2)];
    const s = [candidate("t1", "", 0.2)];
    const fallback = vi.fn().mockRejectedValue(new Error("winocr crashed"));
    const out = await crossCheckLabels(p, s, { winOcrFallback: fallback });
    expect(out[0]!.label).toBe("");
  });
});

describe("crossCheckLabels additional paths", () => {
  it("handles multiple candidates with mixed agreement/disagreement", async () => {
    const p = [
      candidate("t1", "hello", 0.8),
      candidate("t2", "world", 0.9),
      candidate("t3", "", 0.3),
    ];
    const s = [
      candidate("t1", "hello", 0.7),   // agree
      candidate("t2", "WORLD", 0.8),   // disagree (case difference but normalized dist > threshold)
      candidate("t3", "fallback", 0.6), // secondary has label
    ];
    const out = await crossCheckLabels(p, s);
    // t1: agreement → provisional=false, confidence=max(0.8,0.7)=0.8
    const t1 = out.find((c) => c.trackId === "t1")!;
    expect(t1.provisional).toBe(false);
    expect(t1.confidence).toBe(0.8);
    // t3: primary empty, secondary has label
    const t3 = out.find((c) => c.trackId === "t3")!;
    expect(t3.label).toBe("fallback");
  });

  it("preserves primary unchanged when both empty and no fallback provided", async () => {
    const p = [candidate("t1", "", 0.2)];
    const s = [candidate("t1", "", 0.2)];
    const out = await crossCheckLabels(p, s);  // no winOcrFallback
    expect(out[0]!.label).toBe("");
    expect(out[0]!.confidence).toBe(0.2); // original confidence preserved
  });

  it("uses custom threshold when provided", async () => {
    const p = [candidate("t1", "ab", 0.7)];
    const s = [candidate("t1", "ac", 0.7)]; // distance = 1/2 = 0.5
    // With default threshold 0.2: 0.5 >= 0.2 → disagreement
    const defaultOut = await crossCheckLabels(p, s);
    expect(defaultOut[0]!.provisional).toBe(true);
    // With custom threshold 0.8: 0.5 < 0.8 → agreement
    const customOut = await crossCheckLabels(p, s, { threshold: 0.8 });
    expect(customOut[0]!.provisional).toBe(false);
  });

  it("caps confidence at 0.6 on disagreement", async () => {
    const p = [candidate("t1", "abc", 0.9)]; // high confidence primary
    const s = [candidate("t1", "xyz", 0.9)]; // totally different
    const out = await crossCheckLabels(p, s);
    expect(out[0]!.confidence).toBe(0.6);
    expect(out[0]!.provisional).toBe(true);
  });
});

describe("CROSS_CHECK_AGREEMENT_THRESHOLD constant", () => {
  it("matches ADR-005 D3' value 0.2", () => {
    expect(CROSS_CHECK_AGREEMENT_THRESHOLD).toBe(0.2);
  });
});
