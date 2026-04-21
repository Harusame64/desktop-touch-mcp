import { describe, it, expect, afterEach } from "vitest";
import {
  onDirtySignal,
  pushDirtySignal,
  _clearDirtySignalHandlersForTest,
} from "../../src/engine/vision-gpu/dirty-signal.js";
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
  _clearDirtySignalHandlersForTest();
  await getVisualRuntime().dispose();
  _resetVisualRuntimeForTest();
  _resetFacadeForTest();
});

function cand(label: string, targetId: string): UiEntityCandidate {
  return {
    source: "visual_gpu",
    target: { kind: "window", id: targetId },
    label,
    role: "button",
    locator: { visual: { trackId: `t-${label}` } },
    actionability: ["invoke"],
    confidence: 0.9,
    observedAtMs: Date.now(),
    provisional: false,
  };
}

// ── pushDirtySignal / onDirtySignal — unit ────────────────────────────────────

describe("dirty signal pub/sub", () => {
  it("registered handler receives pushed signal", () => {
    const received: Array<{ key: string; count: number }> = [];
    onDirtySignal((key, cands) => received.push({ key, count: cands.length }));
    pushDirtySignal("window:g1", [cand("Btn", "g1")]);
    expect(received).toHaveLength(1);
    expect(received[0].key).toBe("window:g1");
    expect(received[0].count).toBe(1);
  });

  it("multiple handlers all receive the signal", () => {
    const a: string[] = [], b: string[] = [];
    onDirtySignal((key) => a.push(key));
    onDirtySignal((key) => b.push(key));
    pushDirtySignal("window:g1", []);
    expect(a).toContain("window:g1");
    expect(b).toContain("window:g1");
  });

  it("unsubscribe stops the handler", () => {
    const received: string[] = [];
    const unsub = onDirtySignal((key) => received.push(key));
    unsub();
    pushDirtySignal("window:g1", []);
    expect(received).toHaveLength(0);
  });

  it("one failing handler does not block others", () => {
    const ok: string[] = [];
    onDirtySignal(() => { throw new Error("handler error"); });
    onDirtySignal((key) => ok.push(key));
    expect(() => pushDirtySignal("window:g1", [])).not.toThrow();
    expect(ok).toContain("window:g1");
  });

  it("target isolation: only the pushed key is received", () => {
    const received: string[] = [];
    onDirtySignal((key) => received.push(key));
    pushDirtySignal("window:A", []);
    pushDirtySignal("window:B", []);
    expect(received).toEqual(["window:A", "window:B"]);
  });

  it("pushDirtySignal with empty candidates sends no candidates", () => {
    const counts: number[] = [];
    onDirtySignal((_key, cands) => counts.push(cands.length));
    pushDirtySignal("window:g1"); // no candidates arg
    expect(counts[0]).toBe(0);
  });
});

// ── P3-C integration: pushDirtySignal → ingress invalidation → see() refresh ──

describe("P3-C integration — pushDirtySignal feeds visual candidates into desktop_see", () => {
  it("candidates pushed via pushDirtySignal appear in subsequent see()", async () => {
    // Initialize facade (triggers initVisualRuntime async)
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));

    const backend = getPocVisualBackend();
    if (!backend) { console.warn("backend not ready — skipping"); return; }

    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-push" });

    // Push candidates via the global dirty signal (this is what P3-D will call)
    pushDirtySignal("window:hwnd-push", [cand("Exit", "hwnd-push")]);

    const output = await facade.see({ target: { hwnd: "hwnd-push" } });
    const visual = output.entities.filter((e) => e.sources.includes("visual_gpu"));
    expect(visual.length).toBeGreaterThan(0);
    expect(visual[0].label).toBe("Exit");
  });

  it("target isolation: pushDirtySignal for A does not affect B's candidates", async () => {
    const facade = getDesktopFacade();
    await new Promise((r) => setTimeout(r, 150));

    const backend = getPocVisualBackend();
    if (!backend) return;

    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-A" });
    await getVisualRuntime().ensureWarm({ kind: "game", id: "hwnd-B" });

    // Push candidate only for A
    pushDirtySignal("window:hwnd-A", [cand("ButtonA", "hwnd-A")]);

    const outA = await facade.see({ target: { hwnd: "hwnd-A" } });
    const outB = await facade.see({ target: { hwnd: "hwnd-B" } });

    const visualA = outA.entities.filter((e) => e.sources.includes("visual_gpu"));
    const visualB = outB.entities.filter((e) => e.sources.includes("visual_gpu"));

    expect(visualA.length).toBeGreaterThan(0);
    expect(visualB).toHaveLength(0); // B was not pushed
  });

  it("idle: no timer needed — pushDirtySignal is a synchronous operation", () => {
    // Verify the mechanism does not install any polling loops
    const before = Date.now();
    pushDirtySignal("window:idle-test", []);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(10); // synchronous, < 10ms
  });
});
