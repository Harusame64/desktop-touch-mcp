/**
 * tests/unit/path-class-contract/d-modal-classifier.test.ts
 * ADR-020 Phase 2 PR-P2-3 — D 軸 contract test (property-based with fast-check).
 *
 * Contract (ADR-020 §4.2 D 行):
 *   ∀ entity: classifyModal(entity, "pre-touch") ⇔ classifyModal(entity, "post-touch-diff")
 *     (when no excludeSelf is provided in pre-touch context)
 *
 * Pins the unified classifier (PR #336) cannot drift between contexts under
 * any UiEntity shape combination (UIA / non-UIA, role variants, controlType
 * variants including chrome / non-chrome / undefined, single / multi-source).
 *
 * Revert detection (Phase 2 acceptance §4.6 — 代表 3 件 D + F + C):
 *   - Revert PR #331 (isChromeControlType 共有抽出 + isModalLike 同期) → the
 *     pre-touch vs post-touch-diff equivalence breaks on chrome controlType
 *     entities (e.g. MenuBar / TitleBar), this property fails on shrinking.
 *
 * @see docs/adr-020-phase-2-p2-3-contract-test-plan.md §1.1 C (D 軸)
 * @see docs/adr-020-phase-2-p2-1-modal-refactor-plan.md (classifyModal land)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { classifyModal } from "../../../src/engine/world-graph/session-registry.js";
import type { UiEntity } from "../../../src/engine/world-graph/types.js";

// Arbitrary: a UiEntity with plausible shape variation across the dimensions
// the classifier reads (sources / role / controlType). Other fields are kept
// constant (test focuses on the classifier's branching, not entity identity).
const entityArbitrary: fc.Arbitrary<UiEntity> = fc.record({
  entityId: fc.string({ minLength: 1, maxLength: 12 }),
  role: fc.constantFrom(
    "unknown", "button", "textbox", "checkbox", "link", "menuitem", "list",
  ),
  confidence: fc.float({ min: 0, max: 1, noNaN: true }),
  sources: fc.subarray(["uia", "visual_gpu", "cdp", "terminal"] as const, { minLength: 1, maxLength: 4 }),
  affordances: fc.constant([] as never[]),
  generation: fc.constant("g0"),
  evidenceDigest: fc.constant("d0"),
  controlType: fc.option(
    fc.constantFrom(
      // Chrome control types (must classify as non-modal)
      "MenuBar", "Menu", "MenuItem", "TitleBar", "StatusBar", "ToolBar", "ScrollBar", "Tab",
      // Non-chrome control types (must classify as modal when UIA + unknown)
      "Pane", "Window", "Document", "Group", "Custom",
    ),
    { nil: undefined },
  ),
}) as fc.Arbitrary<UiEntity>;

describe("D contract — classifyModal: pre-touch (no excludeSelf) ⇔ post-touch-diff", () => {
  it("classifier result is identical across contexts when excludeSelf is absent (property-based, 100 runs)", () => {
    fc.assert(
      fc.property(entityArbitrary, (entity) => {
        const preTouch = classifyModal(entity, "pre-touch");
        const postTouchDiff = classifyModal(entity, "post-touch-diff");
        expect(preTouch).toBe(postTouchDiff);
      }),
      { numRuns: 100 },
    );
  });

  it("core predicate truth table is preserved (UIA + role:'unknown' + non-chrome → true)", () => {
    fc.assert(
      fc.property(entityArbitrary, (entity) => {
        const isUia = entity.sources.includes("uia");
        const isUnknownRole = entity.role === "unknown";
        const ct = entity.controlType;
        const isChrome = ct !== undefined &&
          new Set(["MenuBar", "Menu", "MenuItem", "TitleBar", "StatusBar", "ToolBar", "ScrollBar", "Tab"]).has(ct);
        const expected = isUia && isUnknownRole && !isChrome;
        expect(classifyModal(entity, "post-touch-diff")).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("pre-touch excludeSelf only affects when entityId matches target (canonical case)", () => {
    fc.assert(
      fc.property(entityArbitrary, (entity) => {
        // self-exclusion shape: pre-touch with excludeSelf = entity itself → always false
        expect(classifyModal(entity, "pre-touch", { excludeSelf: entity })).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
