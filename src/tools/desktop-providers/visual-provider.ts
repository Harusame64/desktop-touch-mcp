/**
 * visual-provider.ts — Visual GPU lane candidate provider.
 *
 * Phase 2 stub: returns empty. The CandidateProducer pipeline (TrackStore +
 * TemporalFusion) requires a running Desktop Duplication + detector/recognizer
 * session that is not yet connected to the facade in Phase 2.
 *
 * Phase 3 plan:
 *   1. Create a per-process CandidateProducer singleton
 *   2. Wire dirty-rect events from Desktop Duplication → ROI scheduler
 *   3. Expose getStableCandiates(targetKey) as a sync snapshot
 *
 * The stub preserves the provider interface so compose-providers can already
 * merge visual_gpu source output into the entity list when it becomes available.
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";

export async function fetchVisualCandidates(
  _target: TargetSpec | undefined
): Promise<UiEntityCandidate[]> {
  // Phase 3: wire to CandidateProducer.ingest() result snapshot here.
  return [];
}
