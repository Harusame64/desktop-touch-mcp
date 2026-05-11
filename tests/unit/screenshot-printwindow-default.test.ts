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
const { isLikelyBlankCapture, captureWindowRawWithFallback } = await import("../../src/engine/image.js");

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
});
