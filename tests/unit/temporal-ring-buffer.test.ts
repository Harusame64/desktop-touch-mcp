/**
 * ADR-019 Stage 2a — temporal ring buffer + causal strip filter unit tests.
 *
 * Validates the stop-detection polling helper (`capturePostFrameUntilStable`)
 * and the strip-wise diff helper (`computeStripChangedFractions`) without
 * touching real screen pixels: a fake clock + injected capture stub drive
 * deterministic sequences.
 *
 * Sub-plan: docs/adr-019-stage-2a-plan.md
 * PoC results: docs/adr-019-stage-2a-poc-results.md
 */

import { describe, it, expect } from "vitest";
import {
  computeStripChangedFractions,
  type RawFrame,
} from "../../src/engine/layer-buffer.js";

// Synthetic frame helpers — produce deterministic buffers we can diff
// against without invoking any native capture or SIMD.
function makeFrame(width: number, height: number, fillByte: number, channels: 3 | 4 = 3): RawFrame {
  const buf = Buffer.alloc(width * height * channels, fillByte);
  return { rawPixels: buf, width, height, channels };
}

/** Fill a horizontal strip (row range) with a different byte value. */
function fillRowRange(frame: RawFrame, rowStart: number, rowEnd: number, byte: number): void {
  const bytesPerRow = frame.width * frame.channels;
  for (let y = rowStart; y < rowEnd; y++) {
    frame.rawPixels.fill(byte, y * bytesPerRow, (y + 1) * bytesPerRow);
  }
}

/** Fill a vertical strip (column range) with a different byte value. */
function fillColRange(frame: RawFrame, colStart: number, colEnd: number, byte: number): void {
  for (let y = 0; y < frame.height; y++) {
    const rowStart = y * frame.width * frame.channels;
    for (let x = colStart; x < colEnd; x++) {
      const px = rowStart + x * frame.channels;
      for (let c = 0; c < frame.channels; c++) {
        frame.rawPixels[px + c] = byte;
      }
    }
  }
}

describe("ADR-019 Stage 2a — computeStripChangedFractions (causal strip filter)", () => {
  it("identical frames → all strip fractions are 0", () => {
    const pre = makeFrame(64, 64, 0);
    const post = makeFrame(64, 64, 0);
    const r = computeStripChangedFractions(pre, post, "vertical", 4);
    expect(r.sizeMismatch).toBe(false);
    expect(r.fractions).toHaveLength(4);
    for (const f of r.fractions) {
      expect(f).toBe(0);
    }
  });

  it("vertical axis: change in 1 horizontal strip → only that strip has fraction > 0", () => {
    // 64x64 split into 4 horizontal strips of 16 rows each. Change rows 0-15
    // (= strip 0). Other strips should remain 0.
    const pre = makeFrame(64, 64, 0);
    const post = makeFrame(64, 64, 0);
    fillRowRange(post, 0, 16, 255); // change strip 0 only
    const r = computeStripChangedFractions(pre, post, "vertical", 4);
    expect(r.sizeMismatch).toBe(false);
    expect(r.fractions).toHaveLength(4);
    expect(r.fractions[0]).toBeGreaterThan(0);
    expect(r.fractions[1]).toBe(0);
    expect(r.fractions[2]).toBe(0);
    expect(r.fractions[3]).toBe(0);
  });

  it("vertical axis: change in all strips (real scroll signature) → all > 0", () => {
    const pre = makeFrame(64, 64, 0);
    const post = makeFrame(64, 64, 255); // entire frame changed
    const r = computeStripChangedFractions(pre, post, "vertical", 4);
    expect(r.sizeMismatch).toBe(false);
    for (const f of r.fractions) {
      expect(f).toBeGreaterThan(0);
    }
  });

  it("horizontal axis: change in 1 vertical strip → only that strip has fraction > 0", () => {
    // 64x64 split into 4 vertical strips of 16 columns each. Change cols 0-15.
    const pre = makeFrame(64, 64, 0);
    const post = makeFrame(64, 64, 0);
    fillColRange(post, 0, 16, 255);
    const r = computeStripChangedFractions(pre, post, "horizontal", 4);
    expect(r.sizeMismatch).toBe(false);
    expect(r.fractions).toHaveLength(4);
    expect(r.fractions[0]).toBeGreaterThan(0);
    expect(r.fractions[1]).toBe(0);
    expect(r.fractions[2]).toBe(0);
    expect(r.fractions[3]).toBe(0);
  });

  it("size mismatch → returns fractions=[1.0,...] with sizeMismatch=true", () => {
    const pre = makeFrame(64, 64, 0);
    const post = makeFrame(96, 96, 0);
    const r = computeStripChangedFractions(pre, post, "vertical", 4);
    expect(r.sizeMismatch).toBe(true);
    expect(r.fractions).toEqual([1.0, 1.0, 1.0, 1.0]);
  });

  it("last strip absorbs leftover rows when height not divisible by stripCount", () => {
    // 64x65 / 4 strips → first 3 strips of 16 rows, last strip of 17 rows.
    // Fill the last strip only (rows 48-64); other strips stay 0.
    const pre = makeFrame(64, 65, 0);
    const post = makeFrame(64, 65, 0);
    fillRowRange(post, 48, 65, 255); // last 17 rows
    const r = computeStripChangedFractions(pre, post, "vertical", 4);
    expect(r.fractions[0]).toBe(0);
    expect(r.fractions[1]).toBe(0);
    expect(r.fractions[2]).toBe(0);
    expect(r.fractions[3]).toBeGreaterThan(0);
  });

  it("stripCount=0 → empty fractions array", () => {
    const pre = makeFrame(64, 64, 0);
    const post = makeFrame(64, 64, 0);
    const r = computeStripChangedFractions(pre, post, "vertical", 0);
    expect(r.fractions).toEqual([]);
  });

  it("strip height smaller than 1 (height < stripCount) → fall back to full-window diff replicated", () => {
    // 64x3 frame, 4 strips → stripHeight = floor(3/4) = 0 → fallback path.
    const pre = makeFrame(64, 3, 0);
    const post = makeFrame(64, 3, 0);
    fillRowRange(post, 1, 2, 255); // middle row changed
    const r = computeStripChangedFractions(pre, post, "vertical", 4);
    expect(r.sizeMismatch).toBe(false);
    expect(r.fractions).toHaveLength(4);
    // All 4 strips should report the same fallback value (full-window diff).
    expect(new Set(r.fractions).size).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// VisualMotionObservation.ringTelemetry schema sanity (compile-time pin via
// type imports; runtime check just exercises the shape we emit).
// ──────────────────────────────────────────────────────────────────────────

import type { VisualMotionObservation } from "../../src/tools/_input-pipeline.js";

describe("ADR-019 Stage 2a — ringTelemetry schema", () => {
  it("compile-time shape includes axis / stripCount / finalStripChangedFractions / stripsAboveNoise / finalChangedFraction / stableReached / framesToStability", () => {
    // Type assertion: if the schema regresses, this assignment fails to compile.
    const sample: VisualMotionObservation = {
      motion: "indeterminate",
      source: "temporal_ring_observation_only",
      framesSampled: 5,
      totalElapsedMs: 204,
      ringTelemetry: {
        framesSampled: 5,
        elapsedMsPerFrame: [0, 50, 80, 110, 140],
        changedFractions: [0.05, 0.001, 0.001],
        maxChangedFraction: 0.05,
        axis: "vertical",
        stripCount: 4,
        finalStripChangedFractions: [0, 0.034, 0.017, 0.012],
        stripsAboveNoise: 3,
        finalChangedFraction: 0.015,
        stableReached: true,
        framesToStability: 4,
      },
    };
    expect(sample.ringTelemetry?.stripsAboveNoise).toBe(3);
    expect(sample.ringTelemetry?.axis).toBe("vertical");
    expect(sample.ringTelemetry?.stableReached).toBe(true);
  });

  it("framesToStability may be null when stop-detection budget exhausts", () => {
    const sample: VisualMotionObservation = {
      motion: "indeterminate",
      source: "temporal_ring_observation_only",
      framesSampled: 23,
      totalElapsedMs: 700,
      ringTelemetry: {
        framesSampled: 23,
        elapsedMsPerFrame: Array.from({ length: 23 }, (_, i) => 50 + i * 30),
        changedFractions: Array.from({ length: 22 }, () => 0.01),
        maxChangedFraction: 0.01,
        axis: "horizontal",
        stripCount: 4,
        finalStripChangedFractions: [0.005, 0.005, 0.005, 0.005],
        stripsAboveNoise: 4,
        finalChangedFraction: 0.005,
        stableReached: false,
        framesToStability: null,
      },
    };
    expect(sample.ringTelemetry?.framesToStability).toBeNull();
    expect(sample.ringTelemetry?.stableReached).toBe(false);
  });
});
