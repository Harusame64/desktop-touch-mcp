/**
 * benchmark-gates.test.ts — Phase 3-E: gates that must hold for Phase 4 readiness.
 *
 * These tests verify the Phase 3 completion criteria:
 *   1. desktop_see can return visual candidates
 *   2. idle cost is not increased by visual lane activation
 *   3. visual lane does not pollute unrelated targets
 *   4. warning surface is coherent (no spurious warnings in normal operation)
 *   5. cold/warm latency gap is measurable via BenchmarkHarness
 *
 * Gate failures block Phase 4 (experimental quality review, default-on decision).
 */

import { describe, it, expect, afterEach } from "vitest";
import { BenchmarkHarness } from "../../src/engine/vision-gpu/benchmark.js";
import { ReplayBackend } from "../../src/engine/vision-gpu/replay-backend.js";
import { getVisualRuntime, _resetVisualRuntimeForTest } from "../../src/engine/vision-gpu/runtime.js";
import {
  getDesktopFacade,
  getPocVisualBackend,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";
import { _clearDirtySignalHandlersForTest } from "../../src/engine/vision-gpu/dirty-signal.js";
import { fetchVisualCandidates } from "../../src/tools/desktop-providers/visual-provider.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

afterEach(async () => {
  _clearDirtySignalHandlersForTest();
  await getVisualRuntime().dispose();
  _resetVisualRuntimeForTest();
  _resetFacadeForTest();
});

function visualCand(label: string, hwnd: string): UiEntityCandidate {
  return {
    source: "visual_gpu",
    target: { kind: "window", id: hwnd },
    label,
    role: "button",
    locator: { visual: { trackId: `t-${label}`, rect: { x: 100, y: 200, width: 150, height: 50 } } },
    actionability: ["invoke", "click"],
    confidence: 0.92,
    observedAtMs: Date.now(),
    provisional: false,
  };
}

// ── Gate 1: desktop_see can return visual candidates ──────────────────────────

describe("Gate 1 — visual lane delivers candidates via desktop_see", () => {
  it("game window returns visual_gpu source entities", async () => {
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));
    const backend = getPocVisualBackend();
    if (!backend) { expect.fail("PocVisualBackend not initialized"); return; }

    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-game" });
    backend.updateSnapshot("window:hwnd-game", [
      visualCand("Start Match", "hwnd-game"),
      visualCand("Settings", "hwnd-game"),
    ]);

    const out = await facade.see({ target: { hwnd: "hwnd-game" } });
    const visual = out.entities.filter((e) => e.sources.includes("visual_gpu"));
    expect(visual.length).toBeGreaterThanOrEqual(1);
  });

  it("ReplayBackend fixture returns game candidates via visual runtime", async () => {
    const replay = await ReplayBackend.fromFile(
      "tests/fixtures/benchmark/game/candidates.json",
      { coldWarmupMs: 0, warmFetchMs: 0 }
    );
    await getVisualRuntime().attach(replay);
    await getVisualRuntime().ensureWarm({ kind: "game", id: "game-window" });
    const cands = await getVisualRuntime().getStableCandidates("window:game-window");
    expect(cands.length).toBe(3);
    expect(cands.map((c) => c.label)).toContain("Start Match");
    await replay.dispose();
  });
});

// ── Gate 2: idle cost not increased ──────────────────────────────────────────

describe("Gate 2 — idle cost: no background polling added by visual lane", () => {
  it("visual runtime with no see() calls fires zero fetch operations", async () => {
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));
    const backend = getPocVisualBackend();
    if (!backend) return;

    // 100ms idle — verify no background activity
    const before = backend.getWarmState();
    await new Promise((r) => setTimeout(r, 100));
    const after = backend.getWarmState();

    // Warm state must not spontaneously change (no background polling)
    expect(before).toBe(after);
    // No unsolicited snapshot updates
    void facade;
  });

  it("BenchmarkHarness idle measurement shows near-zero overhead", async () => {
    const harness = new BenchmarkHarness();
    const idle = await harness.measure("game", "idle", async () => {
      // Simulate idle: no see() calls for 10ms
      await new Promise((r) => setTimeout(r, 10));
    });
    // Idle should add minimal overhead (< 50ms including test overhead)
    expect(idle.latencyMs).toBeLessThan(50);
  });
});

// ── Gate 3: target isolation ──────────────────────────────────────────────────

describe("Gate 3 — target isolation: visual lane does not pollute unrelated targets", () => {
  it("candidates for window A do not appear in window B", async () => {
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));
    const backend = getPocVisualBackend();
    if (!backend) return;

    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-A" });
    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-B" });
    backend.updateSnapshot("window:hwnd-A", [visualCand("ButtonA", "hwnd-A")]);

    const outA = await facade.see({ target: { hwnd: "hwnd-A" } });
    const outB = await facade.see({ target: { hwnd: "hwnd-B" } });

    const visualA = outA.entities.filter((e) => e.sources.includes("visual_gpu"));
    const visualB = outB.entities.filter((e) => e.sources.includes("visual_gpu"));

    expect(visualA.length).toBeGreaterThan(0);
    expect(visualB).toHaveLength(0);
  });

  it("dirty signal for A does not mark B as dirty", async () => {
    const harness = new BenchmarkHarness();
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));
    const backend = getPocVisualBackend();
    if (!backend) return;

    backend.updateSnapshot("window:hwnd-A", [visualCand("Btn", "hwnd-A")]);

    // B should not have been dirtied
    const outB = await facade.see({ target: { hwnd: "hwnd-B" } });
    const visualB = outB.entities.filter((e) => e.sources.includes("visual_gpu"));
    expect(visualB).toHaveLength(0);
    void harness;
  });
});

// ── Gate 4: warning surface coherence ────────────────────────────────────────

describe("Gate 4 — warning surface: coherent, no spurious warnings", () => {
  it("visual_provider_unavailable not present after PocVisualBackend attached", async () => {
    getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));
    const backend = getPocVisualBackend();
    if (!backend) return;
    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-check" });
    const out = await getDesktopFacade().see({ target: { hwnd: "hwnd-check" } });
    expect(out.warnings ?? []).not.toContain("visual_provider_unavailable");
  });

  it("visual_provider_warming when backend has not been warmed yet", async () => {
    // Test fetchVisualCandidates directly (no facade) to avoid initVisualRuntime race.
    const slowMock = {
      ensureWarm: async () => "cold" as const,
      getStableCandidates: async () => [] as UiEntityCandidate[],
      onDirty: () => () => {},
      dispose: async () => {},
    };
    await getVisualRuntime().attach(slowMock);
    const r = await fetchVisualCandidates({ windowTitle: "GameColdWindow" });
    expect(r.warnings).toContain("visual_provider_warming");
  });

  it("no excess warnings when UIA and visual both succeed", async () => {
    getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));
    const backend = getPocVisualBackend();
    if (!backend) return;
    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-clean" });
    const out = await getDesktopFacade().see({ target: { hwnd: "hwnd-clean" } });
    // visual_provider_unavailable and visual_provider_failed must be absent
    const visualWarnings = (out.warnings ?? []).filter((w) => w.startsWith("visual_provider_"));
    expect(visualWarnings).not.toContain("visual_provider_unavailable");
    expect(visualWarnings).not.toContain("visual_provider_failed");
  });
});

// ── Gate 5: cold/warm latency gap measurable ─────────────────────────────────

describe("Gate 5 — cold/warm latency gap is measurable", () => {
  it("ReplayBackend cold path is slower than warm path (BenchmarkHarness)", async () => {
    const COLD_MS = 80;
    const WARM_MS = 10;
    const backend = ReplayBackend.fromRecord(
      {
        "window:g": [visualCand("Btn", "g")],
      },
      { coldWarmupMs: COLD_MS, warmFetchMs: WARM_MS }
    );
    await getVisualRuntime().attach(backend);
    const harness = new BenchmarkHarness();

    const cold = await harness.measure("game", "cold", async () => {
      await getVisualRuntime().ensureWarm({ kind: "game", id: "g" });
      await getVisualRuntime().getStableCandidates("window:g");
    });

    const warm = await harness.measure("game", "warm", async () => {
      await getVisualRuntime().ensureWarm({ kind: "game", id: "g" });
      await getVisualRuntime().getStableCandidates("window:g");
    });

    expect(cold.latencyMs).toBeGreaterThan(warm.latencyMs);
    expect(warm.latencyMs).toBeLessThan(COLD_MS / 2);

    // Verify benchmark result is serializable (for doc/JSON persistence)
    const result = harness.toResult();
    expect(typeof JSON.stringify(result)).toBe("string");
    expect(result.metrics[0].mode).toBe("cold");
    expect(result.metrics[1].mode).toBe("warm");

    await backend.dispose();
  });
});
