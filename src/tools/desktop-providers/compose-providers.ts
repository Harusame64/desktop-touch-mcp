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
 *   no_provider_matched  — target omitted and foreground window could not be resolved
 *   partial_results_only — primary provider returned 0 entities; fallback attempted
 */

import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import { fetchUiaCandidates }      from "./uia-provider.js";
import { fetchBrowserCandidates }  from "./browser-provider.js";
import { fetchTerminalCandidates } from "./terminal-provider.js";
import { fetchVisualCandidates }   from "./visual-provider.js";
import { resolveWindowTarget }     from "../_resolve-window.js";

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

  if (target?.windowTitle) {
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
      fetchVisualCandidates(target),
    ]);
    const browserResult = browser.status === "fulfilled"
      ? browser.value
      : { candidates: [], warnings: ["cdp_provider_failed"] };
    const visualResult  = visual.status  === "fulfilled"
      ? visual.value
      : { candidates: [], warnings: ["visual_provider_unavailable"] };

    return withPrependedWarnings(
      addWarningIfPartial(
        mergeResults([browserResult, visualResult]),
        browserResult.candidates.length
      ),
      normalized.warnings
    );
  }

  if (isTerminalTarget(target)) {
    const [terminal, uia, visual] = await Promise.allSettled([
      fetchTerminalCandidates(target),
      fetchUiaCandidates(target),
      fetchVisualCandidates(target),
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
    fetchVisualCandidates(target),
  ]);
  const uiaResult    = uia.status    === "fulfilled" ? uia.value    : { candidates: [], warnings: ["uia_provider_failed"] };
  const visualResult = visual.status === "fulfilled" ? visual.value : { candidates: [], warnings: ["visual_provider_unavailable"] };

  return withPrependedWarnings(
    addWarningIfPartial(
      mergeResults([uiaResult, visualResult]),
      uiaResult.candidates.length
    ),
    normalized.warnings
  );
}
