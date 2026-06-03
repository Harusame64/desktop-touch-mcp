import { describe, it, expect } from "vitest";
import {
  shouldReturnRoiCapture,
  type ReturnCaptureMode,
  type RoiCaptureGateInput,
} from "../../src/tools/_roi-capture-gate.js";
import type { VisualMotionObservation } from "../../src/tools/_input-pipeline.js";

// The full 5-valued motion enum (ADR-024 §2.5.3 — type SSOT is
// _input-pipeline.ts, NOT the 3-valued any-change.ts docstring) plus `undefined`
// (no observation attached, e.g. Stage 5 DXGI disabled).
const ALL_MOTIONS: Array<VisualMotionObservation["motion"] | undefined> = [
  "translation",
  "local_repaint",
  "any_change",
  "no_change",
  "indeterminate",
  undefined,
];
const CHANGED = new Set(["translation", "local_repaint", "any_change"]);
const ALL_MODES: Array<ReturnCaptureMode | undefined> = ["on-change", "always", "never", undefined];

const gate = (over: Partial<RoiCaptureGateInput>): boolean =>
  shouldReturnRoiCapture({
    ok: true,
    visualOnly: true,
    motion: "any_change",
    returnCapture: undefined,
    ...over,
  });

describe("shouldReturnRoiCapture", () => {
  describe("hard guard: ok", () => {
    it("never attaches when the act failed, for any mode/motion", () => {
      for (const returnCapture of ALL_MODES) {
        for (const motion of ALL_MOTIONS) {
          expect(gate({ ok: false, returnCapture, motion })).toBe(false);
        }
      }
    });
  });

  describe("hard guard: visualOnly", () => {
    it("never attaches on a non-visual-only target, even for 'always'", () => {
      for (const returnCapture of ALL_MODES) {
        for (const motion of ALL_MOTIONS) {
          expect(gate({ visualOnly: false, returnCapture, motion })).toBe(false);
        }
      }
    });
  });

  describe("returnCapture = 'never'", () => {
    it("suppresses capture regardless of motion", () => {
      for (const motion of ALL_MOTIONS) {
        expect(gate({ returnCapture: "never", motion })).toBe(false);
      }
    });
  });

  describe("returnCapture = 'always'", () => {
    it("attaches on any successful visual-only act, ignoring motion", () => {
      for (const motion of ALL_MOTIONS) {
        expect(gate({ returnCapture: "always", motion })).toBe(true);
      }
    });
  });

  describe("auto regime gate (undefined) and 'on-change'", () => {
    for (const returnCapture of [undefined, "on-change"] as const) {
      describe(`returnCapture = ${String(returnCapture)}`, () => {
        for (const motion of ALL_MOTIONS) {
          const expected = motion !== undefined && CHANGED.has(motion);
          it(`motion=${String(motion)} → ${expected}`, () => {
            expect(gate({ returnCapture, motion })).toBe(expected);
          });
        }
      });
    }

    it("excludes 'indeterminate' (unverifiable, e.g. DXGI unavailable over RDP)", () => {
      expect(gate({ returnCapture: "on-change", motion: "indeterminate" })).toBe(false);
    });

    it("excludes 'no_change' (nothing happened)", () => {
      expect(gate({ returnCapture: "on-change", motion: "no_change" })).toBe(false);
    });
  });
});
