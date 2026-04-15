/**
 * tests/unit/dependency-graph.test.ts
 * Unit tests for DependencyGraph — reverse index for RPG.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DependencyGraph } from "../../src/engine/perception/dependency-graph.js";

describe("DependencyGraph", () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
    graph.__resetForTests();
  });

  it("starts empty", () => {
    expect(graph.lensIds()).toHaveLength(0);
  });

  it("addLens registers fluent keys for a lens", () => {
    graph.addLens("perc-1", ["window:100.target.title", "window:100.target.rect"]);
    expect(graph.hasLens("perc-1")).toBe(true);
    const keys = graph.fluentsForLens("perc-1");
    expect(keys).toContain("window:100.target.title");
    expect(keys).toContain("window:100.target.rect");
  });

  it("lookupAffectedLenses returns lens when its fluent changes", () => {
    graph.addLens("perc-1", ["window:100.target.title"]);
    const affected = graph.lookupAffectedLenses(new Set(["window:100.target.title"]));
    expect(affected.has("perc-1")).toBe(true);
  });

  it("lookupAffectedLenses returns empty when no lens tracks the key", () => {
    graph.addLens("perc-1", ["window:100.target.title"]);
    const affected = graph.lookupAffectedLenses(new Set(["window:999.target.rect"]));
    expect(affected.size).toBe(0);
  });

  it("multiple lenses can share a fluent key", () => {
    graph.addLens("perc-1", ["window:100.target.foreground"]);
    graph.addLens("perc-2", ["window:100.target.foreground"]);
    const affected = graph.lookupAffectedLenses(new Set(["window:100.target.foreground"]));
    expect(affected.has("perc-1")).toBe(true);
    expect(affected.has("perc-2")).toBe(true);
  });

  it("addLens deduplicates repeated calls for same lensId", () => {
    graph.addLens("perc-1", ["window:100.target.title"]);
    graph.addLens("perc-1", ["window:100.target.rect"]); // re-register with different keys
    // Should only have rect now, not title
    const keys = graph.fluentsForLens("perc-1");
    expect(keys).toContain("window:100.target.rect");
    expect(keys).not.toContain("window:100.target.title");
  });

  it("removeLens removes lens and cleans up forward index", () => {
    graph.addLens("perc-1", ["window:100.target.title", "window:100.target.rect"]);
    graph.removeLens("perc-1");
    expect(graph.hasLens("perc-1")).toBe(false);
    const affected = graph.lookupAffectedLenses(new Set(["window:100.target.title"]));
    expect(affected.has("perc-1")).toBe(false);
  });

  it("removeLens of unknown id is no-op", () => {
    expect(() => graph.removeLens("nonexistent")).not.toThrow();
  });

  it("forward key is deleted when last lens tracking it is removed", () => {
    graph.addLens("perc-1", ["window:100.target.title"]);
    graph.removeLens("perc-1");
    // The key should not appear for any affected lens
    const affected = graph.lookupAffectedLenses(new Set(["window:100.target.title"]));
    expect(affected.size).toBe(0);
  });

  it("lensIds() lists all registered lenses", () => {
    graph.addLens("perc-1", ["window:100.target.title"]);
    graph.addLens("perc-2", ["window:200.target.rect"]);
    const ids = graph.lensIds();
    expect(ids).toContain("perc-1");
    expect(ids).toContain("perc-2");
    expect(ids).toHaveLength(2);
  });

  it("__resetForTests clears all state", () => {
    graph.addLens("perc-1", ["window:100.target.title"]);
    graph.__resetForTests();
    expect(graph.hasLens("perc-1")).toBe(false);
    expect(graph.lensIds()).toHaveLength(0);
  });
});
