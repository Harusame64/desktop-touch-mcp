import { describe, it, expect } from "vitest";
import {
  snapToDictionary,
  calibrateOcrConfidence,
  type OcrWord,
  type OcrDictionaryEntry,
} from "../../src/engine/ocr-bridge.js";

function word(
  text: string,
  x = 100,
  y = 100,
  lineWordCount?: number,
  lineCharCount?: number,
): OcrWord {
  return {
    text,
    bbox: { x, y, width: 80, height: 14 },
    ...(lineWordCount !== undefined ? { lineWordCount } : {}),
    ...(lineCharCount !== undefined ? { lineCharCount } : {}),
  };
}

function entry(label: string, rx?: number, ry?: number): OcrDictionaryEntry {
  if (rx === undefined) return { label };
  return { label, rect: { x: rx, y: ry ?? 100, width: 80, height: 14 } };
}

// ── Basic correctness ────────────────────────────────────────────────────────

describe("snapToDictionary — basic correctness", () => {
  it("returns words unchanged when dictionary is empty", () => {
    const words = [word("FANUC")];
    expect(snapToDictionary(words, [])).toStrictEqual(words);
  });

  it("returns unchanged when words is empty", () => {
    expect(snapToDictionary([], [entry("FANUC")])).toStrictEqual([]);
  });

  it("exact match returns word unchanged (no _correctedFrom)", () => {
    const w = word("FANUC");
    const result = snapToDictionary([w], [entry("FANUC")]);
    expect(result[0]!.text).toBe("FANUC");
    expect(result[0]!._correctedFrom).toBeUndefined();
  });

  it("close Levenshtein match snaps to entry.label", () => {
    // "SIJPPORT" → "SUPPORT": distance = 2 (I→U, J→P removed) within threshold
    const result = snapToDictionary([word("SIJPPORT")], [entry("SUPPORT")]);
    expect(result[0]!.text).toBe("SUPPORT");
    expect(result[0]!._correctedFrom).toBe("SIJPPORT");
  });

  it("Outlook PWA canonical case: こ一DUCNET-SIJPPORT → CUSCNET-SUPPORT", () => {
    const result = snapToDictionary(
      [word("こ一DUCNET-SIJPPORT")],
      [entry("CUSCNET-SUPPORT")],
      { maxDistance: 6 } // Levenshtein distance is large; override for this test
    );
    expect(result[0]!.text).toBe("CUSCNET-SUPPORT");
  });
});

// ── Distance threshold ───────────────────────────────────────────────────────

describe("snapToDictionary — distance threshold", () => {
  it("does NOT snap when Levenshtein distance exceeds maxDistance", () => {
    // "HELLO" → "WORLD": distance = 4 > default max(2, ceil(5*0.2))=2
    const result = snapToDictionary([word("HELLO")], [entry("WORLD")]);
    expect(result[0]!.text).toBe("HELLO");
  });

  it("snaps at exactly maxDistance", () => {
    // "SEND" → "BEND": distance=1 ≤ default min(2, ceil(4*0.2))=1
    const result = snapToDictionary([word("SEND")], [entry("BEND")]);
    expect(result[0]!.text).toBe("BEND");
  });

  it("custom maxDistance overrides default", () => {
    // "ABCDE" → "XBCDE": distance=1; default threshold=min(2,1)=1 → snaps
    const r1 = snapToDictionary([word("ABCDE")], [entry("XBCDE")], { maxDistance: 0 });
    expect(r1[0]!.text).toBe("ABCDE"); // maxDistance=0 → no snap

    const r2 = snapToDictionary([word("ABCDE")], [entry("XBCDE")], { maxDistance: 1 });
    expect(r2[0]!.text).toBe("XBCDE"); // maxDistance=1 → snaps
  });
});

// ── Locality filter ──────────────────────────────────────────────────────────

describe("snapToDictionary — locality filter", () => {
  it("snaps when entry rect is close enough", () => {
    // word bbox center ≈ (140, 107); entry rect center ≈ (140, 107) → dist ≈ 0
    const result = snapToDictionary([word("SEND", 100, 100)], [entry("BEND", 100, 100)]);
    expect(result[0]!.text).toBe("BEND");
  });

  it("does NOT snap when entry rect is too far", () => {
    // word center ≈ (140, 107); entry center ≈ (640, 107) → dist ≈ 500 > 200
    const result = snapToDictionary(
      [word("SEND", 100, 100)],
      [entry("BEND", 600, 100)],
    );
    expect(result[0]!.text).toBe("SEND");
  });

  it("snaps when entry has no rect (locality filter skipped)", () => {
    const result = snapToDictionary([word("SEND")], [entry("BEND")]); // no rect
    expect(result[0]!.text).toBe("BEND");
  });
});

// ── Tie-breaking ─────────────────────────────────────────────────────────────

describe("snapToDictionary — tie-breaking", () => {
  it("prefers lower Levenshtein over higher when both in threshold", () => {
    // "FAANUC" → distance to "FANUC"=1, distance to "FABRIC"=3 → prefer "FANUC"
    const result = snapToDictionary(
      [word("FAANUC")],
      [entry("FABRIC"), entry("FANUC")],
      { maxDistance: 3 },
    );
    expect(result[0]!.text).toBe("FANUC");
  });

  it("prefers closer rect when Levenshtein is equal", () => {
    // "XEND" → "SEND"(dist=1, close) vs "BEND"(dist=1, far)
    const near = entry("SEND", 100, 100); // center near word at (100,100)
    const far  = entry("BEND", 600, 100); // center far from word
    const result = snapToDictionary(
      [word("XEND", 100, 100)],
      [far, near],
      { maxDistance: 1 },
    );
    expect(result[0]!.text).toBe("SEND"); // closer rect wins
  });
});

// ── Field preservation ───────────────────────────────────────────────────────

describe("snapToDictionary — field preservation", () => {
  it("preserves lineWordCount and lineCharCount after snap", () => {
    const w = word("SIJPPORT", 100, 100, 3, 25);
    const result = snapToDictionary([w], [entry("SUPPORT")]);
    expect(result[0]!.lineWordCount).toBe(3);
    expect(result[0]!.lineCharCount).toBe(25);
  });

  it("_correctedFrom holds the original OCR text", () => {
    const result = snapToDictionary([word("SIJPPORT")], [entry("SUPPORT")]);
    expect(result[0]!._correctedFrom).toBe("SIJPPORT");
  });

  it("exact match: _correctedFrom is undefined (no-op)", () => {
    const result = snapToDictionary([word("SUPPORT")], [entry("SUPPORT")]);
    expect(result[0]!._correctedFrom).toBeUndefined();
  });

  it("no match: word returned unchanged with no _correctedFrom", () => {
    const result = snapToDictionary([word("HELLO")], [entry("WORLD")]);
    expect(result[0]!.text).toBe("HELLO");
    expect(result[0]!._correctedFrom).toBeUndefined();
  });
});

// ── calibrateOcrConfidence improvement after snap ───────────────────────────

describe("snapToDictionary — confidence improvement", () => {
  it("snapped word has higher confidence than original broken word", () => {
    const broken = word("こ一DUCNET-SIJPPORT", 100, 100, 7, 25);
    const [snapped] = snapToDictionary([broken], [entry("CUSCNET-SUPPORT")], { maxDistance: 10 });
    expect(calibrateOcrConfidence(snapped!)).toBeGreaterThan(
      calibrateOcrConfidence(broken),
    );
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("snapToDictionary — edge cases", () => {
  it("skips dictionary entries with label length < 2", () => {
    const result = snapToDictionary([word("AB")], [{ label: "A" }, entry("AB")]);
    // "A" is skipped (too short), "AB" is exact match → unchanged
    expect(result[0]!.text).toBe("AB");
    expect(result[0]!._correctedFrom).toBeUndefined();
  });

  it("handles multiple words independently", () => {
    const words = [word("SIJPPORT"), word("FANUC"), word("HELLO")];
    const dict = [entry("SUPPORT"), entry("FANUC")];
    const result = snapToDictionary(words, dict);
    expect(result[0]!.text).toBe("SUPPORT");
    expect(result[1]!.text).toBe("FANUC");
    expect(result[1]!._correctedFrom).toBeUndefined();
    expect(result[2]!.text).toBe("HELLO");
  });

  it("NFKC normalisation: fullwidth ASCII matches halfwidth label", () => {
    // Fullwidth "Ａ" (U+FF21) normalises to "A" via NFKC
    const result = snapToDictionary([word("ＡBC")], [entry("ABC")]);
    expect(result[0]!.text).toBe("ABC");
  });
});
