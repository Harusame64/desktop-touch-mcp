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

// The wiring: the real `cdpClick` sends the press to the tab by CDP (`cdpDispatchClickAndVerify`) and touches no
// OS cursor. Only when CDP could not send the press does it take browser_click's OS road (`osClickAndVerify`), and
// a refusal there arrives typed. Stubbed at the module edges (CDP, page-aim, browser.ts's click roads).
describe("the real cdpClick (internal #415)", () => {
  type Calls = { dispatch: unknown[][]; os: unknown[][] };
  async function realCdpClick(
    dispatch: () => Promise<unknown>,
    osAnswer: unknown,
    calls: Calls,
    page: { occluded?: boolean; occludedOnce?: boolean; pressPoint?: () => Promise<unknown> } = {},
  ) {
    vi.resetModules();
    let coordsRead = 0;
    vi.doMock("../../src/engine/cdp-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
      portForTab: () => 9335,
      resolveTabId: async () => "T1",
      getElementScreenCoords: async () => { const first = (coordsRead++) === 0; return { x: first ? 154 : 160, y: first ? 291 : 300, ...(page.occluded !== undefined && { occluded: page.occluded && (!page.occludedOnce || first) }) }; },
    }));
    vi.doMock("../../src/engine/page-aim.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/page-aim.js")>()),
      aimFromCoords: () => ({ marker: "aim" }),
    }));
    vi.doMock("../../src/tools/browser.js", async (orig) => ({
      ...(await orig<typeof import("../../src/tools/browser.js")>()),
      cdpDispatchClickAndVerify: async (...args: unknown[]) => {
        calls.dispatch.push(args);
        return dispatch();
      },
      osClickAndVerify: async (...args: unknown[]) => {
        calls.os.push(args);
        return osAnswer;
      },
      pressPointFor: async () => page.pressPoint?.(),
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    return _realExecutorDepsForTest().cdpClick("#go", "T1");
  }
  async function dispatchError(pressSent: boolean): Promise<never> {
    const { CdpClickDispatchError } = await import("../../src/engine/cdp-bridge.js");
    throw new CdpClickDispatchError("socket closed", pressSent);
  }
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../src/engine/cdp-bridge.js");
    vi.doUnmock("../../src/engine/page-aim.js");
    vi.doUnmock("../../src/tools/browser.js");
  });

  it("sends the press to the tab by CDP and never touches the OS road", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    const r = await realCdpClick(async () => ({ status: "delivered", channel: "cdp", openedTabs: 1 }), undefined, calls);
    expect(calls.dispatch).toEqual([["#go", "T1", 9335]]);
    expect(calls.os).toEqual([]);
    expect(r).toEqual({ via: "cdp_dispatch", verifyDelivery: { status: "delivered" }, openedTabs: 1 });
  });

  it("falls back to browser_click's OS road only when CDP could not send the press", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    const r = await realCdpClick(() => dispatchError(false), { status: "delivered", channel: "cdp" }, calls);
    expect(calls.os).toHaveLength(1);
    const [x, y, probe, tab, port, , force, aim] = calls.os[0];
    expect([x, y, probe, tab, port, force, aim]).toEqual([154, 291, "#go", "T1", 9335, false, { marker: "aim" }]);
    expect(r).toEqual({ via: "os_click", verifyDelivery: { status: "delivered" } });
  });

  it("refuses on the OS road what the CDP road's reading refuses, and presses nothing (internal #421)", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    const pressPoint = async () => { throw Object.assign(new Error("behind a dialog"), { name: "ModalBlockingError" }); };
    const err = await realCdpClick(() => dispatchError(false), { status: "delivered", channel: "cdp" }, calls, { occluded: true, pressPoint })
      .then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("ModalBlockingError");
    expect(calls.os).toEqual([]);
  });

  it("does not aim the OS press at a label or a skin: covered at the centre, it presses nothing (internal #421)", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    const pressPoint = async () => ({ x: 10, y: 20, via: "label", how: "own_label" });
    const err = await realCdpClick(() => dispatchError(false), { status: "delivered", channel: "cdp" }, calls, { occluded: true, pressPoint })
      .then(() => null, (e: unknown) => e as Error & { callerDetail?: string });
    expect(err?.name).toBe("AimedRouteFailedError");
    expect(err?.callerDetail).toContain("its label");
    expect(err?.callerDetail).toContain("Nothing was clicked");
    expect(calls.os).toEqual([]);
  });

  it("presses on the OS road when the reading finds the centre clear now, at coordinates read again (/code-review on #1004)", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    const pressPoint = async () => ({ x: 1, y: 1, via: "element", how: "self" });
    const r = await realCdpClick(() => dispatchError(false), { status: "delivered", channel: "cdp" }, calls, { occluded: true, occludedOnce: true, pressPoint });
    expect(calls.os).toHaveLength(1);
    expect(calls.os[0].slice(0, 2)).toEqual([160, 300]);
    expect(r).toEqual({ via: "os_click", verifyDelivery: { status: "delivered" } });
  });

  it("does not read the page on the OS road when the centre is not covered (control)", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    let asked = 0;
    const pressPoint = async () => { asked++; return { x: 1, y: 1, via: "element", how: "self" }; };
    await realCdpClick(() => dispatchError(false), { status: "delivered", channel: "cdp" }, calls, { occluded: false, pressPoint });
    expect(asked).toBe(0);
    expect(calls.os).toHaveLength(1);
  });

  it("does not press again when the CDP press was sent and the release failed", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    const err = await realCdpClick(() => dispatchError(true), { status: "delivered", channel: "cdp" }, calls)
      .then(() => null, (e: unknown) => e as Error & { callerDetail?: string });
    expect(err).not.toBeNull();
    expect(err!.name).toBe("AimedRouteFailedError");
    expect(err!.callerDetail).toContain("may have taken effect");
    expect(calls.os).toEqual([]);
  });

  it("a missing element is not a reason to fall back", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    await expect(
      realCdpClick(async () => { throw new Error("Element not found: #go"); }, { status: "delivered", channel: "cdp" }, calls),
    ).rejects.toThrow("Element not found");
    expect(calls.os).toEqual([]);
  });

  it("throws the typed refusal when the fallback's road answers a cover", async () => {
    const calls: Calls = { dispatch: [], os: [] };
    await expect(
      realCdpClick(() => dispatchError(false), { covered: "other", hwnd: 8719034n, title: "Decoy", at: { x: 154, y: 291 } }, calls),
    ).rejects.toMatchObject({ name: "AimOccludedError" });
  });
});
