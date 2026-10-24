/**
 * internal #311 — browser_click({by}) builds its gather with the tab's page zoom from CDP.
 *
 * The page cannot tell its zoom from its monitor's scale (devicePixelRatio is their product), so the
 * zoom comes from `getPageZoom` (CDP Page.getLayoutMetrics). The conversion cells live in
 * browser-click-aims-at-the-viewport-not-the-bottom-border.test.ts; this one pins the wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ zoom: 1.25, zoomAskedFor: [] as Array<string | null>, exprs: [] as string[], evalTabs: [] as Array<string | null>, firstTab: "A-125" }));

vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  getPageZoom: vi.fn(async (tabId: string | null) => { mocks.zoomAskedFor.push(tabId); return mocks.zoom; }),
  evaluateInTab: vi.fn(async (expr: string, tabId: string | null) => { mocks.exprs.push(expr); mocks.evalTabs.push(tabId); return { __error: "Timeout" }; }),
  // /json/list order is not stable between calls: each call to resolve "the first page tab" may
  // answer another tab, so the resolver must resolve once and use that id for both reads.
  resolveTabId: vi.fn(async (tabId: string | null) => tabId ?? mocks.firstTab),
}));

const { resolveBrowserActionTarget } = await import("../../src/tools/browser-resolver.js");

afterEach(() => { mocks.zoomAskedFor.length = 0; mocks.exprs.length = 0; mocks.evalTabs.length = 0; });

describe("internal #311: the by-axis gather carries the tab's zoom", () => {
  it("asks CDP for the named tab's zoom and puts it into the gather", async () => {
    await resolveBrowserActionTarget({ by: "text", pattern: "Save", tabId: "B7AE2D", port: 9222, action: "click" } as never);
    expect(mocks.zoomAskedFor).toEqual(["B7AE2D"]);
    expect(mocks.exprs).toHaveLength(1);
    expect(mocks.exprs[0]).toContain("var zoom = 1.25;");
  });

  it("an unknown zoom (1) is the conversion as before", async () => {
    mocks.zoom = 1;
    await resolveBrowserActionTarget({ by: "text", pattern: "Save", tabId: null, port: 9222, action: "click" } as never);
    expect(mocks.exprs[0]).toContain("var zoom = 1;");
    mocks.zoom = 1.25;
  });

  it("without a tabId, the zoom and the gather are read from the one tab resolved once (codex on #839)", async () => {
    await resolveBrowserActionTarget({ by: "text", pattern: "Save", tabId: null, port: 9222, action: "click" } as never);
    expect(mocks.zoomAskedFor).toEqual(["A-125"]);
    expect(mocks.evalTabs).toEqual(["A-125"]);
  });
});
