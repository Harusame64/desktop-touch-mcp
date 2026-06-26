/**
 * tests/unit/modal-candidate.test.ts — Issue #297.
 *
 * Pins the `isModalCandidate` truth table so the per-clause negation order
 * (self / source / role / chrome) cannot drift silently. Issue #297 added
 * the chrome-exclusion clause (`controlType` in MenuBar / TitleBar / …);
 * without it the LLM saw spurious `blockingElement` hits for focused UI
 * chrome that it cannot dismiss.
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

describe("classifyModal (pre-touch) — Issue #297 truth table", () => {
  const target = makeEntity({ entityId: "target", role: "button" });

  function isModalCandidate(t: UiEntity, c: UiEntity): boolean {
    return classifyModal(c, "pre-touch", { excludeSelf: t });
  }

  it("returns true for a UIA unknown-role overlay (the canonical dialog pattern)", () => {
    const overlay = makeEntity({ entityId: "overlay", role: "unknown" });
    expect(isModalCandidate(target, overlay)).toBe(true);
  });

  it("returns false for the target itself (self-exclusion)", () => {
    expect(isModalCandidate(target, target)).toBe(false);
  });

  it("returns false when the candidate has no UIA source (cdp-only / visual-only)", () => {
    const cdpOverlay = makeEntity({ entityId: "cdp", sources: ["cdp"] });
    expect(isModalCandidate(target, cdpOverlay)).toBe(false);
    const visualOverlay = makeEntity({ entityId: "v", sources: ["visual_gpu"] });
    expect(isModalCandidate(target, visualOverlay)).toBe(false);
  });

  it("returns false when the candidate's role is NOT 'unknown' (e.g. a button)", () => {
    const btn = makeEntity({ entityId: "btn", role: "button" });
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

  it("returns true for a dialog Pane with controlType:'Pane' (NOT in the chrome list)", () => {
    const pane = makeEntity({ entityId: "pane", controlType: "Pane" });
    expect(isModalCandidate(target, pane)).toBe(true);
  });

  it("returns true for a UIA unknown-role entity with NO controlType (legacy / back-compat)", () => {
    // Pre-Issue-#296 producers do not populate controlType. The chrome
    // exclusion is opt-in — a missing field falls through to the original
    // "trust the role:'unknown' signal" behaviour.
    const legacy = makeEntity({ entityId: "legacy" });
    expect(isModalCandidate(target, legacy)).toBe(true);
  });

  it("returns true for multi-source UIA + visual_gpu unknown-role entity", () => {
    const multi = makeEntity({ entityId: "m", sources: ["uia", "visual_gpu"] });
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
