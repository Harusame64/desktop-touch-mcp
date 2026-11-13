/**
 * internal #403 — `scroll` with x/y on the CDP road sends the wheel at that point, not at the page's centre.
 * Chromium scrolls the scroller under a CDP wheel's point (dev/403-cdp-wheel-spike M1); before this the point
 * was dropped (mouse.ts passed only direction and notch), so a pane the caller pointed at stayed still while
 * whatever sat at the centre scrolled. A point off the page keeps the centre, and the reply says so.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  dispatched: [] as unknown[],
  where: "on" as "on" | "off" | "unreadable",
}));
vi.mock("../../src/engine/cursor.js", () => ({ moveCursorTo: vi.fn(async () => undefined) }));
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async () => ({ hwnd: 0x500n, title: "Mail - Google Chrome", warnings: [] })),
}));
vi.mock(import("../../src/tools/_input-pipeline.js"), async (orig) => ({
  ...(await orig()),
  resolveInputDestination: vi.fn(async () => ({ kind: "cdp" as const, tabId: "TAB" })),
  pointOnPageSurface: vi.fn(() => m.where),
  dispatchScrollWheel: vi.fn(async (_d: unknown, p: unknown) => {
    m.dispatched.push(p);
    return { scrolled: true, channel: "cdp" as const, reason: "delivered_via_cdp" as const };
  }),
}));

const { scrollHandler } = await import("../../src/tools/mouse.js");
const reply = (r: { content: Array<{ type: string; text?: string }> }) => (r.content[0] as { text: string }).text;

beforeEach(() => { m.dispatched.length = 0; m.where = "on"; });

describe("scroll on the CDP road, with x/y", () => {
  it("on the page: the dispatcher gets the point and the frame it is on", async () => {
    await scrollHandler({ direction: "down", amount: 3, x: 420, y: 515, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 3, at: { screenX: 420, screenY: 515, frame: 0x500n } }]);
  });

  it("off the page (the tab strip, a DevTools pane): no point is passed, and the reply says the centre was used", async () => {
    m.where = "off";
    const r = await scrollHandler({ direction: "down", amount: 3, x: 420, y: 90, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 3 }]);
    expect(reply(r)).toContain("The point (420, 90) is not on the page in that window");
    expect(reply(r)).toContain("pass x/y inside that part");
  });

  it("the page area cannot be read: no point, and the reply says so", async () => {
    m.where = "unreadable";
    const r = await scrollHandler({ direction: "up", amount: 1, x: 420, y: 515, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "up", notch: 1 }]);
    expect(reply(r)).toContain("could not be read, so the wheel was sent at the middle of the page");
  });

  it("no x/y: as before, no point and no note", async () => {
    const r = await scrollHandler({ direction: "down", amount: 3, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 3 }]);
    expect(reply(r)).not.toContain("middle of the page");
  });
});
