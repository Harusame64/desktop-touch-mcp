import { describe, it, expect } from "vitest";
import { nativeEngine } from "../../src/engine/native-engine.js";

const HAS_NATIVE = nativeEngine?.preprocessImage != null;

/** 4-channel RGBA buffer filled with a simple gradient pattern. */
function makeRgbaBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[i]     = (x * 255) / (width - 1);   // R
      buf[i + 1] = (y * 255) / (height - 1);  // G
      buf[i + 2] = 128;                        // B
      buf[i + 3] = 255;                        // A
    }
  }
  return buf;
}

describe.skipIf(!HAS_NATIVE)("preprocessImage — scale 1..4 (Rust)", () => {
  const W = 8;
  const H = 6;
  const buf = makeRgbaBuffer(W, H);

  for (const scale of [1, 2, 3, 4] as const) {
    it(`scale=${scale}: output size is ${W * scale}×${H * scale}`, async () => {
      const result = await nativeEngine!.preprocessImage!({
        data: buf,
        width: W,
        height: H,
        channels: 4,
        scale,
      });
      expect(result.width).toBe(W * scale);
      expect(result.height).toBe(H * scale);
      expect(result.channels).toBe(1); // grayscale
      expect(result.data.length).toBe(W * scale * H * scale);
    });
  }

  it("scale=5 is rejected with an error", async () => {
    await expect(
      nativeEngine!.preprocessImage!({ data: buf, width: W, height: H, channels: 4, scale: 5 })
    ).rejects.toThrow(/scale must be 1, 2, 3, or 4/);
  });

  it("scale=0 is rejected with an error", async () => {
    await expect(
      nativeEngine!.preprocessImage!({ data: buf, width: W, height: H, channels: 4, scale: 0 })
    ).rejects.toThrow(/scale must be/);
  });
});

describe.skipIf(HAS_NATIVE)("preprocessImage (native unavailable)", () => {
  it("skipped — native addon not loaded", () => {
    expect(true).toBe(true);
  });
});
