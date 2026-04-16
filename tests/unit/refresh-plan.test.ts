/**
 * tests/unit/refresh-plan.test.ts
 *
 * Unit tests for buildRefreshPlan — maps dirty journal state to sensor call plan.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DirtyJournal } from "../../src/engine/perception/dirty-journal.js";
import { buildRefreshPlan } from "../../src/engine/perception/refresh-plan.js";
import {
  createLensEventIndex,
  addLensToIndex,
} from "../../src/engine/perception/lens-event-index.js";
import type { LensEventIndex } from "../../src/engine/perception/lens-event-index.js";
import type { PerceptionLens, WindowIdentity, LensSpec } from "../../src/engine/perception/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const identity: WindowIdentity = {
  hwnd: "100", pid: 1234, processName: "notepad.exe",
  processStartTimeMs: 1700000000000, titleResolved: "Untitled",
};

function makeLens(lensId: string, hwnd: string, maintain: string[]): PerceptionLens {
  return {
    lensId,
    spec: {
      name: lensId,
      target: { kind: "window", match: { titleIncludes: "test" } },
      maintain: maintain as LensSpec["maintain"],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    },
    binding: { hwnd, windowTitle: "Test" },
    boundIdentity: { ...identity, hwnd },
    fluentKeys: maintain.map(m => `window:${hwnd}.${m}`),
    registeredAtSeq: 0,
    registeredAtMs: Date.now(),
  };
}

function makeIndex(...lenses: PerceptionLens[]): LensEventIndex {
  const idx = createLensEventIndex();
  for (const l of lenses) addLensToIndex(idx, l);
  return idx;
}

describe("buildRefreshPlan", () => {
  let journal: DirtyJournal;

  beforeEach(() => {
    journal = new DirtyJournal();
    journal.__resetForTests();
  });

  it("returns an empty plan when journal has no dirty entries", () => {
    const idx = makeIndex();
    const plan = buildRefreshPlan(journal, idx);
    expect(plan.needsEnumWindows).toBe(false);
    expect(plan.rectHwnds.size).toBe(0);
    expect(plan.foreground).toBe(false);
    expect(plan.reason).toHaveLength(0);
  });

  it("target.rect dirty → rectHwnds only (no EnumWindows)", () => {
    journal.mark({ entityKey: "window:100", props: ["target.rect"], cause: "rect", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.rectHwnds.has("100")).toBe(true);
    expect(plan.needsEnumWindows).toBe(false);
    expect(plan.foreground).toBe(false);
  });

  it("target.foreground dirty → foreground=true, no EnumWindows", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.foreground).toBe(true);
    expect(plan.needsEnumWindows).toBe(false);
  });

  it("target.title dirty → titleHwnds", () => {
    journal.mark({ entityKey: "window:100", props: ["target.title"], cause: "name", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.titleHwnds.has("100")).toBe(true);
    expect(plan.needsEnumWindows).toBe(false);
  });

  it("target.identity dirty → identityHwnds", () => {
    journal.mark({ entityKey: "window:100", props: ["target.identity"], cause: "identity", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.identityHwnds.has("100")).toBe(true);
  });

  it("target.zOrder dirty → needsEnumWindows", () => {
    journal.mark({ entityKey: "window:100", props: ["target.zOrder"], cause: "reorder", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.needsEnumWindows).toBe(true);
  });

  it("modal.above dirty without rect dirty → modalForLensIds only, triggers EnumWindows", () => {
    const lens = makeLens("perc-1", "100", ["modal.above"]);
    journal.mark({ entityKey: "window:100", props: ["modal.above"], cause: "modal", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex(lens));
    expect(plan.modalForLensIds.has("perc-1")).toBe(true);
    expect(plan.rectHwnds.size).toBe(0);
    expect(plan.needsEnumWindows).toBe(true); // modal requires z-order snapshot
  });

  it("structural severity entry → needsEnumWindows", () => {
    journal.mark({ entityKey: "window:100", props: ["target.exists"], cause: "show", monoMs: 100, severity: "structural" });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.needsEnumWindows).toBe(true);
  });

  it("identityRisk severity entry → needsEnumWindows", () => {
    journal.mark({ entityKey: "window:100", props: ["target.identity"], cause: "reuse", monoMs: 100, severity: "identityRisk" });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.needsEnumWindows).toBe(true);
  });

  it("stable.rect dirty adds a reason but no sensor call", () => {
    journal.mark({ entityKey: "window:100", props: ["stable.rect"], cause: "move", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.reason.some(r => r.includes("stable_rect"))).toBe(true);
    expect(plan.rectHwnds.size).toBe(0);
    expect(plan.needsEnumWindows).toBe(false);
  });

  it("global dirty → all allHwnds get all ops", () => {
    journal.markGlobal("overflow", 500);
    const allHwnds = new Set(["100", "200", "300"]);
    const lens1 = makeLens("perc-1", "100", ["modal.above"]);
    const lens2 = makeLens("perc-2", "200", ["target.foreground"]);
    const plan = buildRefreshPlan(journal, makeIndex(lens1, lens2), allHwnds);
    expect(plan.needsEnumWindows).toBe(true);
    expect(plan.foreground).toBe(true);
    for (const h of ["100", "200", "300"]) {
      expect(plan.rectHwnds.has(h)).toBe(true);
      expect(plan.identityHwnds.has(h)).toBe(true);
      expect(plan.titleHwnds.has(h)).toBe(true);
    }
    expect(plan.reason).toContain("global_dirty");
  });

  it("reason array is populated", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground", "target.rect"], cause: "multi", monoMs: 100 });
    const plan = buildRefreshPlan(journal, makeIndex());
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});
