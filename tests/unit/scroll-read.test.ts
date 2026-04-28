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

  it('returns "en" for unknown locale', () => {
    spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "unknown-XX",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "UTC",
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
    expect(detectOcrLanguage()).toBe("en");
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
    }));

    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
      getWindows: vi.fn().mockResolvedValue([
        {
          windowHandle: "fake-hwnd",
          title: "TestWindow",
          region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
          focus: vi.fn().mockResolvedValue(undefined),
        },
      ]),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      getWindowTitleW: vi.fn().mockReturnValue("TestWindow"),
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

  it("stops with stoppedReason=no_change after 2 consecutive no-new-line pages", async () => {
    // Page 1: lines A, B, C
    // Pages 2,3,4: same lines A, B, C (no new content)
    const words = makeWords(["A", "B", "C"]);

    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockResolvedValue({ words, origin: { x: 0, y: 0 } }),
      ocrWordsToLines: (ws: Array<{ text: string }>) => ws.map((w) => w.text).join("\n"),
    }));

    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
      getWindows: vi.fn().mockResolvedValue([
        {
          windowHandle: "fake-hwnd",
          title: "TestWindow",
          region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
          focus: vi.fn().mockResolvedValue(undefined),
        },
      ]),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      getWindowTitleW: vi.fn().mockReturnValue("TestWindow"),
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
    }));

    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
      getWindows: vi.fn().mockResolvedValue([
        {
          windowHandle: "fake-hwnd",
          title: "TestWindow",
          region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
          focus: vi.fn().mockResolvedValue(undefined),
        },
      ]),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      getWindowTitleW: vi.fn().mockReturnValue("TestWindow"),
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
    }));

    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
      getWindows: vi.fn().mockResolvedValue([
        {
          windowHandle: "fake-hwnd",
          title: "TestWindow",
          region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
          focus: vi.fn().mockResolvedValue(undefined),
        },
      ]),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      getWindowTitleW: vi.fn().mockReturnValue("TestWindow"),
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

  it("returns ok:false when no candidate window exposes a usable hwnd (regression for round-3 P2)", async () => {
    // recognizeWindowByHwnd must NOT be reached — the focus guard rejects
    // hwnd-less entries before any OCR is attempted.
    vi.doMock("../../src/engine/ocr-bridge.js", () => ({
      recognizeWindowByHwnd: vi.fn().mockRejectedValue(new Error("must not be called")),
      ocrWordsToLines: () => "",
    }));

    vi.doMock("../../src/engine/nutjs.js", () => ({
      keyboard: {
        pressKey: vi.fn().mockResolvedValue(undefined),
        releaseKey: vi.fn().mockResolvedValue(undefined),
      },
      getWindows: vi.fn().mockResolvedValue([
        {
          windowHandle: null,
          title: "TestWindow",
          region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
          focus: vi.fn().mockResolvedValue(undefined),
        },
        {
          windowHandle: undefined,
          title: "TestWindow",
          region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
          focus: vi.fn().mockResolvedValue(undefined),
        },
      ]),
    }));

    vi.doMock("../../src/engine/win32.js", () => ({
      getWindowTitleW: vi.fn().mockReturnValue("TestWindow"),
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
});
