import sharp from "sharp";
import { screen, Region } from "./nutjs.js";
import { printWindowToBuffer, captureWindowWgc, canCaptureWindowViaWgc } from "./win32.js";
import { nativeEngine } from "./native-engine.js";

export interface CaptureOptions {
  /** Scale longest edge to this value (PNG mode). Default 1280. Ignored when format="webp". */
  maxDimension?: number;
  /** Output format. "webp" = 1:1 pixels + lossy compression; "png" = scaled lossless. Default "png". */
  format?: "png" | "webp";
  /** WebP quality 1-100 (default 60). Only used when format="webp". */
  webpQuality?: number;
  /** Convert to grayscale before encoding. Reduces file size ~50% for text-heavy content. */
  grayscale?: boolean;
  /**
   * Cap the longest edge to this many pixels (WebP mode only).
   * When specified and the image is larger, it is resized and the result includes a scale factor:
   *   screen_x = origin_x + image_x / scale
   * Unspecified = 1:1 pixels (original dotByDot behaviour).
   */
  dotByDotMaxDimension?: number;
  /**
   * Crop the source image before encoding (image-local coordinates).
   * Applied before grayscale and resize. Used by screenshot_background sub-region capture.
   */
  crop?: { x: number; y: number; width: number; height: number };
}

export interface CaptureResult {
  base64: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/webp";
  /**
   * Scale factor applied by dotByDotMaxDimension (output / input, < 1 when downscaled).
   * Undefined means 1:1 — no scale conversion needed.
   * Coordinate formula: screen_x = origin_x + image_x / scale
   */
  scale?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal encoders
// ─────────────────────────────────────────────────────────────────────────────

/** PNG encoder — scales to maxDimension and compresses losslessly. */
async function encodeToBase64(
  rawData: Buffer,
  srcWidth: number,
  srcHeight: number,
  channels: 3 | 4,
  opts: CaptureOptions
): Promise<CaptureResult> {
  let pipeline = sharp(rawData, {
    raw: { width: srcWidth, height: srcHeight, channels },
  });

  if (opts.crop) {
    pipeline = pipeline.extract({
      left: opts.crop.x,
      top: opts.crop.y,
      width: opts.crop.width,
      height: opts.crop.height,
    });
    srcWidth = opts.crop.width;
    srcHeight = opts.crop.height;
  }

  if (opts.grayscale) pipeline = pipeline.grayscale();

  const maxDimension = opts.maxDimension ?? 1280;
  if (Math.max(srcWidth, srcHeight) > maxDimension) {
    pipeline = pipeline.resize({
      width: srcWidth >= srcHeight ? maxDimension : undefined,
      height: srcWidth < srcHeight ? maxDimension : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const pngBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  const meta = await sharp(pngBuffer).metadata();

  return {
    base64: pngBuffer.toString("base64"),
    width: meta.width ?? srcWidth,
    height: meta.height ?? srcHeight,
    mimeType: "image/png",
  };
}

/** WebP encoder — 1:1 pixels (or capped by dotByDotMaxDimension), lossy compression. */
async function encodeToWebP(
  rawData: Buffer,
  srcWidth: number,
  srcHeight: number,
  channels: 3 | 4,
  opts: CaptureOptions
): Promise<CaptureResult> {
  let pipeline = sharp(rawData, {
    raw: { width: srcWidth, height: srcHeight, channels },
  });

  if (opts.crop) {
    pipeline = pipeline.extract({
      left: opts.crop.x,
      top: opts.crop.y,
      width: opts.crop.width,
      height: opts.crop.height,
    });
    srcWidth = opts.crop.width;
    srcHeight = opts.crop.height;
  }

  if (opts.grayscale) pipeline = pipeline.grayscale();

  let outputWidth = srcWidth;
  let outputHeight = srcHeight;
  let scale: number | undefined;

  if (opts.dotByDotMaxDimension && Math.max(srcWidth, srcHeight) > opts.dotByDotMaxDimension) {
    const maxDim = opts.dotByDotMaxDimension;
    const longEdge = Math.max(srcWidth, srcHeight);
    scale = maxDim / longEdge; // < 1, e.g. 1280/1920 = 0.667
    outputWidth = Math.round(srcWidth * scale);
    outputHeight = Math.round(srcHeight * scale);
    pipeline = pipeline.resize({ width: outputWidth, height: outputHeight, withoutEnlargement: true });
  }

  const quality = opts.webpQuality ?? 60;
  const webpBuffer = await pipeline.webp({ quality }).toBuffer();

  return {
    base64: webpBuffer.toString("base64"),
    width: outputWidth,
    height: outputHeight,
    mimeType: "image/webp",
    scale,
  };
}

/** Route to PNG or WebP encoder based on options. */
async function encode(
  rawData: Buffer,
  srcWidth: number,
  srcHeight: number,
  channels: 3 | 4,
  opts: CaptureOptions
): Promise<CaptureResult> {
  if (opts.format === "webp") {
    return encodeToWebP(rawData, srcWidth, srcHeight, channels, opts);
  }
  return encodeToBase64(rawData, srcWidth, srcHeight, channels, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public capture functions
// ─────────────────────────────────────────────────────────────────────────────

/** Capture the full screen (primary) or a specific region. */
export async function captureScreen(
  region?: { x: number; y: number; width: number; height: number },
  optsOrMaxDim: CaptureOptions | number = 1280
): Promise<CaptureResult> {
  const opts: CaptureOptions =
    typeof optsOrMaxDim === "number" ? { maxDimension: optsOrMaxDim } : optsOrMaxDim;

  let image = await screen.grab();

  if (region) {
    const grabRegion = new Region(region.x, region.y, region.width, region.height);
    image = await screen.grabRegion(grabRegion);
  }

  // nut-js returns BGR(A) — convert to RGB(A)
  const rgbImage = await image.toRGB();
  const channels = rgbImage.hasAlphaChannel ? 4 : 3;

  return encode(rgbImage.data, rgbImage.width, rgbImage.height, channels as 3 | 4, opts);
}

/** Capture a specific monitor by its index. */
export async function captureDisplay(
  displayBounds: { x: number; y: number; width: number; height: number },
  optsOrMaxDim: CaptureOptions | number = 1280
): Promise<CaptureResult> {
  return captureScreen(displayBounds, optsOrMaxDim);
}

/**
 * Capture a window using PrintWindow (works even when window is behind others).
 * @param printWindowFlags
 *   2 (default) = PW_RENDERFULLCONTENT — captures GPU/Chrome/WinUI3 correctly
 *   0           = legacy mode, fast but GPU windows may appear black
 *   3           = PW_CLIENTONLY | PW_RENDERFULLCONTENT — client area only
 */
export async function captureWindowBackground(
  hwnd: unknown,
  optsOrMaxDim: CaptureOptions | number = 1280,
  printWindowFlags = 2
): Promise<CaptureResult & { captureBlocked?: boolean }> {
  const opts: CaptureOptions =
    typeof optsOrMaxDim === "number" ? { maxDimension: optsOrMaxDim } : optsOrMaxDim;
  // ADR-027 — for windows DWM is compositing (visible, non-minimised,
  // non-cloaked) prefer WGC: it returns real pixels for GPU-composited /
  // occluded windows that PrintWindow returns black for. Hidden / minimised /
  // cloaked windows fail the D3 gate inside the helper and fall straight to
  // PrintWindow, preserving this entry's "capture hidden/minimised via
  // PrintWindow" contract. WGC only substitutes for full-window full-content
  // (flag 2): fullContent=false → flag 0 (legacy fast opt-out) and client-only
  // requests (PW_CLIENTONLY) stay on PrintWindow (Codex review R1+R2).
  const wgc = wgcMatchesFlags(printWindowFlags) ? await captureWindowRawViaWgc(hwnd) : null;
  if (wgc) {
    // WGC frames pass the blank gate inside captureWindowRawViaWgc (full frame),
    // so a served WGC frame is real content. But when a sub-region is requested
    // the served crop could still be all-black (e.g. a DRM video area inside a
    // non-black window) — re-check the crop so captureBlocked reflects the
    // pixels actually sent (Codex review). With no crop the validated full
    // frame is non-black by construction → false.
    const captureBlocked = opts.crop
      ? isLikelyBlankCapture(wgc.rawPixels, wgc.width, wgc.height, 4, opts.crop).isBlank
      : false;
    const encodedWgc = await encode(wgc.rawPixels, wgc.width, wgc.height, 4, opts);
    return { ...encodedWgc, captureBlocked };
  }
  // Call printWindowToBuffer directly so the original native error (driver
  // failure, DRM-protected surface, etc.) propagates to OCR / SoM callers
  // verbatim. The raw helper that backs the fallback path deliberately
  // converts exceptions into a `null` signal — that shape is wrong for the
  // back-compat entry, which should fail loudly when PrintWindow can't run.
  const { data, width, height } = printWindowToBuffer(hwnd, printWindowFlags);
  // data is already RGBA (converted in win32.ts)
  // ADR-027 R9/AC8 — background mode's rungs are WGC (when eligible) → PrintWindow.
  // If WGC did not serve and this PrintWindow frame is all-black, no rung
  // produced non-black pixels: the result is an unverified black image (either
  // a genuinely-black window OR uncapturable content — DRM / secure desktop /
  // hardware overlay; pixels can't tell them apart). Flag it so the handler
  // surfaces an explicit hedged warning rather than returning a silent black
  // frame. The check is crop-aware (Codex review): when a sub-region is
  // requested it reflects the served crop, not the full window. (Only all-black
  // AND zero-variance qualifies — isLikelyBlankCapture never flags a
  // dark-but-varied editor / video as blank.)
  const captureBlocked = isLikelyBlankCapture(data, width, height, 4, opts.crop).isBlank;
  const encoded = await encode(data, width, height, 4, opts);
  return { ...encoded, captureBlocked };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw capture helpers (PrintWindow + BitBlt fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw PrintWindow capture. Returns null on any failure (exception, missing
 * buffer, zero-size). The null signal is the only definite trigger for
 * fallback in captureWindowRawWithFallback — `null` means we got no image at
 * all, distinct from "we got a legitimately black image".
 */
export function captureWindowRawPrintWindow(
  hwnd: unknown,
  flags = 2,
): { rawPixels: Buffer; width: number; height: number; channels: 4 } | null {
  try {
    const { data, width, height } = printWindowToBuffer(hwnd, flags);
    if (!data || width <= 0 || height <= 0) return null;
    return { rawPixels: data, width, height, channels: 4 };
  } catch {
    return null;
  }
}

/**
 * Conservative blank-capture detector. Returns `isBlank: true` only for an
 * all-black frame with zero variance — a pattern produced by PrintWindow on
 * GPU-only / RDP-occluded windows. Normal images that happen to be all-white
 * (empty Notepad, empty browser tab, blank dialog) MUST NOT be flagged blank
 * here; flagging them would cause silent fallback to BitBlt which on hidden
 * windows would return the wrong window's pixels.
 *
 * Even for all-black we still emit a warning at the caller because terminal
 * windows, dark editors, and video frames can legitimately be all-black.
 *
 * Sampling: walks the buffer with a fixed stride to keep this O(1) per call,
 * regardless of resolution.
 *
 * `crop` (optional, ADR-027 Phase 3 / Codex review): when set, the check is
 * restricted to that sub-rectangle of the buffer — the "pixels actually sent"
 * when the caller requested a region. This is stride-aware (it walks the
 * sub-rect using the full-width row stride), so a black region inside a
 * non-black window is detected. With no `crop` the full buffer is sampled and
 * the result is bit-identical to the original 4-arg form. The crop is clamped
 * to the buffer bounds; an empty clamped crop returns isBlank=false.
 */
export function isLikelyBlankCapture(
  rawPixels: Buffer,
  width: number,
  height: number,
  channels: 3 | 4,
  crop?: { x: number; y: number; width: number; height: number },
): { isBlank: boolean; reason: "printwindow-all-black" | null } {
  if (width <= 0 || height <= 0 || rawPixels.length < channels) {
    return { isBlank: false, reason: null };
  }
  // Region to sample: the full frame, or the requested crop clamped to bounds.
  const rx = crop ? Math.max(0, Math.min(crop.x, width)) : 0;
  const ry = crop ? Math.max(0, Math.min(crop.y, height)) : 0;
  const rw = crop ? Math.min(crop.width, width - rx) : width;
  const rh = crop ? Math.min(crop.height, height - ry) : height;
  if (rw <= 0 || rh <= 0) return { isBlank: false, reason: null };
  const pixelCount = rw * rh;
  // Sample at most ~4096 pixels regardless of frame size (O(1) per call).
  const sampleCount = Math.min(4096, pixelCount);
  const step = Math.max(1, Math.floor(pixelCount / sampleCount));
  // Threshold: average luminance < 2/255. Strict enough to avoid flagging
  // dark-but-not-black UI (dark mode editors with subpixel anti-aliasing).
  const MAX_AVG_LUMA = 2;
  let sumLuma = 0;
  let firstPixelLuma = -1;
  let allSame = true;
  let sampled = 0;
  for (let p = 0; p < pixelCount; p += step) {
    // Map the linear sample index into the (cropped) region, then to the full
    // buffer offset via the real row stride (`width`). With no crop this is
    // exactly `p * channels` (rx=ry=0, rw=width), so behaviour is unchanged.
    const localY = Math.floor(p / rw);
    const localX = p - localY * rw;
    const off = ((ry + localY) * width + (rx + localX)) * channels;
    // RGBA / RGB: take BT.601 luma (R*0.299 + G*0.587 + B*0.114), integer-ish.
    const r = rawPixels[off] ?? 0;
    const g = rawPixels[off + 1] ?? 0;
    const b = rawPixels[off + 2] ?? 0;
    const luma = (r * 299 + g * 587 + b * 114) / 1000;
    sumLuma += luma;
    if (firstPixelLuma < 0) {
      firstPixelLuma = luma;
    } else if (luma !== firstPixelLuma) {
      allSame = false;
    }
    sampled++;
    if (sampled >= sampleCount) break;
  }
  if (sampled === 0) return { isBlank: false, reason: null };
  const avgLuma = sumLuma / sampled;
  // Require BOTH conditions to flag: very low average luminance AND zero
  // variance across samples. This excludes dark-mode editor windows with
  // subtle pixel variation from being treated as blank.
  if (avgLuma < MAX_AVG_LUMA && allSame) {
    return { isBlank: true, reason: "printwindow-all-black" };
  }
  return { isBlank: false, reason: null };
}

export type CaptureSource = "printwindow" | "bitblt-fallback" | "wgc";
export type CaptureFallbackReason = "printwindow-failed" | "printwindow-all-black" | null;

// ADR-027: once a WGC attempt reports the OS doesn't support WGC, skip it for
// the rest of the session rather than paying a futile worker round-trip on
// every eligible capture. Reset between tests via `_resetWgcSupportForTest`.
let wgcUnsupported = false;
/** Test-only: clear the cached "WGC unsupported" flag. */
export function _resetWgcSupportForTest(): void {
  wgcUnsupported = false;
}

// PrintWindow flags: 0 = legacy (fast, GPU-black), 2 = PW_RENDERFULLCONTENT
// (full window, full content), 3 = PW_CLIENTONLY(0x1) | RENDERFULLCONTENT.
// WGC always captures the full window's composited content, so it can only
// substitute for flag 2. Legacy (0 — the explicit fast opt-out / fullContent=
// false) and client-only requests (PW_CLIENTONLY bit set: flags 1/3) are
// honored by PrintWindow, not WGC (Codex review R1 = legacy, R2 = client-only).
const PW_CLIENTONLY = 0x1;
function wgcMatchesFlags(flags: number): boolean {
  return flags !== 0 && (flags & PW_CLIENTONLY) === 0;
}

/**
 * ADR-027 — attempt a WGC capture of `hwnd`, returning raw RGBA (top-down,
 * channels=4) or `null` when WGC is unavailable / ineligible / produced no
 * trustworthy frame, so the caller falls through to the next ladder rung.
 *
 * Eligibility is the D3 gate (`canCaptureWindowViaWgc`: DWM is compositing the
 * window). The WGC frame is run through the SAME blank-capture gate as
 * PrintWindow — an all-black / zero-variance WGC frame (occlusion transition,
 * DRM-protected surface) is rejected so we never return a black image as real
 * (ADR-027 §5). A reject whose reason mentions "unsupported" latches
 * `wgcUnsupported` so subsequent captures skip WGC entirely on this OS.
 */
async function captureWindowRawViaWgc(
  hwnd: unknown,
): Promise<{ rawPixels: Buffer; width: number; height: number; channels: 4 } | null> {
  if (wgcUnsupported) return null;
  if (typeof hwnd !== "bigint" || !canCaptureWindowViaWgc(hwnd)) return null;
  try {
    const { data, width, height } = await captureWindowWgc(hwnd);
    if (!data || width <= 0 || height <= 0) return null;
    if (isLikelyBlankCapture(data, width, height, 4).isBlank) return null;
    return { rawPixels: data, width, height, channels: 4 };
  } catch (e) {
    // Latch ONLY on the OS-level unsupported signal (WgcError::Unsupported →
    // "WGC unsupported on this OS"), not on a transient per-window COM error
    // whose message happens to contain "unsupported" (those rebuild the device
    // engine-side and should keep retrying). Opus review P3.
    const msg = String((e as Error)?.message ?? e).toLowerCase();
    if (msg.includes("wgc unsupported")) wgcUnsupported = true;
    return null;
  }
}

export interface CaptureWindowRawResult {
  rawPixels: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
  source: CaptureSource;
  fallbackReason: CaptureFallbackReason;
  /**
   * ADR-027 R9/AC8 — true when EVERY capture rung (PrintWindow → WGC → BitBlt)
   * produced an all-black / zero-variance frame, so NO rung produced non-black
   * pixels. Pixels alone cannot distinguish a genuinely-black window (a dark
   * terminal, a black / letterboxed video frame, a freshly-launched GPU app)
   * from uncapturable content (DRM-protected video, a secure-desktop / UAC
   * prompt, a hardware-overlay surface) — both yield a uniform black frame.
   * So this is NOT an assertion that the content is protected; it means "the
   * returned image is black and unverified — treat it with low confidence."
   * The ladder is finite (it does not loop); this flags the case where the LAST
   * rung is also blank instead of returning a black image silently. Callers
   * surface an explicit (hedged) warning + a `captureBlocked` hint instead of
   * the misleading "fell back to BitBlt / overlapping windows" text.
   */
  captureBlocked: boolean;
}

/**
 * Window-targeted raw capture with PrintWindow as the primary route and
 * BitBlt-of-window-rect as the fallback. The fallback fires only when:
 *   1. PrintWindow returns no data at all (null / exception / zero-size), or
 *   2. PrintWindow returned an all-black + zero-variance frame.
 *
 * **`windowRect` MUST be the window's full screen rect, not a sub-region.**
 * Both branches return a buffer dimensioned to the window's drawn surface so
 * downstream `opts.crop` (window-local coords) applies uniformly to either
 * source. Passing a sub-region here would silently shift the crop origin on
 * the BitBlt branch and crash sharp's `extract()` when offsets are non-zero.
 *
 * Note on dimension parity: on high-DPI monitors PrintWindow returns the
 * window's drawn surface in device pixels, and `screen.grabRegion` of the
 * same screen rect returns logical pixels — the two branches may therefore
 * differ in dimensions. WGC (ADR-027) is a third source whose `ContentSize`
 * is device-pixel-like (close to PrintWindow) but can still differ from the
 * BitBlt logical-pixel branch. Callers (e.g. `captureAndDiff`) that compare
 * frames across captures must tolerate a one-time `sizeChanged` when the
 * source switches among PrintWindow / WGC / BitBlt for the same window.
 */
export async function captureWindowRawWithFallback(
  hwnd: unknown,
  windowRect: { x: number; y: number; width: number; height: number },
  flags = 2,
): Promise<CaptureWindowRawResult> {
  const raw = captureWindowRawPrintWindow(hwnd, flags);
  // Definite-assignment analysis: every path through this block either
  // assigns fallbackReason or returns, so no initializer is needed (and an
  // initial `null` would be dead code per eslint no-useless-assignment).
  let fallbackReason: CaptureFallbackReason;
  if (!raw) {
    fallbackReason = "printwindow-failed";
  } else {
    const blank = isLikelyBlankCapture(raw.rawPixels, raw.width, raw.height, raw.channels);
    if (!blank.isBlank) {
      return {
        rawPixels: raw.rawPixels,
        width: raw.width,
        height: raw.height,
        channels: raw.channels,
        source: "printwindow",
        fallbackReason: null,
        captureBlocked: false,
      };
    }
    fallbackReason = blank.reason;
  }
  // ADR-027 WGC rescue — before BitBlt, try the DWM composition surface. This
  // is the route for GPU-composited (Chrome/Electron/WinUI3) and occluded
  // windows that PrintWindow blacked out or failed on. Only fires for windows
  // DWM is compositing (D3 gate inside the helper); on an unsupported OS or an
  // ineligible window it returns null and we fall to BitBlt unchanged.
  // `fallbackReason` is preserved to record WHY PrintWindow was abandoned.
  // WGC only substitutes for full-window full-content (flag 2); legacy (0) and
  // client-only (PW_CLIENTONLY) requests fall through to BitBlt unchanged.
  const wgc = wgcMatchesFlags(flags) ? await captureWindowRawViaWgc(hwnd) : null;
  if (wgc) {
    return {
      rawPixels: wgc.rawPixels,
      width: wgc.width,
      height: wgc.height,
      channels: wgc.channels,
      source: "wgc",
      fallbackReason,
      // WGC frames are already run through isLikelyBlankCapture inside
      // captureWindowRawViaWgc — a blank WGC frame returns null and we never
      // reach here, so a served WGC frame is real content (not capture-blocked).
      captureBlocked: false,
    };
  }
  // BitBlt fallback grabs the full window rect, NOT a sub-region. Sub-region
  // crops are applied uniformly at encode time via opts.crop (window-local
  // coordinates) so both source branches share the same crop semantics.
  const grabRegion = new Region(windowRect.x, windowRect.y, windowRect.width, windowRect.height);
  const image = await screen.grabRegion(grabRegion);
  const rgbImage = await image.toRGB();
  const channels = (rgbImage.hasAlphaChannel ? 4 : 3) as 3 | 4;
  // ADR-027 R9/AC8 — BitBlt is the LAST rung. We only reach it because
  // PrintWindow was blank/failed AND WGC did not serve, so if this final frame
  // is ALSO all-black then NO rung produced non-black pixels: the result is an
  // unverified black image (either a genuinely-black window OR uncapturable
  // content — DRM / secure desktop / hardware overlay; pixels can't tell them
  // apart). Flag it so the caller surfaces an explicit hedged warning instead
  // of returning a black image silently. An occluded (non-black) BitBlt of an
  // overlapping window is NOT capture-blocked — it keeps the existing "may show
  // overlapping windows" hint via fallbackReason.
  const captureBlocked = isLikelyBlankCapture(
    rgbImage.data,
    rgbImage.width,
    rgbImage.height,
    channels,
  ).isBlank;
  return {
    rawPixels: rgbImage.data,
    width: rgbImage.width,
    height: rgbImage.height,
    channels,
    source: "bitblt-fallback",
    fallbackReason,
    captureBlocked,
  };
}

/**
 * Encode wrapper for `captureWindowRawWithFallback`. Returns the standard
 * `CaptureResult` plus the capture source / fallback reason for hint reporting.
 *
 * `windowRect` MUST be the window's full screen rect — see the helper docstring.
 * Sub-region capture is expressed via `opts.crop` in window-local coordinates.
 */
export async function captureWindowWithFallback(
  hwnd: unknown,
  windowRect: { x: number; y: number; width: number; height: number },
  optsOrMaxDim: CaptureOptions | number = 1280,
  flags = 2,
): Promise<
  CaptureResult & {
    source: CaptureSource;
    fallbackReason: CaptureFallbackReason;
    captureBlocked: boolean;
  }
> {
  const opts: CaptureOptions =
    typeof optsOrMaxDim === "number" ? { maxDimension: optsOrMaxDim } : optsOrMaxDim;
  const raw = await captureWindowRawWithFallback(hwnd, windowRect, flags);
  const encoded = await encode(raw.rawPixels, raw.width, raw.height, raw.channels, opts);
  // ADR-027 R9/AC8 (Codex review) — captureBlocked must describe the pixels
  // actually sent. When a sub-region is requested, encode() crops to opts.crop,
  // so re-evaluate the blank check over that crop (a black region inside a
  // non-black window — e.g. a DRM video area — must still flag). With no crop
  // the full-buffer result the rung already computed is used unchanged.
  const captureBlocked = opts.crop
    ? isLikelyBlankCapture(raw.rawPixels, raw.width, raw.height, raw.channels, opts.crop).isBlank
    : raw.captureBlocked;
  return {
    ...encoded,
    source: raw.source,
    fallbackReason: raw.fallbackReason,
    captureBlocked,
  };
}

/** Convert a raw RGBA buffer to base64 image. */
export async function bufferToBase64(
  data: Buffer,
  width: number,
  height: number,
  maxDimension = 1280
): Promise<CaptureResult> {
  return encodeToBase64(data, width, height, 4, { maxDimension });
}

/** Encode a cropped region from raw RGBA pixels (for layer diff patches). */
export async function encodeCrop(
  rawData: Buffer,
  srcWidth: number,
  srcHeight: number,
  channels: 3 | 4,
  crop: { x: number; y: number; width: number; height: number },
  webpQuality = 60
): Promise<{ base64: string; mimeType: "image/webp"; width: number; height: number }> {
  const webpBuffer = await sharp(rawData, {
    raw: { width: srcWidth, height: srcHeight, channels },
  })
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .webp({ quality: webpQuality })
    .toBuffer();

  return {
    base64: webpBuffer.toString("base64"),
    mimeType: "image/webp",
    width: crop.width,
    height: crop.height,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SmartScroll image primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a rectangular strip from a raw RGB/RGBA buffer and return raw pixels.
 * First use of the `{data, info}` idiom in this codebase — established here.
 */
export async function extractStripRaw(
  rawRgb: Buffer,
  width: number,
  height: number,
  channels: 3 | 4,
  strip: { left: number; top: number; width: number; height: number }
): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> {
  const result = await sharp(rawRgb, { raw: { width, height, channels } })
    .extract({ left: strip.left, top: strip.top, width: strip.width, height: strip.height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: result.data, info: { width: result.info.width, height: result.info.height, channels: result.info.channels } };
}

/**
 * Compute a 64-bit difference hash (dHash) from a raw RGB/RGBA buffer.
 * Resizes to 9×8 grayscale, then builds 64 bits via row-major horizontal comparison.
 * Returns a bigint where bit=1 means the left pixel is brighter than the right.
 */
export async function dHashFromRaw(
  rawRgb: Buffer,
  width: number,
  height: number,
  channels: 3 | 4
): Promise<bigint> {
  // Rust native path: sync, includes bilinear resize + grayscale (no sharp dependency)
  if (nativeEngine) {
    return nativeEngine.dhashFromRaw(rawRgb, width, height, channels);
  }

  // TS fallback via sharp
  const { data } = await sharp(rawRgb, { raw: { width, height, channels } })
    .grayscale()
    .resize({ width: 9, height: 8, kernel: "cubic", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left  = data[row * 9 + col] ?? 0;
      const right = data[row * 9 + col + 1] ?? 0;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

/** Count differing bits between two 64-bit dHash values (Hamming distance). */
export function hammingDistance(a: bigint, b: bigint): number {
  if (nativeEngine) {
    return nativeEngine.hammingDistance(a, b);
  }
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * Detect the scrollbar thumb position from a narrow vertical strip (rightmost ~16 px).
 * Uses luminance (Y = 0.299R + 0.587G + 0.114B) to find the thumb via RLE.
 * Returns null when no clear thumb is detected (e.g., overlay scrollbars hidden).
 */
export function detectScrollThumbFromStrip(
  stripRgb: Buffer,
  stripW: number,
  stripH: number,
  channels: 3 | 4
): { thumbTop: number; thumbHeight: number; trackHeight: number } | null {
  if (stripH < 10 || stripW < 1) return null;

  // Sample the centre column of the strip for luminance
  const col = Math.floor(stripW / 2);
  const luminance: number[] = [];
  for (let row = 0; row < stripH; row++) {
    const idx = (row * stripW + col) * channels;
    const r = stripRgb[idx] ?? 0;
    const g = stripRgb[idx + 1] ?? 0;
    const b = stripRgb[idx + 2] ?? 0;
    luminance.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
  }

  // Overall track median
  const sorted = [...luminance].sort((a, b) => a - b);
  const trackMedian = sorted[Math.floor(sorted.length / 2)] ?? 128;

  // RLE to find runs whose median deviates from the track median by ≥ 24
  const TOLERANCE = 24;
  const MIN_THUMB_PX = 6;

  let best: { start: number; length: number; median: number } | null = null;
  let runStart = 0;
  let runDir: number = luminance[0]! > trackMedian ? 1 : -1;

  const commitRun = (end: number) => {
    const slice = luminance.slice(runStart, end);
    const sliceSorted = [...slice].sort((a, b) => a - b);
    const sliceMedian = sliceSorted[Math.floor(sliceSorted.length / 2)] ?? 0;
    const diff = Math.abs(sliceMedian - trackMedian);
    if (diff >= TOLERANCE && slice.length >= MIN_THUMB_PX) {
      if (!best || slice.length > best.length) {
        best = { start: runStart, length: slice.length, median: sliceMedian };
      }
    }
  };

  for (let i = 1; i < luminance.length; i++) {
    const dir = (luminance[i] ?? 0) > trackMedian ? 1 : -1;
    if (dir !== runDir) {
      commitRun(i);
      runStart = i;
      runDir = dir;
    }
  }
  commitRun(luminance.length);

  if (best === null) return null;
  const b = best as { start: number; length: number; median: number };
  return { thumbTop: b.start, thumbHeight: b.length, trackHeight: stripH };
}

/** WebP encoder — 1:1 pixels, lossy compression. No resizing. (also exported for layer-buffer) */
export async function encodeToWebPFromRaw(
  rawData: Buffer,
  srcWidth: number,
  srcHeight: number,
  channels: 3 | 4,
  quality: number
): Promise<{ base64: string; mimeType: "image/webp"; width: number; height: number }> {
  const webpBuffer = await sharp(rawData, {
    raw: { width: srcWidth, height: srcHeight, channels },
  })
    .webp({ quality })
    .toBuffer();
  return { base64: webpBuffer.toString("base64"), mimeType: "image/webp", width: srcWidth, height: srcHeight };
}
