import { describe, it, expect } from "vitest";
import { GuardedTouchLoop, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

function entity(id: string, gen: string, opts: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: id,
    role: "button",
    label: "Start",
    confidence: 0.9,
    sources: ["visual_gpu"],
    affordances: [
      { verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] },
      { verb: "click",  executors: ["mouse"],         confidence: 0.8, preconditions: [], postconditions: [] },
    ],
    generation: gen,
    evidenceDigest: `d-${id}`,
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...opts,
  };
}

function makeEnv(overrides: Partial<TouchEnvironment> = {}): TouchEnvironment {
  return {
    resolveLiveEntities:      () => [],
    currentGeneration:        () => "gen-1",
    isModalBlocking:          () => false,
    isInViewport:             () => true,
    execute:                  async () => "mouse",
    resolvePostTouchEntities: async () => [],
    ...overrides,
  };
}

const GEN = "gen-1";

describe("GuardedTouchLoop — happy path", () => {
  it("succeeds when lease is valid and environment is clear", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "view-1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [e],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executor).toBe("mouse");
      expect(result.diff).toHaveLength(0);
      expect(result.next).toBe("none");
    }
  });

  it("returns executor from environment execute()", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute:             async () => "uia",
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.executor).toBe("uia");
  });
});

describe("GuardedTouchLoop — auto action resolution", () => {
  it("auto resolves to highest-priority affordance verb (invoke > click)", async () => {
    const capturedActions: string[] = [];
    const e = entity("e1", GEN); // has invoke + click affordances
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute: async (ent, action) => { capturedActions.push(action); return "uia"; },
    }));
    await loop.touch({ lease, action: "auto" });
    expect(capturedActions[0]).toBe("invoke"); // invoke has higher priority than click
  });

  it("auto falls back to click when entity has no affordances", async () => {
    const capturedActions: string[] = [];
    const e = entity("e1", GEN, { affordances: [] });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute: async (_, action) => { capturedActions.push(action); return "mouse"; },
    }));
    await loop.touch({ lease, action: "auto" });
    expect(capturedActions[0]).toBe("click");
  });

  it("explicit action bypasses auto resolution", async () => {
    const capturedActions: string[] = [];
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute: async (_, action) => { capturedActions.push(action); return "uia"; },
    }));
    await loop.touch({ lease, action: "type", text: "hello" });
    expect(capturedActions[0]).toBe("type");
  });
});

describe("GuardedTouchLoop — lease rejection (safe fail)", () => {
  it("rejects expired lease when the live entity's digest no longer matches", async () => {
    // No-compromise lease C: with the grace path in place, an *expired* lease
    // is now only rejected when the entity has actually changed underneath
    // (or disappeared / shifted generation). Force a digest mismatch to keep
    // the historical "expired = rejected" assertion meaningful.
    let now = 0;
    const e          = entity("e1", GEN, { evidenceDigest: "d-original" });
    const eChanged   = entity("e1", GEN, { evidenceDigest: "d-changed"  });
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 1001;
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [eChanged] }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });

  it("rejects lease with generation mismatch", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      currentGeneration:   () => "gen-2",
      resolveLiveEntities: () => [{ ...e, generation: "gen-2" }],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_generation_mismatch");
  });

  it("rejects lease when entity no longer exists in live set", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [] }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("rejects lease when evidenceDigest has changed", async () => {
    const original = entity("e1", GEN, { evidenceDigest: "d-original" });
    const mutated  = entity("e1", GEN, { evidenceDigest: "d-new" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(original, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [mutated] }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_digest_mismatch");
  });
});

describe("GuardedTouchLoop — pre-touch checks", () => {
  it("rejects when modal is blocking", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      isModalBlocking:     () => true,
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("modal_blocking");
  });

  it("rejects when entity is outside viewport", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      isInViewport:        () => false,
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_outside_viewport");
  });

  it("safe-fails when executor throws", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute:             async () => { throw new Error("native call failed"); },
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("executor_failed");
  });
});

describe("GuardedTouchLoop — semantic diff", () => {
  it("entity_disappeared when entity vanishes after touch", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toContain("entity_disappeared");
      expect(result.next).toBe("refresh_view");
    }
  });

  it("entity_moved when entity rect shifts > 16px", async () => {
    const pre  = entity("e1", GEN, { rect: { x: 100, y: 200, width: 80, height: 30 } });
    const post = entity("e1", GEN, { rect: { x: 150, y: 200, width: 80, height: 30 } });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(pre, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [pre],
      resolvePostTouchEntities: async () => [post],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("entity_moved");
  });

  it("modal_appeared when a new UIA role=unknown entity appears", async () => {
    const btn   = entity("btn",   GEN, { sources: ["visual_gpu"] });
    const modal = entity("modal", GEN, { sources: ["uia"], role: "unknown" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(btn, "v1");
    const loop  = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, modal],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("modal_appeared");
  });

  it("UIA button (role=button) appearing does NOT trigger modal_appeared", async () => {
    const btn    = entity("btn", GEN, { sources: ["visual_gpu"] });
    const newBtn = entity("new", GEN, { sources: ["uia"], role: "button" }); // not a modal
    const store  = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease  = store.issue(btn, "v1");
    const loop   = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, newBtn],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("modal_appeared");
  });

  it("diff is empty and next='none' when nothing changed", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [e],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toHaveLength(0);
      expect(result.next).toBe("none");
    }
  });

  it("rejection carries empty diff (no post-touch state)", async () => {
    // No-compromise lease C: keep the rejection path triggered by feeding
    // back a digest-mismatched live entity, so the test still proves
    // "no post-touch diff is computed on failure".
    let now = 0;
    const e        = entity("e1", GEN, { evidenceDigest: "d-original" });
    const eChanged = entity("e1", GEN, { evidenceDigest: "d-changed"  });
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 9999;
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [eChanged] }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diff).toHaveLength(0);
  });
});

describe("GuardedTouchLoop — enriched semantic diff (P2-D)", () => {
  it("value_changed when entity value differs pre vs post", async () => {
    const pre  = entity("e1", GEN, { role: "textbox", value: "" });
    const post = entity("e1", GEN, { role: "textbox", value: "hello" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(pre, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [pre],
      resolvePostTouchEntities: async () => [post],
    }));
    const result = await loop.touch({ lease, action: "type", text: "hello" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("value_changed");
  });

  it("no value_changed when value is the same", async () => {
    const e = entity("e1", GEN, { role: "textbox", value: "same" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [entity("e1", GEN, { role: "textbox", value: "same" })],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("value_changed");
  });

  it("no value_changed when entity has no value field (not comparable)", async () => {
    const pre  = entity("e1", GEN, { role: "button" }); // no value field
    const post = entity("e1", GEN, { role: "button" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(pre, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [pre],
      resolvePostTouchEntities: async () => [post],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("value_changed");
  });

  it("entity_appeared when non-modal entity appears after touch", async () => {
    const btn = entity("btn", GEN, { sources: ["visual_gpu"] });
    const newBtn = entity("new", GEN, { sources: ["visual_gpu"], role: "button" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(btn, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, newBtn],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("entity_appeared");
  });

  it("entity_appeared not emitted for modal (modal_appeared takes priority)", async () => {
    const btn   = entity("btn",   GEN, { sources: ["visual_gpu"] });
    const modal = entity("modal", GEN, { sources: ["uia"], role: "unknown" });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(btn, "v1");
    const loop  = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, modal],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toContain("modal_appeared");
      expect(result.diff).not.toContain("entity_appeared"); // modal suppresses entity_appeared
    }
  });

  it("both entity_appeared and modal_appeared when both types appear", async () => {
    const btn    = entity("btn",    GEN, { sources: ["visual_gpu"] });
    const newBtn = entity("new",    GEN, { sources: ["visual_gpu"], role: "button" });
    const modal  = entity("modal",  GEN, { sources: ["uia"],        role: "unknown" });
    const store  = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease  = store.issue(btn, "v1");
    const loop   = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, newBtn, modal],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toContain("modal_appeared");
      expect(result.diff).toContain("entity_appeared"); // non-modal also appeared
    }
  });

  it("focus_shifted when getFocusedEntityId changes pre vs post", async () => {
    const e = entity("e1", GEN);
    let callCount = 0;
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [e],
      getFocusedEntityId: () => {
        callCount++;
        return callCount === 1 ? "e1" : "e2"; // focus moved from e1 to e2
      },
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("focus_shifted");
  });

  it("no focus_shifted when focus does not change", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [e],
      getFocusedEntityId: () => "e1", // focus stays on e1
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("focus_shifted");
  });

  it("no focus_shifted when getFocusedEntityId is not provided", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [e],
      // No getFocusedEntityId — conservative, no focus_shifted emitted
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("focus_shifted");
  });

  it("terminal textbox: label change triggers value_changed (label IS the value)", async () => {
    const pre  = entity("t1", GEN, { sources: ["terminal"], role: "textbox", label: "PS C:\> " });
    const post = entity("t1", GEN, { sources: ["terminal"], role: "textbox", label: "PS C:\src> " });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(pre, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [pre],
      resolvePostTouchEntities: async () => [post],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("value_changed");
  });
});

// ── H3: dialog entity reachability ────────────────────────────────────────────
// After H3, desktop_see on a dialog hwnd creates a dialog-own session.
// Entities from the dialog session must not be modal_blocked by the dialog
// container itself (only OTHER unknown-role entities trigger the guard).

describe("GuardedTouchLoop — H3 dialog-own session modal guard", () => {
  it("touches dialog textbox without modal_blocking when only textbox is in live snapshot", async () => {
    // Scenario: Save As session contains only the filename textbox (no unknown-role entity).
    const filename = entity("e1", GEN, { role: "textbox", sources: ["uia"] });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(filename, "dialog-view");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [filename],
      resolvePostTouchEntities: async () => [filename],
      isModalBlocking: (entity) => {
        // session-aware default: other uia+unknown entities in snapshot block
        return false;  // dialog session has no unknown-role containers
      },
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
  });

  it("self-entity is excluded from modal check (dialog entity does not block itself)", async () => {
    // Even if the dialog container has role:unknown, touching IT does not trigger self-blocking.
    const dialogContainer = entity("dlg1", GEN, { role: "unknown", sources: ["uia"] });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(dialogContainer, "dialog-view");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [dialogContainer],
      resolvePostTouchEntities: async () => [dialogContainer],
      execute: async () => "uia",
      // session-aware default isModalBlocking excludes self-reference
      isModalBlocking: (e) => e !== dialogContainer && e.sources.includes("uia") && e.role === "unknown",
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
  });
});

// No-compromise lease C: touch-side grace. An expired lease whose live
// counterpart still has matching generation + digest is allowed to proceed
// — the LLM took longer than the TTL window but the world didn't move
// underneath. Other failure modes (digest_mismatch, generation_mismatch,
// entity_not_found) are still hard fails because they represent real
// content change.
describe("GuardedTouchLoop — expired-lease grace (lease C)", () => {
  it("expired lease + live digest matches → succeeds with warning", async () => {
    let now = 0;
    const e = entity("e1", GEN, { evidenceDigest: "d-stable" });
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 5_000; // way past TTL
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [e],
      resolvePostTouchEntities: async () => [e],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain("lease_was_expired_but_entity_unchanged");
    }
  });

  it("expired lease + live entity missing → still fails with lease_expired", async () => {
    let now = 0;
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 5_000;
    // Live snapshot doesn't contain the entity any more.
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [] }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });

  it("expired lease + generation mismatch → still fails with lease_expired (no grace)", async () => {
    let now = 0;
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 5_000;
    const loop = new GuardedTouchLoop(store, makeEnv({
      // Live entity exists with the same digest, but world generation moved.
      resolveLiveEntities: () => [e],
      currentGeneration:   () => "gen-2",
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });

  it("non-expired failure modes do NOT trigger the grace path (safety)", async () => {
    // Generation mismatch on a NON-expired lease must still surface as
    // lease_generation_mismatch, not get re-categorized.
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      currentGeneration:   () => "gen-2",
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_generation_mismatch");
  });
});
