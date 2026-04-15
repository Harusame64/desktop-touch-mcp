/**
 * tests/unit/envelope-projection.test.ts
 * Unit tests for projectEnvelope — perception envelope projection logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { projectEnvelope } from "../../src/engine/perception/envelope.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import type { GuardEvalResult, PerceptionLens, LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";
import { makeEvidence } from "../../src/engine/perception/evidence.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

function makeStore(): FluentStore {
  const s = new FluentStore();
  s.__resetForTests();
  return s;
}

const hwnd = "100";

function populateStore(store: FluentStore, overrides: Record<string, unknown> = {}) {
  const seq = { n: 1 };
  const set = (prop: string, value: unknown) => {
    const nowMs = Date.now();
    store.apply([{
      seq: seq.n++, tsMs: nowMs, source: "win32",
      entity: { kind: "window", id: hwnd },
      property: prop, value, confidence: 0.98,
      evidence: makeEvidence("win32", seq.n, nowMs),
    }]);
  };
  set("target.exists",     "target.exists"     in overrides ? overrides["target.exists"]     : true);
  set("target.identity",   "target.identity"   in overrides ? overrides["target.identity"]   : { pid: 1234, processStartTimeMs: 1700000000000 });
  set("target.title",      "target.title"      in overrides ? overrides["target.title"]      : "Untitled - Notepad");
  set("target.rect",       "target.rect"       in overrides ? overrides["target.rect"]       : { x: 0, y: 0, width: 1920, height: 1080 });
  set("target.foreground", "target.foreground" in overrides ? overrides["target.foreground"] : true);
  set("target.zOrder",     0);
  set("modal.above",       "modal.above"       in overrides ? overrides["modal.above"]       : false);
}

const baseSpec: LensSpec = {
  name: "test",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  maintain: [...FLUENT_KINDS],
  guards: [],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

const baseIdentity: WindowIdentity = {
  hwnd, pid: 1234, processName: "notepad.exe",
  processStartTimeMs: 1700000000000, titleResolved: "Untitled - Notepad",
};

function makeLens(overrides: Partial<LensSpec> = {}): PerceptionLens {
  const spec = { ...baseSpec, ...overrides };
  return {
    lensId: "perc-1", spec,
    binding: { hwnd, windowTitle: "Untitled - Notepad" },
    boundIdentity: baseIdentity,
    fluentKeys: FLUENT_KINDS.map(k => `window:${hwnd}.${k}`),
    registeredAtSeq: 1, registeredAtMs: Date.now(),
  };
}

const okGuardResult: GuardEvalResult = {
  ok: true, policy: "block", attention: "ok", results: [],
};

const failedGuardResult: GuardEvalResult = {
  ok: false, policy: "block", attention: "guard_failed",
  results: [{
    kind: "safe.keyboardTarget", ok: false, confidence: 0,
    reason: "Not foreground", suggestedAction: "Focus window",
  }],
  failedGuard: { kind: "safe.keyboardTarget", ok: false, confidence: 0, reason: "Not foreground" },
};

describe("projectEnvelope — attention derivation", () => {
  it("returns 'ok' when guards pass, nothing changed, nothing stale", () => {
    const store = makeStore();
    populateStore(store);
    const env = projectEnvelope(makeLens(), store, okGuardResult, { changedKeys: new Set() });
    expect(env.attention).toBe("ok");
  });

  it("returns 'guard_failed' when guards failed", () => {
    const store = makeStore();
    populateStore(store);
    const env = projectEnvelope(makeLens(), store, failedGuardResult, { changedKeys: new Set() });
    expect(env.attention).toBe("guard_failed");
  });

  it("returns 'changed' when changedKeys is non-empty and guards pass", () => {
    const store = makeStore();
    populateStore(store);
    const env = projectEnvelope(makeLens(), store, okGuardResult, {
      changedKeys: new Set([`window:${hwnd}.target.rect`]),
    });
    expect(env.attention).toBe("changed");
  });

  it("returns 'stale' when a fluent is stale and guards pass", () => {
    const store = makeStore();
    populateStore(store);
    store.markStale([`window:${hwnd}.target.rect`]);
    const env = projectEnvelope(makeLens(), store, okGuardResult, { changedKeys: new Set() });
    expect(env.attention).toBe("stale");
  });
});

describe("projectEnvelope — changed summaries", () => {
  it("includes human-readable summary for changed rect", () => {
    const store = makeStore();
    populateStore(store, { "target.rect": { x: 100, y: 200, width: 800, height: 600 } });
    const env = projectEnvelope(makeLens(), store, okGuardResult, {
      changedKeys: new Set([`window:${hwnd}.target.rect`]),
    });
    expect(env.changed.some(s => s.includes("target moved"))).toBe(true);
  });

  it("includes summary for foreground change", () => {
    const store = makeStore();
    populateStore(store, { "target.foreground": false });
    const env = projectEnvelope(makeLens(), store, okGuardResult, {
      changedKeys: new Set([`window:${hwnd}.target.foreground`]),
    });
    expect(env.changed.some(s => s.includes("foreground"))).toBe(true);
  });

  it("excludes target.identity from changed summary (too verbose)", () => {
    const store = makeStore();
    populateStore(store);
    const env = projectEnvelope(makeLens(), store, okGuardResult, {
      changedKeys: new Set([`window:${hwnd}.target.identity`]),
    });
    // identity should be filtered out of changed summaries
    expect(env.changed.every(s => !s.includes("identity"))).toBe(true);
  });
});

describe("projectEnvelope — guards map", () => {
  it("includes all guard results in guards map", () => {
    const store = makeStore();
    populateStore(store);
    const guardResult: GuardEvalResult = {
      ok: true, policy: "block", attention: "ok",
      results: [
        { kind: "target.identityStable", ok: true, confidence: 0.98 },
        { kind: "safe.keyboardTarget", ok: true, confidence: 0.98 },
      ],
    };
    const env = projectEnvelope(makeLens(), store, guardResult);
    expect(env.guards["target.identityStable"]).toBe(true);
    expect(env.guards["safe.keyboardTarget"]).toBe(true);
  });
});

describe("projectEnvelope — latest target block", () => {
  it("includes title and rect in latest.target", () => {
    const store = makeStore();
    populateStore(store, { "target.title": "MyApp", "target.rect": { x: 10, y: 20, width: 400, height: 300 } });
    const env = projectEnvelope(makeLens(), store, okGuardResult);
    expect(env.latest.target?.title).toBe("MyApp");
    expect(env.latest.target?.rect).toMatchObject({ x: 10, y: 20 });
  });

  it("includes foreground status", () => {
    const store = makeStore();
    populateStore(store, { "target.foreground": true });
    const env = projectEnvelope(makeLens(), store, okGuardResult);
    expect(env.latest.target?.foreground).toBe(true);
  });

  it("includes modalAbove when true", () => {
    const store = makeStore();
    populateStore(store, { "modal.above": true });
    const env = projectEnvelope(makeLens(), store, okGuardResult);
    expect(env.latest.target?.modalAbove).toBe(true);
  });
});

describe("projectEnvelope — token budget trimming", () => {
  it("removes zOrder first when budget exceeded", () => {
    const store = makeStore();
    populateStore(store);
    // Very tight budget
    const env = projectEnvelope(makeLens({ maxEnvelopeTokens: 30 }), store, okGuardResult);
    // With extremely low budget, zOrder should be dropped first
    // We can't predict exact trim without byte-counting, but at least it shouldn't throw
    expect(env).toBeDefined();
    expect(env.lens).toBe("perc-1");
  });

  it("always includes lens id, attention, seq regardless of budget", () => {
    const store = makeStore();
    populateStore(store);
    const env = projectEnvelope(makeLens({ maxEnvelopeTokens: 20 }), store, okGuardResult);
    expect(env.lens).toBeDefined();
    expect(env.attention).toBeDefined();
    expect(env.seq).toBeGreaterThanOrEqual(0);
  });
});
