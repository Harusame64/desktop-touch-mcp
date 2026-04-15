import sharp from "sharp";
import { screen, Region } from "./nutjs.js";
import { printWindowToBuffer } from "./win32.js";

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
): Promise<CaptureResult> {
  const opts: CaptureOptions =
    typeof optsOrMaxDim === "number" ? { maxDimension: optsOrMaxDim } : optsOrMaxDim;
  const { data, width, height } = printWindowToBuffer(hwnd, printWindowFlags);
  // data is already RGBA (converted in win32.ts)
  return encode(data, width, height, 4, opts);
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
