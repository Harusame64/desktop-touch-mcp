/**
 * _roi-capture-gate.ts — ADR-024 Seed-2 (S1 contract lock).
 *
 * Pure decision function: should a successful `desktop_act` fold a post-action
 * `roiCapture` (diff-region crop + lease-less entity preview) into its response?
 *
 * S1 locks the gate logic and the opt-in surface; the registration wrapper wires
 * this in S2 and the ROI/OCR population lands in S3/S4. Keeping the decision pure
 * lets it be exhaustively unit-tested over the 5-valued motion enum without any
 * capture machinery.
 */

import type { VisualMotionObservation } from "./_input-pipeline.js";

/**
 * Caller opt-in for post-action ROI capture. `undefined` (the default) behaves
 * as the automatic regime gate (= "on-change" semantics, hard-gated on
 * visual-only). Surfaced as the optional `returnCapture` param on `desktop_act`.
 */
export type ReturnCaptureMode = "on-change" | "always" | "never";

/**
 * Motion verdicts that count as a real visual change (ADR-024 §2 trigger).
 * `no_change` / `indeterminate` (and an absent observation) are excluded — the
 * former means nothing happened, the latter means we cannot verify (e.g. DXGI
 * unavailable over RDP), and an unverifiable change must not trigger a crop.
 */
const CHANGED_MOTIONS: ReadonlySet<VisualMotionObservation["motion"]> = new Set([
  "translation",
  "local_repaint",
  "any_change",
]);

export interface RoiCaptureGateInput {
  /** Did the act succeed? */
  ok: boolean;
  /** Is the act target visual-only (UIA-blind / RDP / canvas)? Hard gate. */
  visualOnly: boolean;
  /** Motion verdict from the post-act observation, or `undefined` if none. */
  motion: VisualMotionObservation["motion"] | undefined;
  /** Caller opt-in. */
  returnCapture: ReturnCaptureMode | undefined;
}

/**
 * Decide whether to attach a `roiCapture` to a `desktop_act` response.
 *
 * Hard guards (enforced regardless of `returnCapture`):
 *   1. the act must have succeeded, and
 *   2. the target must be visual-only. On structured targets (browser/CDP,
 *      UIA-rich native) structured observation via `desktop_state` is strictly
 *      better, so attaching a screenshot would regress
 *      `feedback_minimize_screenshot_reliance`.
 *
 * Within those guards:
 *   - "never"               → never attach;
 *   - "always"              → attach on any successful visual-only act (motion ignored);
 *   - "on-change" / undefined → attach only when the post-act motion shows a real
 *                               change (translation / local_repaint / any_change).
 */
export function shouldReturnRoiCapture(input: RoiCaptureGateInput): boolean {
  if (!input.ok) return false;
  if (input.returnCapture === "never") return false;
  if (!input.visualOnly) return false;
  if (input.returnCapture === "always") return true;
  return input.motion !== undefined && CHANGED_MOTIONS.has(input.motion);
}
