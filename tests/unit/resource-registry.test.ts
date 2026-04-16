/**
 * tests/unit/resource-registry.test.ts
 *
 * Unit tests for ResourceRegistry — URI lifecycle management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ResourceRegistry } from "../../src/engine/perception/resource-registry.js";
import type { PerceptionLens, LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseIdentity: WindowIdentity = {
  hwnd: "100", pid: 1234, processName: "notepad.exe",
  processStartTimeMs: 1700000000000, titleResolved: "Notepad",
};

function makeLens(lensId: string, hwnd = "100"): PerceptionLens {
  return {
    lensId,
    spec: {
      name: lensId,
      target: { kind: "window", match: { titleIncludes: "test" } },
      maintain: ["target.foreground"],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    } satisfies LensSpec,
    binding: { hwnd, windowTitle: "Test" },
    boundIdentity: { ...baseIdentity, hwnd },
    fluentKeys: [`window:${hwnd}.target.foreground`],
    registeredAtSeq: 0,
    registeredAtMs: Date.now(),
  };
}

describe("ResourceRegistry — registration", () => {
  let reg: ResourceRegistry;

  beforeEach(() => {
    reg = new ResourceRegistry();
    reg.__resetForTests();
  });

  it("onLensRegistered returns summary and guards URIs", () => {
    const uris = reg.onLensRegistered(makeLens("perc-1"));
    expect(uris).toContain("perception://lens/perc-1/summary");
    expect(uris).toContain("perception://lens/perc-1/guards");
  });

  it("debug/events URIs are not included without DEBUG_RESOURCES flag", () => {
    delete process.env.DESKTOP_TOUCH_PERCEPTION_DEBUG_RESOURCES;
    const uris = reg.onLensRegistered(makeLens("perc-1"));
    expect(uris).not.toContain("perception://lens/perc-1/debug");
    expect(uris).not.toContain("perception://lens/perc-1/events");
  });

  it("debug/events URIs are included with DEBUG_RESOURCES=1", () => {
    vi.stubEnv("DESKTOP_TOUCH_PERCEPTION_DEBUG_RESOURCES", "1");
    const uris = reg.onLensRegistered(makeLens("perc-2"));
    expect(uris).toContain("perception://lens/perc-2/debug");
    expect(uris).toContain("perception://lens/perc-2/events");
    vi.unstubAllEnvs();
  });

  it("getLensId resolves URI to lensId", () => {
    reg.onLensRegistered(makeLens("perc-1"));
    expect(reg.getLensId("perception://lens/perc-1/summary")).toBe("perc-1");
    expect(reg.getLensId("perception://lens/perc-1/guards")).toBe("perc-1");
  });

  it("listUris includes all registered URIs", () => {
    reg.onLensRegistered(makeLens("perc-1"));
    reg.onLensRegistered(makeLens("perc-2"));
    const all = reg.listUris();
    expect(all).toContain("perception://lens/perc-1/summary");
    expect(all).toContain("perception://lens/perc-2/guards");
  });

  it("onListChanged callback fires on register", () => {
    const changes: number[] = [];
    reg.setOnListChanged(() => changes.push(1));
    reg.onLensRegistered(makeLens("perc-1"));
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe("ResourceRegistry — tombstone", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("onLensForgotten removes URIs from active list and creates tombstone", () => {
    const reg = new ResourceRegistry();
    reg.onLensRegistered(makeLens("perc-1"));
    reg.onLensForgotten("perc-1");

    expect(reg.listUris()).not.toContain("perception://lens/perc-1/summary");
    expect(reg.getTombstone("perception://lens/perc-1/summary")).toBeDefined();
    expect(reg.getTombstone("perception://lens/perc-1/guards")).toBeDefined();
  });

  it("tombstone disappears after 30s TTL", () => {
    const reg = new ResourceRegistry();
    reg.onLensRegistered(makeLens("perc-1"));
    reg.onLensForgotten("perc-1");

    vi.advanceTimersByTime(29_999);
    expect(reg.getTombstone("perception://lens/perc-1/summary")).toBeDefined();

    vi.advanceTimersByTime(2);
    expect(reg.getTombstone("perception://lens/perc-1/summary")).toBeUndefined();
  });

  it("tombstone has lensId and removedAtMs", () => {
    const reg = new ResourceRegistry();
    reg.onLensRegistered(makeLens("perc-1"));
    reg.onLensForgotten("perc-1");

    const t = reg.getTombstone("perception://lens/perc-1/summary");
    expect(t).toBeDefined();
    expect(t!.lensId).toBe("perc-1");
    expect(typeof t!.removedAtMs).toBe("number");
    expect(typeof t!.message).toBe("string");
  });

  it("re-registering a lens clears its tombstone", () => {
    const reg = new ResourceRegistry();
    reg.onLensRegistered(makeLens("perc-1"));
    reg.onLensForgotten("perc-1");
    expect(reg.getTombstone("perception://lens/perc-1/summary")).toBeDefined();

    reg.onLensRegistered(makeLens("perc-1")); // re-register
    expect(reg.getTombstone("perception://lens/perc-1/summary")).toBeUndefined();
    expect(reg.listUris()).toContain("perception://lens/perc-1/summary");
  });

  it("evicts oldest tombstone when 128 limit is reached", () => {
    const reg = new ResourceRegistry();
    // Fill 128 tombstones by registering/forgetting 64 lenses (2 URIs each)
    for (let i = 0; i < 64; i++) {
      reg.onLensRegistered(makeLens(`perc-${i}`));
      reg.onLensForgotten(`perc-${i}`);
    }
    // The first tombstone (perc-0/summary) should have been evicted
    // (we have 64*2=128 tombstones so exactly at limit — next add will evict oldest)
    reg.onLensRegistered(makeLens("perc-overflow"));
    reg.onLensForgotten("perc-overflow"); // adds 2 more (129th, 130th) → evicts 2 oldest
    expect(reg.getTombstone("perception://lens/perc-0/summary")).toBeUndefined();
  });
});
