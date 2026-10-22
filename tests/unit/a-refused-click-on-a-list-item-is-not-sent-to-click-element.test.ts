/**
 * internal #291 — a coordinate refusal of a click on a list, tree or grid item does not send the caller
 * to click_element.
 *
 * From win2 on PR #819 (H2, 2026-10-13): a click on a collection item refused with `aim_occluded` was
 * still advised "click_element(name=…) invokes through the accessibility API". On these items that
 * Invoke is the press a click avoids: a DataGridView cell starts editing, a .NET 10 parent tree node
 * expands without selecting, an Explorer item opens the file, and a ReadOnly cell has no Invoke at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedTouchLoop, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { EntityLease, UiEntity } from "../../src/engine/world-graph/types.js";
import { collectionItemRefusalAdviceFor, getSuggestsForCode } from "../../src/tools/_errors.js";
import { desktopActRawHandler, getDesktopFacade, _resetFacadeForTest } from "../../src/tools/desktop-register.js";

afterEach(() => {
  vi.restoreAllMocks();
  _resetFacadeForTest();
});

const GEN = "gen-1";

function item(controlType: string, patterns: string[]): UiEntity {
  return {
    entityId: "it", role: "listitem", label: "report.xlsx", confidence: 0.9, sources: ["uia"],
    affordances: [{ verb: "click", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: GEN, evidenceDigest: "d-it", rect: { x: 100, y: 200, width: 80, height: 20 }, controlType, patterns,
  };
}

function env(e: UiEntity, thrown: Error): TouchEnvironment {
  return {
    resolveLiveEntities: () => [e],
    currentGeneration: () => GEN,
    isModalBlocking: () => false,
    checkViewport: () => null,
    execute: async () => { throw thrown; },
    resolvePostTouchEntities: async () => [],
  };
}

const named = (name: string) => Object.assign(new Error("refused"), { name });

const REFUSALS = [
  ["AimOccludedError", "aim_occluded"],
  ["AimedRouteFailedError", "aim_route_failed"],
  ["AimBlockedByExcludedWindowError", "aim_blocked_by_excluded_window"],
  ["CoordinateOutsideReachableBounds", "coordinate_outside_reachable_bounds"],
  ["CursorPlacementBlocked", "cursor_placement_blocked"],
] as const;

async function touch(e: UiEntity, thrown: Error, action?: "click" | "invoke") {
  const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
  const lease = store.issue(e, "v1");
  return new GuardedTouchLoop(store, env(e, thrown)).touch({ lease, ...(action !== undefined && { action }) });
}

describe("the loop marks a refused click on a collection item", () => {
  for (const [name, reason] of REFUSALS) {
    it(`${reason}: a ListItem with Invoke, a DataItem without, and a Button not at all`, async () => {
      const withInvoke = await touch(item("ListItem", ["InvokePattern", "SelectionItemPattern"]), named(name), "click");
      expect(withInvoke).toMatchObject({ ok: false, reason, adviceClass: "collection_item_select" });
      const noInvoke = await touch(item("DataItem", ["ValuePattern"]), named(name), "click");
      expect(noInvoke).toMatchObject({ ok: false, reason, adviceClass: "collection_item_select_no_invoke" });
      const button = await touch(item("Button", ["InvokePattern"]), named(name), "click");
      expect(button).toMatchObject({ ok: false, reason });
      expect(button).not.toHaveProperty("adviceClass");
    });
  }

  it("marks it when the action is omitted, as a real UIA item reads (affordances 'read', so auto is click)", async () => {
    const real = { ...item("ListItem", ["InvokePattern"]), affordances: [{ verb: "read" as const, executors: ["uia" as const], confidence: 0.9, preconditions: [], postconditions: [] }] };
    const r = await touch(real, named("AimOccludedError"));
    expect(r).toMatchObject({ ok: false, reason: "aim_occluded", adviceClass: "collection_item_select" });
  });

  it("CONTROL: an invoke on the same item is not marked — opening it is what was asked", async () => {
    const r = await touch(item("ListItem", ["InvokePattern"]), named("AimOccludedError"), "invoke");
    expect(r).toMatchObject({ ok: false, reason: "aim_occluded" });
    expect(r).not.toHaveProperty("adviceClass");
  });

  it("CONTROL: a refusal whose advice never named click_element is not marked (aim_point_outside_window)", async () => {
    const r = await touch(item("TreeItem", ["InvokePattern"]), named("AimedPointOutsideWindowError"), "click");
    expect(r).toMatchObject({ ok: false, reason: "aim_point_outside_window" });
    expect(r).not.toHaveProperty("adviceClass");
  });
});

const SENDS = /click_element\(name=…\) (invokes|is worth)/;
const CODES = ["AimOccluded", "AimRouteFailed", "AimBlockedByExcludedWindow", "CoordinateOutsideReachableBounds", "CursorPlacementBlocked"] as const;

describe("the advice for it", () => {
  for (const code of CODES) {
    it(`${code}: drops exactly the line that sends to click_element, and says why not`, () => {
      const table = getSuggestsForCode(code);
      // Pins the pattern to the table: a reworded line would otherwise slip past the filter.
      expect(table.filter((l) => SENDS.test(l))).toHaveLength(1);
      const advice = collectionItemRefusalAdviceFor(code, "collection_item_select");
      expect(advice.some((l) => SENDS.test(l))).toBe(false);
      expect(advice.some((l) => /do NOT use click_element on it/.test(l))).toBe(true);
      expect(advice.some((l) => /action:'invoke'/.test(l))).toBe(true);
      expect(collectionItemRefusalAdviceFor(code, "collection_item_select_no_invoke").some((l) => /action:'invoke'/.test(l))).toBe(false);
    });
  }

  it("keeps a line that forbids click_element (aim_route_failed's 'do NOT press again')", () => {
    expect(collectionItemRefusalAdviceFor("AimRouteFailed", "collection_item_select").some((l) => /do NOT press again, click_element included/.test(l))).toBe(true);
  });
});

describe("through desktop_act", () => {
  const lease: EntityLease = { entityId: "it", viewId: "v1", targetGeneration: GEN, expiresAtMs: Number.MAX_SAFE_INTEGER, evidenceDigest: "d-it" };

  async function answer(reason: string, adviceClass?: "collection_item_select" | "collection_item_select_no_invoke") {
    vi.spyOn(getDesktopFacade(), "touch").mockResolvedValue({ ok: false, reason, diff: [], ...(adviceClass !== undefined && { adviceClass }) } as never);
    const r = await desktopActRawHandler({ lease, action: "click" });
    return JSON.parse((r.content[0] as { text: string }).text) as { if_unexpected: { try_next: Array<{ action: string }> } };
  }

  for (const reason of ["aim_occluded", "aim_route_failed", "aim_blocked_by_excluded_window", "coordinate_outside_reachable_bounds", "cursor_placement_blocked"] as const) {
    it(`${reason}: try_next does not send a collection item to click_element`, async () => {
      const marked = await answer(reason, "collection_item_select");
      expect(marked.if_unexpected.try_next.some((t) => SENDS.test(t.action))).toBe(false);
      expect(marked.if_unexpected.try_next.some((t) => /do NOT use click_element on it/.test(t.action))).toBe(true);
      // CONTROL: unmarked, the reason's own table and headline, as before.
      const plain = await answer(reason);
      expect(plain.if_unexpected.try_next.some((t) => SENDS.test(t.action))).toBe(true);
    });
  }

  it("an item without Invoke is not offered action:'invoke'", async () => {
    const r = await answer("aim_occluded", "collection_item_select_no_invoke");
    expect(r.if_unexpected.try_next.some((t) => /do NOT use click_element on it/.test(t.action))).toBe(true);
    expect(r.if_unexpected.try_next.some((t) => /action:'invoke'/.test(t.action))).toBe(false);
  });
});
