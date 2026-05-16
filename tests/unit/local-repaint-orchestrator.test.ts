/**
 * ADR-019 Stage 4 — local-repaint orchestrator unit tests.
 *
 * Tests `resolveLocalRepaintRect` (deterministic, no mocks needed) and
 * `verifyLocalRepaint` (mocks the native SSIM + the
 * `capturePostFrameUntilStable` polling helper to drive the orchestrator
 * through each branch of §2.3 deterministically).
 *
 * Sub-plan: docs/adr-019-stage-4-plan.md §3 row 12 (≥ 8 cases).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawFrame } from "../../src/engine/layer-buffer.js";
import type {
  NativeSsimRegion,
  NativeSsimResidualResult,
} from "../../src/engine/native-types.js";

// Mock the layer-buffer polling helper. The orchestrator calls
// `capturePostFrameUntilStable(hwnd, region, opts)` and then reads
// `frames[frames.length - 1]` as the post-action stable frame.
const mockCapturePostFrame = vi.fn();
vi.mock("../../src/engine/layer-buffer.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/engine/layer-buffer.js")
  >();
  return {
    ...actual,
    capturePostFrameUntilStable: (
      ...args: Parameters<typeof actual.capturePostFrameUntilStable>
    ) => mockCapturePostFrame(...args),
  };
});

// Mock the native engine surface. The orchestrator calls
// `nativeEngine?.computeSsimResidual(...)` and also
// `computeChangeFraction` indirectly via `layer-buffer.ts` (but we re-export
// the real `computeChangeFraction` through importOriginal above so the
// cheap-reject path runs against actual buffers without native dependency).
const mockComputeSsim = vi.fn();
vi.mock("../../src/engine/native-engine.js", async () => {
  return {
    nativeEngine: {
      computeChangeFraction: (
        prev: Buffer,
        curr: Buffer,
        _w: number,
        _h: number,
        _ch: number,
      ) => {
        // Simple TS-side change fraction: equal buffers → 0, otherwise 1.
        // The orchestrator only branches on `< NO_CHANGE_FLOOR (0.001)` so
        // either 0 or 1 is sufficient to drive each cheap-reject branch.
        return prev.equals(curr) ? 0 : 1;
      },
      dhashFromRaw: () => 0n,
      hammingDistance: () => 0,
      computeSsimResidual: (
        ...args: [Buffer, Buffer, number, number, number, NativeSsimRegion | null | undefined]
      ): NativeSsimResidualResult => mockComputeSsim(...args),
    },
    nativeUia: null,
    nativeVision: null,
    nativeWin32: null,
    nativeL1: null,
    nativeViewFocus: null,
    nativeExcel: null,
  };
});

// Import after mocks so the orchestrator picks up the mocked surface.
const localRepaint = await import("../../src/engine/local-repaint.js");
const { resolveLocalRepaintRect, verifyLocalRepaint } = localRepaint;

function makeFrame(
  width: number,
  height: number,
  channels: 3 | 4 = 4,
  fillByte: number = 0,
): RawFrame {
  return {
    rawPixels: Buffer.alloc(width * height * channels, fillByte),
    width,
    height,
    channels,
  };
}

const HWND = 0n;

describe("resolveLocalRepaintRect (P16 decision lock default b — 2 strategies)", () => {
  const windowRect = { x: 100, y: 100, width: 800, height: 600 };

  it("point inside windowRect → rectSource: 'point_padded' with 192×192 square", () => {
    const r = resolveLocalRepaintRect({
      point: { x: 500, y: 400 },
      windowRect,
    });
    expect(r.rectSource).toBe("point_padded");
    expect(r.rect.width).toBe(192);
    expect(r.rect.height).toBe(192);
    expect(r.rect.x).toBe(500 - 96);
    expect(r.rect.y).toBe(400 - 96);
  });

  it("point near windowRect edge → padded square clipped to windowRect", () => {
    const r = resolveLocalRepaintRect({
      point: { x: 110, y: 110 }, // 10 px inside top-left
      windowRect,
    });
    expect(r.rectSource).toBe("point_padded");
    // Clipped to windowRect.x = 100.
    expect(r.rect.x).toBe(100);
    expect(r.rect.y).toBe(100);
  });

  it("no point supplied → rectSource: 'window_fallback'", () => {
    const r = resolveLocalRepaintRect({ windowRect });
    expect(r.rectSource).toBe("window_fallback");
    expect(r.rect).toEqual(windowRect);
  });

  it("point outside windowRect (no intersection) → window_fallback", () => {
    const r = resolveLocalRepaintRect({
      point: { x: 5000, y: 5000 },
      windowRect,
    });
    expect(r.rectSource).toBe("window_fallback");
    expect(r.rect).toEqual(windowRect);
  });
});

describe("verifyLocalRepaint (§2.3 orchestrator)", () => {
  beforeEach(() => {
    mockComputeSsim.mockReset();
    mockCapturePostFrame.mockReset();
  });

  it("native SSIM unavailable → motion: 'indeterminate'", async () => {
    // Override the global mock so computeSsimResidual is undefined.
    const { nativeEngine } = await import("../../src/engine/native-engine.js");
    const origCompute = nativeEngine!.computeSsimResidual;
    // @ts-expect-error — temporary removal for negative path
    nativeEngine!.computeSsimResidual = undefined;
    try {
      const pre = makeFrame(192, 192);
      const r = await verifyLocalRepaint({
        hwnd: HWND,
        hint: {
          point: { x: 100, y: 100 },
          windowRect: { x: 0, y: 0, width: 192, height: 192 },
        },
        preFrame: pre,
      });
      expect(r.motion).toBe("indeterminate");
      expect(r.source).toBe("ssim_residual");
    } finally {
      nativeEngine!.computeSsimResidual = origCompute;
    }
  });

  it("preFrame === null → motion: 'indeterminate'", async () => {
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: null,
    });
    expect(r.motion).toBe("indeterminate");
    expect(r.source).toBe("ssim_residual");
  });

  it("rect area > MAX_RECT_AREA_PX → motion: 'indeterminate' without SSIM call", async () => {
    const pre = makeFrame(192, 192);
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        // Force window_fallback with > 1_000_000 px area.
        windowRect: { x: 0, y: 0, width: 2000, height: 2000 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("indeterminate");
    expect(mockComputeSsim).not.toHaveBeenCalled();
    expect(mockCapturePostFrame).not.toHaveBeenCalled();
  });

  it("stableReached: false → motion: 'indeterminate' (R6 mitigation)", async () => {
    const pre = makeFrame(192, 192);
    const post = makeFrame(192, 192, 4, 255);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [post],
      deltas: [1.0, 1.0, 1.0],
      stableReached: false,
      framesToStability: null,
      totalElapsedMs: 700,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("indeterminate");
    expect(r.source).toBe("ssim_residual");
    // SSIM is NOT called when stableReached: false (orchestrator short-
    // circuits to R6 mitigation BEFORE the kernel call to keep latency low).
    expect(mockComputeSsim).not.toHaveBeenCalled();
  });

  it("identical pre/post (cheap-reject) → motion: 'no_change' without SSIM call", async () => {
    const pre = makeFrame(192, 192, 4, 100);
    // Same buffer fill → `computeChangeFraction` returns 0 (below NO_CHANGE_FLOOR).
    const post = makeFrame(192, 192, 4, 100);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [post],
      deltas: [0],
      stableReached: true,
      framesToStability: 1,
      totalElapsedMs: 80,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("no_change");
    expect(r.source).toBe("ssim_residual");
    // No SSIM kernel invocation needed — cheap reject path.
    expect(mockComputeSsim).not.toHaveBeenCalled();
  });

  it("fraction_changed >= 0.05 → motion: 'local_repaint' with centroid + meanSsim", async () => {
    const pre = makeFrame(192, 192, 4, 0);
    // Different content → `computeChangeFraction` (mock) returns 1 → SSIM is called.
    const post = makeFrame(192, 192, 4, 200);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [post],
      deltas: [0],
      stableReached: true,
      framesToStability: 1,
      totalElapsedMs: 80,
    });
    mockComputeSsim.mockReturnValueOnce({
      fractionChanged: 0.12,
      centroid: { x: 110, y: 95 },
      meanSsim: 0.85,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("local_repaint");
    expect(r.source).toBe("ssim_residual");
    expect(r.residual?.fractionChanged).toBe(0.12);
    expect(r.residual?.centroid).toEqual({ x: 110, y: 95 });
    // P15(a) plumbing — meanSsim exposed on local_repaint.
    expect(r.residual?.meanSsim).toBe(0.85);
  });

  it("fraction < 0.05 AND meanSsim >= 0.99 → motion: 'no_change' with meanSsim exposed", async () => {
    const pre = makeFrame(192, 192, 4, 0);
    const post = makeFrame(192, 192, 4, 200);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [post],
      deltas: [0],
      stableReached: true,
      framesToStability: 1,
      totalElapsedMs: 80,
    });
    mockComputeSsim.mockReturnValueOnce({
      fractionChanged: 0.01,
      meanSsim: 0.995,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("no_change");
    // P15(a): observation.residual.meanSsim audit field present on no_change.
    expect(r.residual?.fractionChanged).toBe(0.01);
    expect(r.residual?.meanSsim).toBe(0.995);
  });

  it("fraction < 0.05 AND meanSsim < 0.99 → motion: 'indeterminate' with meanSsim exposed", async () => {
    const pre = makeFrame(192, 192, 4, 0);
    const post = makeFrame(192, 192, 4, 200);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [post],
      deltas: [0],
      stableReached: true,
      framesToStability: 1,
      totalElapsedMs: 80,
    });
    mockComputeSsim.mockReturnValueOnce({
      fractionChanged: 0.02,
      meanSsim: 0.96,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("indeterminate");
    // P15(a): meanSsim exposed on indeterminate so callers can audit boundary.
    expect(r.residual?.fractionChanged).toBe(0.02);
    expect(r.residual?.meanSsim).toBe(0.96);
  });

  it("post-frame capture returns empty array → motion: 'indeterminate'", async () => {
    const pre = makeFrame(192, 192);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [],
      deltas: [],
      stableReached: false,
      framesToStability: null,
      totalElapsedMs: 60,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("indeterminate");
    expect(mockComputeSsim).not.toHaveBeenCalled();
  });

  it("post-frame shape mismatch → motion: 'indeterminate'", async () => {
    // Pre-frame is 192×192×4, post is 100×100×4 (window resized mid-action).
    const pre = makeFrame(192, 192);
    const post = makeFrame(100, 100, 4, 255);
    mockCapturePostFrame.mockResolvedValueOnce({
      frames: [post],
      deltas: [0],
      stableReached: true,
      framesToStability: 1,
      totalElapsedMs: 80,
    });
    const r = await verifyLocalRepaint({
      hwnd: HWND,
      hint: {
        point: { x: 100, y: 100 },
        windowRect: { x: 0, y: 0, width: 192, height: 192 },
      },
      preFrame: pre,
    });
    expect(r.motion).toBe("indeterminate");
  });
});
