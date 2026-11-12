/**
 * ADR-040 PR ② (internal #396) — scroll answers the dispatcher's "page not visible" with the guided
 * refusal, not a delivery claim and not a fall-through to the OS wheel at the cursor.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async () => ({ hwnd: 0x500n, title: "Back - Google Chrome", warnings: [] })),
}));
vi.mock(import("../../src/tools/_input-pipeline.js"), async (orig) => ({
  ...(await orig()),
  resolveInputDestination: vi.fn(async () => ({ kind: "hwnd" as const, hwnd: 0x500n })),
  dispatchScrollWheel: vi.fn(async () => ({
    scrolled: false,
    channel: "postmessage" as const,
    reason: "target_unreachable" as const,
    pageNotVisible: { frame: 0x500n, why: "covered" as const, title: "Back - Google Chrome" },
  })),
}));
const nutjs = vi.hoisted(() => ({ scrollDown: vi.fn(), scrollUp: vi.fn() }));
vi.mock("../../src/engine/nutjs.js", async (orig) => {
  const real = await orig<typeof import("../../src/engine/nutjs.js")>();
  return { ...real, mouse: { ...real.mouse, scrollDown: nutjs.scrollDown, scrollUp: nutjs.scrollUp } };
});

const { scrollHandler } = await import("../../src/tools/mouse.js");

describe("scroll to a Chromium window whose page is visible nowhere", () => {
  it("refuses with the road on, and sends no OS wheel", async () => {
    const r = await scrollHandler({ direction: "down", amount: 3, homing: false, hwnd: "1280" });
    const j = JSON.parse((r.content[0] as { text: string }).text) as { ok: boolean; code: string; error: string; suggest: string[] };
    expect(j.ok).toBe(false);
    expect(j.code).toBe("ScrollNotDelivered");
    expect(j.error).toMatch(/Nothing was scrolled: the browser window's page is not visible \(hwnd 1280/);
    expect(j.suggest.join(" ")).toContain('focus_window({ title: "Back - Google Chrome" })');
    expect(nutjs.scrollDown).not.toHaveBeenCalled();
  });
});
