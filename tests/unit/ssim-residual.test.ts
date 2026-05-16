/**
 * ADR-019 Stage 4 — SSIM residual primitive unit tests.
 *
 * Drives `computeSsimResidual` (Rust napi, `src/ssim.rs`) directly through
 * the hand-maintained re-export in `index.js`. Tests are skipped when the
 * native addon is not available (Linux dev environment, addon out-of-date)
 * so CI on non-Windows hosts still passes — the Rust unit tests in
 * `src/ssim.rs::tests` are the algorithm SoT and run via `cargo test`.
 *
 * Sub-plan: docs/adr-019-stage-4-plan.md §3 row 11 (≥ 6 cases).
 */

import { describe, it, expect } from "vitest";
import { nativeEngine } from "../../src/engine/native-engine.js";

const compute = nativeEngine?.computeSsimResidual;
const describeNative = compute ? describe : describe.skip;

function buf(width: number, height: number, channels: 3 | 4, fillByte: number): Buffer {
  return Buffer.alloc(width * height * channels, fillByte);
}

describeNative("ADR-019 Stage 4 — computeSsimResidual (Wang et al. 2004)", () => {
  it("same-frame returns fraction_changed === 0 and mean_ssim ≥ 0.999", () => {
    const b = buf(64, 64, 4, 128);
    const r = compute!(b, b, 64, 64, 4, null);
    expect(r.fractionChanged).toBe(0);
    expect(r.centroid).toBeUndefined();
    expect(r.meanSsim).toBeGreaterThanOrEqual(0.999);
  });

  it("RGB (3 channel) same-frame is also identical", () => {
    const b = buf(32, 32, 3, 200);
    const r = compute!(b, b, 32, 32, 3, null);
    expect(r.fractionChanged).toBe(0);
    expect(r.meanSsim).toBeGreaterThanOrEqual(0.999);
  });

  it("20×20 black rect on white 200×200: fraction_changed > 0, centroid near (100, 100)", () => {
    const w = 200;
    const h = 200;
    const ch = 4 as const;
    const pre = buf(w, h, ch, 255);
    const post = Buffer.from(pre);
    // Draw black rect [90..110) × [90..110).
    const stride = w * ch;
    for (let y = 90; y < 110; y++) {
      for (let x = 90; x < 110; x++) {
        const i = y * stride + x * ch;
        post[i] = 0;
        post[i + 1] = 0;
        post[i + 2] = 0;
        // alpha untouched
      }
    }
    const r = compute!(pre, post, w, h, ch, null);
    expect(r.fractionChanged).toBeGreaterThan(0);
    expect(r.fractionChanged).toBeLessThan(0.5);
    // Centroid present when fractionChanged > 0.
    expect(r.centroid).toBeDefined();
    expect(Math.abs(r.centroid!.x - 100)).toBeLessThanOrEqual(16);
    expect(Math.abs(r.centroid!.y - 100)).toBeLessThanOrEqual(16);
    // mean_ssim should be high (most windows untouched) but < 1.
    expect(r.meanSsim).toBeGreaterThan(0.9);
    expect(r.meanSsim).toBeLessThan(1.0);
  });

  it("region selects sub-rect: change in untouched corner reports no change", () => {
    const w = 64;
    const h = 64;
    const ch = 4 as const;
    const pre = buf(w, h, ch, 0);
    const post = Buffer.from(pre);
    // Whiten bottom-right quadrant only.
    const stride = w * ch;
    for (let y = 32; y < 64; y++) {
      for (let x = 32; x < 64; x++) {
        const i = y * stride + x * ch;
        post[i] = 255;
        post[i + 1] = 255;
        post[i + 2] = 255;
      }
    }
    const r = compute!(pre, post, w, h, ch, {
      x: 0,
      y: 0,
      width: 24,
      height: 24,
    });
    expect(r.fractionChanged).toBe(0);
    expect(r.meanSsim).toBeGreaterThanOrEqual(0.999);
  });

  it("size mismatch throws", () => {
    const pre = Buffer.alloc(10);
    const post = buf(16, 16, 4, 0);
    expect(() => compute!(pre, post, 16, 16, 4, null)).toThrow();
  });

  it("invalid channels throws", () => {
    const b = buf(16, 16, 4, 0).subarray(0, 16 * 16 * 2);
    expect(() => compute!(b, b, 16, 16, 2 as 3 | 4, null)).toThrow();
  });

  it("region outside frame throws", () => {
    const b = buf(16, 16, 4, 0);
    expect(() =>
      compute!(b, b, 16, 16, 4, { x: 10, y: 10, width: 20, height: 20 }),
    ).toThrow();
  });

  it("region smaller than 8×8 window: returns mean_ssim only, fraction is 0", () => {
    const b = buf(16, 16, 4, 128);
    const r = compute!(b, b, 16, 16, 4, {
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    });
    expect(r.fractionChanged).toBe(0);
    expect(r.meanSsim).toBeGreaterThanOrEqual(0.999);
  });
});
