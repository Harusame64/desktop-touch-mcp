/**
 * internal #420 — desktop_discover names controls that share a label by their row ("Delete — Beta"); a query
 * matches the control's own name, not the row's words added to it (/code-review on #1026: a query for "Beta" returned
 * that row's Delete first).
 */
import { describe, it, expect } from "vitest";
import { entityMatchesQuery } from "../../src/tools/desktop.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const ent = (label: string, labelContext?: string): UiEntity =>
  ({ entityId: "e", role: "button", label, ...(labelContext !== undefined && { labelContext }), confidence: 1, sources: ["cdp"], affordances: [], generation: "g", evidenceDigest: "d" }) as unknown as UiEntity;

describe("entityMatchesQuery", () => {
  it("matches a control by its own name, with or without row words", () => {
    expect(entityMatchesQuery(ent("Delete — Beta", "Beta"), "delete")).toBe(true);
    expect(entityMatchesQuery(ent("Beta"), "beta")).toBe(true);
  });
  it("does not match a control by its row's words", () => {
    expect(entityMatchesQuery(ent("Delete — Beta", "Beta"), "beta")).toBe(false);
  });
  it("matches a plain label as before, including one that holds ' — ' itself", () => {
    expect(entityMatchesQuery(ent("Save — draft"), "draft")).toBe(true);
  });
});
