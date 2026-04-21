import { describe, it, expect, afterEach, vi } from "vitest";
import { PocVisualBackend } from "../../src/engine/vision-gpu/poc-backend.js";
import {
  getVisualRuntime,
  _resetVisualRuntimeForTest,
} from "../../src/engine/vision-gpu/runtime.js";
import {
  getDesktopFacade,
  getPocVisualBackend,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

afterEach(async () => {
  await getVisualRuntime().dispose();
  _resetVisualRuntimeForTest();
  _resetFacadeForTest();
});

function gameCandidate(label: string, targetId: string): UiEntityCandidate {
  return {
    source: "visual_gpu",
    target: { kind: "window", id: targetId },
    label,
    role: "button",
    locator: { visual: { trackId: `track-${label}`, rect: { x: 50, y: 80, width: 120, height: 40 } } },
    actionability: ["invoke", "click"],
    confidence: 0.91,
    observedAtMs: Date.now(),
    provisional: false,
  };
}

// ── PocVisualBackend — unit tests ─────────────────────────────────────────────

describe("PocVisualBackend — warmup", () => {
  it("starts cold, becomes warm on ensureWarm()", async () => {
    const b = new PocVisualBackend();
    expect(b.getWarmState()).toBe("cold");
    const s = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(s).toBe("warm");
    expect(b.getWarmState()).toBe("warm");
    await b.dispose();
  });

  it("warm path is idempotent", async () => {
    const b = new PocVisualBackend();
    await b.ensureWarm({ kind: "game", id: "g1" });
    const s = await b.ensureWarm({ kind: "game", id: "g1" }); // second call
    expect(s).toBe("warm");
    await b.dispose();
  });
});

describe("PocVisualBackend — candidate snapshot", () => {
  it("returns [] before any snapshot is set", async () => {
    const b = new PocVisualBackend();
    expect(await b.getStableCandidates("window:g1")).toEqual([]);
    await b.dispose();
  });

  it("returns injected candidates after updateSnapshot()", async () => {
    const b = new PocVisualBackend();
    const cands = [gameCandidate("Start Match", "g1")];
    b.updateSnapshot("window:g1", cands);
    const result = await b.getStableCandidates("window:g1");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Start Match");
    await b.dispose();
  });

  it("different targetKeys are isolated", async () => {
    const b = new PocVisualBackend();
    b.updateSnapshot("window:A", [gameCandidate("ButtonA", "A")]);
    b.updateSnapshot("window:B", [gameCandidate("ButtonB", "B")]);
    expect((await b.getStableCandidates("window:A"))[0].label).toBe("ButtonA");
    expect((await b.getStableCandidates("window:B"))[0].label).toBe("ButtonB");
    expect(await b.getStableCandidates("window:C")).toEqual([]);
    await b.dispose();
  });
});

describe("PocVisualBackend — dirty signals", () => {
  it("fires dirty listener when updateSnapshot() is called", () => {
    const b = new PocVisualBackend();
    const received: string[] = [];
    b.onDirty((key) => received.push(key));
    b.updateSnapshot("window:g1", [gameCandidate("Btn", "g1")]);
    expect(received).toContain("window:g1");
  });

  it("unsubscribe stops dirty callbacks", () => {
    const b = new PocVisualBackend();
    const received: string[] = [];
    const unsub = b.onDirty((key) => received.push(key));
    unsub();
    b.updateSnapshot("window:g1", []);
    expect(received).toHaveLength(0);
  });

  it("only the updated targetKey is in the dirty signal", () => {
    const b = new PocVisualBackend();
    const received: string[] = [];
    b.onDirty((key) => received.push(key));
    b.updateSnapshot("window:X", []);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("window:X");
  });
});

// ── P3-B integration: desktop_see returns visual candidates ───────────────────

describe("P3-B integration — visual candidates appear in desktop_see", () => {
  it("visual_gpu candidates returned when PocVisualBackend has a snapshot", async () => {
    // Get facade (this triggers initVisualRuntime async)
    const facade = getDesktopFacade();

    // Wait for the async backend init to complete
    await new Promise((r) => setTimeout(r, 100));

    const backend = getPocVisualBackend();
    expect(backend).toBeDefined();

    if (!backend) return;

    // Ensure warm for the game target
    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-game" });

    // Inject a fixture candidate
    const cand = gameCandidate("Play Button", "hwnd-game");
    backend.updateSnapshot("window:hwnd-game", [cand]);

    // see() for that window — visual candidate should appear
    const output = await facade.see({ target: { hwnd: "hwnd-game" } });

    // visual_gpu source should be in the entity sources
    const visualEntities = output.entities.filter((e) => e.sources.includes("visual_gpu"));
    expect(visualEntities.length).toBeGreaterThan(0);
    expect(visualEntities[0].label).toBe("Play Button");

    // visual_provider_unavailable must NOT appear (runtime is live)
    expect(output.warnings ?? []).not.toContain("visual_provider_unavailable");
  });

  it("visual_provider_unavailable not present once backend is attached", async () => {
    getDesktopFacade();
    await new Promise((r) => setTimeout(r, 100));
    const backend = getPocVisualBackend();
    if (!backend) return;

    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-test" });
    // Empty snapshot is valid (no unavailable warning)
    const output = await getDesktopFacade().see({ target: { hwnd: "hwnd-test" } });
    expect(output.warnings ?? []).not.toContain("visual_provider_unavailable");
  });

  it("updateSnapshot triggers dirty signal → ingress marks key dirty", async () => {
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 100));
    const backend = getPocVisualBackend();
    if (!backend) return;

    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-dirty" });

    // First see() — no candidates yet
    const first = await facade.see({ target: { hwnd: "hwnd-dirty" } });
    const firstVisual = first.entities.filter((e) => e.sources.includes("visual_gpu"));
    expect(firstVisual).toHaveLength(0);

    // Inject a candidate — this fires dirty, marks ingress entry dirty
    backend.updateSnapshot("window:hwnd-dirty", [gameCandidate("Confirm", "hwnd-dirty")]);

    // Second see() — ingress detects dirty and fetches fresh
    const second = await facade.see({ target: { hwnd: "hwnd-dirty" } });
    const secondVisual = second.entities.filter((e) => e.sources.includes("visual_gpu"));
    expect(secondVisual.length).toBeGreaterThan(0);
    expect(secondVisual[0].label).toBe("Confirm");
  });
});
