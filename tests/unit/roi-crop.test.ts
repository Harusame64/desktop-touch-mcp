/**
 * ADR-024 Seed-2 S4 — `cropRgbaToRoi` unit tests.
 *
 * Pins the RGBA row-copy crop + buffer-bounds clamp + clamped-offset return
 * that lets `runSomPipeline` OCR only the ROI while keeping screen-absolute
 * coordinates correct (the caller shifts `origin` by the returned `x`/`y`).
 */

import { describe, it, expect } from "vitest";

import { cropRgbaToRoi } from "../../src/engine/roi-crop.js";

/**
 * Build a `w * h` RGBA buffer where each pixel's R channel encodes its index
 * (`y * w + x`), G = x, B = y, A = 255. Lets a crop assert exact provenance.
 */
function makeBuffer(w: number, h: number): Buffer {
  const buf = Buffer.allocUnsafe(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = (y * w + x) & 0xff;
      buf[i + 1] = x & 0xff;
      buf[i + 2] = y & 0xff;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/** Read the (G,B) = (x,y) provenance of pixel `idx` in a cropped buffer. */
function pixelXY(data: Buffer, idx: number): { x: number; y: number } {
  return { x: data[idx * 4 + 1], y: data[idx * 4 + 2] };
}

describe("cropRgbaToRoi (S4 ROI buffer crop)", () => {
  it("crops a fully-inside ROI with correct dimensions, offset, and pixels", () => {
    const src = makeBuffer(10, 8); // 10x8
    const out = cropRgbaToRoi(src, 10, 8, { x: 3, y: 2, width: 4, height: 3 });
    expect(out).not.toBeNull();
    expect(out!.width).toBe(4);
    expect(out!.height).toBe(3);
    expect(out!.x).toBe(3);
    expect(out!.y).toBe(2);
    expect(out!.data.length).toBe(4 * 3 * 4);
    // top-left pixel of the crop is source (x=3, y=2)
    expect(pixelXY(out!.data, 0)).toEqual({ x: 3, y: 2 });
    // last pixel of the first crop row is source (x=6, y=2)
    expect(pixelXY(out!.data, 3)).toEqual({ x: 6, y: 2 });
    // first pixel of the second crop row is source (x=3, y=3)
    expect(pixelXY(out!.data, 4)).toEqual({ x: 3, y: 3 });
    // bottom-right pixel is source (x=6, y=4)
    expect(pixelXY(out!.data, 11)).toEqual({ x: 6, y: 4 });
  });

  it("clamps an ROI that overruns the bottom-right edge and reports clamped size", () => {
    const src = makeBuffer(10, 8);
    // ROI starts at (8,6) and asks for 5x5 → clamps to 2x2 (buffer is 10x8).
    const out = cropRgbaToRoi(src, 10, 8, { x: 8, y: 6, width: 5, height: 5 });
    expect(out).not.toBeNull();
    expect(out!.width).toBe(2);
    expect(out!.height).toBe(2);
    expect(out!.x).toBe(8);
    expect(out!.y).toBe(6);
    expect(pixelXY(out!.data, 0)).toEqual({ x: 8, y: 6 });
  });

  it("clamps a negative-origin ROI to (0,0) and shrinks the size accordingly", () => {
    const src = makeBuffer(10, 8);
    // ROI from (-2,-3) size 5x6 → clamps top-left to (0,0), size to 3x3.
    const out = cropRgbaToRoi(src, 10, 8, { x: -2, y: -3, width: 5, height: 6 });
    expect(out).not.toBeNull();
    expect(out!.x).toBe(0);
    expect(out!.y).toBe(0);
    expect(out!.width).toBe(3);
    expect(out!.height).toBe(3);
    expect(pixelXY(out!.data, 0)).toEqual({ x: 0, y: 0 });
  });

  it("returns null when the ROI does not overlap the buffer", () => {
    const src = makeBuffer(10, 8);
    expect(cropRgbaToRoi(src, 10, 8, { x: 100, y: 100, width: 4, height: 4 })).toBeNull();
  });

  it("returns null for a zero-area ROI", () => {
    const src = makeBuffer(10, 8);
    expect(cropRgbaToRoi(src, 10, 8, { x: 2, y: 2, width: 0, height: 4 })).toBeNull();
  });

  it("floors the top-left and ceils the bottom-right for sub-pixel ROIs", () => {
    const src = makeBuffer(10, 8);
    // x:[2.4, 5.1) → floor 2 .. ceil 6 = width 4; y:[1.9, 3.2) → floor 1 .. ceil 4 = height 3.
    const out = cropRgbaToRoi(src, 10, 8, { x: 2.4, y: 1.9, width: 2.7, height: 1.3 });
    expect(out!.x).toBe(2);
    expect(out!.y).toBe(1);
    expect(out!.width).toBe(4);
    expect(out!.height).toBe(3);
  });

  it("crops the full buffer when the ROI matches its bounds (identity offset)", () => {
    const src = makeBuffer(4, 3);
    const out = cropRgbaToRoi(src, 4, 3, { x: 0, y: 0, width: 4, height: 3 });
    expect(out!.width).toBe(4);
    expect(out!.height).toBe(3);
    expect(out!.x).toBe(0);
    expect(out!.y).toBe(0);
    expect(out!.data.equals(src)).toBe(true);
  });

  it("does not alias the source buffer (crop is a fresh copy)", () => {
    const src = makeBuffer(4, 3);
    const out = cropRgbaToRoi(src, 4, 3, { x: 1, y: 1, width: 2, height: 2 });
    out!.data[0] = 7;
    // Mutating the crop must not touch the source pixel it came from (x=1,y=1).
    const srcIdx = (1 * 4 + 1) * 4;
    expect(src[srcIdx]).toBe((1 * 4 + 1) & 0xff);
  });
});
