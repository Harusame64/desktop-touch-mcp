/**
 * compose-providers.ts — Selects and merges candidate providers based on target type.
 *
 * Routing policy:
 *   tabId present            → browser (primary) + visual (additive)
 *   hwnd/title is terminal   → terminal (primary) + uia (additive, for structured overlay)
 *   hwnd/title is window     → uia (primary) + visual (additive)
 *
 * "Additive" means: a provider's results are merged INTO the candidate list; they
 * do not replace other sources. The resolver deduplicates by digest/label+rect,
 * so overlap between sources naturally produces cross-source entities.
 *
 * Warnings from all providers are collected and deduplicated. Rejection of one
 * provider does not prevent others from contributing candidates.
 *
 * Warning codes emitted here:
 *   no_provider_matched               — target omitted and foreground window could not be resolved
 *   partial_results_only              — primary provider returned 0 entities; fallback attempted
 *   visual_not_attempted              — (H4) visual lane was unready (unavailable/warming) on a blind target
 *   visual_attempted_empty            — (H4) visual lane ran warm but produced no candidates on a blind target
 *   visual_attempted_empty_cdp_fallback — (H4) CDP failed and visual also empty (browser target)
 */

import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import { fetchUiaCandidates }      from "./uia-provider.js";
import { fetchBrowserCandidates }  from "./browser-provider.js";
import { fetchTerminalCandidates } from "./terminal-provider.js";
import { fetchVisualCandidates }   from "./visual-provider.js";
import { fetchOcrCandidates }      from "./ocr-provider.js";
import { resolveWindowTarget }     from "../_resolve-window.js";

// ── G4: transient visual warnings trigger a single 200ms retry ────────────────
// Covers the first-request race where VisualRuntime.attach() (fire-and-forget in
// desktop-register.ts) has not completed yet (unavailable) or the backend has
// attached but warmup is still in flight (warming). Retry once with a short
// delay; if the warning persists, return it and let the caller continue on the
// structured lane.
const VISUAL_TRANSIENT_WARNINGS = new Set([
  "visual_provider_unavailable",
  "visual_provider_warming",
]);
const VISUAL_RETRY_DELAY_MS = 200;

async function fetchVisualCandidatesWithRetry(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  const first = await fetchVisualCandidates(target);
  const isTransient = first.warnings.some((w) => VISUAL_TRANSIENT_WARNINGS.has(w));
  if (!isTransient) return first;

  await new Promise<void>((resolve) => setTimeout(resolve, VISUAL_RETRY_DELAY_MS));
  return fetchVisualCandidates(target);
}

/**
 * Heuristic terminal title patterns.
 *
 * Design notes:
 * - Use word boundaries (\b) for short tokens like "sh", "wsl", "cmd" to avoid
 *   matching "Photoshop", "Dashboard", "cmd inside longer title", etc.
 * - "cmd.exe" doesn't appear in window titles — use "Command Prompt" instead.
 * - "terminal" is a common substring — anchor with \b to reduce false positives.
 *
 * A future improvement: prefer processName checks (more reliable than title).
 */
const TERMINAL_TITLE_PATTERN =
  /powershell|\bcommand prompt\b|\bterminal\b|\bbash\b|\b(wsl|zsh|fish|ksh|sh)\b|git.?bash|conemu|mintty/i;

export function isTerminalTarget(target: TargetSpec | undefined): boolean {
  return TERMINAL_TITLE_PATTERN.test(target?.windowTitle ?? "");
}

export function isBrowserTarget(target: TargetSpec | undefined): boolean {
  return Boolean(target?.tabId);
}

function mergeResults(results: ProviderResult[]): ProviderResult {
  const candidates = results.flatMap((r) => r.candidates);
  // Deduplicate warnings while preserving order.
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const r of results) {
    for (const w of r.warnings) {
      if (!seen.has(w)) { seen.add(w); warnings.push(w); }
    }
  }
  return { candidates, warnings };
}

function addWarningIfPartial(result: ProviderResult, primaryCount: number): ProviderResult {
  if (primaryCount === 0 && result.candidates.length === 0) return result;
  if (primaryCount === 0 && result.candidates.length > 0) {
    // Primary returned nothing but additive providers contributed — flag as partial.
    if (!result.warnings.includes("partial_results_only")) {
      return { ...result, warnings: [...result.warnings, "partial_results_only"] };
    }
  }
  return result;
}

// ── H4: visual escalation ─────────────────────────────────────────────────────
// When structured lanes (UIA / CDP) cannot surface actionable entities due to
// renderer opacity, surface the visual lane's outcome for explainability.
// Call frequency is NOT increased — only the interpretation of existing results.
//
// Scope: applied to "uia" (native window) and "browser" primary routes only.
// Terminal route is excluded intentionally: terminal provider is the primary
// there, and uia is additive. Even if uia is blind, the terminal buffer is the
// authoritative source — visual escalation would add noise, not signal.

const UIA_BLIND_WARNINGS   = new Set(["uia_blind_single_pane", "uia_blind_too_few_elements"]);
const VISUAL_UNREADY_WARNINGS = new Set(["visual_provider_unavailable", "visual_provider_warming"]);

function applyVisualEscalation(
  primaryResult: ProviderResult,
  visualResult: ProviderResult,
  primaryKind: "uia" | "browser",
): string[] {
  const extra: string[] = [];
  const uiaBlind      = primaryResult.warnings.some((w) => UIA_BLIND_WARNINGS.has(w));
  const cdpFailed     = primaryResult.warnings.includes("cdp_provider_failed");
  const visualUnready = visualResult.warnings.some((w) => VISUAL_UNREADY_WARNINGS.has(w));
  const visualEmpty   = visualResult.candidates.length === 0;

  // Rule-A: uia blind + visual backend unready → visual_not_attempted
  if (primaryKind === "uia" && uiaBlind && visualUnready) {
    extra.push("visual_not_attempted");
  }
  // Rule-A': uia blind + visual warm but empty → visual_attempted_empty
  if (primaryKind === "uia" && uiaBlind && !visualUnready && visualEmpty) {
    extra.push("visual_attempted_empty");
  }
  // Rule-C: browser CDP failed + visual also empty → visual_attempted_empty_cdp_fallback
  if (primaryKind === "browser" && cdpFailed && visualEmpty) {
    extra.push("visual_attempted_empty_cdp_fallback");
  }
  return extra;
}

function withPrependedWarnings(result: ProviderResult, warnings: string[]): ProviderResult {
  if (warnings.length === 0) return result;
  const seen = new Set<string>();
  const mergedWarnings: string[] = [];
  for (const warning of [...warnings, ...result.warnings]) {
    if (!seen.has(warning)) {
      seen.add(warning);
      mergedWarnings.push(warning);
    }
  }
  return { ...result, warnings: mergedWarnings };
}

async function normalizeTarget(
  target: TargetSpec | undefined
): Promise<{ target: TargetSpec | undefined; warnings: string[] }> {
  if (target?.tabId) {
    return { target, warnings: [] };
  }

  if (target?.hwnd && !target.windowTitle) {
    try {
      const resolved = await resolveWindowTarget({ hwnd: target.hwnd });
      if (!resolved) return { target, warnings: [] };
      return {
        target: {
          ...target,
          hwnd: target.hwnd,
          windowTitle: resolved.title,
        },
        warnings: resolved.warnings,
      };
    } catch {
      return { target, warnings: [] };
    }
  }

  // H3: plain windowTitle without hwnd — try dialog resolution (case 4 in _resolve-window.ts).
  // resolveWindowTarget returns null when a top-level window matches (preserving existing behaviour).
  // Only dialog-fallback results (dialog_resolved_via_owner_chain) change the effective target.
  if (target?.windowTitle && !target.hwnd) {
    try {
      const resolved = await resolveWindowTarget({ windowTitle: target.windowTitle });
      if (resolved) {
        return {
          target: { ...target, hwnd: resolved.hwnd.toString(), windowTitle: resolved.title },
          warnings: resolved.warnings,
        };
      }
    } catch { /* fall through */ }
    return { target, warnings: [] };
  }

  if (target?.windowTitle) {  // hwnd + windowTitle: pass through as before
    return { target, warnings: [] };
  }

  try {
    const resolved = await resolveWindowTarget({ windowTitle: "@active" });
    if (!resolved) return { target: undefined, warnings: ["no_provider_matched"] };
    return {
      target: {
        hwnd: resolved.hwnd.toString(),
        windowTitle: resolved.title,
      },
      warnings: resolved.warnings,
    };
  } catch {
    return { target: undefined, warnings: ["no_provider_matched"] };
  }
}

/**
 * Fetch candidates from all appropriate providers and return merged result + warnings.
 * Uses Promise.allSettled so one failing provider doesn't block others.
 */
export async function composeCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  const normalized = await normalizeTarget(target);
  if (!normalized.target) {
    return { candidates: [], warnings: normalized.warnings };
  }
  target = normalized.target;

  if (isBrowserTarget(target)) {
    const [browser, visual] = await Promise.allSettled([
      fetchBrowserCandidates(target),
      fetchVisualCandidatesWithRetry(target),
    ]);
    const browserResult = browser.status === "fulfilled"
      ? browser.value
      : { candidates: [], warnings: ["cdp_provider_failed"] };
    const visualResult  = visual.status  === "fulfilled"
      ? visual.value
      : { candidates: [], warnings: ["visual_provider_unavailable"] };

    const merged     = mergeResults([browserResult, visualResult]);
    const escalation = applyVisualEscalation(browserResult, visualResult, "browser");
    const extra      = escalation.filter((w) => !merged.warnings.includes(w));
    const finalMerged = extra.length > 0
      ? { ...merged, warnings: [...merged.warnings, ...extra] }
      : merged;

    return withPrependedWarnings(
      addWarningIfPartial(finalMerged, browserResult.candidates.length),
      normalized.warnings
    );
  }

  if (isTerminalTarget(target)) {
    const [terminal, uia, visual] = await Promise.allSettled([
      fetchTerminalCandidates(target),
      fetchUiaCandidates(target),
      fetchVisualCandidatesWithRetry(target),
    ]);
    const termResult   = terminal.status === "fulfilled" ? terminal.value : { candidates: [], warnings: ["terminal_provider_failed"] };
    const uiaResult    = uia.status      === "fulfilled" ? uia.value      : { candidates: [], warnings: ["uia_provider_failed"] };
    const visualResult = visual.status   === "fulfilled" ? visual.value   : { candidates: [], warnings: ["visual_provider_unavailable"] };

    return withPrependedWarnings(
      addWarningIfPartial(
        mergeResults([termResult, uiaResult, visualResult]),
        termResult.candidates.length
      ),
      normalized.warnings
    );
  }

  // Native Windows window: UIA primary + visual additive.
  const [uia, visual] = await Promise.allSettled([
    fetchUiaCandidates(target),
    fetchVisualCandidatesWithRetry(target),
  ]);
  const uiaResult    = uia.status    === "fulfilled" ? uia.value    : { candidates: [], warnings: ["uia_provider_failed"] };
  const visualResult = visual.status === "fulfilled" ? visual.value : { candidates: [], warnings: ["visual_provider_unavailable"] };

  // OCR lane: additive, UIA-blind targets only.
  // Builds a label dictionary from UIA candidates for snap-correction inside runSomPipeline.
  const uiaBlindForOcr = uiaResult.warnings.some((w) => UIA_BLIND_WARNINGS.has(w));
  const ocrResult: ProviderResult = uiaBlindForOcr
    ? await fetchOcrCandidates(
        target,
        uiaResult.candidates
          .filter((c) => c.label && c.rect)
          .map((c) => ({ label: c.label!, rect: c.rect })),
      ).catch((): ProviderResult => ({ candidates: [], warnings: ["ocr_provider_failed"] }))
    : { candidates: [], warnings: [] };

  const merged     = mergeResults([uiaResult, visualResult, ocrResult]);
  const escalation = applyVisualEscalation(uiaResult, visualResult, "uia");
  const extra      = escalation.filter((w) => !merged.warnings.includes(w));
  const finalMerged = extra.length > 0
    ? { ...merged, warnings: [...merged.warnings, ...extra] }
    : merged;

  return withPrependedWarnings(
    addWarningIfPartial(finalMerged, uiaResult.candidates.length),
    normalized.warnings
  );
}
