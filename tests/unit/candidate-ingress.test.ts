import { describe, it, expect, vi } from "vitest";
import {
  SnapshotIngress,
  type ProviderResult,
} from "../../src/engine/world-graph/candidate-ingress.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

function candidate(label: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "w1" },
    label,
    role: "button",
    actionability: ["invoke"],
    confidence: 1,
    observedAtMs: Date.now(),
    provisional: false,
  };
}

function ok(label: string, warnings: string[] = []): ProviderResult {
  return { candidates: [candidate(label)], warnings };
}

function failed(warnings: string[]): ProviderResult {
  return { candidates: [], warnings };
}

// ── Every call reads (internal #218) ─────────────────────────────────────────

describe("SnapshotIngress — every call reads (internal #218)", () => {
  // Measured (win2, 2026-09-29): Excel's zoom and sheet changed through COM, and the next discover
  // answered in 10 ms with the list from before. No event marks a change made inside a window.

  it("reads again on the next call, and hands back what the window shows now", async () => {
    let shown = "Sheet1";
    const fetch = vi.fn(async () => ok(shown));
    const ingress = new SnapshotIngress(fetch);
    expect((await ingress.getSnapshot("title:Book1 - Excel")).candidates[0].label).toBe("Sheet1");
    shown = "Sheet2"; // changed from outside: nothing is told
    const second = await ingress.getSnapshot("title:Book1 - Excel");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.candidates[0].label).toBe("Sheet2");
    expect(second.freshness?.from).toBe("read");
  });

  it("reads again for a bare discover, whose key no window event names (Alt-Tab)", async () => {
    let front = "Notepad";
    const ingress = new SnapshotIngress(async () => ok(front));
    await ingress.getSnapshot("window:__default__");
    front = "Explorer";
    expect((await ingress.getSnapshot("window:__default__")).candidates[0].label).toBe("Explorer");
  });

  it("dates each read to its own start, not the first one", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      // Each read takes 500 ms, so its start and its end are different moments.
      const ingress = new SnapshotIngress(async () => { vi.setSystemTime(Date.now() + 500); return ok("A"); });
      await ingress.getSnapshot("window:1");
      vi.setSystemTime(6_000);
      expect((await ingress.getSnapshot("window:1")).freshness).toEqual({ from: "read", observedAtMs: 6_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("through the facade: a second discover with no act between reads again", async () => {
    const fetch = vi.fn(async (): Promise<ProviderResult> => ({ candidates: [{ ...candidate("OK"), rect: { x: 10, y: 10, width: 60, height: 20 } }], warnings: [] }));
    const facade = new DesktopFacade(async () => [], { ingress: new SnapshotIngress(fetch), executorFn: async () => "uia" });
    await facade.see({ target: { hwnd: "500" } });
    const second = await facade.see({ target: { hwnd: "500" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.freshness?.from).toBe("read");
  });

  it("through the facade: an act still tells the ingress its read is over, pressed or refused", async () => {
    // Production's ingress remembers nothing, but an injected one may (`CandidateIngress`).
    for (const opts of [{}, { isModalBlocking: () => true }]) {
      const invalidate = vi.fn();
      const ingress = {
        getSnapshot: async (): Promise<ProviderResult> => ({ candidates: [{ ...candidate("OK"), rect: { x: 10, y: 10, width: 60, height: 20 } }], warnings: [] }),
        invalidate,
        subscribe: () => () => undefined,
        dispose: () => undefined,
      };
      const facade = new DesktopFacade(async () => [], { ingress, executorFn: async () => "uia", ...opts });
      const view = await facade.see({ target: { hwnd: "500" } });
      expect(invalidate).not.toHaveBeenCalled();
      await facade.touch({ lease: view.entities[0].lease });
      expect(invalidate).toHaveBeenCalledWith("window:500", "manual");
    }
  });
});

// ── When the read throws (ADR-036 item 8, internal #150, #160) ────────────────

describe("SnapshotIngress — when the read throws", () => {
  it("hands back nothing it read before: no candidates, no target, `unavailable` (gate 2, #160)", async () => {
    // The one throw on a shipped road is `WindowExcludedError`: an earlier read handed back here
    // would be the excluded window's contents with new leases.
    let fail = false;
    const ingress = new SnapshotIngress(async () => {
      if (fail) throw new Error("WindowExcludedError");
      return { ...ok("A", ["some_prior_warning"]), target: { hwnd: "500", windowTitle: "W" }, identityRead: true, origin: { kind: "measured" as const, rect: { x: 0, y: 0, width: 10, height: 10 } } };
    });
    await ingress.getSnapshot("window:500");
    fail = true;
    expect(await ingress.getSnapshot("window:500")).toEqual({ candidates: [], warnings: ["ingress_fetch_error"], freshness: { from: "unavailable" } });
  });

  it("reads again on the call after, and says `read` when it works", async () => {
    let fail = true;
    const ingress = new SnapshotIngress(async () => {
      if (fail) throw new Error("boom");
      return ok("A");
    });
    await ingress.getSnapshot("window:1");
    fail = false;
    const result = await ingress.getSnapshot("window:1");
    expect(result.candidates[0].label).toBe("A");
    expect(result.freshness?.from).toBe("read");
  });

  it("says `unavailable` after dispose, without reading", async () => {
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch);
    await ingress.getSnapshot("window:1");
    ingress.dispose();
    const result = await ingress.getSnapshot("window:1");
    expect(result).toEqual({ candidates: [], warnings: [], freshness: { from: "unavailable" } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ── Subscribe ─────────────────────────────────────────────────────────────────

describe("SnapshotIngress — subscribe", () => {
  it("subscriber fires on invalidate", () => {
    const ingress = new SnapshotIngress(async () => failed([]));
    const cb = vi.fn();
    ingress.subscribe("window:1", cb);
    ingress.invalidate("window:1", "manual");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("subscriber does NOT fire for a different key", () => {
    const ingress = new SnapshotIngress(async () => failed([]));
    const cb = vi.fn();
    ingress.subscribe("window:A", cb);
    ingress.invalidate("window:B", "manual");
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops callbacks", () => {
    const ingress = new SnapshotIngress(async () => failed([]));
    const cb = vi.fn();
    const unsub = ingress.subscribe("window:1", cb);
    unsub();
    ingress.invalidate("window:1", "manual");
    expect(cb).not.toHaveBeenCalled();
  });
});
