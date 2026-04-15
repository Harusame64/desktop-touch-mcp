/**
 * tests/unit/fluent-store.test.ts
 * Unit tests for FluentStore — core data structure for RPG.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import type { Observation } from "../../src/engine/perception/types.js";
import { makeEvidence } from "../../src/engine/perception/evidence.js";

function makeObs(
  seq: number,
  hwnd: string,
  property: string,
  value: unknown,
  confidence = 0.98
): Observation {
  const nowMs = Date.now();
  return {
    seq,
    tsMs: nowMs,
    source: "win32",
    entity: { kind: "window", id: hwnd },
    property,
    value,
    confidence,
    evidence: makeEvidence("win32", seq, nowMs),
  };
}

describe("FluentStore", () => {
  let store: FluentStore;

  beforeEach(() => {
    store = new FluentStore();
    store.__resetForTests();
  });

  // ── apply / basic reconcile ──────────────────────────────────────────────

  it("starts empty", () => {
    expect(store.size()).toBe(0);
  });

  it("applies a single observation", () => {
    const { changed } = store.apply([makeObs(1, "100", "target.exists", true)]);
    expect(changed.size).toBe(1);
    expect(changed.has("window:100.target.exists")).toBe(true);
    expect(store.read("window:100.target.exists")?.value).toBe(true);
  });

  it("updates seq monotonically", () => {
    store.apply([makeObs(1, "100", "target.title", "A")]);
    const s1 = store.currentSeq();
    store.apply([makeObs(2, "100", "target.title", "B")]);
    expect(store.currentSeq()).toBeGreaterThan(s1);
  });

  it("newer observation replaces older for same property", () => {
    store.apply([makeObs(1, "100", "target.title", "A")]);
    store.apply([makeObs(2, "100", "target.title", "B")]);
    expect(store.read("window:100.target.title")?.value).toBe("B");
  });

  it("drops observation with older seq", () => {
    store.apply([makeObs(3, "100", "target.title", "C")]);
    const { changed } = store.apply([makeObs(1, "100", "target.title", "old")]);
    expect(changed.size).toBe(0);
    expect(store.read("window:100.target.title")?.value).toBe("C");
  });

  it("returns changed set accurately for multi-obs batch", () => {
    const obs = [
      makeObs(1, "100", "target.exists", true),
      makeObs(2, "100", "target.title", "Foo"),
      makeObs(3, "100", "target.rect", { x: 10, y: 20, width: 800, height: 600 }),
    ];
    const { changed } = store.apply(obs);
    expect(changed.size).toBe(3);
  });

  it("does not report unchanged keys when value is re-applied at same seq", () => {
    store.apply([makeObs(1, "100", "target.title", "A")]);
    // Same seq — lower confidence wins per TMS-lite
    const { changed } = store.apply([makeObs(1, "100", "target.title", "A", 0.50)]);
    expect(changed.size).toBe(0);
  });

  // ── status transitions ───────────────────────────────────────────────────

  it("new fluent starts with status 'observed'", () => {
    store.apply([makeObs(1, "100", "target.exists", true)]);
    expect(store.read("window:100.target.exists")?.status).toBe("observed");
  });

  it("markDirty sets status to dirty", () => {
    store.apply([makeObs(1, "100", "target.rect", { x: 0, y: 0, width: 800, height: 600 })]);
    store.markDirty(["window:100.target.rect"]);
    expect(store.read("window:100.target.rect")?.status).toBe("dirty");
  });

  it("markStale sets status to stale", () => {
    store.apply([makeObs(1, "100", "target.rect", { x: 0, y: 0, width: 800, height: 600 })]);
    store.markStale(["window:100.target.rect"]);
    expect(store.read("window:100.target.rect")?.status).toBe("stale");
  });

  it("markInvalidated sets status to invalidated", () => {
    store.apply([makeObs(1, "100", "target.title", "X")]);
    store.markInvalidated(["window:100.target.title"]);
    expect(store.read("window:100.target.title")?.status).toBe("invalidated");
  });

  // ── sweepTTL ─────────────────────────────────────────────────────────────

  it("sweepTTL stales entries whose evidence has expired", () => {
    const pastMs = Date.now() - 100_000; // 100s ago
    const ev = makeEvidence("win32", 1, pastMs); // TTL will have passed
    store.apply([{
      seq: 1,
      tsMs: pastMs,
      source: "win32",
      entity: { kind: "window", id: "200" },
      property: "target.title",
      value: "Old",
      confidence: 0.98,
      evidence: ev,
    }]);
    const staled = store.sweepTTL(Date.now());
    expect(staled).toContain("window:200.target.title");
    expect(store.read("window:200.target.title")?.status).toBe("stale");
  });

  it("sweepTTL does not stale fresh entries", () => {
    store.apply([makeObs(1, "300", "target.title", "Fresh")]);
    const staled = store.sweepTTL(Date.now());
    expect(staled).not.toContain("window:300.target.title");
    expect(store.read("window:300.target.title")?.status).toBe("observed");
  });

  // ── readMany ─────────────────────────────────────────────────────────────

  it("readMany returns map of requested keys", () => {
    store.apply([
      makeObs(1, "100", "target.title", "A"),
      makeObs(2, "100", "target.exists", true),
    ]);
    const result = store.readMany(["window:100.target.title", "window:100.target.exists", "window:100.target.rect"]);
    expect(result.size).toBe(2); // rect not present
    expect(result.get("window:100.target.title")?.value).toBe("A");
  });

  // ── buildObservation static ───────────────────────────────────────────────

  it("buildObservation creates a valid Observation", () => {
    const obs = FluentStore.buildObservation(1, "400", "target.foreground", true, 0.98);
    expect(obs.entity).toEqual({ kind: "window", id: "400" });
    expect(obs.property).toBe("target.foreground");
    expect(obs.value).toBe(true);
    expect(obs.confidence).toBe(0.98);
  });

  // ── __resetForTests ───────────────────────────────────────────────────────

  it("__resetForTests clears state", () => {
    store.apply([makeObs(1, "100", "target.title", "X")]);
    store.__resetForTests();
    expect(store.size()).toBe(0);
    expect(store.currentSeq()).toBe(0);
  });
});
