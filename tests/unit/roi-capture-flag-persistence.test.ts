import { describe, it, expect } from "vitest";
import { DesktopFacade, type CandidateIngress } from "../../src/tools/desktop.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import type { ProviderResult } from "../../src/engine/world-graph/candidate-ingress.js";

// ADR-024 Seed-2 S2 — the visual-only flag (SessionState.lastDiscoverVisualOnly)
// is written by see() from the discover snapshot and read by the desktop_act
// wrapper via resolveVisualOnlyForViewId(). This pins the write→read contract
// (sub-plan §2 S2 acceptance ⑤). Visual-only = UIA-blind warning AND no
// structured (terminal/cdp) candidate source (Codex PR #425 P2), so we drive
// the flag through both warnings and candidate sources.

function cand(label: string, source: UiEntityCandidate["source"] = "ocr"): UiEntityCandidate {
  return {
    source,
    target: { kind: "window", id: "win-1" },
    label,
    role: "label",
    actionability: ["click"],
    confidence: 0.8,
    observedAtMs: 1000,
    provisional: false,
    digest: `digest-${label}-${source}`,
    rect: { x: 10, y: 20, width: 80, height: 30 },
  };
}

interface Snapshot { candidates: UiEntityCandidate[]; warnings: string[] }

/** Minimal ingress that returns a snapshot (candidates + warnings) so we control
 *  both the discover `warnings` and candidate sources the facade derives the flag
 *  from. The snapshot is read live on each getSnapshot, so a test can mutate it to
 *  simulate a regime change across two discovers on the same session. */
function mutableIngress(ref: { current: Snapshot }): CandidateIngress {
  return {
    getSnapshot: async (): Promise<ProviderResult> => ({ ...ref.current }),
    invalidate: () => {},
    subscribe: () => () => {},
    dispose: () => {},
  };
}

const discover = async (facade: DesktopFacade): Promise<string> => {
  const out = await facade.see({ target: { windowTitle: "Canvas" } });
  return out.entities[0].lease.viewId;
};

const facadeWith = (warnings: string[], candidates: UiEntityCandidate[] = [cand("Foo")]): DesktopFacade =>
  new DesktopFacade(() => [], { ingress: mutableIngress({ current: { candidates, warnings } }) });

describe("ADR-024 Seed-2 — visual-only flag persistence (discover → act)", () => {
  it("sets the flag when discover reports a UIA-blind warning (single-giant-pane)", async () => {
    const facade = facadeWith(["uia_blind_single_pane"]);
    expect(facade.resolveVisualOnlyForViewId(await discover(facade))).toBe(true);
  });

  it("sets the flag for the too-few-elements blind reason", async () => {
    const facade = facadeWith(["uia_blind_too_few_elements"]);
    expect(facade.resolveVisualOnlyForViewId(await discover(facade))).toBe(true);
  });

  it("leaves the flag false when discover has no blind warning (structured target)", async () => {
    const facade = facadeWith([]);
    expect(facade.resolveVisualOnlyForViewId(await discover(facade))).toBe(false);
  });

  it("ignores unrelated warnings (e.g. visual_provider_unavailable) — flag stays false", async () => {
    const facade = facadeWith(["visual_provider_unavailable"]);
    expect(facade.resolveVisualOnlyForViewId(await discover(facade))).toBe(false);
  });

  it("does NOT set the flag for a terminal target even when UIA looks blind (structured buffer; Codex #425 P2)", async () => {
    // The terminal route runs UIA additively, so a terminal can surface uia_blind_*
    // warnings — but the terminal buffer is structured, so roiCapture must be suppressed.
    const facade = facadeWith(["uia_blind_single_pane"], [cand("$ npm test", "terminal")]);
    expect(facade.resolveVisualOnlyForViewId(await discover(facade))).toBe(false);
  });

  it("does NOT set the flag when a cdp candidate is present even with a blind warning", async () => {
    const facade = facadeWith(["uia_blind_single_pane"], [cand("Search", "cdp")]);
    expect(facade.resolveVisualOnlyForViewId(await discover(facade))).toBe(false);
  });

  it("returns false (safe default) for an unknown viewId — no session / no discover", () => {
    const facade = new DesktopFacade(() => []);
    expect(facade.resolveVisualOnlyForViewId("never-issued-view-id")).toBe(false);
  });

  it("re-evaluates the flag on each discover (blind → structured flips it back to false)", async () => {
    const ref = { current: { candidates: [cand("Foo")], warnings: ["uia_blind_single_pane"] } };
    const facade = new DesktopFacade(() => [], { ingress: mutableIngress(ref) });
    const v1 = await discover(facade);
    expect(facade.resolveVisualOnlyForViewId(v1)).toBe(true);
    // Same target → same session key; the next discover updates the same session.
    ref.current = { candidates: [cand("Foo")], warnings: [] };
    const v2 = await discover(facade);
    expect(facade.resolveVisualOnlyForViewId(v2)).toBe(false);
  });
});

// ADR-024 Seed-2 S5c-1a — the visual-only frame-diff motion verdict
// (verifyLocalRepaint) needs a focal `hint.point` so a small localized repaint
// is not diluted across the whole window (→ false `indeterminate`). The act
// wrapper uses the clicked entity's screen-absolute centre, resolved from the
// discover snapshot by lease (viewId + entityId).
describe("ADR-024 Seed-2 S5c-1a — resolveEntityCenterForViewId (frame-diff focal point)", () => {
  const discoverEntity = async (facade: DesktopFacade) => {
    const out = await facade.see({ target: { windowTitle: "Canvas" } });
    return out.entities[0];
  };

  it("returns the screen-absolute centre of the clicked entity's rect", async () => {
    // cand("Foo") rect = { x: 10, y: 20, width: 80, height: 30 } → centre (50, 35).
    const facade = facadeWith(["uia_blind_single_pane"]);
    const ent = await discoverEntity(facade);
    expect(facade.resolveEntityCenterForViewId(ent.lease.viewId, ent.entityId)).toEqual({
      x: 50,
      y: 35,
    });
  });

  it("returns null for an unknown viewId (no session)", () => {
    const facade = new DesktopFacade(() => []);
    expect(facade.resolveEntityCenterForViewId("never-issued-view-id", "ent-x")).toBeNull();
  });

  it("returns null for an unknown entityId within a known view", async () => {
    const facade = facadeWith(["uia_blind_single_pane"]);
    const ent = await discoverEntity(facade);
    expect(facade.resolveEntityCenterForViewId(ent.lease.viewId, "ent-does-not-exist")).toBeNull();
  });
});

// ADR-024 Seed-2 S5b — facade fold accessors (read at act time on the discover
// session). `resolveOcrTargetIdForViewId` MUST mirror the discover OCR lane's id
// formula (`ocr-provider.ts`: `target.hwnd ?? target.windowTitle ?? "@active"`)
// so the fold's carry-forward candidates key to the SAME entityId (R1). This is
// the facade half of the @active parity pin (the resolver half is in
// roi-preview.test.ts). `discoverHasVisualGpuForViewId` is the D6 fold gate.
describe("ADR-024 Seed-2 S5b — resolveOcrTargetIdForViewId (@active parity)", () => {
  /** see() with an explicit target → its viewId. Each unique target keys its own
   *  session; the facade stores `lastTarget = input.target` verbatim. */
  const seeWith = async (facade: DesktopFacade, target: Record<string, string>): Promise<string> => {
    const out = await facade.see({ target });
    return out.entities[0].lease.viewId;
  };

  it("returns target.hwnd when the discover target pinned an HWND", async () => {
    const facade = facadeWith([]);
    expect(facade.resolveOcrTargetIdForViewId(await seeWith(facade, { hwnd: "0xABC" }))).toBe("0xABC");
  });

  it("returns target.windowTitle when only a title was given", async () => {
    const facade = facadeWith([]);
    expect(facade.resolveOcrTargetIdForViewId(await seeWith(facade, { windowTitle: "Canvas" }))).toBe("Canvas");
  });

  it("returns the '@active' literal when the target pinned neither hwnd nor title", async () => {
    // The exact fallback ocr-provider.ts keys on — both sides read the same
    // un-normalized lastTarget, so an @active discover and its fold agree (Codex
    // PR #438 P2 refute, pinned).
    const facade = facadeWith([]);
    expect(facade.resolveOcrTargetIdForViewId(await seeWith(facade, {}))).toBe("@active");
  });

  it("prefers hwnd over windowTitle when both are present (matches the `??` chain)", async () => {
    const facade = facadeWith([]);
    expect(
      facade.resolveOcrTargetIdForViewId(await seeWith(facade, { hwnd: "0xDEAD", windowTitle: "Canvas" })),
    ).toBe("0xDEAD");
  });

  it("returns null for an unknown viewId (no session → handler skips the fold)", () => {
    expect(new DesktopFacade(() => []).resolveOcrTargetIdForViewId("never-issued-view-id")).toBeNull();
  });
});

describe("ADR-024 Seed-2 S5b — discoverHasVisualGpuForViewId (D6 fold gate)", () => {
  it("is true when the discover snapshot produced a visual_gpu entity (fold disabled → S5 2-OCR)", async () => {
    const facade = facadeWith(["uia_blind_single_pane"], [cand("Icon", "visual_gpu")]);
    expect(facade.discoverHasVisualGpuForViewId(await discover(facade))).toBe(true);
  });

  it("is false for an OCR-only discover (the fold-eligible visual-only target)", async () => {
    const facade = facadeWith(["uia_blind_single_pane"], [cand("TARGET ALPHA", "ocr")]);
    expect(facade.discoverHasVisualGpuForViewId(await discover(facade))).toBe(false);
  });

  it("returns false (safe default) for an unknown viewId", () => {
    expect(new DesktopFacade(() => []).discoverHasVisualGpuForViewId("never-issued-view-id")).toBe(false);
  });
});
