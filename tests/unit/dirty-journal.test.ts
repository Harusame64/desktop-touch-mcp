/**
 * tests/unit/dirty-journal.test.ts
 *
 * Unit tests for DirtyJournal — uncertainty recording without sensor reads.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DirtyJournal } from "../../src/engine/perception/dirty-journal.js";

describe("DirtyJournal", () => {
  let journal: DirtyJournal;

  beforeEach(() => {
    journal = new DirtyJournal();
    journal.__resetForTests();
  });

  // ── mark / basic coalescing ──────────────────────────────────────────────

  it("starts empty", () => {
    expect(journal.hasDirty()).toBe(false);
    expect(journal.entries().size).toBe(0);
  });

  it("mark creates an entry", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "EVENT_SYSTEM_FOREGROUND", monoMs: 1000 });
    expect(journal.hasDirty()).toBe(true);
    expect(journal.entries().size).toBe(1);
    const entry = journal.entries().get("window:100")!;
    expect(entry).toBeDefined();
    expect(entry.props.has("target.foreground")).toBe(true);
    expect(entry.eventCount).toBe(1);
  });

  it("coalesces multiple marks for the same entity into one entry", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg1", monoMs: 1000 });
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg2", monoMs: 1050 });
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg3", monoMs: 1100 });
    expect(journal.entries().size).toBe(1);
    const entry = journal.entries().get("window:100")!;
    expect(entry.eventCount).toBe(3);
    expect(entry.firstEventAtMonoMs).toBe(1000);
    expect(entry.lastEventAtMonoMs).toBe(1100);
  });

  it("coalesces foreground A→B→C into one dirty entry", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "A", monoMs: 100 });
    journal.mark({ entityKey: "window:200", props: ["target.foreground"], cause: "B", monoMs: 110 });
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "C", monoMs: 120 });
    // Two different entities
    expect(journal.entries().size).toBe(2);
    const entry100 = journal.entries().get("window:100")!;
    expect(entry100.eventCount).toBe(2);
    expect(entry100.lastEventAtMonoMs).toBe(120);
  });

  it("merges different props for the same entity", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 1000 });
    journal.mark({ entityKey: "window:100", props: ["target.title"], cause: "name", monoMs: 1001 });
    const entry = journal.entries().get("window:100")!;
    expect(entry.props.has("target.foreground")).toBe(true);
    expect(entry.props.has("target.title")).toBe(true);
    expect(entry.eventCount).toBe(2);
  });

  it("accumulates unique causes only", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "same", monoMs: 1000 });
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "same", monoMs: 1001 });
    const entry = journal.entries().get("window:100")!;
    expect(entry.causes).toHaveLength(1);
  });

  // ── severity precedence ──────────────────────────────────────────────────

  it("severity escalates to the highest seen", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "hint", monoMs: 100, severity: "hint" });
    journal.mark({ entityKey: "window:100", props: ["target.exists"], cause: "show", monoMs: 110, severity: "structural" });
    const entry = journal.entries().get("window:100")!;
    expect(entry.severity).toBe("structural");
  });

  it("identityRisk beats structural", () => {
    journal.mark({ entityKey: "window:100", props: ["target.exists"], cause: "destroy", monoMs: 100, severity: "structural" });
    journal.mark({ entityKey: "window:100", props: ["target.identity"], cause: "reuse", monoMs: 110, severity: "identityRisk" });
    journal.mark({ entityKey: "window:100", props: ["target.exists"], cause: "show", monoMs: 120, severity: "structural" });
    const entry = journal.entries().get("window:100")!;
    expect(entry.severity).toBe("identityRisk");
  });

  // ── clearFor / watermark correctness ──────────────────────────────────────

  it("clearFor removes props when observation is newer than the last event", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground", "target.zOrder"], cause: "fg", monoMs: 1000 });
    // Observation timestamp 1001 > lastEventAtMonoMs 1000 → clears
    journal.clearFor("window:100", ["target.foreground"], 1001);
    const entry = journal.entries().get("window:100")!;
    expect(entry.props.has("target.foreground")).toBe(false);
    expect(entry.props.has("target.zOrder")).toBe(true);
  });

  it("clearFor removes the entry when all props are cleared", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 1000 });
    journal.clearFor("window:100", ["target.foreground"], 1001);
    expect(journal.entries().has("window:100")).toBe(false);
    expect(journal.hasDirty()).toBe(false);
  });

  it("clearFor does NOT clear when observation is same age as last event", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 1000 });
    journal.clearFor("window:100", ["target.foreground"], 1000); // equal, not newer
    const entry = journal.entries().get("window:100")!;
    expect(entry.props.has("target.foreground")).toBe(true);
  });

  it("clearFor does NOT clear when observation is older than last event", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg1", monoMs: 1000 });
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg2", monoMs: 1100 }); // newer event
    journal.clearFor("window:100", ["target.foreground"], 1050); // 1050 < lastEvent 1100
    const entry = journal.entries().get("window:100")!;
    expect(entry.props.has("target.foreground")).toBe(true);
  });

  it("clearFor on non-existent entity is a no-op", () => {
    expect(() => journal.clearFor("window:999", ["target.foreground"], 9999)).not.toThrow();
  });

  // ── global dirty ──────────────────────────────────────────────────────────

  it("markGlobal sets globalDirty flag", () => {
    expect(journal.isGlobalDirty()).toBe(false);
    journal.markGlobal("overflow", 5000);
    expect(journal.isGlobalDirty()).toBe(true);
    expect(journal.globalDirtyAtMonoMs()).toBe(5000);
  });

  it("clearGlobal removes globalDirty flag", () => {
    journal.markGlobal("overflow", 5000);
    journal.clearGlobal();
    expect(journal.isGlobalDirty()).toBe(false);
    expect(journal.globalDirtyAtMonoMs()).toBe(0);
  });

  it("markGlobal also updates existing per-entity entries to 'global' severity", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 1000, severity: "hint" });
    journal.markGlobal("overflow", 2000);
    const entry = journal.entries().get("window:100")!;
    expect(entry.severity).toBe("global");
  });

  // ── dirtyEntityKeys ────────────────────────────────────────────────────────

  it("dirtyEntityKeys returns all entity keys with dirty props", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 100 });
    journal.mark({ entityKey: "window:200", props: ["target.title"],      cause: "name", monoMs: 200 });
    const keys = journal.dirtyEntityKeys();
    expect(keys).toContain("window:100");
    expect(keys).toContain("window:200");
    expect(keys).toHaveLength(2);
  });

  // ── __resetForTests ────────────────────────────────────────────────────────

  it("__resetForTests clears all state", () => {
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 100 });
    journal.markGlobal("overflow", 200);
    journal.__resetForTests();
    expect(journal.hasDirty()).toBe(false);
    expect(journal.isGlobalDirty()).toBe(false);
    expect(journal.entries().size).toBe(0);
  });
});
