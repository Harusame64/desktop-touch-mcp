import { describe, it, expect } from "vitest";

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

  // Everything else is not "a window on top": the blind press is refused.
  const others: Array<[string, Cover]> = [
    ["the page not shown", { covered: "page_not_shown", why: "minimized", hwnd: 7n }],
    ["an ambiguous surface", { covered: "surface_ambiguous", hwnd: 7n }],
    ["a pane of the same window", { covered: "panel", hwnd: 9n, frame: 7n }],
    ["an excluded window", { covered: "excluded" }],
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
      expect(err.message.length).toBeGreaterThan(20);
      expect(err.callerDetail).toBe(err.message);
    });
  }
});
