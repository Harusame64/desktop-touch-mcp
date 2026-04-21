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
 * Errors in individual providers are silenced (each logs to stderr and returns []).
 * compose() always returns a flat deduplicated candidate list.
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import { fetchUiaCandidates }      from "./uia-provider.js";
import { fetchBrowserCandidates }  from "./browser-provider.js";
import { fetchTerminalCandidates } from "./terminal-provider.js";
import { fetchVisualCandidates }   from "./visual-provider.js";

/** Common terminal process name patterns for heuristic detection. */
const TERMINAL_TITLE_PATTERN = /powershell|cmd\.exe|command prompt|terminal|bash|wsl|sh|git.?bash|conemu|mintty/i;

export function isTerminalTarget(target: TargetSpec | undefined): boolean {
  return TERMINAL_TITLE_PATTERN.test(target?.windowTitle ?? "");
}

export function isBrowserTarget(target: TargetSpec | undefined): boolean {
  return Boolean(target?.tabId);
}

/**
 * Fetch candidates from all appropriate providers and return the merged list.
 * Each provider result is appended; the resolver handles cross-source deduplication.
 */
export async function composeCandidates(
  target: TargetSpec | undefined
): Promise<UiEntityCandidate[]> {
  const all: UiEntityCandidate[] = [];

  if (isBrowserTarget(target)) {
    // Browser tab: CDP is the primary structured source.
    const [browser, visual] = await Promise.allSettled([
      fetchBrowserCandidates(target),
      fetchVisualCandidates(target),
    ]);
    if (browser.status === "fulfilled") all.push(...browser.value);
    if (visual.status  === "fulfilled") all.push(...visual.value);

  } else if (isTerminalTarget(target)) {
    // Terminal window: terminal buffer is primary; UIA adds control structure.
    const [terminal, uia, visual] = await Promise.allSettled([
      fetchTerminalCandidates(target),
      fetchUiaCandidates(target),
      fetchVisualCandidates(target),
    ]);
    if (terminal.status === "fulfilled") all.push(...terminal.value);
    if (uia.status      === "fulfilled") all.push(...uia.value);
    if (visual.status   === "fulfilled") all.push(...visual.value);

  } else {
    // Native Windows window: UIA is primary; visual GPU as additive overlay.
    const [uia, visual] = await Promise.allSettled([
      fetchUiaCandidates(target),
      fetchVisualCandidates(target),
    ]);
    if (uia.status    === "fulfilled") all.push(...uia.value);
    if (visual.status === "fulfilled") all.push(...visual.value);
  }

  return all;
}
