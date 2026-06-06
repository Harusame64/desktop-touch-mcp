import { describe, it, expect, vi } from "vitest";
import { GuardedTouchLoop, type TouchEnvironment, type RoiCaptureMaterial } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Rect, UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

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
    if (result.ok) {
      expect(result.executor).toBe("uia");
      expect(result.downgrade).toBeUndefined();
    }
  });

  // Issue #327 item C: when env.execute() returns the rich ExecutorOutcome shape
  // (downgrade signalled), GuardedTouchLoop normalises and surfaces it on the
  // success TouchResult so the LLM can distinguish "advised executor was tried
  // and failed" from "advised executor was not the chosen route".
  it("surfaces downgrade on TouchResult when execute() returns ExecutorOutcome with downgrade (#327 item C)", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute: async () => ({
        kind: "mouse",
        downgrade: { from: "uia", reason: "InvokePatternNotSupported" },
      }),
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executor).toBe("mouse");
      expect(result.downgrade).toEqual({ from: "uia", reason: "InvokePatternNotSupported" });
    }
  });

  it("ExecutorOutcome without downgrade field omits TouchResult.downgrade (no spurious undefined)", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      execute: async () => ({ kind: "uia" }), // rich shape but no downgrade
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executor).toBe("uia");
      expect(result.downgrade).toBeUndefined();
      // Field omitted entirely (not `downgrade: undefined`) so JSON.stringify
      // produces the same shape as the bare-kind path.
      expect("downgrade" in result).toBe(false);
    }
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
  it("rejects expired lease", async () => {
    let now = 0;
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 1001;
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [e] }));
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

  // Issue #63: modal_blocking response now surfaces the offending modal's identity
  // so the LLM can dismiss it via click_element(name) without an extra screenshot.

  it("modal_blocking includes blockingElement when findBlockingModal returns an entity", async () => {
    const target = entity("e1", GEN);
    const modal  = entity("m1", GEN, {
      role: "unknown",
      label: "Copilot",
      sources: ["uia"],
      locator: { uia: { automationId: "CopilotPane" } },
    });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(target, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [target, modal],
      isModalBlocking:     () => true,
      findBlockingModal:   () => modal,
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      expect(result.blockingElement).toEqual({
        name: "Copilot",
        role: "unknown",
        automationId: "CopilotPane",
      });
    }
  });

  it("blockingElement falls back to locator.uia.name → role → 'modal' when label is missing", async () => {
    const target = entity("e1", GEN);
    const noLabel = entity("m1", GEN, {
      role: "unknown",
      label: undefined,
      sources: ["uia"],
      locator: { uia: { name: "System Dialog" } },
    });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(target, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [target, noLabel],
      isModalBlocking:     () => true,
      findBlockingModal:   () => noLabel,
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // locator.uia.name takes precedence when label is empty.
      expect(result.blockingElement?.name).toBe("System Dialog");
      // automationId omitted when locator does not provide it.
      expect(result.blockingElement?.automationId).toBeUndefined();
    }
  });

  it("blockingElement is omitted when isModalBlocking=true but findBlockingModal returns null (predicate divergence)", async () => {
    // Defensive case — env layers can drift if a custom isModalBlocking is paired with
    // a default/undefined findBlockingModal. The response must still be valid (no crash,
    // no empty {} field) so callers see "modal blocked, identity unavailable".
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      isModalBlocking:     () => true,
      findBlockingModal:   () => null,
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      expect(result.blockingElement).toBeUndefined();
      // Confirm the property is genuinely absent, not present-as-undefined.
      expect("blockingElement" in result).toBe(false);
    }
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

  // Issue #327 item D / Issue #297 closure completion: post-touch isModalLike
  // must exclude the same NON_MODAL_CHROME_CONTROL_TYPES list that pre-touch
  // isModalCandidate uses, otherwise Notepad-style chrome entities (TitleBar /
  // MenuBar / StatusBar) fire spurious modal_appeared whenever the UIA snapshot
  // re-keys them — exactly what dogfood saw on Notepad text-area clicks.
  for (const chromeType of ["MenuBar", "TitleBar", "StatusBar", "ToolBar", "ScrollBar", "Tab", "Menu", "MenuItem"] as const) {
    it(`UIA role=unknown chrome with controlType=${chromeType} does NOT trigger modal_appeared (#327 item D)`, async () => {
      const btn    = entity("btn", GEN, { sources: ["visual_gpu"] });
      const chrome = entity("chrome", GEN, {
        sources: ["uia"],
        role: "unknown",
        controlType: chromeType,
      });
      const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
      const lease = store.issue(btn, "v1");
      const loop  = new GuardedTouchLoop(store, makeEnv({
        resolveLiveEntities:      () => [btn],
        resolvePostTouchEntities: async () => [btn, chrome],
      }));
      const result = await loop.touch({ lease });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.diff).not.toContain("modal_appeared");
    });
  }

  it("UIA role=unknown with controlType=Pane (no chrome exclusion) DOES trigger modal_appeared — scope pin", async () => {
    // Genuine dialogs / overlays surface as role=unknown without a chrome controlType
    // (often controlType=Pane / Window for modal dialogs). The chrome filter must
    // NOT swallow these — this test pins that direction of the rule.
    const btn    = entity("btn", GEN, { sources: ["visual_gpu"] });
    const dialog = entity("dialog", GEN, {
      sources: ["uia"],
      role: "unknown",
      controlType: "Pane",
    });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(btn, "v1");
    const loop  = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, dialog],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("modal_appeared");
  });

  it("UIA role=unknown without controlType (legacy producer) DOES trigger modal_appeared — back-compat pin", async () => {
    // Entities from non-UIA-fronted producers (legacy bridge, visual-only) won't
    // have a controlType field. The chrome filter must fall through and the
    // role-based heuristic must keep firing — preserves pre-#297 behaviour.
    const btn    = entity("btn", GEN, { sources: ["visual_gpu"] });
    const modal  = entity("modal", GEN, { sources: ["uia"], role: "unknown" });
    const store  = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease  = store.issue(btn, "v1");
    const loop   = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities:      () => [btn],
      resolvePostTouchEntities: async () => [btn, modal],
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("modal_appeared");
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
    let now = 0;
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const lease = store.issue(e, "v1");
    now = 9999;
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [e] }));
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

// ── ADR-024 Seed-2 S5b — postSnapshot seam (未配線 in prod; wired in the loop) ──
//
// The loop consumes an optional per-call `postSnapshot` closure (W2): when
// present it supplies the post-touch candidates IN PLACE OF
// `env.resolvePostTouchEntities()`, surfaces `roiMaterial`, and scopes the diff
// to `roiMaterial.observedRect`. Absent → the env path runs and no `roiMaterial`
// is attached (byte-equal). Production does not pass a closure yet (S5b-2), so
// these tests exercise the seam with a fake closure.
describe("GuardedTouchLoop — ADR-024 S5b postSnapshot seam", () => {
  function ocrCandidate(label: string, rect: Rect): UiEntityCandidate {
    return {
      source: "ocr",
      target: { kind: "window", id: "w1" },
      role: "label",
      label,
      rect,
      actionability: ["click"],
      confidence: 0.7,
      observedAtMs: 0,
      provisional: false,
    };
  }

  it("postSnapshot present → used instead of resolvePostTouchEntities; candidates feed the diff; roiMaterial surfaces", async () => {
    const e = entity("e1", GEN); // touched, rect 100,200,80,30
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const resolvePost = vi.fn(async () => [] as UiEntity[]);
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      resolvePostTouchEntities: resolvePost,
    }));
    const roiMaterial: RoiCaptureMaterial = { observedRect: { x: 0, y: 0, width: 50, height: 50 } };
    const postSnapshot = vi.fn(async () => ({
      // A fresh OCR candidate inside the observed region; e (touched) sits OUTSIDE
      // it (100,200) so its fate is not asserted — isolating "candidate → diff".
      candidates: [ocrCandidate("Hello", { x: 10, y: 10, width: 20, height: 10 })],
      roiMaterial,
    }));

    const result = await loop.touch({ lease, postSnapshot });

    expect(postSnapshot).toHaveBeenCalledOnce();
    expect(resolvePost).not.toHaveBeenCalled(); // env path bypassed
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The closure's candidate was resolved into the post snapshot → appeared.
      expect(result.diff).toContain("entity_appeared");
      // The touched entity (outside observedRect) was not re-observed → not disappeared.
      expect(result.diff).not.toContain("entity_disappeared");
      // roiMaterial threaded straight through for the wrapper to strip.
      expect(result.roiMaterial).toBe(roiMaterial);
    }
  });

  it("postSnapshot absent → resolvePostTouchEntities used and no roiMaterial key (byte-equal)", async () => {
    const e = entity("e1", GEN);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const resolvePost = vi.fn(async () => [e]);
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      resolvePostTouchEntities: resolvePost,
    }));

    const result = await loop.touch({ lease });

    expect(resolvePost).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toHaveLength(0);
      // Field omitted entirely (not `roiMaterial: undefined`) so JSON.stringify
      // matches the pre-S5b shape.
      expect("roiMaterial" in result).toBe(false);
    }
  });

  it("observedRect scopes the touched fate — out-of-region touched is NOT entity_disappeared", async () => {
    const e = entity("e1", GEN); // rect 100,200,80,30
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [e] }));

    // post empty (e absent), observedRect far from e → e was not re-observed.
    const result = await loop.touch({
      lease,
      postSnapshot: async () => ({ candidates: [], roiMaterial: { observedRect: { x: 0, y: 0, width: 10, height: 10 } } }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("entity_disappeared");
  });

  it("observedRect covering the touched entity DOES report entity_disappeared when it vanishes", async () => {
    const e = entity("e1", GEN); // rect 100,200,80,30
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [e] }));

    const result = await loop.touch({
      lease,
      postSnapshot: async () => ({ candidates: [], roiMaterial: { observedRect: { x: 100, y: 200, width: 80, height: 30 } } }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("entity_disappeared");
  });

  it("observedRect scopes the removed set — an out-of-region dismissed modal is NOT modal_dismissed", async () => {
    const touched = entity("t1", GEN, { rect: { x: 500, y: 500, width: 10, height: 10 } });
    const modal   = entity("m1", GEN, { role: "unknown", sources: ["uia"], rect: { x: 0, y: 0, width: 10, height: 10 } });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(touched, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [touched, modal] }));

    // observedRect covers the touched (500,500) only; the modal (0,0) is outside.
    // post=[] → unscoped this would emit modal_dismissed (modal in removed); scoped
    // the out-of-region modal is excluded from removed.
    const result = await loop.touch({
      lease,
      postSnapshot: async () => ({ candidates: [], roiMaterial: { observedRect: { x: 495, y: 495, width: 20, height: 20 } } }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).not.toContain("modal_dismissed");
      // The touched IS in the observed region and vanished → entity_disappeared,
      // proving the diff actually ran (not vacuously empty).
      expect(result.diff).toContain("entity_disappeared");
    }
  });
});
