/**
 * keyboard-cjk.test.ts — ADR-018 Phase 2b (§2.4 D4) NON_ASCII_RE coverage.
 *
 * Pins that the broadened non-ASCII detection regex matches CJK, emoji,
 * surrogate pairs, and Latin diacritics — the categories the Win32 keystroke
 * channel cannot deliver reliably and that must auto-upgrade to clipboard.
 *
 * Regex is private to keyboard.ts; we re-create the same pattern here to
 * pin its semantics. If keyboard.ts changes the pattern, this test must
 * be updated in lock-step.
 *
 * See `docs/adr-018-input-pipeline-3tier.md` §2.4 + §2.6.3 background.
 */

import { describe, it, expect } from "vitest";

// Use the public isNonAscii helper (which wraps the private NON_ASCII_RE
// regex declared in src/tools/keyboard.ts) so this test pins the actual
// production contract bit-equally. The legacy NON_ASCII_SYMBOL_RE is private
// to keyboard.ts; we recreate its pattern locally below for the
// subset / superset relation tests.
import { isNonAscii } from "../../src/tools/keyboard.js";
const NON_ASCII_RE = { test: isNonAscii };
const NON_ASCII_SYMBOL_RE = /[–—‘’“”… ]/;

describe("ADR-018 §2.4 D4 — NON_ASCII_RE matches all non-ASCII categories", () => {
  it("Japanese (hiragana / katakana / kanji)", () => {
    expect(NON_ASCII_RE.test("日本語テスト")).toBe(true);
    expect(NON_ASCII_RE.test("こんにちは")).toBe(true);
    expect(NON_ASCII_RE.test("カタカナ")).toBe(true);
  });

  it("Korean (hangul)", () => {
    expect(NON_ASCII_RE.test("한글")).toBe(true);
    expect(NON_ASCII_RE.test("안녕하세요")).toBe(true);
  });

  it("Chinese (simplified + traditional)", () => {
    expect(NON_ASCII_RE.test("中文")).toBe(true);
    expect(NON_ASCII_RE.test("繁體字")).toBe(true);
  });

  it("Emoji (BMP + surrogate pair)", () => {
    expect(NON_ASCII_RE.test("😀")).toBe(true); // U+1F600 (surrogate pair)
    expect(NON_ASCII_RE.test("✓")).toBe(true); // U+2713 (BMP)
    expect(NON_ASCII_RE.test("👍🏼")).toBe(true); // skin-tone modifier sequence
  });

  it("Latin diacritics", () => {
    expect(NON_ASCII_RE.test("résumé")).toBe(true);
    expect(NON_ASCII_RE.test("naïve")).toBe(true);
    expect(NON_ASCII_RE.test("über")).toBe(true);
  });

  it("Other scripts (Greek / Cyrillic / Arabic / Hebrew)", () => {
    expect(NON_ASCII_RE.test("Ελληνικά")).toBe(true);
    expect(NON_ASCII_RE.test("Русский")).toBe(true);
    expect(NON_ASCII_RE.test("العربية")).toBe(true);
    expect(NON_ASCII_RE.test("עברית")).toBe(true);
  });

  it("Pure ASCII text does NOT match (keeps fast keystroke path)", () => {
    expect(NON_ASCII_RE.test("hello world")).toBe(false);
    expect(NON_ASCII_RE.test("ABC abc 123")).toBe(false);
    expect(NON_ASCII_RE.test("!@#$%^&*()_+-=[]{};:'\",.<>/?\\|`~")).toBe(false);
    expect(NON_ASCII_RE.test("Tab\there\nnewline")).toBe(false);
  });

  it("Mixed ASCII + non-ASCII triggers detection (correctness over speed)", () => {
    expect(NON_ASCII_RE.test("Hello 世界")).toBe(true);
    expect(NON_ASCII_RE.test("café")).toBe(true);
    expect(NON_ASCII_RE.test("emoji: 🎉 done")).toBe(true);
  });
});

describe("ADR-018 §2.4 D4 — NON_ASCII_SYMBOL_RE retained for Chrome accelerator hijack defence", () => {
  it("legacy 5-symbol set still detects en-dash, em-dash, smart quotes, ellipsis, NBSP", () => {
    expect(NON_ASCII_SYMBOL_RE.test("a–b")).toBe(true); // U+2013 en-dash
    expect(NON_ASCII_SYMBOL_RE.test("a—b")).toBe(true); // U+2014 em-dash
    expect(NON_ASCII_SYMBOL_RE.test("‘smart’")).toBe(true); // U+2018 / U+2019
    expect(NON_ASCII_SYMBOL_RE.test("“smart”")).toBe(true); // U+201C / U+201D
    expect(NON_ASCII_SYMBOL_RE.test("etc…")).toBe(true); // U+2026 ellipsis
    expect(NON_ASCII_SYMBOL_RE.test("nbsp space")).toBe(true); // U+00A0
  });

  it("does NOT match generic CJK (NON_ASCII_RE handles those)", () => {
    expect(NON_ASCII_SYMBOL_RE.test("日本語")).toBe(false);
    expect(NON_ASCII_SYMBOL_RE.test("résumé")).toBe(false);
  });
});

describe("ADR-018 §2.4 D4 — coverage relationship between the two regexes", () => {
  it("every NON_ASCII_SYMBOL_RE match is also a NON_ASCII_RE match (subset relation)", () => {
    const symbols = ["–", "—", "‘", "’", "“", "”", "…", " "];
    for (const s of symbols) {
      expect(NON_ASCII_SYMBOL_RE.test(s)).toBe(true);
      expect(NON_ASCII_RE.test(s)).toBe(true);
    }
  });

  it("NON_ASCII_RE matches strict superset (CJK, emoji, diacritics not in symbol set)", () => {
    const onlyBroad = ["あ", "한", "中", "😀", "é", "Я"];
    for (const c of onlyBroad) {
      expect(NON_ASCII_SYMBOL_RE.test(c)).toBe(false);
      expect(NON_ASCII_RE.test(c)).toBe(true);
    }
  });
});
