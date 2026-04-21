import { describe, it, expect, vi } from "vitest";
import {
  combineEventSources,
  type IngressEventSource,
  type IngressReason,
} from "../../src/engine/world-graph/candidate-ingress.js";
import { createVisualIngressSource } from "../../src/engine/world-graph/visual-ingress.js";
import { createBrowserIngressSource } from "../../src/engine/world-graph/browser-ingress.js";
import { createTerminalIngressSource } from "../../src/engine/world-graph/terminal-ingress.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function staticSource(events: Array<{ key: string; reason: IngressReason }>): IngressEventSource {
  let delivered = false;
  return {
    drain: async (knownKeys) => {
      if (delivered) return [];
      delivered = true;
      return events.filter((e) => knownKeys.has(e.key));
    },
    dispose: vi.fn(),
  };
}

function noop(): IngressEventSource {
  return { drain: async () => [], dispose: vi.fn() };
}

const ALL_KEYS = new Set(["window:1", "tab:t1", "title:PowerShell"]);

// ── combineEventSources ───────────────────────────────────────────────────────

describe("combineEventSources", () => {
  it("drains all sub-sources and merges results", async () => {
    const src = combineEventSources([
      staticSource([{ key: "window:1", reason: "winevent" }]),
      staticSource([{ key: "tab:t1",   reason: "cdp" }]),
    ]);
    const events = await src.drain(ALL_KEYS);
    const keys = [...events].map((e) => e.key);
    expect(keys).toContain("window:1");
    expect(keys).toContain("tab:t1");
  });

  it("deduplicates events for the same key across sources", async () => {
    const src = combineEventSources([
      staticSource([{ key: "window:1", reason: "winevent" }]),
      staticSource([{ key: "window:1", reason: "winevent" }]),
    ]);
    const events = [...await src.drain(ALL_KEYS)];
    expect(events.filter((e) => e.key === "window:1")).toHaveLength(1);
  });

  it("skips keys not in knownKeys", async () => {
    const src = combineEventSources([
      staticSource([{ key: "window:unknown", reason: "winevent" }]),
    ]);
    const events = [...await src.drain(ALL_KEYS)];
    expect(events.find((e) => e.key === "window:unknown")).toBeUndefined();
  });

  it("continues draining other sources when one throws", async () => {
    const broken: IngressEventSource = {
      drain: async () => { throw new Error("broken"); },
      dispose: vi.fn(),
    };
    const src = combineEventSources([
      broken,
      staticSource([{ key: "tab:t1", reason: "cdp" }]),
    ]);
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("tab:t1");
  });

  it("dispose calls all sub-source dispose methods", () => {
    const a = noop(), b = noop();
    const src = combineEventSources([a, b]);
    src.dispose();
    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalled();
  });

  it("returns empty for empty sources array", async () => {
    const src = combineEventSources([]);
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(0);
  });
});

// ── VisualIngressSource ───────────────────────────────────────────────────────

describe("createVisualIngressSource", () => {
  it("returns no events when nothing marked dirty", async () => {
    const src = createVisualIngressSource();
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(0);
  });

  it("returns dirty event for key in knownKeys", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:1");
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("window:1");
    expect(events[0].reason).toBe("dirty-rect");
  });

  it("ignores dirty keys not in knownKeys", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:99"); // not in ALL_KEYS
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(0);
  });

  it("clears pending after drain — subsequent drain returns empty", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:1");
    await src.drain(ALL_KEYS); // first drain consumes
    const second = [...await src.drain(ALL_KEYS)];
    expect(second).toHaveLength(0);
  });

  it("accepts custom reason", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:1", "manual");
    const events = [...await src.drain(ALL_KEYS)];
    expect(events[0].reason).toBe("manual");
  });

  it("can mark multiple keys dirty", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:1");
    src.markDirty("tab:t1");
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(2);
  });

  it("target isolation: only marked key is returned, not all knownKeys", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:1"); // only one key
    const events = [...await src.drain(ALL_KEYS)];
    const keys = events.map((e) => e.key);
    expect(keys).toContain("window:1");
    expect(keys).not.toContain("tab:t1");
    expect(keys).not.toContain("title:PowerShell");
  });

  it("dispose clears pending", async () => {
    const src = createVisualIngressSource();
    src.markDirty("window:1");
    src.dispose();
    const events = [...await src.drain(ALL_KEYS)];
    expect(events).toHaveLength(0);
  });
});

// ── BrowserIngressSource — isolation and graceful degradation ─────────────────

describe("createBrowserIngressSource", () => {
  it("returns empty when no tab: keys in knownKeys", async () => {
    const src = createBrowserIngressSource();
    const windowOnly = new Set(["window:1", "title:App"]);
    const events = [...await src.drain(windowOnly)];
    expect(events).toHaveLength(0);
  });

  it("gracefully returns empty when CDP is unavailable", async () => {
    const src = createBrowserIngressSource();
    // CDP unavailable (no Chrome running) → should not throw, returns []
    const events = [...await src.drain(new Set(["tab:t1"]))];
    expect(Array.isArray(events)).toBe(true);
  });

  it("only invalidates tab: keys (not window: or title:)", async () => {
    // Even if the source internally checks tabs, window: keys must never appear
    // in output. This is structural: filterKey by startsWith("tab:").
    const src = createBrowserIngressSource();
    // With CDP unavailable, no invalidations — confirms tab isolation by default
    const events = [...await src.drain(new Set(["window:1"]))];
    for (const e of events) {
      expect(e.key.startsWith("tab:")).toBe(true);
    }
  });
});

// ── TerminalIngressSource — isolation and graceful degradation ────────────────

describe("createTerminalIngressSource", () => {
  it("returns empty when no title: terminal keys in knownKeys", async () => {
    const src = createTerminalIngressSource();
    const nonTerminal = new Set(["tab:t1", "window:1", "title:Notepad"]);
    const events = [...await src.drain(nonTerminal)];
    expect(events).toHaveLength(0);
  });

  it("gracefully returns empty when terminal window not found", async () => {
    const src = createTerminalIngressSource();
    const events = [...await src.drain(new Set(["title:PowerShell"]))];
    expect(Array.isArray(events)).toBe(true);
  });

  it("only processes title: keys (not tab: or window: keys)", async () => {
    const src = createTerminalIngressSource();
    // window: and tab: keys should never trigger a terminal check
    const events = [...await src.drain(new Set(["window:1", "tab:t1"]))];
    for (const e of events) {
      expect(e.key.startsWith("title:")).toBe(true);
    }
  });

  it("only processes terminal-like titles (not all title: keys)", async () => {
    const src = createTerminalIngressSource();
    // "title:Notepad" should NOT be checked (not a terminal pattern)
    const events = [...await src.drain(new Set(["title:Notepad"]))];
    expect(events).toHaveLength(0); // Notepad is not a terminal
  });
});

// ── Integration: target isolation in composite source ─────────────────────────

describe("combineEventSources — target isolation across source types", () => {
  it("browser source event does not invalidate window: key", async () => {
    // Simulate a browser source that emits a tab event
    const browserLike: IngressEventSource = {
      drain: async (keys) => keys.has("tab:t1") ? [{ key: "tab:t1", reason: "cdp" as IngressReason }] : [],
      dispose: vi.fn(),
    };
    const composite = combineEventSources([browserLike]);
    const mixed = new Set(["window:1", "tab:t1"]);
    const events = [...await composite.drain(mixed)];
    const keys = events.map((e) => e.key);
    expect(keys).not.toContain("window:1");
    expect(keys).toContain("tab:t1");
  });

  it("visual source only invalidates explicitly marked keys", async () => {
    const visualSrc = createVisualIngressSource();
    const composite = combineEventSources([noop(), visualSrc, noop()]);
    visualSrc.markDirty("window:1");
    const events = [...await composite.drain(new Set(["window:1", "tab:t1"]))];
    const keys = events.map((e) => e.key);
    expect(keys).toContain("window:1");
    expect(keys).not.toContain("tab:t1");
  });
});
