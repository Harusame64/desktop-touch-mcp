/**
 * tests/unit/browser-resolver-decision.test.ts
 * — ADR-023 Phase 1 PR 2: pure action-resolution decision (gather/decide split, §2.bis).
 *
 * The injected JS gathers raw DOM facts (real layout / elementFromPoint); these
 * pure functions make the actionability / climb / uniqueness / ambiguity decision
 * and are unit-testable in node with synthetic CandidateFacts (no DOM). The
 * fact-gatherer + end-to-end pipeline are covered separately by real headless
 * Chrome e2e (tests/e2e/browser-resolver.test.ts).
 *
 * @see src/tools/browser-resolver.ts
 */

import { describe, it, expect } from "vitest";
import {
  clickableStrength,
  isActionable,
  climbToClickable,
  decideActionTarget,
  CLIMB_MAX_DEPTH,
  AMBIGUITY_NEXT_HINTS,
  NO_ACTIONABLE_NEXT_HINTS,
  type ClickableNode,
  type CandidateFacts,
} from "../../src/tools/browser-resolver.js";

function node(p: Partial<ClickableNode> = {}): ClickableNode {
  return {
    tag: "div",
    role: null,
    hasHref: false,
    tabindex: null,
    hasOnclick: false,
    cursorPointer: false,
    visible: true,
    enabled: true,
    receivesEvents: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    ...p,
  };
}

function facts(p: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    index: 0,
    chain: [node()],
    type: "other",
    name: "x",
    role: null,
    ariaLabel: null,
    matchedBy: "text",
    score: 1,
    nearestLabels: [],
    containerHint: null,
    ...p,
  };
}

describe("clickableStrength (ADR §1.2 D4)", () => {
  it("strong: interactive tag / a[href] / ARIA interactive role", () => {
    expect(clickableStrength(node({ tag: "button" }))).toBe("strong");
    expect(clickableStrength(node({ tag: "input" }))).toBe("strong");
    expect(clickableStrength(node({ tag: "a", hasHref: true }))).toBe("strong");
    expect(clickableStrength(node({ tag: "div", role: "button" }))).toBe("strong");
    expect(clickableStrength(node({ tag: "li", role: "menuitem" }))).toBe("strong");
  });

  it("medium: tabindex>=0 or onclick attribute", () => {
    expect(clickableStrength(node({ tabindex: 0 }))).toBe("medium");
    expect(clickableStrength(node({ tabindex: 3 }))).toBe("medium");
    expect(clickableStrength(node({ hasOnclick: true }))).toBe("medium");
  });

  it("weak: cursor:pointer alone", () => {
    expect(clickableStrength(node({ cursorPointer: true }))).toBe("weak");
  });

  it("none: plain element / a without href / negative tabindex", () => {
    expect(clickableStrength(node({ tag: "span" }))).toBe("none");
    expect(clickableStrength(node({ tag: "a", hasHref: false }))).toBe("none");
    expect(clickableStrength(node({ tabindex: -1 }))).toBe("none");
  });
});

describe("isActionable (visible + enabled + receivesEvents)", () => {
  it("true only when all three hold", () => {
    expect(isActionable(node())).toBe(true);
    expect(isActionable(node({ visible: false }))).toBe(false);
    expect(isActionable(node({ enabled: false }))).toBe(false);
    expect(isActionable(node({ receivesEvents: false }))).toBe(false);
  });
});

describe("climbToClickable (ADR §1.2 D4, depth D=3)", () => {
  it("resolves to self when self is strong (depth 0)", () => {
    const r = climbToClickable(facts({ chain: [node({ tag: "button" })] }));
    expect(r).toEqual({ node: expect.objectContaining({ tag: "button" }), depth: 0 });
  });

  it("climbs to the nearest strong ancestor", () => {
    const r = climbToClickable(
      facts({ chain: [node({ tag: "span" }), node({ tag: "i" }), node({ tag: "button", rect: { x: 1, y: 1, w: 5, h: 5 } })] }),
    );
    expect(r?.depth).toBe(2);
    expect(r?.node.tag).toBe("button");
  });

  it("returns null when no strong clickable exists (weak/medium alone never auto-resolve)", () => {
    expect(climbToClickable(facts({ chain: [node({ cursorPointer: true }), node({ tabindex: 0 })] }))).toBeNull();
  });

  it("does not climb beyond CLIMB_MAX_DEPTH", () => {
    // chain index 4 (depth 4) is strong but beyond D=3 → not reached
    const chain = [node(), node(), node(), node(), node({ tag: "button" })];
    expect(chain.length).toBe(CLIMB_MAX_DEPTH + 2);
    expect(climbToClickable(facts({ chain }))).toBeNull();
  });
});

describe("decideActionTarget (ADR §1.2 D3 uniqueness contract)", () => {
  it("resolves when exactly one actionable strong candidate", () => {
    const d = decideActionTarget([facts({ index: 0, chain: [node({ tag: "button", rect: { x: 5, y: 6, w: 7, h: 8 } })] })], 1);
    expect(d.kind).toBe("resolved");
    if (d.kind === "resolved") {
      expect(d.target).toEqual({ index: 0, rect: { x: 5, y: 6, w: 7, h: 8 }, climbDepth: 0 });
    }
  });

  it("dedups candidates that climb to the SAME clickable rect → still resolved", () => {
    const sameRect = { x: 1, y: 1, w: 20, h: 10 };
    const d = decideActionTarget(
      [
        // label span climbs to the button…
        facts({ index: 0, chain: [node({ tag: "span" }), node({ tag: "button", rect: sameRect })] }),
        // …and the button itself also matched
        facts({ index: 1, chain: [node({ tag: "button", rect: sameRect })] }),
      ],
      2,
    );
    expect(d.kind).toBe("resolved");
  });

  it("two distinct actionable targets → ambiguous with fingerprints + fixed next hints", () => {
    const d = decideActionTarget(
      [
        facts({ index: 0, name: "Save", chain: [node({ tag: "button", rect: { x: 0, y: 0, w: 10, h: 10 } })] }),
        facts({ index: 1, name: "Save", chain: [node({ tag: "button", rect: { x: 50, y: 0, w: 10, h: 10 } })] }),
      ],
      2,
    );
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.total).toBe(2);
      expect(d.returned).toBe(2);
      expect(d.candidates.map((c) => c.index)).toEqual([0, 1]);
      expect(d.candidates[0].name).toBe("Save");
      expect(d.next).toEqual([...AMBIGUITY_NEXT_HINTS]);
    }
  });

  it("occluded strong target (receivesEvents=false) is not actionable", () => {
    const d = decideActionTarget(
      [facts({ index: 0, chain: [node({ tag: "button", receivesEvents: false })] })],
      1,
    );
    expect(d.kind).toBe("noActionable");
  });

  it("matches with no strong clickable → noActionable, but candidates are still returned", () => {
    const d = decideActionTarget(
      [
        facts({ index: 0, name: "Row", chain: [node({ cursorPointer: true })] }),
        facts({ index: 1, name: "Row2", chain: [node({ tabindex: 0 })] }),
      ],
      5,
    );
    expect(d.kind).toBe("noActionable");
    if (d.kind === "noActionable") {
      expect(d.total).toBe(5);
      expect(d.returned).toBe(2);
      expect(d.truncated).toBe(true); // 5 > 2
      expect(d.candidates).toHaveLength(2);
      expect(d.next).toEqual([...NO_ACTIONABLE_NEXT_HINTS]);
    }
  });

  it("truncated reflects total > returned in the ambiguous response", () => {
    const d = decideActionTarget(
      [
        facts({ index: 0, chain: [node({ tag: "button", rect: { x: 0, y: 0, w: 1, h: 1 } })] }),
        facts({ index: 1, chain: [node({ tag: "button", rect: { x: 9, y: 9, w: 1, h: 1 } })] }),
      ],
      37,
    );
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.truncated).toBe(true);
      expect(d.total).toBe(37);
    }
  });
});

describe("decideActionTarget — role gate (Codex P1: never resolve to a wrong-role ancestor)", () => {
  it("undefined roleMatch (no role filter) does not gate → resolved", () => {
    const d = decideActionTarget([facts({ index: 0, chain: [node({ tag: "button" })] })], 1);
    expect(d.kind).toBe("resolved");
  });

  it("roleMatch:true on the climbed strong clickable → resolved", () => {
    const d = decideActionTarget(
      [facts({ index: 0, chain: [node({ tag: "span" }), node({ tag: "div", role: "button", roleMatch: true })] })],
      1,
    );
    expect(d.kind).toBe("resolved");
    if (d.kind === "resolved") expect(d.target.climbDepth).toBe(1);
  });

  it("roleMatch:false on the climbed strong clickable → noActionable (not a wrong-role resolve)", () => {
    const d = decideActionTarget(
      [facts({ index: 0, chain: [node({ tag: "span" }), node({ tag: "div", role: "button", roleMatch: false })] })],
      1,
    );
    expect(d.kind).toBe("noActionable");
  });

  it("nested-mixed-role: climb resolves to the nearest strong link (roleMatch:false for button) → noActionable", () => {
    // role:'button' admits this candidate via the farther div[role=button] ancestor
    // (chain-aware pool filter), but the climb stops at the nearer <a href> link,
    // whose roleMatch is false for a button filter → must NOT resolve to the link.
    const d = decideActionTarget(
      [
        facts({
          index: 0,
          chain: [
            node({ tag: "span" }),
            node({ tag: "a", hasHref: true, roleMatch: false }), // nearest strong = link, wrong role
            node({ tag: "div", role: "button", roleMatch: true }), // farther, matches — but not the climb target
          ],
        }),
      ],
      1,
    );
    expect(d.kind).toBe("noActionable");
  });
});
