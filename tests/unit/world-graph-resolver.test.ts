import { describe, it, expect } from "vitest";
import { resolveCandidates } from "../../src/engine/world-graph/resolver.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const GEN = "gen-1";
const TARGET = { kind: "window" as const, id: "hwnd-1" };

function candidate(
  label: string,
  opts: Partial<UiEntityCandidate> = {}
): UiEntityCandidate {
  return {
    source: "visual_gpu",
    target: TARGET,
    label,
    role: "button",
    actionability: ["invoke", "click"],
    confidence: 0.9,
    observedAtMs: 1000,
    provisional: false,
    digest: `digest-${label}`,
    ...opts,
  };
}

describe("resolveCandidates — basic resolution", () => {
  it("returns empty array for empty input", () => {
    expect(resolveCandidates([], GEN)).toEqual([]);
  });

  it("produces one entity per unique candidate", () => {
    const entities = resolveCandidates([
      candidate("Start"),
      candidate("Quit"),
    ], GEN);
    expect(entities).toHaveLength(2);
  });

  it("entity fields are populated from candidate", () => {
    const [e] = resolveCandidates([candidate("Play", { confidence: 0.85 })], GEN);
    expect(e.label).toBe("Play");
    expect(e.confidence).toBe(0.85);
    expect(e.role).toBe("button");
    expect(e.generation).toBe(GEN);
    expect(e.entityId).toMatch(/^ent_/); // human-debuggable prefix
    expect(e.sources).toContain("visual_gpu");
  });

  it("evidenceDigest is always set (required for lease issuance)", () => {
    const [e] = resolveCandidates([candidate("Start")], GEN);
    expect(e.evidenceDigest).toBeTruthy();
    expect(e.entityId).toBe(`ent_${e.evidenceDigest}`);
  });

  it("entityId is stable across calls with the same digest", () => {
    const e1 = resolveCandidates([candidate("Start", { digest: "d-abc" })], GEN)[0];
    const e2 = resolveCandidates([candidate("Start", { digest: "d-abc" })], GEN)[0];
    expect(e1.entityId).toBe(e2.entityId);
  });

  it("different digests produce different entityIds", () => {
    const e1 = resolveCandidates([candidate("Start", { digest: "d-abc" })], GEN)[0];
    const e2 = resolveCandidates([candidate("Start", { digest: "d-xyz" })], GEN)[0];
    expect(e1.entityId).not.toBe(e2.entityId);
  });
});

describe("resolveCandidates — source merging", () => {
  it("two candidates with same digest are merged into one entity", () => {
    const entities = resolveCandidates([
      candidate("Start", { digest: "d-start", source: "visual_gpu", confidence: 0.85 }),
      candidate("Start", { digest: "d-start", source: "ocr",        confidence: 0.9 }),
    ], GEN);
    expect(entities).toHaveLength(1);
    expect(entities[0].sources).toContain("visual_gpu");
    expect(entities[0].sources).toContain("ocr");
  });

  it("merged entity takes the max confidence across sources", () => {
    const [e] = resolveCandidates([
      candidate("Start", { digest: "d-s", confidence: 0.7 }),
      candidate("Start", { digest: "d-s", confidence: 0.95 }),
    ], GEN);
    expect(e.confidence).toBe(0.95);
  });

  it("merged entity takes label from the most recently observed candidate", () => {
    const [e] = resolveCandidates([
      candidate("Start",  { digest: "d-s", observedAtMs: 1000 }),
      candidate("START",  { digest: "d-s", observedAtMs: 2000 }),
    ], GEN);
    expect(e.label).toBe("START"); // most recent wins
  });

  it("affordance verbs are unioned across merged sources", () => {
    const [e] = resolveCandidates([
      candidate("X", { digest: "d-x", actionability: ["invoke"] }),
      candidate("X", { digest: "d-x", actionability: ["type"] }),
    ], GEN);
    const verbs = e.affordances.map((a) => a.verb);
    expect(verbs).toContain("invoke");
    expect(verbs).toContain("type");
  });
});

describe("resolveCandidates — role normalization", () => {
  it("known roles pass through", () => {
    for (const role of ["button", "textbox", "link", "menuitem", "label"]) {
      const [e] = resolveCandidates([candidate("x", { role })], GEN);
      expect(e.role).toBe(role);
    }
  });

  it("unknown role is normalised to 'unknown'", () => {
    const [e] = resolveCandidates([candidate("x", { role: "custom-widget" })], GEN);
    expect(e.role).toBe("unknown");
  });

  it("missing role is normalised to 'unknown'", () => {
    const [e] = resolveCandidates([candidate("x", { role: undefined })], GEN);
    expect(e.role).toBe("unknown");
  });
});

describe("resolveCandidates — provisional filtering", () => {
  it("provisional candidates are excluded from resolution", () => {
    const entities = resolveCandidates([
      candidate("Start", { provisional: true }),
      candidate("Quit",  { provisional: false }),
    ], GEN);
    expect(entities).toHaveLength(1);
    expect(entities[0].label).toBe("Quit");
  });

  it("all provisional → empty result", () => {
    const entities = resolveCandidates([
      candidate("Start", { provisional: true }),
    ], GEN);
    expect(entities).toHaveLength(0);
  });
});

describe("resolveCandidates — fallback key (no digest)", () => {
  it("candidates without digest use label+rect (NOT source) as identity key", () => {
    const rect = { x: 0, y: 0, width: 100, height: 40 };
    const entities = resolveCandidates([
      candidate("Play", { digest: undefined, rect }),
      candidate("Play", { digest: undefined, rect }),
    ], GEN);
    expect(entities).toHaveLength(1);
  });

  it("cross-source: visual_gpu + uia without digest merge when label+rect match", () => {
    const rect = { x: 10, y: 20, width: 80, height: 30 };
    const entities = resolveCandidates([
      candidate("Start", { digest: undefined, source: "visual_gpu", rect }),
      candidate("Start", { digest: undefined, source: "uia",        rect }),
    ], GEN);
    expect(entities).toHaveLength(1);
    expect(entities[0].sources).toContain("visual_gpu");
    expect(entities[0].sources).toContain("uia");
  });

  it("cross-source: slightly different rect (within same 8px bucket) still merges", () => {
    // snap(n,8) = Math.round(n/8)*8. Values used here:
    // x: 16 → 16, 18 → 16 ✓ | y: 24 → 24, 25 → 24 ✓ | w: 80 → 80, 81 → 80 ✓ | h: 32 → 32, 31 → 32 ✓
    const entities = resolveCandidates([
      candidate("OK", { digest: undefined, source: "visual_gpu", rect: { x: 16, y: 24, width: 80, height: 32 } }),
      candidate("OK", { digest: undefined, source: "uia",        rect: { x: 18, y: 25, width: 81, height: 31 } }),
    ], GEN);
    expect(entities).toHaveLength(1);
  });

  it("different labels without digest produce different entities", () => {
    const entities = resolveCandidates([
      candidate("Start", { digest: undefined }),
      candidate("Quit",  { digest: undefined }),
    ], GEN);
    expect(entities).toHaveLength(2);
  });
});
