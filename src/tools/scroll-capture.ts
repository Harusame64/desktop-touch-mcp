import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { screen, keyboard, mouse, getWindows, Region } from "../engine/nutjs.js";
import { getWindowTitleW } from "../engine/win32.js";
import { parseKeys } from "../utils/key-map.js";
import { buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";

// Horizontal mouse scroll units per step (matches nut-js scroll granularity)
const H_SCROLL_STEPS = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const scrollCaptureSchema = {
  windowTitle: z
    .string()
    .describe("Partial title of the window to capture (case-insensitive match)"),
  direction: z
    .enum(["down", "right"])
    .default("down")
    .describe(
      "Scroll direction: 'down' (vertical, uses Page Down key) or 'right' (horizontal, uses mouse scroll). Default 'down'."
    ),
  maxScrolls: z
    .coerce.number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe("Maximum scroll iterations before stopping (default 10, max 30)"),
  scrollDelayMs: z
    .coerce.number()
    .int()
    .min(100)
    .max(3000)
    .default(400)
    .describe(
      "Milliseconds to wait after each scroll for rendering to settle (default 400). Increase for slow/animated pages."
    ),
  maxWidth: z
    .coerce.number()
    .int()
    .positive()
    .default(1280)
    .describe(
      "Max size of the short edge of the final image (default 1280). " +
      "For 'down': caps the image width; height is unconstrained. " +
      "For 'right': caps the image height; width is unconstrained."
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawFrame {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function captureRawRegion(
  region: { x: number; y: number; width: number; height: number }
): Promise<RawFrame> {
  const grabRegion = new Region(region.x, region.y, region.width, region.height);
  const image = await screen.grabRegion(grabRegion);
  const rgb = await image.toRGB();
  const channels = (rgb.hasAlphaChannel ? 4 : 3) as 3 | 4;
  return { data: Buffer.from(rgb.data), width: rgb.width, height: rgb.height, channels };
}

async function pressAndRelease(keyCombo: string): Promise<void> {
  const keys = parseKeys(keyCombo);
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// MAE threshold for overlap detection (per channel, 0–255).
// Allows ~3% pixel difference to tolerate subpixel rendering, ads, lazy-load jitter.
const MAE_THRESHOLD = 8;

// MAE threshold for identical-frame detection (stricter — page-end check).
const FRAMES_IDENTICAL_MAE = 4;

// Strip dimensions for overlap detection.
// Defined once here to avoid silent drift between findNewRows and the handler.
const OVERLAP_STRIP_ROWS = 16;
const OVERLAP_STRIP_COLS = 10;

// Reference strip position within prevFrame (as a fraction of the axis length).
// Must be high enough that the strip survives a ~90% Page Down scroll:
//   expectedRow = STRIP_ANCHOR − 0.9 = 0.05  (5% from top of currFrame)
// With searchWindow=±10%, the effective window is [0, 0.15] — giving ample room
// even if Chrome scrolls slightly more than 90%.
const STRIP_ANCHOR = 0.95;

/**
 * Compute mean absolute error per byte between two equal-length buffers.
 * Returns a value in [0, 255].
 */
function computeMAE(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += Math.abs(a[i]! - b[i]!);
  }
  return sum / len;
}

/**
 * Check if two frames are "identical" (page-end detection).
 *
 * Compares strips at TWO positions (40% and 70%) using MAE — both must be within
 * FRAMES_IDENTICAL_MAE. Dual-point comparison prevents false positives from
 * repeating-pattern UIs (e.g. review lists where one band happens to match the
 * next scroll position by coincidence). 70% typically shows footer / "related
 * products", which differs structurally from the mid-page content at 40%.
 *
 * Offsets are clamped so the strip never reads past the frame boundary.
 */
function framesIdentical(a: RawFrame, b: RawFrame, direction: "down" | "right"): boolean {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return false;
  const { width, height, channels } = a;

  if (direction === "down") {
    const rowBytes = width * channels;
    const ROWS = 20;
    for (const frac of [0.4, 0.7]) {
      const startRow = Math.min(Math.floor(height * frac), height - ROWS);
      const off = startRow * rowBytes;
      if (computeMAE(a.data.subarray(off, off + ROWS * rowBytes), b.data.subarray(off, off + ROWS * rowBytes)) > FRAMES_IDENTICAL_MAE) {
        return false;
      }
    }
    return true;
  } else {
    const COLS = 10;
    for (const frac of [0.4, 0.7]) {
      const col = Math.min(Math.floor(width * frac), width - COLS);
      const sa = extractVerticalStrip(a.data, width, height, channels, col, COLS);
      const sb = extractVerticalStrip(b.data, width, height, channels, col, COLS);
      if (computeMAE(sa, sb) > FRAMES_IDENTICAL_MAE) return false;
    }
    return true;
  }
}

/**
 * Extract a contiguous vertical strip of `numCols` columns starting at `colStart`.
 * Returns a buffer of size: height × numCols × channels
 */
function extractVerticalStrip(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  colStart: number,
  numCols: number
): Buffer {
  const strip = Buffer.alloc(height * numCols * channels);
  for (let row = 0; row < height; row++) {
    const srcOffset = (row * width + colStart) * channels;
    const dstOffset = row * numCols * channels;
    data.copy(strip, dstOffset, srcOffset, srcOffset + numCols * channels);
  }
  return strip;
}

interface OverlapResult {
  count: number;      // new rows (vertical) or columns (horizontal) to append
  estimated: boolean; // true = MAE threshold not met, fell back to ~90% estimate
}

/**
 * Detect vertical overlap between consecutive frames.
 *
 * Strategy (D + A hybrid):
 *   1. Take a OVERLAP_STRIP_ROWS-row reference strip at STRIP_ANCHOR (95%) of prevFrame.
 *      At ~90% scroll this lands at ≈5% from the top of currFrame, giving a ±10%
 *      search window that fits cleanly in [0, 0.15h] without excessive clipping.
 *   2. Search only within expectedRow ± 10% instead of the full frame height.
 *      This avoids false matches on fixed headers/footers and cuts CPU work.
 *   3. Pick the row with the lowest MAE. Accept if MAE ≤ MAE_THRESHOLD (≈3% difference).
 *   4. If no row meets the threshold, fall back to expectedScroll (~90% of height).
 *      estimated=true tells the caller to log a warning.
 *
 * Math: strip at row S in prevFrame == strip at row M in currFrame
 *   → scroll amount = S − M  (new rows = bottom `scrollAmount` rows of currFrame)
 *
 * Returns null only when even the fallback is unusable (degenerate frame dimensions).
 */
function findNewRows(prevFrame: RawFrame, currFrame: RawFrame): OverlapResult | null {
  const { width, height, channels } = prevFrame;
  if (currFrame.width !== width || currFrame.height !== height) return null;

  const rowBytes = width * channels;
  const stripStart = Math.floor(height * STRIP_ANCHOR);
  const strip = prevFrame.data.subarray(stripStart * rowBytes, (stripStart + OVERLAP_STRIP_ROWS) * rowBytes);

  const expectedScroll = Math.round(height * 0.9);
  const expectedRow    = stripStart - expectedScroll;   // ≈ 5% from top
  const searchWindow   = Math.round(height * 0.10);

  const searchStart = Math.max(0, expectedRow - searchWindow);
  const searchEnd   = Math.min(height - OVERLAP_STRIP_ROWS, expectedRow + searchWindow);

  let bestRow = -1;
  let bestMAE = Infinity;

  for (let row = searchStart; row <= searchEnd; row++) {
    const candidate = currFrame.data.subarray(row * rowBytes, (row + OVERLAP_STRIP_ROWS) * rowBytes);
    const mae = computeMAE(strip, candidate);
    if (mae < bestMAE) {
      bestMAE = mae;
      bestRow = row;
    }
  }

  if (bestMAE <= MAE_THRESHOLD) {
    const scrollAmount = stripStart - bestRow;
    if (scrollAmount > 0) return { count: scrollAmount, estimated: false };
  }

  // Fallback: MAE threshold not met — use estimated scroll amount.
  if (expectedScroll > 0) return { count: expectedScroll, estimated: true };
  return null;
}

/**
 * Detect horizontal overlap between consecutive frames.
 * Mirror of findNewRows for the horizontal axis.
 * Strip is a vertical slice (height × OVERLAP_STRIP_COLS) at STRIP_ANCHOR of prevFrame's width.
 * Searches expectedCol ± 10% in currFrame. Returns OverlapResult or null.
 */
function findNewColumns(prevFrame: RawFrame, currFrame: RawFrame): OverlapResult | null {
  const { width, height, channels } = prevFrame;
  if (currFrame.width !== width || currFrame.height !== height) return null;

  const stripStart = Math.floor(width * STRIP_ANCHOR);
  const prevStrip  = extractVerticalStrip(prevFrame.data, width, height, channels, stripStart, OVERLAP_STRIP_COLS);

  const expectedScroll = Math.round(width * 0.9);
  const expectedCol    = stripStart - expectedScroll;   // ≈ 5% from left
  const searchWindow   = Math.round(width * 0.10);

  const searchStart = Math.max(0, expectedCol - searchWindow);
  const searchEnd   = Math.min(width - OVERLAP_STRIP_COLS, expectedCol + searchWindow);

  let bestCol = -1;
  let bestMAE = Infinity;

  for (let col = searchStart; col <= searchEnd; col++) {
    const currStrip = extractVerticalStrip(currFrame.data, width, height, channels, col, OVERLAP_STRIP_COLS);
    const mae = computeMAE(prevStrip, currStrip);
    if (mae < bestMAE) {
      bestMAE = mae;
      bestCol = col;
    }
  }

  if (bestMAE <= MAE_THRESHOLD) {
    const scrollAmount = stripStart - bestCol;
    if (scrollAmount > 0) return { count: scrollAmount, estimated: false };
  }

  if (expectedScroll > 0) return { count: expectedScroll, estimated: true };
  return null;
}

/**
 * Stitch frames vertically.
 * Each part specifies which rows to copy from its frame.
 */
function stitchVertical(
  parts: { data: Buffer; rowOffset: number; numRows: number }[],
  width: number,
  totalHeight: number,
  channels: number
): Buffer {
  const rowBytes = width * channels;
  const result = Buffer.alloc(totalHeight * rowBytes);
  let destOffset = 0;
  for (const part of parts) {
    const srcStart = part.rowOffset * rowBytes;
    const copyLen = part.numRows * rowBytes;
    part.data.copy(result, destOffset, srcStart, srcStart + copyLen);
    destOffset += copyLen;
  }
  return result;
}

/**
 * Stitch frames horizontally.
 * Each part specifies which column range to copy from its frame.
 * Builds the result row by row.
 */
function stitchHorizontal(
  frames: RawFrame[],
  colRanges: { start: number; count: number }[],
  totalWidth: number,
  height: number,
  channels: number
): Buffer {
  const result = Buffer.alloc(totalWidth * height * channels);
  for (let row = 0; row < height; row++) {
    let destCol = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      const range = colRanges[fi]!;
      const srcOffset = (row * frame.width + range.start) * channels;
      const dstOffset = (row * totalWidth + destCol) * channels;
      const copyLen = range.count * channels;
      frame.data.copy(result, dstOffset, srcOffset, srcOffset + copyLen);
      destCol += range.count;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const scrollCaptureHandler = async ({
  windowTitle,
  direction,
  maxScrolls,
  scrollDelayMs,
  maxWidth,
}: {
  windowTitle: string;
  direction: "down" | "right";
  maxScrolls: number;
  scrollDelayMs: number;
  maxWidth: number;
}): Promise<ToolResult> => {
  try {
    // ── Phase A: Find and focus the target window ──────────────────────────
    const windows = await getWindows();
    const query = windowTitle.toLowerCase();
    let targetRegion: { x: number; y: number; width: number; height: number } | null = null;

    for (const win of windows) {
      try {
        const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
        const title = hwnd ? getWindowTitleW(hwnd) : await win.title;
        if (!title.toLowerCase().includes(query)) continue;
        const reg = await win.region;
        if (reg.width < 100 || reg.height < 100) continue;
        await win.focus();
        targetRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
        break;
      } catch { /* skip */ }
    }

    if (!targetRegion) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `No window found matching: "${windowTitle}"` }),
        }],
      };
    }

    // Scroll to start position (Ctrl+Home → top-left in most apps)
    await sleep(300);
    await pressAndRelease("ctrl+home");
    await sleep(scrollDelayMs);

    // ── Phase B: Capture loop ──────────────────────────────────────────────
    const frames: RawFrame[] = [];
    const warnings: string[] = [];
    let identicalStreak = 0; // consecutive identical-frame count; break only at 2

    for (let i = 0; i <= maxScrolls; i++) {
      const frame = await captureRawRegion(targetRegion);

      // Page-end detection: require 2 consecutive identical frames to avoid
      // false positives from repeating-pattern UIs (e.g. review sections).
      if (frames.length > 0 && framesIdentical(frames[frames.length - 1]!, frame, direction)) {
        identicalStreak++;
        if (identicalStreak >= 2) {
          // Remove the streak=1 frame that was tentatively pushed last iteration —
          // it's near-duplicate content and would cause stitch artifacts if kept.
          frames.pop();
          break;
        }
        // 1st hit: push tentatively so next comparison uses the latest snapshot.
        // Will be popped above if streak=2 is confirmed.
        frames.push(frame);
      } else {
        identicalStreak = 0;
        frames.push(frame);
      }

      if (i < maxScrolls) {
        if (direction === "down") {
          await pressAndRelease("pagedown");
        } else {
          await mouse.scrollRight(H_SCROLL_STEPS);
        }
        await sleep(scrollDelayMs);
      }
    }

    if (frames.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "No frames captured" }) }],
      };
    }

    // ── Phase C & D: Overlap detection + stitching ─────────────────────────
    const firstFrame = frames[0]!;
    const { width, height, channels } = firstFrame;

    let stitchedBuffer: Buffer;
    let stitchedWidth: number;
    let stitchedHeight: number;

    // Track overlap-detection outcomes without alarming the caller.
    // Exact MAE match is best-effort; estimated fallback is a normal code path
    // for dynamic pages (sticky headers, lazy-loaded images, repeating patterns).
    let exactMatchCount = 0;
    let estimatedCount = 0;
    let failedCount = 0;

    if (direction === "down") {
      const parts: { data: Buffer; rowOffset: number; numRows: number }[] = [
        { data: firstFrame.data, rowOffset: 0, numRows: height },
      ];
      let totalHeight = height;

      for (let i = 1; i < frames.length; i++) {
        const result = findNewRows(frames[i - 1]!, frames[i]!);

        if (result === null) {
          failedCount++;
          warnings.push(`Frame ${i}: overlap detection failed, appended in full`);
          parts.push({ data: frames[i]!.data, rowOffset: 0, numRows: height });
          totalHeight += height;
        } else {
          if (result.estimated) estimatedCount++;
          else exactMatchCount++;
          const skipRows = height - result.count;
          parts.push({ data: frames[i]!.data, rowOffset: skipRows, numRows: result.count });
          totalHeight += result.count;
        }
      }

      stitchedBuffer = stitchVertical(parts, width, totalHeight, channels);
      stitchedWidth = width;
      stitchedHeight = totalHeight;
    } else {
      const colRanges: { start: number; count: number }[] = [{ start: 0, count: width }];
      let totalWidth = width;

      for (let i = 1; i < frames.length; i++) {
        const result = findNewColumns(frames[i - 1]!, frames[i]!);
        if (result === null) {
          failedCount++;
          warnings.push(`Frame ${i}: horizontal overlap detection failed, appended in full`);
          colRanges.push({ start: 0, count: width });
          totalWidth += width;
        } else {
          if (result.estimated) estimatedCount++;
          else exactMatchCount++;
          colRanges.push({ start: width - result.count, count: result.count });
          totalWidth += result.count;
        }
      }

      stitchedBuffer = stitchHorizontal(frames, colRanges, totalWidth, height, channels);
      stitchedWidth = totalWidth;
      stitchedHeight = height;
    }

    // ── Phase E: Encode ─────────────────────────────────────────────────────
    let pipeline = sharp(stitchedBuffer, {
      raw: { width: stitchedWidth, height: stitchedHeight, channels },
    });

    // Cap the short edge to maxWidth so the image remains readable
    if (direction === "down" && stitchedWidth > maxWidth) {
      pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
    } else if (direction === "right" && stitchedHeight > maxWidth) {
      pipeline = pipeline.resize({ height: maxWidth, withoutEnlargement: true });
    }

    // ── 1MB guard ─────────────────────────────────────────────────────────────
    // MCP base64 encodes binary: 1 raw byte → ~1.33 base64 chars.
    // 700KB raw  → ~933KB base64, safely within the 1MB message envelope limit.
    const MCP_RAW_LIMIT = 700_000;

    let imageBuffer: Buffer;
    let mimeType: "image/png" | "image/webp" = "image/png";
    let sizeReduced: string | undefined;

    const pngBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();

    if (pngBuffer.length <= MCP_RAW_LIMIT) {
      imageBuffer = pngBuffer;
    } else {
      // Helper: rebuild the resize pipeline from the raw stitched buffer.
      const rawPipeline = () => {
        let p = sharp(stitchedBuffer, {
          raw: { width: stitchedWidth, height: stitchedHeight, channels },
        });
        if (direction === "down" && stitchedWidth > maxWidth) {
          p = p.resize({ width: maxWidth, withoutEnlargement: true });
        } else if (direction === "right" && stitchedHeight > maxWidth) {
          p = p.resize({ height: maxWidth, withoutEnlargement: true });
        }
        return p;
      };

      // Try WebP at decreasing quality levels first.
      let resolved = false;
      for (const q of [70, 55, 40] as const) {
        const buf = await rawPipeline().webp({ quality: q }).toBuffer();
        if (buf.length <= MCP_RAW_LIMIT) {
          imageBuffer = buf;
          mimeType = "image/webp";
          sizeReduced = `webp_q${q}`;
          resolved = true;
          break;
        }
      }

      // If still too large, iteratively downscale (×0.75 per pass, up to 3 passes).
      if (!resolved) {
        const pngLen = pngBuffer.length;
        let scale = Math.sqrt(MCP_RAW_LIMIT / pngLen) * 0.85;
        for (let attempt = 0; attempt < 3; attempt++) {
          const targetW = Math.max(1, Math.round(stitchedWidth * scale));
          const buf = await rawPipeline()
            .resize({ width: targetW, withoutEnlargement: false })
            .webp({ quality: 40 })
            .toBuffer();
          if (buf.length <= MCP_RAW_LIMIT) {
            imageBuffer = buf;
            mimeType = "image/webp";
            const meta = await sharp(buf).metadata();
            sizeReduced = `auto_downscaled_${meta.width ?? targetW}px`;
            resolved = true;
            break;
          }
          scale *= 0.75;
        }

        // Final fallback: extreme downscale + lowest quality — always fits.
        if (!resolved) {
          const targetW = Math.max(1, Math.round(stitchedWidth * 0.25));
          const buf = await rawPipeline()
            .resize({ width: targetW, withoutEnlargement: false })
            .webp({ quality: 30 })
            .toBuffer();
          imageBuffer = buf;
          mimeType = "image/webp";
          const meta = await sharp(buf).metadata();
          sizeReduced = `forced_fallback_${meta.width ?? targetW}px`;
        }
      }
    }

    const outMeta = await sharp(imageBuffer!).metadata();
    const outW = outMeta.width ?? stitchedWidth;
    const outH = outMeta.height ?? stitchedHeight;

    const truncated = frames.length > maxScrolls;
    const stitchTotal = exactMatchCount + estimatedCount + failedCount;
    const overlapMode =
      failedCount > 0 ? "mixed-with-failures" :
      exactMatchCount === 0 && estimatedCount > 0 ? "estimated" :
      estimatedCount === 0 ? "exact" :
      "mixed";
    const summary = {
      ok: true,
      frames: frames.length,
      stitchedSize: `${outW}x${outH}`,
      direction,
      overlapMode,
      overlapStats: {
        exact: exactMatchCount,
        estimated: estimatedCount,
        failed: failedCount,
        total: stitchTotal,
      },
      ...(truncated ? { warning: "maxScrolls reached, image may be truncated" } : {}),
      ...(failedCount > 0 ? { overlapWarnings: warnings.filter(w => w.includes("failed")) } : {}),
      ...(sizeReduced ? { sizeReduced, tip: "Reduce maxScrolls or add grayscale=true for smaller output." } : {}),
    };

    return {
      content: [
        { type: "image" as const, data: imageBuffer!.toString("base64"), mimeType: mimeType as "image/png" | "image/webp" },
        { type: "text" as const, text: JSON.stringify(summary, null, 2) },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `scroll_capture failed: ${String(err)}` }],
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerScrollCaptureTools(server: McpServer): void {
  server.tool(
    "scroll_capture",
    buildDesc({
      purpose: "Scroll a window top-to-bottom (or left-to-right) and stitch all frames into one image — for full-length webpages or documents that exceed a single screenshot.",
      details: "Output is capped at ~700KB raw (MCP base64 encoding inflates to ~933KB, approaching the 1MB message limit); when sizeReduced=true appears in the response, iterative WebP downscale was applied (up to 3 passes at 0.75× each) — reduce maxScrolls or add grayscale=true to avoid truncation. Focuses the target window, scrolls to Ctrl+Home, then captures frames via Page Down until identical consecutive frames are detected or maxScrolls is reached. Pixel-overlap detection eliminates seam duplication; check response overlapMode — 'mixed-with-failures' means some seams may have duplicate rows.",
      prefer: "Use only for content too long to fit one screenshot. Prefer screenshot(detail='text') for interactive UIs — scroll_capture returns an image, not clickable elements.",
      caveats: "When sizeReduced=true, stitched image pixels do NOT match screen coords — use for reading only, not for mouse_click. When overlapMode='mixed-with-failures', expect occasional duplicate content rows near frame boundaries. Increase scrollDelayMs for pages with animations or lazy-loaded images.",
    }),
    scrollCaptureSchema,
    scrollCaptureHandler
  );
}
