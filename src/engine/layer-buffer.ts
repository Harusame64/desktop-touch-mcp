/**
 * layer-buffer.ts
 *
 * Window-layer frame buffer for diff-based screenshot mode.
 * Treats the virtual desktop as a compositor: each window is a layer.
 * Only changed layers are re-sent on subsequent captures (MPEG P-frame style).
 */

import { screen, Region } from "./nutjs.js";
import { encodeToWebPFromRaw } from "./image.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowInfo {
  hwnd: bigint;
  title: string;
  region: { x: number; y: number; width: number; height: number };
  zOrder: number;
}

interface WindowLayer {
  title: string;
  hwnd: bigint;
  region: { x: number; y: number; width: number; height: number };
  zOrder: number;
  rawPixels: Buffer;  // RGBA or RGB, native resolution
  channels: 3 | 4;
  width: number;
  height: number;
  timestamp: number;
  /** Cached UIA text representation (JSON string). */
  uiaText: string | null;
  uiaTimestamp: number;
}

export type LayerChangeType = "unchanged" | "moved" | "content_changed" | "new" | "closed";

export interface LayerDiff {
  type: LayerChangeType;
  title: string;
  hwnd: bigint;
  region: { x: number; y: number; width: number; height: number };
  previousRegion?: { x: number; y: number; width: number; height: number };
  /** Encoded image — only for content_changed and new. */
  image?: { base64: string; mimeType: "image/webp"; width: number; height: number };
  /** Whether UIA text changed (text mode). */
  uiaChanged?: boolean;
  uiaText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (singleton within the MCP server process)
// ─────────────────────────────────────────────────────────────────────────────

const layers = new Map<bigint, WindowLayer>();

/** Max age in ms before a buffered layer is considered stale. */
const LAYER_TTL_MS = 90_000; // 90 seconds

/** Block size for pixel comparison (NxN pixels averaged). */
const BLOCK_SIZE = 8;

/** Per-channel delta threshold to consider a block "changed". */
const NOISE_THRESHOLD = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Pixel comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare two raw pixel buffers at block resolution.
 * Returns fraction of changed blocks (0.0 – 1.0).
 */
function computeChangeFraction(
  prev: Buffer, curr: Buffer,
  width: number, height: number, channels: number
): number {
  const blocksX = Math.ceil(width / BLOCK_SIZE);
  const blocksY = Math.ceil(height / BLOCK_SIZE);
  let changedBlocks = 0;
  const totalBlocks = blocksX * blocksY;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const x0 = bx * BLOCK_SIZE;
      const y0 = by * BLOCK_SIZE;
      const x1 = Math.min(x0 + BLOCK_SIZE, width);
      const y1 = Math.min(y0 + BLOCK_SIZE, height);

      let sumDelta = 0;
      let count = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * width + x) * channels;
          for (let c = 0; c < 3; c++) {  // compare RGB only
            sumDelta += Math.abs((prev[idx + c] ?? 0) - (curr[idx + c] ?? 0));
          }
          count++;
        }
      }

      if (count > 0 && sumDelta / count / 3 > NOISE_THRESHOLD) {
        changedBlocks++;
      }
    }
  }

  return totalBlocks > 0 ? changedBlocks / totalBlocks : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer capture helpers
// ─────────────────────────────────────────────────────────────────────────────

async function captureWindowRaw(region: { x: number; y: number; width: number; height: number }): Promise<{
  rawPixels: Buffer; channels: 3 | 4; width: number; height: number;
} | null> {
  try {
    const grabRegion = new Region(region.x, region.y, region.width, region.height);
    const image = await screen.grabRegion(grabRegion);
    const rgbImage = await image.toRGB();
    return {
      rawPixels: rgbImage.data,
      channels: (rgbImage.hasAlphaChannel ? 4 : 3) as 3 | 4,
      width: rgbImage.width,
      height: rgbImage.height,
    };
  } catch {
    return null;
  }
}

async function encodeLayer(layer: WindowLayer, quality: number): Promise<{
  base64: string; mimeType: "image/webp"; width: number; height: number;
}> {
  return encodeToWebPFromRaw(layer.rawPixels, layer.width, layer.height, layer.channels, quality);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Clear all buffered layers (force full I-frame on next call). */
export function clearLayers(): void {
  layers.clear();
}

/** Clear layers older than TTL. */
function evictStale(): void {
  const now = Date.now();
  for (const [hwnd, layer] of layers) {
    if (now - layer.timestamp > LAYER_TTL_MS) {
      layers.delete(hwnd);
    }
  }
}

/**
 * Compare current windows against buffered layers.
 * Captures raw pixels for new/changed windows, returns diffs.
 *
 * @param currentWindows  List of currently visible windows
 * @param webpQuality     Quality for encoding changed-layer images
 * @returns Array of LayerDiff (one per window: new, changed, moved, unchanged, or closed)
 */
export async function captureAndDiff(
  currentWindows: WindowInfo[],
  webpQuality = 60
): Promise<LayerDiff[]> {
  evictStale();

  const results: LayerDiff[] = [];
  const seenHwnds = new Set<bigint>();

  for (const win of currentWindows) {
    seenHwnds.add(win.hwnd);
    const prev = layers.get(win.hwnd);

    if (!prev) {
      // New window — capture and buffer
      const raw = await captureWindowRaw(win.region);
      if (!raw) continue;

      const newLayer: WindowLayer = {
        title: win.title,
        hwnd: win.hwnd,
        region: win.region,
        zOrder: win.zOrder,
        rawPixels: raw.rawPixels,
        channels: raw.channels,
        width: raw.width,
        height: raw.height,
        timestamp: Date.now(),
        uiaText: null,
        uiaTimestamp: 0,
      };
      layers.set(win.hwnd, newLayer);

      const image = await encodeLayer(newLayer, webpQuality);
      results.push({ type: "new", title: win.title, hwnd: win.hwnd, region: win.region, image });
      continue;
    }

    // Check if region changed (window moved or resized)
    const regionChanged =
      prev.region.x !== win.region.x ||
      prev.region.y !== win.region.y ||
      prev.region.width !== win.region.width ||
      prev.region.height !== win.region.height;

    if (regionChanged) {
      // Size change → must recapture content
      const raw = await captureWindowRaw(win.region);
      if (!raw) {
        results.push({ type: "moved", title: win.title, hwnd: win.hwnd, region: win.region, previousRegion: prev.region });
        continue;
      }

      const sizeChanged = raw.width !== prev.width || raw.height !== prev.height;
      const fraction = sizeChanged ? 1.0 : computeChangeFraction(prev.rawPixels, raw.rawPixels, raw.width, raw.height, raw.channels);

      // Update buffer
      prev.rawPixels = raw.rawPixels;
      prev.channels = raw.channels;
      prev.width = raw.width;
      prev.height = raw.height;
      prev.region = win.region;
      prev.zOrder = win.zOrder;
      prev.title = win.title;
      prev.timestamp = Date.now();

      if (fraction < 0.05) {
        // Just moved, content same
        results.push({ type: "moved", title: win.title, hwnd: win.hwnd, region: win.region, previousRegion: prev.region });
      } else {
        const image = await encodeLayer(prev, webpQuality);
        results.push({ type: "content_changed", title: win.title, hwnd: win.hwnd, region: win.region, previousRegion: { ...prev.region }, image });
      }
      continue;
    }

    // Same region — compare pixels
    const raw = await captureWindowRaw(win.region);
    if (!raw) {
      results.push({ type: "unchanged", title: win.title, hwnd: win.hwnd, region: win.region });
      continue;
    }

    const sizeChanged = raw.width !== prev.width || raw.height !== prev.height;
    const fraction = sizeChanged ? 1.0 : computeChangeFraction(prev.rawPixels, raw.rawPixels, raw.width, raw.height, raw.channels);

    if (fraction < 0.02) {
      // Unchanged (allow minor rendering noise)
      results.push({ type: "unchanged", title: win.title, hwnd: win.hwnd, region: win.region });
    } else {
      // Content changed
      prev.rawPixels = raw.rawPixels;
      prev.channels = raw.channels;
      prev.width = raw.width;
      prev.height = raw.height;
      prev.timestamp = Date.now();
      prev.title = win.title;
      prev.zOrder = win.zOrder;

      const image = await encodeLayer(prev, webpQuality);
      results.push({ type: "content_changed", title: win.title, hwnd: win.hwnd, region: win.region, image });
    }
  }

  // Detect closed windows
  for (const [hwnd, layer] of layers) {
    if (!seenHwnds.has(hwnd)) {
      layers.delete(hwnd);
      results.push({ type: "closed", title: layer.title, hwnd, region: layer.region });
    }
  }

  return results;
}

/**
 * Capture all windows as a full I-frame (clears existing buffer first).
 * Used for the first call or explicit refresh.
 */
export async function captureAllLayers(
  currentWindows: WindowInfo[],
  webpQuality = 60
): Promise<LayerDiff[]> {
  clearLayers();
  return captureAndDiff(currentWindows, webpQuality);
}

// UIA cache is independent of WindowLayer so it works without diffMode baseline.
const uiaCache = new Map<bigint, { uiaText: string; timestamp: number }>();
const UIA_CACHE_TTL_MS = 90_000;
const UIA_CACHE_MAX = 64;

function sweepUiaCache(): void {
  const now = Date.now();
  // Evict expired first.
  for (const [k, v] of uiaCache) {
    if (now - v.timestamp > UIA_CACHE_TTL_MS) uiaCache.delete(k);
  }
  // Cap by size (oldest-first eviction — Map keeps insertion order).
  while (uiaCache.size > UIA_CACHE_MAX) {
    const firstKey = uiaCache.keys().next().value;
    if (firstKey === undefined) break;
    uiaCache.delete(firstKey);
  }
}

/** Update the UIA text cache for a specific window. */
export function updateUiaCache(hwnd: bigint, uiaText: string): void {
  // MRU ordering: delete-then-set so freshly-updated entries move to the end.
  if (uiaCache.has(hwnd)) uiaCache.delete(hwnd);
  uiaCache.set(hwnd, { uiaText, timestamp: Date.now() });
  sweepUiaCache();
  // Also keep WindowLayer in sync if a baseline exists.
  const layer = layers.get(hwnd);
  if (layer) {
    layer.uiaText = uiaText;
    layer.uiaTimestamp = Date.now();
  }
}

/** Get cached UIA text for a window, or null if not cached / expired. */
export function getCachedUia(hwnd: bigint): string | null {
  const entry = uiaCache.get(hwnd);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > UIA_CACHE_TTL_MS) {
    uiaCache.delete(hwnd);
    return null;
  }
  return entry.uiaText;
}

/** UIA cache TTL — exported so identity-tracker can compute expiresInMs. */
export const UIA_CACHE_TTL_EXPORTED_MS = UIA_CACHE_TTL_MS;

/** Check if layer buffer has any entries (i.e., I-frame has been taken). */
export function hasBuffer(): boolean {
  return layers.size > 0;
}

/** TTL constant (ms) — exported so callers can compute expires-in. */
export const LAYER_TTL_EXPORTED_MS = LAYER_TTL_MS;

/** Get the timestamp of the buffered baseline for a window, or null if none. */
export function getBaselineTimestamp(hwnd: bigint): number | null {
  return layers.get(hwnd)?.timestamp ?? null;
}

/** Get the UIA-cache timestamp for a window, or null if no cached UIA. */
export function getUiaCacheTimestamp(hwnd: bigint): number | null {
  return uiaCache.get(hwnd)?.timestamp ?? null;
}
