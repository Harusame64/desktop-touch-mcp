/**
 * smart-scroll-body.test.ts — ADR-018 Phase 3 / §5 R3 regression fix pin.
 *
 * The pre-Phase-3 implementation built a scrollExpr like:
 *
 *   const el = document.querySelector('body');
 *   el.scrollIntoView({block:'center', behavior:'instant'});
 *
 * which Chromium interprets as "snap viewport to the body's top edge" — the
 * `scrollTop` is reset to 0 even when the page was scrolled. ADR §1.1 symptom 4
 * captured this as a silent reverse-direction scroll. The Phase 3 fix swaps the
 * `target='body'` / `target='html'` path to the two-step
 * `document.scrollingElement || document.documentElement` query and skips
 * `scrollIntoView` entirely for the document root (it's in view by definition).
 *
 * This test pins the *expression string* sent to CDP so a future refactor
 * cannot silently reintroduce the regression.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// CDP bridge mock — captures every `evaluateInTab` invocation so the test
// can inspect the JS expression sent to the browser. `getScrollAncestorsCdp`
// is stubbed to "no ancestors" so the CDP path proceeds straight to the
// scrollExpr step.
const evaluateInTabMock = vi.fn();
const getScrollAncestorsCdpMock = vi.fn();
const detectStickyHeaderCdpMock = vi.fn();
const setScrollPositionCdpMock = vi.fn();
const scrollVirtualListCdpMock = vi.fn();

vi.mock("../../src/engine/cdp-bridge.js", () => ({
  evaluateInTab: evaluateInTabMock,
  getScrollAncestorsCdp: getScrollAncestorsCdpMock,
  detectStickyHeaderCdp: detectStickyHeaderCdpMock,
  setScrollPositionCdp: setScrollPositionCdpMock,
  scrollVirtualListCdp: scrollVirtualListCdpMock,
}));

// smart-scroll imports several engine modules that the CDP-strategy code path
// never reaches; mock them as no-ops so the SUT loads without native binaries.
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getScrollAncestors: vi.fn().mockResolvedValue([]),
  scrollByPercent: vi.fn(),
  scrollElementIntoView: vi.fn(),
}));
vi.mock("../../src/engine/win32.js", () => ({
  readScrollInfo: vi.fn(),
  enumWindowsInZOrder: vi.fn().mockReturnValue([]),
  restoreAndFocusWindow: vi.fn(),
}));
vi.mock("../../src/engine/image.js", () => ({
  dHashFromRaw: vi.fn(),
  hammingDistance: vi.fn(),
  extractStripRaw: vi.fn(),
  detectScrollThumbFromStrip: vi.fn(),
}));
vi.mock("../../src/engine/layer-buffer.js", () => ({
  captureWindowRawAndHash: vi.fn(),
  getCachedRaw: vi.fn(),
}));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    scrollDown: vi.fn(),
    scrollUp: vi.fn(),
    scrollLeft: vi.fn(),
    scrollRight: vi.fn(),
  },
}));
vi.mock("../../src/utils/desktop-config.js", () => ({
  getCdpPort: vi.fn(() => 9222),
}));

const { smartScrollHandler } = await import("../../src/tools/smart-scroll.js");

const baseParams = {
  port: 9222,
  strategy: "cdp" as const,
  direction: "into-view" as const,
  inline: "center" as const,
  maxDepth: 3,
  retryCount: 3,
  verifyWithHash: false,
  expandHidden: false,
};

describe("smart-scroll target='body' — ADR-018 Phase 3 / §5 R3 fix", () => {
  beforeEach(() => {
    evaluateInTabMock.mockReset();
    getScrollAncestorsCdpMock.mockReset();
    detectStickyHeaderCdpMock.mockReset();
    setScrollPositionCdpMock.mockReset();
    scrollVirtualListCdpMock.mockReset();

    getScrollAncestorsCdpMock.mockResolvedValue({ ancestors: [], warnings: [] });
    detectStickyHeaderCdpMock.mockResolvedValue({ occluded: false });

    // The CDP path issues 4 evaluateInTab calls (restore, scrollExpr,
    // finalState) when ancestors is empty + expandHidden is false. The mock
    // returns a benign shape for each — the test asserts on the expression
    // *sent*, not on what comes back.
    evaluateInTabMock.mockImplementation((expr: string) => {
      if (expr.includes("scrollIntoView") || expr.includes("scrollingElement")) {
        return Promise.resolve({ ok: true, viewportTop: 0, viewportBottom: 100 });
      }
      if (expr.includes("viewportPosition")) {
        return Promise.resolve({ viewportPosition: "in-view", pageRatio: 0.5 });
      }
      return Promise.resolve(undefined);
    });
  });

  function findScrollExprCall(): string {
    // The scrollExpr is the only one that mentions both `scrollingElement` and
    // `isRoot` (post-Phase-3 contract). Pick that one specifically — the
    // restore expression also touches the DOM but does not reference these
    // identifiers.
    const calls = evaluateInTabMock.mock.calls.filter((call) => {
      const expr = String(call[0]);
      return expr.includes("scrollingElement") && expr.includes("isRoot");
    });
    if (calls.length === 0) {
      throw new Error(
        `No scrollExpr call captured. All calls: ${JSON.stringify(
          evaluateInTabMock.mock.calls.map((c) => String(c[0]).slice(0, 80)),
        )}`,
      );
    }
    return String(calls[0]![0]);
  }

  it("target='body': scrollExpr uses document.scrollingElement (two-step query), NOT document.querySelector('body').scrollIntoView", async () => {
    await smartScrollHandler({ ...baseParams, target: "body" });
    const scrollExpr = findScrollExprCall();
    expect(scrollExpr).toContain("document.scrollingElement");
    expect(scrollExpr).toContain("document.documentElement");
  });

  it("target='body': scrollIntoView is gated behind `!isRoot` — the root branch skips it entirely (no scrollTop reset)", async () => {
    await smartScrollHandler({ ...baseParams, target: "body" });
    const scrollExpr = findScrollExprCall();
    // The contract pin: scrollIntoView must be inside the `if (!isRoot)`
    // branch. Reading source order, the `if (!isRoot)` appears before the
    // scrollIntoView call.
    const idxIfNotRoot = scrollExpr.search(/if\s*\(\s*!\s*isRoot\s*\)/);
    const idxScrollIntoView = scrollExpr.indexOf("scrollIntoView");
    expect(idxIfNotRoot).toBeGreaterThanOrEqual(0);
    expect(idxScrollIntoView).toBeGreaterThan(idxIfNotRoot);
  });

  it("target='html' takes the same scrollingElement branch (both literals listed in the isRoot test)", async () => {
    await smartScrollHandler({ ...baseParams, target: "html" });
    const scrollExpr = findScrollExprCall();
    // Both 'body' and 'html' switch to the scrollingElement path.
    expect(scrollExpr).toMatch(/target === 'body' \|\| target === 'html'/);
  });

  it("target='#some-element' keeps the document.querySelector + scrollIntoView path", async () => {
    await smartScrollHandler({ ...baseParams, target: "#some-element" });
    const scrollExpr = findScrollExprCall();
    // The literal target is embedded in the expression via JSON.stringify.
    expect(scrollExpr).toContain('"#some-element"');
    // scrollIntoView is still called for non-root selectors (inside the
    // `if (!isRoot)` branch — runtime behaviour). The post-Phase-3 contract
    // is "scrollIntoView exists in the expression and is gated by isRoot",
    // not "scrollIntoView is absent for non-root".
    expect(scrollExpr).toContain("scrollIntoView");
  });
});
