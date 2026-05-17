/**
 * desktop-capabilities.test.ts — Issue #296.
 *
 * Pins the `deriveEntityCapabilities` rule table. Pure function — no mocks,
 * no fixtures, no UIA round-trips. Each case targets one rule branch so a
 * future refactor that drops a branch lands a discrete test failure rather
 * than a silent capability regression.
 */

import { describe, it, expect } from "vitest";
import { deriveEntityCapabilities } from "../../src/tools/desktop-capabilities.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

function makeEntity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "test-entity",
    role: "button",
    confidence: 1,
    sources: ["uia"],
    affordances: [],
    generation: "g0",
    evidenceDigest: "d0",
    ...overrides,
  };
}

describe("deriveEntityCapabilities — Issue #296", () => {
  it("UIA + InvokePattern → preferredExecutors:['uia','mouse'] (standard happy path)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "Button",
        patterns: ["InvokePattern"],
        rect: { x: 10, y: 10, width: 40, height: 20 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["uia", "mouse"]);
    expect(cap?.unsupportedExecutors).toBeUndefined();
    expect(cap?.fallbackHint).toBeUndefined();
  });

  it("UIA + ListItem + no InvokePattern → unsupportedExecutors:['uia'] (user report)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "ListItem",
        patterns: ["SelectionItemPattern"],
        rect: { x: 0, y: 0, width: 200, height: 28 },
      }),
    );
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.fallbackHint).toContain("mouse_click");
    expect(cap?.fallbackHint).toContain("ListItem");
  });

  it("UIA + TabItem + no InvokePattern → unsupportedExecutors:['uia'] with TabItem hint", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "TabItem",
        patterns: ["SelectionItemPattern"],
        rect: { x: 0, y: 0, width: 100, height: 28 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
    expect(cap?.fallbackHint).toContain("TabItem");
  });

  it("UIA + TogglePattern-only (no Invoke) → preferredExecutors:['mouse'] (executor doesn't speak Toggle yet)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "CheckBox",
        patterns: ["TogglePattern"],
        rect: { x: 0, y: 0, width: 30, height: 30 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
    expect(cap?.fallbackHint).toContain("TogglePattern");
  });

  it("UIA + InvokePattern + Toggle → Invoke wins (happy path takes precedence)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "CheckBox",
        patterns: ["InvokePattern", "TogglePattern"],
        rect: { x: 0, y: 0, width: 30, height: 30 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["uia", "mouse"]);
    expect(cap?.unsupportedExecutors).toBeUndefined();
  });

  it("UIA + ValuePattern (Edit) → preferredExecutors:['uia','keyboard'] (ADR-020 SR-5: keyboard co-advertised as UIA setValue recovery)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        role: "textbox",
        controlType: "Edit",
        patterns: ["ValuePattern"],
        rect: { x: 0, y: 0, width: 200, height: 24 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["uia", "keyboard"]);
    expect(cap?.unsupportedExecutors).toBeUndefined();
  });

  it("UIA + no actionable pattern + has rect → mouse fallback", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "Text",
        patterns: [],
        rect: { x: 0, y: 0, width: 100, height: 20 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
  });

  it("UIA + no patterns + no rect → undefined (no actionable signal)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "Text",
        patterns: [],
      }),
    );
    expect(cap).toBeUndefined();
  });

  it("visual-only entity (no UIA source) with rect → mouse, uia unsupported", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        sources: ["visual_gpu"],
        rect: { x: 0, y: 0, width: 80, height: 80 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
  });

  it("non-UIA source + no rect → undefined", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        sources: ["visual_gpu"],
      }),
    );
    expect(cap).toBeUndefined();
  });

  it("multi-source (uia + visual_gpu) with InvokePattern → uia path wins", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        sources: ["uia", "visual_gpu"],
        controlType: "Button",
        patterns: ["InvokePattern"],
        rect: { x: 0, y: 0, width: 60, height: 24 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["uia", "mouse"]);
  });

  it("viewConstraints.uia='provider_failed' biases UIA-sourced entity to mouse even with InvokePattern", () => {
    // Defensive: the provider already reported it failed for this view, so
    // believing the per-element pattern data would lead the LLM into the same
    // failure mode again. The capability hint reflects the system-level signal.
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "Button",
        patterns: ["InvokePattern"],
        rect: { x: 0, y: 0, width: 60, height: 24 },
      }),
      { uia: "provider_failed" },
    );
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
    expect(cap?.fallbackHint).toContain("UIA provider failed");
  });

  it("viewConstraints.uia='provider_failed' with no rect → undefined (nothing actionable)", () => {
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "Button",
        patterns: ["InvokePattern"],
      }),
      { uia: "provider_failed" },
    );
    expect(cap).toBeUndefined();
  });

  it("patterns array undefined (only happens for non-UIA entities) → mouse if rect, undefined otherwise", () => {
    // UIA-sourced entity should always have a `patterns` field from the
    // resolver (empty array when UIA found no patterns) — but defensively,
    // a UIA-sourced entity with patterns:undefined acts like patterns:[].
    const cap = deriveEntityCapabilities(
      makeEntity({
        controlType: "Custom",
        rect: { x: 0, y: 0, width: 40, height: 40 },
      }),
    );
    expect(cap?.preferredExecutors).toEqual(["mouse"]);
    expect(cap?.unsupportedExecutors).toEqual(["uia"]);
  });
});
