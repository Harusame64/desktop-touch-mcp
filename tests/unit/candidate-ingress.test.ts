import { describe, it, expect, vi } from "vitest";
import {
  SnapshotIngress,
  windowEventMatchesKey,
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

  it("idle: nothing is read between calls", async () => {
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch);
    await ingress.getSnapshot("window:1");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ── When the read throws (ADR-036 item 8, internal #150) ──────────────────────

describe("SnapshotIngress — when the read throws", () => {
  it("says `staleCache`, dated to the read it remembers, with ingress_fetch_error", async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      let label = "A";
      const ingress = new SnapshotIngress(async () => {
        if (fail) throw new Error("boom");
        return ok(label, ["some_prior_warning"]);
      });
      vi.setSystemTime(1_000);
      await ingress.getSnapshot("window:1");
      vi.setSystemTime(2_000);
      label = "B";
      await ingress.getSnapshot("window:1");
      vi.setSystemTime(3_000);
      fail = true;
      const result = await ingress.getSnapshot("window:1");
      // The LATEST read goes out, under its own date, and is not called a read.
      expect(result.candidates[0].label).toBe("B");
      expect(result.freshness).toEqual({ from: "staleCache", observedAtMs: 2_000 });
      expect(result.warnings).toEqual(["some_prior_warning", "ingress_fetch_error"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hand one target's read to another", async () => {
    const ingress = new SnapshotIngress(async (key: string) => {
      if (key === "window:B") throw new Error("boom");
      return ok(key);
    });
    await ingress.getSnapshot("window:A");
    expect((await ingress.getSnapshot("window:B")).freshness).toEqual({ from: "unavailable" });
  });

  it("says `unavailable` — never `read` — when nothing was read before", async () => {
    const ingress = new SnapshotIngress(async () => {
      throw new Error("boom");
    });
    const result = await ingress.getSnapshot("window:1");
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual(["ingress_fetch_error"]);
    // No date: there is no observation to date.
    expect(result.freshness).toEqual({ from: "unavailable" });
  });

  it("says `unavailable` after dispose, and forgets what it read", async () => {
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

// ── windowEventMatchesKey ─────────────────────────────────────────────────────

describe("windowEventMatchesKey — matching logic", () => {
  it("window: key matches by hwnd equality", () => {
    expect(windowEventMatchesKey({ hwnd: "123" }, "window:123")).toBe(true);
    expect(windowEventMatchesKey({ hwnd: "123" }, "window:456")).toBe(false);
  });

  it("title: key matches by case-insensitive substring", () => {
    expect(windowEventMatchesKey({ windowTitle: "Notepad (modified)" }, "title:notepad")).toBe(true);
    expect(windowEventMatchesKey({ windowTitle: "Chrome" }, "title:Notepad")).toBe(false);
  });

  it("tab: key is never matched by WinEvent", () => {
    expect(windowEventMatchesKey({ hwnd: "123" }, "tab:abc")).toBe(false);
  });

  it("event missing hwnd does not match window: key", () => {
    expect(windowEventMatchesKey({ windowTitle: "App" }, "window:123")).toBe(false);
  });
});
