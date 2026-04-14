import { describe, it, expect } from "vitest";
import { mergeNearbyWords, ocrWordsToLines } from "../../src/engine/ocr-bridge.js";
import type { OcrWord } from "../../src/engine/ocr-bridge.js";

function word(text: string, x: number, y: number, w = 20, h = 16): OcrWord {
  return { text, bbox: { x, y, width: w, height: h } };
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
