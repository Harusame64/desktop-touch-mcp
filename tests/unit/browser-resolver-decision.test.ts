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

describe("decideActionTarget does not guess among controls a person can each press (internal #420)", () => {
  // A plain radio passes the centre test; two 0x0 radios are pressed through their own labels. A person sees three
  // choices; the strict pass saw one and pressed it (win2 on #1018: by:'role' radio pressed the plain one).
  const plain = facts({ index: 0, chain: [node({ tag: "input", rect: { x: 0, y: 0, w: 13, h: 13 } })] });
  const zero = (i: number) => facts({ index: i, chain: [node({ tag: "input", receivesEvents: false, reachedViaLabel: true, rect: { x: 40 * i, y: 0, w: 0, h: 0 } })] });
  it("is ambiguous when other matches are reached through their own labels", () => {
    expect(decideActionTarget([plain, zero(1), zero(2)], 3).kind).toBe("ambiguous");
  });
  it("still resolves one match that passes the centre test when the others cannot be pressed (covered, no label)", () => {
    const covered = facts({ index: 1, chain: [node({ tag: "input", receivesEvents: false, rect: { x: 40, y: 0, w: 13, h: 13 } })] });
    expect(decideActionTarget([plain, covered], 2).kind).toBe("resolved");
  });
  it("still resolves a widget drawn over the hidden control it stands for (/code-review on #1022)", () => {
    // Choices: an opacity:0 select with its own <label>, under the div[role=combobox] drawn in its place.
    const widget = facts({ index: 0, chain: [node({ tag: "div", role: "combobox", axControl: true, rect: { x: 100, y: 100, w: 240, h: 40 } })] });
    const hiddenSelect = facts({ index: 1, chain: [node({ tag: "select", receivesEvents: false, reachedViaLabel: true, rect: { x: 100, y: 100, w: 240, h: 40 } })] });
    expect(decideActionTarget([widget, hiddenSelect], 2).kind).toBe("resolved");
  });
  it("leaves the loose pass as it was: the gate there is off", () => {
    expect(decideActionTarget([plain, zero(1)], 2, { requireReceivesEvents: false }).kind).toBe("ambiguous");
  });
  it("does not count a label-reached match that is disabled or of another role", () => {
    const off = facts({ index: 1, chain: [node({ tag: "input", enabled: false, receivesEvents: false, reachedViaLabel: true, rect: { x: 40, y: 0, w: 0, h: 0 } })] });
    const wrongRole = facts({ index: 2, chain: [node({ tag: "input", receivesEvents: false, reachedViaLabel: true, roleMatch: false, rect: { x: 80, y: 0, w: 0, h: 0 } })] });
    expect(decideActionTarget([plain, off, wrongRole], 3).kind).toBe("resolved");
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

describe("decideActionTarget — requireReceivesEvents opt (issue #441 selector-rescue scrollIntoView 1st pass)", () => {
  it("default (true): a visible+enabled but off-viewport strong target (receivesEvents=false) → noActionable", () => {
    // The off-viewport visible candidate that the rescue must scroll into view.
    const d = decideActionTarget(
      [facts({ index: 0, chain: [node({ tag: "button", receivesEvents: false })] })],
      1,
    );
    expect(d.kind).toBe("noActionable");
  });

  it("requireReceivesEvents:false: the SAME off-viewport candidate resolves (used to identify it before scrolling)", () => {
    const d = decideActionTarget(
      [facts({ index: 0, chain: [node({ tag: "button", receivesEvents: false, rect: { x: 3, y: 4, w: 5, h: 6 } })] })],
      1,
      { requireReceivesEvents: false },
    );
    expect(d.kind).toBe("resolved");
    if (d.kind === "resolved") {
      expect(d.target).toEqual({ index: 0, rect: { x: 3, y: 4, w: 5, h: 6 }, climbDepth: 0 });
    }
  });

  it("requireReceivesEvents:false still requires visible + enabled (hidden duplicate never resolves)", () => {
    // The hidden zero-size duplicate is filtered out by the gatherer before
    // decide, but even if it reached here, visible:false must keep it out.
    const d = decideActionTarget(
      [facts({ index: 0, chain: [node({ tag: "button", visible: false, receivesEvents: false })] })],
      1,
      { requireReceivesEvents: false },
    );
    expect(d.kind).toBe("noActionable");
  });

  it("requireReceivesEvents:false: two off-viewport visible candidates → ambiguous (scroll won't disambiguate)", () => {
    const d = decideActionTarget(
      [
        facts({ index: 0, name: "A", chain: [node({ tag: "button", receivesEvents: false, rect: { x: 0, y: 0, w: 5, h: 5 } })] }),
        facts({ index: 1, name: "B", chain: [node({ tag: "button", receivesEvents: false, rect: { x: 9, y: 9, w: 5, h: 5 } })] }),
      ],
      2,
      { requireReceivesEvents: false },
    );
    expect(d.kind).toBe("ambiguous");
  });
});

describe("ElementZeroSizeError (issue #441 — cdp-bridge typed zero-size error)", () => {
  it("is an Error subclass with name 'ElementZeroSizeError' and preserves the message", async () => {
    const { ElementZeroSizeError } = await import("../../src/engine/cdp-bridge.js");
    const e = new ElementZeroSizeError("Element has zero size (hidden or not rendered): div[aria-label=\"x\"]");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ElementZeroSizeError);
    expect(e.name).toBe("ElementZeroSizeError");
    // message still matches the legacy /zero size|hidden/i contract (e2e + callers)
    expect(e.message).toMatch(/zero size|hidden/i);
  });
});

describe("decideActionTarget: every match only outside the viewport (issue #441's e2e after a fill)", () => {
  const VP = { innerWidth: 800, innerHeight: 600 };
  const btn = (i: number, rect: { x: number; y: number; w: number; h: number }, p: Partial<ClickableNode> = {}) =>
    facts({ index: i, chain: [node({ tag: "button", receivesEvents: false, scrollsIntoView: true, rect, ...p })] });
  const above = { x: 300, y: -300, w: 100, h: 20 };
  const below = { x: 300, y: 900, w: 100, h: 20 };
  it("says so, with no generic hints, when each pressable match lies wholly outside", () => {
    const d = decideActionTarget([btn(0, above), btn(1, below)], 2, { viewport: VP });
    expect(d).toMatchObject({ kind: "noActionable", offViewport: true });
    if (d.kind === "noActionable") expect(d.next).toEqual([]);
  });
  it("keeps the generic answer when one press is in view (covered), one scrolling never shows, or no viewport is known", () => {
    for (const fs of [
      [btn(0, above), btn(1, { x: 300, y: 580, w: 100, h: 20 })],
      [btn(0, above), btn(1, { x: -9999, y: 0, w: 100, h: 20 }, { scrollsIntoView: false })],
    ]) {
      const d = decideActionTarget(fs, 2, { viewport: VP });
      expect(d.kind).toBe("noActionable");
      expect(d.kind === "noActionable" && d.offViewport).toBeFalsy();
      if (d.kind === "noActionable") expect(d.next).toEqual([...NO_ACTIONABLE_NEXT_HINTS]);
    }
    const none = decideActionTarget([btn(0, above)], 1);
    expect(none.kind === "noActionable" && none.offViewport).toBeFalsy();
    // A cut list (more matches than were read) may hold one in view (/code-review on the #441 fix).
    const cut = decideActionTarget([btn(0, above), btn(1, below)], 12, { viewport: VP });
    expect(cut.kind === "noActionable" && cut.offViewport).toBeFalsy();
  });
  it("counts controls, not matches, ignores matches that are no press, and reads the centre", () => {
    // A button and its own label span climb to one button: one control.
    const twice = decideActionTarget([btn(0, below), btn(1, below)], 2, { viewport: VP });
    expect(twice).toMatchObject({ kind: "noActionable", offViewport: true, offViewportCount: 1 });
    // A disabled button is no press either.
    expect(decideActionTarget([btn(0, above), btn(1, below, { enabled: false })], 2, { viewport: VP })).toMatchObject({ offViewport: true, offViewportCount: 1 });
    // A paragraph with no clickable beside the off-screen button is not a press.
    const text = decideActionTarget([btn(0, below), facts({ index: 1, chain: [node({ receivesEvents: false, rect: { x: 0, y: 100, w: 200, h: 20 } })] })], 2, { viewport: VP });
    expect(text).toMatchObject({ kind: "noActionable", offViewport: true, offViewportCount: 1 });
    // Its top edge in view, its centre below the edge.
    const edge = decideActionTarget([btn(0, { x: 300, y: 590, w: 100, h: 40 })], 1, { viewport: VP });
    expect(edge).toMatchObject({ kind: "noActionable", offViewport: true });
  });
});
