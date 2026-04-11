import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { screen, keyboard, mouse, getWindows, Region } from "../engine/nutjs.js";
import { getWindowTitleW } from "../engine/win32.js";
import { parseKeys } from "../utils/key-map.js";
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

/**
 * Check if two frames are identical by comparing a strip in the middle.
 * Using the middle avoids fixed headers/footers.
 */
function framesIdentical(a: RawFrame, b: RawFrame, direction: "down" | "right"): boolean {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return false;
  const { width, height, channels } = a;

  if (direction === "down") {
    // Compare 20 horizontal rows at ~40% height
    const rowBytes = width * channels;
    const startRow = Math.floor(height * 0.4);
    const startOffset = startRow * rowBytes;
    const endOffset = startOffset + 20 * rowBytes;
    return Buffer.compare(a.data.subarray(startOffset, endOffset), b.data.subarray(startOffset, endOffset)) === 0;
  } else {
    // Compare 10 vertical columns at ~40% width
    const startCol = Math.floor(width * 0.4);
    const sa = extractVerticalStrip(a.data, width, height, channels, startCol, 10);
    const sb = extractVerticalStrip(b.data, width, height, channels, startCol, 10);
    return Buffer.compare(sa, sb) === 0;
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

/**
 * Detect vertical overlap between consecutive frames.
 * Takes a reference strip near the bottom of prevFrame (92%), searches the full height of currFrame.
 * Returns the number of NEW rows to append from the bottom of currFrame, or null on failure.
 *
 * Why 92%: Page Down scrolls ~90% of the viewport. Content near the bottom of prevFrame
 * is the only region guaranteed to still be visible near the top of currFrame.
 * Searching 80% (old value) placed the strip in content that scrolls off-screen entirely.
 *
 * Math: strip at row S in prevFrame == strip at row M in currFrame
 *   → scroll amount = S - M  (rows of new content = bottom S-M rows of currFrame)
 */
function findNewRows(prevFrame: RawFrame, currFrame: RawFrame): number | null {
  const { width, height, channels } = prevFrame;
  if (currFrame.width !== width || currFrame.height !== height) return null;

  const rowBytes = width * channels;
  const STRIP_ROWS = 30;                          // 30 rows: large enough to avoid false positives
  const stripStart = Math.floor(height * 0.92);   // near bottom of prevFrame
  const stripOffset = stripStart * rowBytes;
  const strip = prevFrame.data.subarray(stripOffset, stripOffset + STRIP_ROWS * rowBytes);

  const searchEnd = height - STRIP_ROWS;          // search the entire currFrame
  for (let row = 0; row <= searchEnd; row++) {
    const offset = row * rowBytes;
    const candidate = currFrame.data.subarray(offset, offset + STRIP_ROWS * rowBytes);
    if (Buffer.compare(strip, candidate) === 0) {
      const scrollAmount = stripStart - row;
      return scrollAmount > 0 ? scrollAmount : null;
    }
  }
  return null;
}

/**
 * Detect horizontal overlap between consecutive frames.
 * Takes a reference strip at 80% of prevFrame's width, searches in the left 60% of currFrame.
 * Returns the number of NEW columns to append from the right of currFrame, or null on failure.
 */
function findNewColumns(prevFrame: RawFrame, currFrame: RawFrame): number | null {
  const { width, height, channels } = prevFrame;
  if (currFrame.width !== width || currFrame.height !== height) return null;

  const STRIP_COLS = 10;
  const stripStart = Math.floor(width * 0.80);
  const prevStrip = extractVerticalStrip(prevFrame.data, width, height, channels, stripStart, STRIP_COLS);

  const searchEnd = Math.floor(width * 0.60) - STRIP_COLS;
  for (let col = 0; col <= searchEnd; col++) {
    const currStrip = extractVerticalStrip(currFrame.data, width, height, channels, col, STRIP_COLS);
    if (Buffer.compare(prevStrip, currStrip) === 0) {
      const scrollAmount = stripStart - col;
      return scrollAmount > 0 ? scrollAmount : null;
    }
  }
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

    for (let i = 0; i <= maxScrolls; i++) {
      const frame = await captureRawRegion(targetRegion);

      // Check if we've reached the end (identical to previous frame)
      if (frames.length > 0 && framesIdentical(frames[frames.length - 1]!, frame, direction)) {
        break;
      }

      frames.push(frame);

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

    if (direction === "down") {
      const parts: { data: Buffer; rowOffset: number; numRows: number }[] = [
        { data: firstFrame.data, rowOffset: 0, numRows: height },
      ];
      let totalHeight = height;

      for (let i = 1; i < frames.length; i++) {
        const newRows = findNewRows(frames[i - 1]!, frames[i]!);
        if (newRows === null) {
          warnings.push(`Frame ${i}: overlap detection failed, appended in full`);
          parts.push({ data: frames[i]!.data, rowOffset: 0, numRows: height });
          totalHeight += height;
        } else {
          const skipRows = height - newRows;
          parts.push({ data: frames[i]!.data, rowOffset: skipRows, numRows: newRows });
          totalHeight += newRows;
        }
      }

      stitchedBuffer = stitchVertical(parts, width, totalHeight, channels);
      stitchedWidth = width;
      stitchedHeight = totalHeight;
    } else {
      const colRanges: { start: number; count: number }[] = [{ start: 0, count: width }];
      let totalWidth = width;

      for (let i = 1; i < frames.length; i++) {
        const newCols = findNewColumns(frames[i - 1]!, frames[i]!);
        if (newCols === null) {
          warnings.push(`Frame ${i}: horizontal overlap detection failed, appended in full`);
          colRanges.push({ start: 0, count: width });
          totalWidth += width;
        } else {
          colRanges.push({ start: width - newCols, count: newCols });
          totalWidth += newCols;
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

    const pngBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
    const pngMeta = await sharp(pngBuffer).metadata();
    const outW = pngMeta.width ?? stitchedWidth;
    const outH = pngMeta.height ?? stitchedHeight;

    const truncated = frames.length > maxScrolls;
    const summary = {
      ok: true,
      frames: frames.length,
      stitchedSize: `${outW}x${outH}`,
      direction,
      ...(truncated ? { warning: "maxScrolls reached, image may be truncated" } : {}),
      ...(warnings.length > 0 ? { overlapWarnings: warnings } : {}),
    };

    return {
      content: [
        { type: "image" as const, data: pngBuffer.toString("base64"), mimeType: "image/png" as const },
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
    [
      "Scroll through a window from top to bottom (or left to right) and stitch all frames into a single image.",
      "",
      "The tool focuses the target window, scrolls to the start (Ctrl+Home), then repeatedly presses Page Down",
      "(or scrolls right for direction='right') and captures each frame. Consecutive frames are stitched by detecting",
      "pixel overlap so there are no duplicate seams. Stops when the end is reached (identical frames) or maxScrolls is hit.",
      "",
      "Useful for capturing full-length webpages in Chrome, long documents, or any scrollable UI.",
      "Tip: increase scrollDelayMs for pages with animations or lazy-loaded content.",
    ].join("\n"),
    scrollCaptureSchema,
    scrollCaptureHandler
  );
}
