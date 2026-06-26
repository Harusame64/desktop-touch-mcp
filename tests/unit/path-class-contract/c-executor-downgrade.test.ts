/**
 * tests/unit/path-class-contract/c-executor-downgrade.test.ts
 * ADR-020 Phase 2 PR-P2-3 — C 軸 contract test (table + production-invoke).
 *
 * Contract (ADR-020 §4.2 C 行):
 *   ∀ (capabilities, observed_executor).
 *     observed_executor ∈ preferredExecutors(capabilities) ∨ response.downgrade != null
 *
 * Round 2 fix (Opus R1 P1-1): the earlier draft only asserted on hand-built
 * ExecutorOutcome fixtures, which could not catch a PR #332 revert. This
 * version invokes `createDesktopExecutor()` with an injected mock that forces
 * the UIA route to throw, exercising the real fallback path at
 * `desktop-executor.ts:198-218` (PR #332's downgrade marker emit site).
 *
 * Revert detection:
 *   - Revert PR #332 (`return { kind: "mouse", downgrade: {...} }` →
 *     `return "mouse"`) → the `downgrade` marker disappears from the wire
 *     and the "silent UIA→mouse fallback marker present" assertion fails.
 *
 * @see docs/adr-020-phase-2-p2-3-contract-test-plan.md §1.1 C (C 軸)
 * @see src/tools/desktop-capabilities.ts:64 (deriveEntityCapabilities)
 * @see src/tools/desktop-executor.ts:212-217 (downgrade marker emit, PR #332)
 */

import { describe, it, expect } from "vitest";
import { createDefaultCapabilityRegistry } from "../../../src/capabilities/registry.js";

const deriveEntityCapabilities = createDefaultCapabilityRegistry().lookup;
import { createDesktopExecutor, type ExecutorDeps } from "../../../src/tools/desktop-executor.js";
import type { UiEntity, ExecutorKind } from "../../../src/engine/world-graph/types.js";

function makeEntity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e",
    role: "button",
    confidence: 1,
    sources: ["uia"],
    affordances: [],
    generation: "g",
    evidenceDigest: "d",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function makeMockDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: async () => {},
    uiaSetValue: async () => {},
    cdpClick: async () => {},
    cdpFill: async () => {},
    terminalSend: async () => {},
    keyboardTypeBg: async () => {},
    mouseClick: async () => {},
    ...overrides,
  };
}

describe("C contract — preferredExecutors ⇔ observed executor (silent fallback禁止)", () => {
  const tableCases: Array<{
    name: string;
    entity: UiEntity;
    expectedPreferred: ExecutorKind[];
  }> = [
    {
      name: "UIA + InvokePattern → preferredExecutors=['uia','mouse']",
      entity: makeEntity({ patterns: ["InvokePattern"] }),
      expectedPreferred: ["uia", "mouse"],
    },
    {
      // ADR-020 SR-5 PR-SR5-1: ValuePattern entity に "keyboard" 共起 advertise
      // (UIA setValue 優先、失敗時の keyboard recovery 経路を LLM に明示)。
      name: "UIA + ValuePattern (no Invoke) → preferredExecutors=['uia','keyboard']",
      entity: makeEntity({ patterns: ["ValuePattern"], role: "textbox" }),
      expectedPreferred: ["uia", "keyboard"],
    },
    {
      name: "UIA + SelectionOnly controlType (ListItem) → preferredExecutors=['mouse']",
      entity: makeEntity({ controlType: "ListItem", patterns: [] }),
      expectedPreferred: ["mouse"],
    },
    {
      name: "Visual-only (no UIA source) with rect → preferredExecutors=['mouse']",
      entity: makeEntity({ sources: ["visual_gpu"], patterns: [] }),
      expectedPreferred: ["mouse"],
    },
  ];

  it.each(tableCases)("$name", ({ entity, expectedPreferred }) => {
    const cap = deriveEntityCapabilities(entity);
    expect(cap).toBeDefined();
    expect(cap!.preferredExecutors).toEqual(expectedPreferred);
  });

  // Round 2 P1-1 fix: real production invoke of createDesktopExecutor with
  // an injected mock that forces the UIA route to throw, exercising the
  // PR #332 downgrade marker emit at desktop-executor.ts:212-217.
  it("UIA click failure → mouse fallback emits downgrade marker (PR #332 wire-level pin)", async () => {
    const mockDeps = makeMockDeps({
      uiaClick: async () => { throw new Error("InvokePatternNotSupported"); },
    });
    const exec = createDesktopExecutor({ windowTitle: "test-window" }, mockDeps);
    const entity = makeEntity({ patterns: ["InvokePattern"] });

    const outcome = await exec(entity, "click");

    // PR #332 contract: the wire MUST carry { kind: "mouse", downgrade: {...} }
    // — a bare "mouse" string is the pre-PR #332 silent-drift shape that the
    // contract forbids.
    expect(typeof outcome).toBe("object");
    if (typeof outcome === "string") {
      throw new Error(`silent-drift regression: outcome was "${outcome}", expected ExecutorOutcome with downgrade`);
    }
    expect(outcome.kind).toBe("mouse");
    expect(outcome.downgrade).toBeDefined();
    expect(outcome.downgrade!.from).toBe("uia");
    expect(typeof outcome.downgrade!.reason).toBe("string");
    expect(outcome.downgrade!.reason.length).toBeGreaterThan(0);
  });

  it("happy path (UIA click succeeds) returns bare 'uia' string (no downgrade marker)", async () => {
    const mockDeps = makeMockDeps();   // all succeed
    const exec = createDesktopExecutor({ windowTitle: "test-window" }, mockDeps);
    const entity = makeEntity({ patterns: ["InvokePattern"] });

    const outcome = await exec(entity, "click");

    // Happy path: no downgrade needed, executor returns the bare ExecutorKind.
    expect(outcome).toBe("uia");
  });

  it("UIA click failure + no rect → throws (no silent mouse downgrade without rect)", async () => {
    const mockDeps = makeMockDeps({
      uiaClick: async () => { throw new Error("uia failed"); },
    });
    const exec = createDesktopExecutor({ windowTitle: "test-window" }, mockDeps);
    // rect=undefined → mouse fallback impossible
    const entity = makeEntity({ patterns: ["InvokePattern"], rect: undefined });

    await expect(exec(entity, "click")).rejects.toThrow(/UIA click failed/);
  });
});
