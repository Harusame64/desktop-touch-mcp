/**
 * tests/unit/modal-candidate.test.ts — Issue #297.
 *
 * Pins the `isModalCandidate` truth table so the per-clause negation order
 * (self / source / controlType) cannot drift silently. Since internal #126 the
 * controlType clause is "is `Window`", which the chrome cells below still pin. Issue #297 added
 * the chrome-exclusion clause (`controlType` in MenuBar / TitleBar / …);
 * without it the LLM saw spurious `blockingElement` hits for focused UI
 * chrome that it cannot dismiss.
 */

import { describe, it, expect } from "vitest";
import { isModalCandidate } from "../../src/engine/world-graph/session-registry.js";
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

describe("isModalCandidate — Issue #297 truth table", () => {
  const target = makeEntity({ entityId: "target", role: "button" });

  it("returns true for a UIA Window (the owned dialog in the owner's tree, internal #126)", () => {
    const dialog = makeEntity({ entityId: "dialog", role: "unknown", controlType: "Window" });
    expect(isModalCandidate(target, dialog)).toBe(true);
  });

  it("returns false for the target itself (self-exclusion)", () => {
    const dialogTarget = makeEntity({ entityId: "target", controlType: "Window" });
    expect(isModalCandidate(dialogTarget, dialogTarget)).toBe(false);
  });

  it("returns false when the candidate has no UIA source (cdp-only / visual-only)", () => {
    const cdpOverlay = makeEntity({ entityId: "cdp", sources: ["cdp"], controlType: "Window" });
    expect(isModalCandidate(target, cdpOverlay)).toBe(false);
    const visualOverlay = makeEntity({ entityId: "v", sources: ["visual_gpu"], controlType: "Window" });
    expect(isModalCandidate(target, visualOverlay)).toBe(false);
  });

  it("returns false for a button (controlType Button, role button)", () => {
    const btn = makeEntity({ entityId: "btn", role: "button", controlType: "Button" });
    expect(isModalCandidate(target, btn)).toBe(false);
  });

  // Issue #297 — UI chrome exclusions
  it.each([
    "MenuBar",
    "Menu",
    "MenuItem",
    "TitleBar",
    "StatusBar",
    "ToolBar",
    "ScrollBar",
    "Tab",
  ])("returns false for chrome controlType=%s on a role:'unknown' UIA entity", (chromeCt) => {
    const chrome = makeEntity({ entityId: "chrome", controlType: chromeCt });
    expect(isModalCandidate(target, chrome)).toBe(false);
  });

  it("returns false for a Pane — it is role:'unknown', and it rang in Explorer and Chrome without a modal (internal #126)", () => {
    const pane = makeEntity({ entityId: "pane", controlType: "Pane" });
    expect(isModalCandidate(target, pane)).toBe(false);
  });

  it("returns false for a UIA unknown-role entity with NO controlType — a missing fact is not a modal", () => {
    // Until internal #126 a missing field fell through to "trust role:'unknown'". The only UIA
    // producer always sets a controlType, so the branch served no producer and refused on a gap.
    const untyped = makeEntity({ entityId: "untyped" });
    expect(isModalCandidate(target, untyped)).toBe(false);
  });

  it("returns true for multi-source UIA + visual_gpu Window", () => {
    const multi = makeEntity({ entityId: "m", sources: ["uia", "visual_gpu"], controlType: "Window" });
    expect(isModalCandidate(target, multi)).toBe(true);
  });

  it("chrome exclusion still applies on multi-source entities (UIA + visual_gpu MenuBar)", () => {
    const multiChrome = makeEntity({
      entityId: "mc",
      sources: ["uia", "visual_gpu"],
      controlType: "MenuBar",
    });
    expect(isModalCandidate(target, multiChrome)).toBe(false);
  });
});
