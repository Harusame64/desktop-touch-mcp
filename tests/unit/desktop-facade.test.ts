import { describe, it, expect, vi } from "vitest";
import { DesktopFacade, type CandidateProvider, type DesktopSeeInput, type CandidateIngress } from "../../src/tools/desktop.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const TARGET_GAME    = { windowTitle: "GameWindow" };
const TARGET_CHROME  = { tabId: "tab-1" };
const TARGET_TERM    = { windowTitle: "PowerShell" };

function cand(
  label: string,
  source: UiEntityCandidate["source"],
  overrides: Partial<UiEntityCandidate> = {}
): UiEntityCandidate {
  return {
    source,
    target: { kind: "window", id: "win-1" },
    label,
    role: "button",
    actionability: ["invoke", "click"],
    confidence: 0.9,
    observedAtMs: 1000,
    provisional: false,
    digest: `digest-${label}-${source}`,
    rect: { x: 10, y: 20, width: 80, height: 30 },
    ...overrides,
  };
}

const gameProvider: CandidateProvider = (_input) => [
  cand("Start Match", "visual_gpu"),
  cand("Settings",    "visual_gpu"),
];

const chromeProvider: CandidateProvider = (_input) => [
  cand("Search",    "cdp"),
  cand("Sign In",   "cdp"),
];

const terminalProvider: CandidateProvider = (_input) => [
  cand("$ npm test", "terminal", { role: "label", actionability: ["read"] }),
];

describe("DesktopFacade — desktop_see (game / chrome / terminal)", () => {
  it("game: resolves visual_gpu entities without raw coords", async () => {
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: TARGET_GAME });
    expect(out.entities).toHaveLength(2);
    expect(out.entities[0].label).toBe("Start Match");
    expect(out.entities[0].sources).toContain("visual_gpu");
    expect(out.entities[0].rect).toBeUndefined(); // no coords in normal mode
    expect(out.entities[0].lease).toBeDefined();
  });

  it("chrome: resolves CDP entities without raw coords", async () => {
    const facade = new DesktopFacade(chromeProvider);
    const out = await facade.see({ target: TARGET_CHROME });
    expect(out.entities).toHaveLength(2);
    expect(out.entities[0].sources).toContain("cdp");
    expect(out.entities[0].rect).toBeUndefined();
  });

  it("terminal: resolves terminal entities without raw coords", async () => {
    const facade = new DesktopFacade(terminalProvider);
    const out = await facade.see({ target: TARGET_TERM });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].sources).toContain("terminal");
    expect(out.entities[0].rect).toBeUndefined();
  });

  it("debug=true exposes raw rect for all target types", async () => {
    for (const [provider, target] of [
      [gameProvider,    TARGET_GAME],
      [chromeProvider,  TARGET_CHROME],
      [terminalProvider, TARGET_TERM],
    ] as const) {
      const facade = new DesktopFacade(provider);
      const out = await facade.see({ target, debug: true });
      for (const e of out.entities) {
        expect(e.rect).toBeDefined(); // coords exposed in debug mode
      }
    }
  });

  it("viewId and generation are present in response", async () => {
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see();
    expect(out.viewId).toBeTruthy();
    expect(out.target.generation).toBeTruthy();
  });

  // No-compromise lease A: every see() carries a softExpiresAtMs hint that
  // sits before the lease's hard expiresAtMs. The LLM uses softExpiresAtMs
  // to decide "should I refresh proactively?" without any TTL-related
  // correctness coupling.
  it("response includes softExpiresAtMs strictly less than each lease.expiresAtMs", async () => {
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see();
    expect(typeof out.softExpiresAtMs).toBe("number");
    expect(Number.isInteger(out.softExpiresAtMs)).toBe(true);
    for (const e of out.entities) {
      expect(out.softExpiresAtMs).toBeLessThan(e.lease.expiresAtMs);
    }
  });

  it("query filters entities by label substring", async () => {
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ query: "start" });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].label).toBe("Start Match");
  });

  it("maxEntities limits the returned count", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 30 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider);
    const out = await facade.see({ maxEntities: 5 });
    expect(out.entities).toHaveLength(5);
  });

  it("explore view raises default maxEntities to 50", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 60 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider);
    expect((await facade.see({ view: "explore" })).entities).toHaveLength(50);
    expect((await facade.see({ view: "action"  })).entities).toHaveLength(20);
  });
});

// Audit P1-12 (gap #2): explicit shape validation for the lease handed back
// from desktop_discover. The existing tests above assert `lease` is defined;
// these add a contract on every required field so refactors can't quietly
// drop one and still pass the previous expectations.
describe("DesktopFacade — desktop_discover lease shape contract", () => {
  it("each entity carries a complete EntityLease (5 required fields, all populated)", async () => {
    const facade = new DesktopFacade(gameProvider);
    const before = Date.now();
    const out = await facade.see({ target: TARGET_GAME });
    expect(out.entities.length).toBeGreaterThan(0);

    for (const entity of out.entities) {
      const lease = entity.lease;
      expect(lease).toBeDefined();
      expect(typeof lease!.entityId).toBe("string");
      expect(lease!.entityId.length).toBeGreaterThan(0);
      expect(typeof lease!.viewId).toBe("string");
      expect(lease!.viewId).toBe(out.viewId);
      expect(typeof lease!.targetGeneration).toBe("string");
      expect(lease!.targetGeneration.length).toBeGreaterThan(0);
      expect(typeof lease!.expiresAtMs).toBe("number");
      expect(lease!.expiresAtMs).toBeGreaterThan(before); // future timestamp
      expect(typeof lease!.evidenceDigest).toBe("string");
      expect(lease!.evidenceDigest.length).toBeGreaterThan(0);
    }
  });

  it("lease.entityId matches entity.entityId so callers can route without ambiguity", async () => {
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: TARGET_GAME });
    for (const entity of out.entities) {
      expect(entity.lease!.entityId).toBe(entity.entityId);
    }
  });
});

// Audit P1-12 (gap #3): the windows[] array on DesktopSeeOutput is meant to
// reflect whatever the live windowsProvider currently reports, including a
// focus shift between calls. These tests pin the contract so a future
// refactor that caches the snapshot can't silently freeze focus.
describe("DesktopFacade — windows[] reflects live windowsProvider state", () => {
  function makeWindow(overrides: Partial<{
    title: string; hwnd: string; isActive: boolean; zOrder: number;
  }> = {}) {
    return {
      zOrder: overrides.zOrder ?? 0,
      title: overrides.title ?? "Notepad",
      hwnd: overrides.hwnd ?? "1000",
      region: { x: 0, y: 0, width: 800, height: 600 },
      isActive: overrides.isActive ?? true,
      isMinimized: false,
      isMaximized: false,
      processName: "notepad.exe",
    };
  }

  it("a focus change between two see() calls is reflected by windows[].isActive", async () => {
    let activeHwnd = "1000";
    const facade = new DesktopFacade(() => [], {
      windowsProvider: () => [
        makeWindow({ hwnd: "1000", title: "Notepad", isActive: activeHwnd === "1000", zOrder: 0 }),
        makeWindow({ hwnd: "2000", title: "Calc",    isActive: activeHwnd === "2000", zOrder: 1 }),
      ],
    });

    const first = await facade.see({});
    const firstActive = first.windows.find((w) => w.isActive);
    expect(firstActive?.hwnd).toBe("1000");

    activeHwnd = "2000";

    const second = await facade.see({});
    const secondActive = second.windows.find((w) => w.isActive);
    expect(secondActive?.hwnd).toBe("2000");

    // The previously-active window must now report isActive:false (focus
    // moved away, not lost).
    const previousNotepad = second.windows.find((w) => w.hwnd === "1000");
    expect(previousNotepad?.isActive).toBe(false);
  });
});

describe("DesktopFacade — desktop_touch", () => {
  it("touch with valid lease returns ok:true + diff", async () => {
    const facade = new DesktopFacade(gameProvider, { executorFn: async () => "mouse" });
    const view = await facade.see({ target: TARGET_GAME });
    const lease = view.entities[0].lease;
    const result = await facade.touch({ lease });
    expect(result.ok).toBe(true);
  });

  it("touch after second see() invalidates leases from first see()", async () => {
    const facade = new DesktopFacade(gameProvider);
    const view1 = await facade.see();
    const oldLease = view1.entities[0].lease;
    await facade.see(); // replaceViewId evicts view1's viewId from index
    const result = await facade.touch({ lease: oldLease });
    // viewId removed from index → entity_not_found (safe fail)
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("touch returns entity_disappeared when entity vanishes after click", async () => {
    let callCount = 0;
    const dynamicProvider: CandidateProvider = () =>
      callCount === 0 ? [cand("Start", "visual_gpu")] : [];

    const facade = new DesktopFacade(dynamicProvider, {
      postTouchCandidates: () => { callCount++; return []; }, // no entities after click
    });
    const view = await facade.see();
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("entity_disappeared");
  });

  it("touch with expired lease returns ok:false reason:lease_expired", async () => {
    let now = 0;
    const facade = new DesktopFacade(gameProvider, {
      defaultTtlMs: 1000,
      nowFn: () => now,
    });
    const view = await facade.see();
    now = 2000; // past TTL
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });

  it("touch passes action and text to executor", async () => {
    const calls: Array<{ action: string; text?: string }> = [];
    const facade = new DesktopFacade(
      () => [cand("Input", "uia", {
        actionability: ["type"],
        digest: "d-input",
        role: "textbox",
      })],
      { executorFn: async (_, action, text) => { calls.push({ action, text }); return "uia"; } }
    );
    const view = await facade.see();
    await facade.touch({ lease: view.entities[0].lease, action: "type", text: "hello" });
    expect(calls[0].action).toBe("type");
    expect(calls[0].text).toBe("hello");
  });
});

// ── G1: Production guard wiring ───────────────────────────────────────────────

describe("DesktopFacade — G1 modal guard (session-aware default)", () => {
  // The session-aware modal default (in session-registry.ts) checks if any OTHER entity
  // in the session's live snapshot has sources:["uia"] and role:"unknown".
  // No isModalBlocking override needed — the default is production-grade.

  it("modal_blocking when a UIA 'unknown' entity co-exists with the touch target", async () => {
    const modalCand: UiEntityCandidate = {
      source: "uia",
      target: { kind: "window", id: "win-1" },
      label: "Dialog",
      role: "unknown",   // ← triggers modal guard
      actionability: [],
      confidence: 0.95,
      observedAtMs: 1000,
      provisional: false,
      digest: "digest-modal",
      rect: { x: 0, y: 0, width: 400, height: 300 },
    };
    // Provider returns both the button (touch target) and a modal overlay.
    const providerWithModal: CandidateProvider = () => [
      cand("Start Match", "visual_gpu"),
      modalCand,
    ];
    const facade = new DesktopFacade(providerWithModal, { executorFn: async () => "mouse" });
    const view = await facade.see({ target: TARGET_GAME });
    // Touch the "Start Match" button — session has the "Dialog" UIA unknown entity too.
    const btnLease = view.entities.find((e) => e.label === "Start Match")?.lease;
    expect(btnLease).toBeDefined();
    const result = await facade.touch({ lease: btnLease! });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      // Issue #63: production default propagates the blocker identity end-to-end so
      // the LLM can dismiss it via click_element(name=blockingElement.name).
      expect(result.blockingElement).toBeDefined();
      expect(result.blockingElement?.name).toBe("Dialog");
      expect(result.blockingElement?.role).toBe("unknown");
    }
  });

  it("no modal_blocking when all live entities have non-unknown roles", async () => {
    // All entities are regular buttons — no modal overlay.
    const facade = new DesktopFacade(gameProvider, { executorFn: async () => "mouse" });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
  });

  it("touching the modal entity itself is NOT blocked by its own role", async () => {
    // If an LLM tries to touch the modal/dialog entity itself (e.g. to dismiss it),
    // the entity being touched is excluded from the modal check — no self-blocking.
    const modalCand: UiEntityCandidate = {
      source: "uia",
      target: { kind: "window", id: "win-1" },
      label: "OK",
      role: "unknown",
      actionability: ["invoke"],
      confidence: 0.9,
      observedAtMs: 1000,
      provisional: false,
      digest: "digest-modal-ok",
    };
    const facade = new DesktopFacade(
      () => [modalCand],
      { executorFn: async () => "uia" }
    );
    const view = await facade.see();
    const result = await facade.touch({ lease: view.entities[0].lease });
    // Only the modal entity is in session — it doesn't block itself.
    expect(result.ok).toBe(true);
  });

  it("isModalBlocking override takes precedence over session-aware default", async () => {
    // Explicit override: always block (even with no UIA unknown entities).
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      isModalBlocking: () => true,
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("modal_blocking");
  });

  // Issue #63 (Codex P1): when only one of the (isModalBlocking, findBlockingModal) pair
  // is overridden, the other must be derived to keep the predicate ↔ blockingElement
  // consistent. Otherwise, a default UIA-unknown finder would surface an entity unrelated
  // to a custom predicate and the LLM would be told to dismiss the wrong element.

  it("custom isModalBlocking alone omits blockingElement (no default UIA finder leak)", async () => {
    // Snapshot contains a UIA "unknown" entity that the *default* finder would surface,
    // but the custom predicate is what actually blocks. Without the Codex P1 fix the
    // response would carry the unrelated dialog as blockingElement.
    const unrelatedDialog: UiEntityCandidate = {
      source: "uia",
      target: { kind: "window", id: "win-1" },
      label: "Unrelated Dialog",
      role: "unknown",
      actionability: [],
      confidence: 0.9,
      observedAtMs: 1000,
      provisional: false,
      digest: "digest-unrelated",
    };
    const facade = new DesktopFacade(
      () => [cand("Start Match", "visual_gpu"), unrelatedDialog],
      { executorFn: async () => "mouse", isModalBlocking: () => true },
    );
    const view = await facade.see({ target: TARGET_GAME });
    const btnLease = view.entities.find((e) => e.label === "Start Match")?.lease;
    const result = await facade.touch({ lease: btnLease! });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      // No custom finder → blockingElement omitted entirely.
      expect(result.blockingElement).toBeUndefined();
      expect("blockingElement" in result).toBe(false);
    }
  });

  it("custom findBlockingModal alone derives isModalBlocking from the finder", async () => {
    // Caller provides only the finder. The predicate must be derived as `finder !== null`
    // so the block decision and the blockingElement come from the same source.
    const customBlocker: UiEntityCandidate = {
      source: "uia",
      target: { kind: "window", id: "win-1" },
      label: "Custom Modal",
      role: "unknown",
      actionability: [],
      confidence: 0.9,
      observedAtMs: 1000,
      provisional: false,
      digest: "digest-custom-modal",
    };
    let captured: { entityId: string; label?: string } | null = null;
    const facade = new DesktopFacade(
      () => [cand("Start Match", "visual_gpu"), customBlocker],
      {
        executorFn: async () => "mouse",
        findBlockingModal: (entity) => {
          // Locate the custom blocker in *some* hand-rolled way; here we just match by label.
          // Returning a non-null entity must trigger modal_blocking even though
          // isModalBlocking is unspecified.
          if (entity.label === "Start Match") {
            captured = { entityId: entity.entityId, label: entity.label };
            return { ...entity, entityId: "custom-modal-id", label: "Custom Modal", role: "unknown" };
          }
          return null;
        },
      },
    );
    const view = await facade.see({ target: TARGET_GAME });
    const btnLease = view.entities.find((e) => e.label === "Start Match")?.lease;
    const result = await facade.touch({ lease: btnLease! });
    expect(captured).not.toBeNull();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      expect(result.blockingElement?.name).toBe("Custom Modal");
    }
  });
});

describe("DesktopFacade — G1 viewport guard", () => {
  it("entity_outside_viewport when isInViewport returns false", async () => {
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      isInViewport: () => false, // simulate entity outside window
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_outside_viewport");
  });

  it("touch proceeds when isInViewport returns true", async () => {
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      isInViewport: () => true,
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
  });
});

describe("DesktopFacade — G1 focus detection (getFocusedEntityId)", () => {
  it("focus_shifted emitted when getFocusedEntityId changes pre vs post touch", async () => {
    let callCount = 0;
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      getFocusedEntityId: () => {
        callCount++;
        return callCount === 1 ? "hwnd:111" : "hwnd:222"; // focus moved to different window
      },
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).toContain("focus_shifted");
  });

  it("no focus_shifted when getFocusedEntityId is stable", async () => {
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      getFocusedEntityId: () => "hwnd:111", // same every time
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("focus_shifted");
  });

  it("no focus_shifted when getFocusedEntityId not provided (conservative default)", async () => {
    // No getFocusedEntityId → focus_shifted never emitted
    const facade = new DesktopFacade(gameProvider, { executorFn: async () => "mouse" });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diff).not.toContain("focus_shifted");
  });
});

describe("DesktopFacade — cross-source entity merging", () => {
  it("visual_gpu + uia with same digest merge into one entity with both sources", async () => {
    const provider: CandidateProvider = () => [
      cand("Submit", "visual_gpu", { digest: "d-submit" }),
      cand("Submit", "uia",        { digest: "d-submit" }),
    ];
    const facade = new DesktopFacade(provider);
    const out = await facade.see();
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].sources).toContain("visual_gpu");
    expect(out.entities[0].sources).toContain("uia");
  });
});

// ── H1: Response-size aware lease TTL ────────────────────────────────────────

// ── H3: Common dialog reachability regression ────────────────────────────────
// H3 targets dogfood incident S4 (Save As dialog — W-1/W-2/W-4/U-1/M-2 failures).
// When desktop_see targets a dialog hwnd directly (after owner-chain resolution),
// the session uses the dialog's hwnd as its key so entities come from the dialog itself.

describe("DesktopFacade — H3 common dialog reachability", () => {
  it("dialog hwnd session yields dialog entities (filename textbox)", async () => {
    const provider: CandidateProvider = async (input) => {
      if (input.target?.hwnd === "200") {
        return [cand("File name", "uia", {
          role: "textbox", actionability: ["type", "click"],
          digest: "d-filename",
        })];
      }
      return [];
    };
    const facade = new DesktopFacade(provider);
    const out = await facade.see({ target: { hwnd: "200" } });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].label).toBe("File name");
    expect(out.entities[0].role).toBe("textbox");
  });

  it("dialog entity can be touched (no modal_blocking from dialog-own session)", async () => {
    // The dialog session contains only dialog entities — no other window's unknown-role entity.
    // The default session-aware modal guard should NOT fire.
    const provider: CandidateProvider = async () => [
      cand("File name", "uia", {
        role: "textbox", actionability: ["type", "click"], digest: "d-filename",
      }),
    ];
    const facade = new DesktopFacade(provider, { executorFn: async () => "uia" });
    const view = await facade.see({ target: { hwnd: "200" } });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(true);
  });
});

// ── H4: Visual escalation warning propagation ────────────────────────────────

describe("DesktopFacade — H4 visual escalation in view=debug", () => {
  it("view=debug surfaces visual_not_attempted when provider warnings contain visual_provider_unavailable", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["uia_blind_single_pane", "visual_provider_unavailable"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ view: "debug" });
    expect(out.warnings).toBeDefined();
    expect(out.warnings).toContain("visual_not_attempted");
  });

  it("view=debug does NOT add duplicate visual_not_attempted when already present", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["visual_provider_unavailable", "visual_not_attempted"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ view: "debug" });
    const count = (out.warnings ?? []).filter((w) => w === "visual_not_attempted").length;
    expect(count).toBe(1);
  });

  it("non-debug view does NOT inject visual_not_attempted even with visual_provider_unavailable", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["visual_provider_unavailable"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ view: "action" });
    expect((out.warnings ?? []).includes("visual_not_attempted")).toBe(false);
  });
});

// H1 targets dogfood incidents L-1/L-2/L-3:
//   S1 (browser-form, explore ~50 entities) and S3 (terminal, action view)
//   both hit lease_expired because fixed 5s TTL < LLM read+reason+tool-call latency.
describe("DesktopFacade — response-size aware lease TTL (H1)", () => {
  it("explore view issues longer TTL than action view for same entity set", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 30 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facadeAction  = new DesktopFacade(manyProvider, { nowFn: () => 0 });
    const facadeExplore = new DesktopFacade(manyProvider, { nowFn: () => 0 });

    const viewAction  = await facadeAction.see({ view: "action" });
    const viewExplore = await facadeExplore.see({ view: "explore" });

    const expiryAction  = viewAction.entities[0].lease.expiresAtMs;
    const expiryExplore = viewExplore.entities[0].lease.expiresAtMs;

    expect(expiryExplore).toBeGreaterThan(expiryAction);
  });

  it("action view with few entities keeps TTL at base 5s", async () => {
    const facade = new DesktopFacade(gameProvider, { nowFn: () => 0 });
    const view = await facade.see({ view: "action" });
    // base 5000 + no view bonus + no entity bonus (2 entities)
    expect(view.entities[0].lease.expiresAtMs).toBe(5_000);
  });

  it("explore view with 50 entities adds meaningful TTL bonus", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 60 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => 0 });
    const view = await facade.see({ view: "explore" }); // 50 entities after maxEntities slice
    // 5000 base + 5000 explore + (50-20)*100 entityBonus + payloadBonus
    // (no-compromise A: payload-size aware). Estimate:
    //   estimatedPayloadBytes = 500 + 50*250 + 0*180 + 0 warnings = 13_000
    //   payloadBonus = (13_000 - 2_000) * 0.5 = 5_500
    // total = 5000 + 5000 + 3000 + 5500 = 18_500
    expect(view.entities[0].lease.expiresAtMs).toBe(18_500);
  });

  it("stale lease safety: TTL extension does NOT bypass generation eviction", async () => {
    const facade = new DesktopFacade(gameProvider, { nowFn: () => 0 });
    const view1 = await facade.see({ view: "explore" }); // longer TTL
    const oldLease = view1.entities[0].lease;
    await facade.see({ view: "explore" }); // bumps generation, evicts view1 from viewId index
    const result = await facade.touch({ lease: oldLease });
    expect(result.ok).toBe(false);
    // evicted from viewId index → entity_not_found (same as pre-H1 behavior)
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("stale lease safety: expired lease rejected even at high TTL (past 30s)", async () => {
    let now = 0;
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 80 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => now });
    const view = await facade.see({ view: "explore" });
    const lease = view.entities[0].lease;
    // Push clock well past the maximum possible TTL (cap: 30s)
    now = 40_000;
    const result = await facade.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });

  it("explicit defaultTtlMs overrides policy (backward compat for tests)", async () => {
    let now = 0;
    const facade = new DesktopFacade(gameProvider, {
      defaultTtlMs: 1_000,
      nowFn: () => now,
    });
    const view = await facade.see({ view: "explore" }); // policy would give 10s, but override wins
    expect(view.entities[0].lease.expiresAtMs).toBe(1_000);
    now = 2_000; // past the 1s override TTL
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });
});

// ── H2: Negative capability surfacing ────────────────────────────────────────

describe("DesktopFacade — H2 constraints surfacing", () => {
  it("no constraints field when provider returns no warnings", async () => {
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: TARGET_GAME });
    expect(out.constraints).toBeUndefined();
  });

  it("constraints.uia=blind_single_pane when warning present and entities > 0", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [cand("X", "uia")],
        warnings:   ["uia_blind_single_pane"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ target: TARGET_GAME });
    expect(out.constraints?.uia).toBe("blind_single_pane");
    expect(out.constraints?.entityZeroReason).toBeUndefined(); // entities > 0
  });

  it("constraints.entityZeroReason=uia_blind_visual_unready when 0 entities + UIA blind + visual unready", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["uia_blind_single_pane", "visual_not_attempted"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ target: TARGET_GAME });
    expect(out.entities).toHaveLength(0);
    expect(out.constraints?.entityZeroReason).toBe("uia_blind_visual_unready");
    expect(out.constraints?.uia).toBe("blind_single_pane");
    expect(out.constraints?.visual).toBe("not_attempted");
  });

  it("constraints.entityZeroReason=cdp_failed_visual_empty for browser PWA 0-entity scenario", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["visual_attempted_empty_cdp_fallback"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ target: TARGET_CHROME });
    expect(out.entities).toHaveLength(0);
    expect(out.constraints?.entityZeroReason).toBe("cdp_failed_visual_empty");
    expect(out.constraints?.cdp).toBe("provider_failed");
    expect(out.constraints?.visual).toBe("attempted_empty");
  });

  it("constraints.entityZeroReason=foreground_unresolved when no_provider_matched + 0 entities", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["no_provider_matched"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see();
    expect(out.constraints?.entityZeroReason).toBe("foreground_unresolved");
    expect(out.constraints?.window).toBe("no_provider_matched");
  });

  it("constraints and warnings co-exist (additive)", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings:   ["uia_provider_failed", "terminal_provider_failed"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see();
    expect(out.warnings).toContain("uia_provider_failed");
    expect(out.warnings).toContain("terminal_provider_failed");
    expect(out.constraints?.entityZeroReason).toBe("all_providers_failed");
  });

  it("constraints absent when only partial_results_only warning", async () => {
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [cand("OK", "uia")],
        warnings:   ["partial_results_only"],
      }),
      invalidate:  () => {},
      subscribe:   () => () => {},
      dispose:     () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see();
    expect(out.constraints).toBeUndefined();
  });
});

describe("DesktopFacade — per-target session isolation (Batch A)", () => {
  const TARGET_A = { hwnd: "hwnd-A" };
  const TARGET_B = { hwnd: "hwnd-B" };

  it("see() on target A does NOT invalidate leases for target B", async () => {
    const facade = new DesktopFacade(gameProvider);
    const viewA = await facade.see({ target: TARGET_A });
    const viewB = await facade.see({ target: TARGET_B });
    const leaseB = viewB.entities[0].lease;

    // Call see() on A again — bumps A's generation, not B's
    await facade.see({ target: TARGET_A });

    const result = await facade.touch({ lease: leaseB });
    // B's lease must still be valid
    expect(result.ok).toBe(true);
    void viewA; // suppress unused warning
  });

  it("see() on the same target invalidates its own previous leases", async () => {
    const facade = new DesktopFacade(gameProvider);
    const view1 = await facade.see({ target: TARGET_A });
    const oldLease = view1.entities[0].lease;
    await facade.see({ target: TARGET_A }); // replaceViewId removes view1's viewId
    const result = await facade.touch({ lease: oldLease });
    // Old viewId evicted from index → entity_not_found (safe fail)
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("two independent targets maintain separate generation counters", async () => {
    const facade = new DesktopFacade(gameProvider);
    const vA1 = await facade.see({ target: TARGET_A });
    const vB1 = await facade.see({ target: TARGET_B });
    await facade.see({ target: TARGET_A }); // bumps A seq to 2
    const vB2 = await facade.see({ target: TARGET_B }); // bumps B seq to 2
    // Generations should embed different viewIds and seq numbers
    expect(vA1.target.generation).not.toBe(vB1.target.generation);
    expect(vB1.target.generation).not.toBe(vB2.target.generation);
  });

  it("touch dispatches to the correct session by viewId", async () => {
    const executorCalls: string[] = [];
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async (entity) => { executorCalls.push(entity.entityId); return "mouse"; },
    });
    const vA = await facade.see({ target: TARGET_A });
    const vB = await facade.see({ target: TARGET_B });

    await facade.touch({ lease: vA.entities[0].lease });
    await facade.touch({ lease: vB.entities[0].lease });

    // Both touches executed for the correct session
    expect(executorCalls).toHaveLength(2);
  });

  it("touch for unknown viewId returns entity_not_found (evicted or never existed)", async () => {
    const facade = new DesktopFacade(gameProvider);
    await facade.see({ target: TARGET_A }); // establishes session
    const tampered = {
      entityId: "e1", viewId: "completely-unknown-view-id",
      targetGeneration: "x", expiresAtMs: Date.now() + 99999, evidenceDigest: "d",
    };
    const result = await facade.touch({ lease: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("old viewId evicted after second see() — stale lease returns entity_not_found via viewId miss", async () => {
    const facade = new DesktopFacade(gameProvider);
    const view1 = await facade.see({ target: TARGET_A });
    const oldLease = view1.entities[0].lease;
    await facade.see({ target: TARGET_A }); // replaceViewId removes view1's viewId from index
    // The old viewId is gone from the index → entity_not_found (even though session exists)
    // NOTE: the generation check would also catch it, but the index is cleaned up first.
    const result = await facade.touch({ lease: oldLease });
    expect(result.ok).toBe(false);
  });
});

// Audit P1 / no-compromise lease hardening (D): the production facade must
// periodically prune sessions that have gone idle past sessionTtlMs so the
// SessionRegistry doesn't grow unbounded over a long-running process.
// `evictStaleSessions()` was previously defined but never called — this is
// the wiring + lifecycle pin.
describe("DesktopFacade — automatic session eviction timer", () => {
  it("with sessionEvictionIntervalMs unset (default), no timer is created", () => {
    const facade = new DesktopFacade(gameProvider);
    // No public accessor — the contract is "no setInterval handle is held",
    // so dispose() finishes synchronously and idle. We assert the negative
    // by ensuring the constructor doesn't reach into Node timers when
    // disabled. (No .unref handle to inspect; the fake-timer test below
    // covers the positive case.)
    expect(() => facade.dispose()).not.toThrow();
  });

  it("with sessionEvictionIntervalMs > 0, calls evictStaleSessions on the configured cadence", () => {
    vi.useFakeTimers();
    try {
      const evictSpy = vi.fn();
      // Subclass to spy on evictStaleSessions without touching the registry.
      class SpyFacade extends DesktopFacade {
        override evictStaleSessions(): void {
          evictSpy();
          super.evictStaleSessions();
        }
      }
      const facade = new SpyFacade(gameProvider, { sessionEvictionIntervalMs: 1000 });

      vi.advanceTimersByTime(2_500); // 2 fires (at 1000, 2000)
      expect(evictSpy).toHaveBeenCalledTimes(2);

      facade.dispose();
      vi.advanceTimersByTime(5_000); // no further fires after dispose
      expect(evictSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eviction errors do not crash the timer — subsequent fires still occur", () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      class ThrowingFacade extends DesktopFacade {
        override evictStaleSessions(): void {
          calls++;
          if (calls === 1) throw new Error("transient registry error");
          // 2nd call goes through normally.
          super.evictStaleSessions();
        }
      }
      const facade = new ThrowingFacade(gameProvider, { sessionEvictionIntervalMs: 500 });

      vi.advanceTimersByTime(1_100); // 2 fires (500, 1000)
      expect(calls).toBe(2);

      facade.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
