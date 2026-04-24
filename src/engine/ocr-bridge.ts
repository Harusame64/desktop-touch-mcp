import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import sharp from "sharp";
import { captureWindowBackground } from "./image.js";
import { enumWindowsInZOrder, getWindowDpi, printWindowToBuffer } from "./win32.js";
import { nativeEngine } from "./native-engine.js";
import type { ActionableElement } from "./uia-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OcrWord {
  text: string;
  /** Bounding box in window-local screen coordinates. */
  bbox: { x: number; y: number; width: number; height: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// win-ocr.exe runner
// ─────────────────────────────────────────────────────────────────────────────

// Resolve bin/win-ocr.exe relative to this file (dist/engine/ → ../../bin/)
const EXE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "win-ocr.exe"
);

/**
 * Spawn win-ocr.exe with PNG bytes on stdin, receive JSON on stdout.
 * Uses a pre-built C# exe to avoid Windows Defender AMSI scanning
 * that blocks PowerShell + WinRT ContentType=WindowsRuntime patterns.
 */
async function runOcrExe(pngBytes: Buffer, language: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE_PATH, [language], { windowsHide: true });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`win-ocr.exe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (!out && code !== 0) {
        reject(new Error(`win-ocr.exe exited ${String(code)}: ${stderr.slice(0, 400)}`));
      } else {
        resolve(out);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Swallow EPIPE: if exe exits early on error, stdin write would throw
    child.stdin.on("error", () => { /* intentionally swallowed */ });

    // Write raw PNG bytes (not base64) — simpler and faster
    const canWriteNow = child.stdin.write(pngBytes);
    if (canWriteNow) {
      child.stdin.end();
    } else {
      child.stdin.once("drain", () => { child.stdin.end(); });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Word merging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge adjacent OCR words that are on the same line and close together.
 * Windows.Media.Ocr often returns individual Japanese characters as separate
 * "words". Merging them produces "ファイル" instead of "フ","ァ","イ","ル".
 *
 * gapThreshold: max pixel gap between word right-edge and next word left-edge
 * to still consider them part of the same token (default 12px).
 */
/**
 * Merge adjacent OCR words that are on the same line and close together.
 * Windows.Media.Ocr often returns individual Japanese characters as separate
 * "words". Merging produces "ファイル" instead of "フ","ァ","イ","ル".
 *
 * Algorithm:
 *  1. Cluster words into visual lines by vertical midpoint proximity.
 *  2. Within each line, sort left-to-right.
 *  3. Merge consecutive words whose horizontal gap ≤ max(gapThreshold, avgH×0.5).
 *
 * gapThreshold (default 12px) is a minimum baseline but the threshold scales
 * with glyph height to stay correct across DPI settings.
 */
export function mergeNearbyWords(words: OcrWord[], gapThreshold = 12): OcrWord[] {
  if (words.length === 0) return words;

  // Sort by vertical midpoint (not raw y) to handle subpixel y-jitter
  const sorted = [...words].sort(
    (a, b) => (a.bbox.y + a.bbox.height / 2) - (b.bbox.y + b.bbox.height / 2)
  );

  // ── Step 1: cluster into lines ──────────────────────────────────────────
  const lines: OcrWord[][] = [];
  let currentLine: OcrWord[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentLine[currentLine.length - 1];
    const cur  = sorted[i];
    const avgH = (prev.bbox.height + cur.bbox.height) / 2;
    const prevMidY = prev.bbox.y + prev.bbox.height / 2;
    const curMidY  = cur.bbox.y  + cur.bbox.height  / 2;

    if (Math.abs(prevMidY - curMidY) < avgH * 0.6) {
      currentLine.push(cur);
    } else {
      lines.push(currentLine);
      currentLine = [cur];
    }
  }
  lines.push(currentLine);

  // ── Step 2+3: within each line, sort left-to-right, then merge ─────────
  const result: OcrWord[] = [];

  for (const line of lines) {
    const lineWords = [...line].sort((a, b) => a.bbox.x - b.bbox.x);
    let cur: OcrWord = { ...lineWords[0], bbox: { ...lineWords[0].bbox } };

    for (let i = 1; i < lineWords.length; i++) {
      const next    = lineWords[i];
      const curRight = cur.bbox.x + cur.bbox.width;
      const gap      = next.bbox.x - curRight;
      const avgH     = (cur.bbox.height + next.bbox.height) / 2;
      // DPI-safe threshold: whichever is larger — fixed floor or half glyph height
      const maxGap = Math.max(gapThreshold, avgH * 0.5);

      if (gap >= -2 && gap <= maxGap) {
        // Insert a space when the gap suggests a word boundary in Latin text
        const lastChar = cur.text[cur.text.length - 1] ?? "";
        const separator = gap > avgH * 0.25 && /[a-zA-Z0-9]/.test(lastChar) ? " " : "";

        const newRight  = Math.max(curRight, next.bbox.x + next.bbox.width);
        const newTop    = Math.min(cur.bbox.y, next.bbox.y);
        const newBottom = Math.max(cur.bbox.y + cur.bbox.height, next.bbox.y + next.bbox.height);

        cur = {
          text: cur.text + separator + next.text,
          bbox: {
            x: cur.bbox.x,
            y: newTop,
            width: newRight - cur.bbox.x,
            height: newBottom - newTop,
          },
        };
      } else {
        result.push(cur);
        cur = { ...next, bbox: { ...next.bbox } };
      }
    }
    result.push(cur);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run Windows.Media.Ocr on a PNG image (provided as base64).
 * Returns words with bounding boxes in IMAGE-LOCAL coordinates.
 */
export async function runOcr(pngBase64: string, language = "ja"): Promise<OcrWord[]> {
  if (!existsSync(EXE_PATH)) {
    throw new Error(
      `win-ocr.exe not found at ${EXE_PATH}. ` +
      `Run: cd tools/win-ocr && dotnet publish -c Release -o ../../bin/`
    );
  }
  const pngBytes = Buffer.from(pngBase64, "base64");
  const output = await runOcrExe(pngBytes, language, 20000);
  const parsed = JSON.parse(output) as { words?: OcrWord[]; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed.words ?? [];
}

/**
 * Capture a window and run OCR on it.
 * Returns words with bounding boxes already scaled to window-local screen coordinates,
 * plus the window's top-left origin in screen coordinates.
 */
export async function recognizeWindow(
  windowTitle: string,
  language = "ja"
): Promise<{ words: OcrWord[]; origin: { x: number; y: number } }> {
  const wins = enumWindowsInZOrder();
  const win = wins.find((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
  if (!win) throw new Error(`Window not found: "${windowTitle}"`);

  const region = win.region;
  const origin = { x: region.x, y: region.y };

  // Use PrintWindow (PW_RENDERFULLCONTENT) so the window is captured correctly
  // even when it is behind other windows (e.g. Claude Code covering Paint).
  const maxDim = 1280;
  const captured = await captureWindowBackground(win.hwnd, maxDim);

  // Scale factors: image may be downscaled, OCR bboxes are in image coords
  const scaleX = region.width / captured.width;
  const scaleY = region.height / captured.height;

  const rawWords = await runOcr(captured.base64, language);

  // Convert image-local coords → window-local screen coords
  const scaledWords: OcrWord[] = rawWords.map((w) => ({
    text: w.text,
    bbox: {
      x: Math.round(w.bbox.x * scaleX),
      y: Math.round(w.bbox.y * scaleY),
      width: Math.max(1, Math.round(w.bbox.width * scaleX)),
      height: Math.max(1, Math.round(w.bbox.height * scaleY)),
    },
  }));

  // Merge adjacent characters that Windows OCR split into individual words
  const mergedWords = mergeNearbyWords(scaledWords);

  return { words: mergedWords, origin };
}

/**
 * Reconstruct lines of text from OCR words by clustering on y-midpoint and
 * sorting horizontally. Used by terminal_read OCR fallback to keep the 2D
 * structure intact (so sinceMarker stays comparable across UIA / OCR sources).
 */
export function ocrWordsToLines(words: OcrWord[]): string {
  if (words.length === 0) return "";
  const sorted = [...words].sort(
    (a, b) => (a.bbox.y + a.bbox.height / 2) - (b.bbox.y + b.bbox.height / 2)
  );
  const lines: OcrWord[][] = [];
  let cur: OcrWord[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = cur[cur.length - 1]!;
    const next = sorted[i]!;
    const avgH = (prev.bbox.height + next.bbox.height) / 2;
    const prevMid = prev.bbox.y + prev.bbox.height / 2;
    const nextMid = next.bbox.y + next.bbox.height / 2;
    if (Math.abs(prevMid - nextMid) < avgH * 0.6) cur.push(next);
    else { lines.push(cur); cur = [next]; }
  }
  lines.push(cur);
  return lines
    .map((line) => line.sort((a, b) => a.bbox.x - b.bbox.x).map((w) => w.text).join(" "))
    .join("\n");
}

/**
 * Convert OCR words (with window-local bboxes + origin) into ActionableElements.
 * clickAt is in absolute screen coordinates.
 */
export function ocrWordsToActionable(
  words: OcrWord[],
  origin: { x: number; y: number }
): ActionableElement[] {
  const result: ActionableElement[] = [];
  for (const word of words) {
    if (!word.text.trim()) continue;
    const { bbox } = word;
    // Phase 2.3 — PLACEHOLDER OCR confidence (win-ocr.exe does not yet expose
    // OcrLine.Confidence). Tuned so a vanilla OCR word reads as "moderate" not
    // "high" — this keeps it below UIA Name-exact (0.95) when results are mixed.
    let confidence = 0.7;
    const t = word.text;
    if (t.length === 1) confidence = 0.55;          // single chars are unreliable
    if (/[\u00A0-\u00BF\u2000-\u206F]/.test(t)) confidence = 0.45;
    if (/[\uFFFD]/.test(t)) confidence = 0.2;       // replacement char = unrecognized
    const suggest = confidence < 0.5
      ? "Use dotByDot screenshot or browser_eval for verification"
      : undefined;

    result.push({
      action: "click",
      name: word.text,
      type: "OcrText",
      clickAt: {
        x: Math.round(origin.x + bbox.x + bbox.width / 2),
        y: Math.round(origin.y + bbox.y + bbox.height / 2),
      },
      region: {
        x: origin.x + bbox.x,
        y: origin.y + bbox.y,
        width: bbox.width,
        height: bbox.height,
      },
      source: "ocr",
      confidence,
      ...(suggest ? { suggest } : {}),
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Set-of-Mark pipeline (Step 3 + Step 5 — Hybrid Non-CDP)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One UI element produced by the SoM pipeline.
 * `clickAt` and `region` are in **absolute screen coordinates**.
 */
export interface SomElement {
  /** Sequential 1-based ID matching the badge drawn on the SoM image. */
  id: number;
  /** Merged text label (after word clustering). */
  text: string;
  /** Absolute screen coordinates of the element centre — pass to mouse_click. */
  clickAt: { x: number; y: number };
  /** Absolute screen bounding rectangle. */
  region: { x: number; y: number; width: number; height: number };
}

export interface SomPipelineResult {
  /** Annotated SoM image (PNG base64). null when Rust draw_som_labels unavailable. */
  somImage: { base64: string; mimeType: "image/png" } | null;
  /** Structured element list with ID-to-coordinate mapping. */
  elements: SomElement[];
  /** Upscale factor used during OCR preprocessing (for debugging). */
  preprocessScale: number;
  /** Full title of the resolved window. When hwnd is passed, reflects the window's current title rather than the windowTitle argument. */
  resolvedWindowTitle: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preprocessing policy
// ─────────────────────────────────────────────────────────────────────────────

const OOM_THRESHOLD_MP = 8;
const AUTO_DPI_THRESHOLD = 144;   // 150% scaling — conservative baseline
const AGGRESSIVE_DPI_THRESHOLD = 168; // 175% scaling — aggressive limit

/**
 * Decide the effective upscale factor to apply before OCR, based on the
 * preprocessing policy, base scale, image megapixels, and window DPI.
 *
 * OOM guard (megapixels > 8 → scale=1) is always applied regardless of policy.
 *
 * @param policy      "auto" | "aggressive" | "minimal"
 * @param baseScale   Caller-specified base scale (1..4).
 * @param megapixels  Captured image area in megapixels (width×height / 1_000_000).
 * @param windowDpi   Logical DPI of the target window (96 = 100%).
 */
export function decideEffectiveScale(
  policy: "auto" | "aggressive" | "minimal",
  baseScale: number,
  megapixels: number,
  windowDpi: number,
): number {
  if (policy === "minimal") return 1;
  if (megapixels > OOM_THRESHOLD_MP) return 1; // OOM guard — same for all policies
  if (policy === "aggressive") {
    return windowDpi >= AGGRESSIVE_DPI_THRESHOLD ? 1 : baseScale;
  }
  // "auto" — original behaviour
  return windowDpi >= AUTO_DPI_THRESHOLD ? 1 : baseScale;
}

/**
 * Cluster merged OCR words into UI element groups and assign sequential IDs.
 *
 * Applies a second pass of `mergeNearbyWords` with a larger gap threshold
 * (`elementGapThreshold`, default 35px) to join words that form a single
 * clickable element (e.g., "Save As", "検索 ボタン").
 *
 * The result is a flat array of `SomElement` ordered top→bottom, left→right.
 */
export function clusterOcrWords(words: OcrWord[], elementGapThreshold = 35): SomElement[] {
  // Reuse the merge logic with a wider gap to produce element-level groups.
  const clustered = mergeNearbyWords(words, elementGapThreshold);

  return clustered
    .filter((w) => w.text.trim().length > 0)
    .map((w, i): SomElement => ({
      id: i + 1,
      text: w.text.trim(),
      clickAt: {
        x: Math.round(w.bbox.x + w.bbox.width / 2),
        y: Math.round(w.bbox.y + w.bbox.height / 2),
      },
      region: {
        x: w.bbox.x,
        y: w.bbox.y,
        width: w.bbox.width,
        height: w.bbox.height,
      },
    }));
}

/**
 * Full UIA-Blind SoM pipeline for a single window.
 *
 * Steps:
 *  1. Capture raw RGBA via PrintWindow (background-safe, no focus steal).
 *  2. Preprocess via Rust `preprocessImage` (or sharp fallback):
 *     upscale `scale`× + grayscale + contrast stretch.
 *  3. Encode preprocessed buffer to PNG → feed to win-ocr.exe.
 *  4. Scale OCR bbox coords back to original image space (÷ scale).
 *  5. Convert image-local coords → absolute screen coords (+ origin).
 *  6. `mergeNearbyWords` → `clusterOcrWords` → `SomElement[]`.
 *  7. Render SoM image via Rust `drawSomLabels` (or skip if unavailable).
 *  8. Return `{ somImage, elements, preprocessScale, resolvedWindowTitle }`.
 *
 * @param windowTitle      Partial window title (same matching convention as UIA calls).
 * @param hwnd             Optional HWND (bigint) — uses enumWindowsInZOrder when null.
 * @param ocrLang          BCP-47 language tag (default "ja").
 * @param scale            Base upscale factor for OCR preprocessing: 1..4 (default 2).
 * @param preprocessPolicy Controls effective scale selection strategy (default "auto").
 *   "auto"       — current behaviour: clamp to 1 on OOM (>8MP) or high-DPI (≥144dpi).
 *   "aggressive" — relax DPI clamp to 168dpi; implemented in commit 1-3.
 *   "minimal"    — always scale=1 regardless of DPI/OOM; implemented in commit 1-3.
 */
export async function runSomPipeline(
  windowTitle: string,
  hwnd?: bigint | null,
  ocrLang = "ja",
  scale = 2,
  preprocessPolicy: "auto" | "aggressive" | "minimal" = "auto",
): Promise<SomPipelineResult> {
  // ── Locate window & capture raw RGBA ───────────────────────────────────────
  let targetHwnd: unknown = hwnd ?? null;
  let origin = { x: 0, y: 0 };
  let resolvedWindowTitle = windowTitle;

  if (!targetHwnd) {
    const wins = enumWindowsInZOrder();
    const win  = wins.find((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
    if (!win) throw new Error(`runSomPipeline: window not found: "${windowTitle}"`);
    targetHwnd = win.hwnd;
    origin = { x: win.region.x, y: win.region.y };
    resolvedWindowTitle = win.title;
  } else {
    // Resolve origin from enumWindowsInZOrder for the known hwnd
    const wins = enumWindowsInZOrder();
    const win  = wins.find((w) => w.hwnd === targetHwnd);
    if (win) {
      origin = { x: win.region.x, y: win.region.y };
      resolvedWindowTitle = win.title;
    } else {
      console.error(
        `[SoM] WARNING: hwnd provided but window not found in enumWindowsInZOrder ` +
        `(hwnd=${String(targetHwnd)}). Screen coordinates will be image-local (origin=0,0). ` +
        `The window may be minimized or on a different virtual desktop.`,
      );
    }
  }

  const { data: rawData, width, height } = printWindowToBuffer(targetHwnd);
  // printWindowToBuffer returns RGBA (4 channels)

  const _somT0 = performance.now();

  // ── Scale decision via preprocessPolicy ─────────────────────────────────────
  // OOM guard and DPI clamp are delegated to decideEffectiveScale().
  // "auto"       — original thresholds (OOM>8MP or DPI≥144 → scale=1)
  // "aggressive" — relaxed DPI clamp to 168dpi (175% scaling)
  // "minimal"    — always scale=1
  const megapixels = (width * height) / 1_000_000;
  const windowDpi = getWindowDpi(targetHwnd);
  const effectiveScale = decideEffectiveScale(preprocessPolicy, scale, megapixels, windowDpi);
  console.error(
    `[SoM] scale: policy=${preprocessPolicy} base=${scale} mp=${megapixels.toFixed(1)} dpi=${windowDpi}` +
    ` (${Math.round(windowDpi / 96 * 100)}%) → effectiveScale=${effectiveScale}`,
  );

  // ── Step 2: Preprocess (upscale + grayscale + contrast) ────────────────────
  let preprocessedData: Buffer;
  let outW: number;
  let outH: number;

  const _tPreStart = performance.now();
  if (nativeEngine?.preprocessImage) {
    const res = await nativeEngine.preprocessImage({
      data: rawData,
      width,
      height,
      channels: 4,
      scale: effectiveScale,
    });
    preprocessedData = res.data as Buffer;
    outW = res.width;
    outH = res.height;
  } else {
    // sharp fallback: grayscale + bilinear upscale (matches Rust bilinear_resize_u8)
    const { data, info } = await sharp(rawData, { raw: { width, height, channels: 4 } })
      .grayscale()
      .resize({ width: width * effectiveScale, height: height * effectiveScale, kernel: "mitchell" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    preprocessedData = data;
    outW = info.width;
    outH = info.height;
  }
  console.error(`[SoM] preprocess: ${(performance.now() - _tPreStart).toFixed(1)}ms  (${width}×${height} → ${outW}×${outH}, effectiveScale=${effectiveScale})`);

  // ── Step 3: OCR on preprocessed PNG ────────────────────────────────────────
  const pngBuffer = await sharp(preprocessedData, {
    raw: { width: outW, height: outH, channels: 1 },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();

  const _tOcrStart = performance.now();
  const rawWords = await runOcr(pngBuffer.toString("base64"), ocrLang);
  console.error(`[SoM] win-ocr: ${(performance.now() - _tOcrStart).toFixed(1)}ms  (${rawWords.length} words)`);

  // ── Scale OCR coords back to original image space (÷ effectiveScale) ────────
  // Use effectiveScale (not scale) — DPI/OOM guards may have clamped it to 1.
  const scaledWords: OcrWord[] = rawWords.map((w) => ({
    text: w.text,
    bbox: {
      x:      Math.round(w.bbox.x      / effectiveScale),
      y:      Math.round(w.bbox.y      / effectiveScale),
      width:  Math.max(1, Math.round(w.bbox.width  / effectiveScale)),
      height: Math.max(1, Math.round(w.bbox.height / effectiveScale)),
    },
  }));

  // Convert image-local → absolute screen coordinates
  const screenWords: OcrWord[] = scaledWords.map((w) => ({
    text: w.text,
    bbox: {
      x:      origin.x + w.bbox.x,
      y:      origin.y + w.bbox.y,
      width:  w.bbox.width,
      height: w.bbox.height,
    },
  }));

  // ── Merge chars → words → elements (2-stage clustering) ────────────────────
  // Stage 1 (gap≈12px): raw OCR words → merged word spans  [handled in clusterOcrWords]
  // Stage 2 (gap=35px): word spans   → logical UI elements [handled in clusterOcrWords]
  // This call applies stage 1 on screenWords, then stage 2 inside clusterOcrWords.
  const _tClsStart = performance.now();
  const merged   = mergeNearbyWords(screenWords);
  const elements = clusterOcrWords(merged);
  console.error(`[SoM] clustering: ${(performance.now() - _tClsStart).toFixed(1)}ms  (${merged.length} words → ${elements.length} elements)`);

  // ── Step 4: Render SoM image via Rust ───────────────────────────────────────
  let somImage: SomPipelineResult["somImage"] = null;

  if (nativeEngine?.drawSomLabels) {
    // Labels are in image-local coordinates (subtract origin)
    const labels = elements.map((el) => ({
      id:     el.id,
      x:      Math.max(0, el.region.x - origin.x),
      y:      Math.max(0, el.region.y - origin.y),
      width:  el.region.width,
      height: el.region.height,
    }));

    const _tDrawStart = performance.now();
    const drawn = await nativeEngine.drawSomLabels({
      data:     rawData,
      width,
      height,
      channels: 4,
      labels,
    });
    console.error(`[SoM] drawSomLabels (Rust): ${(performance.now() - _tDrawStart).toFixed(1)}ms  (${labels.length} labels)`);

    const pngOut = await sharp(drawn.data as Buffer, {
      raw: { width: drawn.width, height: drawn.height, channels: drawn.channels as 1 | 2 | 3 | 4 },
    })
      .png({ compressionLevel: 6 })
      .toBuffer();

    somImage = { base64: pngOut.toString("base64"), mimeType: "image/png" };
  }

  console.error(`[SoM] total pipeline: ${(performance.now() - _somT0).toFixed(1)}ms`);

  return { somImage, elements, preprocessScale: effectiveScale, resolvedWindowTitle };
}
