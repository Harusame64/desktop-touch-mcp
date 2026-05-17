/**
 * tests/unit/path-class-contract/e-uia-fallback-ladder.test.ts
 * ADR-020 Phase 2 PR-P2-3 — E 軸 contract test (table + production-invoke).
 *
 * Contract (ADR-020 §4.2 E 行):
 *   (a) ∀ entity ∈ uiaSetValue.advertised.
 *         deriveEntityCapabilities(entity).preferredExecutors[0] === "uia"
 *       (SR-5 BC pin: "uia" stays at index 0 even when "keyboard" promotion lands)
 *   (b) ∀ failure ∈ uiaSetValue ladder.
 *         response.executor === "keyboard" (fallback marker present)
 *         OR throws (ladder exhausted) — silent success forbidden.
 *
 * Round 2 fix (Opus R1 P1-2): the earlier draft (b) cases were 100% tautological
 * (test-internal literals asserted against test-internal literals). This version
 * invokes `createDesktopExecutor()` with an injected mock that forces `uiaSetValue`
 * to throw, exercising the real fallback path at `desktop-executor.ts:180-197`
 * (PR #330's keyboardTypeBg fallback emit + "keyboard" ExecutorKind return).
 *
 * Revert detection:
 *   - Revert PR #330 (keyboardTypeBg fallback ladder + ExecutorKind:"keyboard")
 *     → `uiaSetValue` throw propagates without fallback, the "ladder fallback
 *     returns keyboard" assertion fails on production path.
 *
 * @see docs/adr-020-phase-2-p2-3-contract-test-plan.md §1.1 C (E 軸)
 * @see src/tools/desktop-capabilities.ts:142-146 (ValuePattern → preferred=["uia"])
 * @see src/tools/desktop-executor.ts:180-197 (uiaSetValue → keyboardTypeBg ladder, PR #330)
 */

import { describe, it, expect } from "vitest";
import { deriveEntityCapabilities } from "../../../src/tools/desktop-capabilities.js";
import { createDesktopExecutor, type ExecutorDeps } from "../../../src/tools/desktop-executor.js";
import type { UiEntity, ExecutorKind } from "../../../src/engine/world-graph/types.js";

function makeUiaEntity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e",
    role: "textbox",
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

describe("E contract (a) — uiaSetValue.advertised entity → preferredExecutors[0] === 'uia'", () => {
  const advertisedCases: Array<{ name: string; entity: UiEntity }> = [
    {
      name: "UIA + ValuePattern only (Edit / textbox without Invoke)",
      entity: makeUiaEntity({ patterns: ["ValuePattern"] }),
    },
    {
      name: "UIA + InvokePattern + ValuePattern (Edit with explicit Invoke)",
      entity: makeUiaEntity({ patterns: ["InvokePattern", "ValuePattern"] }),
    },
  ];

  it.each(advertisedCases)("$name → preferredExecutors[0] === 'uia'", ({ entity }) => {
    const cap = deriveEntityCapabilities(entity);
    expect(cap).toBeDefined();
    expect(cap!.preferredExecutors[0]).toBe("uia");
  });

  it("SR-5 BC pin: 'uia' stays at index 0 even if 'keyboard' is later added (ADR-020 §8 R6)", () => {
    const entity = makeUiaEntity({ patterns: ["ValuePattern"] });
    const cap = deriveEntityCapabilities(entity)!;
    expect(cap.preferredExecutors[0]).toBe("uia");
    // Codex R2 P2 fix: dropped `as ExecutorKind` cast — if a future change
    // removes "keyboard" from ExecutorKind, tsc fails here directly (compile-
    // time signal), instead of silently passing through the includes branch.
    if (cap.preferredExecutors.includes("keyboard")) {
      const uiaIdx = cap.preferredExecutors.indexOf("uia");
      const keyboardIdx = cap.preferredExecutors.indexOf("keyboard");
      expect(uiaIdx).toBeLessThan(keyboardIdx);
    }
  });
});

describe("E contract (b) — uiaSetValue ladder (real production-invoke, PR #330)", () => {
  it("uiaSetValue throw + keyboardTypeBg succeeds → returns 'keyboard' ExecutorKind", async () => {
    const mockDeps = makeMockDeps({
      uiaSetValue: async () => { throw new Error("UIA setValue failed (e.g. RichEditD2DPT name unstable)"); },
      // keyboardTypeBg succeeds by default mock (resolves)
    });
    const exec = createDesktopExecutor({ windowTitle: "test-window" }, mockDeps);
    const entity = makeUiaEntity({ patterns: ["ValuePattern"] });

    const outcome = await exec(entity, "type", "hello");

    // PR #330 contract: keyboard fallback returns "keyboard" ExecutorKind
    const kind = typeof outcome === "string" ? outcome : outcome.kind;
    expect(kind).toBe("keyboard");
  });

  it("uiaSetValue + keyboardTypeBg both throw → ladder exhausted error (PR #330)", async () => {
    const mockDeps = makeMockDeps({
      uiaSetValue: async () => { throw new Error("uia failed"); },
      keyboardTypeBg: async () => { throw new Error("WT-XAML host: BG injection unsupported"); },
    });
    const exec = createDesktopExecutor({ windowTitle: "test-window" }, mockDeps);
    const entity = makeUiaEntity({ patterns: ["ValuePattern"] });

    await expect(exec(entity, "type", "hello")).rejects.toThrow(/Type fallback ladder exhausted/);
  });

  it("uiaSetValue happy path returns bare 'uia' string (no fallback needed)", async () => {
    const mockDeps = makeMockDeps();   // all succeed
    const exec = createDesktopExecutor({ windowTitle: "test-window" }, mockDeps);
    const entity = makeUiaEntity({ patterns: ["ValuePattern"] });

    const outcome = await exec(entity, "type", "hello");

    expect(outcome).toBe("uia");
  });
});
