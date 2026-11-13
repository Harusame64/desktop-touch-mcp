/**
 * internal #403 — `scroll` with x/y on the CDP road sends the wheel at that point, not at the page's centre.
 * Chromium scrolls the scroller under a CDP wheel's point (dev/403-cdp-wheel-spike M1); before this the point
 * was dropped (mouse.ts passed only direction and notch), so a pane the caller pointed at stayed still while
 * whatever sat at the centre scrolled. A point off the page keeps the centre, and the reply says so.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  dispatched: [] as unknown[],
  notUsed: undefined as "off" | "unreadable" | undefined,
  windowNotUsed: undefined as "off" | "covered" | "unreadable" | undefined,
  result: null as Record<string, unknown> | null,
  dest: { kind: "cdp" as const, tabId: "TAB", frame: 0x500n } as Record<string, unknown>,
}));
vi.mock("../../src/engine/cursor.js", () => ({ moveCursorTo: vi.fn(async () => undefined) }));
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async () => ({ hwnd: 0x500n, title: "Mail - Google Chrome", warnings: [] })),
}));
vi.mock(import("../../src/tools/_input-pipeline.js"), async (orig) => ({
  ...(await orig()),
  resolveInputDestination: vi.fn(async () => m.dest as never),
  dispatchScrollWheel: vi.fn(async (_d: unknown, p: unknown) => {
    m.dispatched.push(p);
    const told = (p as { onPointNotUsed?: (w: string) => void }).onPointNotUsed;
    if (m.windowNotUsed !== undefined) told?.(m.windowNotUsed);
    if (m.result !== null) return m.result as never;
    return { scrolled: true, channel: "cdp" as const, reason: "delivered_via_cdp" as const, ...(m.notUsed !== undefined && { pointNotUsed: m.notUsed }) };
  }),
}));

const { scrollHandler } = await import("../../src/tools/mouse.js");
const reply = (r: { content: Array<{ type: string; text?: string }> }) => (r.content[0] as { text: string }).text;

beforeEach(() => { m.dispatched.length = 0; m.notUsed = undefined; m.windowNotUsed = undefined; m.result = null; m.dest = { kind: "cdp", tabId: "TAB", frame: 0x500n }; });

describe("scroll on the CDP road, with x/y", () => {
  it("the dispatcher gets the point and the frame the tab was found in", async () => {
    await scrollHandler({ direction: "down", amount: 3, x: 420, y: 515, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 3, at: { screenX: 420, screenY: 515, frame: 0x500n } }]);
  });

  it("a window named by title only (no hwnd resolved up front) gets the point too: the frame comes with the destination (gate 2 on #979)", async () => {
    m.dest = { kind: "cdp", tabId: "TAB", frame: 0x777n };
    await scrollHandler({ direction: "down", amount: 1, x: 420, y: 515, homing: false, windowTitle: "Mail" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 1, at: { screenX: 420, screenY: 515, frame: 0x777n } }]);
  });

  it("the dispatcher sent it at the centre because the point is off the page: the reply says so, with the way to aim", async () => {
    m.notUsed = "off";
    const r = await scrollHandler({ direction: "down", amount: 3, x: 420, y: 90, homing: false, hwnd: "1280" });
    expect(reply(r)).toContain("The point (420, 90) is not on the page in that window");
    expect(reply(r)).toContain("pass x/y inside that part");
  });

  it("…or because the point could not be placed: the reply says so", async () => {
    m.notUsed = "unreadable";
    const r = await scrollHandler({ direction: "up", amount: 1, x: 420, y: 515, homing: false, hwnd: "1280" });
    expect(reply(r)).toContain("could not be placed on the page");
    expect(reply(r)).toContain('scroll({ action: \\"to_element\\" })');
  });

  it("no x/y, or the point was used: no point note", async () => {
    for (const args of [{}, { x: 420, y: 515 }]) {
      const r = await scrollHandler({ direction: "down", amount: 3, homing: false, hwnd: "1280", ...args });
      expect(reply(r)).not.toContain("middle of the page");
    }
    expect(m.dispatched[0]).toEqual({ direction: "down", notch: 3 });
  });

});

describe("scroll on the window road, with x/y (internal #404)", () => {
  beforeEach(() => { m.dest = { kind: "hwnd", hwnd: 0x500n }; m.result = { scrolled: true, channel: "postmessage", reason: "delivered_via_postmessage" }; });

  it("the dispatcher gets the point, the window, and a way to say the point was not used", async () => {
    await scrollHandler({ direction: "down", amount: 1, x: 420, y: 515, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 1, at: { screenX: 420, screenY: 515, frame: 0x500n }, onPointNotUsed: expect.any(Function) }]);
  });

  it("no x/y: nothing about a point is passed", async () => {
    await scrollHandler({ direction: "down", amount: 1, homing: false, hwnd: "1280" });
    expect(m.dispatched).toEqual([{ direction: "down", notch: 1 }]);
  });

  it("the point was off the page: said, naming where the wheel went on this road", async () => {
    m.windowNotUsed = "off";
    const t = reply(await scrollHandler({ direction: "down", amount: 1, x: 420, y: 90, homing: false, hwnd: "1280" }));
    expect(t).toContain("The point (420, 90) is not on the page in that window");
    expect(t).toContain("where the page shows");
    expect(t).not.toContain("at the middle of the page");
  });

  it("the point was covered by another window: said, with focus_window as the road on", async () => {
    m.windowNotUsed = "covered";
    const t = reply(await scrollHandler({ direction: "down", amount: 1, x: 420, y: 515, homing: false, hwnd: "1280" }));
    expect(t).toContain("The point (420, 515) is covered by another window");
    expect(t).toContain("focus_window");
  });

  it("the point could not be checked: said, without the CDP road's reasons", async () => {
    m.windowNotUsed = "unreadable";
    const t = reply(await scrollHandler({ direction: "down", amount: 1, x: 420, y: 515, homing: false, hwnd: "1280" }));
    expect(t).toContain("could not be checked");
    expect(t).not.toContain("pinch-zoomed");
  });

  it("said even when nothing was seen to move (the dispatcher answers null)", async () => {
    m.windowNotUsed = "off";
    const mod = await import("../../src/tools/_input-pipeline.js");
    vi.mocked(mod.dispatchScrollWheel).mockImplementationOnce(async (_d, p) => { m.dispatched.push(p); p.onPointNotUsed?.("off"); return null; });
    const t = reply(await scrollHandler({ direction: "down", amount: 1, x: 420, y: 90, homing: false, hwnd: "1280" }));
    expect(t).toContain("The point (420, 90) is not on the page in that window");
  });

  it("the page visible nowhere: the refusal, without a point note", async () => {
    m.windowNotUsed = "covered";
    m.result = { scrolled: false, channel: "postmessage", reason: "target_unreachable", pageNotVisible: { frame: 0x500n, why: "covered" } };
    const t = reply(await scrollHandler({ direction: "down", amount: 1, x: 420, y: 515, homing: false, hwnd: "1280" }));
    expect(t).toContain("Nothing was scrolled");
    expect(t).not.toContain("is covered by another window, so the wheel was sent");
  });
});

describe("the CDP road's answers become honest replies (internal #403)", () => {
  const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(reply(r)) as Record<string, any>;

  it("the part under the point could move and did not: ScrollNotDelivered saying the wheel was sent", async () => {
    m.result = { scrolled: false, channel: "cdp", reason: "target_unreachable", sentNotMoved: "room_not_moved" };
    const j = json(await scrollHandler({ direction: "down", amount: 1, homing: false, hwnd: "1280" }));
    expect(j.code).toBe("ScrollNotDelivered");
    expect(JSON.stringify(j)).toContain("could still scroll that way, but nothing moved");
    expect(JSON.stringify(j)).toContain('"channel":"cdp"');
  });

  it("the path could not be read and the document did not move: says so, without claiming room", async () => {
    m.result = { scrolled: false, channel: "cdp", reason: "target_unreachable", sentNotMoved: "document_still" };
    const t = reply(await scrollHandler({ direction: "down", amount: 1, homing: false, hwnd: "1280" }));
    expect(t).toContain("could not be read, and the page itself did not move");
    expect(t).not.toContain("could still scroll");
  });

  it("not sent: ScrollNotDelivered saying nothing was sent", async () => {
    const mod = await import("../../src/tools/_input-pipeline.js");
    vi.mocked(mod.dispatchScrollWheel).mockResolvedValueOnce(null);
    const t = reply(await scrollHandler({ direction: "down", amount: 1, homing: false, hwnd: "1280" }));
    expect(t).toContain("Nothing was sent");
  });

  it("at the end: ok, with the note", async () => {
    m.result = { scrolled: true, channel: "cdp", reason: "delivered_via_cdp", atEnd: true };
    const t = reply(await scrollHandler({ direction: "down", amount: 1, homing: false, hwnd: "1280" }));
    expect(t).toContain('"ok":true');
    expect(t).toContain("already at its end in the down direction");
  });

  for (const reason of ["page_handled_wheel", "hit_path_unobservable"] as const) {
    it(`${reason}: ok with verifyDelivery unverifiable and the road on`, async () => {
      m.result = { scrolled: false, channel: "cdp", reason };
      const t = reply(await scrollHandler({ direction: "down", amount: 1, homing: false, hwnd: "1280" }));
      expect(t).toContain('"ok":true');
      expect(t).toContain('"status":"unverifiable"');
      expect(t).toContain(`"reason":"${reason}"`);
      expect(t).toContain("action:'to_element'");
    });
  }
});
