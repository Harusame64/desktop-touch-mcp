import sharp from "sharp";
import { screen, Region } from "./nutjs.js";
import { printWindowToBuffer, captureWindowWgc } from "./win32.js";
import { nativeEngine } from "./native-engine.js";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

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
// ─────────────────────────────────────────────────────────────────────────────
// Raw capture helpers (WGC → PrintWindow → BitBlt fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw PrintWindow capture.

// ─────────────────────────────────────────────────────────────────────────────
// Raw capture helpers (WGC → PrintWindow → BitBlt fallback)
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
 */
export function isLikelyBlankCapture(
  rawPixels: Buffer,
  width: number,
  height: number,
  channels: 3 | 4,
): { isBlank: boolean; reason: "printwindow-all-black" | null } {
  if (width <= 0 || height <= 0 || rawPixels.length < channels) {
    return { isBlank: false, reason: null };
  }
  const pixelCount = width * height;
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
    const off = p * channels;
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

export type CaptureSource = "wgc" | "printwindow" | "bitblt-fallback";
export type CaptureFallbackReason = "wgc-failed" | "printwindow-failed" | "printwindow-all-black" | null;

export interface CaptureWindowRawResult {
  rawPixels: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
  source: CaptureSource;
  fallbackReason: CaptureFallbackReason;
}

/**
 * Window-targeted raw capture with WGC (DWM composition surface) as the
 * primary route, then PrintWindow, then BitBlt-of-window-rect as the final
 * fallback. The fallback chain fires when:
 *   1. WGC is unavailable (no D3D11, RDP/headless, pre-1809), or
 *   2. WGC returns no data at all (null / exception / zero-size)
 *   3. PrintWindow returns no data or an all-black + zero-variance frame.
 *
 * **`windowRect` MUST be the window's full screen rect, not a sub-region.**
 * All branches return a buffer dimensioned to the window's drawn surface so
 * downstream `opts.crop` (window-local coords) applies uniformly to either
 * source. Passing a sub-region here would silently shift the crop origin on
 * the BitBlt branch and crash sharp's `extract()` when offsets are non-zero.
 *
 * Note on dimension parity: on high-DPI monitors WGC returns device pixels,
 * PrintWindow returns device pixels, and `screen.grabRegion` of the same
 * screen rect returns logical pixels — the three branches may therefore
 * differ in dimensions. Callers (e.g. `captureAndDiff`) that compare frames
 * across captures must tolerate a one-time `sizeChanged` when the source
 * alternates backends for the same window.
 */
export async function captureWindowRawWithFallback(
  hwnd: unknown,
  windowRect: { x: number; y: number; width: number; height: number },
  flags = 2,
): Promise<CaptureWindowRawResult> {
  // Layer 0: WGC (DWM composition surface, no foreground / WM_PRINT dependency)
  let wgcFailed = false;
  if (typeof hwnd === "bigint") {
    const wgcRaw = captureWindowWgc(hwnd);
    if (wgcRaw) {
      return {
        rawPixels: wgcRaw.data,
        width: wgcRaw.width,
        height: wgcRaw.height,
        channels: 4,
        source: "wgc",
        fallbackReason: null,
      };
    }
    wgcFailed = true;
  }

  // Layer 1: PrintWindow (WM_PRINT)
  const raw = captureWindowRawPrintWindow(hwnd, flags);
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
      };
    }
    fallbackReason = blank.reason;
  }
  // Layer 2: BitBlt screen grab (always works, but captures whatever is on top)
  const grabRegion = new Region(windowRect.x, windowRect.y, windowRect.width, windowRect.height);
  const image = await screen.grabRegion(grabRegion);
  const rgbImage = await image.toRGB();
  const channels = (rgbImage.hasAlphaChannel ? 4 : 3) as 3 | 4;
  return {
    rawPixels: rgbImage.data,
    width: rgbImage.width,
    height: rgbImage.height,
    channels,
    source: "bitblt-fallback",
    fallbackReason: wgcFailed ? "wgc-failed" : fallbackReason,
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
): Promise<CaptureResult & { source: CaptureSource; fallbackReason: CaptureFallbackReason }> {
  const opts: CaptureOptions =
    typeof optsOrMaxDim === "number" ? { maxDimension: optsOrMaxDim } : optsOrMaxDim;
  const raw = await captureWindowRawWithFallback(hwnd, windowRect, flags);
  const encoded = await encode(raw.rawPixels, raw.width, raw.height, raw.channels, opts);
  return { ...encoded, source: raw.source, fallbackReason: raw.fallbackReason };
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

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot disk persistence (Phase 1 — disk-path model)
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveCaptureOpts {
  screenshotsDir: string;
  processName: string;
  windowTitle: string;
  windowUuid: string;
}

export interface SavedCapture {
  ref: string;
  tag: string;
  contentHash: string;
  capturedAt: string;
}

interface WindowIndexScreenshot {
  file: string;
  title: string;
  hash: string;
  at: string;
  width: number;
  height: number;
  size: number;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/webp": ".webp",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

function mimeExtension(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? ".webp";
}

function sanitizeTitle(title: string): string {
  return title.replace(/[\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) || "untitled";
}

function contentHashFromBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function updateTagsFile(tagsPath: string, tag: string, ref: string): void {
  let tags: Record<string, string> = {};
  try { tags = JSON.parse(fs.readFileSync(tagsPath, "utf-8")); } catch { /* empty */ }
  tags[tag] = ref;
  tags["latest"] = ref;
  atomicWriteJson(tagsPath, tags);
}

function writeGitignoreOnFirstUse(screenshotsDir: string): void {
  const p = path.join(screenshotsDir, ".gitignore");
  if (!fs.existsSync(p)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    fs.writeFileSync(p, "*\n");
  }
}

export async function saveCapture(
  encodedBuffer: Buffer,
  meta: { width: number; height: number; mimeType: string },
  opts: SaveCaptureOpts,
): Promise<SavedCapture> {
  const tag = path.basename(opts.processName, ".exe").toLowerCase();
  const capturedAt = new Date().toISOString();
  const timestamp = capturedAt.replace(/[-:T.]/g, "").slice(0, 15);
  const sanitized = sanitizeTitle(opts.windowTitle);
  const contentHash = contentHashFromBuffer(encodedBuffer);
  const windowDir = path.join(opts.screenshotsDir, opts.processName, opts.windowUuid);

  // Dedup: scan for existing file with same contentHash
  const ext = mimeExtension(meta.mimeType);
  let ref: string;
  let existingMatch: string | undefined;
  try {
    const files = fs.readdirSync(windowDir);
    existingMatch = files.find((f) => f.endsWith("_" + contentHash + ext));
  } catch {
    // windowDir doesn't exist yet — first capture for this window
  }

  if (existingMatch) {
    ref = path.join(windowDir, existingMatch);
  } else {
    fs.mkdirSync(windowDir, { recursive: true });
    const filename = `${timestamp}_${sanitized}_${contentHash}${ext}`;
    ref = path.join(windowDir, filename);
    fs.writeFileSync(ref, encodedBuffer);
  }

  // Write .gitignore on first directory creation
  writeGitignoreOnFirstUse(opts.screenshotsDir);

  // Update window-level _index.json
  const windowIndexPath = path.join(windowDir, "_index.json");
  let windowIndex: { windowUuid: string; screenshots: WindowIndexScreenshot[] };
  try { windowIndex = JSON.parse(fs.readFileSync(windowIndexPath, "utf-8")); } catch {
    windowIndex = { windowUuid: opts.windowUuid, screenshots: [] };
  }
  windowIndex.screenshots.push({
    file: path.basename(ref),
    title: opts.windowTitle,
    hash: contentHash,
    at: capturedAt,
    width: meta.width,
    height: meta.height,
    size: encodedBuffer.length,
  });
  atomicWriteJson(windowIndexPath, windowIndex);

  // Update process-level _index.json
  const processDir = path.join(opts.screenshotsDir, opts.processName);
  const processIndexPath = path.join(processDir, "_index.json");
  let processIndex: Array<{ windowUuid: string; firstSeen: string; lastSeen: string; processName: string; titleHistory: Array<{ title: string; at: string }>; screenshotCount: number }>;
  try { processIndex = JSON.parse(fs.readFileSync(processIndexPath, "utf-8")); } catch {
    processIndex = [];
  }
  const now = capturedAt;
  const pEntry = processIndex.find((e) => e.windowUuid === opts.windowUuid);
  if (pEntry) {
    pEntry.lastSeen = now;
    pEntry.screenshotCount++;
    pEntry.titleHistory.push({ title: opts.windowTitle, at: now });
  } else {
    processIndex.push({
      windowUuid: opts.windowUuid,
      firstSeen: now,
      lastSeen: now,
      processName: opts.processName,
      titleHistory: [{ title: opts.windowTitle, at: now }],
      screenshotCount: 1,
    });
  }
  atomicWriteJson(processIndexPath, processIndex);

  // Update global _tags.json
  updateTagsFile(path.join(opts.screenshotsDir, "_tags.json"), tag, ref);

  return { ref, tag, contentHash, capturedAt };
}
