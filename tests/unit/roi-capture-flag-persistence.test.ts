import { describe, it, expect } from "vitest";
import { DesktopFacade, type CandidateIngress } from "../../src/tools/desktop.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import type { ProviderResult } from "../../src/engine/world-graph/candidate-ingress.js";

// ADR-024 Seed-2 S2 — the visual-only flag (SessionState.lastDiscoverVisualOnly)
// is written by see() from the discover warnings and read by the desktop_act
// wrapper via resolveVisualOnlyForViewId(). This pins the write→read contract
// (sub-plan §2 S2 acceptance ⑤). The flag must derive from the SAME predicate as
// the OCR lane (membership in UIA_BLIND_WARNINGS), so we drive it through warnings.

function cand(label: string): UiEntityCandidate {
  return {
    source: "ocr",
    target: { kind: "window", id: "win-1" },
    label,
    role: "label",
    actionability: ["click"],
    confidence: 0.8,
    observedAtMs: 1000,
    provisional: false,
    digest: `digest-${label}`,
    rect: { x: 10, y: 20, width: 80, height: 30 },
  };
}

/** Minimal ingress that returns a snapshot (candidates + warnings) so we control
 *  the discover `warnings` the facade derives the flag from. `warnings` is read
 *  live on each getSnapshot, so a test can mutate it to simulate a regime change
 *  across two discovers on the same session. */
function mutableIngress(warningsRef: { current: string[] }): CandidateIngress {
  return {
    getSnapshot: async (): Promise<ProviderResult> => ({ candidates: [cand("Foo")], warnings: warningsRef.current }),
    invalidate: () => {},
    subscribe: () => () => {},
    dispose: () => {},
  };
}

const discover = async (facade: DesktopFacade): Promise<string> => {
  const out = await facade.see({ target: { windowTitle: "Canvas" } });
  return out.entities[0].lease.viewId;
};

const facadeWith = (warnings: string[]): DesktopFacade =>
  new DesktopFacade(() => [], { ingress: mutableIngress({ current: warnings }) });

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

  it("returns false (safe default) for an unknown viewId — no session / no discover", () => {
    const facade = new DesktopFacade(() => []);
    expect(facade.resolveVisualOnlyForViewId("never-issued-view-id")).toBe(false);
  });

  it("re-evaluates the flag on each discover (blind → structured flips it back to false)", async () => {
    const ref = { current: ["uia_blind_single_pane"] };
    const facade = new DesktopFacade(() => [], { ingress: mutableIngress(ref) });
    const v1 = await discover(facade);
    expect(facade.resolveVisualOnlyForViewId(v1)).toBe(true);
    // Same target → same session key; the next discover updates the same session.
    ref.current = [];
    const v2 = await discover(facade);
    expect(facade.resolveVisualOnlyForViewId(v2)).toBe(false);
  });
});
