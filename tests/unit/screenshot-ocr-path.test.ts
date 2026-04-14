/**
 * screenshot-ocr-path.test.ts — Unit tests for OCR fallback trigger logic (F2 supplement)
 *
 * The screenshot handler fires OCR when:
 *   1. ocrFallback === "always"  (unconditional)
 *   2. ocrFallback === "auto" AND (actionable.length === 0 OR uiaSparse OR isChromium)
 *
 * This file tests the pure decision logic in isolation — no actual screenshot/OCR needed.
 *
 * Context (Opus review recommendation):
 *   F2 E2E uses VS Code (elementCount=6, uiaSparse=false) and fires OCR via actionable=[].
 *   The sparse threshold boundary (elementCount exactly crossing 5) can only be verified
 *   via unit test since we can't control a real app's element count.
 */

import { describe, it, expect } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Extract the core shouldOcr decision as a pure function (mirrors screenshot.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of the decision logic inside screenshotHandler. */
function shouldFireOcr(opts: {
  ocrFallback: "auto" | "always" | "never";
  actionableCount: number;
  elementCount: number | null;  // null means UIA failed entirely
  isChromium: boolean;
}): { fire: boolean; uiaSparse: boolean } {
  const { ocrFallback, actionableCount, elementCount, isChromium } = opts;
  const uiaSparse = elementCount !== null && elementCount < 5;
  const fire =
    ocrFallback === "always" ||
    (ocrFallback === "auto" && (actionableCount === 0 || uiaSparse || isChromium));
  return { fire, uiaSparse };
}

// ─────────────────────────────────────────────────────────────────────────────
// ocrFallback: 'always'
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldFireOcr — ocrFallback:'always'", () => {
  it("fires regardless of actionable count", () => {
    expect(shouldFireOcr({ ocrFallback: "always", actionableCount: 10, elementCount: 20, isChromium: false }).fire).toBe(true);
  });

  it("fires even when UIA has plenty of elements", () => {
    expect(shouldFireOcr({ ocrFallback: "always", actionableCount: 5, elementCount: 30, isChromium: false }).fire).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ocrFallback: 'never'
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldFireOcr — ocrFallback:'never'", () => {
  it("never fires even when actionable=0", () => {
    expect(shouldFireOcr({ ocrFallback: "never", actionableCount: 0, elementCount: 6, isChromium: false }).fire).toBe(false);
  });

  it("never fires even when sparse", () => {
    expect(shouldFireOcr({ ocrFallback: "never", actionableCount: 0, elementCount: 3, isChromium: false }).fire).toBe(false);
  });

  it("never fires even for Chromium", () => {
    expect(shouldFireOcr({ ocrFallback: "never", actionableCount: 0, elementCount: 2, isChromium: true }).fire).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ocrFallback: 'auto' — actionable=0 trigger
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldFireOcr — auto, actionable=0 trigger", () => {
  it("fires when actionable=0 and elementCount=6 (VS Code scenario)", () => {
    // VS Code: 6 non-actionable Pane elements. uiaSparse=false but fires via actionable=[].
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 0, elementCount: 6, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(false);  // threshold not triggered — OCR fires via actionable path
  });

  it("fires when actionable=0 and elementCount=5 (exactly at threshold)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 0, elementCount: 5, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(false);  // 5 is NOT < 5
  });

  it("does NOT fire when actionable>0 and elementCount=6 (normal app)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 5, elementCount: 6, isChromium: false });
    expect(r.fire).toBe(false);
    expect(r.uiaSparse).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ocrFallback: 'auto' — uiaSparse trigger (elementCount < 5)
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldFireOcr — auto, uiaSparse trigger (elementCount < 5)", () => {
  it("fires when elementCount=4 (just below threshold), even if actionable>0", () => {
    // This is the "threshold miss" bug scenario from the test plan:
    // App returns 4 elements, 2 of which are somehow actionable.
    // Without sparse detection, OCR would NOT fire and LLM sees only 2 items.
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 2, elementCount: 4, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(true);
  });

  it("fires when elementCount=3 (sparse)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 3, elementCount: 3, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(true);
  });

  it("fires when elementCount=1", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 1, elementCount: 1, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(true);
  });

  it("fires when elementCount=0 (UIA returned nothing)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 0, elementCount: 0, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(true);
  });

  it("sparse boundary: elementCount=5 is NOT sparse (≥5)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 3, elementCount: 5, isChromium: false });
    expect(r.uiaSparse).toBe(false);
    // But actionable=3 → fire=false
    expect(r.fire).toBe(false);
  });

  it("sparse boundary: elementCount=4 IS sparse (<5)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 3, elementCount: 4, isChromium: false });
    expect(r.uiaSparse).toBe(true);
    expect(r.fire).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ocrFallback: 'auto' — Chromium trigger
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldFireOcr — auto, Chromium trigger", () => {
  it("fires for Chromium regardless of actionable count and element count", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 10, elementCount: 50, isChromium: true });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(false);
  });

  it("VS Code is NOT Chromium (isChromium=false) — must fire via other paths", () => {
    // VS Code title doesn't match CHROMIUM_TITLE_RE → isChromium=false
    // OCR fires only because actionable=0
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 0, elementCount: 6, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UIA failure (elementCount = null)
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldFireOcr — UIA failed entirely (elementCount=null)", () => {
  it("auto + actionable=0 + null elementCount → fires (actionable=0 trigger)", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 0, elementCount: null, isChromium: false });
    expect(r.fire).toBe(true);
    expect(r.uiaSparse).toBe(false);  // null → uiaSparse=false per implementation
  });

  it("auto + actionable=5 + null elementCount → does NOT fire", () => {
    const r = shouldFireOcr({ ocrFallback: "auto", actionableCount: 5, elementCount: null, isChromium: false });
    expect(r.fire).toBe(false);
  });
});
