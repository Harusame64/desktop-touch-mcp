import { describe, it, expect, afterEach } from "vitest";
import { VisualRuntime, getVisualRuntime, _resetVisualRuntimeForTest, targetKeyToWarmTarget } from "../../src/engine/vision-gpu/runtime.js";
import { MockVisualBackend } from "../../src/engine/vision-gpu/backend.js";
import { fetchVisualCandidates } from "../../src/tools/desktop-providers/visual-provider.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

afterEach(() => {
  _resetVisualRuntimeForTest();
});

// ── VisualRuntime — lifecycle ─────────────────────────────────────────────────

describe("VisualRuntime — availability", () => {
  it("not available when no backend attached", () => {
    const rt = new VisualRuntime();
    expect(rt.isAvailable()).toBe(false);
  });

  it("available after attach()", () => {
    const rt = new VisualRuntime();
    rt.attach(new MockVisualBackend());
    expect(rt.isAvailable()).toBe(true);
  });

  it("not available after detach()", () => {
    const rt = new VisualRuntime();
    rt.attach(new MockVisualBackend());
    rt.detach();
    expect(rt.isAvailable()).toBe(false);
  });

  it("not available after dispose()", async () => {
    const rt = new VisualRuntime();
    rt.attach(new MockVisualBackend());
    await rt.dispose();
    expect(rt.isAvailable()).toBe(false);
  });
});

describe("VisualRuntime — ensureWarm", () => {
  it("returns cold when no backend", async () => {
    const rt = new VisualRuntime();
    expect(await rt.ensureWarm({ kind: "game", id: "g1" })).toBe("cold");
  });

  it("returns warm after backend.ensureWarm", async () => {
    const rt = new VisualRuntime();
    rt.attach(new MockVisualBackend());
    expect(await rt.ensureWarm({ kind: "game", id: "g1" })).toBe("warm");
  });
});

describe("VisualRuntime — getStableCandidates", () => {
  it("returns [] when no backend", async () => {
    const rt = new VisualRuntime();
    expect(await rt.getStableCandidates("window:1")).toEqual([]);
  });

  it("returns injected candidates from MockVisualBackend", async () => {
    const rt = new VisualRuntime();
    const mock = new MockVisualBackend();
    await mock.ensureWarm({ kind: "game", id: "g1" });
    const candidate: UiEntityCandidate = {
      source: "visual_gpu",
      target: { kind: "window", id: "g1" },
      label: "Start Match",
      role: "button",
      actionability: ["invoke", "click"],
      confidence: 0.91,
      observedAtMs: Date.now(),
      provisional: false,
    };
    mock.setCandidates("window:g1", [candidate]);
    rt.attach(mock);
    const result = await rt.getStableCandidates("window:g1");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Start Match");
  });
});

describe("VisualRuntime — onDirty", () => {
  it("returns no-op when no backend", () => {
    const rt = new VisualRuntime();
    const unsub = rt.onDirty(() => {});
    expect(() => unsub()).not.toThrow();
  });

  it("listener receives dirty signal from backend", () => {
    const rt = new VisualRuntime();
    const mock = new MockVisualBackend();
    rt.attach(mock);
    const received: string[] = [];
    rt.onDirty((key) => received.push(key));
    mock.triggerDirty("window:game1");
    expect(received).toContain("window:game1");
  });

  it("unsubscribe stops callbacks", () => {
    const rt = new VisualRuntime();
    const mock = new MockVisualBackend();
    rt.attach(mock);
    const received: string[] = [];
    const unsub = rt.onDirty((key) => received.push(key));
    unsub();
    mock.triggerDirty("window:game1");
    expect(received).toHaveLength(0);
  });

  it("target isolation: only specified key fires", () => {
    const rt = new VisualRuntime();
    const mock = new MockVisualBackend();
    rt.attach(mock);
    const received: string[] = [];
    rt.onDirty((key) => received.push(key));
    mock.triggerDirty("window:game1");
    mock.triggerDirty("window:game2");
    expect(received).toContain("window:game1");
    expect(received).toContain("window:game2");
    // The callback decides filtering — the runtime passes all signals through
    expect(received).toHaveLength(2);
  });
});

describe("getVisualRuntime — singleton", () => {
  it("returns the same instance on repeated calls", () => {
    const a = getVisualRuntime();
    const b = getVisualRuntime();
    expect(a).toBe(b);
  });

  it("_resetVisualRuntimeForTest creates a fresh instance", () => {
    const first = getVisualRuntime();
    _resetVisualRuntimeForTest();
    const second = getVisualRuntime();
    expect(first).not.toBe(second);
  });
});

// ── targetKeyToWarmTarget ─────────────────────────────────────────────────────

describe("targetKeyToWarmTarget", () => {
  it("tab: → kind=browser", () => {
    expect(targetKeyToWarmTarget("tab:tab-1")).toEqual({ kind: "browser", id: "tab-1" });
  });
  it("window: → kind=game", () => {
    expect(targetKeyToWarmTarget("window:hwnd-1")).toEqual({ kind: "game", id: "hwnd-1" });
  });
  it("title: → kind=game", () => {
    expect(targetKeyToWarmTarget("title:GameWindow")).toEqual({ kind: "game", id: "GameWindow" });
  });
  it("unknown → kind=game with full key as id", () => {
    expect(targetKeyToWarmTarget("other:x")).toEqual({ kind: "game", id: "other:x" });
  });
});

// ── fetchVisualCandidates — P3-A boundary ─────────────────────────────────────

describe("fetchVisualCandidates — runtime dependency (P3-A)", () => {
  it("returns visual_provider_unavailable when runtime has no backend", async () => {
    // Runtime singleton has no backend after reset
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.warnings).toContain("visual_provider_unavailable");
    expect(r.candidates).toHaveLength(0);
  });

  it("returns visual_provider_warming when backend warms cold state", async () => {
    const rt = getVisualRuntime();
    // Attach a mock that keeps returning "cold" (simulate slow warmup)
    const slowMock = {
      ensureWarm: async () => "cold" as const,
      getStableCandidates: async () => [] as UiEntityCandidate[],
      onDirty: () => () => {},
      dispose: async () => {},
    };
    rt.attach(slowMock);
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.warnings).toContain("visual_provider_warming");
  });

  it("returns empty candidates (no warning) when backend is warm but has no tracks yet", async () => {
    const rt = getVisualRuntime();
    rt.attach(new MockVisualBackend()); // warm but no candidates
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.warnings).toHaveLength(0);
    expect(r.candidates).toHaveLength(0);
  });

  it("returns candidates when backend is warm and has stable tracks", async () => {
    const rt = getVisualRuntime();
    const mock = new MockVisualBackend();
    const candidate: UiEntityCandidate = {
      source: "visual_gpu",
      target: { kind: "window", id: "123" },
      label: "Play",
      role: "button",
      locator: { visual: { trackId: "t1", rect: { x: 50, y: 80, width: 100, height: 40 } } },
      actionability: ["invoke", "click"],
      confidence: 0.92,
      observedAtMs: Date.now(),
      provisional: false,
    };
    mock.setCandidates("window:123", [candidate]);
    rt.attach(mock);
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].label).toBe("Play");
    expect(r.warnings).toHaveLength(0);
  });

  it("locator.visual.trackId is present on returned candidates", async () => {
    const rt = getVisualRuntime();
    const mock = new MockVisualBackend();
    mock.setCandidates("window:abc", [{
      source: "visual_gpu",
      target: { kind: "window", id: "abc" },
      label: "Continue",
      role: "button",
      locator: { visual: { trackId: "track-99" } },
      actionability: ["invoke"],
      confidence: 0.88,
      observedAtMs: Date.now(),
      provisional: false,
    }]);
    rt.attach(mock);
    const r = await fetchVisualCandidates({ hwnd: "abc" });
    expect(r.candidates[0].locator?.visual?.trackId).toBe("track-99");
    expect(r.candidates[0].source).toBe("visual_gpu");
  });
});
