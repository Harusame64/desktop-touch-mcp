/**
 * internal #421 — `pressPointFor`'s answers without a browser (the e2e file holds the page-script cells and needs
 * Chrome): a modal in front is ModalBlockingError, any other cover AimedRouteFailedError, a cover that cannot be read
 * is a typed refusal too (never a plain error, whose advice is a coordinate press onto the cover), an empty overlay is
 * read again before it is refused, and a skin the browser names is not pressed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Answers = { point: unknown[]; cover?: unknown[] | "throws"; inspect?: unknown };
async function pressPoint(a: Answers) {
  vi.resetModules();
  let p = 0, c = 0;
  vi.doMock("../../src/engine/cdp-bridge.js", async (orig) => ({
    ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
    evaluateInTab: async (expr: string) => {
      if (expr.includes("emptyOverlay")) {
        if (a.cover === "throws") throw new Error("JS exception in tab: gone");
        return a.cover?.[Math.min(c++, (a.cover?.length ?? 1) - 1)] ?? null;
      }
      return a.point[Math.min(p++, a.point.length - 1)];
    },
    inspectHitAtPoint: async () => a.inspect ?? null,
  }));
  const { pressPointFor } = await import("../../src/tools/browser.js");
  return pressPointFor("#t", null, 9335).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e: e as Error & { callerDetail?: string } }),
  );
}
afterEach(() => { vi.resetModules(); vi.doUnmock("../../src/engine/cdp-bridge.js"); });

const cover = (over: Record<string, unknown> = {}) => ({ cover: "div#x", dialog: null, offers: [], emptyOverlay: false, ...over });

describe("pressPointFor's refusals (internal #421)", () => {
  it("returns the page's point when one reaches the element", async () => {
    const out = await pressPoint({ point: [{ x: 1, y: 2, via: "label", how: "own_label" }] });
    expect(out.ok && out.r).toEqual({ x: 1, y: 2, via: "label", how: "own_label" });
  });

  it("refuses a modal in front as ModalBlockingError, naming it and what it offers", async () => {
    const out = await pressPoint({ point: [{ none: true }], cover: [cover({ dialog: { name: "Settings", role: "dialog", modal: true }, offers: ["OK", "Cancel"] })] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.e.name).toBe("ModalBlockingError");
    expect(out.e.callerDetail).toContain('"Settings"');
    expect(out.e.callerDetail).toContain('"OK", "Cancel"');
  });

  it("refuses a non-modal dialog and any other cover as AimedRouteFailedError", async () => {
    for (const c of [cover({ dialog: { name: "Drawer", role: "dialog", modal: false } }), cover({ cover: 'header "Site"' })]) {
      const out = await pressPoint({ point: [{ none: true }], cover: [c] });
      expect(!out.ok && out.e.name).toBe("AimedRouteFailedError");
    }
  });

  it("refuses typed when what covers it cannot be read", async () => {
    const out = await pressPoint({ point: [{ none: true }], cover: "throws" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.e.name).toBe("AimedRouteFailedError");
    expect(out.e.callerDetail).toContain("could not be read");
  });

  it("reads an empty overlay again and presses once it has gone", async () => {
    const out = await pressPoint({ point: [{ none: true }, { x: 5, y: 6, via: "element", how: "self" }], cover: [cover({ emptyOverlay: true })] });
    expect(out.ok && out.r).toEqual({ x: 5, y: 6, via: "element", how: "self" });
  });

  it("does not press a skin the browser names, and refuses naming the cover", async () => {
    const out = await pressPoint({ point: [{ x: 1, y: 1, via: "element", how: "skin" }], inspect: { role: "button", name: "Locked", ignored: false }, cover: [cover({ cover: 'ins "Locked"' })] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.e.callerDetail).toContain("Locked");
  });

  it("presses a skin the browser reads as unnamed with no role of its own", async () => {
    const out = await pressPoint({ point: [{ x: 1, y: 1, via: "element", how: "skin" }], inspect: { role: "insertion", name: "", ignored: false } });
    expect(out.ok).toBe(true);
  });
});
