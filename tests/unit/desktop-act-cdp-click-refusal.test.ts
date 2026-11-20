import { afterEach, describe, it, expect, vi } from "vitest";

// internal #415 — desktop_act's CDP click goes through browser_click's road, and when that road refuses, the
// refusal must arrive TYPED. A plain Error becomes `executor_failed`, whose first suggestion is a coordinate
// click at the entity — into the very window the road refused (win2 on the spike: the decoy on top).
const { cdpClickRefusal } = await import("../../src/tools/browser.js");
type Cover = Parameters<typeof cdpClickRefusal>[0];

const at = { x: 154, y: 291 };
const ctx = { selector: "#go", tabId: "T1" };

function refuse(cover: Cover) {
  return cdpClickRefusal(cover, at.x, at.y, ctx) as Error & { callerDetail?: string };
}

describe("cdpClickRefusal (internal #415)", () => {
  it("another window on top is aim_occluded, names that window, and says nothing was clicked", () => {
    const err = refuse({ covered: "other", hwnd: 8719034n, title: "WS1000 fixture - Google Chrome" });
    expect(err.name).toBe("AimOccludedError");
    expect(err.message).toMatch(/^desktop_act \(cdp\): /);
    expect(err.message).toContain("8719034");
    expect(err.message).toContain("Nothing was clicked");
    expect(err.callerDetail).toBe(err.message);
  });

  it("a window the browser owns is aim_occluded too", () => {
    expect(refuse({ covered: "owned", hwnd: 42n, title: "Edge first run" }).name).toBe("AimOccludedError");
  });

  it("an excluded window is aim_blocked_by_excluded_window and is not named", () => {
    const err = refuse({ covered: "excluded" });
    expect(err.name).toBe("AimBlockedByExcludedWindowError");
    expect(err.message).toContain("Nothing was clicked");
  });

  it("a pane that cannot be told from the page carries browser_click's remedy", () => {
    const err = refuse({ covered: "surface_ambiguous", hwnd: 7n });
    expect(err.message).toContain(" Next: ");
  });

  // Everything else is not "a window on top": the blind press is refused.
  const others: Array<[string, Cover]> = [
    ["the page not shown", { covered: "page_not_shown", why: "minimized", hwnd: 7n }],
    ["an ambiguous surface", { covered: "surface_ambiguous", hwnd: 7n }],
    ["a pane of the same window", { covered: "panel", hwnd: 9n, frame: 7n }],
    [
      "a hidden tab",
      {
        covered: "tab",
        target: { tabId: "T1", title: "Target", url: "https://example.test/a" },
        showing: [{ tabId: "T2", title: "Front", url: "https://example.test/b" }],
      },
    ],
  ];
  for (const [what, cover] of others) {
    it(`${what} is aim_route_failed with browser_click's sentence`, () => {
      const err = refuse(cover);
      expect(err.name).toBe("AimedRouteFailedError");
      expect(err.message).not.toMatch(/^browser_click: /);
      expect(err.message).toContain("Nothing was clicked");
      expect(err.callerDetail).toBe(err.message);
    });
  }
});

// The wiring: the real `cdpClick` presses only through `osClickAndVerify`, throws the typed refusal it returns,
// and hands back the probe's verdict. Stubbed at the module edges (CDP, page-aim, browser.ts's click road).
describe("the real cdpClick (internal #415)", () => {
  async function realCdpClick(answer: unknown, calls: unknown[][]) {
    vi.resetModules();
    vi.doMock("../../src/engine/cdp-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
      portForTab: () => 9335,
      resolveTabId: async () => "T1",
      getElementScreenCoords: async () => ({ x: 154, y: 291 }),
    }));
    vi.doMock("../../src/engine/page-aim.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/page-aim.js")>()),
      aimFromCoords: () => ({ marker: "aim" }),
    }));
    vi.doMock("../../src/tools/browser.js", async (orig) => ({
      ...(await orig<typeof import("../../src/tools/browser.js")>()),
      osClickAndVerify: async (...args: unknown[]) => {
        calls.push(args);
        return answer;
      },
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    return _realExecutorDepsForTest().cdpClick("#go", "T1");
  }
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../src/engine/cdp-bridge.js");
    vi.doUnmock("../../src/engine/page-aim.js");
    vi.doUnmock("../../src/tools/browser.js");
  });

  it("presses through osClickAndVerify with the tab, port, selector and the element's aim", async () => {
    const calls: unknown[][] = [];
    const r = await realCdpClick({ status: "delivered", channel: "cdp" }, calls);
    expect(calls).toHaveLength(1);
    const [x, y, probe, tab, port, , force, aim] = calls[0];
    expect([x, y, probe, tab, port, force, aim]).toEqual([154, 291, "#go", "T1", 9335, false, { marker: "aim" }]);
    expect(r).toEqual({ verifyDelivery: { status: "delivered" } });
  });

  it("throws the typed refusal when the road answers a cover, and does not report a press", async () => {
    const calls: unknown[][] = [];
    await expect(
      realCdpClick({ covered: "other", hwnd: 8719034n, title: "Decoy", at: { x: 154, y: 291 } }, calls),
    ).rejects.toMatchObject({ name: "AimOccludedError" });
  });
});
