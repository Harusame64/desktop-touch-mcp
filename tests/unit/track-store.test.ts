import { describe, it, expect } from "vitest";
import { TrackStore } from "../../src/engine/vision-gpu/track-store.js";
import type { Rect } from "../../src/engine/vision-gpu/types.js";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });

describe("TrackStore", () => {
  it("creates a new track for an unmatched roi", () => {
    const store = new TrackStore();
    const tracks = store.update([R(0, 0, 100, 50)], 1000);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].state).toBe("new");
    expect(tracks[0].age).toBe(1);
  });

  it("updates existing track and increments age on successive updates", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    const tracks = store.update([R(5, 5, 100, 50)], 1100);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].age).toBe(2);
    expect(tracks[0].state).toBe("tracking");
  });

  it("transitions to stable after STABLE_AGE_THRESHOLD updates", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    store.update([R(0, 0, 100, 50)], 1100);
    const tracks = store.update([R(0, 0, 100, 50)], 1200);
    expect(tracks[0].state).toBe("stable");
  });

  it("marks track as lost when roi disappears", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    const tracks = store.update([], 1100);
    expect(tracks[0].state).toBe("lost");
  });

  it("evicts lost track after timeout", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    store.update([], 1100); // mark lost
    const tracks = store.update([], 4000); // beyond LOST_EVICT_MS (2000)
    expect(tracks).toHaveLength(0);
  });

  it("getStableTracks returns only stable tracks", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    expect(store.getStableTracks()).toHaveLength(0);
    store.update([R(0, 0, 100, 50)], 1100);
    store.update([R(0, 0, 100, 50)], 1200);
    expect(store.getStableTracks()).toHaveLength(1);
  });

  it("recognizer only sees stable tracks — new/tracking tracks are not in getStableTracks", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000); // age=1, state=new
    store.update([R(0, 0, 100, 50)], 1100); // age=2, state=tracking
    expect(store.getStableTracks()).toHaveLength(0);
  });

  it("markRecognized updates bestFrameScore and lastText", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    store.update([R(0, 0, 100, 50)], 1100);
    store.update([R(0, 0, 100, 50)], 1200);
    const [track] = store.getStableTracks();
    store.markRecognized(track.trackId, { text: "Start", confidence: 0.9, tsMs: 1200 });
    const [updated] = store.getStableTracks();
    expect(updated.lastText).toBe("Start");
    expect(updated.bestFrameScore).toBe(0.9);
  });

  it("markRecognized does not update if new confidence is lower", () => {
    const store = new TrackStore();
    store.update([R(0, 0, 100, 50)], 1000);
    store.update([R(0, 0, 100, 50)], 1100);
    store.update([R(0, 0, 100, 50)], 1200);
    const [track] = store.getStableTracks();
    store.markRecognized(track.trackId, { text: "Start", confidence: 0.9, tsMs: 1200 });
    store.markRecognized(track.trackId, { text: "Stari", confidence: 0.5, tsMs: 1300 });
    const [updated] = store.getStableTracks();
    expect(updated.lastText).toBe("Start");
    expect(updated.bestFrameScore).toBe(0.9);
  });

  it("two disjoint rois produce two independent tracks", () => {
    const store = new TrackStore();
    const tracks = store.update([R(0, 0, 50, 50), R(500, 500, 50, 50)], 1000);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].trackId).not.toBe(tracks[1].trackId);
  });

  it("markRecognized on unknown trackId is a no-op", () => {
    const store = new TrackStore();
    expect(() => store.markRecognized("no-such-id", { text: "x", confidence: 1, tsMs: 0 })).not.toThrow();
  });
});
