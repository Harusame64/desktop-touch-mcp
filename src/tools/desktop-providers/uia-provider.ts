/**
 * uia-provider.ts — UIA candidate provider for native Windows windows.
 *
 * Uses getUiElements() with hwnd option when available (precise, no title ambiguity).
 * Falls back to windowTitle when only a title is given.
 * Populates locator.uia for every candidate.
 *
 * Warnings:
 *   uia_provider_failed       — getUiElements threw or returned an error
 *   uia_no_elements           — window found but no actionable elements returned
 *   uia_blind_single_pane     — (H4) UIA tree is a single giant Pane (PWA/Electron/canvas)
 *   uia_blind_too_few_elements — (H4) UIA tree element count below threshold
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";

function uiaRoleFromControlType(ct: string): string {
  const map: Record<string, string> = {
    Button: "button", CheckBox: "button", RadioButton: "button",
    Edit: "textbox", ComboBox: "textbox",
    Hyperlink: "link", MenuItem: "menuitem",
    Text: "label", Document: "label",
  };
  return map[ct] ?? "unknown";
}

function uiaActionability(ct: string): Array<"click" | "invoke" | "type" | "read"> {
  if (["Button", "CheckBox", "RadioButton", "Hyperlink", "MenuItem"].includes(ct)) return ["invoke", "click"];
  if (["Edit", "ComboBox"].includes(ct)) return ["type", "click"];
  return ["read"];
}

/**
 * Issue #296 (Opus R1 P1) — canonicalise the UIA pattern-name wire form.
 *
 * The Rust native path (`src/uia/tree.rs`) emits the short form
 * (`"Invoke"` / `"Value"` / `"Toggle"` / `"SelectionItem"` /
 * `"ExpandCollapse"` / `"Scroll"`) while the PowerShell fallback
 * (`makeGetElementsScript` in `uia-bridge.ts`) emits the suffixed form
 * (`"InvokePattern"` / `"ValuePattern"` / …). Without this normalisation,
 * `CapabilityRegistry.lookup` would silently inverse-classify every Rust-path
 * entity (matching `"InvokePattern"` against `"Invoke"` always misses).
 *
 * Canonicalisation target: the `*Pattern`-suffixed form, which matches the
 * documented Microsoft UI Automation pattern names ("Invoke Pattern" →
 * `InvokePattern`). Pre-suffixed strings pass through unchanged.
 *
 * Exported for unit testing.
 */
export function normalizeUiaPatternNames(patterns: string[] | undefined): string[] {
  if (patterns === undefined) return [];
  return patterns.map((p) => (p.endsWith("Pattern") ? p : `${p}Pattern`));
}

export async function fetchUiaCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  if (!target || (!target.hwnd && !target.windowTitle)) {
    return { candidates: [], warnings: [] };
  }

  const windowTitle = target.windowTitle ?? target.hwnd ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";

  try {
    const { getUiElements, detectUiaBlind } = await import("../../engine/uia-bridge.js");

    // hwnd invariant: always decimal string (bigint as decimal, per codebase convention)
    const options = target.hwnd ? { hwnd: BigInt(target.hwnd) } : undefined;
    const result  = await getUiElements(windowTitle, 4, 80, 8000, options);

    const candidates: UiEntityCandidate[] = result.elements
      .filter((el) => el.isEnabled && el.name)
      .map((el): UiEntityCandidate => ({
        source: "uia",
        target: { kind: "window", id: targetId },
        locator: { uia: { automationId: el.automationId || undefined, name: el.name } },
        role: uiaRoleFromControlType(el.controlType),
        label: el.name,
        value: el.value,
        rect: el.boundingRect ?? undefined,
        actionability: uiaActionability(el.controlType),
        // Issue #296: carry the UIA-side `controlType` and `patterns` through
        // so `CapabilityRegistry.lookup` can advertise executor preferences
        // at discover time (no extra UIA round-trip — `getUiElements` already
        // collected both via `GetSupportedPatterns()`). Patterns are normalised
        // here because the Rust native path (`src/uia/tree.rs`) emits the
        // short form (`"Invoke"`, `"Value"`, `"Toggle"`, …) while the
        // PowerShell fallback (`makeGetElementsScript`) emits the suffixed
        // form (`"InvokePattern"`, …). Downstream consumers (most importantly
        // `CapabilityRegistry.lookup`) see a single canonical shape.
        controlType: el.controlType,
        patterns: normalizeUiaPatternNames(el.patterns),
        confidence: 1.0,
        observedAtMs: Date.now(),
        provisional: false,
      }));

    const warnings: string[] = candidates.length === 0 ? ["uia_no_elements"] : [];

    // H4: detect UIA-blind conditions (single-giant-pane / too-few-elements)
    // so that compose-providers can escalate visual lane explainability.
    const blind = detectUiaBlind(result);
    if (blind.blind) {
      if (blind.reason === "single-giant-pane")  warnings.push("uia_blind_single_pane");
      else if (blind.reason === "too-few-elements") warnings.push("uia_blind_too_few_elements");
    }

    return { candidates, warnings };
  } catch (err) {
    console.error(`[uia-provider] Error for target "${targetId}":`, err);
    return { candidates: [], warnings: ["uia_provider_failed"] };
  }
}
