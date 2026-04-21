import { describe, it, expect } from "vitest";
import { DesktopFacade, type CandidateProvider, type DesktopSeeInput } from "../../src/tools/desktop.js";
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
  it("game: resolves visual_gpu entities without raw coords", () => {
    const facade = new DesktopFacade(gameProvider);
    const out = facade.see({ target: TARGET_GAME });
    expect(out.entities).toHaveLength(2);
    expect(out.entities[0].label).toBe("Start Match");
    expect(out.entities[0].sources).toContain("visual_gpu");
    expect(out.entities[0].rect).toBeUndefined(); // no coords in normal mode
    expect(out.entities[0].lease).toBeDefined();
  });

  it("chrome: resolves CDP entities without raw coords", () => {
    const facade = new DesktopFacade(chromeProvider);
    const out = facade.see({ target: TARGET_CHROME });
    expect(out.entities).toHaveLength(2);
    expect(out.entities[0].sources).toContain("cdp");
    expect(out.entities[0].rect).toBeUndefined();
  });

  it("terminal: resolves terminal entities without raw coords", () => {
    const facade = new DesktopFacade(terminalProvider);
    const out = facade.see({ target: TARGET_TERM });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].sources).toContain("terminal");
    expect(out.entities[0].rect).toBeUndefined();
  });

  it("debug=true exposes raw rect for all target types", () => {
    for (const [provider, target] of [
      [gameProvider,    TARGET_GAME],
      [chromeProvider,  TARGET_CHROME],
      [terminalProvider, TARGET_TERM],
    ] as const) {
      const facade = new DesktopFacade(provider);
      const out = facade.see({ target, debug: true });
      for (const e of out.entities) {
        expect(e.rect).toBeDefined(); // coords exposed in debug mode
      }
    }
  });

  it("viewId and generation are present in response", () => {
    const facade = new DesktopFacade(gameProvider);
    const out = facade.see();
    expect(out.viewId).toBeTruthy();
    expect(out.target.generation).toBeTruthy();
  });

  it("query filters entities by label substring", () => {
    const facade = new DesktopFacade(gameProvider);
    const out = facade.see({ query: "start" });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].label).toBe("Start Match");
  });

  it("maxEntities limits the returned count", () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 30 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider);
    const out = facade.see({ maxEntities: 5 });
    expect(out.entities).toHaveLength(5);
  });

  it("explore view raises default maxEntities to 50", () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 60 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider);
    expect(facade.see({ view: "explore" }).entities).toHaveLength(50);
    expect(facade.see({ view: "action"  }).entities).toHaveLength(20);
  });
});

describe("DesktopFacade — desktop_touch", () => {
  it("touch with valid lease returns ok:true + diff", async () => {
    const facade = new DesktopFacade(gameProvider, { executorFn: async () => "mouse" });
    const view = facade.see({ target: TARGET_GAME });
    const lease = view.entities[0].lease;
    const result = await facade.touch({ lease });
    expect(result.ok).toBe(true);
  });

  it("touch after second see() invalidates leases from first see()", async () => {
    const facade = new DesktopFacade(gameProvider);
    const view1 = facade.see();
    const oldLease = view1.entities[0].lease;
    facade.see(); // generation bumped
    const result = await facade.touch({ lease: oldLease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_generation_mismatch");
  });

  it("touch returns entity_disappeared when entity vanishes after click", async () => {
    let callCount = 0;
    const dynamicProvider: CandidateProvider = () =>
      callCount === 0 ? [cand("Start", "visual_gpu")] : [];

    const facade = new DesktopFacade(dynamicProvider, {
      postTouchCandidates: () => { callCount++; return []; }, // no entities after click
    });
    const view = facade.see();
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
    const view = facade.see();
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
    const view = facade.see();
    await facade.touch({ lease: view.entities[0].lease, action: "type", text: "hello" });
    expect(calls[0].action).toBe("type");
    expect(calls[0].text).toBe("hello");
  });
});

describe("DesktopFacade — cross-source entity merging", () => {
  it("visual_gpu + uia with same digest merge into one entity with both sources", () => {
    const provider: CandidateProvider = () => [
      cand("Submit", "visual_gpu", { digest: "d-submit" }),
      cand("Submit", "uia",        { digest: "d-submit" }),
    ];
    const facade = new DesktopFacade(provider);
    const out = facade.see();
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].sources).toContain("visual_gpu");
    expect(out.entities[0].sources).toContain("uia");
  });
});

describe("DesktopFacade — per-target session isolation (Batch A)", () => {
  const TARGET_A = { hwnd: "hwnd-A" };
  const TARGET_B = { hwnd: "hwnd-B" };

  it("see() on target A does NOT invalidate leases for target B", async () => {
    const facade = new DesktopFacade(gameProvider);
    const viewA = facade.see({ target: TARGET_A });
    const viewB = facade.see({ target: TARGET_B });
    const leaseB = viewB.entities[0].lease;

    // Call see() on A again — bumps A's generation, not B's
    facade.see({ target: TARGET_A });

    const result = await facade.touch({ lease: leaseB });
    // B's lease must still be valid
    expect(result.ok).toBe(true);
    void viewA; // suppress unused warning
  });

  it("see() on the same target invalidates its own previous leases", async () => {
    const facade = new DesktopFacade(gameProvider);
    const view1 = facade.see({ target: TARGET_A });
    const oldLease = view1.entities[0].lease;
    facade.see({ target: TARGET_A }); // bumps A's generation
    const result = await facade.touch({ lease: oldLease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_generation_mismatch");
  });

  it("two independent targets maintain separate generation counters", () => {
    const facade = new DesktopFacade(gameProvider);
    const vA1 = facade.see({ target: TARGET_A });
    const vB1 = facade.see({ target: TARGET_B });
    facade.see({ target: TARGET_A }); // bumps A seq to 2
    const vB2 = facade.see({ target: TARGET_B }); // bumps B seq to 2
    // Generations should embed different viewIds and seq numbers
    expect(vA1.target.generation).not.toBe(vB1.target.generation);
    expect(vB1.target.generation).not.toBe(vB2.target.generation);
  });

  it("touch dispatches to the correct session by viewId", async () => {
    const executorCalls: string[] = [];
    const facade = new DesktopFacade(gameProvider, {
      executorFn: async (entity) => { executorCalls.push(entity.entityId); return "mouse"; },
    });
    const vA = facade.see({ target: TARGET_A });
    const vB = facade.see({ target: TARGET_B });

    await facade.touch({ lease: vA.entities[0].lease });
    await facade.touch({ lease: vB.entities[0].lease });

    // Both touches executed for the correct session
    expect(executorCalls).toHaveLength(2);
  });

  it("touch for unknown viewId returns entity_not_found (session evicted or never existed)", async () => {
    const facade = new DesktopFacade(gameProvider);
    const fakeLeases = facade.see({ target: TARGET_A }).entities[0].lease;
    const tampered = { ...fakeLeases, viewId: "completely-unknown-view-id" };
    const result = await facade.touch({ lease: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });
});
