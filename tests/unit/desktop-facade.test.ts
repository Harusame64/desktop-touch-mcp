import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Several facades below are built WITHOUT an `executorFn`, so a touch that
// reaches the executor uses the production dep bundle — whose mouse route moves
// the real pointer (`engine/cursor.ts`, which does NOT go through
// `engine/nutjs.js`) and clicks the real screen. The candidate rect here is
// `{x:10,y:20,w:80,h:30}`, whose centre is (50,35): the top-left of the primary
// monitor, i.e. the desktop's first icon. Measured with a cursor probe during a
// full unit run before this stub was added.
vi.mock("../../src/engine/cursor.js", () => ({
  moveCursorTo: vi.fn(async () => undefined),
}));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    click: vi.fn(async () => undefined),
    doubleClick: vi.fn(async () => undefined),
    pressButton: vi.fn(async () => undefined),
    releaseButton: vi.fn(async () => undefined),
    scrollDown: vi.fn(async () => undefined),
    scrollUp: vi.fn(async () => undefined),
    scrollLeft: vi.fn(async () => undefined),
    scrollRight: vi.fn(async () => undefined),
    setPosition: vi.fn(async () => undefined),
    getPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  },
  keyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
  rawKeyboard: { pressKeyDown: vi.fn(), pressKeyUp: vi.fn() },
  withKeyboardLock: (fn: () => Promise<unknown>) => fn(),
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
}));
import { DesktopFacade, type CandidateProvider, type CandidateIngress } from "../../src/tools/desktop.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import {
  updateUiaCache,
  clearLayers,
  clearUiaCache,
  UIA_CACHE_TTL_EXPORTED_MS,
} from "../../src/engine/layer-buffer.js";

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
  // in the session's live snapshot has sources:["uia"] and controlType "Window" (internal #126;
  // it was role:"unknown" before, which is every control outside sixteen types).
  // No isModalBlocking override needed — the default is production-grade.

  it("modal_blocking when a UIA Window co-exists with the touch target", async () => {
    const modalCand: UiEntityCandidate = {
      source: "uia",
      target: { kind: "window", id: "win-1" },
      label: "Dialog",
      role: "unknown",
      controlType: "Window",   // ← triggers modal guard
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

  it("no modal_blocking from a NumericUpDown's Spinner — role:'unknown', not a Window (internal #126)", async () => {
    // win2 measured this exact refusal on a window with no modal at all: `{ok:false,
    // reason:"modal_blocking", blockingElement:{name:"Spinner",role:"unknown"}}` (`8954558`).
    const spinner: UiEntityCandidate = {
      source: "uia",
      target: { kind: "window", id: "win-1" },
      label: "Spinner",
      role: "unknown",
      controlType: "Spinner",
      actionability: [],
      confidence: 0.9,
      observedAtMs: 1000,
      provisional: false,
      digest: "digest-spinner",
    };
    const facade = new DesktopFacade(() => [cand("Start Match", "visual_gpu"), spinner], { executorFn: async () => "mouse" });
    const view = await facade.see({ target: TARGET_GAME });
    const btnLease = view.entities.find((e) => e.label === "Start Match")?.lease;
    expect(btnLease).toBeDefined();
    const result = await facade.touch({ lease: btnLease! });
    expect(result.ok).toBe(true);
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
      controlType: "Window",
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
      controlType: "Window",
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
  it("entity_outside_viewport when checkViewport blocks", async () => {
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      checkViewport: () => "entity_outside_viewport", // simulate entity outside window
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_outside_viewport");
  });

  // ADR-029 Phase 1: minimised / cloaked origin window gets its own reason so the
  // recovery advice can point at focus_window instead of scroll / re-discover.
  it("origin_window_not_visible when checkViewport reports a hidden origin window", async () => {
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      checkViewport: () => "origin_window_not_visible",
    });
    const view = await facade.see({ target: TARGET_GAME });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("origin_window_not_visible");
  });

  it("touch proceeds when checkViewport clears", async () => {
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async () => "mouse",
      checkViewport: () => null,
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

  it("action view with few entities keeps TTL at base 15s", async () => {
    const facade = new DesktopFacade(gameProvider, { nowFn: () => 0 });
    const view = await facade.see({ view: "action" });
    // base 15000 + no view bonus + no entity bonus (2 entities)
    expect(view.entities[0].lease.expiresAtMs).toBe(15_000);
  });

  it("explore view with 50 entities adds meaningful TTL bonus", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 60 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => 0 });
    const view = await facade.see({ view: "explore" }); // 50 entities after maxEntities slice
    // 15000 base + 5000 explore + (50-20)*100 entityBonus + payloadBonus
    // (no-compromise A: payload-size aware). Estimate:
    //   estimatedPayloadBytes = 500 + 50*250 + 0*180 + 0 warnings = 13_000
    //   payloadBonus = (13_000 - 2_000) * 0.5 = 5_500
    // total = 15000 + 5000 + 3000 + 5500 = 28_500
    expect(view.entities[0].lease.expiresAtMs).toBe(28_500);
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

  it("stale lease safety: expired lease rejected even at high TTL (past 40s clock)", async () => {
    let now = 0;
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 80 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => now });
    const view = await facade.see({ view: "explore" });
    const lease = view.entities[0].lease;
    // Push clock past the lease expiry (high-TTL explore lease still well under the 60s cap)
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
    const view = await facade.see({ view: "explore" }); // policy would give 20s, but override wins
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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #295 carry-over — `desktop_discover` UIA-cache-stale → attention
// ─────────────────────────────────────────────────────────────────────────────
//
// PR #299 added the stale signal to `desktop_state.attention` only. This carry-over
// extends the same freshness contract to `desktop_discover` so the LLM receives a
// consistent signal regardless of which observation tool it used. The facade
// reads `isUiaCacheStale(hwnd)` for the resolved target HWND and surfaces
// `attention: 'stale'` when fully expired; otherwise `'ok'`. When no HWND can be
// resolved the field is OMITTED (not synthesised to 'ok') — absent reads as "no
// signal", not "fresh".

describe("DesktopFacade — observed or remembered (ADR-036 item 8, internal #150)", () => {
  // The defect this answers, measured on real hardware: a window hung for 90 s answered in 4 ms
  // with six entities and a fresh generation, and no lane had run. The neighbours a caller could
  // compare against (`screenshot(detail='text')`, `workspace_snapshot`) were slow and empty, which
  // at least gives a reason to doubt them. This one is fast and full.
  //
  // **The clock here is the system clock, faked.** `ageMs` is `Date.now()` minus the ingress's own
  // `Date.now()` stamp, deliberately: ageing against an injected `nowFn` subtracts two unrelated
  // numbers (gate 2, 2026-09-22).

  function ingressSaying(freshness: unknown): CandidateIngress {
    return {
      getSnapshot: async () => ({ candidates: [], warnings: [], ...(freshness as object) }),
      invalidate: () => {},
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_500);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries the ingress's `cache`, and ages it against the reply rather than re-dating it", async () => {
    const facade = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: { from: "cache", observedAtMs: 1_000 } }),
    });
    const out = await facade.see({});
    expect(out.freshness.from).toBe("cache");
    expect(out.freshness.observedAtMs).toBe(1_000);
    expect(out.freshness.ageMs).toBe(4_500);
  });

  it("says `read` on the road that has no cache to serve from", async () => {
    // No ingress: `see()` calls the provider on every call, so this is the one road that can say
    // "read" without being told.
    const facade = new DesktopFacade(() => []);
    const out = await facade.see({});
    expect(out.freshness).toEqual({ from: "read", observedAtMs: 5_500, ageMs: 0 });
  });

  it("dates a direct read to when it STARTED, not when it came back", async () => {
    // The shipped description says `observedAtMs` is when the read that produced the entities
    // started — which is what the ingress stamps (it takes `now` before awaiting `fetchFn`).
    // Inside the object literal, `Date.now()` runs after the provider's await resolves, so this
    // road alone would have dated the reply to the END of its own read and reported `ageMs: 0`
    // for a read that took a second. Caught on a re-read of the sentence against the code.
    const facade = new DesktopFacade(() => {
      vi.setSystemTime(6_500);          // the provider takes a second
      return [];
    });
    const out = await facade.see({});
    expect(out.freshness.observedAtMs, "dated to the end of its own read").toBe(5_500);
    expect(out.freshness.ageMs, "a read that took a second reported as instant").toBe(1_000);
  });

  it("says `unavailable` — never `read` — when the ingress says nothing", async () => {
    // **The default lands on the not-read side.** An ingress that carries no freshness (an older
    // implementation, a test double) must not have its silence reported as a fresh read: "could
    // not tell" and "looked just now" are the two answers this field exists to separate (win2's
    // rule, 2026-09-22 — a kind nobody handled falls into the default branch, so the default has
    // to be the unreadable one).
    const facade = new DesktopFacade(() => [], { ingress: ingressSaying({}) });
    const out = await facade.see({});
    expect(out.freshness).toEqual({ from: "unavailable" });
    expect(out.freshness.ageMs).toBeUndefined();
  });

  it("keeps `staleCache` distinct from both a read and a plain cache hit", async () => {
    const facade = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: { from: "staleCache", observedAtMs: 2_000 } }),
    });
    const out = await facade.see({});
    expect(out.freshness).toEqual({ from: "staleCache", observedAtMs: 2_000, ageMs: 3_500 });
  });

  it("does not pass through a value this build does not know", async () => {
    // The ingress is an exported, injectable interface: what comes back is runtime input, not a
    // compile-time guarantee (gate 2, 2026-09-22). A newer ingress inventing `predicted` must not
    // have it forwarded to a caller that has no rule for it.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: { from: "predicted", observedAtMs: 1_000 } }),
    });
    expect((await facade.see({})).freshness).toEqual({ from: "unavailable" });
  });

  it("survives an ingress that answers `null`, which the line it replaced handled", async () => {
    // **The hardening's own hole** (gate 2, 2026-09-22). `rawResult.freshness ?? {…}` caught `null`
    // as well as `undefined`; a reader that guarded only `undefined` threw
    // `TypeError: Cannot read properties of null` out of `see()` and failed the whole call — for
    // an injected ingress, or for any result that has been through a JSON round trip where an
    // absent field came back as `null`. Failing closed on the one input nobody thought of is worse
    // than the line it replaced.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: null }),
    });
    expect((await facade.see({})).freshness).toEqual({ from: "unavailable" });
  });

  it("does not pass through an observation it cannot date", async () => {
    // `{from:"cache"}` with no date reached the wire exactly as written before this: a caller
    // reading `ageMs` to decide whether to trust the positions got nothing to read, from a field
    // whose whole job is to be read.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: { from: "cache" } }),
    });
    expect((await facade.see({})).freshness).toEqual({ from: "unavailable" });
  });

  it("ages against the system clock even when an embedder injects `nowFn`", async () => {
    // `observedAtMs` is stamped by the ingress with `Date.now()`. Ageing it against `nowFn` would
    // subtract two unrelated numbers, and this repo already passes clocks like
    // `() => performance.now()` elsewhere — the reply would then carry a plausible age computed
    // from a monotonic counter, and on the direct road an `observedAtMs` that is not an epoch
    // timestamp at all (gate 2, 2026-09-22).
    const injected = 1_000_000_000;
    const cached = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: { from: "cache", observedAtMs: 1_000 } }),
      nowFn: () => injected,
    });
    expect((await cached.see({})).freshness.ageMs, "aged against the injected clock").toBe(4_500);

    const direct = new DesktopFacade(() => [], { nowFn: () => injected });
    expect(
      (await direct.see({})).freshness.observedAtMs,
      "the direct road stamped the injected clock, which may not be an epoch time",
    ).toBe(5_500);
  });

  it("drops `ageMs` rather than clamping a negative difference to zero", async () => {
    // A backwards clock step between the ingress's stamp and the reply makes the difference
    // negative. `Math.max(0, …)` turned that into the FRESHEST possible answer for an entry that
    // may be 29 s old (gate 2, 2026-09-22) — this change's own rule, broken in one line.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressSaying({ freshness: { from: "cache", observedAtMs: 9_000 } }),
    });
    const out = await facade.see({});
    expect(out.freshness.from).toBe("cache");
    expect(out.freshness.observedAtMs).toBe(9_000);
    expect(out.freshness.ageMs, "a negative age was reported as fresh").toBeUndefined();
  });

  it("disagrees with `attention`, which is about the UIA cache's TTL", async () => {
    // **CONTROL, and it has been wrong twice.** The first version built the facade with no
    // `getFocusedHwnd`, so `attention` was absent whatever this change did. The second wrote the
    // UIA cache entry under the REAL clock and only then set the fake one, so the entry read as
    // written 56 years in the future rather than "fresh at half the TTL" — the cell passed for a
    // reason its own comment did not name (gate 2, 2026-09-22). The clock is set first now.
    //
    // Measured on real hardware the same day: four arms, `attention` `'ok'` in every one —
    // including the hung window and the one whose read threw — while this field said `cache`,
    // `cache`, `read`, `read`.
    const HWND = 0xBEEF10n;
    vi.setSystemTime(0);
    clearUiaCache();
    updateUiaCache(HWND, "<UIA tree>");
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS / 2);          // the UIA cache is FRESH…
    try {
      const facade = new DesktopFacade(() => [], {
        ingress: ingressSaying({ freshness: { from: "cache", observedAtMs: 10 } }),
        getFocusedHwnd: () => HWND,
      });
      const out = await facade.see({ target: { windowTitle: "GameWindow" } });
      expect(out.attention, "attention is not being answered at all").toBe("ok");
      expect(out.freshness.from, "…while the entities were remembered, not read").toBe("cache");
    } finally {
      clearUiaCache();
    }
  });
});

describe("DesktopFacade — the ingress's answer is runtime input (internal #161)", () => {
  // `CandidateIngress` is exported and injectable, and so is the direct `CandidateProvider`: an
  // embedder's implementation, or a result that has been through a JSON round trip where an empty
  // array came back as `null`, is ordinary input. Measured on the #710 branch before this: an
  // ingress answering `warnings: null` threw at `rawResult.warnings.some(...)`, and
  // `candidates: null` at `rawResult.candidates.length`, and either failed the whole call.
  //
  // The rule is #150's, applied to the rest of the result: **what cannot be recognised is not a
  // read.** A missing candidate list is not "the window is empty" — that would hand a caller
  // `entities: []` with nothing to doubt — so it says `ingress_fetch_error`, whose advice is to
  // retry, and its freshness is `unavailable`.

  function ingressAnswering(result: unknown): CandidateIngress {
    return {
      getSnapshot: async () => result as never,
      invalidate: () => {},
      subscribe: () => () => {},
      dispose: () => {},
    };
  }
  const READ = { from: "read", observedAtMs: 1_000 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_500);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("CONTROL: a well-formed answer goes out untouched, with no warning added", async () => {
    // Without this, a normaliser that always adds the warning, or always drops the freshness,
    // would pass every cell below.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({ candidates: [cand("OK", "uia")], warnings: [], freshness: READ }),
    });
    const out = await facade.see({});
    expect(out.entities.map((e) => e.label)).toEqual(["OK"]);
    expect(out.warnings).toBeUndefined();
    expect(out.constraints).toBeUndefined();
    expect(out.freshness).toEqual({ from: "read", observedAtMs: 1_000, ageMs: 4_500 });
  });

  it("reads `warnings: null` as no warnings, and keeps the read", async () => {
    // A missing diagnostic list says nothing about the candidates beside it.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({ candidates: [cand("OK", "uia")], warnings: null, freshness: READ }),
    });
    const out = await facade.see({});
    expect(out.entities.map((e) => e.label)).toEqual(["OK"]);
    expect(out.warnings).toBeUndefined();
    expect(out.freshness.from).toBe("read");
  });

  it("survives `warnings: null` on the debug view too, which reads them one line earlier", async () => {
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({ candidates: [cand("OK", "uia")], warnings: null, freshness: READ }),
    });
    const out = await facade.see({ view: "debug" });
    expect(out.entities.map((e) => e.label)).toEqual(["OK"]);
  });

  it("keeps only the strings of a warning list", async () => {
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({
        candidates: [cand("OK", "uia")],
        warnings: [null, "partial_results_only", 3, { w: 1 }],
        freshness: READ,
      }),
    });
    const out = await facade.see({ view: "debug" });
    expect(out.warnings).toEqual(["partial_results_only"]);
  });

  it("says `ingress_fetch_error` for `candidates: null`, not an empty window", async () => {
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({ candidates: null, warnings: [], freshness: READ }),
    });
    const out = await facade.see({});
    expect(out.entities).toEqual([]);
    expect(out.warnings).toEqual(["ingress_fetch_error"]);
    expect(out.constraints?.entityZeroReason).toBe("ingress_fetch_error");
    expect(out.freshness, "no list was read, whatever the freshness said").toEqual({ from: "unavailable" });
  });

  it("says the same for an answer that is not an object at all", async () => {
    for (const answer of [null, undefined, "ok", 0]) {
      const facade = new DesktopFacade(() => [], { ingress: ingressAnswering(answer) });
      const out = await facade.see({});
      expect(out.entities, String(answer)).toEqual([]);
      expect(out.warnings, String(answer)).toEqual(["ingress_fetch_error"]);
      expect(out.freshness, String(answer)).toEqual({ from: "unavailable" });
    }
  });

  it("drops a candidate that is not an object, keeps the rest, and says the list was damaged", async () => {
    // The kept candidates were read, so the freshness stands; the warning is what tells a caller
    // the list is not the whole answer.
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({ candidates: [null, cand("OK", "uia"), 7], warnings: [], freshness: READ }),
    });
    const out = await facade.see({});
    expect(out.entities.map((e) => e.label)).toEqual(["OK"]);
    expect(out.warnings).toEqual(["ingress_fetch_error"]);
    expect(out.freshness.from).toBe("read");
  });

  it("does not repeat `ingress_fetch_error` when the ingress already said it", async () => {
    const facade = new DesktopFacade(() => [], {
      ingress: ingressAnswering({ candidates: null, warnings: ["ingress_fetch_error"], freshness: READ }),
    });
    expect((await facade.see({})).warnings).toEqual(["ingress_fetch_error"]);
  });

  it("applies the same rule to the direct provider road", async () => {
    // The other injectable input: `CandidateProvider` is typed to return an array and is just as
    // much runtime input as the ingress.
    const facade = new DesktopFacade((() => null) as unknown as CandidateProvider);
    const out = await facade.see({});
    expect(out.entities).toEqual([]);
    expect(out.warnings).toEqual(["ingress_fetch_error"]);
    expect(out.freshness).toEqual({ from: "unavailable" });
  });
});

describe("DesktopFacade — UIA-cache-stale → attention (#295 carry-over)", () => {
  // The cache TTL is module-scoped state in layer-buffer.ts. Each test pins time
  // deterministically and clears both the WindowLayer map AND the UIA cache so
  // cross-test bleed cannot mask a real regression. Opus PR #302 P2 #4:
  // `clearLayers()` only resets the `layers` Map; the independent `uiaCache`
  // Map (layer-buffer.ts:308) needs the dedicated `clearUiaCache()` export.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clearLayers();
    clearUiaCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearLayers();
    clearUiaCache();
  });

  it("attention='stale' when target.hwnd resolves to a fully-expired UIA cache", async () => {
    const HWND = 0xBEEF01n;
    updateUiaCache(HWND, "<UIA tree>");
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS + 1);

    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: { hwnd: String(HWND) } });
    expect(out.attention).toBe("stale");
  });

  it("attention='ok' when target.hwnd resolves to a fresh UIA cache", async () => {
    const HWND = 0xBEEF02n;
    updateUiaCache(HWND, "<UIA tree>");
    // Half the TTL — well within fresh window.
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS / 2);

    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: { hwnd: String(HWND) } });
    expect(out.attention).toBe("ok");
  });

  it("attention omitted when no target.hwnd and no getFocusedHwnd wired", async () => {
    // Default facade construction (no getFocusedHwnd) — `desktop_discover` has
    // no HWND it can interrogate, so the field must be absent rather than a
    // synthesised 'ok'.
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: { windowTitle: "GameWindow" } });
    expect(out.attention).toBeUndefined();
  });

  it("getFocusedHwnd resolves the HWND when target.hwnd is absent (stale path)", async () => {
    const HWND = 0xBEEF03n;
    updateUiaCache(HWND, "<UIA tree>");
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS + 1);

    const facade = new DesktopFacade(gameProvider, { getFocusedHwnd: () => HWND });
    const out = await facade.see();
    expect(out.attention).toBe("stale");
  });

  it("target.hwnd takes precedence over getFocusedHwnd (focused stale, target fresh → 'ok')", async () => {
    // Opus PR #302 P2 #3 — the previous version of this test wrote both
    // HWNDs at time 0 and advanced to TTL/2, leaving both fresh; the
    // assertion would pass regardless of which HWND `resolveTargetHwnd`
    // chose. We stamp at the EXACT TTL boundary instead — the older entry
    // is then `age === TTL`, which `isUiaCacheStale` reports as stale
    // (boundary inclusive: `age >= TTL`) but `sweepUiaCache` does NOT evict
    // (strict `age > TTL` test inside the sweep loop). So the older entry
    // stays in the Map AND is observable as stale, which lets the
    // assertion actually distinguish which HWND the facade interrogated.
    const FOCUSED_HWND = 0xBEEF04n;
    const TARGET_HWND = 0xBEEF05n;
    updateUiaCache(FOCUSED_HWND, "<focused>"); // time 0
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS); // boundary
    updateUiaCache(TARGET_HWND, "<target>"); // fresh (age 0); FOCUSED kept (sweep is strict >)
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => FOCUSED_HWND,
    });
    const out = await facade.see({ target: { hwnd: String(TARGET_HWND) } });
    // If precedence broke and the facade interrogated FOCUSED instead, this
    // would be 'stale'. The 'ok' assertion proves target.hwnd wins.
    expect(out.attention).toBe("ok");
  });

  it("target.hwnd takes precedence over getFocusedHwnd (focused fresh, target stale → 'stale')", async () => {
    // Opus PR #302 P2 #3 — companion to the previous case. Swap the
    // freshness so the explicit target.hwnd is stale while the focused
    // HWND is fresh. `attention === 'stale'` proves precedence the other
    // direction (facade reports on the entity the caller pinned, not the
    // foreground). Same TTL-boundary trick to dodge the sweep.
    const FOCUSED_HWND = 0xBEEF06n;
    const TARGET_HWND = 0xBEEF07n;
    updateUiaCache(TARGET_HWND, "<target>"); // time 0
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS); // boundary
    updateUiaCache(FOCUSED_HWND, "<focused>"); // fresh (age 0); TARGET kept
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => FOCUSED_HWND,
    });
    const out = await facade.see({ target: { hwnd: String(TARGET_HWND) } });
    // If precedence broke and the facade interrogated FOCUSED, this would
    // be 'ok'. The 'stale' assertion proves target.hwnd wins.
    expect(out.attention).toBe("stale");
  });

  it("attention omitted when getFocusedHwnd returns null (no foreground)", async () => {
    // Production case: enumeration succeeded but no active window. We must
    // not surface a synthetic 'ok' because we genuinely have no signal.
    const facade = new DesktopFacade(gameProvider, { getFocusedHwnd: () => null });
    const out = await facade.see();
    expect(out.attention).toBeUndefined();
  });

  it("attention omitted when getFocusedHwnd throws (defensive)", async () => {
    // Production wiring calls into Win32; any throw must degrade to omitted
    // rather than crash see().
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => {
        throw new Error("Win32 boom");
      },
    });
    const out = await facade.see();
    expect(out.attention).toBeUndefined();
  });

  it("malformed target.hwnd string → attention omitted (no false 'ok')", async () => {
    // `BigInt("not-a-number")` throws — we treat that as "no HWND resolvable"
    // rather than swallowing into a synthetic 'ok'. Same reasoning as the
    // null / throw branches above.
    const facade = new DesktopFacade(gameProvider, { getFocusedHwnd: () => null });
    const out = await facade.see({ target: { hwnd: "not-a-bigint" } });
    expect(out.attention).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-019 Stage 5 — DesktopFacade.resolveHwndForViewId foreground fallback
// ─────────────────────────────────────────────────────────────────────────────
//
// PR #325 wired `desktop_act` to attach a `VisualMotionObservation` after a
// successful touch, but `tryVerifyAnyChange` only consulted
// `session.lastTarget.hwnd` and silently returned null for the typical
// `desktop_discover()` / `desktop_discover({ windowTitle })` flow that does
// not pin an HWND. These tests pin the foreground-fallback contract added in
// this PR: `resolveHwndForViewId` reuses the same precedence ladder
// (`target.hwnd` → `getFocusedHwnd()` → null) that `see()` consults for its
// Issue #295 stale check, so Stage 5 no longer goes dormant on the common
// flows.
describe("DesktopFacade — resolveHwndForViewId (Stage 5 foreground fallback)", () => {
  it("returns session.lastTarget.hwnd when explicitly pinned (foreground irrelevant)", async () => {
    const TARGET_HWND = 0xC0DE01n;
    const FOCUSED_HWND = 0xC0DE02n;
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => FOCUSED_HWND,
    });
    const out = await facade.see({ target: { hwnd: String(TARGET_HWND) } });
    expect(facade.resolveHwndForViewId(out.viewId)).toBe(TARGET_HWND);
  });

  it("falls back to getFocusedHwnd when lastTarget is windowTitle-only (no hwnd)", async () => {
    // This is the path PR #325 left dormant — the LLM passed a windowTitle
    // hint, lastTarget.hwnd is undefined, and Stage 5 silently produced no
    // observation. The foreground resolver now bridges that gap.
    const FOCUSED_HWND = 0xC0DE03n;
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => FOCUSED_HWND,
    });
    const out = await facade.see({ target: { windowTitle: "GameWindow" } });
    expect(facade.resolveHwndForViewId(out.viewId)).toBe(FOCUSED_HWND);
  });

  it("falls back to getFocusedHwnd when lastTarget is undefined (foreground see())", async () => {
    // The other dormant path — `desktop_discover()` with no arg. session.lastTarget
    // is undefined; without the fallback, Stage 5 never fired for this flow.
    const FOCUSED_HWND = 0xC0DE04n;
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => FOCUSED_HWND,
    });
    const out = await facade.see();
    expect(facade.resolveHwndForViewId(out.viewId)).toBe(FOCUSED_HWND);
  });

  it("returns null when neither lastTarget.hwnd nor getFocusedHwnd is available", async () => {
    // Same shape as `see()` returning attention: undefined — there is genuinely
    // no signal, so the Stage 5 wiring degrades silently to no observation.
    const facade = new DesktopFacade(gameProvider);
    const out = await facade.see({ target: { windowTitle: "GameWindow" } });
    expect(facade.resolveHwndForViewId(out.viewId)).toBeNull();
  });

  it("returns null when getFocusedHwnd returns null (no foreground)", async () => {
    const facade = new DesktopFacade(gameProvider, { getFocusedHwnd: () => null });
    const out = await facade.see();
    expect(facade.resolveHwndForViewId(out.viewId)).toBeNull();
  });

  it("returns null defensively when getFocusedHwnd throws", async () => {
    // Production wiring calls into Win32; any throw must degrade to null
    // (Stage 5 skips the verify) rather than crash desktop_act.
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => {
        throw new Error("Win32 boom");
      },
    });
    const out = await facade.see();
    expect(facade.resolveHwndForViewId(out.viewId)).toBeNull();
  });

  it("returns null for an unknown viewId (session evicted)", async () => {
    const facade = new DesktopFacade(gameProvider, { getFocusedHwnd: () => 0xC0DE05n });
    expect(facade.resolveHwndForViewId("nonexistent-view-id")).toBeNull();
  });

  it("malformed target.hwnd falls back to getFocusedHwnd and logs audit trail", async () => {
    // PR-SR4-4 Round 1 P2 — parse failure on a stale pinned hwnd must NOT
    // silently disable Stage 5 when a usable focused HWND is available
    // (that's exactly the dormancy class this PR claims to eliminate).
    // `resolveHwndForViewId` open-codes the (target.hwnd → focused) ladder
    // for this reason: `resolveTargetHwnd` short-circuits to null on parse
    // failure, which is the right behaviour for `see()`'s UIA-cache stale
    // check (it wants null so a malformed pinned hwnd does not silently
    // re-purpose the foreground window as a stale-check target) but the
    // wrong behaviour for Stage 5 dormancy avoidance.
    const FOCUSED_HWND = 0xC0DE06n;
    const facade = new DesktopFacade(gameProvider, {
      getFocusedHwnd: () => FOCUSED_HWND,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await facade.see({ target: { hwnd: "not-a-bigint" } });
      expect(facade.resolveHwndForViewId(out.viewId)).toBe(FOCUSED_HWND);
      // Audit trail: PR #325 Round 1 P3-2 (preserved through PR-SR4-4
      // Round 1 P2 even after the ladder open-coding) — a production race
      // where `lastTarget.hwnd` becomes malformed must still emit an
      // observable stderr line rather than silently degrading.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toMatch(/Stage 5/);
      expect(message).toMatch(/falling back to foreground resolver/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("malformed target.hwnd returns null when no foreground resolver is wired", async () => {
    // Mirror of the above: without `getFocusedHwnd` wired, the fall-through
    // has nowhere to land and Stage 5 honestly returns null. The audit log
    // still fires so the malformed-vs-absent distinction remains observable.
    const facade = new DesktopFacade(gameProvider);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await facade.see({ target: { hwnd: "not-a-bigint" } });
      expect(facade.resolveHwndForViewId(out.viewId)).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
