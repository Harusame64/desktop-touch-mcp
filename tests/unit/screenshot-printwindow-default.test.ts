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

const { mockPrintWindowToBuffer, mockGrabRegion, mockCaptureWindowWgc, mockCanUseWgc } = vi.hoisted(() => ({
  mockPrintWindowToBuffer: vi.fn(),
  mockGrabRegion: vi.fn(),
  // ADR-027 WGC rescue (Phase 2). Default OFF so the pre-existing PrintWindow /
  // BitBlt routing tests are unaffected; the WGC-rescue describe flips them on.
  mockCaptureWindowWgc: vi.fn(),
  mockCanUseWgc: vi.fn(() => false),
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    printWindowToBuffer: mockPrintWindowToBuffer,
    captureWindowWgc: mockCaptureWindowWgc,
    canCaptureWindowViaWgc: mockCanUseWgc,
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
const { isLikelyBlankCapture, captureWindowRawWithFallback, captureWindowWithFallback, captureWindowBackground, _resetWgcSupportForTest } = await import("../../src/engine/image.js");

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
    _resetWgcSupportForTest();
    mockCanUseWgc.mockReturnValue(false); // WGC off by default; rescue tests flip it
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
    _resetWgcSupportForTest();
    mockCanUseWgc.mockReturnValue(false); // WGC off by default; rescue tests flip it
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-027 Phase 2 — WGC rescue (normal mode) + WGC primary (background mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("captureWindowRawWithFallback — WGC rescue (ADR-027 Phase 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWgcSupportForTest();
    mockCanUseWgc.mockReturnValue(false);
  });

  const region = { x: 100, y: 200, width: 64, height: 64 };
  const hwnd = 12345n;

  it("PrintWindow all-black + WGC eligible + WGC returns real pixels → source='wgc', no BitBlt", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(64, 64), width: 64, height: 64 });

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("wgc");
    expect(result.fallbackReason).toBe("printwindow-all-black"); // records why PrintWindow was abandoned
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1);
    expect(mockGrabRegion).not.toHaveBeenCalled();
  });

  it("PrintWindow throws + WGC eligible + WGC real → source='wgc', reason='printwindow-failed'", async () => {
    mockPrintWindowToBuffer.mockImplementation(() => { throw new Error("PrintWindow native error"); });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(64, 64), width: 64, height: 64 });

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("wgc");
    expect(result.fallbackReason).toBe("printwindow-failed");
    expect(mockGrabRegion).not.toHaveBeenCalled();
  });

  it("WGC returns an all-black frame → rejected (never returns black as real), falls to BitBlt", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1);
    expect(mockGrabRegion).toHaveBeenCalledTimes(1);
  });

  it("WGC ineligible (D3 gate false) → BitBlt, WGC not attempted", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(false); // minimised / hidden / cloaked
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(mockCaptureWindowWgc).not.toHaveBeenCalled();
    expect(mockGrabRegion).toHaveBeenCalledTimes(1);
  });

  it("WGC 'unsupported' rejection latches → subsequent eligible captures skip WGC", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockRejectedValue(new Error("WGC unsupported on this OS"));
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const first = await captureWindowRawWithFallback(hwnd, region);
    expect(first.source).toBe("bitblt-fallback");
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1);

    // Second eligible capture must NOT re-attempt WGC (wgcUnsupported latched).
    const second = await captureWindowRawWithFallback(hwnd, region);
    expect(second.source).toBe("bitblt-fallback");
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("flags=0 (legacy / fullContent=false) → WGC rescue skipped, BitBlt used", async () => {
    // Honors the explicit fast-PrintWindow opt-out (Codex review): even when the
    // window is WGC-eligible and PrintWindow blanked, legacy mode must not pull
    // in WGC.
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(64, 64), width: 64, height: 64 });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region, 0);
    expect(result.source).toBe("bitblt-fallback");
    expect(mockCaptureWindowWgc).not.toHaveBeenCalled();
  });

  it("flags=3 (PW_CLIENTONLY) → WGC skipped (WGC can't do client-only), BitBlt used", async () => {
    // WGC always captures the full window; honor the client-only request via
    // PrintWindow/BitBlt instead of silently returning a full-window frame.
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(64, 64), width: 64, height: 64 });
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 10, g: 20, b: 30 }));

    const result = await captureWindowRawWithFallback(hwnd, region, 3);
    expect(result.source).toBe("bitblt-fallback");
    expect(mockCaptureWindowWgc).not.toHaveBeenCalled();
  });
});

describe("captureWindowBackground — WGC primary (ADR-027 Phase 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWgcSupportForTest();
    mockCanUseWgc.mockReturnValue(false);
  });

  const hwnd = 12345n;

  it("eligible window → WGC used, PrintWindow NOT called", async () => {
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect(result).toBeTruthy();
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1);
    expect(mockPrintWindowToBuffer).not.toHaveBeenCalled();
  });

  it("ineligible window (hidden/minimised/cloaked) → PrintWindow used", async () => {
    mockCanUseWgc.mockReturnValue(false);
    mockPrintWindowToBuffer.mockReturnValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect(result).toBeTruthy();
    expect(mockCaptureWindowWgc).not.toHaveBeenCalled();
    expect(mockPrintWindowToBuffer).toHaveBeenCalledTimes(1);
  });

  it("flags=0 (fullContent=false) → legacy PrintWindow, WGC NOT attempted", async () => {
    mockCanUseWgc.mockReturnValue(true); // eligible, but legacy mode opts out of WGC
    mockPrintWindowToBuffer.mockReturnValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280, 0);
    expect(result).toBeTruthy();
    expect(mockCaptureWindowWgc).not.toHaveBeenCalled();
    expect(mockPrintWindowToBuffer).toHaveBeenCalledTimes(1);
  });

  it("flags=3 (PW_CLIENTONLY) → WGC skipped, client-only PrintWindow used", async () => {
    mockCanUseWgc.mockReturnValue(true);
    mockPrintWindowToBuffer.mockReturnValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280, 3);
    expect(result).toBeTruthy();
    expect(mockCaptureWindowWgc).not.toHaveBeenCalled();
    expect(mockPrintWindowToBuffer).toHaveBeenCalledTimes(1);
  });

  it("WGC returns an all-black frame → PrintWindow fallback (blank-safety)", async () => {
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeUniformRgba(80, 60, 0, 0, 0), width: 80, height: 60 });
    mockPrintWindowToBuffer.mockReturnValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect(result).toBeTruthy();
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1);
    expect(mockPrintWindowToBuffer).toHaveBeenCalledTimes(1); // WGC blank rejected → PrintWindow
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-027 Phase 3 — R9/AC8 capture-blocked (every rung returns all-black)
//
// The ladder is finite (PrintWindow → WGC → BitBlt). captureBlocked flags the
// case where the LAST rung is ALSO all-black, so the served pixels are black
// and NOT the real content (DRM video / secure desktop / hardware overlay). The
// caller surfaces an explicit reason instead of a silent black image. An
// occluding (non-black) BitBlt frame is NOT capture-blocked — it keeps the
// existing "overlapping windows" hint.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureWindowRawWithFallback — capture-blocked (ADR-027 Phase 3 / AC8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWgcSupportForTest();
    mockCanUseWgc.mockReturnValue(false);
  });

  const region = { x: 100, y: 200, width: 64, height: 64 };
  const hwnd = 12345n;

  it("PrintWindow all-black + WGC ineligible + BitBlt ALSO all-black → captureBlocked=true", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(false);
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 0, g: 0, b: 0 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(result.captureBlocked).toBe(true);
    // fallbackReason is preserved as a diagnostic (records why PrintWindow was abandoned).
    expect(result.fallbackReason).toBe("printwindow-all-black");
  });

  it("PrintWindow throws + WGC ineligible + BitBlt all-black → captureBlocked=true (printwindow-failed reason)", async () => {
    mockPrintWindowToBuffer.mockImplementation(() => { throw new Error("PrintWindow native error"); });
    mockCanUseWgc.mockReturnValue(false);
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 0, g: 0, b: 0 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(result.captureBlocked).toBe(true);
    expect(result.fallbackReason).toBe("printwindow-failed");
  });

  it("PrintWindow all-black + BitBlt shows an OCCLUDING (non-black) window → captureBlocked=false", async () => {
    // The headline non-capture-blocked case: an occluding window's pixels are
    // real (just the wrong window). Keep the "overlapping windows" hint, do NOT
    // claim capture-blocked.
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(false);
    mockGrabRegion.mockResolvedValue(makeNutjsImage(64, 64, { r: 80, g: 90, b: 100 }));

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("bitblt-fallback");
    expect(result.captureBlocked).toBe(false);
    expect(result.fallbackReason).toBe("printwindow-all-black");
  });

  it("PrintWindow returns real pixels → captureBlocked=false (no rung exhaustion)", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeGradientRgba(64, 64), width: 64, height: 64 });

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("printwindow");
    expect(result.captureBlocked).toBe(false);
  });

  it("WGC rescue serves real pixels → captureBlocked=false", async () => {
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(64, 64, 0, 0, 0), width: 64, height: 64 });
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(64, 64), width: 64, height: 64 });

    const result = await captureWindowRawWithFallback(hwnd, region);
    expect(result.source).toBe("wgc");
    expect(result.captureBlocked).toBe(false);
  });
});

describe("captureWindowBackground — capture-blocked (ADR-027 Phase 3 / AC8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWgcSupportForTest();
    mockCanUseWgc.mockReturnValue(false);
  });

  const hwnd = 12345n;

  it("WGC ineligible + PrintWindow all-black → captureBlocked=true", async () => {
    mockCanUseWgc.mockReturnValue(false);
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(80, 60, 0, 0, 0), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect((result as { captureBlocked?: boolean }).captureBlocked).toBe(true);
  });

  it("WGC eligible but all-black + PrintWindow ALSO all-black → captureBlocked=true (both rungs failed)", async () => {
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeUniformRgba(80, 60, 0, 0, 0), width: 80, height: 60 });
    mockPrintWindowToBuffer.mockReturnValue({ data: makeUniformRgba(80, 60, 0, 0, 0), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect(mockCaptureWindowWgc).toHaveBeenCalledTimes(1);
    expect(mockPrintWindowToBuffer).toHaveBeenCalledTimes(1);
    expect((result as { captureBlocked?: boolean }).captureBlocked).toBe(true);
  });

  it("WGC serves real pixels → not capture-blocked", async () => {
    mockCanUseWgc.mockReturnValue(true);
    mockCaptureWindowWgc.mockResolvedValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect((result as { captureBlocked?: boolean }).captureBlocked).toBeFalsy();
    expect(mockPrintWindowToBuffer).not.toHaveBeenCalled();
  });

  it("PrintWindow serves real pixels → not capture-blocked", async () => {
    mockCanUseWgc.mockReturnValue(false);
    mockPrintWindowToBuffer.mockReturnValue({ data: makeGradientRgba(80, 60), width: 80, height: 60 });

    const result = await captureWindowBackground(hwnd, 1280);
    expect((result as { captureBlocked?: boolean }).captureBlocked).toBeFalsy();
  });
});
