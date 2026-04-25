import { describe, it, expect } from "vitest";
import { TrackStore } from "../../src/engine/vision-gpu/track-store.js";
import { TemporalFusion } from "../../src/engine/vision-gpu/temporal-fusion.js";
import { CandidateProducer } from "../../src/engine/vision-gpu/candidate-producer.js";
import type { Rect } from "../../src/engine/vision-gpu/types.js";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });
const REC = (text: string, conf: number, tsMs = 1000) => ({ text, confidence: conf, tsMs });

/** Advance a TrackStore through N update cycles to make a track stable (age >= 3). */
function makeStableTrack(store: TrackStore, roi: Rect, nowMs = 1000): string {
  store.update([roi], nowMs);
  store.update([roi], nowMs + 100);
  store.update([roi], nowMs + 200);
  const [track] = store.getStableTracks();
  return track.trackId;
}

const TARGET = { kind: "window" as const, id: "hwnd-42" };

describe("CandidateProducer — basic production", () => {
  it("returns no candidates while fusion is still accumulating (provisional gate)", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });

    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    // Only one recognition — fusion not stable yet
    const candidates = producer.ingest([{ trackId, result: REC("Start", 0.9) }]);
    expect(candidates).toHaveLength(0);
  });

  it("returns a candidate once fusion reaches stability", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });

    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    producer.ingest([{ trackId, result: REC("Start", 0.9, 1000) }]);
    const candidates = producer.ingest([{ trackId, result: REC("Start", 0.85, 1100) }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe("Start");
    expect(candidates[0].provisional).toBe(false);
  });

  it("produced candidate has correct source and target fields", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, R(10, 20, 80, 30));
    producer.ingest([{ trackId, result: REC("Play", 0.9, 2000) }]);
    const [c] = producer.ingest([{ trackId, result: REC("Play", 0.9, 2100) }]);
    expect(c.source).toBe("visual_gpu");
    expect(c.target).toEqual(TARGET);
    expect(c.sourceId).toBe(trackId);
  });

  it("produced candidate includes rect from the stable track", () => {
    const roi = R(50, 60, 120, 35);
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, roi);
    producer.ingest([{ trackId, result: REC("Quit", 0.9, 2000) }]);
    const [c] = producer.ingest([{ trackId, result: REC("Quit", 0.9, 2100) }]);
    expect(c.rect).toEqual(roi);
  });

  it("confidence is in [0,1] range", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    producer.ingest([{ trackId, result: REC("OK", 0.95, 2000) }]);
    const [c] = producer.ingest([{ trackId, result: REC("OK", 0.95, 2100) }]);
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });

  it("observedAtMs reflects fusion observedAtMs", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    producer.ingest([{ trackId, result: REC("OK", 0.9, 5000) }]);
    const [c] = producer.ingest([{ trackId, result: REC("OK", 0.9, 5100) }]);
    expect(c.observedAtMs).toBe(5100);
  });
});

describe("CandidateProducer — role and actionability inference", () => {
  it("short non-punctuated text → role=button with invoke+click affordances", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, R(0, 0, 80, 30));
    producer.ingest([{ trackId, result: REC("Start Game", 0.9, 2000) }]);
    const [c] = producer.ingest([{ trackId, result: REC("Start Game", 0.9, 2100) }]);
    expect(c.role).toBe("button");
    expect(c.actionability).toContain("invoke");
    expect(c.actionability).toContain("click");
  });

  it("long sentence text → role=label with read affordance", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, R(0, 0, 300, 20));
    const longText = "Press any key to continue playing the game.";
    producer.ingest([{ trackId, result: REC(longText, 0.9, 2000) }]);
    const [c] = producer.ingest([{ trackId, result: REC(longText, 0.9, 2100) }]);
    expect(c.role).toBe("label");
    expect(c.actionability).toEqual(["read"]);
  });
});

describe("CandidateProducer — digest stability", () => {
  it("same label + same ROI bucket → same digest across calls", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    producer.ingest([{ trackId, result: REC("Retry", 0.9, 2000) }]);
    const [c1] = producer.ingest([{ trackId, result: REC("Retry", 0.9, 2100) }]);

    // Reset and produce again from same roi+label — digest must match
    const store2 = new TrackStore();
    const fusion2 = new TemporalFusion({ stableConsecutive: 2 });
    const producer2 = new CandidateProducer(store2, fusion2, { target: TARGET });
    const trackId2 = makeStableTrack(store2, R(0, 0, 100, 40));
    producer2.ingest([{ trackId: trackId2, result: REC("Retry", 0.9, 2000) }]);
    const [c2] = producer2.ingest([{ trackId: trackId2, result: REC("Retry", 0.9, 2100) }]);

    expect(c1.digest).toBe(c2.digest);
  });

  it("different label → different digest", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });
    const roi = R(0, 0, 100, 40);

    const t1 = makeStableTrack(store, roi, 1000);
    producer.ingest([{ trackId: t1, result: REC("Start", 0.9, 2000) }]);
    const [c1] = producer.ingest([{ trackId: t1, result: REC("Start", 0.9, 2100) }]);

    // Second roi far enough to be a separate track — needs 3 store updates to stabilize
    store.update([R(0, 0, 100, 40), R(500, 0, 100, 40)], 3000);
    store.update([R(0, 0, 100, 40), R(500, 0, 100, 40)], 3100);
    store.update([R(0, 0, 100, 40), R(500, 0, 100, 40)], 3200);
    const [, t2Track] = store.getStableTracks();
    const t2 = t2Track.trackId;
    producer.ingest([{ trackId: t2, result: REC("Quit", 0.9, 4000) }]);
    const [c2] = producer.ingest([{ trackId: t2, result: REC("Quit", 0.9, 4100) }]);

    expect(c1.digest).not.toBe(c2.digest);
  });
});

describe("CandidateProducer — eviction and cleanup", () => {
  it("evict() clears fusion state for the track (prevents state leak)", () => {
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const { producer } = CandidateProducer.create({}, fusion, { target: TARGET });
    const store = new TrackStore({ onEvict: (id) => producer.evict(id) });
    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    fusion.update(trackId, { text: "Start", confidence: 0.9, tsMs: 0 });
    fusion.update(trackId, { text: "Start", confidence: 0.9, tsMs: 0 });
    expect(fusion.getState(trackId)?.stable).toBe(true);
    producer.evict(trackId);
    expect(fusion.getState(trackId)).toBeNull();
  });

  it("create() factory wires onEvict automatically — eviction clears fusion", () => {
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const { store } = CandidateProducer.create({}, fusion, { target: TARGET });

    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    fusion.update(trackId, { text: "X", confidence: 0.9, tsMs: 0 });
    fusion.update(trackId, { text: "X", confidence: 0.9, tsMs: 0 });
    expect(fusion.getState(trackId)?.stable).toBe(true);

    store.update([], 1200); // mark lost
    store.update([], 3500); // beyond LOST_EVICT_MS → evicts + fires wired onEvict
    expect(fusion.getState(trackId)).toBeNull();
  });

  it("ingest ignores recognitions for non-stable tracks and does NOT advance fusion", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });

    // Only 1 update — track is in "new" state
    const tracks = store.update([R(0, 0, 100, 40)], 1000);
    const trackId = tracks[0].trackId;

    producer.ingest([{ trackId, result: REC("Foo", 0.9) }]);
    // Fusion state must NOT have been advanced
    expect(fusion.getState(trackId)).toBeNull();

    const candidates = producer.ingest([{ trackId, result: REC("Foo", 0.9) }]);
    expect(candidates).toHaveLength(0);
  });
});

describe("CandidateProducer — frame dedup via TemporalFusion tsMs guard", () => {
  it("calling ingest twice with the same tsMs does not double-count frames", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });

    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    const result = REC("Start", 0.9, 2000);
    // First ingest at tsMs=2000 — advances consecutive count to 1
    producer.ingest([{ trackId, result }]);
    // Second ingest with SAME tsMs=2000 — must be deduped, count stays at 1
    const candidates = producer.ingest([{ trackId, result }]);
    expect(candidates).toHaveLength(0); // not stable yet (count still 1, not 2)
  });

  it("distinct tsMs values are each counted once", () => {
    const store = new TrackStore();
    const fusion = new TemporalFusion({ stableConsecutive: 2 });
    const producer = new CandidateProducer(store, fusion, { target: TARGET });

    const trackId = makeStableTrack(store, R(0, 0, 100, 40));
    producer.ingest([{ trackId, result: REC("Start", 0.9, 3000) }]);
    const candidates = producer.ingest([{ trackId, result: REC("Start", 0.9, 3100) }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe("Start");
  });
});
