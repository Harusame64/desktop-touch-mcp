/**
 * Tests for scroll(action='read') — findOverlap, detectOcrLanguage, handler mock, schema.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findOverlap, detectOcrLanguage } from "../../src/tools/scroll-read.js";
import { scrollSchema } from "../../src/tools/scroll.js";

// ─────────────────────────────────────────────────────────────────────────────
// findOverlap
// ─────────────────────────────────────────────────────────────────────────────

describe("findOverlap", () => {
  it("detects overlap at end of prev matching start of curr", () => {
    expect(findOverlap(["a", "b", "c"], ["b", "c", "d"])).toBe(2);
  });

  it("returns 0 for non-overlapping arrays", () => {
    expect(findOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("returns 0 when prev is empty", () => {
    expect(findOverlap([], ["a", "b"])).toBe(0);
  });

  it("returns 0 when curr is empty", () => {
    expect(findOverlap(["a", "b"], [])).toBe(0);
  });

  it("returns full overlap when curr is exact suffix of prev", () => {
    expect(findOverlap(["x", "a", "b"], ["a", "b"])).toBe(2);
  });

  it("returns overlap equal to min length when both equal", () => {
    expect(findOverlap(["a", "b"], ["a", "b"])).toBe(2);
  });

  it("handles single-element overlap", () => {
    expect(findOverlap(["x", "y", "z"], ["z", "w"])).toBe(1);
  });

  it("handles overlap longer than 20 elements (ArrowDown viewport edge — round-7/8 regression)", () => {
    // Prev page 30 lines, curr page = last 29 of prev + 1 new (line-by-line scroll).
    const prev = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
    const curr = [...Array.from({ length: 29 }, (_, i) => `L${i + 2}`), "L31"];
    expect(findOverlap(prev, curr)).toBe(29);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectOcrLanguage
// ─────────────────────────────────────────────────────────────────────────────

describe("detectOcrLanguage", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    spy?.mockRestore();
  });

  it('returns "ja" for ja-JP locale', () => {
    spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "ja-JP",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "Asia/Tokyo",
      hour12: false,
      hourCycle: "h23",
      weekday: undefined,
      era: undefined,
      year: "numeric",
      month: undefined,
      day: undefined,
      hour: undefined,
      minute: undefined,
      second: undefined,
      timeZoneName: undefined,
    });
    expect(detectOcrLanguage()).toBe("ja");
  });

  it('returns the primary tag verbatim for any locale (no hardcoded allowlist — round-9 regression)', () => {
    // Swedish was previously force-coerced to "en" by the old OCR_KNOWN_LANGUAGES
    // allowlist. The fix lets win-ocr.exe / Windows.Media.Ocr resolve the tag
    // against whatever language packs the OS actually has installed.
    spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "sv-SE",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "Europe/Stockholm",
      hour12: false,
      hourCycle: "h23",
      weekday: undefined,
      era: undefined,
      year: "numeric",
      month: undefined,
      day: undefined,
      hour: undefined,
      minute: undefined,
      second: undefined,
      timeZoneName: undefined,
    });
    expect(detectOcrLanguage()).toBe("sv");
  });

  it('returns "zh" for zh-CN locale', () => {
    spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "zh-CN",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "Asia/Shanghai",
      hour12: false,
      hourCycle: "h23",
      weekday: undefined,
      era: undefined,
      year: "numeric",
      month: undefined,
      day: undefined,
      hour: undefined,
      minute: undefined,
      second: undefined,
      timeZoneName: undefined,
    });
    expect(detectOcrLanguage()).toBe("zh");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema validation
// ─────────────────────────────────────────────────────────────────────────────

describe("scroll schema — action='read'", () => {
  it("parses minimal valid input with defaults", () => {
    const result = scrollSchema.safeParse({
      action: "read",
      windowTitle: "Notepad",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.action).toBe("read");
    expect(result.data.windowTitle).toBe("Notepad");
    expect(result.data.maxPages).toBe(20);
    expect(result.data.scrollKey).toBe("PageDown");
    expect(result.data.scrollDelayMs).toBe(400);
    expect(result.data.stopWhenNoChange).toBe(true);
    expect(result.data.language).toBeUndefined();
  });

  it("accepts explicit language override", () => {
    const result = scrollSchema.safeParse({
      action: "read",
      windowTitle: "MyApp",
      language: "ja",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.language).toBe("ja");
  });

  it("rejects invalid scrollKey", () => {
    const result = scrollSchema.safeParse({
      action: "read",
      windowTitle: "MyApp",
      scrollKey: "F5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxPages below 1", () => {
    const result = scrollSchema.safeParse({
      action: "read",
      windowTitle: "MyApp",
      maxPages: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxPages above 50", () => {
    const result = scrollSchema.safeParse({
      action: "read",
      windowTitle: "MyApp",
      maxPages: 51,
    });
    expect(result.success).toBe(false);
  });

  it("coerces string maxPages", () => {
    const result = scrollSchema.safeParse({
      action: "read",
      windowTitle: "MyApp",
      maxPages: "5",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.maxPages).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler dry-run (OCR + nut-js mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe("scrollReadHandler (mocked)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // resetModules does not drop a doMock registration; the off-desktop test's must not reach the next test.
    vi.doUnmock("../../src/tools/_off-desktop.js");
    vi.doUnmock("../../src/tools/_blocked-by-dialog.js");
  });

  /**
   * Build a mock OcrWord array for a list of text lines.
   * Each line is assigned a y-midpoint spaced 20px apart.
   */
  function makeWords(lines: string[]): Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }> {
    return lines.map((text, i) => ({
      text,
      bbox: { x: 0, y: i * 20, width: 100, height: 18 },
    }));
  }

  it("returns stitched text from 3 pages with deduplication", async () => {
    // Page 1: lines A, B, C
    // Page 2: lines B, C, D, E   (B,C overlap with page 1 tail)
    // Page 3: lines D, E, F      (D,E overlap with page 2 tail)
    const page1 = makeWords(["A", "B", "C"]);
    const page2 = makeWords(["B", "C", "D", "E"]);
    const page3 = makeWords(["D", "E", "F"]);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi
        .fn()
        .mockResolvedValueOnce({ words: page1, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page2, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page3, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (words: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }>) =>
        words.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 3,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(true);
    expect(data.text).toBe("A\nB\nC\nD\nE\nF");
    expect(data.pages).toBe(3);
    expect(data.stoppedReason).toBe("max_pages");
    expect(data.dedupedLines).toBe(4); // 2 from page2 + 2 from page3
  });

  // internal #357: 'en' asked for, read by the 'ja' engine (no English OCR pack installed).
  it("names the language that read, and warns, when the one asked for had no OCR pack (internal #357)", async () => {
    const used = vi.fn((_req: string) => "ja" as string | undefined);
    const warning = vi.fn((_req: string) => "ocr_language_fallback: no pack for 'en'" as string | null);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: makeWords(["A"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "ja",
      ocrLanguageUsed: used,
      ocrLanguageWarning: warning,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: { pressKey: vi.fn().mockResolvedValue(undefined), releaseKey: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));
    vi.doMock("../../src/engine/win32.js", () => ({
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({
      action: "read", windowTitle: "Test", maxPages: 1, scrollKey: "PageDown", scrollDelayMs: 0,
      stopWhenNoChange: true, language: "en",
    });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(used).toHaveBeenCalledWith("en");
    expect(data.language).toBe("ja");
    expect(data.requestedLanguage).toBe("en");
    expect(data.warnings).toEqual(["ocr_language_fallback: no pack for 'en'"]);
  });

  it("stops with stoppedReason=no_change after 2 consecutive no-new-line pages", async () => {
    // Page 1: lines A, B, C
    // Pages 2,3,4: same lines A, B, C (no new content)
    const words = makeWords(["A", "B", "C"]);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 20,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(true);
    expect(data.stoppedReason).toBe("no_change");
    // Page 1 adds A,B,C. Pages 2 and 3 add 0 lines each (streak reaches 2 on page 3)
    expect(data.pages).toBe(3);
    expect(data.text).toBe("A\nB\nC");
  });

  it("stops with stoppedReason=max_pages when maxPages is reached", async () => {
    // Every page returns fresh lines
    let callCount = 0;
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockImplementation(async () => {
        callCount++;
        return { words: makeWords([`Line${callCount}`]), origin: { x: 0, y: 0 } };
      }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 5,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(true);
    expect(data.stoppedReason).toBe("max_pages");
    expect(data.pages).toBe(5);
  });

  it("stops with stoppedReason=ocr_empty when OCR returns no words", async () => {
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: [], origin: { x: 0, y: 0 } }),
      ocrWordsToLines: () => "",
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 10,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(true);
    expect(data.stoppedReason).toBe("ocr_empty");
    expect(data.pages).toBe(0);
    expect(data.text).toBe("");
  });

  it("returns ok:false when neither resolveWindowTarget nor findPlainTopLevelWindowByTitle yields a target (Phase 5 — replaces round-3 P2 'no usable hwnd' guard)", async () => {
    // recognizeWindowByHwnd must NOT be reached — both window-resolution paths
    // must return null/no-match before any OCR is attempted.
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockRejectedValue(new Error("must not be called")),
      ocrWordsToLines: () => "",
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    // Phase 5: both resolution paths return null → "Window not found".
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue(null),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 5,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Window not found");
  });

  it("dispatches scroll key via postKeyComboToHwnd with the resolved hwnd (BG input — round-4 regression)", async () => {
    const page1 = makeWords(["A"]);
    const page2 = makeWords(["B"]);

    const postKeyMock = vi.fn().mockReturnValue(true);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi
        .fn()
        .mockResolvedValueOnce({ words: page1, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page2, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));

    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: postKeyMock,
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 2,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    // BG input fired with the focused hwnd (bigint, Phase 5 migration) and combo.
    expect(postKeyMock).toHaveBeenCalledWith(0xCAFEn, "pagedown");
    // global keyboard NOT used when BG path succeeds — no foreground drift.
    expect(pressKeyMock).not.toHaveBeenCalled();
  });

  it("falls back to global keyboard with re-focus when BG injection is rejected (round-4 regression)", async () => {
    const page1 = makeWords(["A"]);
    const page2 = makeWords(["B"]);

    // Phase 5 migration: re-focus mechanism is `restoreAndFocusWindow(hwnd)`
    // from `src/engine/win32.ts`, not the legacy `Window.focus()` method.
    const restoreAndFocusMock = vi.fn().mockReturnValue({
      x: 0, y: 0, width: 800, height: 600,
    });
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    const releaseKeyMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi
        .fn()
        .mockResolvedValueOnce({ words: page1, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page2, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: { pressKey: pressKeyMock, releaseKey: releaseKeyMock },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    // BG path attempted but PostMessage returns false — exercise fallback
    // (canInject says supported, but postKeyComboToHwnd itself fails).
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(false),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreAndFocusMock,
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 2,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    // Initial focus only: the window is checked to be in front before the keystroke, not asked again
    // (gate 2 on #915: a user who moved away is not pulled back).
    expect(restoreAndFocusMock).toHaveBeenCalledTimes(1);
    expect(pressKeyMock).toHaveBeenCalled();
    expect(releaseKeyMock).toHaveBeenCalled();
  });

  // internal #326: SendInput goes to whatever is in front, so a window that will not come forward gets no keys.
  it("goes on reading through PrintWindow and PostMessage when the window will not come forward (gate 2 on #915)", async () => {
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn().mockReturnValue(true);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn()
        .mockResolvedValueOnce({ words: makeWords(["A"]), origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: makeWords(["B"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: post,
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));
    const restoreAndFocusMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: vi.fn().mockReturnValue(2n),
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreAndFocusMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 2, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.ok).toBe(true);
    expect(body.stoppedReason).toBe("max_pages");
    expect(post).toHaveBeenCalled();
    expect(pressKeyMock).not.toHaveBeenCalled();
    // Asked once, not forced: read does not need the front for this window.
    expect(restoreAndFocusMock).toHaveBeenCalledTimes(1);
    expect(restoreAndFocusMock).toHaveBeenCalledWith(0xCAFEn);
  });

  it("stops with stoppedReason='foreground_refused' and keeps the pages read when the window will not come back before a scroll", async () => {
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: makeWords(["A"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(false),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: false }),
    }));
    const restoreMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    // In front for the initial focus, then something else takes the foreground.
    const fg = vi.fn().mockReturnValueOnce(0xCAFEn).mockReturnValue(2n);
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: fg,
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.stoppedReason).toBe("foreground_refused");
    expect(body.note).toContain("stopped being in front");
    expect(body.text ?? body.lines ?? JSON.stringify(body)).toContain("A");
    expect(pressKeyMock).not.toHaveBeenCalled();
    // Not pulled back: only the initial focus asks; the page checks and stops (gate 2 on #915).
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });

  it("says the window is on another desktop, not 'click it', when a keys-in-front window is off this desktop (internal #221)", async () => {
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: makeWords(["A"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(false),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: false, reason: "chromium" }),
    }));
    vi.doMock("../../src/tools/_off-desktop.js", () => ({
      offDesktopTarget: vi.fn().mockResolvedValue({ hwnd: 0xCAFEn, title: "TestWindow", sameTitleOnScreen: false }),
    }));
    const restoreMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: vi.fn().mockReturnValue(2n),
      enumWindowsInZOrder: vi.fn().mockReturnValue([{ hwnd: 0xCAFEn, title: "TestWindow", isCloaked: true }]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.stoppedReason).toBe("foreground_refused");
    expect(body.note).toContain("another virtual desktop");
    expect(body.note).not.toContain("click the target window");
    expect(restoreMock).not.toHaveBeenCalled();
    expect(pressKeyMock).not.toHaveBeenCalled();
  });

  // internal #381 (win2 S2, dev/380-design-spike b7a8bbee): with Save As open, read brought the disabled
  // Notepad in front of its dialog (the dialog lost its focus). Now: not brought forward, no page key —
  // not even by PostMessage, which would reach the dialog — and the first page is what is read.
  it("reads a window its dialog has disabled without bringing it forward or sending a page key", async () => {
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    const postMock = vi.fn().mockReturnValue(true);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: makeWords(["A"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: postMock,
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));
    vi.doMock("../../src/tools/_off-desktop.js", () => ({ offDesktopTarget: vi.fn().mockResolvedValue(null) }));
    vi.doMock("../../src/tools/_blocked-by-dialog.js", () => ({
      beforeForeground: vi.fn().mockResolvedValue({ blockedByDialog: { hwnd: 0xCAFEn, title: "TestWindow", dialog: { hwnd: 0xD1A1n, name: "Save As" } } }),
    }));
    const restoreMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: vi.fn().mockReturnValue(0xD1A1n),
      enumWindowsInZOrder: vi.fn().mockReturnValue([{ hwnd: 0xCAFEn, title: "TestWindow", isEnabled: false }]),
      getWindowTitleW: vi.fn().mockReturnValue("Save As"),
      getWindowRectByHwnd: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.stoppedReason).toBe("foreground_refused");
    expect(body.note).toContain("disabled while a dialog it opened is in front");
    expect(restoreMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(pressKeyMock).not.toHaveBeenCalled();
  });

  // agy on #957: when the dialog could not be looked for, the window is still disabled and a key may reach a
  // dialog — no page key, as when one is seen.
  it("sends no page key when the dialog could not be read (dialogUnread)", async () => {
    const postMock = vi.fn().mockReturnValue(true);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: makeWords(["A"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: vi.fn(), releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({ postKeyComboToHwnd: postMock, canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }) }));
    vi.doMock("../../src/tools/_blocked-by-dialog.js", () => ({
      beforeForeground: vi.fn().mockResolvedValue({ blockedByDialog: { hwnd: 0xCAFEn, title: "TestWindow", dialog: null, dialogUnread: true } }),
    }));
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: vi.fn().mockReturnValue(2n),
      enumWindowsInZOrder: vi.fn().mockReturnValue([{ hwnd: 0xCAFEn, title: "TestWindow", isEnabled: false }]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn(),
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const body = JSON.parse(((await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true })).content[0] as { text: string }).text);
    expect(body.pages).toBe(1);
    expect(postMock).not.toHaveBeenCalled();
  });

  // gate 2 on #957: a window disabled with no dialog of its seen keeps its PostMessage page keys (they
  // reach its enabled child, K3b) — refusing them would take away a road that works.
  it("pages a disabled window with no dialog seen by PostMessage, and says it was not brought forward", async () => {
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    const postMock = vi.fn().mockReturnValue(true);
    let page = 0;
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockImplementation(async () => ({ words: makeWords([`L${++page}`]), origin: { x: 0, y: 0 } })),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: postMock,
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));
    vi.doMock("../../src/tools/_blocked-by-dialog.js", () => ({
      beforeForeground: vi.fn().mockResolvedValue({ blockedByDialog: { hwnd: 0xCAFEn, title: "TestWindow", dialog: null } }),
    }));
    const restoreMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: vi.fn().mockReturnValue(2n),
      enumWindowsInZOrder: vi.fn().mockReturnValue([{ hwnd: 0xCAFEn, title: "TestWindow", isEnabled: false }]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(3);
    expect(postMock).toHaveBeenCalled();
    expect(restoreMock).not.toHaveBeenCalled();
    expect(body.note).toContain("no dialog of its was seen");
  });

  // win2 2026-11-10: Chrome takes page keys only in front. With another window holding the front from
  // the start, read asks with force once, reads what it can without keys, and says it never got there.
  it("asks with force at the start for a window that takes keys only in front, and says it never came forward", async () => {
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words: makeWords(["A"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(false),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: false, reason: "chromium" }),
    }));
    const restoreMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: vi.fn().mockReturnValue(2n),
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.stoppedReason).toBe("foreground_refused");
    expect(body.note).toContain("did not bring the window to the front");
    expect(body.note).not.toContain("stopped being in front");
    expect(pressKeyMock).not.toHaveBeenCalled();
    // Asked at the start only, plain then forced (as capture is); the page checks and does not ask.
    expect(restoreMock).toHaveBeenCalledTimes(2);
    expect(restoreMock.mock.calls[1]).toEqual([0xCAFEn, { force: true }]);
  });

  it("says the window stopped being in front when it came forward for a later page and then lost it", async () => {
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn()
        .mockResolvedValueOnce({ words: makeWords(["A"]), origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: makeWords(["B"]), origin: { x: 0, y: 0 } })
        .mockResolvedValue({ words: makeWords(["C"]), origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/engine/nutjs.js", () => ({ keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn() } }));
    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestWindow", hwnd: 0xCAFEn, warnings: [] }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(false),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: false, reason: "chromium" }),
    }));
    const restoreMock = vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    // Start: refused (plain, forced, then the title read); page 1's check: in front (the user clicked it);
    // page 2's check: not in front.
    const fg = vi.fn()
      .mockReturnValueOnce(2n).mockReturnValueOnce(2n).mockReturnValueOnce(2n)
      .mockReturnValueOnce(0xCAFEn)
      .mockReturnValue(2n);
    vi.doMock("../../src/engine/win32.js", () => ({
      getForegroundHwnd: fg,
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue("Other"),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreMock,
    }));
    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");
    const result = await scrollReadHandler({ action: "read", windowTitle: "Test", maxPages: 3, scrollKey: "PageDown", scrollDelayMs: 0, stopWhenNoChange: true });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    expect(body.pages).toBe(2);
    expect(body.stoppedReason).toBe("foreground_refused");
    expect(pressKeyMock).toHaveBeenCalledTimes(1);
    expect(body.note).toContain("stopped being in front");
  });

  it("skips BG path entirely when canInjectViaPostMessage reports unsupported (Chromium host) and goes straight to foreground fallback (round-5 regression)", async () => {
    // Chromium-class hosts: PostMessage would silently no-op so the BG
    // dispatch must be gated out before it is even attempted, otherwise the
    // loop would observe "BG ok" + repeated frames and stop on no_change.
    const page1 = makeWords(["A"]);
    const page2 = makeWords(["B"]);

    const restoreAndFocusMock = vi.fn().mockReturnValue({
      x: 0, y: 0, width: 800, height: 600,
    });
    const pressKeyMock = vi.fn().mockResolvedValue(undefined);
    const postKeyMock = vi.fn(); // must NOT be called

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi
        .fn()
        .mockResolvedValueOnce({ words: page1, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page2, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: { pressKey: pressKeyMock, releaseKey: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: postKeyMock,
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: false, reason: "chromium" }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: restoreAndFocusMock,
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 2,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    // postKeyComboToHwnd MUST NOT be invoked when canInject reports unsupported.
    expect(postKeyMock).not.toHaveBeenCalled();
    // Fallback engaged: the window is checked to be in front before the single scroll keystroke; only
    // the initial focus asks (gate 2 on #915).
    expect(restoreAndFocusMock).toHaveBeenCalledTimes(1);
    expect(pressKeyMock).toHaveBeenCalled();
  });

  it("dedupes overlap larger than 20 lines (ArrowDown line-by-line — round-7/8 regression)", async () => {
    // ArrowDown advances by a single line, so adjacent OCR frames overlap
    // by almost a full viewport. With the previous fixed slice(-20) cap,
    // dupCount on page 2 would have been 0 → 30 duplicate "Line2..Line30"
    // copies appended as new content, bloating the output and preventing
    // stopWhenNoChange from firing. With slice(-lines.length) the entire
    // 29-line overlap is detected so only "Line31" is genuinely new.
    const page1 = makeWords(Array.from({ length: 30 }, (_, i) => `Line${i + 1}`));
    const page2 = makeWords([
      ...Array.from({ length: 29 }, (_, i) => `Line${i + 2}`),
      "Line31",
    ]);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi
        .fn()
        .mockResolvedValueOnce({ words: page1, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page2, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 2,
      scrollKey: "ArrowDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(true);
    expect(data.pages).toBe(2);
    expect(data.perPage[1].duplicateLines).toBe(29);
    expect(data.perPage[1].addedLines).toBe(1);
    // Stitched text contains Line1..Line31 with no duplicates.
    const expectedLines = Array.from({ length: 31 }, (_, i) => `Line${i + 1}`).join("\n");
    expect(data.text).toBe(expectedLines);
  });

  it("returns ok:false structured error when OCR throws on the very first page (round-9 regression)", async () => {
    // recognizeWindowByHwnd throws (e.g. target window already closed) before
    // any page is captured — the handler must not let the throw escape; it
    // should return a structured ok:false ToolResult so upstream workflows
    // can observe the failure consistently with other scroll actions.
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockRejectedValue(new Error("PrintWindow failed: window closed")),
      ocrWordsToLines: () => "",
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 5,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("PrintWindow failed: window closed");
  });

  it("preserves partial output and reports stoppedReason='ocr_failed' when OCR throws after some pages (round-9 regression)", async () => {
    // First two pages succeed. Page 3's OCR throws (target window closed
    // mid-read) — we must keep Line1..Line4 (the captured pages) and surface
    // the error alongside ok:true so the caller can use the partial result.
    const page1 = makeWords(["Line1", "Line2"]);
    const page2 = makeWords(["Line3", "Line4"]);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi
        .fn()
        .mockResolvedValueOnce({ words: page1, origin: { x: 0, y: 0 } })
        .mockResolvedValueOnce({ words: page2, origin: { x: 0, y: 0 } })
        .mockRejectedValueOnce(new Error("OCR subprocess crashed")),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
      detectOcrLanguage: () => "en",
      ocrLanguageUsed: () => undefined,
      ocrLanguageWarning: () => null,
    }));
    
    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../../src/tools/_resolve-window.js", () => ({
      resolveWindowTarget: vi.fn().mockResolvedValue({
        title: "TestWindow", hwnd: 0xCAFEn, warnings: [],
      }),
      findPlainTopLevelWindowByTitle: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("../../src/engine/bg-input.js", () => ({
      postKeyComboToHwnd: vi.fn().mockReturnValue(true),
      canInjectAtTarget: vi.fn().mockReturnValue({ supported: true }),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      // internal #326: the window is in front (both resolve to one root).
      enumWindowsInZOrder: vi.fn().mockReturnValue([]),
      getWindowTitleW: vi.fn().mockReturnValue(""),
      getWindowRectByHwnd: vi.fn().mockReturnValue(null),
      getForegroundHwnd: vi.fn().mockReturnValue(0xCAFEn),
      getWindowRoot: vi.fn((h: bigint) => h),
      restoreAndFocusWindow: vi.fn().mockReturnValue({
        x: 0, y: 0, width: 800, height: 600,
      }),
    }));

    const { scrollReadHandler } = await import("../../src/tools/scroll-read.js");

    const result = await scrollReadHandler({
      action: "read",
      windowTitle: "Test",
      maxPages: 5,
      scrollKey: "PageDown",
      scrollDelayMs: 0,
      stopWhenNoChange: true,
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.ok).toBe(true);
    expect(data.stoppedReason).toBe("ocr_failed");
    expect(data.pages).toBe(2);
    expect(data.text).toBe("Line1\nLine2\nLine3\nLine4");
    expect(data.error).toContain("OCR subprocess crashed");
  });
});
