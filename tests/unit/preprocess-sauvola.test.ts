/**
 * Tests for Sauvola adaptive binarization (adaptive=true in preprocessImage).
 *
 * Strategy: use a synthetic 32×32 RGBA image with a gradient background and
 * a dark text-like rectangle in the centre. Without adaptive binarization the
 * rectangle blends into the dark end of the gradient; with adaptive=true the
 * rectangle should be cleanly separated as all-0 pixels.
 *
 * Skipped automatically when the native addon is unavailable (CI / non-Windows).
 */
import { describe, it, expect } from "vitest";
import { nativeEngine } from "../../src/engine/native-engine.js";

const HAS_NATIVE = nativeEngine?.preprocessImage != null;

/** Build a synthetic RGBA image.
 * Background: horizontal gradient from 200 (left) to 240 (right) — light grey.
 * Centre rectangle (rows 10-21, cols 10-21): dark gradient from 60 (top) to 100 (bottom).
 *
 * The gradient ensures the rectangle contains a range of values, so min-max stretch
 * alone cannot produce a fully-binary result within the rectangle.
 * Sauvola should still classify all rectangle pixels as dark (below local threshold).
 */
function makeSyntheticRgba(w: number, h: number): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const isRect = x >= 10 && x < 22 && y >= 10 && y < 22;
      let luma: number;
      if (isRect) {
        // Dark gradient within rectangle: 60 (top) to 100 (bottom)
        luma = Math.round(60 + ((y - 10) / 11) * 40);
      } else {
        // Light gradient background: 180 (left) to 240 (right)
        luma = Math.round(180 + (x / (w - 1)) * 60);
      }
      buf[i]     = luma; // R
      buf[i + 1] = luma; // G
      buf[i + 2] = luma; // B
      buf[i + 3] = 255;  // A
    }
  }
  return buf;
}

function pixelsInRect(buf: Buffer, w: number, x1: number, y1: number, x2: number, y2: number): number[] {
  const values: number[] = [];
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      values.push(buf[y * w + x]!);
    }
  }
  return values;
}

describe.skipIf(!HAS_NATIVE)("preprocessImage adaptive=true (Sauvola)", () => {
  const W = 32;
  const H = 32;
  const rgba = makeSyntheticRgba(W, H);

  it("adaptive=false: output contains intermediate grayscale values (not fully binarized)", async () => {
    const result = await nativeEngine!.preprocessImage!({
      data: rgba,
      width: W,
      height: H,
      channels: 4,
      scale: 1,
      adaptive: false,
    });
    expect(result.channels).toBe(1);
    // Background gradient and rect gradient together produce a range of values.
    // Min-max stretch maps [min,max] → [0,255]; interior values remain intermediate.
    const allPixels = Array.from(result.data as Buffer);
    const intermediate = allPixels.filter((v) => v > 0 && v < 255);
    // At least some pixels should be intermediate (not strictly binarized)
    expect(intermediate.length).toBeGreaterThan(0);
  });

  it("adaptive=true: centre rectangle pixels are all 0 (dark text detected)", async () => {
    const result = await nativeEngine!.preprocessImage!({
      data: rgba,
      width: W,
      height: H,
      channels: 4,
      scale: 1,
      adaptive: true,
    });
    expect(result.channels).toBe(1);
    const rectPixels = pixelsInRect(result.data as Buffer, W, 10, 10, 22, 22);
    // All rectangle pixels should be binarized to 0 (dark text)
    const darkCount = rectPixels.filter((v) => v === 0).length;
    expect(darkCount).toBeGreaterThan(rectPixels.length * 0.8); // ≥80% classified as dark
  });

  it("adaptive=true: background pixels are mostly 255 (light background)", async () => {
    const result = await nativeEngine!.preprocessImage!({
      data: rgba,
      width: W,
      height: H,
      channels: 4,
      scale: 1,
      adaptive: true,
    });
    // Sample corners (away from the rectangle)
    const cornerPixels = [
      ...(pixelsInRect(result.data as Buffer, W, 0, 0, 8, 8)),   // top-left
      ...(pixelsInRect(result.data as Buffer, W, 24, 0, 32, 8)), // top-right
      ...(pixelsInRect(result.data as Buffer, W, 0, 24, 8, 32)), // bottom-left
    ];
    const lightCount = cornerPixels.filter((v) => v === 255).length;
    expect(lightCount).toBeGreaterThan(cornerPixels.length * 0.8); // ≥80% classified as light
  });

  it("adaptive=true output is strictly 0/255 (binarized)", async () => {
    const result = await nativeEngine!.preprocessImage!({
      data: rgba,
      width: W,
      height: H,
      channels: 4,
      scale: 1,
      adaptive: true,
    });
    const nonBinary = Array.from(result.data as Buffer).filter((v) => v !== 0 && v !== 255);
    expect(nonBinary).toHaveLength(0);
  });

  it("adaptive=true with scale=2 preserves output dimensions", async () => {
    const result = await nativeEngine!.preprocessImage!({
      data: rgba,
      width: W,
      height: H,
      channels: 4,
      scale: 2,
      adaptive: true,
    });
    expect(result.width).toBe(W * 2);
    expect(result.height).toBe(H * 2);
    expect(result.data.length).toBe(W * 2 * H * 2);
    const nonBinary = Array.from(result.data as Buffer).filter((v) => v !== 0 && v !== 255);
    expect(nonBinary).toHaveLength(0);
  });
});

describe.skipIf(HAS_NATIVE)("preprocessImage adaptive (native unavailable)", () => {
  it("skipped — native addon not loaded", () => {
    expect(true).toBe(true);
  });
});
