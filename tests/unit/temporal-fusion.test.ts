import { describe, it, expect } from "vitest";
import { TemporalFusion } from "../../src/engine/vision-gpu/temporal-fusion.js";

const R = (text: string, confidence: number, tsMs = 0) => ({ text, confidence, tsMs });

describe("TemporalFusion — basic stability", () => {
  it("single update is not stable (premature commit prevention)", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    const s = f.update("t1", R("Start", 0.9, 1000));
    expect(s.stable).toBe(false);
    expect(s.text).toBeNull();
    expect(s.consecutiveCount).toBe(1);
  });

  it("two consecutive identical observations become stable", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    f.update("t1", R("Start", 0.9, 1000));
    const s = f.update("t1", R("Start", 0.85, 1100));
    expect(s.stable).toBe(true);
    expect(s.text).toBe("Start");
    expect(s.consecutiveCount).toBe(2);
  });

  it("three-frame threshold requires three consecutive direct observations", () => {
    const f = new TemporalFusion({ stableConsecutive: 3 });
    f.update("t1", R("Start", 0.9));
    const s2 = f.update("t1", R("Start", 0.9));
    expect(s2.stable).toBe(false);
    const s3 = f.update("t1", R("Start", 0.9));
    expect(s3.stable).toBe(true);
  });

  it("stableConsecutive is clamped to 2 when 1 is passed", () => {
    const f = new TemporalFusion({ stableConsecutive: 1 });
    const s = f.update("t1", R("Start", 0.9));
    expect(s.stable).toBe(false); // must not commit on single frame even if 1 was passed
  });
});

describe("TemporalFusion — consecutive count correctness", () => {
  it("consecutiveCount does not increment when leader text is not directly observed", () => {
    // leader="A" stabilizes, then we observe "B". "A" still wins by accumulated vote
    // because decay is slow, but consecutive count must NOT advance.
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0.99 });
    f.update("t1", R("A", 0.9, 1000)); // A: 0.9, consecutive=1
    f.update("t1", R("A", 0.9, 1100)); // A: ~1.8, consecutive=2 → stable
    // Now observe "B" with low confidence — A still leads by accumulated votes
    const s = f.update("t1", R("B", 0.1, 1200));
    // consecutive must NOT increase beyond 2 — A was not observed
    expect(s.consecutiveCount).toBe(2);
    expect(s.stable).toBe(true); // still stable unless challenger margin triggers de-stabilize
  });

  it("fluctuating text stays provisional and does not commit", () => {
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0 });
    f.update("t1", R("Start", 0.9));
    f.update("t1", R("Stari", 0.9));
    f.update("t1", R("Start", 0.9));
    const s = f.update("t1", R("Stari", 0.9));
    expect(s.stable).toBe(false);
    expect(s.text).toBeNull();
  });
});

describe("TemporalFusion — de-stabilization", () => {
  it("stable text reverts when a different text takes the vote lead", () => {
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0.01 });
    f.update("t1", R("Start", 0.9, 1000));
    f.update("t1", R("Start", 0.9, 1100)); // stable
    // Resume floods the votes; Start decays to near-zero
    f.update("t1", R("Resume", 0.99, 1200));
    const s = f.update("t1", R("Resume", 0.99, 1300));
    expect(s.stable).toBe(true);
    expect(s.text).toBe("Resume");
  });

  it("stable text de-stabilizes when challenger closes the margin (runnerUp * 1.5 >= leader)", () => {
    // With voteDecay=0.7: after 2 frames of A=0.9, A_votes ≈ 1.53 → stable.
    // Frame 3 observes B=0.8: decay A→1.071. votes: A=1.071, B=0.8.
    // A still wins (1.071 > 0.8) but 0.8*1.5=1.2 >= 1.071 → de-stabilize.
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0.7 });
    f.update("t1", R("A", 0.9));
    f.update("t1", R("A", 0.9)); // stable
    const s = f.update("t1", R("B", 0.8));
    expect(s.stable).toBe(false);
  });

  it("stable text does NOT de-stabilize when challenger is far behind", () => {
    // voteDecay=1.0 means no decay, votes accumulate: after 2 frames A=1.8.
    // B at 0.3: 0.3*1.5=0.45 < 1.8 → stays stable.
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 1.0 });
    f.update("t1", R("A", 0.9));
    f.update("t1", R("A", 0.9)); // stable: A=1.8
    const s = f.update("t1", R("B", 0.3));
    expect(s.stable).toBe(true);
  });
});

describe("TemporalFusion — confidence weighting", () => {
  it("higher confidence text wins vote over lower confidence text with same occurrence count", () => {
    // voteDecay=1.0 so votes don't accumulate across frames
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 1.0 });
    f.update("t1", R("Weak", 0.3));
    f.update("t1", R("Weak", 0.3));
    f.update("t1", R("Weak", 0.3)); // Weak stable at 0.3
    f.update("t1", R("Strong", 0.95)); // Strong 0.95 > Weak 0.3 → new leader
    const s = f.update("t1", R("Strong", 0.95));
    expect(s.text).toBe("Strong");
    expect(s.stable).toBe(true);
  });

  it("confidence is normalized to approximately [0,1] for resolver ranking", () => {
    // With voteDecay=0.7, geometric series max = confidence / 0.3 ≈ 3.0 for conf=0.9
    // After normalization *= 0.3 → should be close to 0.9
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0.7 });
    for (let i = 0; i < 10; i++) f.update("t1", R("Start", 0.9));
    const s = f.getState("t1")!;
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
    // Should be close to original OCR confidence (within 15%)
    expect(s.confidence).toBeGreaterThan(0.75);
  });

  it("vote decay prevents old high-confidence frames from blocking a new leader", () => {
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0.1 });
    for (let i = 0; i < 5; i++) f.update("t1", R("Old", 0.95));
    f.update("t1", R("New", 0.9));
    const s = f.update("t1", R("New", 0.9));
    expect(s.text).toBe("New");
    expect(s.stable).toBe(true);
  });
});

describe("TemporalFusion — input filtering", () => {
  it("empty text observation is ignored — state unchanged", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    f.update("t1", R("Start", 0.9));
    f.update("t1", R("Start", 0.9)); // stable
    const before = f.getState("t1")!;
    f.update("t1", R("", 0.99)); // empty — must be ignored
    const after = f.getState("t1")!;
    expect(after.stable).toBe(before.stable);
    expect(after.consecutiveCount).toBe(before.consecutiveCount);
  });

  it("whitespace-only text observation is ignored", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    const s = f.update("t1", R("   ", 0.99));
    expect(s.text).toBeNull();
    expect(s.stable).toBe(false);
  });

  it("observation below confidence floor is ignored", () => {
    const f = new TemporalFusion({ stableConsecutive: 2, minConfidence: 0.3 });
    const s = f.update("t1", R("Start", 0.1)); // below floor
    expect(s.text).toBeNull();
    expect(s.consecutiveCount).toBe(0);
  });
});

describe("TemporalFusion — observedAtMs tracking", () => {
  it("observedAtMs reflects when the leader text was last directly observed", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    f.update("t1", R("Start", 0.9, 1000));
    f.update("t1", R("Start", 0.9, 1100));
    const s = f.getState("t1")!;
    expect(s.observedAtMs).toBe(1100);
  });

  it("observedAtMs does not update when a non-leader text is observed", () => {
    // voteDecay=0.99 so A keeps leading after two frames, then B is observed once
    const f = new TemporalFusion({ stableConsecutive: 2, voteDecay: 0.99 });
    f.update("t1", R("A", 0.9, 1000));
    f.update("t1", R("A", 0.9, 1100)); // stable, leader=A, leaderLastObservedMs=1100
    f.update("t1", R("B", 0.1, 1200)); // B is below challenger threshold, A still leads
    const s = f.getState("t1")!;
    expect(s.observedAtMs).toBe(1100); // must not be 1200
  });
});

describe("TemporalFusion — lifecycle", () => {
  it("getState returns null for unknown trackId", () => {
    const f = new TemporalFusion();
    expect(f.getState("no-such-id")).toBeNull();
  });

  it("getState does not advance state", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    f.update("t1", R("Start", 0.9));
    f.update("t1", R("Start", 0.9));
    expect(f.getState("t1")).toEqual(f.getState("t1"));
  });

  it("clear resets fusion state for a track", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    f.update("t1", R("Start", 0.9));
    f.update("t1", R("Start", 0.9));
    expect(f.getState("t1")!.stable).toBe(true);
    f.clear("t1");
    expect(f.getState("t1")).toBeNull();
    const s = f.update("t1", R("Start", 0.9));
    expect(s.stable).toBe(false); // starts fresh
  });

  it("different trackIds are independent", () => {
    const f = new TemporalFusion({ stableConsecutive: 2 });
    f.update("t1", R("Start", 0.9));
    f.update("t1", R("Start", 0.9));
    f.update("t2", R("Menu", 0.8));
    expect(f.getState("t1")!.stable).toBe(true);
    expect(f.getState("t2")!.stable).toBe(false);
  });

  it("provisional gate: text=null when not yet stable — prevents premature lease issuance", () => {
    const f = new TemporalFusion({ stableConsecutive: 3 });
    f.update("t1", R("Start", 0.9));
    f.update("t1", R("Start", 0.9));
    const s = f.getState("t1")!;
    expect(s.stable).toBe(false);
    expect(s.text).toBeNull(); // Batch 6 must not issue a lease when text is null
  });
});
