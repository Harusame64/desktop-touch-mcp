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

function targetKeyFromSpec(target: TargetSpec | undefined): string {
  if (target?.hwnd)        return `window:${target.hwnd}`;
  if (target?.tabId)       return `tab:${target.tabId}`;
  if (target?.windowTitle) return `title:${target.windowTitle}`;
  return "window:__default__";
}

export async function fetchVisualCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  const runtime = getVisualRuntime();

  if (!runtime.isAvailable()) {
    // No backend attached — Phase 2 stub behavior.
    return { candidates: [], warnings: ["visual_provider_unavailable"] };
  }

  const targetKey  = targetKeyFromSpec(target);
  const warmTarget = targetKeyToWarmTarget(targetKey);

  let warmState: import("../../engine/vision-gpu/types.js").WarmState;
  try {
    warmState = await runtime.ensureWarm(warmTarget);
  } catch (err) {
    console.error("[visual-provider] ensureWarm failed:", err);
    return { candidates: [], warnings: ["visual_provider_failed"] };
  }

  if (warmState === "cold" || warmState === "warming") {
    // Pipeline not ready yet — let the caller know so LLM can retry.
    return { candidates: [], warnings: ["visual_provider_warming"] };
  }

  if (warmState === "evicted") {
    // Evicted means session was torn down but backend is still attached.
    // Retry once — ensureWarm should rebuild the session on re-call.
    try {
      warmState = await runtime.ensureWarm(warmTarget);
    } catch {
      return { candidates: [], warnings: ["visual_provider_failed"] };
    }
    if (warmState !== "warm") {
      return { candidates: [], warnings: ["visual_provider_warming"] };
    }
  }

  // warm — fetch stable candidates from the backend.
  try {
    const candidates = await runtime.getStableCandidates(targetKey);
    // Empty candidates when warm is valid — the GPU pipeline may not have any
    // stable tracks yet. No warning emitted (distinct from "unavailable").
    return { candidates, warnings: [] };
  } catch (err) {
    console.error("[visual-provider] getStableCandidates failed:", err);
    return { candidates: [], warnings: ["visual_provider_failed"] };
  }
}
