import { describe, it, expect } from "vitest";
import type { CdpScrollAncestor } from "../../src/engine/cdp-bridge.js";
import type { UiaScrollAncestor } from "../../src/engine/uia-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure-function helpers derived from smart_scroll dispatcher logic
// These are extracted here for unit-testing without real browser/UIA sessions.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of isSelectorLike from smart-scroll.ts */
function isSelectorLike(target: string): boolean {
  return /^[#.\[a-zA-Z]/.test(target.trim());
}

/** Find hidden ancestors (isHidden=true) */
function findHiddenAncestors(ancestors: CdpScrollAncestor[]): CdpScrollAncestor[] {
  return ancestors.filter(a => a.isHidden);
}

/** Find virtualised ancestors */
function findVirtualizedAncestors(ancestors: CdpScrollAncestor[]): CdpScrollAncestor[] {
  return ancestors.filter(a => a.isVirtualized);
}

/** Cap ancestor list to maxDepth */
function capToMaxDepth<T>(ancestors: T[], maxDepth: number): T[] {
  return ancestors.slice(0, maxDepth);
}

// UIA helpers
function hasScrollableAncestor(ancestors: UiaScrollAncestor[]): boolean {
  return ancestors.some(a => a.verticallyScrollable || a.horizontallyScrollable);
}

function innermostPageRatio(ancestors: UiaScrollAncestor[]): number | null {
  const inner = ancestors[ancestors.length - 1];
  if (!inner?.verticallyScrollable) return null;
  return Math.max(0, Math.min(1, inner.verticalPercent / 100));
}

// ─────────────────────────────────────────────────────────────────────────────
// isSelectorLike
// ─────────────────────────────────────────────────────────────────────────────

describe("isSelectorLike", () => {
  it("ID selector", () => expect(isSelectorLike("#foo")).toBe(true));
  it("class selector", () => expect(isSelectorLike(".bar")).toBe(true));
  it("tag selector", () => expect(isSelectorLike("button")).toBe(true));
  it("attribute selector", () => expect(isSelectorLike("[data-index='5']")).toBe(true));
  it("UIA name (spaces, no prefix)", () => expect(isSelectorLike("Create Release")).toBe(true));
  it("UIA name starting with digit — not selector", () => expect(isSelectorLike("3rd item")).toBe(false));
  it("empty string — not selector", () => expect(isSelectorLike("")).toBe(false));
});

// ─────────────────────────────────────────────────────────────────────────────
// CDP ancestor filtering
// ─────────────────────────────────────────────────────────────────────────────

function makeCdpAncestor(overrides: Partial<CdpScrollAncestor> = {}): CdpScrollAncestor {
  return {
    cssSelectorPath: "div",
    scrollTop: 0, scrollLeft: 0,
    scrollHeight: 1000, clientHeight: 400,
    scrollWidth: 200, clientWidth: 200,
    overflowX: "visible", overflowY: "scroll",
    isHidden: false,
    isVirtualized: false,
    ...overrides,
  };
}

describe("CDP ancestor filtering", () => {
  it("findHiddenAncestors — picks only isHidden=true", () => {
    const ancestors: CdpScrollAncestor[] = [
      makeCdpAncestor({ isHidden: false }),
      makeCdpAncestor({ isHidden: true, cssSelectorPath: "#hidden" }),
      makeCdpAncestor({ isHidden: false }),
    ];
    const hidden = findHiddenAncestors(ancestors);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.cssSelectorPath).toBe("#hidden");
  });

  it("findVirtualizedAncestors — picks isVirtualized=true", () => {
    const ancestors: CdpScrollAncestor[] = [
      makeCdpAncestor({ isVirtualized: false }),
      makeCdpAncestor({ isVirtualized: true, cssSelectorPath: ".virtual-list" }),
    ];
    const virtual = findVirtualizedAncestors(ancestors);
    expect(virtual).toHaveLength(1);
    expect(virtual[0]?.cssSelectorPath).toBe(".virtual-list");
  });

  it("capToMaxDepth limits to maxDepth", () => {
    const ancestors = [1, 2, 3, 4, 5].map(i =>
      makeCdpAncestor({ cssSelectorPath: `div${i}` })
    );
    expect(capToMaxDepth(ancestors, 3)).toHaveLength(3);
    expect(capToMaxDepth(ancestors, 10)).toHaveLength(5);
    expect(capToMaxDepth(ancestors, 0)).toHaveLength(0);
  });

  it("overflow:auto is NOT hidden", () => {
    const anc = makeCdpAncestor({ overflowY: "auto", isHidden: false });
    expect(findHiddenAncestors([anc])).toHaveLength(0);
  });

  it("overflow:overlay is NOT hidden", () => {
    const anc = makeCdpAncestor({ overflowY: "overlay", isHidden: false });
    expect(findHiddenAncestors([anc])).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UIA ancestor helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeUiaAncestor(overrides: Partial<UiaScrollAncestor> = {}): UiaScrollAncestor {
  return {
    name: "ScrollViewer",
    automationId: "",
    controlType: "ControlType.ScrollViewer",
    verticalPercent: 0,
    horizontalPercent: 0,
    verticallyScrollable: true,
    horizontallyScrollable: false,
    ...overrides,
  };
}

describe("UIA ancestor helpers", () => {
  it("hasScrollableAncestor — true when at least one scrollable", () => {
    expect(hasScrollableAncestor([makeUiaAncestor()])).toBe(true);
  });

  it("hasScrollableAncestor — false for empty list", () => {
    expect(hasScrollableAncestor([])).toBe(false);
  });

  it("hasScrollableAncestor — false when none scrollable", () => {
    const anc = makeUiaAncestor({ verticallyScrollable: false, horizontallyScrollable: false });
    expect(hasScrollableAncestor([anc])).toBe(false);
  });

  it("innermostPageRatio — computes 0..1 from verticalPercent", () => {
    const ancestors = [
      makeUiaAncestor({ verticalPercent: 0 }),
      makeUiaAncestor({ verticalPercent: 50 }),
    ];
    expect(innermostPageRatio(ancestors)).toBeCloseTo(0.5);
  });

  it("innermostPageRatio — clamps to 0..1", () => {
    const ancestors = [makeUiaAncestor({ verticalPercent: 120 })];
    expect(innermostPageRatio(ancestors)).toBe(1);
    const ancestors2 = [makeUiaAncestor({ verticalPercent: -10 })];
    expect(innermostPageRatio(ancestors2)).toBe(0);
  });

  it("innermostPageRatio — null when not vertically scrollable", () => {
    const ancestors = [makeUiaAncestor({ verticallyScrollable: false })];
    expect(innermostPageRatio(ancestors)).toBeNull();
  });

  it("innermostPageRatio — null for empty list", () => {
    expect(innermostPageRatio([])).toBeNull();
  });
});
