/**
 * internal #211, gate 2 on the element-count read — `getUiElements` gives the PowerShell road its
 * own caps, answers from the per-window cache only a read the cached tree covers (cut to the
 * caller's caps), and does NOT mark a native read that filled its cap as `truncated`: narration
 * refuses truncated trees, and would go silent on every rich window (round 2).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../index.js");
  vi.doUnmock("node:child_process");
  vi.unstubAllEnvs();
  vi.resetModules();
});

const el = (i: number) => ({ name: `e${i}`, controlType: "Button", automationId: "", className: "", isEnabled: true, boundingRect: { x: 0, y: 0, width: 10, height: 10 }, patterns: [], depth: 1 });

async function bridge(opts: { native: boolean; count: number; psTruncated?: boolean }) {
  vi.resetModules();
  const scripts: string[] = [];
  const nativeCalls: Array<{ maxDepth: number; maxElements: number }> = [];
  vi.doMock("node:child_process", () => ({
    execFile: (_f: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      scripts.push(args[args.length - 1]);
      const elements = Array.from({ length: opts.count }, (_, i) => el(i));
      cb(null, { stdout: JSON.stringify({ windowTitle: "T", elementCount: opts.count, elements, truncated: opts.psTruncated ?? false }), stderr: "" });
    },
  }));
  vi.doMock("../../index.js", () => ({
    default: {
      computeChangeFraction: () => 0,
      dhashFromRaw: () => 0n,
      hammingDistance: () => 0,
      win32EnumTopLevelWindows: () => [],
      uiaGetElements: async (o: { maxDepth: number; maxElements: number }) => {
        nativeCalls.push({ maxDepth: o.maxDepth, maxElements: o.maxElements });
        return { windowTitle: "T", elementCount: opts.count, elements: Array.from({ length: opts.count }, (_, i) => el(i)) };
      },
    },
  }));
  if (!opts.native) vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
  const mod = await import("../../src/engine/uia-bridge.js");
  return { ...mod, scripts, nativeCalls };
}

describe("a read that stopped at its element cap", () => {
  it("is not marked truncated by the bridge on the native road (narration would go silent)", async () => {
    const { getUiElements } = await bridge({ native: true, count: 80 });
    expect((await getUiElements("T", 3, 80, 8000)).truncated).toBeUndefined();
  });

  it("keeps the PowerShell road's own deadline truncation", async () => {
    const { getUiElements } = await bridge({ native: false, count: 3, psTruncated: true });
    expect((await getUiElements("T", 4, 80, 8000)).truncated).toBe(true);
  });
});

describe("the PowerShell road's caps", () => {
  it("are the fallback limits when the caller gives them", async () => {
    const { getUiElements, scripts } = await bridge({ native: false, count: 3 });
    await getUiElements("T", 64, 500, 8000, { fallbackLimits: { maxDepth: 4, maxElements: 80 } });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("if ($depth -gt 4) { continue }");
    expect(scripts[0]).toContain("$count -lt 80 -and");
  });

  it("do not change the native road's", async () => {
    const { getUiElements, nativeCalls } = await bridge({ native: true, count: 3 });
    await getUiElements("T", 64, 500, 8000, { fallbackLimits: { maxDepth: 4, maxElements: 80 } });
    expect(nativeCalls).toEqual([{ maxDepth: 64, maxElements: 500 }]);
  });

  it("say which road answered, so the caller can tell which cap applied", async () => {
    const { getUiElements } = await bridge({ native: false, count: 80 });
    expect((await getUiElements("T", 64, 500, 8000, { fallbackLimits: { maxDepth: 4, maxElements: 80 } })).via).toBe("powershell");
  });
});

describe("the per-window cache", () => {
  it("answers a read with the same caps", async () => {
    const { getUiElements, nativeCalls } = await bridge({ native: true, count: 3 });
    await getUiElements("T", 6, 120, 8000, { hwnd: 4242n, cached: true });
    const again = await getUiElements("T", 6, 120, 8000, { hwnd: 4242n, cached: true });
    expect(again._cacheHit).toBe(true);
    expect(nativeCalls).toHaveLength(1);
  });

  it("answers a shallower read from a deeper one, cut to its caps (discover's tree for screenshot)", async () => {
    const { getUiElements, nativeCalls, deep } = await bridgeWithTree();
    await getUiElements("T", 64, 500, 8000, { pinnedHwnd: 4242n });
    // Depth 2 with room for 10: the depth, not the count, is what cuts here.
    const shallow = await getUiElements("T", 2, 10, 8000, { hwnd: 4242n, cached: true });
    expect(shallow._cacheHit).toBe(true);
    expect(nativeCalls).toHaveLength(1);
    expect(shallow.elements.map((e) => e.name)).toEqual(deep.filter((e) => e.depth <= 2).map((e) => e.name));
    expect(shallow.elementCount).toBe(5);
    // And the count, where it is the tighter cap: breadth-first, the first 3 at or above depth 2.
    const fewer = await getUiElements("T", 2, 3, 8000, { hwnd: 4242n, cached: true });
    expect(fewer.elements.map((e) => e.name)).toEqual(deep.filter((e) => e.depth <= 2).slice(0, 3).map((e) => e.name));
  });

  it("does not answer a deeper read from a shallower one", async () => {
    const { getUiElements, nativeCalls } = await bridge({ native: true, count: 3 });
    await getUiElements("T", 4, 80, 8000, { pinnedHwnd: 4242n });
    const deeper = await getUiElements("T", 6, 120, 8000, { hwnd: 4242n, cached: true });
    expect(deeper._cacheHit).toBeUndefined();
    expect(nativeCalls).toHaveLength(2);
  });

  it("does not answer a read to more elements at the same depth", async () => {
    const { getUiElements, nativeCalls } = await bridge({ native: true, count: 3 });
    await getUiElements("T", 6, 100, 8000, { hwnd: 4242n, cached: true });
    const more = await getUiElements("T", 6, 120, 8000, { hwnd: 4242n, cached: true });
    expect(more._cacheHit).toBeUndefined();
    expect(nativeCalls).toHaveLength(2);
  });
});

/** A native tree with depths 1..3, breadth-first, for the subset cell. */
async function bridgeWithTree() {
  const deep = [1, 1, 2, 2, 2, 3, 3].map((depth, i) => ({ ...el(i), depth }));
  vi.resetModules();
  const nativeCalls: unknown[] = [];
  vi.doMock("node:child_process", () => ({ execFile: () => { throw new Error("no PowerShell here"); } }));
  vi.doMock("../../index.js", () => ({
    default: {
      computeChangeFraction: () => 0, dhashFromRaw: () => 0n, hammingDistance: () => 0, win32EnumTopLevelWindows: () => [],
      uiaGetElements: async (o: unknown) => { nativeCalls.push(o); return { windowTitle: "T", elementCount: deep.length, elements: deep }; },
    },
  }));
  const mod = await import("../../src/engine/uia-bridge.js");
  return { ...mod, nativeCalls, deep };
}
