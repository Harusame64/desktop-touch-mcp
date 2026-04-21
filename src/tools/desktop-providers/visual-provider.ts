/**
 * visual-provider.ts — Visual GPU lane candidate provider.
 *
 * Phase 2 stub. Always returns empty candidates with the
 * `visual_provider_unavailable` warning so the LLM knows this lane is not
 * active — "no entities" is not the same as "provider working but found nothing".
 *
 * Phase 3 plan:
 *   1. Create a per-process CandidateProducer singleton
 *   2. Wire dirty-rect events from Desktop Duplication → ROI scheduler
 *   3. Expose getStableCandidates(targetKey) as a sync snapshot
 */

import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";

export async function fetchVisualCandidates(
  _target: TargetSpec | undefined
): Promise<ProviderResult> {
  // Phase 3: wire to CandidateProducer.ingest() result snapshot here.
  return { candidates: [], warnings: ["visual_provider_unavailable"] };
}
