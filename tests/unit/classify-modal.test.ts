/**
 * tests/unit/classify-modal.test.ts — ADR-020 Phase 2 PR-P2-1.
 *
 * Pins the unified `classifyModal(entity, context, options?)` truth table
 * directly (the historical 2-function split `isModalCandidate` / `isModalLike`
 * silently drifted on the chrome-exclusion clause until PR #331; this test
 * pins the merged classifier so the same drift cannot reappear under a new
 * context expansion).
 *
 * Context coverage:
 *   - pre-touch + excludeSelf: self-exclusion clause active
 *   - pre-touch without excludeSelf: core predicate only
 *   - post-touch-diff: core predicate only (no self-exclusion)
 *
 * The legacy `isModalCandidate` / `isModalLike` behaviours are pinned by their
 * own tests (`modal-candidate.test.ts` + `guarded-touch.test.ts`) which now
 * route through this classifier — keeping both layers guarantees BC.
 */

import { describe, it, expect } from "vitest";
import { classifyModal } from "../../src/engine/world-graph/session-registry.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

function makeEntity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "ent-default",
    role: "unknown",
    confidence: 1,
    sources: ["uia"],
    affordances: [],
    generation: "g0",
    evidenceDigest: "d0",
    ...overrides,
  };
}

describe("classifyModal — ADR-020 PR-P2-1 unified classifier", () => {
  describe("core predicate (both contexts share)", () => {
    it("returns true for a UIA unknown-role overlay (canonical dialog) in pre-touch", () => {
      const overlay = makeEntity({ entityId: "overlay" });
      expect(classifyModal(overlay, "pre-touch")).toBe(true);
    });

    it("returns true for a UIA unknown-role overlay in post-touch-diff", () => {
      const overlay = makeEntity({ entityId: "overlay" });
      expect(classifyModal(overlay, "post-touch-diff")).toBe(true);
    });

    it("returns false when sources lacks 'uia' (cdp-only / visual-only)", () => {
      const cdp = makeEntity({ entityId: "cdp", sources: ["cdp"] });
      expect(classifyModal(cdp, "pre-touch")).toBe(false);
      expect(classifyModal(cdp, "post-touch-diff")).toBe(false);
    });

    it("returns false when role is NOT 'unknown' (e.g. button)", () => {
      const btn = makeEntity({ entityId: "btn", role: "button" });
      expect(classifyModal(btn, "pre-touch")).toBe(false);
      expect(classifyModal(btn, "post-touch-diff")).toBe(false);
    });

    it.each([
      "MenuBar", "Menu", "MenuItem", "TitleBar",
      "StatusBar", "ToolBar", "ScrollBar", "Tab",
    ])("returns false for chrome controlType=%s in both contexts", (chromeCt) => {
      const chrome = makeEntity({ entityId: "chrome", controlType: chromeCt });
      expect(classifyModal(chrome, "pre-touch")).toBe(false);
      expect(classifyModal(chrome, "post-touch-diff")).toBe(false);
    });

    it("returns true for non-chrome controlType (e.g. Pane) in both contexts", () => {
      const pane = makeEntity({ entityId: "pane", controlType: "Pane" });
      expect(classifyModal(pane, "pre-touch")).toBe(true);
      expect(classifyModal(pane, "post-touch-diff")).toBe(true);
    });

    it("returns true when controlType is undefined (pre-#296 producer back-compat)", () => {
      const legacy = makeEntity({ entityId: "legacy" });
      expect(classifyModal(legacy, "pre-touch")).toBe(true);
      expect(classifyModal(legacy, "post-touch-diff")).toBe(true);
    });
  });

  describe("self-exclusion clause (pre-touch + excludeSelf only)", () => {
    const target = makeEntity({ entityId: "target", role: "button" });

    it("returns false for the target itself when excludeSelf is provided (pre-touch)", () => {
      // Even when the candidate would otherwise satisfy the core predicate,
      // self-exclusion wins to keep a dialog from blocking its own children (Issue #63).
      const selfWithModalShape = makeEntity({ entityId: "target" });
      expect(classifyModal(selfWithModalShape, "pre-touch", { excludeSelf: target })).toBe(false);
    });

    it("returns true for a non-self entity even when excludeSelf is provided (pre-touch)", () => {
      const other = makeEntity({ entityId: "other" });
      expect(classifyModal(other, "pre-touch", { excludeSelf: target })).toBe(true);
    });

    it("ignores excludeSelf in post-touch-diff context (no self-exclusion)", () => {
      // post-touch-diff context: the `touched` entity is handled by a separate layer
      // in computeDiff, so self-exclusion must not leak here. A modal-shaped entity
      // matching target.entityId must still classify as modal in post-touch context.
      const selfWithModalShape = makeEntity({ entityId: "target" });
      expect(classifyModal(selfWithModalShape, "post-touch-diff", { excludeSelf: target })).toBe(true);
    });
  });
});
