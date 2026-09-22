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

// ── Was it read, or remembered? (ADR-036 item 8, internal #150) ───────────────

describe("SnapshotIngress — says whether the answer was read or remembered", () => {
  // Measured on real hardware (internal #150, 2026-09-21): a window hung for 90 s got six entities
  // back in 4 ms with a fresh generation, and the probe recorded no `provider.read` row — no lane
  // ran. The ingress knew: the entry it served carried `fetchedAtMs`. It just never left this file.

  it("says `read`, with the moment of the read, when it fetched for this call", async () => {
    const ingress = new SnapshotIngress(async () => ok("A"), noopSource());
    const before = Date.now();
    const result = await ingress.getSnapshot("window:1");
    expect(result.observation?.from).toBe("read");
    expect(result.observation?.observedAtMs).toBeGreaterThanOrEqual(before);
  });

  it("says `cache`, and dates it to the FETCH rather than to this call", async () => {
    // **The clock is moved between the two calls, and that is the whole cell.** Written without
    // it, both calls land in the same millisecond, so `observedAtMs: Date.now()` on the cache-hit
    // road is numerically identical to the fetch's own stamp: the mutation that re-dates a
    // remembered answer to the moment it was served passed 107/107 green (measured, 2026-09-22).
    // Two answers that are supposed to differ have to be made to look different first.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const fetch = vi.fn(async () => ok("A"));
      const ingress = new SnapshotIngress(fetch, noopSource());
      const first = await ingress.getSnapshot("window:1");
      vi.setSystemTime(6_000);                        // still inside the 30 s TTL
      const second = await ingress.getSnapshot("window:1");

      expect(fetch).toHaveBeenCalledOnce();           // CONTROL: the second call really did not read
      expect(second.observation?.from).toBe("cache");
      // The date is the observation's, not the reply's. Stamping "now" here would make a
      // remembered answer look freshly read — the defect, expressed as a timestamp instead of a
      // word.
      expect(first.observation?.observedAtMs).toBe(1_000);
      expect(second.observation?.observedAtMs).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says `staleCache` when the fetch threw and the remembered entry went out anyway", async () => {
    let fail = false;
    const ingress = new SnapshotIngress(
      async () => {
        if (fail) throw new Error("boom");
        return ok("A");
      },
      noopSource(),
    );
    const first = await ingress.getSnapshot("window:1");
    fail = true;
    ingress.invalidate("window:1", "window-event");
    const second = await ingress.getSnapshot("window:1");

    expect(second.candidates).toHaveLength(1);      // the remembered answer did go out…
    expect(second.warnings).toContain("ingress_fetch_error");
    expect(second.observation?.from).toBe("staleCache");   // …and it is not called a read
    expect(second.observation?.observedAtMs).toBe(first.observation?.observedAtMs);
  });

  it("says `unavailable` — never `read` — when the fetch threw with nothing remembered", async () => {
    const ingress = new SnapshotIngress(async () => {
      throw new Error("boom");
    }, noopSource());
    const result = await ingress.getSnapshot("window:1");
    expect(result.candidates).toEqual([]);
    expect(result.observation).toEqual({ from: "unavailable" });
    // No date: there is no observation to date. An `observedAtMs` here would be the moment of a
    // read that did not happen.
    expect(result.observation?.observedAtMs).toBeUndefined();
  });

  it("says `unavailable` after dispose, where it used to say nothing at all", async () => {
    const ingress = new SnapshotIngress(async () => ok("A"), noopSource());
    ingress.dispose();
    expect((await ingress.getSnapshot("window:1")).observation).toEqual({ from: "unavailable" });
  });
});

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
