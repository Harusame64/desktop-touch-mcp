/**
 * tests/unit/action-target-normalize.test.ts
 * Unit tests for normalizeTitle (8 cases required by plan A-1).
 */

import { describe, it, expect } from "vitest";
import { normalizeTitle } from "../../src/engine/perception/action-target.js";

describe("normalizeTitle", () => {
  it("strips '- Google Chrome' suffix", () => {
    expect(normalizeTitle("GitHub - Google Chrome")).toBe("github");
  });

  it("strips '- Google Chrome (Incognito)' suffix", () => {
    expect(normalizeTitle("Settings - Google Chrome (Incognito)")).toBe("settings");
  });

  it("strips '- Microsoft Edge' suffix", () => {
    expect(normalizeTitle("Bing - Microsoft Edge")).toBe("bing");
  });

  it("strips NBSP variant '\\u00A0- Microsoft Edge' suffix", () => {
    expect(normalizeTitle("Bing\u00A0- Microsoft Edge")).toBe("bing");
  });

  it("strips '— Mozilla Firefox' suffix (em-dash)", () => {
    expect(normalizeTitle("Mozilla Support \u2014 Mozilla Firefox")).toBe("mozilla support");
  });

  it("strips '- Mozilla Firefox' suffix", () => {
    expect(normalizeTitle("MDN Web Docs - Mozilla Firefox")).toBe("mdn web docs");
  });

  it("NFC-normalizes decomposed characters (café)", () => {
    // 'é' as decomposed (e + combining accent) → NFC → 'é' as precomposed
    const decomposed = "cafe\u0301";       // 'cafe' + combining acute
    const precomposed = "caf\u00E9";       // 'café' precomposed
    expect(normalizeTitle(decomposed)).toBe(normalizeTitle(precomposed));
  });

  it("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });

  it("handles title longer than 256 characters without suffix", () => {
    const long = "a".repeat(300);
    expect(normalizeTitle(long)).toBe("a".repeat(300));
  });

  it("trims whitespace and lowercases", () => {
    expect(normalizeTitle("  Notepad  ")).toBe("notepad");
  });
});
