/**
 * tests/unit/guards-eval.test.ts
 * Unit tests for guard evaluators — pure functions over FluentStore.
 */

import { describe, it, expect } from "vitest";
import { evaluateGuard, evaluateGuards } from "../../src/engine/perception/guards.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import type { PerceptionLens, LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";
import { makeEvidence } from "../../src/engine/perception/evidence.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

function makeStore(): FluentStore {
  const s = new FluentStore();
  s.__resetForTests();
  return s;
}

function populateStore(store: FluentStore, hwnd: string, overrides: Record<string, unknown> = {}) {
  const seq = { n: 1 };

  const setWithSource = (prop: string, value: unknown, source: import("../../src/engine/perception/types.js").SensorSource = "win32") => {
    const nowMs = Date.now();
    const ev = makeEvidence(source, seq.n, nowMs);
    const confidence = source === "win32" ? 0.98 : source === "image" ? 0.60 : 0.50;
    store.apply([{
      seq: seq.n++,
      tsMs: nowMs,
      source,
      entity: { kind: "window", id: hwnd },
      property: prop,
      value,
      confidence,
      evidence: ev,
    }]);
  };

  const exists     = "target.exists"     in overrides ? overrides["target.exists"]     : true;
  const foreground = "target.foreground" in overrides ? overrides["target.foreground"] : true;
  const modal      = "modal.above"       in overrides ? overrides["modal.above"]       : false;
  const rect       = "target.rect"       in overrides ? overrides["target.rect"]       : { x: 0, y: 0, width: 1920, height: 1080 };
  const identity   = "target.identity"   in overrides ? overrides["target.identity"]   : { pid: 1234, processStartTimeMs: 1700000000000 };
  // "fg.source":"image" → confidence 0.60 (below 0.90 threshold), for testing low-confidence path
  const fgSource   = ("fg.source" in overrides ? overrides["fg.source"] : "win32") as import("../../src/engine/perception/types.js").SensorSource;

  setWithSource("target.exists", exists);
  setWithSource("target.identity", identity);
  setWithSource("target.title", "Untitled - Notepad");
  setWithSource("target.rect", rect);
  setWithSource("target.foreground", foreground, fgSource);
  setWithSource("target.zOrder", 0);
  setWithSource("modal.above", modal);
}

const hwnd = "100";

const baseIdentity: WindowIdentity = {
  hwnd,
  pid: 1234,
  processName: "notepad.exe",
  processStartTimeMs: 1700000000000,
  titleResolved: "Untitled - Notepad",
};

const baseSpec: LensSpec = {
  name: "test",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  maintain: [...FLUENT_KINDS],
  guards: ["target.identityStable", "safe.keyboardTarget", "safe.clickCoordinates", "stable.rect"],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

function makeLens(overrides: Partial<PerceptionLens> = {}): PerceptionLens {
  return {
    lensId: "perc-1",
    spec: baseSpec,
    binding: { hwnd, windowTitle: "Untitled - Notepad" },
    boundIdentity: baseIdentity,
    fluentKeys: FLUENT_KINDS.map(k => `window:${hwnd}.${k}`),
    registeredAtSeq: 1,
    registeredAtMs: Date.now(),
    ...overrides,
  };
}

describe("target.identityStable", () => {
  it("passes when pid and processStartTimeMs match", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    const result = evaluateGuard("target.identityStable", makeLens(), store, Date.now());
    expect(result.ok).toBe(true);
  });

  it("fails when target.identity fluent is missing", () => {
    const store = makeStore();
    // Don't populate — identity fluent absent
    const result = evaluateGuard("target.identityStable", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("fails when pid changed", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.identity": { pid: 9999, processStartTimeMs: 1700000000000 } });
    const result = evaluateGuard("target.identityStable", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pid/);
  });

  it("fails when processStartTimeMs changed (process restart)", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.identity": { pid: 1234, processStartTimeMs: 9999999 } });
    const result = evaluateGuard("target.identityStable", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/startTime/);
  });

  it("fails when identity value is null (window closed)", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.identity": null });
    const result = evaluateGuard("target.identityStable", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
  });
});

describe("safe.keyboardTarget", () => {
  it("passes when foreground=true, modal=false, identity stable", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(true);
  });

  it("fails when window is not foreground", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.foreground": false });
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/foreground/i);
  });

  it("fails when modal is above target", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "modal.above": true });
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/modal/i);
  });

  it("fails when identity is unstable", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.identity": { pid: 9999, processStartTimeMs: 0 } });
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unstable/i);
  });

  it("fails when foreground confidence is too low", () => {
    const store = makeStore();
    // Use "image" source (base confidence 0.60) which is below the 0.90 threshold
    populateStore(store, hwnd, { "fg.source": "image" });
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/confidence/i);
  });

  it("fails when foreground status is dirty (watermark gate)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markDirtyWithCause([`window:${hwnd}.target.foreground`], "foreground_change", 9000);
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dirty/i);
  });

  it("fails when foreground status is settling (watermark gate)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markSettling([`window:${hwnd}.target.foreground`], 9000);
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/settling/i);
  });

  it("fails when foreground evidence is older than dirty mark (watermark gate, status=dirty)", () => {
    const store = makeStore();
    // Apply observation with explicit early monoMs
    const nowMs = Date.now();
    const ev = makeEvidence("win32", 1, nowMs);
    store.apply([{
      seq: 1, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.identity",
      value: { pid: 1234, processStartTimeMs: 1700000000000 }, confidence: 0.98, evidence: ev,
    }]);
    store.apply([{
      seq: 2, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.foreground",
      value: true, confidence: 0.98, evidence: ev,
      monoMs: 1000,  // observation monoMs = 1000
    }]);
    // dirty mark at monoMs=2000 (AFTER the observation) → status becomes "dirty"
    // old obs (monoMs=1000) cannot clear dirty (watermark prevents it)
    store.markDirtyWithCause([`window:${hwnd}.target.foreground`], "fg_change", 2000);
    const result = evaluateGuard("safe.keyboardTarget", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    // dirty status check fires first (Rule 1) — confirms guard blocks
    expect(result.reason).toMatch(/dirty/i);
  });

  // ── foregroundVerified bypass ───────────────────────────────────────────────
  // When the caller (keyboard tool) has already driven the window to the
  // foreground and verified the transition, safe.keyboardTarget must bypass
  // the foreground fluent check (racy against foreground-stealing protection).
  // Other gates (identity, modal, focused element) must still run.
  it("passes when foreground=false but foregroundVerified=true is supplied", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.foreground": false });
    const result = evaluateGuard(
      "safe.keyboardTarget", makeLens(), store, Date.now(),
      { foregroundVerified: true }
    );
    expect(result.ok).toBe(true);
  });

  it("passes when foreground confidence is low but foregroundVerified=true", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "fg.source": "image" });
    const result = evaluateGuard(
      "safe.keyboardTarget", makeLens(), store, Date.now(),
      { foregroundVerified: true }
    );
    expect(result.ok).toBe(true);
  });

  it("still fails on identity instability even when foregroundVerified=true", () => {
    const store = makeStore();
    populateStore(store, hwnd, {
      "target.foreground": false,
      "target.identity": { pid: 9999, processStartTimeMs: 0 },
    });
    const result = evaluateGuard(
      "safe.keyboardTarget", makeLens(), store, Date.now(),
      { foregroundVerified: true }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unstable/i);
  });

  it("still fails on modal block even when foregroundVerified=true", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.foreground": false, "modal.above": true });
    const result = evaluateGuard(
      "safe.keyboardTarget", makeLens(), store, Date.now(),
      { foregroundVerified: true }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/modal/i);
  });
});

describe("safe.clickCoordinates", () => {
  it("passes when coords are inside rect and identity stable", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.rect": { x: 0, y: 0, width: 1920, height: 1080 } });
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), { clickX: 100, clickY: 100 });
    expect(result.ok).toBe(true);
  });

  it("fails when target.rect fluent is missing", () => {
    const store = makeStore();
    const nowMs = Date.now();
    // Populate everything except rect
    store.apply([{ seq: 1, tsMs: nowMs, source: "win32", entity: { kind: "window", id: hwnd }, property: "target.identity", value: { pid: 1234, processStartTimeMs: 1700000000000 }, confidence: 0.98, evidence: makeEvidence("win32", 1, nowMs) }]);
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), { clickX: 100, clickY: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("fails when click coords are outside rect", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.rect": { x: 100, y: 100, width: 400, height: 300 } });
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), { clickX: 5, clickY: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside/i);
  });

  it("passes without coords (no point-in-rect check)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), {});
    expect(result.ok).toBe(true);
  });

  it("fails when rect status is dirty (watermark gate)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markDirtyWithCause([`window:${hwnd}.target.rect`], "move", 9000);
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), { clickX: 100, clickY: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dirty/i);
  });

  it("fails when rect status is settling (watermark gate)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markSettling([`window:${hwnd}.target.rect`], 9000);
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), { clickX: 100, clickY: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/settling/i);
  });

  it("fails when rect evidence is older than dirty mark (watermark gate, status=dirty)", () => {
    const store = makeStore();
    const nowMs = Date.now();
    const ev = makeEvidence("win32", 1, nowMs);
    store.apply([{
      seq: 1, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.identity",
      value: { pid: 1234, processStartTimeMs: 1700000000000 }, confidence: 0.98, evidence: ev,
    }]);
    store.apply([{
      seq: 2, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.rect",
      value: { x: 0, y: 0, width: 800, height: 600 }, confidence: 0.98, evidence: ev,
      monoMs: 1000,  // observation monoMs = 1000
    }]);
    // dirty mark at monoMs=2000 (AFTER the observation) → status becomes "dirty"
    store.markDirtyWithCause([`window:${hwnd}.target.rect`], "move", 2000);
    const result = evaluateGuard("safe.clickCoordinates", makeLens(), store, Date.now(), { clickX: 100, clickY: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dirty/i);
  });
});

describe("stable.rect", () => {
  it("passes with observed rect (returns confidence >= 0.6)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("fails when target.rect is missing", () => {
    const store = makeStore();
    // No fluents at all
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
  });

  it("fails when rect status is dirty", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markDirty([`window:${hwnd}.target.rect`]);
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dirty/);
  });

  it("fails when rect status is stale", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markStale([`window:${hwnd}.target.rect`]);
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stale/);
  });

  it("passes with confidence=0.6 for fresh rect (first sample)", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    // Right after apply, age < 250ms → first-sample path
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(0.6);
  });

  it("fails when rect status is settling", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    store.markSettling([`window:${hwnd}.target.rect`], 9000);
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/settling/i);
  });

  it("fails when rect evidence is older than dirty mark (watermark rule, status=dirty)", () => {
    const store = makeStore();
    const nowMs = Date.now();
    const ev = makeEvidence("win32", 1, nowMs);
    store.apply([{
      seq: 1, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.rect",
      value: { x: 0, y: 0, width: 800, height: 600 }, confidence: 0.98, evidence: ev,
      monoMs: 1000,  // observation before dirty mark
    }]);
    // dirty mark at monoMs=2000 → status="dirty"; old obs cannot clear it (watermark)
    store.markDirtyWithCause([`window:${hwnd}.target.rect`], "move", 2000);
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dirty/i);
  });

  it("passes with confidence=0.6 for rect observed right after dirty mark (quiet window < 250ms)", () => {
    const store = makeStore();
    const nowMs = Date.now();
    const ev = makeEvidence("win32", 1, nowMs);
    // First apply to establish the fluent
    store.apply([{
      seq: 1, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.rect",
      value: { x: 0, y: 0, width: 800, height: 600 }, confidence: 0.98, evidence: ev,
      monoMs: 1000,
    }]);
    // Mark dirty at monoMs=2000
    store.markDirtyWithCause([`window:${hwnd}.target.rect`], "move", 2000);
    // Apply fresh observation at monoMs=2050 (just 50ms after dirty, < 250ms quiet window)
    const ev2 = makeEvidence("win32", 2, nowMs);
    store.apply([{
      seq: 2, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd }, property: "target.rect",
      value: { x: 10, y: 0, width: 800, height: 600 }, confidence: 0.98, evidence: ev2,
      monoMs: 2050,
    }]);
    const result = evaluateGuard("stable.rect", makeLens(), store, Date.now());
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(0.6); // quiet window not yet elapsed
  });
});

describe("evaluateGuards — policy integration", () => {
  it("returns ok:true when all guards pass", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    const lens = makeLens({ spec: { ...baseSpec, guards: ["target.identityStable", "safe.keyboardTarget"] } });
    const result = evaluateGuards(lens, store, "block");
    expect(result.ok).toBe(true);
    expect(result.attention).toBe("ok");
  });

  it("returns ok:false and attention:'guard_failed' on failure", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.foreground": false });
    const lens = makeLens({ spec: { ...baseSpec, guards: ["safe.keyboardTarget"] } });
    const result = evaluateGuards(lens, store, "block");
    expect(result.ok).toBe(false);
    expect(result.attention).toBe("guard_failed");
    expect(result.failedGuard?.kind).toBe("safe.keyboardTarget");
  });

  it("still returns ok:false with policy:warn (LLM can proceed but is notified)", () => {
    const store = makeStore();
    populateStore(store, hwnd, { "target.foreground": false });
    const lens = makeLens({ spec: { ...baseSpec, guards: ["safe.keyboardTarget"], guardPolicy: "warn" } });
    const result = evaluateGuards(lens, store, "warn");
    // ok:false regardless of policy — policy is for caller to decide how to handle
    expect(result.ok).toBe(false);
    expect(result.policy).toBe("warn");
  });

  it("evaluates all requested guards and aggregates results", () => {
    const store = makeStore();
    populateStore(store, hwnd);
    const lens = makeLens({ spec: { ...baseSpec, guards: ["target.identityStable", "safe.keyboardTarget", "stable.rect"] } });
    const result = evaluateGuards(lens, store, "block");
    expect(result.results).toHaveLength(3);
  });
});
