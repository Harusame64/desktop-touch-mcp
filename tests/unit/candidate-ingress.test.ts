import { describe, it, expect, vi } from "vitest";
import {
  SnapshotIngress,
  windowEventMatchesKey,
  type IngressEventSource,
  type IngressReason,
  type ProviderResult,
} from "../../src/engine/world-graph/candidate-ingress.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

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

function noopSource(): IngressEventSource {
  return { drain: async () => [], dispose: vi.fn() };
}

// (Helper `eventSource` was removed — was unused, see code-scanning #87.)

// ── Cache behavior ────────────────────────────────────────────────────────────

describe("SnapshotIngress — cache behavior", () => {
  it("fetches on cache miss (first call)", async () => {
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch, noopSource());
    const result = await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.candidates[0].label).toBe("A");
  });

  it("returns cached result on second call without invalidation", async () => {
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("re-fetches after invalidate()", async () => {
    const fetch = vi.fn(async (key: string) => ok(key));
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    ingress.invalidate("window:1", "winevent");
    await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after cache TTL expires", async () => {
    let now = 0;
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch, noopSource(), { cacheTtlMs: 100 });
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await ingress.getSnapshot("window:1");
    now = 200;
    await ingress.getSnapshot("window:1");
    vi.restoreAllMocks();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns stale cache on fetch error", async () => {
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("network error");
      return ok("Stale");
    });
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    ingress.invalidate("window:1", "manual");
    fail = true;
    const result = await ingress.getSnapshot("window:1");
    expect(result.candidates[0].label).toBe("Stale");
  });

  it("adds ingress_fetch_error warning when fetch throws and stale cache returned", async () => {
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("err");
      return ok("Stale", ["some_prior_warning"]);
    });
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    ingress.invalidate("window:1", "manual");
    fail = true;
    const result = await ingress.getSnapshot("window:1");
    expect(result.warnings).toContain("ingress_fetch_error");
    expect(result.candidates[0].label).toBe("Stale");
  });

  it("returns empty candidates and ingress_fetch_error when cache is empty on error", async () => {
    const fetch = vi.fn(async () => { throw new Error("UIA unavailable"); });
    const ingress = new SnapshotIngress(fetch);
    const result = await ingress.getSnapshot("window:1");
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toContain("ingress_fetch_error");
  });

  it("returns [] candidates and [] warnings after dispose", async () => {
    const ingress = new SnapshotIngress(async () => ok("A"));
    await ingress.getSnapshot("window:1");
    ingress.dispose();
    const result = await ingress.getSnapshot("window:1");
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("cached warnings are returned on cache hit", async () => {
    const fetch = vi.fn(async () => ok("A", ["visual_provider_unavailable"]));
    const ingress = new SnapshotIngress(fetch, noopSource());
    const first  = await ingress.getSnapshot("window:1");
    const second = await ingress.getSnapshot("window:1"); // cache hit
    expect(first.warnings).toEqual(["visual_provider_unavailable"]);
    expect(second.warnings).toEqual(["visual_provider_unavailable"]);
    expect(fetch).toHaveBeenCalledOnce(); // not re-fetched
  });
});

// ── Target isolation ──────────────────────────────────────────────────────────

describe("SnapshotIngress — target isolation", () => {
  it("invalidate on A does NOT affect B's cache", async () => {
    const fetch = vi.fn(async (key: string) => ok(key));
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:A");
    await ingress.getSnapshot("window:B");
    ingress.invalidate("window:A", "winevent");
    await ingress.getSnapshot("window:B");
    const bCalls = (fetch.mock.calls as string[][]).filter((args) => args[0] === "window:B");
    expect(bCalls).toHaveLength(1);
  });

  it("event source fires only for matching key (target isolation)", async () => {
    const fetch = vi.fn(async (key: string) => ok(key));
    let drainCount = 0;
    const source: IngressEventSource = {
      drain: async () => {
        drainCount++;
        if (drainCount === 3) return [{ key: "window:A", reason: "winevent" as IngressReason }];
        return [];
      },
      dispose: vi.fn(),
    };
    const ingress = new SnapshotIngress(fetch, source);
    await ingress.getSnapshot("window:A");
    await ingress.getSnapshot("window:B");
    await ingress.getSnapshot("window:A"); // event fires → re-fetch A
    await ingress.getSnapshot("window:B"); // no event → cache hit for B
    const aCalls = (fetch.mock.calls as string[][]).filter((a) => a[0] === "window:A");
    const bCalls = (fetch.mock.calls as string[][]).filter((a) => a[0] === "window:B");
    expect(aCalls).toHaveLength(2);
    expect(bCalls).toHaveLength(1);
  });

  it("idle: no background fetch", async () => {
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ── Subscribe / markRecovered ─────────────────────────────────────────────────

describe("SnapshotIngress — subscribe", () => {
  it("subscriber fires on invalidate", () => {
    const ingress = new SnapshotIngress(async () => failed([]));
    const cb = vi.fn();
    ingress.subscribe("window:1", cb);
    ingress.invalidate("window:1", "winevent");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("subscriber does NOT fire for a different key", () => {
    const ingress = new SnapshotIngress(async () => failed([]));
    const cb = vi.fn();
    ingress.subscribe("window:A", cb);
    ingress.invalidate("window:B", "winevent");
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops callbacks", () => {
    const ingress = new SnapshotIngress(async () => failed([]));
    const cb = vi.fn();
    const unsub = ingress.subscribe("window:1", cb);
    unsub();
    ingress.invalidate("window:1", "winevent");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("SnapshotIngress — markRecovered", () => {
  it("markRecovered clears dirty flag — no re-fetch on next getSnapshot", async () => {
    const fetch = vi.fn(async () => ok("A"));
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    ingress.invalidate("window:1", "manual");
    ingress.markRecovered!("window:1");
    await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("SnapshotIngress — dispose", () => {
  it("calls eventSource.dispose on ingress.dispose", () => {
    const src = noopSource();
    const ingress = new SnapshotIngress(async () => failed([]), src);
    ingress.dispose();
    expect(src.dispose).toHaveBeenCalled();
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
