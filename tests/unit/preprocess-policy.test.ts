import { describe, it, expect } from "vitest";
import { decideEffectiveScale } from "../../src/engine/ocr-bridge.js";

type Policy = "auto" | "aggressive" | "minimal";

// Shorthand for table-driven tests
function ds(policy: Policy, base: number, mp: number, dpi: number): number {
  return decideEffectiveScale(policy, base, mp, dpi);
}

describe("decideEffectiveScale", () => {
  // ── minimal: always 1 ────────────────────────────────────────────────────

  describe("policy=minimal", () => {
    it("returns 1 regardless of DPI or megapixels", () => {
      expect(ds("minimal", 2, 4, 96)).toBe(1);
      expect(ds("minimal", 2, 4, 144)).toBe(1);
      expect(ds("minimal", 2, 4, 192)).toBe(1);
      expect(ds("minimal", 3, 10, 96)).toBe(1);
      expect(ds("minimal", 4, 10, 192)).toBe(1);
    });
  });

  // ── OOM guard: applies to all non-minimal policies ───────────────────────

  describe("OOM guard (megapixels > 8)", () => {
    it("auto: forces scale=1 when mp > 8", () => {
      expect(ds("auto",       2, 10, 96)).toBe(1);
      expect(ds("auto",       3, 10, 96)).toBe(1);
      expect(ds("aggressive", 2, 10, 96)).toBe(1);
      expect(ds("aggressive", 4, 10, 96)).toBe(1);
    });

    it("OOM guard does not fire at exactly 8MP", () => {
      // 8MP is at the boundary — should NOT be clamped
      expect(ds("auto",       2, 8, 96)).toBe(2);
      expect(ds("aggressive", 2, 8, 96)).toBe(2);
    });
  });

  // ── auto policy ──────────────────────────────────────────────────────────

  describe("policy=auto (DPI threshold=144)", () => {
    it("96dpi (100%) + 4MP → baseScale", () => {
      expect(ds("auto", 2, 4, 96)).toBe(2);
      expect(ds("auto", 3, 4, 96)).toBe(3);
    });

    it("143dpi (< 150%) + 4MP → baseScale", () => {
      expect(ds("auto", 2, 4, 143)).toBe(2);
    });

    it("144dpi (150%) + 4MP → 1 (DPI clamp)", () => {
      expect(ds("auto", 2, 4, 144)).toBe(1);
      expect(ds("auto", 3, 4, 144)).toBe(1);
    });

    it("168dpi (175%) + 4MP → 1 (DPI clamp)", () => {
      expect(ds("auto", 2, 4, 168)).toBe(1);
    });

    it("192dpi (200%) + 4MP → 1 (DPI clamp)", () => {
      expect(ds("auto", 2, 4, 192)).toBe(1);
    });
  });

  // ── aggressive policy ────────────────────────────────────────────────────

  describe("policy=aggressive (DPI threshold=168)", () => {
    it("96dpi + 4MP → baseScale", () => {
      expect(ds("aggressive", 2, 4, 96)).toBe(2);
      expect(ds("aggressive", 3, 4, 96)).toBe(3);
    });

    it("144dpi (150%) + 4MP → baseScale (relaxed clamp)", () => {
      // Key difference from "auto": 144dpi is NOT clamped under "aggressive"
      expect(ds("aggressive", 2, 4, 144)).toBe(2);
      expect(ds("aggressive", 3, 4, 144)).toBe(3);
    });

    it("167dpi (< 175%) + 4MP → baseScale", () => {
      expect(ds("aggressive", 2, 4, 167)).toBe(2);
    });

    it("168dpi (175%) + 4MP → 1 (DPI clamp)", () => {
      expect(ds("aggressive", 2, 4, 168)).toBe(1);
      expect(ds("aggressive", 3, 4, 168)).toBe(1);
    });

    it("192dpi (200%) + 4MP → 1 (DPI clamp)", () => {
      expect(ds("aggressive", 2, 4, 192)).toBe(1);
    });
  });

  // ── edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("baseScale=1 is preserved when no clamp applies", () => {
      expect(ds("auto",       1, 4, 96)).toBe(1);
      expect(ds("aggressive", 1, 4, 96)).toBe(1);
    });

    it("baseScale=4 works with aggressive on low-DPI", () => {
      expect(ds("aggressive", 4, 4, 96)).toBe(4);
    });

    it("OOM guard takes precedence over DPI in aggressive mode", () => {
      // Even if DPI is below threshold, OOM guard fires at >8MP
      expect(ds("aggressive", 2, 9, 96)).toBe(1);
    });
  });
});
