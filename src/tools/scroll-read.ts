/**
 * scroll-read.ts — handler for scroll(action='read')
 *
 * Scrolls a window page-by-page, OCRs each viewport, deduplicates overlapping
 * lines, and returns the stitched text. Part of the scroll dispatcher family
 * (scroll.ts). Phase 1: native apps only (browser/CDP in Phase 3).
 */

import { recognizeWindowByHwnd, ocrWordsToLines } from "../engine/ocr-bridge.js";
import { keyboard, getWindows } from "../engine/nutjs.js";
import { getWindowTitleW } from "../engine/win32.js";
import { canInjectAtTarget, postKeyComboToHwnd } from "../engine/bg-input.js";
import { parseKeys } from "../utils/key-map.js";
import type { ToolResult } from "./_types.js";

type FocusableWin = { focus: () => Promise<void> };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the best OCR language from the Windows system locale via
 * Intl.DateTimeFormat().resolvedOptions().locale (reads OS preferred language).
 *
 * Returns the BCP-47 primary tag verbatim (e.g. "ja", "en", "sv", "th") so
 * win-ocr.exe / Windows.Media.Ocr can resolve it against whichever language
 * packs the OS actually has installed — including locales that an in-process
 * allowlist could not anticipate. Falls back to "en" only when the locale is
 * empty (extremely rare; happens with stripped-down container images).
 */
export function detectOcrLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const primary = locale.split("-")[0]?.toLowerCase();
  return primary || "en";
}

/**
 * Longest suffix of `prev` that equals a prefix of `curr`.
 * Naive O(min(n,m)²) — caller bounds `prev` to at most `curr.length` so cost
 * is dominated by the OCR page size (tens to low hundreds of lines).
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
  let focusedWin: FocusableWin | null = null;

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
        focusedWin = win as unknown as FocusableWin;
        break;
      } catch { /* skip */ }
    }
    if (!focusedHwnd || !focusedRegion || !focusedWin) {
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
  let stoppedReason: "no_change" | "max_pages" | "ocr_empty" | "ocr_failed" = "max_pages";
  let noChangeStreak = 0;
  let ocrError: string | null = null;

  for (let page = 1; page <= args.maxPages; page++) {
    // Wrap each iteration so OCR / capture / scroll-injection failures surface
    // as a structured ToolResult instead of escaping as a tool execution
    // failure. The target window may close mid-read, PrintWindow may fault,
    // or the OCR subprocess may crash — any of those should yield ok:false
    // (when no pages have completed yet) or ok:true with whatever pages we
    // already captured (stoppedReason="ocr_failed", error attached).
    try {
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

      // Deduplicate: remove lines at the start of `lines` that are already at
      // the end of `allLines`. Bound the prev-side window to `lines.length` so
      // the suffix-prefix scan covers the worst case where the entire current
      // frame overlaps the previous one (notably scrollKey='ArrowDown' which
      // advances by a single line and almost-fully overlaps adjacent frames).
      // A fixed 20-line cap silently broke ArrowDown mode, leaving duplicates
      // appended every iteration and stopWhenNoChange never firing.
      const dupCount = findOverlap(allLines.slice(-lines.length), lines);
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

      // Send scroll key. Prefer BG-mode injection bound to the resolved hwnd
      // (WM_KEYDOWN/KEYUP via PostMessage — does not change foreground) so a
      // concurrent user click or system popup cannot redirect the keystroke.
      //
      // canInjectAtTarget evaluates BG-injection support against the SAME
      // resolved child HWND that postKeyComboToHwnd will eventually post to
      // (resolveTarget → focused child if any, else parent). A parent-only
      // gate would mis-classify a Chromium / WebView2 child whose parent
      // class looks supported, letting BG send "succeed" while keys are
      // silently dropped. postKeyComboToHwnd's boolean alone is also
      // insufficient — it confirms the message was posted, not consumed.
      // Either gate failing routes the keystroke through the foreground
      // fallback so the page actually scrolls.
      const combo = SCROLL_KEY_COMBO[args.scrollKey]!;
      const canBg = canInjectAtTarget(focusedHwnd);
      const bgOk = canBg.supported && postKeyComboToHwnd(focusedHwnd, combo);
      if (!bgOk) {
        await focusedWin.focus();
        await new Promise<void>((r) => setTimeout(r, 100));
        const arr = parseKeys(combo);
        await keyboard.pressKey(...arr);
        await keyboard.releaseKey(...arr);
      }
      await new Promise<void>((r) => setTimeout(r, args.scrollDelayMs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No pages captured yet — return a clean structured failure rather
      // than an empty ok:true payload that would mask the underlying error.
      if (perPage.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: `scroll(action='read') failed before any page was captured: ${msg}`,
            }),
          }],
        };
      }
      // At least one page already in `allLines` — preserve partial output and
      // surface the error alongside the stitched text so the caller can decide
      // whether to retry or use what's there.
      ocrError = msg;
      stoppedReason = "ocr_failed";
      break;
    }
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
        ...(ocrError !== null ? { error: ocrError } : {}),
      }, null, 2),
    }],
  };
}
