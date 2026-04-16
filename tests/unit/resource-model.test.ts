/**
 * tests/unit/resource-model.test.ts
 *
 * Unit tests for resource-model projections.
 */

import { describe, it, expect } from "vitest";
import {
  buildLensSnapshot,
  projectResourceSummary,
  projectResourceGuards,
  projectResourceDebug,
  computeCanAct,
  formatGuardSummary,
} from "../../src/engine/perception/resource-model.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import { DirtyJournal } from "../../src/engine/perception/dirty-journal.js";
import { makeEvidence } from "../../src/engine/perception/evidence.js";
import type { PerceptionLens, LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const hwnd = "100";

const baseIdentity: WindowIdentity = {
  hwnd, pid: 1234, processName: "notepad.exe",
  processStartTimeMs: 1700000000000, titleResolved: "Notepad",
};

function makeStore(): FluentStore {
  const s = new FluentStore();
  s.__resetForTests();
  return s;
}

function populateStore(store: FluentStore) {
  const nowMs = Date.now();
  const obs = (prop: string, value: unknown, seq: number) => ({
    seq, tsMs: nowMs, source: "win32" as const,
    entity: { kind: "window" as const, id: hwnd },
    property: prop, value, confidence: 0.98,
    evidence: makeEvidence("win32", seq, nowMs),
  });
  store.apply([
    obs("target.exists",     true,  1),
    obs("target.identity",   { pid: 1234, processStartTimeMs: 1700000000000 }, 2),
    obs("target.title",      "Notepad", 3),
    obs("target.rect",       { x: 0, y: 0, width: 800, height: 600 }, 4),
    obs("target.foreground", true,  5),
    obs("target.zOrder",     0,     6),
    obs("modal.above",       false, 7),
  ]);
}

const baseSpec: LensSpec = {
  name: "test",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  maintain: [...FLUENT_KINDS],
  guards: ["target.identityStable", "safe.keyboardTarget", "safe.clickCoordinates", "stable.rect"],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

function makeLens(): PerceptionLens {
  return {
    lensId: "perc-1",
    spec: baseSpec,
    binding: { hwnd, windowTitle: "Notepad" },
    boundIdentity: baseIdentity,
    fluentKeys: FLUENT_KINDS.map(k => `window:${hwnd}.${k}`),
    registeredAtSeq: 1,
    registeredAtMs: Date.now(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildLensSnapshot", () => {
  it("returns a snapshot with correct shape", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);

    const snap = buildLensSnapshot(makeLens(), store, journal);
    expect(snap.lens.lensId).toBe("perc-1");
    expect(snap.seq).toBeGreaterThan(0);
    expect(snap.fluents.size).toBeGreaterThan(0);
    expect(typeof snap.hasDirty).toBe("boolean");
    expect(typeof snap.hasSettling).toBe("boolean");
    expect(typeof snap.hasStale).toBe("boolean");
  });

  it("hasDirty is true when a fluent is dirty", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);
    store.markDirty([`window:${hwnd}.target.rect`]);
    const snap = buildLensSnapshot(makeLens(), store, journal);
    expect(snap.hasDirty).toBe(true);
  });

  it("attention is guard_failed when a guard fails", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);
    store.markDirtyWithCause([`window:${hwnd}.target.foreground`], "fg_change", 9000);
    const snap = buildLensSnapshot(makeLens(), store, journal);
    expect(snap.attention).toBe("guard_failed");
  });

  it("attention is dirty when fluents are dirty but guards pass", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);
    // Only mark a non-guarded fluent dirty (zOrder is not checked by any guard)
    store.markDirty([`window:${hwnd}.target.zOrder`]);
    const snap = buildLensSnapshot(makeLens(), store, journal);
    expect(snap.hasDirty).toBe(true);
    // guards pass (foreground/identity are clean)
    if (snap.guardResult.ok) {
      expect(snap.attention).toBe("dirty");
    }
  });
});

describe("projectResourceSummary", () => {
  it("includes attention, watermark, guards, canAct", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);

    const snap    = buildLensSnapshot(makeLens(), store, journal);
    const summary = projectResourceSummary(snap);

    expect(summary.lensId).toBe("perc-1");
    expect(summary.seq).toBeGreaterThan(0);
    expect(typeof summary.attention).toBe("string");
    expect(summary.watermark).toHaveProperty("hasDirty");
    expect(summary.watermark).toHaveProperty("hasSettling");
    expect(summary.watermark).toHaveProperty("hasStale");
    expect(typeof summary.canAct.keyboard).toBe("boolean");
    expect(typeof summary.canAct.mouse).toBe("boolean");
    expect(typeof summary.guards).toBe("object");
  });

  it("includes target block for window lens", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);
    const snap    = buildLensSnapshot(makeLens(), store, journal);
    const summary = projectResourceSummary(snap);
    expect(summary.target).toBeDefined();
    expect(summary.target!["title"]).toBe("Notepad");
  });

  it("dirty fluents are never reported with attention 'ok'", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);
    store.markDirty([`window:${hwnd}.target.rect`]);
    const snap    = buildLensSnapshot(makeLens(), store, journal);
    const summary = projectResourceSummary(snap);
    expect(summary.attention).not.toBe("ok");
    expect(summary.canAct.mouse).toBe(false);
  });
});

describe("projectResourceGuards", () => {
  it("returns full guard list with summary strings", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);

    const snap   = buildLensSnapshot(makeLens(), store, journal);
    const guards = projectResourceGuards(snap);

    expect(guards.lensId).toBe("perc-1");
    expect(Array.isArray(guards.guards)).toBe(true);
    expect(guards.guards.length).toBe(baseSpec.guards.length);
    for (const g of guards.guards) {
      expect(typeof g.summary).toBe("string");
    }
  });
});

describe("projectResourceDebug", () => {
  it("returns fluents array and diagnostics", () => {
    const store   = makeStore();
    const journal = new DirtyJournal();
    journal.__resetForTests();
    populateStore(store);

    const snap  = buildLensSnapshot(makeLens(), store, journal);
    const debug = projectResourceDebug(snap);

    expect(debug.lensId).toBe("perc-1");
    expect(Array.isArray(debug.fluents)).toBe(true);
    expect(debug.diagnostics).toHaveProperty("hasDirty");
    expect(Array.isArray(debug.warnings)).toBe(true);
  });
});

describe("computeCanAct", () => {
  it("returns keyboard=true, mouse=true when guard passes", () => {
    const ca = computeCanAct({ ok: true, policy: "block", attention: "ok", results: [] });
    expect(ca.keyboard).toBe(true);
    expect(ca.mouse).toBe(true);
  });

  it("returns keyboard=false, mouse=false when guard fails", () => {
    const ca = computeCanAct({ ok: false, policy: "block", attention: "guard_failed", results: [] });
    expect(ca.keyboard).toBe(false);
    expect(ca.mouse).toBe(false);
  });
});

describe("formatGuardSummary", () => {
  it("formats passing guard", () => {
    const s = formatGuardSummary({ kind: "stable.rect", ok: true, confidence: 0.98 });
    expect(s).toContain("ok");
    expect(s).toContain("stable.rect");
  });

  it("formats failing guard with reason and action", () => {
    const s = formatGuardSummary({
      kind: "safe.keyboardTarget",
      ok: false,
      confidence: 0.5,
      reason: "Window not in foreground",
      suggestedAction: "Call focus_window first",
    });
    expect(s).toContain("FAILED");
    expect(s).toContain("not in foreground");
    expect(s).toContain("focus_window");
  });
});
