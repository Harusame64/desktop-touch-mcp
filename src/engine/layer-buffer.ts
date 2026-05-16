/**
 * layer-buffer.ts
 *
 * Window-layer frame buffer for diff-based screenshot mode.
 * Treats the virtual desktop as a compositor: each window is a layer.
 * Only changed layers are re-sent on subsequent captures (MPEG P-frame style).
 */

import { encodeToWebPFromRaw, dHashFromRaw, captureWindowRawWithFallback } from "./image.js";
import { nativeEngine } from "./native-engine.js";

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
  /** Cached 64-bit dHash of rawPixels for scroll-verification. */
  lastDHash?: bigint;
  lastDHashAt?: number;
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
 *
 * Exported so ADR-019 Stage 2a temporal-ring telemetry in
 * `src/tools/_input-pipeline.ts` can reuse the same block-SAD primitive
 * (SSE2 SIMD when nativeEngine is present, TS fallback otherwise) without
 * duplicating the noise-threshold tuning.
 */
export function computeChangeFraction(
  prev: Buffer, curr: Buffer,
  width: number, height: number, channels: number
): number {
  if (nativeEngine) {
    return nativeEngine.computeChangeFraction(prev, curr, width, height, channels);
  }

  // TS fallback
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

async function captureWindowRaw(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
): Promise<{
  rawPixels: Buffer; channels: 3 | 4; width: number; height: number;
} | null> {
  try {
    // PrintWindow primary + BitBlt fallback. Each captured layer is now sourced
    // the same way as `screenshot(detail='image', windowTitle=…)` — important
    // so diff/layer captures stay readable on RDP and GPU-composited apps.
    const raw = await captureWindowRawWithFallback(hwnd, region);
    return {
      rawPixels: raw.rawPixels,
      channels: raw.channels,
      width: raw.width,
      height: raw.height,
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
      const raw = await captureWindowRaw(win.hwnd, win.region);
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
      const raw = await captureWindowRaw(win.hwnd, win.region);
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
    const raw = await captureWindowRaw(win.hwnd, win.region);
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
  //
  // Invariant — keep this comparison STRICT `>` (do NOT change to `>=`):
  // `isUiaCacheStale` (identity-tracker.ts) reports stale at `age >= TTL`,
  // and the boundary case (`age === TTL`) is the only point at which a
  // stale entry remains observable in this Map. The precedence tests in
  // `tests/unit/desktop-facade.test.ts` (#295 carry-over) stamp at exactly
  // that boundary to distinguish which HWND the facade interrogated;
  // tightening the sweep to `>=` would silently make those tests pass for
  // the wrong reason (the older entry would be evicted before assertion).
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

/**
 * Drop every UIA-cache entry (Opus PR #302 P2 #4). `clearLayers()` only clears
 * the WindowLayer baseline map; the `uiaCache` Map is independent (line 308
 * comment) and survives `clearLayers()`. Tests that depend on a clean UIA-
 * cache state should call this helper alongside `clearLayers()` so cross-test
 * bleed cannot mask a regression in stale-detection logic.
 */
export function clearUiaCache(): void {
  uiaCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// SmartScroll raw-pixel + dHash access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the cached raw pixel buffer for a window (from the last diffMode capture).
 * Used by scroll({action:'smart'}) image path to derive dHash without re-screenshotting.
 * Returns null when no baseline has been captured for this HWND.
 */
export function getCachedRaw(hwnd: bigint): {
  rawPixels: Buffer; channels: 3 | 4; width: number; height: number;
} | null {
  const layer = layers.get(hwnd);
  if (!layer) return null;
  return { rawPixels: layer.rawPixels, channels: layer.channels, width: layer.width, height: layer.height };
}

/**
 * Return the last cached dHash for a window, or null if none computed yet.
 * Updated lazily on each captureWindowRaw call inside captureAndDiff.
 */
export function getCachedDHash(hwnd: bigint): bigint | null {
  return layers.get(hwnd)?.lastDHash ?? null;
}

/**
 * Capture the raw pixels for a window region and update the dHash cache.
 * Returns null on capture failure.
 * Callers (scroll({action:'smart'}) image path) use this between scroll attempts.
 */
export async function captureWindowRawAndHash(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number }
): Promise<{ rawPixels: Buffer; channels: 3 | 4; width: number; height: number; dHash: bigint } | null> {
  const raw = await captureWindowRaw(hwnd, region);
  if (!raw) return null;
  const dHash = await dHashFromRaw(raw.rawPixels, raw.width, raw.height, raw.channels);
  // Update layer cache if present
  const layer = layers.get(hwnd);
  if (layer) {
    layer.rawPixels = raw.rawPixels;
    layer.channels = raw.channels;
    layer.width = raw.width;
    layer.height = raw.height;
    layer.lastDHash = dHash;
    layer.lastDHashAt = Date.now();
  }
  return { ...raw, dHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-019 Stage 2a — stop-detection + causal strip filter (observation-only)
//
// PoC-validated algorithm (`docs/adr-019-stage-2a-poc-results.md` 2026-05-16):
// instead of fixed `[30, 60, 120, 240] ms` sampling, poll until visual
// stability is detected (CONSECUTIVE_STABLE consecutive frames with inter-
// frame `changedFraction < STABLE_THRESHOLD`), then compute strip-wise diff
// of `preFrame` vs the final stable frame oriented along the dispatch motion
// axis. This filters caret/spinner noise semantically — caret blink touches
// 1 strip, real scroll touches multiple strips.
//
// Two exported functions:
//   - `captureFrame`                  is the dispatch-pre reference (T_pre)
//   - `capturePostFrameUntilStable`   polls until stable or budget exhausts
//   - `computeStripChangedFractions`  per-strip diff for the final stable frame
//
// All helpers measure `performance.now()` from their own call instant — the
// caller's choice to invoke at `T_settle` makes the time-bases coincide.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw RGBA/RGB frame returned by Stage 2a capture helpers.
 *
 * Shape matches `captureWindowRawWithFallback`'s payload; exported so callers
 * in `src/tools/_input-pipeline.ts` (Stage 2a wiring) and tests can pass the
 * frame around without re-deriving the field set.
 */
export type RawFrame = {
  rawPixels: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
};

/**
 * ADR-019 Stage 2a — single synchronous capture used for the dispatch-pre
 * reference frame (`T_pre`).
 *
 * Returns `null` on any capture failure (DWM warm-up, minimised window,
 * permission boundary) — the caller decides whether to skip Stage 2a ring
 * activation when pre-frame is unavailable. Never throws.
 */
export async function captureFrame(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
): Promise<RawFrame | null> {
  return captureWindowRaw(hwnd, region);
}

/**
 * ADR-019 Stage 2a — poll post-frames until visual stability is reached or
 * the wall-clock budget is exhausted.
 *
 * Algorithm (PoC-validated, see `docs/adr-019-stage-2a-poc-results.md`):
 *   1. `await sleep(minWaitMs)` to absorb GPU staleness (PrintWindow can
 *      return a pre-paint cached frame for ~16-50 ms; without minWait the
 *      first two captures might be byte-identical pre-paint = false stable).
 *   2. Capture first reference frame (`prev`). Push onto `frames`.
 *   3. Loop until budget exhausted OR `consecutiveStable >= consecutiveStableTarget`:
 *      - `await sleep(pollIntervalMs)`
 *      - capture `now`
 *      - `delta = changedFraction(prev, now)` (or 1.0 on size mismatch)
 *      - push `now` + `delta`
 *      - `consecutiveStable++` if `delta < stableThreshold`, else reset to 0
 *      - `prev = now`
 *
 * Returns `frames[]` (the captured ring) + per-frame `deltas[]` (inter-frame
 * stability metric) + `stableReached` + `framesToStability` + `totalElapsedMs`.
 * The caller computes the pre-vs-final diff (strip-wise + full-window) from
 * `preFrame` and `frames[frames.length - 1]`.
 */
export async function capturePostFrameUntilStable(
  hwnd: bigint,
  region: { x: number; y: number; width: number; height: number },
  opts: {
    pollIntervalMs: number;
    minWaitMs: number;
    stableThreshold: number;
    consecutiveStableTarget: number;
    budgetMs: number;
  },
): Promise<{
  frames: RawFrame[];
  deltas: number[];
  stableReached: boolean;
  framesToStability: number | null;
  totalElapsedMs: number;
}> {
  const { pollIntervalMs, minWaitMs, stableThreshold, consecutiveStableTarget, budgetMs } = opts;
  const start = performance.now();

  await sleep(minWaitMs);

  const frames: RawFrame[] = [];
  const deltas: number[] = [];
  let prev = await captureWindowRaw(hwnd, region);
  if (prev === null) {
    return {
      frames,
      deltas,
      stableReached: false,
      framesToStability: null,
      totalElapsedMs: performance.now() - start,
    };
  }
  frames.push(prev);

  let consecutiveStable = 0;
  let stableReached = false;
  let framesToStability: number | null = null;

  while (performance.now() - start < budgetMs) {
    await sleep(pollIntervalMs);
    const now = await captureWindowRaw(hwnd, region);
    if (now === null) continue; // transient capture failure — try next poll
    const delta =
      now.width === prev.width && now.height === prev.height && now.channels === prev.channels
        ? computeChangeFraction(prev.rawPixels, now.rawPixels, now.width, now.height, now.channels)
        : 1.0;
    frames.push(now);
    deltas.push(delta);
    if (delta < stableThreshold) {
      consecutiveStable++;
      if (consecutiveStable >= consecutiveStableTarget) {
        stableReached = true;
        framesToStability = frames.length;
        break;
      }
    } else {
      consecutiveStable = 0;
    }
    prev = now;
  }

  return {
    frames,
    deltas,
    stableReached,
    framesToStability,
    totalElapsedMs: performance.now() - start,
  };
}

/**
 * ADR-019 Stage 2a — strip-wise `changedFraction` between two frames, with
 * strips oriented along the expected motion axis.
 *
 *   axis = "vertical"   → horizontal strips (rows partitioned top→bottom),
 *                         for scroll-up / scroll-down dispatches
 *   axis = "horizontal" → vertical strips (columns partitioned left→right),
 *                         for scroll-left / scroll-right dispatches
 *
 * The "causal" interpretation: a real scroll along the axis shifts content
 * across multiple strips → multiple strips show non-zero changedFraction. A
 * caret blink / local UI animation touches one region → only 1 strip shows
 * change. Stage 2b uses `stripsAboveNoise` count to discriminate.
 *
 * Returns `fractions: number[]` (length = stripCount, all 1.0 on size mismatch)
 * + `sizeMismatch: boolean`. On axis="vertical" the strip boundaries are
 * row indices; on axis="horizontal" they are column indices. The last strip
 * absorbs leftover pixels when (height|width) is not divisible by stripCount.
 */
export function computeStripChangedFractions(
  pre: RawFrame,
  post: RawFrame,
  axis: "vertical" | "horizontal",
  stripCount: number,
): { fractions: number[]; sizeMismatch: boolean } {
  if (
    pre.width !== post.width ||
    pre.height !== post.height ||
    pre.channels !== post.channels
  ) {
    return { fractions: new Array(stripCount).fill(1.0), sizeMismatch: true };
  }
  if (stripCount <= 0) {
    return { fractions: [], sizeMismatch: false };
  }
  const { width, height, channels } = pre;
  const fractions: number[] = [];

  if (axis === "vertical") {
    // Horizontal strips — row-major slicing, zero-copy via subarray.
    const bytesPerRow = width * channels;
    const stripHeight = Math.floor(height / stripCount);
    if (stripHeight <= 0) {
      // Window too small to partition; fall back to single full-window diff
      // replicated across strips so callers see consistent array length.
      const f = computeChangeFraction(pre.rawPixels, post.rawPixels, width, height, channels);
      return { fractions: new Array(stripCount).fill(f), sizeMismatch: false };
    }
    for (let i = 0; i < stripCount; i++) {
      const rowStart = i * stripHeight;
      const rowEnd = i === stripCount - 1 ? height : (i + 1) * stripHeight;
      const sliceH = rowEnd - rowStart;
      const byteStart = rowStart * bytesPerRow;
      const byteEnd = rowEnd * bytesPerRow;
      const preSlice = pre.rawPixels.subarray(byteStart, byteEnd);
      const postSlice = post.rawPixels.subarray(byteStart, byteEnd);
      fractions.push(
        computeChangeFraction(preSlice, postSlice, width, sliceH, channels),
      );
    }
  } else {
    // Vertical strips — column slicing requires a per-strip copy (rows are
    // contiguous in memory but columns are interleaved). Acceptable for
    // Stage 2a's small strip count (4); Stage 2b can refine to per-strip
    // SIMD inside Rust if telemetry shows hot-path pressure.
    const stripWidth = Math.floor(width / stripCount);
    if (stripWidth <= 0) {
      const f = computeChangeFraction(pre.rawPixels, post.rawPixels, width, height, channels);
      return { fractions: new Array(stripCount).fill(f), sizeMismatch: false };
    }
    for (let i = 0; i < stripCount; i++) {
      const colStart = i * stripWidth;
      const colEnd = i === stripCount - 1 ? width : (i + 1) * stripWidth;
      const sliceW = colEnd - colStart;
      const sliceBytes = sliceW * channels * height;
      const preStrip = Buffer.alloc(sliceBytes);
      const postStrip = Buffer.alloc(sliceBytes);
      for (let y = 0; y < height; y++) {
        const srcOff = (y * width + colStart) * channels;
        const dstOff = y * sliceW * channels;
        pre.rawPixels.copy(preStrip, dstOff, srcOff, srcOff + sliceW * channels);
        post.rawPixels.copy(postStrip, dstOff, srcOff, srcOff + sliceW * channels);
      }
      fractions.push(
        computeChangeFraction(preStrip, postStrip, sliceW, height, channels),
      );
    }
  }
  return { fractions, sizeMismatch: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
