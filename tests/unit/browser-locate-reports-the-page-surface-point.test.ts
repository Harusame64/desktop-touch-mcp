/**
 * ADR-040 PR ① — browser_locate's clickAt is the page surface's point (win2 P6 on #967: 423,507, the
 * button's centre, where main said 701,515), and says when it is only the page-side estimate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  surfaceKind: "surface" as "surface" | "not_shown",
  resolvedTab: "TAB-1",
  coordsTab: [] as Array<string | null>,
  frameTab: [] as Array<string | null>,
}));

vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  resolveTabId: vi.fn(async () => m.resolvedTab),
  getElementScreenCoords: vi.fn(async (_sel: string, tab: string | null) => {
    m.coordsTab.push(tab);
    return {
      x: 701, y: 515, left: 641, top: 495, width: 120, height: 40, inViewport: true, screenX: 100, screenY: 100,
      occluded: false, viewport: { left: 254.5, top: 300, width: 120, height: 40, innerWidth: 629, innerHeight: 705 },
    };
  }),
}));
vi.mock("../../src/engine/page-aim.js", async (orig) => {
  const actual = await orig<typeof import("../../src/engine/page-aim.js")>();
  return {
    ...actual,
    findTabFrame: vi.fn(async (_port: number, tab: string | null) => { m.frameTab.push(tab); return 7001n; }),
    alignToPageSurface: vi.fn((_f: unknown, aim: { viewportX: number; viewportY: number } | undefined, fallback: { x: number; y: number }) =>
      m.surfaceKind === "surface" && aim
        ? { point: { x: Math.round(108 + aim.viewportX), y: Math.round(187 + aim.viewportY) }, surface: { kind: "surface" } }
        : { point: fallback, surface: { kind: "not_shown", why: "no_page_window" } }),
  };
});

const { browserFindElementHandler } = await import("../../src/tools/browser.js");

beforeEach(() => {
  m.coordsTab.length = 0;
  m.frameTab.length = 0;
  m.surfaceKind = "surface";
});

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

describe("browser_locate's clickAt (ADR-040 PR ①)", () => {
  it("is the page surface's point, the box moved with it, and says so", async () => {
    const r = await browserFindElementHandler({ selector: "#c", port: 9222, includeContext: false });
    const t = text(r as never);
    expect(t).toContain('"clickAt": {\n    "x": 423,\n    "y": 507');
    expect(t).toContain('"topLeft": {\n    "x": 363,\n    "y": 487');
    expect(t).toContain('"pointFrom": "page_window"');
  });

  it("resolves the tab once and uses it for both the coordinates and the window (codex on #967)", async () => {
    await browserFindElementHandler({ selector: "#c", port: 9222, includeContext: false });
    expect(m.coordsTab).toEqual(["TAB-1"]);
    expect(m.frameTab).toEqual(["TAB-1"]);
  });

  it("when the page window cannot be read: the estimate, marked as one", async () => {
    m.surfaceKind = "not_shown";
    const t = text(await browserFindElementHandler({ selector: "#c", port: 9222, includeContext: false }) as never);
    expect(t).toContain('"clickAt": {\n    "x": 701,\n    "y": 515');
    expect(t).toContain('"pointFrom": "page_estimate"');
    expect(t).toMatch(/estimated from the page's own geometry/);
  });
});
