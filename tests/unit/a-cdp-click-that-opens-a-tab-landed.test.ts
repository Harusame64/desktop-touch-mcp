/**
 * internal #415 — `cdpDispatchClickAndVerify` counts the page tabs before and after the press. A tab the click
 * opened is evidence it landed: a `window.open` button changes no DOM of its own page, so the click probe alone
 * reads it as unverifiable (win2 on #1001, cell 7). With no new tab the probe's verdict stands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function clickWith(tabsAfter: string[], probe: { mutationCount: number }, order: string[] = [], point: unknown = { x: 10, y: 20 }) {
  vi.resetModules();
  let listed = 0;
  vi.doMock("../../src/engine/cdp-bridge.js", async (orig) => ({
    ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
    evaluateInTab: async (expr: string) => {
      if (expr.includes("getBoundingClientRect")) return point;
      if (expr.includes("__dtmClickProbe") && expr.includes("MutationObserver")) {
        order.push("probe");
        return { ok: true, selectorFound: true, inIframe: false };
      }
      return { ok: true, mutationCount: probe.mutationCount, urlChanged: false, activeElementChanged: false, inIframe: false };
    },
    listTabsLight: async () => {
      const ids = listed++ === 0 ? ["T1"] : tabsAfter;
      return ids.map((id) => ({ id, title: id, url: "about:blank", type: "page" }));
    },
    dispatchMouseMoveInTab: async () => { order.push("move"); },
    dispatchClickInTab: async () => { order.push("press"); },
  }));
  const { cdpDispatchClickAndVerify } = await import("../../src/tools/browser.js");
  return cdpDispatchClickAndVerify("#go", "T1", 9335);
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../src/engine/cdp-bridge.js");
});

describe("a CDP click that opens a tab (internal #415)", () => {
  it("is delivered when a page tab appeared, though its own page did not change", async () => {
    const r = await clickWith(["T1", "T2"], { mutationCount: 0 });
    expect(r.status).toBe("delivered");
    expect(r.reason).toBeUndefined();
    expect(r.openedTabs).toBe(1);
  });

  it("keeps the probe's unverifiable when no tab appeared", async () => {
    const r = await clickWith(["T1"], { mutationCount: 0 });
    expect(r.status).toBe("unverifiable");
    expect(r.reason).toBe("no_dom_mutation");
    expect(r.openedTabs).toBe(0);
  });

  it("moves the pointer before installing the probe, so hover effects are not read as the click", async () => {
    const order: string[] = [];
    await clickWith(["T1"], { mutationCount: 0 }, order);
    expect(order).toEqual(["move", "probe", "press"]);
  });

  it("an element that cannot be scrolled into the viewport is refused typed, with nothing pressed", async () => {
    const order: string[] = [];
    const err = await clickWith(["T1"], { mutationCount: 0 }, order, { error: "Element is outside the viewport and could not be scrolled into it: #go. Nothing was clicked.", outside: true })
      .then(() => null, (e: unknown) => e as Error & { callerDetail?: string });
    expect(err?.name).toBe("AimedRouteFailedError");
    expect(err?.callerDetail).toContain("Nothing was clicked");
    expect(order).toEqual([]);
  });
});
