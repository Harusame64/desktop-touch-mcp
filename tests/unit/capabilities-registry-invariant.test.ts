/**
 * capabilities-registry-invariant.test.ts — ADR-020 SR-1 PR-SR1-1.
 *
 * Pins the three registry invariants (北極星 7) for the production
 * `lookupDefault` output plus the `assertCapabilitiesInvariant` defensive
 * guard. Existing rule-table behaviour is covered separately by
 * `tests/unit/desktop-capabilities.test.ts` (14 cases, bit-equal pin); this
 * file targets the invariants themselves:
 *
 *   (a) preferredExecutors.length >= 1                   (non-empty)
 *   (b) preferredExecutors ∩ unsupportedExecutors = ∅    (disjoint)
 *   (c) preferredExecutors ⊆ AdvertisedExecutorKind set  (narrow type)
 *
 * The narrow-type runtime check guards against rule-table edits that
 * accidentally introduce `"keyboard"` (or other non-advertised values) into
 * `preferredExecutors`. This is defense-in-depth — the TypeScript compiler
 * also guards (c) via the `AdvertisedExecutorKind` alias.
 */

import { describe, it, expect } from "vitest";
import {
  createDefaultCapabilityRegistry,
  assertCapabilitiesInvariant,
  bakeEntityCapabilities,
  type AdvertisedExecutorKind,
} from "../../src/capabilities/registry.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { EntityCapabilities } from "../../src/tools/desktop-constraints.js";

const registry = createDefaultCapabilityRegistry();

function makeEntity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e",
    role: "button",
    confidence: 1,
    sources: ["uia"],
    affordances: [],
    generation: "g0",
    evidenceDigest: "d0",
    ...overrides,
  };
}

describe("CapabilityRegistry invariant — sub-plan §4.5 acceptance", () => {
  describe("lookupDefault output (production rule table) satisfies invariants", () => {
    // Each rule branch from `lookupDefault` is exercised with a representative
    // entity; the registry's internal `assertCapabilitiesInvariant` call would
    // throw on any rule-table edit that violates (a), (b), or (c).
    const cases: Array<{ name: string; entity: UiEntity; constraints?: Parameters<typeof registry.lookup>[1] }> = [
      {
        name: "UIA + InvokePattern (Case Invoke happy path)",
        entity: makeEntity({ controlType: "Button", patterns: ["InvokePattern"], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      {
        name: "UIA + SelectionOnly (ListItem) without Invoke",
        entity: makeEntity({ controlType: "ListItem", patterns: [], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      {
        name: "UIA + TogglePattern (CheckBox) without Invoke",
        entity: makeEntity({ controlType: "CheckBox", patterns: ["TogglePattern"], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      {
        name: "UIA + ValuePattern (Edit)",
        entity: makeEntity({ controlType: "Edit", patterns: ["ValuePattern"], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      {
        name: "UIA + no-actionable-pattern + rect (Text label)",
        entity: makeEntity({ controlType: "Text", patterns: [], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      {
        name: "Visual-only with rect",
        entity: makeEntity({ sources: ["visual_gpu"], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      {
        name: "UIA provider_failed view with InvokePattern",
        entity: makeEntity({ controlType: "Button", patterns: ["InvokePattern"], rect: { x: 0, y: 0, width: 10, height: 10 } }),
        constraints: { uia: "provider_failed" },
      },
    ];

    it.each(cases)("$name → invariants hold", ({ entity, constraints }) => {
      const cap = registry.lookup(entity, constraints);
      // `undefined` is allowed (no actionable signal); when defined the
      // invariants must hold.
      if (cap === undefined) return;
      expect(cap.preferredExecutors).toBeDefined();
      expect(cap.preferredExecutors!.length).toBeGreaterThanOrEqual(1);
      // Disjoint
      const unsupported = cap.unsupportedExecutors ?? [];
      for (const p of cap.preferredExecutors!) {
        expect(unsupported).not.toContain(p);
      }
      // Narrow type (re-run assertion for explicit pin)
      expect(() => assertCapabilitiesInvariant(cap)).not.toThrow();
    });
  });

  describe("assertCapabilitiesInvariant defensive guard", () => {
    it("rejects empty preferredExecutors (a)", () => {
      const bad: EntityCapabilities = { preferredExecutors: [] };
      expect(() => assertCapabilitiesInvariant(bad)).toThrow(/length === 0/);
    });

    it("rejects preferred ∩ unsupported overlap (b)", () => {
      const bad: EntityCapabilities = {
        preferredExecutors: ["uia"],
        unsupportedExecutors: ["uia"],
      };
      expect(() => assertCapabilitiesInvariant(bad)).toThrow(/overlap "uia"/);
    });

    it('rejects "keyboard" smuggled into preferredExecutors via unsound cast (c)', () => {
      // The TS narrow type would normally prevent this; the cast simulates
      // a rule-table edit that bypasses the compile-time guard.
      const bad = {
        preferredExecutors: ["keyboard" as unknown as AdvertisedExecutorKind],
      } as EntityCapabilities;
      expect(() => assertCapabilitiesInvariant(bad)).toThrow(
        /ALLOWED_EXECUTORS|narrow type breach/,
      );
    });

    it("accepts a well-formed capability shape", () => {
      const ok: EntityCapabilities = {
        preferredExecutors: ["uia", "mouse"],
        unsupportedExecutors: ["cdp"],
      };
      expect(() => assertCapabilitiesInvariant(ok)).not.toThrow();
    });
  });

  describe("bakeEntityCapabilities (case β entity bake、北極星 8)", () => {
    it("bakes all three fields (preferredExecutors / unsupportedExecutors / fallbackHint) in one batch", () => {
      const entity = makeEntity();
      const cap: EntityCapabilities = {
        preferredExecutors: ["mouse"],
        unsupportedExecutors: ["uia"],
        fallbackHint: "use mouse_click",
      };
      bakeEntityCapabilities(entity, cap);
      expect(entity.preferredExecutors).toEqual(["mouse"]);
      expect(entity.unsupportedExecutors).toEqual(["uia"]);
      expect(entity.fallbackHint).toBe("use mouse_click");
    });

    it("is a no-op when cap is undefined (test direct invoke / legacy path safe)", () => {
      const entity = makeEntity();
      bakeEntityCapabilities(entity, undefined);
      expect(entity.preferredExecutors).toBeUndefined();
      expect(entity.unsupportedExecutors).toBeUndefined();
      expect(entity.fallbackHint).toBeUndefined();
    });

    it("does not bake empty preferredExecutors array (matches pre-SR-1 behaviour)", () => {
      const entity = makeEntity();
      // Synthesise a degenerate shape that bypassed the invariant guard.
      const cap = { preferredExecutors: [] } as EntityCapabilities;
      bakeEntityCapabilities(entity, cap);
      expect(entity.preferredExecutors).toBeUndefined();
    });

    it("copies arrays defensively (caller cannot mutate registry output via entity)", () => {
      const entity = makeEntity();
      const cap: EntityCapabilities = { preferredExecutors: ["mouse"] };
      bakeEntityCapabilities(entity, cap);
      entity.preferredExecutors!.push("uia");
      expect(cap.preferredExecutors).toEqual(["mouse"]); // original untouched
    });
  });

  describe("registry singleton purity (副作用波 6 防止)", () => {
    it("two independent registry instances produce identical output for the same entity", () => {
      const r1 = createDefaultCapabilityRegistry();
      const r2 = createDefaultCapabilityRegistry();
      const entity = makeEntity({ controlType: "Button", patterns: ["InvokePattern"], rect: { x: 0, y: 0, width: 10, height: 10 } });
      expect(r1.lookup(entity)).toEqual(r2.lookup(entity));
    });

    it("toolDescriptionAdvisory returns a non-empty stable string (PR-SR1-3 will derive from rule shape)", () => {
      const r = createDefaultCapabilityRegistry();
      const a = r.toolDescriptionAdvisory();
      const b = r.toolDescriptionAdvisory();
      expect(a.length).toBeGreaterThan(0);
      expect(a).toBe(b);
    });
  });
});
