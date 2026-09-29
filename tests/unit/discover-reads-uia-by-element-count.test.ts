/**
 * internal #211 — discover's UIA read is capped by element count, not by depth.
 *
 * MEASURED win2 (2026-09-29, 17 app types): Chrome, Edge and VS Code expose their web content to
 * plain UIA at depth 7–12, but discover read to depth 4 and answered `uia_blind_single_pane`,
 * sending the window to OCR. Walked to depth 64 with a 500-element cap, every type stayed at or
 * under 128 elements and 80–406 ms.
 *
 * The bridge is modelled as the walk is: it returns only the elements at or above the depth it was
 * asked for, so a read that went back to depth 4 loses the page and the cells below notice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../src/engine/uia-bridge.js");
  vi.resetModules();
});

type El = { name: string; controlType: string; isEnabled: boolean; boundingRect: { x: number; y: number; width: number; height: number }; patterns: string[]; depth: number; automationId?: string };

const pane = (depth: number): El => ({ name: "Chrome Legacy Window", controlType: "Pane", isEnabled: true, boundingRect: { x: 0, y: 0, width: 900, height: 600 }, patterns: [], depth });
const button = (name: string, depth: number): El => ({ name, automationId: name, controlType: "Button", isEnabled: true, boundingRect: { x: 10, y: 10, width: 60, height: 20 }, patterns: ["Invoke"], depth });

async function read(opts: { tree: El[]; truncated?: boolean; via?: "native" | "powershell"; windowRect?: { x: number; y: number; width: number; height: number } | null }) {
  vi.resetModules();
  const getUiElements = vi.fn(async (_title: string, maxDepth: number, maxElements: number, _t: number, _o?: unknown) => {
    const elements = opts.tree.filter((e) => e.depth <= maxDepth).slice(0, maxElements);
    return {
      windowTitle: "FX-HTML - Google Chrome",
      windowRect: opts.windowRect === undefined ? { x: 0, y: 0, width: 900, height: 600 } : opts.windowRect,
      elementCount: elements.length,
      elements,
      ...(opts.truncated !== undefined && { truncated: opts.truncated }),
      via: opts.via ?? "native",
    };
  });
  vi.doMock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/engine/uia-bridge.js")>()),
    getUiElements,
  }));
  const { fetchUiaCandidates } = await import("../../src/tools/desktop-providers/uia-provider.js");
  const result = await fetchUiaCandidates({ windowTitle: "FX-HTML - Google Chrome" });
  return { result, getUiElements };
}

// A browser window as win2 read it: chrome near the top, the page's controls at depth 8.
const chrome = [pane(4), button("t", 8), button("inc", 8), button("chk", 8), button("dis", 8), button("more", 8)];

describe("discover's UIA read", () => {
  it("asks for depth 64 / 500, and gives the PowerShell road its own 4 / 80", async () => {
    const { getUiElements } = await read({ tree: [button("OK", 1)] });
    const [, depth, max, , options] = getUiElements.mock.calls[0];
    expect([depth, max]).toEqual([64, 500]);
    expect(options).toMatchObject({ fallbackLimits: { maxDepth: 4, maxElements: 80 } });
  });

  it("reaches a page's controls below the pane, and does not call the page blind (Chrome, depth 8)", async () => {
    const { result } = await read({ tree: chrome });
    expect(result.warnings).not.toContain("uia_blind_single_pane");
    expect(result.candidates.map((c) => c.label)).toEqual(expect.arrayContaining(["t", "inc", "chk"]));
  });

  it("still calls a window blind when only the pane comes back (the control)", async () => {
    const { result } = await read({ tree: [pane(4)] });
    expect(result.warnings.some((w) => w.startsWith("uia_blind_"))).toBe(true);
  });

  it("says the tree was cut when the bridge says so, and does not judge blindness from a prefix", async () => {
    const { result } = await read({ tree: [pane(4)], truncated: true });
    expect(result.warnings).toContain("uia_tree_truncated");
    expect(result.warnings.some((w) => w.startsWith("uia_blind_"))).toBe(false);
  });

  it("says the tree was cut when a native read filled the 500 cap", async () => {
    const tree = [pane(1), ...Array.from({ length: 499 }, (_, i) => button(`b${i}`, 2))];
    const { result } = await read({ tree });
    expect(result.warnings).toContain("uia_tree_truncated");
    expect(result.warnings.some((w) => w.startsWith("uia_blind_"))).toBe(false);
  });

  it("does not say so one element short of the cap", async () => {
    const { result } = await read({ tree: Array.from({ length: 499 }, (_, i) => button(`b${i}`, 2)) });
    expect(result.warnings).not.toContain("uia_tree_truncated");
  });

  it("does not call a PowerShell read truncated at its 80 — that road stops there silently, as before", async () => {
    // A blind canvas app read on the PowerShell road was judged blind and got OCR; truncated would
    // have skipped both (gate 2 on A2).
    const { result } = await read({ tree: [pane(1), ...Array.from({ length: 79 }, (_, i) => ({ ...pane(2), name: `p${i}`, controlType: "Text" }))], via: "powershell" });
    expect(result.warnings).not.toContain("uia_tree_truncated");
  });

  it("reports the page's rectangle from every element read, named or not (a page with no <title>)", async () => {
    const nameless = { ...pane(7), name: "", controlType: "Document", automationId: "RootWebArea", boundingRect: { x: 0, y: 100, width: 900, height: 500 } };
    const { result } = await read({ tree: [pane(4), nameless, button("inc", 8)] });
    expect(result.webArea).toEqual({ x: 0, y: 100, width: 900, height: 500 });
  });

  it("reports the largest page when there are several and the title names neither", async () => {
    // Window 900 x 600; both cover at least half of it.
    const small = { ...pane(7), name: "Frame A", controlType: "Document", automationId: "RootWebArea", boundingRect: { x: 0, y: 100, width: 900, height: 320 } };
    const large = { ...pane(7), name: "Frame B", controlType: "Document", automationId: "RootWebArea", boundingRect: { x: 0, y: 100, width: 900, height: 450 } };
    const { result } = await read({ tree: [small, large] });
    expect(result.webArea).toEqual(large.boundingRect);
  });

  it("reports no page for a window without one", async () => {
    const { result } = await read({ tree: [button("OK", 1)] });
    expect(result.webArea).toBeUndefined();
  });

  it("reports no page for a small web pane in a native app (under half the window)", async () => {
    const pane300 = { ...pane(3), name: "Help", controlType: "Document", automationId: "RootWebArea", boundingRect: { x: 0, y: 0, width: 300, height: 150 } };
    const { result } = await read({ tree: [button("OK", 1), pane300] });
    expect(result.webArea).toBeUndefined();
  });

  it("prefers the page the window's title names over a larger DevTools", async () => {
    // The window is 900 x 600; both web areas cover at least half of it, and DevTools is the larger.
    const bigDev = { ...pane(7), name: "DevTools", controlType: "Document", automationId: "RootWebArea", boundingRect: { x: 0, y: 100, width: 900, height: 400 } };
    const bigPage = { ...pane(7), name: "FX-HTML", controlType: "Document", automationId: "RootWebArea", boundingRect: { x: 0, y: 100, width: 900, height: 320 } };
    const { result } = await read({ tree: [bigDev, bigPage] });
    expect(result.webArea).toEqual(bigPage.boundingRect);
  });

  // PR codex P2 on d27f94bd: docked DevTools sits BESIDE the page, splitting the content area under
  // the toolbar. Window 900 x 600, content 900 x 500 from y = 100.
  const web = (name: string, x: number, width: number): El => ({ ...pane(7), name, controlType: "Document", automationId: "RootWebArea", boundingRect: { x, y: 100, width, height: 500 } });

  it("finds the page beside DevTools docked half and half, though neither half is half the window", async () => {
    const page = web("FX-HTML", 0, 450);
    const { result } = await read({ tree: [page, web("DevTools", 450, 450)] });
    expect(result.webArea).toEqual(page.boundingRect);
  });

  it("finds the page by its title beside a DevTools that alone is over half the window", async () => {
    const page = web("FX-HTML", 0, 300);
    const { result } = await read({ tree: [web("DevTools", 300, 600), page] });
    expect(result.webArea).toEqual(page.boundingRect);
  });

  it("reports no page for two small web panes that together are under half the window", async () => {
    const { result } = await read({ tree: [button("OK", 1), web("Help", 0, 200), web("Tips", 600, 200)] });
    expect(result.webArea).toBeUndefined();
  });

  it("reports no page when the window's bounds were not read: half of it cannot be told (PR codex P2)", async () => {
    const { result } = await read({ tree: [web("FX-HTML", 0, 900)], windowRect: null });
    expect(result.webArea).toBeUndefined();
  });
});
