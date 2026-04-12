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
