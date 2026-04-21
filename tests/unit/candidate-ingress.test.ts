import { describe, it, expect, vi } from "vitest";
import {
  SnapshotIngress,
  windowEventMatchesKey,
  type IngressEventSource,
  type IngressReason,
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

function noopSource(): IngressEventSource {
  return {
    drain: async () => [],
    dispose: vi.fn(),
  };
}

function eventSource(
  events: Array<{ key: string; reason: IngressReason }>
): IngressEventSource {
  let called = false;
  return {
    drain: async () => {
      if (called) return [];
      called = true;
      return events;
    },
    dispose: vi.fn(),
  };
}

describe("SnapshotIngress — cache behavior", () => {
  it("fetches on cache miss (first call)", async () => {
    const fetch = vi.fn(async () => [candidate("A")]);
    const ingress = new SnapshotIngress(fetch, noopSource());
    const result = await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledOnce();
    expect(result[0].label).toBe("A");
  });

  it("returns cached result on second call without invalidation", async () => {
    const fetch = vi.fn(async () => [candidate("A")]);
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledOnce(); // not called twice
  });

  it("re-fetches after invalidate()", async () => {
    const fetch = vi.fn(async (key: string) => [candidate(key)]);
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    ingress.invalidate("window:1", "winevent");
    await ingress.getSnapshot("window:1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after cache TTL expires", async () => {
    let now = 0;
    const fetch = vi.fn(async () => [candidate("A")]);
    const ingress = new SnapshotIngress(fetch, noopSource(), { cacheTtlMs: 100 });
    // Override internal Date.now behavior via mock
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await ingress.getSnapshot("window:1"); // fetch #1
    now = 200; // advance past TTL
    await ingress.getSnapshot("window:1"); // should re-fetch
    vi.restoreAllMocks();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns stale cache on fetch error", async () => {
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("network error");
      return [candidate("Stale")];
    });
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1"); // populate cache
    ingress.invalidate("window:1", "manual");
    fail = true;
    const result = await ingress.getSnapshot("window:1"); // error → stale
    expect(result[0].label).toBe("Stale");
  });

  it("returns [] on fetch error when cache is empty (startup failure)", async () => {
    const fetch = vi.fn(async () => { throw new Error("UIA unavailable"); });
    const ingress = new SnapshotIngress(fetch);
    const result = await ingress.getSnapshot("window:1");
    expect(result).toHaveLength(0);
  });
});

describe("SnapshotIngress — target isolation (Batch D key requirement)", () => {
  it("invalidate on key A does NOT affect key B's cache", async () => {
    const fetch = vi.fn(async (key: string) => [candidate(key)]);
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:A");
    await ingress.getSnapshot("window:B");
    ingress.invalidate("window:A", "winevent");
    await ingress.getSnapshot("window:B"); // must NOT re-fetch B
    // fetch was called: A(1) + B(1) + A-post-invalidate(1) = 3 if B re-fetched incorrectly
    // correct: A(1) + B(1) + A-post-invalidate(1) = 3 if B not re-fetched = 2 for B
    const bCalls = (fetch.mock.calls as string[][]).filter((args) => args[0] === "window:B");
    expect(bCalls).toHaveLength(1); // B only fetched once
  });

  it("event source returns events only for matching keys (target isolation)", async () => {
    const fetch = vi.fn(async (key: string) => [candidate(key)]);
    // Event fires on the 3rd drain call (after initial A and B fetches)
    let drainCount = 0;
    const source: IngressEventSource = {
      drain: async () => {
        drainCount++;
        // Return A event only on the 3rd drain (after A and B are in cache)
        if (drainCount === 3) return [{ key: "window:A", reason: "winevent" as IngressReason }];
        return [];
      },
      dispose: vi.fn(),
    };
    const ingress = new SnapshotIngress(fetch, source);
    await ingress.getSnapshot("window:A"); // drain #1: no events, fetch A
    await ingress.getSnapshot("window:B"); // drain #2: no events, fetch B
    await ingress.getSnapshot("window:A"); // drain #3: A event fires → A dirty → re-fetch A
    await ingress.getSnapshot("window:B"); // drain #4: no events, B cache still clean

    const aCalls = (fetch.mock.calls as string[][]).filter((a) => a[0] === "window:A");
    const bCalls = (fetch.mock.calls as string[][]).filter((a) => a[0] === "window:B");
    expect(aCalls).toHaveLength(2); // fetch + re-fetch after event
    expect(bCalls).toHaveLength(1); // only initial fetch — target isolation confirmed
  });

  it("idle: no background fetch — fetch count stays at 1 without see() calls", async () => {
    const fetch = vi.fn(async () => [candidate("A")]);
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    // Simulate idle time — no calls, no fetches
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledOnce(); // still just 1
  });
});

describe("SnapshotIngress — subscribe", () => {
  it("subscriber fires on invalidate", () => {
    const ingress = new SnapshotIngress(async () => []);
    const cb = vi.fn();
    ingress.subscribe("window:1", cb);
    ingress.invalidate("window:1", "winevent");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("subscriber does NOT fire for a different key", () => {
    const ingress = new SnapshotIngress(async () => []);
    const cb = vi.fn();
    ingress.subscribe("window:A", cb);
    ingress.invalidate("window:B", "winevent");
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops callbacks", () => {
    const ingress = new SnapshotIngress(async () => []);
    const cb = vi.fn();
    const unsub = ingress.subscribe("window:1", cb);
    unsub();
    ingress.invalidate("window:1", "winevent");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("SnapshotIngress — markRecovered", () => {
  it("markRecovered clears dirty flag without re-fetching immediately", async () => {
    const fetch = vi.fn(async () => [candidate("A")]);
    const ingress = new SnapshotIngress(fetch, noopSource());
    await ingress.getSnapshot("window:1");
    ingress.invalidate("window:1", "manual");
    ingress.markRecovered!("window:1");
    await ingress.getSnapshot("window:1"); // clean again — no fetch
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("SnapshotIngress — dispose", () => {
  it("getSnapshot returns [] after dispose", async () => {
    const ingress = new SnapshotIngress(async () => [candidate("A")]);
    await ingress.getSnapshot("window:1");
    ingress.dispose();
    const result = await ingress.getSnapshot("window:1");
    expect(result).toHaveLength(0);
  });

  it("calls eventSource.dispose on ingress.dispose", () => {
    const src = noopSource();
    const ingress = new SnapshotIngress(async () => [], src);
    ingress.dispose();
    expect(src.dispose).toHaveBeenCalled();
  });
});

describe("windowEventMatchesKey — matching logic", () => {
  it("window: key matches by hwnd equality", () => {
    expect(windowEventMatchesKey({ hwnd: "123" }, "window:123")).toBe(true);
    expect(windowEventMatchesKey({ hwnd: "123" }, "window:456")).toBe(false);
  });

  it("title: key matches by case-insensitive substring", () => {
    expect(windowEventMatchesKey({ windowTitle: "Notepad (modified)" }, "title:notepad")).toBe(true);
    expect(windowEventMatchesKey({ windowTitle: "Chrome" }, "title:Notepad")).toBe(false);
  });

  it("tab: key is never matched by WinEvent (CDP only)", () => {
    expect(windowEventMatchesKey({ hwnd: "123" }, "tab:abc")).toBe(false);
    expect(windowEventMatchesKey({ windowTitle: "anything" }, "tab:abc")).toBe(false);
  });

  it("event missing hwnd does not match window: key", () => {
    expect(windowEventMatchesKey({ windowTitle: "App" }, "window:123")).toBe(false);
  });
});
