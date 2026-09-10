/**
 * visual-provider.ts — Visual GPU lane candidate provider.
 *
 * Phase 3-A: depends on VisualRuntime interface instead of being a pure stub.
 *   - When no backend is attached → visual_provider_unavailable (same as Phase 2)
 *   - When backend attached but warming → visual_provider_warming
 *   - When warm + no candidates → empty candidates, no warning (valid state)
 *   - When backend failed → visual_provider_failed
 *
 * Phase 3-B: attach a real backend (MockVisualBackend with fixture data or
 *   SidecarBackend for native detector/recognizer output).
 *
 * Phase 3-D: replace MockVisualBackend with OnnxBackend / SidecarBackend.
 */

import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import { getVisualRuntime, targetKeyToWarmTarget } from "../../engine/vision-gpu/runtime.js";
import { probeLane } from "../../engine/aim-probe.js";

// H-killswitch: operator escape hatch. When set, the visual lane behaves
// exactly as if no backend were attached — the provider returns
// visual_provider_unavailable and composer falls through to OCR or
// structured-only mode. Evaluated once at module load; tests use
// vi.resetModules() + dynamic import() to re-evaluate.
const VISUAL_GPU_DISABLED = process.env["DESKTOP_TOUCH_DISABLE_VISUAL_GPU"] === "1";

function targetKeyFromSpec(target: TargetSpec | undefined): string {
  if (target?.hwnd)        return `window:${target.hwnd}`;
  if (target?.tabId)       return `tab:${target.tabId}`;
  if (target?.windowTitle) return `title:${target.windowTitle}`;
  return "window:__default__";
}

export async function fetchVisualCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  // ADR-036 item 14a — every return below writes the lane's row. The first two answer the same
  // warning for two different reasons, and only the row's `why` tells an operator's switch from a
  // backend that never attached.
  if (VISUAL_GPU_DISABLED) {
    return probeLane("visual_gpu", "skipped", { why: "disabled_by_env" }, { candidates: [], warnings: ["visual_provider_unavailable"] });
  }

  const runtime = getVisualRuntime();

  if (!runtime.isAvailable()) {
    // No backend attached — Phase 2 stub behavior.
    return probeLane("visual_gpu", "skipped", { why: "no_backend" }, { candidates: [], warnings: ["visual_provider_unavailable"] });
  }

  const targetKey  = targetKeyFromSpec(target);
  const warmTarget = targetKeyToWarmTarget(targetKey);

  // What this lane asks for; the warm state joins it once there is one.
  const asked = { targetKey };
  let warmState: import("../../engine/vision-gpu/types.js").WarmState;
  try {
    warmState = await runtime.ensureWarm(warmTarget);
  } catch (err) {
    console.error("[visual-provider] ensureWarm failed:", err);
    return probeLane("visual_gpu", "failed", { ...asked, why: "ensure_warm_threw" }, { candidates: [], warnings: ["visual_provider_failed"] });
  }

  if (warmState === "cold" || warmState === "warming") {
    // Pipeline not ready yet — let the caller know so LLM can retry.
    return probeLane("visual_gpu", "skipped", { ...asked, why: "warming", warmState }, { candidates: [], warnings: ["visual_provider_warming"] });
  }

  if (warmState === "evicted") {
    // Evicted means session was torn down but backend is still attached.
    // Retry once — ensureWarm should rebuild the session on re-call.
    try {
      warmState = await runtime.ensureWarm(warmTarget);
    } catch {
      return probeLane("visual_gpu", "failed", { ...asked, why: "ensure_warm_threw", warmState: "evicted" }, { candidates: [], warnings: ["visual_provider_failed"] });
    }
    if (warmState !== "warm") {
      return probeLane("visual_gpu", "skipped", { ...asked, why: "warming", warmState }, { candidates: [], warnings: ["visual_provider_warming"] });
    }
  }

  // warm — fetch stable candidates from the backend.
  try {
    const candidates = await runtime.getStableCandidates(targetKey);
    // Empty candidates when warm is valid — the GPU pipeline may not have any
    // stable tracks yet. No warning emitted (distinct from "unavailable").
    //
    // **Unless the backend cannot look at all**, which is the default build: `PocVisualBackend`
    // replays injected snapshots and recognises nothing, yet it warms in 50 ms and answers `[]`
    // exactly like a real pipeline that found no stable track. The caller was told neither, and the
    // case where it matters is the one the visual lane exists for — a window whose buttons are
    // PAINTED came back with the title bar's four elements and no note, when the honest answer was
    // "the part you care about was never looked at" (win2, 2026-09-10).
    //
    // Only when the answer is empty: a backend that replays something HAS produced candidates for
    // this target, and saying it cannot look would be false about the answer in hand.
    if (candidates.length === 0 && runtime.recognitionCapability() === "replays_injected_only") {
      return probeLane("visual_gpu", "read", { ...asked, warmState }, { candidates, warnings: ["visual_backend_cannot_recognise"] });
    }
    return probeLane("visual_gpu", "read", { ...asked, warmState }, { candidates, warnings: [] });
  } catch (err) {
    console.error("[visual-provider] getStableCandidates failed:", err);
    return probeLane("visual_gpu", "failed", { ...asked, warmState }, { candidates: [], warnings: ["visual_provider_failed"] });
  }
}
