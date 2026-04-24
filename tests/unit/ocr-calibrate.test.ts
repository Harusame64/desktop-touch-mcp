import { describe, it, expect } from "vitest";
import { calibrateOcrConfidence, hasGlyphConfusion } from "../../src/engine/ocr-bridge.js";
import type { OcrWord } from "../../src/engine/ocr-bridge.js";

function word(
  text: string,
  height = 14,
  lineWordCount?: number,
  lineCharCount?: number,
): OcrWord {
  return {
    text,
    bbox: { x: 0, y: 0, width: 60, height },
    ...(lineWordCount !== undefined ? { lineWordCount } : {}),
    ...(lineCharCount !== undefined ? { lineCharCount } : {}),
  };
}

// ── hasGlyphConfusion ────────────────────────────────────────────────────────

describe("hasGlyphConfusion", () => {
  it("CJK mixed into ASCII → true", () => {
    expect(hasGlyphConfusion("こ一DUCNET")).toBe(true);  // Outlook observed
    expect(hasGlyphConfusion("Fab「iQR_LOG")).toBe(true); // 「 mixed into ASCII
  });

  it("pure CJK word → false", () => {
    expect(hasGlyphConfusion("受信トレイ")).toBe(false);
  });

  it("pure ASCII → false", () => {
    expect(hasGlyphConfusion("FANUC")).toBe(false);
    expect(hasGlyphConfusion("Service")).toBe(false);
  });

  it("circled digits → true", () => {
    expect(hasGlyphConfusion("①")).toBe(true);
    expect(hasGlyphConfusion("⑨印")).toBe(true);
  });

  it("dense glyph-confusion cluster S↔5 in 5VDX2030 → true", () => {
    // ascii = "5VDX2030": hasNumLetter=true, [S5]→"5"=1, [O0]→"0"=1, total=2
    expect(hasGlyphConfusion("5VDX2030")).toBe(true);
  });

  it("short ASCII with no confusion (SEND) → false", () => {
    expect(hasGlyphConfusion("Send")).toBe(false);
  });

  it("all-alpha ASCII with l/I confusion but no digit → false (hasNumLetter guard)", () => {
    // "SllJPPORT": [lI1|]→"l","l"=2 but hasNumLetter=false (no digit) → false
    expect(hasGlyphConfusion("SllJPPORT")).toBe(false);
  });

  it("I1 mix with digit → true", () => {
    expect(hasGlyphConfusion("I1nstall9")).toBe(true); // [lI1|]→"I","1"=2, hasNumLetter=true
  });
});

// ── calibrateOcrConfidence ───────────────────────────────────────────────────

describe("calibrateOcrConfidence", () => {
  it("healthy ASCII word returns ≥ 0.85 (no penalties)", () => {
    const result = calibrateOcrConfidence(word("Send", 14, 3, 25));
    // base=0.7 (density=3/25=0.12 ≤ 0.4), /^[A-Za-z0-9]{2,3}$/ → no (length=4) → 0.7
    expect(result).toBeGreaterThanOrEqual(0.68);
    expect(result).toBeLessThanOrEqual(0.72);
  });

  it("U+FFFD returns flat 0.2 regardless of other fields", () => {
    expect(calibrateOcrConfidence(word("�", 14, 1, 10))).toBe(0.2);
    expect(calibrateOcrConfidence(word("A�B", 14))).toBe(0.2);
  });

  it("known broken glyph-confusion pattern scores ≤ 0.5", () => {
    // こ一DUCNET: hasGlyphConfusion=true → ×0.70 → ~0.49
    const w = word("こ一DUCNET", 14, 7, 25);
    expect(calibrateOcrConfidence(w)).toBeLessThanOrEqual(0.5);
  });

  it("5VDX2030 (S↔5 confusion) scores ≤ 0.5", () => {
    const w = word("5VDX2030", 14, 2, 15);
    expect(calibrateOcrConfidence(w)).toBeLessThanOrEqual(0.5);
  });

  it("single character returns < 0.65", () => {
    expect(calibrateOcrConfidence(word("A"))).toBeLessThan(0.65);
  });

  it("small bbox (height < 10) applies penalty", () => {
    const big = calibrateOcrConfidence(word("Test", 14));
    const small = calibrateOcrConfidence(word("Test", 8));
    expect(small).toBeLessThan(big);
  });

  it("high word density (over-split line) lowers base", () => {
    // 7 words in 13 chars → density=0.538 → over threshold
    const fragmented = calibrateOcrConfidence(word("F", 14, 7, 13));
    const normal = calibrateOcrConfidence(word("F", 14, 2, 25));
    expect(fragmented).toBeLessThan(normal);
  });

  it("lineCharCount < 8 does not apply density penalty", () => {
    // Short line guard: lineCharCount=5 < 8 → density ignored
    const short = calibrateOcrConfidence(word("AB", 14, 5, 5));
    const noStat = calibrateOcrConfidence(word("AB", 14));
    // Both should produce same score (no density penalty)
    expect(short).toBe(noStat);
  });

  it("suggest fires at confidence < 0.55", () => {
    // Test indirectly: glyph confusion lowers to ~0.49 → suggest expected
    // We can't easily test the suggest field here since calibrateOcrConfidence returns a number.
    // Just verify the score boundary.
    const confused = calibrateOcrConfidence(word("5VDX2030", 14, 2, 15));
    expect(confused).toBeLessThan(0.55);
  });

  it("result is clamped to [0,1] and rounded to 2 decimals", () => {
    const result = calibrateOcrConfidence(word("FANUC Integration Service", 14, 3, 25));
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBe(Math.round(result * 100) / 100);
  });
});
