import { createHash } from "node:crypto";
import type { UiEntityCandidate, RecognizedText } from "./types.js";
import { TrackStore, type TrackStoreOptions } from "./track-store.js";
import type { TemporalFusion } from "./temporal-fusion.js";

export interface CandidateProducerOptions {
  target: { kind: "window" | "browserTab"; id: string };
  /** Pixel bucket size for ROI-based digest snapping (default: 8). Use Math.floor — monotonic, no boundary flip. */
  rectBucketPx?: number;
}

export interface RecognitionInput {
  trackId: string;
  result: RecognizedText;
}

/**
 * Heuristic role inference from OCR text.
 * Short (≤24 chars), few words (≤3), no trailing sentence punctuation → button.
 * Resolver normalises the role further when merging with UIA/CDP sources.
 */
function inferRole(text: string): string {
  const words = text.trim().split(/\s+/).length;
  return text.length <= 24 && words <= 3 && !/[.,:;?!…]$/.test(text) ? "button" : "label";
}

function inferActionability(role: string): Array<"click" | "invoke" | "type" | "read"> {
  return role === "button" ? ["invoke", "click"] : ["read"];
}

function computeDigest(
  source: string,
  target: { kind: string; id: string },
  label: string,
  roi: { x: number; y: number; width: number; height: number },
  bucketPx: number
): string {
  // Math.floor (not round) to avoid boundary flips at high DPI.
  const snap = (n: number) => Math.floor(n / bucketPx) * bucketPx;
  const rectKey = `${snap(roi.x)},${snap(roi.y)},${snap(roi.width)},${snap(roi.height)}`;
  // Include target.kind to prevent HWND / CDP-tabId collision in digest.
  // SHA-256 used as a non-cryptographic fingerprint (collision avoidance only,
  // not a security primitive — output truncated to 16 hex chars). Replaces
  // former SHA-1 to satisfy code scanning js/weak-cryptographic-algorithm.
  return createHash("sha256")
    .update(`${source}|${target.kind}:${target.id}|${label}|${rectKey}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Connects TrackStore + TemporalFusion to produce UiEntityCandidates.
 *
 * Preferred construction: use `CandidateProducer.create()` which automatically
 * wires the `onEvict` callback so fusion state is cleaned up when tracks expire.
 *
 * NOTE on lost→rediscovered cycles: when a track is evicted and later a new track
 * appears at the same location, a new `trackId` (randomUUID) is assigned but the
 * `digest` will be identical (same label + rect bucket). The resolver should treat
 * matching digests as the same entity and re-issue the lease rather than creating
 * a duplicate entry.
 */
export class CandidateProducer {
  private readonly target: { kind: "window" | "browserTab"; id: string };
  private readonly rectBucketPx: number;

  constructor(
    private readonly trackStore: TrackStore,
    private readonly fusion: TemporalFusion,
    opts: CandidateProducerOptions
  ) {
    this.target = opts.target;
    this.rectBucketPx = opts.rectBucketPx ?? 8;
  }

  /**
   * Factory that creates a TrackStore wired to this producer's eviction handler.
   * Preferred over manual construction — prevents silent eviction miswiring.
   */
  static create(
    storeOpts: Omit<TrackStoreOptions, "onEvict">,
    fusion: TemporalFusion,
    producerOpts: CandidateProducerOptions
  ): { store: TrackStore; producer: CandidateProducer } {
    // ref avoids chicken-and-egg: closure captures ref, producer assigned before store.update() fires.
    const ref = { producer: null as unknown as CandidateProducer };
    const store = new TrackStore({ ...storeOpts, onEvict: (id) => ref.producer.evict(id) });
    ref.producer = new CandidateProducer(store, fusion, producerOpts);
    return { store, producer: ref.producer };
  }

  /**
   * Feed a batch of recognition results for structurally stable tracks.
   * Fusion state is only advanced for tracks that are already in `state="stable"`.
   * Candidates are emitted only once fusion has committed stable text.
   */
  ingest(recognitions: RecognitionInput[]): UiEntityCandidate[] {
    const candidates: UiEntityCandidate[] = [];

    for (const { trackId, result } of recognitions) {
      // Check structural stability FIRST — do not advance fusion for new/tracking tracks.
      const track = this.trackStore.getTrack(trackId);
      if (!track || track.state !== "stable") continue;

      const fusedState = this.fusion.update(trackId, result);
      if (!fusedState.stable || fusedState.text === null) continue;

      // Mirror committed text onto the track for diagnostic use.
      this.trackStore.markRecognized(trackId, result);

      const role = inferRole(fusedState.text);
      const digest = computeDigest("visual_gpu", this.target, fusedState.text, track.roi, this.rectBucketPx);

      candidates.push({
        source: "visual_gpu",
        target: this.target,
        sourceId: trackId, // kept for backward compat
        locator: { visual: { trackId, rect: track.roi } },
        role,
        label: fusedState.text,
        rect: track.roi,
        actionability: inferActionability(role),
        confidence: fusedState.confidence,
        observedAtMs: fusedState.observedAtMs,
        digest,
        provisional: false,
      });
    }

    return candidates;
  }

  /** Wire to TrackStore.onEvict (or call directly) to prevent TemporalFusion state leak. */
  evict(trackId: string): void {
    this.fusion.clear(trackId);
  }
}
