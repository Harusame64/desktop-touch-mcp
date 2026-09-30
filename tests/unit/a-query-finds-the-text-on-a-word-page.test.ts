/**
 * internal #217 part 2 — `desktop_discover`'s `query` also matches the text visible on a Word page.
 *
 * MEASURED win2 (2026-09-30): each page's body (`Edit`, automationId `Body`, no window of its own, in
 * `_WwG`) answers TextPattern with that page's text alone, and `GetVisibleRanges` with one range per
 * visible paragraph, in 1–2 ms. Its label is its name ("ページ 1 のコンテンツ"), so a query for words on
 * the page matched nothing. The user chose (2026-09-30) to use the text for `query` only: it is
 * matched, and not returned by any tool, nor kept in the UIA cache that other tools read.
 */
import { describe, expect, it, vi } from "vitest";

import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

const MARKER = "QA1X";

// ─── the bridge ──────────────────────────────────────────────────────────────────────────────

const nativeOpts: Array<Record<string, unknown>> = [];

vi.mock("../../index.js", () => ({
  default: {
    computeChangeFraction: () => 0,
    dhashFromRaw: () => 0n,
    hammingDistance: () => 0,
    win32EnumTopLevelWindows: () => [4242n],
    win32IsWindowVisible: () => true,
    win32GetClassName: () => "OpusApp",
    win32GetWindowText: () => "文書 1 - Word",
    uiaGetElements: async (opts: Record<string, unknown>) => {
      nativeOpts.push(opts);
      return {
        windowTitle: "文書 1 - Word",
        windowHwnd: "4242",
        elementCount: 1,
        elements: [{
          name: "ページ 1 のコンテンツ", controlType: "Edit", automationId: "Body", isEnabled: true,
          boundingRect: { x: 1, y: 2, width: 3, height: 4 }, patterns: [], depth: 5, value: null,
          nativeWindowHandleRead: "zero", hostWindowHandle: "658714", hostWindowClass: "_WwG",
          ...(opts.readBodyText ? { visibleText: `Page 1 marker ${MARKER} begins here.` } : { visibleText: null }),
        }],
      };
    },
  },
}));

vi.resetModules();
const { getUiElements } = await import("../../src/engine/uia-bridge.js");
const { getCachedUia, forgetUiaCache } = await import("../../src/engine/layer-buffer.js");

describe("the bridge reads a Word page's text only when asked, and does not cache it", () => {
  it("asks the addon for it when readBodyText is set, and hands it on", async () => {
    nativeOpts.length = 0;
    forgetUiaCache(4242n);
    const r = await getUiElements("Word", 64, 500, 8000, { pinnedHwnd: 4242n, readBodyText: true });
    expect(nativeOpts[0]).toMatchObject({ readBodyText: true });
    expect(r.elements[0]!.visibleText).toBe(`Page 1 marker ${MARKER} begins here.`);
  });

  it("does not ask otherwise, and the element has no text", async () => {
    nativeOpts.length = 0;
    forgetUiaCache(4242n);
    const r = await getUiElements("Word", 64, 500, 8000, { pinnedHwnd: 4242n });
    expect(nativeOpts[0]).not.toHaveProperty("readBodyText");
    expect(r.elements[0]).not.toHaveProperty("visibleText");
  });

  it("leaves the text out of the cache that other tools read", async () => {
    forgetUiaCache(4242n);
    await getUiElements("Word", 64, 500, 8000, { pinnedHwnd: 4242n, readBodyText: true });
    const cached = getCachedUia(4242n);
    expect(cached).not.toBeNull();
    expect(cached).not.toContain(MARKER);
    expect(cached).toContain("ページ 1 のコンテンツ");
  });

  it("does not answer a read that asks for the text from the cache", async () => {
    forgetUiaCache(4242n);
    await getUiElements("Word", 64, 500, 8000, { pinnedHwnd: 4242n });
    nativeOpts.length = 0;
    const r = await getUiElements("Word", 64, 500, 8000, { pinnedHwnd: 4242n, cached: true, readBodyText: true });
    expect(nativeOpts).toHaveLength(1);
    expect(r._cacheHit).toBeUndefined();
    expect(r.elements[0]!.visibleText).toContain(MARKER);
  });
});

// ─── the query ───────────────────────────────────────────────────────────────────────────────

function candidate(label: string, visibleText?: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "4242" },
    label,
    role: "textbox",
    controlType: "Edit",
    rect: { x: 10, y: 10, width: 600, height: 800 },
    actionability: ["type"],
    confidence: 0.9,
    observedAtMs: 0,
    provisional: false,
    digest: `d-${label}`,
    locator: { uia: { name: label, automationId: "Body", ...(visibleText !== undefined && { visibleText }) } },
  } as unknown as UiEntityCandidate;
}

async function discover(query: string, ...cands: UiEntityCandidate[]) {
  const facade = new DesktopFacade(async () => [candidate("保存", undefined), ...cands]);
  return facade.see({ target: { windowTitle: "Word" }, query });
}

describe("desktop_discover's query and a Word page's visible text", () => {
  it("finds the page whose visible lines hold the words, case-insensitively, under its own name", async () => {
    const view = await discover("qa1x", candidate("ページ 1 のコンテンツ", `Page 1 marker ${MARKER} begins here.`));
    expect(view.entities.map((e) => e.label)).toEqual(["ページ 1 のコンテンツ"]);
  });

  it("does not put the text in the reply", async () => {
    const view = await discover(MARKER, candidate("ページ 1 のコンテンツ", `Page 1 marker ${MARKER} begins here.`));
    expect(view.entities).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("begins here");
  });

  it("does not find a page whose visible lines lack the words, and says the query matched nothing", async () => {
    const view = await discover("QB2Y", candidate("ページ 1 のコンテンツ", `Page 1 marker ${MARKER} begins here.`));
    expect(view.entities).toEqual([]);
    expect(view.constraints?.entityZeroReason).toBe("query_no_match");
  });

  it("still matches labels as before (the control)", async () => {
    const view = await discover("保存", candidate("ページ 1 のコンテンツ", `Page 1 marker ${MARKER} begins here.`));
    expect(view.entities.map((e) => e.label)).toEqual(["保存"]);
  });
});

// ─── the provider ────────────────────────────────────────────────────────────────────────────

describe("discover's UIA lane", () => {
  it("asks the read for the text, and carries it on the body's locator", async () => {
    vi.resetModules();
    const body = {
      name: "ページ 1 のコンテンツ", controlType: "Edit", automationId: "Body", isEnabled: true,
      boundingRect: { x: 10, y: 10, width: 600, height: 800 }, patterns: ["Text"], depth: 5,
      hostWindowHandle: "658714", hostWindowClass: "_WwG", visibleText: `Page 1 marker ${MARKER} begins here.`,
    };
    const getUiElements = vi.fn(async () => ({
      windowTitle: "文書 1 - Word", windowRect: { x: 0, y: 0, width: 900, height: 900 }, elementCount: 1, elements: [body], via: "native" as const,
    }));
    vi.doMock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/uia-bridge.js")>()),
      getUiElements,
    }));
    try {
      const { fetchUiaCandidates } = await import("../../src/tools/desktop-providers/uia-provider.js");
      const result = await fetchUiaCandidates({ windowTitle: "Word" });
      expect((getUiElements.mock.calls[0] as unknown[])[4]).toMatchObject({ readBodyText: true });
      const found = result.candidates.find((c) => c.label === "ページ 1 のコンテンツ");
      expect(found?.locator?.uia?.visibleText).toBe(`Page 1 marker ${MARKER} begins here.`);
    } finally {
      vi.doUnmock("../../src/engine/uia-bridge.js");
      vi.resetModules();
    }
  });
});
