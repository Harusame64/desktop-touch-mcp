/**
 * scroll-read.ts — handler for scroll(action='read')
 *
 * Scrolls a window page-by-page, OCRs each viewport, deduplicates overlapping
 * lines, and returns the stitched text. Part of the scroll dispatcher family
 * (scroll.ts). Phase 1: native apps only (browser/CDP in Phase 3).
 */

import { recognizeWindowByHwnd, ocrWordsToLines } from "../engine/ocr-bridge.js";
import { keyboard } from "../engine/nutjs.js";
import { getWindows } from "../engine/nutjs.js";
import { getWindowTitleW } from "../engine/win32.js";
import { parseKeys } from "../utils/key-map.js";
import type { ToolResult } from "./_types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the best OCR language from the Windows system locale via
 * Intl.DateTimeFormat().resolvedOptions().locale (reads OS preferred language).
 * Returns a primary tag (e.g. "ja", "en") that win-ocr.exe accepts.
 * Falls back to "en" for unrecognised locales.
 */
export function detectOcrLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const primary = locale.split("-")[0]?.toLowerCase() ?? "en";
  const KNOWN = new Set([
    "ja", "en", "zh", "ko", "fr", "de", "es", "it", "pt", "ru", "nl", "pl", "tr", "ar",
  ]);
  return KNOWN.has(primary) ? primary : "en";
}

/**
 * Longest suffix of `prev` that equals a prefix of `curr`.
 * Naive O(n*m), n,m ≤ 20 (we always pass `prev.slice(-20)`).
 */
export function findOverlap(prev: string[], curr: string[]): number {
  const maxOverlap = Math.min(prev.length, curr.length);
  for (let k = maxOverlap; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== curr[i]) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return 0;
}

// Map scrollKey enum → key combo string understood by parseKeys
const SCROLL_KEY_COMBO: Record<string, string> = {
  PageDown:   "pagedown",
  Space:      "space",
  ArrowDown:  "down",
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler args type (matches the read branch in scroll.ts discriminatedUnion)
// ─────────────────────────────────────────────────────────────────────────────

export interface ScrollReadArgs {
  action: "read";
  windowTitle: string;
  maxPages: number;
  scrollKey: "PageDown" | "Space" | "ArrowDown";
  scrollDelayMs: number;
  stopWhenNoChange: boolean;
  language?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function scrollReadHandler(args: ScrollReadArgs): Promise<ToolResult> {
  const language = args.language ?? detectOcrLanguage();

  // Focus the target window — and capture hwnd + region so OCR stays bound to
  // the resolved target across the loop. A title-based lookup on every iteration
  // would risk drifting to a different window with the same title fragment, or
  // to a new foreground when the user changes z-order mid-read; binding to hwnd
  // keeps PageDown and OCR consistently aimed at one window.
  let focusedHwnd: unknown = null;
  let focusedRegion: { x: number; y: number; width: number; height: number } | null = null;

  {
    const wins = await getWindows();
    const query = args.windowTitle.toLowerCase();
    for (const win of wins) {
      try {
        const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
        // OCR drives PrintWindow capture against the hwnd, so an entry without
        // a usable handle cannot be a valid target — skip rather than letting
        // a falsy hwnd reach recognizeWindowByHwnd and crash the Win32 layer.
        if (!hwnd) continue;
        const title = getWindowTitleW(hwnd);
        if (!title.toLowerCase().includes(query)) continue;
        const reg = await win.region;
        if (reg.width < 10 || reg.height < 10) continue;
        await win.focus();
        focusedHwnd = hwnd;
        focusedRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
        break;
      } catch { /* skip */ }
    }
    if (!focusedHwnd || !focusedRegion) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: `Window not found matching: "${args.windowTitle}"`,
          }),
        }],
      };
    }
  }

  // Brief settle after focus
  await new Promise<void>((r) => setTimeout(r, 200));

  const allLines: string[] = [];
  const perPage: Array<{ page: number; addedLines: number; duplicateLines: number }> = [];
  let stoppedReason: "no_change" | "max_pages" | "ocr_empty" = "max_pages";
  let noChangeStreak = 0;

  for (let page = 1; page <= args.maxPages; page++) {
    // OCR bound to the hwnd resolved at focus time, not a fresh title lookup.
    const { words } = await recognizeWindowByHwnd(focusedHwnd, focusedRegion, language);
    const lineText = ocrWordsToLines(words);
    const lines = lineText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      stoppedReason = "ocr_empty";
      break;
    }

    // Deduplicate: remove lines at start of `lines` that are already at end of `allLines`
    const dupCount = findOverlap(allLines.slice(-20), lines);
    const newLines = lines.slice(dupCount);

    perPage.push({ page, addedLines: newLines.length, duplicateLines: dupCount });
    allLines.push(...newLines);

    if (args.stopWhenNoChange && newLines.length === 0) {
      noChangeStreak++;
      if (noChangeStreak >= 2) {
        stoppedReason = "no_change";
        break;
      }
    } else {
      noChangeStreak = 0;
    }

    if (page === args.maxPages) break;

    // Send scroll key and wait
    const combo = parseKeys(SCROLL_KEY_COMBO[args.scrollKey]!);
    await keyboard.pressKey(...combo);
    await keyboard.releaseKey(...combo);
    await new Promise<void>((r) => setTimeout(r, args.scrollDelayMs));
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: true,
        text: allLines.join("\n"),
        pages: perPage.length,
        language,
        stoppedReason,
        dedupedLines: perPage.reduce((s, p) => s + p.duplicateLines, 0),
        perPage,
      }, null, 2),
    }],
  };
}
