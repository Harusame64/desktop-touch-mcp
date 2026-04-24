/**
 * ocr-adapter.ts — Bridge from SoM pipeline output to CandidateProducer.
 *
 * Phase 1 of visual-gpu-dataplane-plan.md: fills the production gap where no
 * component ever calls CandidateProducer.ingest(). Reuses the existing
 * PrintWindow + win-ocr.exe pipeline as a stand-in detector+recognizer.
 *
 * Per-target isolation: one OcrVisualAdapter instance per targetKey.
 * Adapter owns its TrackStore/TemporalFusion/CandidateProducer triple so
 * tracks from Outlook do not collide with tracks from Chrome.
 *
 * Poll semantics:
 *   pollOnce(target) runs runSomPipeline() once, converts SomElements to
 *   ROIs, drives TrackStore for STABLE_AGE_THRESHOLD (=3) frames so the
 *   tracks promote to `stable`, drives TemporalFusion for stableConsecutive
 *   (=2) frames so text commits, then pushes the resulting UiEntityCandidate[]
 *   via pushDirtySignal.
 *
 *   When the caller (ocr-provider) already holds SomElement[] from a preceding
 *   runSomPipeline call, pass them as `preFetchedElements` — the adapter skips
 *   the duplicate runSomPipeline invocation, halving the per-see cost.
 *
 * The "3 synthesised frames" trick is deliberate: we have no real frame
 * source in Phase 1, so we simulate stability by calling update() with the
 * same ROIs three times in quick succession. The fusion/track store do not
 * know the difference. This is replaced by real per-frame ingestion in Phase 3.
 */

import type { TargetSpec } from "../world-graph/session-registry.js";
import type { UiEntityCandidate } from "./types.js";
import { TrackStore } from "./track-store.js";
import { TemporalFusion } from "./temporal-fusion.js";
import { CandidateProducer } from "./candidate-producer.js";
import { pushDirtySignal } from "./dirty-signal.js";
import type { SomElement, OcrDictionaryEntry } from "../ocr-bridge.js";

/** Compute the targetKey that both visual-provider and pushDirtySignal use. */
export function targetKeyFromSpec(target: TargetSpec): string {
  if (target.hwnd)        return `window:${target.hwnd}`;
  if (target.tabId)       return `tab:${target.tabId}`;
  if (target.windowTitle) return `title:${target.windowTitle}`;
  return "window:__default__";
}

export interface OcrVisualAdapterOptions {
  /** Min ms between pollOnce invocations for the same target (default 2000). */
  minPollIntervalMs?: number;
  /** Fusion stableConsecutive (default 2). */
  stableConsecutive?: number;
}

/**
 * Per-target adapter. Hold one instance per window/tab in a Map.
 */
export class OcrVisualAdapter {
  private readonly store: TrackStore;
  private readonly fusion: TemporalFusion;
  private readonly producer: CandidateProducer;
  private readonly targetKey: string;
  private readonly minPollIntervalMs: number;
  private lastPollMs = 0;
  // inFlight coalesces concurrent callers onto the same in-progress poll.
  // Debounce check (lastPollMs) happens BEFORE inFlight so that a concurrent
  // call within minPollIntervalMs is coalesced rather than silently dropped.
  // Debounce interval is measured from poll START, not completion.
  private inFlight: Promise<UiEntityCandidate[]> | null = null;

  constructor(
    target: TargetSpec,
    opts: OcrVisualAdapterOptions = {},
  ) {
    this.targetKey = targetKeyFromSpec(target);
    this.minPollIntervalMs = opts.minPollIntervalMs ?? 2000;

    const fusion = new TemporalFusion({
      stableConsecutive: opts.stableConsecutive ?? 2,
    });
    // CandidateProducer.create wires onEvict → producer.evict automatically.
    const producerTarget = target.tabId
      ? { kind: "browserTab" as const, id: target.tabId }
      : { kind: "window" as const, id: target.hwnd ?? target.windowTitle ?? "@active" };
    const { store, producer } = CandidateProducer.create(
      {}, // TrackStoreOptions — onEvict auto-wired by factory
      fusion,
      { target: producerTarget }
    );
    this.store = store;
    this.fusion = fusion;
    this.producer = producer;
  }

  /**
   * Drive one observation of the target window.
   *
   * 1. If preFetchedElements is provided, skip runSomPipeline (avoids double-cost).
   *    Otherwise call runSomPipeline → SomElement[].
   * 2. Map SomElements → ROIs (screen-absolute rects from el.region).
   * 3. Call TrackStore.update(rois, nowMs) THREE times with same rois
   *    (STABLE_AGE_THRESHOLD=3) so tracks promote from new→tracking→stable.
   * 4. For each stable track, match the best-IoU SomElement (skip if none).
   *    Call CandidateProducer.ingest() twice (stableConsecutive=2) to commit fusion.
   * 5. Push collected UiEntityCandidate[] via pushDirtySignal.
   *
   * Debounce: calls after inFlight completes within minPollIntervalMs are dropped.
   * Concurrent calls while inFlight is active are coalesced onto the same Promise.
   *
   * Returns [] on debounce, OCR failure, or zero stable candidates.
   * Never throws — OCR errors are swallowed and logged.
   */
  /**
   * @param preFetchedElements - When the caller already holds SomElement[] from a
   *   preceding runSomPipeline call, pass them here to skip a duplicate invocation.
   *   `dictionary` is ignored when preFetchedElements is provided.
   */
  async pollOnce(
    target: TargetSpec,
    dictionary: OcrDictionaryEntry[] = [],
    preFetchedElements?: SomElement[],
  ): Promise<UiEntityCandidate[]> {
    const now = Date.now();
    if (now - this.lastPollMs < this.minPollIntervalMs) return [];
    // Coalesce concurrent callers onto in-progress poll instead of starting a second one.
    if (this.inFlight) return this.inFlight;
    this.lastPollMs = now;

    this.inFlight = this._doPoll(target, dictionary, now, preFetchedElements)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async _doPoll(
    target: TargetSpec,
    dictionary: OcrDictionaryEntry[],
    nowMs: number,
    preFetchedElements: SomElement[] | undefined,
  ): Promise<UiEntityCandidate[]> {
    let elements: SomElement[];

    if (preFetchedElements) {
      elements = preFetchedElements;
    } else {
      try {
        const { runSomPipeline } = await import("../ocr-bridge.js");
        const hwnd = target.hwnd ? BigInt(target.hwnd) : null;
        const title = target.windowTitle ?? "@active";
        const result = await runSomPipeline(title, hwnd, "ja", 2, "auto", false, dictionary);
        elements = result.elements;
      } catch (err) {
        console.error("[ocr-adapter] runSomPipeline failed:", err);
        return [];
      }
    }

    if (elements.length === 0) return [];

    // Stage 1: promote tracks to `stable` by feeding the same ROIs 3 times.
    // STABLE_AGE_THRESHOLD in TrackStore is 3. Use nowMs, nowMs+1, nowMs+2
    // so TemporalFusion's tsMs dedup does not reject the repeats.
    const rois = elements.map((e) => e.region);
    this.store.update(rois, nowMs);
    this.store.update(rois, nowMs + 1);
    this.store.update(rois, nowMs + 2);

    // Stage 2: match stable tracks back to their source SomElement via IoU.
    // TrackStore re-assigns the same trackId as long as IoU ≥ 0.3 — for stable
    // ROIs (same rois fed 3 times) this is effectively deterministic.
    const stableTracks = this.store.getStableTracks();
    if (stableTracks.length === 0) return [];

    // Stage 3: feed TemporalFusion via producer.ingest() twice to reach
    // stableConsecutive=2. tsMs must be strictly increasing per trackId across
    // passes (nowMs+10, nowMs+11) to avoid TemporalFusion's frame dedup.
    let candidates: UiEntityCandidate[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const inputs = stableTracks.flatMap((track) => {
        // Skip any stable track whose ROI has no overlapping SomElement (IoU=0).
        // Falling back to an arbitrary elements[i] would publish wrong text.
        const el = findBestMatchingElement(track.roi, elements);
        if (!el) return [];
        return [{
          trackId: track.trackId,
          result: {
            text: el.text,
            confidence: el.confidence ?? 0.7,
            tsMs: nowMs + 10 + pass,
          },
        }];
      });
      if (inputs.length > 0) {
        candidates = this.producer.ingest(inputs);
      }
    }

    // Stage 4: publish.
    if (candidates.length > 0) {
      pushDirtySignal(this.targetKey, candidates);
    }
    return candidates;
  }

  /**
   * Release TemporalFusion state for all stable tracks and reset the debounce
   * timer. Only stable tracks have fusion state (producer.ingest() guards on
   * track.state === "stable"), so new/tracking tracks need no explicit clear.
   *
   * TrackStore internal state is NOT reset here — the adapter is expected to be
   * discarded after dispose(). Do not re-use a disposed adapter; obtain a fresh
   * instance from getOcrVisualAdapter() instead.
   */
  dispose(): void {
    for (const t of this.store.getStableTracks()) {
      this.fusion.clear(t.trackId);
    }
    this.lastPollMs = 0;
  }
}

function iouOf(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function findBestMatchingElement(
  roi: { x: number; y: number; width: number; height: number },
  elements: SomElement[],
): SomElement | undefined {
  let best: SomElement | undefined;
  let bestScore = 0;
  for (const e of elements) {
    const s = iouOf(roi, e.region);
    if (s > bestScore) { bestScore = s; best = e; }
  }
  return best;
}
