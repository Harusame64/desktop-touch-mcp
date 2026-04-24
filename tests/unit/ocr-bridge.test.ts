import { describe, it, expect } from "vitest";
import { mergeNearbyWords, ocrWordsToLines } from "../../src/engine/ocr-bridge.js";
import type { OcrWord } from "../../src/engine/ocr-bridge.js";

function word(text: string, x: number, y: number, w = 20, h = 16, lineWordCount?: number, lineCharCount?: number): OcrWord {
  return { text, bbox: { x, y, width: w, height: h }, ...(lineWordCount !== undefined ? { lineWordCount } : {}), ...(lineCharCount !== undefined ? { lineCharCount } : {}) };
}

describe("mergeNearbyWords", () => {
  it("merges adjacent Japanese single-char words on the same line", () => {
    const words = [word("フ", 0, 0), word("ァ", 20, 0), word("イ", 40, 0), word("ル", 60, 0)];
    const merged = mergeNearbyWords(words, 12);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe("ファイル");
  });

  it("keeps words on different lines separate", () => {
    const words = [word("top", 0, 0), word("bot", 0, 40)];
    const merged = mergeNearbyWords(words);
    expect(merged).toHaveLength(2);
  });
});

describe("mergeNearbyWords — lineWordCount/lineCharCount propagation", () => {
  it("propagates line stats from a single word unchanged", () => {
    const words = [word("FANUC", 0, 0, 50, 12, 3, 23)];
    const merged = mergeNearbyWords(words);
    expect(merged[0]!.lineWordCount).toBe(3);
    expect(merged[0]!.lineCharCount).toBe(23);
  });

  it("takes min of lineWordCount/lineCharCount when merging two words", () => {
    const a = word("FANUC", 0, 0, 50, 12, 3, 23);
    const b = word("Integration", 55, 0, 70, 12, 5, 40);
    const merged = mergeNearbyWords([a, b]);
    expect(merged[0]!.lineWordCount).toBe(3);  // min(3, 5)
    expect(merged[0]!.lineCharCount).toBe(23); // min(23, 40)
  });

  it("omits line stats when neither word has them", () => {
    const words = [word("A", 0, 0), word("B", 25, 0)];
    const merged = mergeNearbyWords(words);
    expect(merged[0]!.lineWordCount).toBeUndefined();
    expect(merged[0]!.lineCharCount).toBeUndefined();
  });

  it("uses the defined value when only one word has line stats", () => {
    const a = word("A", 0, 0, 20, 12, 2, 10);
    const b = word("B", 25, 0, 20, 12);
    const merged = mergeNearbyWords([a, b]);
    expect(merged[0]!.lineWordCount).toBe(2);
    expect(merged[0]!.lineCharCount).toBe(10);
  });
});

describe("ocrWordsToLines", () => {
  it("joins same-line words with spaces and different lines with newlines", () => {
    const words = [
      word("PS", 0, 0), word(">", 30, 0), word("cd", 60, 0),
      word("C:\\>", 0, 40),
    ];
    const out = ocrWordsToLines(words);
    expect(out.split("\n")).toHaveLength(2);
    expect(out.split("\n")[0]).toBe("PS > cd");
    expect(out.split("\n")[1]).toBe("C:\\>");
  });

  it("returns empty string for no words", () => {
    expect(ocrWordsToLines([])).toBe("");
  });
});
