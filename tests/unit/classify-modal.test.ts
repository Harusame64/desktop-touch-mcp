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

// What UIA reported for the two real modals win2 read (internal `b9319d7`): a WinForms
// `ShowDialog` form and a `#32770` MessageBox, both in the owner's tree as controlType `Window`.
const dialogWindow = (overrides: Partial<UiEntity> = {}) => makeEntity({ controlType: "Window", ...overrides });

describe("classifyModal — ADR-020 PR-P2-1 unified classifier", () => {
  describe("core predicate (both contexts share)", () => {
    it("returns true for a UIA Window (the owned dialog in the owner's tree) in pre-touch", () => {
      expect(classifyModal(dialogWindow({ entityId: "dialog" }), "pre-touch")).toBe(true);
    });

    it("returns true for a UIA Window in post-touch-diff", () => {
      expect(classifyModal(dialogWindow({ entityId: "dialog" }), "post-touch-diff")).toBe(true);
    });

    it("returns false when sources lacks 'uia' (cdp-only / visual-only)", () => {
      const cdp = dialogWindow({ entityId: "cdp", sources: ["cdp"] });
      expect(classifyModal(cdp, "pre-touch")).toBe(false);
      expect(classifyModal(cdp, "post-touch-diff")).toBe(false);
    });

    it("returns true for a multi-source UIA + visual_gpu Window", () => {
      expect(classifyModal(dialogWindow({ entityId: "multi", sources: ["uia", "visual_gpu"] }), "pre-touch")).toBe(true);
    });

    // internal #126 half 2 — every control type the old predicate rang on in win2's inventory
    // (`b9319d7`: a WinForms widget window, Explorer, Windows Terminal; Chrome's root pane in
    // `89797ae`). None was a modal. All of them are `role:"unknown"`, which is why "role unknown"
    // cannot be the test.
    it.each([
      "Spinner", "Thumb", "Pane", "TabItem", "SplitButton", "Table", "Group", "Custom",
      "Header", "HeaderItem", "DataItem", "ListItem", "TreeItem", "Tree", "List",
    ])("returns false for controlType=%s — measured, never a modal", (ct) => {
      const widget = makeEntity({ entityId: "widget", controlType: ct });
      expect(classifyModal(widget, "pre-touch")).toBe(false);
      expect(classifyModal(widget, "post-touch-diff")).toBe(false);
    });

    it.each([
      "MenuBar", "Menu", "MenuItem", "TitleBar",
      "StatusBar", "ToolBar", "ScrollBar", "Tab",
    ])("returns false for chrome controlType=%s in both contexts", (chromeCt) => {
      const chrome = makeEntity({ entityId: "chrome", controlType: chromeCt });
      expect(classifyModal(chrome, "pre-touch")).toBe(false);
      expect(classifyModal(chrome, "post-touch-diff")).toBe(false);
    });

    it("returns false when controlType is missing — a missing fact is not a modal", () => {
      // The only UIA producer always sets one (`uia-provider.ts`); the old "no type → trust
      // role:'unknown'" branch turned an absent fact into a refusal.
      const untyped = makeEntity({ entityId: "untyped" });
      expect(classifyModal(untyped, "pre-touch")).toBe(false);
      expect(classifyModal(untyped, "post-touch-diff")).toBe(false);
      expect(classifyModal(makeEntity({ entityId: "empty", controlType: "" }), "pre-touch")).toBe(false);
    });
  });

  describe("self-exclusion clause (pre-touch + excludeSelf only)", () => {
    const target = makeEntity({ entityId: "target", role: "button" });

    it("returns false for the target itself when excludeSelf is provided (pre-touch)", () => {
      // Even when the candidate would otherwise satisfy the core predicate,
      // self-exclusion wins to keep a dialog from blocking its own children (Issue #63).
      const selfWithModalShape = dialogWindow({ entityId: "target" });
      expect(classifyModal(selfWithModalShape, "pre-touch", { excludeSelf: target })).toBe(false);
    });

    it("returns true for a non-self entity even when excludeSelf is provided (pre-touch)", () => {
      const other = dialogWindow({ entityId: "other" });
      expect(classifyModal(other, "pre-touch", { excludeSelf: target })).toBe(true);
    });

    it("ignores excludeSelf in post-touch-diff context (no self-exclusion)", () => {
      // post-touch-diff context: the `touched` entity is handled by a separate layer
      // in computeDiff, so self-exclusion must not leak here. A modal-shaped entity
      // matching target.entityId must still classify as modal in post-touch context.
      const selfWithModalShape = dialogWindow({ entityId: "target" });
      expect(classifyModal(selfWithModalShape, "post-touch-diff", { excludeSelf: target })).toBe(true);
    });
  });
});
