/**
 * screenshot-printwindow-default.test.ts
 *
 * Regression pins for the PrintWindow-default capture route added in v1.4.4.
 *
 * The critical invariant is: `isLikelyBlankCapture` MUST NOT flag an all-white
 * frame as blank. Empty Notepad, empty browser tabs, blank dialogs and untouched
 * input fields are routine "all-white" surfaces; if we treat them as blank, the
 * BitBlt fallback would silently substitute whatever happens to be at the
 * window's on-screen rect (overlapping windows / wallpaper). That is the worst
 * failure mode of the whole flip — return the wrong window's pixels without
 * the caller knowing.
 *
 * The secondary invariant: only PrintWindow producing "no data at all"
 * (`null` / zero-size / exception) OR an all-black + zero-variance frame
 * triggers fallback. Even all-black fallback emits a warning so callers can
 * treat the result as ambiguous when they expected a black window
 * (terminal / dark editor / video frame / dark mode IDE).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockPrintWindowToBuffer, mockGrabRegion } = vi.hoisted(() => ({
  mockPrintWindowToBuffer: vi.fn(),
  mockGrabRegion: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    printWindowToBuffer: mockPrintWindowToBuffer,
  };
});

vi.mock("../../src/engine/nutjs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/nutjs.js")>();
  return {
    ...actual,
    screen: { grabRegion: mockGrabRegion },
  };
});

// Import the SUT after the mocks so the module picks up the mocked deps.
const { isLikelyBlankCapture, captureWindowRawWithFallback, captureWindowWithFallback } = await import("../../src/engine/image.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUniformRgba(width: number, height: number, r: number, g: number, b: number, a = 255): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4 + 0] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

function makeGradientRgba(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      buf[off + 0] = (x * 255) & 0xff;
      buf[off + 1] = (y * 255) & 0xff;
      buf[off + 2] = ((x + y) * 127) & 0xff;
      buf[off + 3] = 255;
    }
  }
  return buf;
}

/** nutjs Image-like stub returned from screen.grabRegion. */
function makeNutjsImage(width: number, height: number, fill: { r: number; g: number; b: number }): {
  toRGB: () => Promise<{ data: Buffer; width: number; height: number; hasAlphaChannel: boolean }>;
} {
  return {
    toRGB: async () => ({
      data: makeUniformRgba(width, height, fill.r, fill.g, fill.b),
      width,
      height,
      hasAlphaChannel: true,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// isLikelyBlankCapture — pure function, no mocks needed
// ─────────────────────────────────────────────────────────────────────────────

describe("isLikelyBlankCapture", () => {
  it("CRITICAL: all-white RGBA is NEVER flagged blank", () => {
    // Empty Notepad / empty browser tab / blank dialog — these are normal
    // images. Flagging them blank would cause BitBlt fallback to substitute
    // whatever sits at the on-screen rect (overlapping windows / wallpaper).
    const buf = makeUniformRgba(64, 64, 255, 255, 255);
    const result = isLikelyBlankCapture(buf, 64, 64, 4);
    expect(result.isBlank).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("all-black + zero variance IS flagged as printwindow-all-black", () => {
    const buf = makeUniformRgba(64, 64, 0, 0, 0);
    const result = isLikelyBlankCapture(buf, 64, 64, 4);
    expect(result.isBlank).toBe(true);
    expect(result.reason).toBe("printwindow-all-black");
  });

  it("mid-luminance uniform (mid-gray) is NOT flagged blank", () => {
    const buf = makeUniformRgba(64, 64, 128, 128, 128);
    const result = isLikelyBlankCapture(buf, 64, 64, 4);
    expect(result.isBlank).toBe(false);
  });

  it("dark-but-non-uniform image is NOT flagged blank (dark mode editor)", () => {
    // Mostly dark but with subtle pixel variation — dark editor / terminal
    // with text. Variance != 0 means "real content", do not fall back.
    const buf = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      const v = i % 2 === 0 ? 0 : 1; // alternating 0 and 1 — very dark, but varied
      buf[i * 4 + 0] = v;
      buf[i * 4 + 1] = v;
      buf[i * 4 + 2] = v;
      buf[i * 4 + 3] = 255;
    }
    const result = isLikelyBlankCapture(buf, 64, 64, 4);
    expect(result.isBlank).toBe(false);
  });

  it("gradient image is NOT flagged blank", () => {
    const buf = makeGradientRgba(32, 32);
    const result = isLikelyBlankCapture(buf, 32, 32, 4);
    expect(result.isBlank).toBe(false);
  });

  it("zero-size buffer is NOT flagged blank (treated as no-data, caller decides)", () => {
    const result = isLikelyBlankCapture(Buffer.alloc(0), 0, 0, 4);
    expect(result.isBlank).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureWindowRawWithFallback — exercise the routing decision
// ─────────────────────────────────────────────────────────────────────────────

describe("captureWindowRawWithFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const region = { x: 100, y: 200, width: 64, height: 64 };
  const hwnd = 12345n;

  it("PrintWindow returns a normal mixed-pixel frame → source='printwindow', no fallback", async () => {
    mockPrintWindowToBuffer.mockReturnValue({
      data: makeGradientRgba(64, 64),
      width: 64,
      height: 64,
    });

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("printwindow");
    expect(result.fallbackReason).toBeNull();
    expect(mockGrabRegion).not.toHaveBeenCalled();
  });

  it("CRITICAL: PrintWindow returns all-white → source='printwindow', no fallback", async () => {
    // Empty Notepad regression pin.
    mockPrintWindowToBuffer.mockReturnValue({
      data: makeUniformRgba(64, 64, 255, 255, 255),
      width: 64,
      height: 64,
    });

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("printwindow");
    expect(result.fallbackReason).toBeNull();
    expect(mockGrabRegion).not.toHaveBeenCalled();
  });

  it("PrintWindow throws → source='bitblt-fallback', reason='printwindow-failed'", async () => {
    mockPrintWindowToBuffer.mockImplementation(() => {
      throw new Error("PrintWindow native error");
    });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(result.fallbackReason).toBe("printwindow-failed");
    expect(mockGrabRegion).toHaveBeenCalledTimes(1);
  });

  it("PrintWindow returns zero-size → source='bitblt-fallback', reason='printwindow-failed'", async () => {
    mockPrintWindowToBuffer.mockReturnValue({
      data: Buffer.alloc(0),
      width: 0,
      height: 0,
    });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(result.fallbackReason).toBe("printwindow-failed");
  });

  it("PrintWindow returns all-black uniform → source='bitblt-fallback', reason='printwindow-all-black'", async () => {
    mockPrintWindowToBuffer.mockReturnValue({
      data: makeUniformRgba(64, 64, 0, 0, 0),
      width: 64,
      height: 64,
    });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(result.fallbackReason).toBe("printwindow-all-black");
    expect(mockGrabRegion).toHaveBeenCalledTimes(1);
  });

  it("BitBlt fallback grabs the FULL window rect, not a sub-region", async () => {
    // P1.1 regression pin: callers must pass the window's full screen rect as
    // windowRect, and the BitBlt fallback must grab that full rect — NOT the
    // caller's sub-region. Sub-region cropping happens at encode time via
    // opts.crop in window-local coords. If this branch grabbed a sub-region
    // sized buffer, opts.crop would either crash or pick the wrong pixels.
    const fullWindow = { x: 100, y: 200, width: 800, height: 600 };
    mockPrintWindowToBuffer.mockImplementation(() => {
      throw new Error("forced failure to exercise fallback");
    });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(800, 600, { r: 1, g: 2, b: 3 }));

    const result = await captureWindowRawWithFallback(hwnd, fullWindow);
    expect(result.source).toBe("bitblt-fallback");
    // Buffer dimensions must match the full window rect, not any sub-region.
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    // Verify grabRegion was called with the full window rect.
    expect(mockGrabRegion).toHaveBeenCalledTimes(1);
    const grabArg = mockGrabRegion.mock.calls[0]?.[0];
    expect(grabArg).toMatchObject({ left: 100, top: 200, width: 800, height: 600 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureWindowWithFallback — encode wrapper, exercise sub-region crop path
// ─────────────────────────────────────────────────────────────────────────────

describe("captureWindowWithFallback — sub-region crop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fullWindow = { x: 0, y: 0, width: 200, height: 150 };
  const hwnd = 12345n;

  it("PrintWindow + opts.crop → encode crops to sub-region without sharp throwing", async () => {
    // P3.1 regression pin: window-local sub-region crop applied uniformly to
    // the PrintWindow path. The full-window buffer enters encode and the
    // sub-region is extracted at encode time, so non-zero crop offsets are
    // safe (the buffer is large enough to contain the crop window).
    mockPrintWindowToBuffer.mockReturnValue({
      data: makeGradientRgba(200, 150),
      width: 200,
      height: 150,
    });

    const result = await captureWindowWithFallback(
      hwnd,
      fullWindow,
      { maxDimension: 200, crop: { x: 50, y: 30, width: 100, height: 60 } },
    );
    expect(result.source).toBe("printwindow");
    expect(result.fallbackReason).toBeNull();
    expect(result.width).toBe(100);
    expect(result.height).toBe(60);
    expect(mockGrabRegion).not.toHaveBeenCalled();
  });

  it("BitBlt fallback + opts.crop → encode crops to sub-region without sharp throwing", async () => {
    // P1.1 regression pin: when PrintWindow fails and the BitBlt fallback
    // grabs the FULL window rect, opts.crop still applies correctly because
    // both source branches return same-sized buffers. If the helper
    // accidentally grabbed only the sub-region, sharp's extract() with
    // non-zero offsets would throw "bad extract area".
    mockPrintWindowToBuffer.mockImplementation(() => {
      throw new Error("forced failure to exercise fallback");
    });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(200, 150, { r: 100, g: 100, b: 100 }));

    const result = await captureWindowWithFallback(
      hwnd,
      fullWindow,
      { maxDimension: 200, crop: { x: 50, y: 30, width: 100, height: 60 } },
    );
    expect(result.source).toBe("bitblt-fallback");
    expect(result.fallbackReason).toBe("printwindow-failed");
    expect(result.width).toBe(100);
    expect(result.height).toBe(60);
    expect(mockGrabRegion).toHaveBeenCalledTimes(1);
  });
});
