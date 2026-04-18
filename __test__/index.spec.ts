/**
 * Integration tests for desktop-touch-engine native addon.
 * Validates that the Rust implementation matches the TypeScript reference behavior.
 */
import { describe, it, expect } from "vitest";
import * as native from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reference TS implementations (from layer-buffer.ts and image.ts)
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_SIZE = 8;
const NOISE_THRESHOLD = 16;

/** TypeScript reference: computeChangeFraction from layer-buffer.ts */
function tsComputeChangeFraction(
  prev: Buffer,
  curr: Buffer,
  width: number,
  height: number,
  channels: number
): number {
  const blocksX = Math.ceil(width / BLOCK_SIZE);
  const blocksY = Math.ceil(height / BLOCK_SIZE);
  let changedBlocks = 0;
  const totalBlocks = blocksX * blocksY;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const x0 = bx * BLOCK_SIZE;
      const y0 = by * BLOCK_SIZE;
      const x1 = Math.min(x0 + BLOCK_SIZE, width);
      const y1 = Math.min(y0 + BLOCK_SIZE, height);

      let sumDelta = 0;
      let count = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * width + x) * channels;
          for (let c = 0; c < 3; c++) {
            sumDelta += Math.abs((prev[idx + c] ?? 0) - (curr[idx + c] ?? 0));
          }
          count++;
        }
      }

      if (count > 0 && sumDelta / count / 3 > NOISE_THRESHOLD) {
        changedBlocks++;
      }
    }
  }

  return totalBlocks > 0 ? changedBlocks / totalBlocks : 0;
}

/** TypeScript reference: hammingDistance from image.ts */
function tsHammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function randomBuffer(width: number, height: number, channels: number): Buffer {
  const len = width * height * channels;
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf;
}

function solidBuffer(
  width: number,
  height: number,
  channels: number,
  value: number
): Buffer {
  return Buffer.alloc(width * height * channels, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: computeChangeFraction
// ─────────────────────────────────────────────────────────────────────────────

describe("computeChangeFraction", () => {
  it("returns 0 for identical images", () => {
    const buf = solidBuffer(100, 100, 3, 128);
    expect(native.computeChangeFraction(buf, buf, 100, 100, 3)).toBe(0);
  });

  it("returns 1 for completely different images", () => {
    const prev = solidBuffer(16, 16, 3, 0);
    const curr = solidBuffer(16, 16, 3, 255);
    expect(native.computeChangeFraction(prev, curr, 16, 16, 3)).toBe(1);
  });

  it("returns 0 for zero-size images", () => {
    const empty = Buffer.alloc(0);
    expect(native.computeChangeFraction(empty, empty, 0, 0, 3)).toBe(0);
  });

  it("handles RGBA (4 channels)", () => {
    const prev = solidBuffer(32, 32, 4, 0);
    const curr = solidBuffer(32, 32, 4, 255);
    expect(native.computeChangeFraction(prev, curr, 32, 32, 4)).toBe(1);
  });

  it("ignores noise below threshold", () => {
    const prev = solidBuffer(8, 8, 3, 100);
    const curr = solidBuffer(8, 8, 3, 110);
    expect(native.computeChangeFraction(prev, curr, 8, 8, 3)).toBe(0);
  });

  it("throws on buffer length mismatch", () => {
    const short = Buffer.alloc(10);
    const long = Buffer.alloc(100 * 100 * 3);
    expect(() =>
      native.computeChangeFraction(short, long, 100, 100, 3)
    ).toThrow(/mismatch/);
  });

  it("throws on invalid channels", () => {
    const buf = Buffer.alloc(10 * 10 * 2);
    expect(() =>
      native.computeChangeFraction(buf, buf, 10, 10, 2)
    ).toThrow(/channels/);
  });

  // Parity tests: Rust == TS reference
  const parityConfigs = [
    { w: 64, h: 64, ch: 3, name: "64x64 RGB" },
    { w: 100, h: 75, ch: 3, name: "100x75 RGB (non-block-aligned)" },
    { w: 128, h: 128, ch: 4, name: "128x128 RGBA" },
    { w: 1920, h: 1080, ch: 3, name: "1920x1080 RGB (Full HD)" },
  ];

  for (const { w, h, ch, name } of parityConfigs) {
    it(`matches TS reference for random ${name}`, () => {
      const prev = randomBuffer(w, h, ch);
      const curr = randomBuffer(w, h, ch);
      const rustResult = native.computeChangeFraction(prev, curr, w, h, ch);
      const tsResult = tsComputeChangeFraction(prev, curr, w, h, ch);
      expect(rustResult).toBeCloseTo(tsResult, 10);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: dhashFromRaw
// ─────────────────────────────────────────────────────────────────────────────

describe("dhashFromRaw", () => {
  it("returns 0n for solid image", () => {
    const buf = solidBuffer(32, 32, 3, 128);
    const hash = native.dhashFromRaw(buf, 32, 32, 3);
    expect(hash).toBe(0n);
  });

  it("returns nonzero for gradient image", () => {
    const buf = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const val = Math.min(255, 255 - x * 4);
        const idx = (y * 64 + x) * 3;
        buf[idx] = val;
        buf[idx + 1] = val;
        buf[idx + 2] = val;
      }
    }
    const hash = native.dhashFromRaw(buf, 64, 64, 3);
    // Left-to-right decreasing gradient: every left > right → all bits set
    expect(hash).toBe(BigInt("0xFFFFFFFFFFFFFFFF"));
  });

  it("handles RGBA", () => {
    const buf = solidBuffer(16, 16, 4, 100);
    expect(native.dhashFromRaw(buf, 16, 16, 4)).toBe(0n);
  });

  it("returns 0n for zero-size image", () => {
    expect(native.dhashFromRaw(Buffer.alloc(0), 0, 0, 3)).toBe(0n);
  });

  it("throws on invalid buffer length", () => {
    expect(() => native.dhashFromRaw(Buffer.alloc(10), 32, 32, 3)).toThrow(
      /mismatch/
    );
  });

  it("produces consistent results", () => {
    const buf = randomBuffer(64, 64, 3);
    const h1 = native.dhashFromRaw(buf, 64, 64, 3);
    const h2 = native.dhashFromRaw(buf, 64, 64, 3);
    expect(h1).toBe(h2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: hammingDistance
// ─────────────────────────────────────────────────────────────────────────────

describe("hammingDistance", () => {
  it("returns 0 for identical hashes", () => {
    expect(native.hammingDistance(42n, 42n)).toBe(0);
  });

  it("returns 64 for completely different hashes", () => {
    expect(native.hammingDistance(0n, BigInt("0xFFFFFFFFFFFFFFFF"))).toBe(64);
  });

  it("counts single bit difference", () => {
    expect(native.hammingDistance(0n, 1n)).toBe(1);
  });

  it("matches TS reference for random values", () => {
    for (let i = 0; i < 100; i++) {
      const a = BigInt(Math.floor(Math.random() * 2 ** 52));
      const b = BigInt(Math.floor(Math.random() * 2 ** 52));
      expect(native.hammingDistance(a, b)).toBe(tsHammingDistance(a, b));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Performance smoke test
// ─────────────────────────────────────────────────────────────────────────────

describe("performance", () => {
  it("Rust computeChangeFraction is faster than TS for Full HD", () => {
    const w = 1920,
      h = 1080,
      ch = 3;
    const prev = randomBuffer(w, h, ch);
    const curr = randomBuffer(w, h, ch);

    // Warm up
    native.computeChangeFraction(prev, curr, w, h, ch);
    tsComputeChangeFraction(prev, curr, w, h, ch);

    // Benchmark Rust
    const rustStart = performance.now();
    const ITERS = 20;
    for (let i = 0; i < ITERS; i++) {
      native.computeChangeFraction(prev, curr, w, h, ch);
    }
    const rustMs = (performance.now() - rustStart) / ITERS;

    // Benchmark TS
    const tsStart = performance.now();
    for (let i = 0; i < ITERS; i++) {
      tsComputeChangeFraction(prev, curr, w, h, ch);
    }
    const tsMs = (performance.now() - tsStart) / ITERS;

    const speedup = tsMs / rustMs;
    console.log(
      `  computeChangeFraction 1920x1080 RGB:  Rust=${rustMs.toFixed(2)}ms  TS=${tsMs.toFixed(2)}ms  speedup=${speedup.toFixed(1)}x`
    );

    // With SSE2 SIMD (psadbw), Rust achieves ~13x over TS.
    // Conservative threshold of 5x to avoid flaky CI.
    expect(speedup).toBeGreaterThan(5);
  });
});
