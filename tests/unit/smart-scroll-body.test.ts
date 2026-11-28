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
  // The Chrome path resolves its tab once before the steps (internal #423); no browser runs here.
  resolveTabId: vi.fn(async (tabId: string | null) => tabId ?? "TAB-1"),
}));

// smart-scroll imports several engine modules that the CDP-strategy code path
// never reaches; mock them as no-ops so the SUT loads without native binaries.
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getScrollAncestors: vi.fn().mockResolvedValue([]),
  scrollByPercent: vi.fn(),
  scrollElementIntoView: vi.fn(),
}));
// The rest of win32.js kept as is: smart-scroll's imports reach constants such as VK_CONTROL (bg-input.ts via
// _blocked-by-dialog.ts), and a mock without them stopped this file from loading at all, on Windows and mac
// alike, so none of its cells ran (found on #1047).
vi.mock("../../src/engine/win32.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
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

    // The CDP path issues 4 evaluateInTab calls when ancestors is empty: the offsets read for `scrolled`, scrollExpr,
    // finalState, and the offsets read again (internal #433). The sticky-header check has its own mock. The mock returns
    // a benign shape for each; these cells assert on the expression *sent*, not on what comes back.
    evaluateInTabMock.mockImplementation((expr: string) => {
      if (expr.includes("assignedSlot")) return Promise.resolve([0, 0, 0, 0]);
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
      // viewportTop: the offsets read for `scrolled` (internal #433) names both identifiers too.
      return expr.includes("scrollingElement") && expr.includes("isRoot") && expr.includes("viewportTop");
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

/**
 * internal #433 — the answer after the scrolls: TargetOutOfView when the target is left outside the window, and
 * `scrolled` from the offsets read before and after. The e2e files run these in Chrome; these cells pin the order of
 * the branches and the comparison where no browser runs.
 */
describe("smart-scroll answers from where the target ended and what moved — internal #433", () => {
  function page(o: { before?: unknown; after?: unknown; final: Record<string, unknown> | null }) {
    const offsets = [o.before === undefined ? [0, 0, 0, 0] : o.before, o.after === undefined ? [0, 0, 0, 0] : o.after];
    evaluateInTabMock.mockImplementation((expr: string) => {
      if (expr.includes("assignedSlot")) return Promise.resolve(offsets.shift());
      if (expr.includes("viewportTop")) return Promise.resolve({ ok: true, viewportTop: 0, viewportBottom: 10 });
      if (expr.includes("clipCheck")) return Promise.resolve(o.final);
      return Promise.resolve(undefined);
    });
  }
  const run = async (target = "#t", extra: Record<string, unknown> = {}) =>
    JSON.parse(((await smartScrollHandler({ ...baseParams, target, ...extra } as never)) as { content: { text: string }[] }).content[0]!.text);

  beforeEach(() => {
    evaluateInTabMock.mockReset();
    getScrollAncestorsCdpMock.mockReset().mockResolvedValue({ ancestors: [], warnings: [] });
    detectStickyHeaderCdpMock.mockReset().mockResolvedValue({ occluded: false });
    scrollVirtualListCdpMock.mockReset();
  });

  it("outside the window with nothing moved is TargetOutOfView, scrolled:false", async () => {
    page({ final: { viewportPosition: "below", pageRatio: 0.1, clipped: false, clipCheck: "not-needed" } });
    const r = await run();
    expect(r.code).toBe("TargetOutOfView");
    expect(r.error).toContain("nothing on the page scrolled");
    expect(r.context).toMatchObject({ scrolled: false, viewportPosition: "below" });
  });

  it("outside the window after a move is TargetOutOfView, scrolled:true", async () => {
    page({ after: [0, 0, 300, 0], final: { viewportPosition: "above", pageRatio: 0.1, clipped: false, clipCheck: "not-needed" } });
    const r = await run();
    expect(r.code).toBe("TargetOutOfView");
    expect(r.error).toContain("still outside the window (above)");
    expect(r.context.scrolled).toBe(true);
  });

  it("a sub-pixel move counts as a move", async () => {
    page({ after: [0.8, 0, 0, 0], final: { viewportPosition: "in-view", pageRatio: 0.1, clipped: false, clipCheck: "asked" } });
    expect((await run()).scrolled).toBe(true);
  });

  it("in view with nothing moved is ok, scrolled:false", async () => {
    page({ final: { viewportPosition: "in-view", pageRatio: 0.1, clipped: false, clipCheck: "asked" } });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.scrolled).toBe(false);
  });

  it("in view and clipped is TargetClipped, with the measured scrolled", async () => {
    page({ after: [5, 0, 0, 0], final: { viewportPosition: "in-view", pageRatio: 0.1, clipped: true, clipCheck: "asked" } });
    const r = await run();
    expect(r.code).toBe("TargetClipped");
    expect(r.context.scrolled).toBe(true);
  });

  it("offsets that cannot be compared keep scrolled:true, with a warning", async () => {
    page({ after: [0, 0], final: { viewportPosition: "in-view", pageRatio: 0.1, clipped: false, clipCheck: "asked" } });
    const r = await run();
    expect(r.scrolled).toBe(true);
    expect(r.warnings).toContainEqual(expect.stringMatching(/Whether anything scrolled was not read/));
  });

  it("the document's root is in view whatever body's box says", async () => {
    page({ final: { viewportPosition: "above", pageRatio: 0, clipped: false, clipCheck: "not-needed" } });
    const r = await run("body");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("on the virtual-list road the answer says only the list was scrolled", async () => {
    getScrollAncestorsCdpMock.mockResolvedValue({ ancestors: [{ cssSelectorPath: "div#list", isVirtualized: true, isHidden: false,
      overflowY: "auto", scrollTop: 0, scrollHeight: 30000, clientHeight: 300, scrollLeft: 0 }], warnings: [] });
    scrollVirtualListCdpMock.mockResolvedValue({ ok: true, warnings: [] });
    page({ after: [0, 0, 1200, 0, 0, 0], before: [0, 0, 0, 0, 0, 0], final: { viewportPosition: "below", pageRatio: 0.9, clipped: false, clipCheck: "not-needed" } });
    const r = await run("[data-index='40']", { virtualIndex: 40, virtualTotal: 1000 });
    expect(r.code).toBe("TargetOutOfView");
    expect(r.error).toContain("only the virtual list was scrolled");
  });
});
