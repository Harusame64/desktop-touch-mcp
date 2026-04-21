import { randomUUID } from "node:crypto";
import type { Rect, VisualTrack, RecognizedText } from "./types.js";

const STABLE_AGE_THRESHOLD = 3;
const LOST_EVICT_MS = 2000;
const IOU_MATCH_THRESHOLD = 0.3;

export interface TrackStoreOptions {
  /** Called when a lost track is evicted. Use to clean up TemporalFusion state. */
  onEvict?: (trackId: string) => void;
}

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

export class TrackStore {
  private tracks = new Map<string, VisualTrack>();
  private readonly onEvict: ((trackId: string) => void) | undefined;

  constructor(opts: TrackStoreOptions = {}) {
    this.onEvict = opts.onEvict;
  }

  update(rois: Rect[], nowMs: number): VisualTrack[] {
    const matched = new Set<string>();
    const usedRoiIdx = new Set<number>();

    for (const [id, track] of this.tracks) {
      if (track.state === "lost") continue;
      let bestScore = 0;
      let bestIdx = -1;
      for (let i = 0; i < rois.length; i++) {
        if (usedRoiIdx.has(i)) continue;
        const score = iou(track.roi, rois[i]);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestScore >= IOU_MATCH_THRESHOLD && bestIdx >= 0) {
        usedRoiIdx.add(bestIdx);
        matched.add(id);
        track.roi = rois[bestIdx];
        track.age += 1;
        track.lastSeenTsMs = nowMs;
        track.state = track.age >= STABLE_AGE_THRESHOLD ? "stable" : "tracking";
      }
    }

    for (const [id, track] of this.tracks) {
      if (matched.has(id)) continue;
      if (track.state === "lost") {
        if (nowMs - track.lastSeenTsMs > LOST_EVICT_MS) {
          this.tracks.delete(id);
          this.onEvict?.(id);
        }
      } else {
        track.state = "lost";
      }
    }

    for (let i = 0; i < rois.length; i++) {
      if (usedRoiIdx.has(i)) continue;
      const t: VisualTrack = {
        trackId: randomUUID(),
        roi: rois[i],
        age: 1,
        lastSeenTsMs: nowMs,
        bestFrameScore: 0,
        state: "new",
      };
      this.tracks.set(t.trackId, t);
    }

    return [...this.tracks.values()];
  }

  getStableTracks(): VisualTrack[] {
    return [...this.tracks.values()].filter((t) => t.state === "stable");
  }

  getTrack(trackId: string): VisualTrack | undefined {
    return this.tracks.get(trackId);
  }

  /**
   * markRecognized reflects the best raw OCR result on the track for diagnostics.
   * NOTE: for stability decisions, use TemporalFusion.update() instead — this method
   * uses simple max-confidence gating and cannot detect text drift.
   */
  markRecognized(trackId: string, result: RecognizedText): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    if (result.confidence > t.bestFrameScore) {
      t.bestFrameScore = result.confidence;
      t.lastText = result.text;
    }
  }
}
