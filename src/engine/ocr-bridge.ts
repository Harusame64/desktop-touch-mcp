import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { captureWindowBackground } from "./image.js";
import { enumWindowsInZOrder } from "./win32.js";
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
