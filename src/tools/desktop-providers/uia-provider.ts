/**
 * uia-provider.ts — UIA candidate provider for native Windows windows.
 *
 * Uses getUiElements() with hwnd option when available (precise, no title ambiguity).
 * Falls back to windowTitle when only a title is given.
 * Populates locator.uia for every candidate.
 *
 * Warnings:
 *   uia_provider_failed — getUiElements threw or returned an error
 *   uia_no_elements     — window found but no actionable elements returned
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

export async function fetchUiaCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  if (!target || (!target.hwnd && !target.windowTitle)) {
    return { candidates: [], warnings: [] };
  }

  const windowTitle = target.windowTitle ?? target.hwnd ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";

  try {
    const { getUiElements } = await import("../../engine/uia-bridge.js");

    // hwnd invariant: always decimal string (bigint as decimal, per codebase convention)
    const options = target.hwnd ? { hwnd: BigInt(target.hwnd) } : undefined;
    const result  = await getUiElements(windowTitle, 4, 80, 8000, options);

    const candidates: UiEntityCandidate[] = result.elements
      .filter((el) => el.isEnabled && el.name)
      .map((el): UiEntityCandidate => ({
        source: "uia",
        target: { kind: "window", id: targetId },
        sourceId: el.automationId || undefined,
        locator: { uia: { automationId: el.automationId || undefined, name: el.name } },
        role: uiaRoleFromControlType(el.controlType),
        label: el.name,
        value: el.value,
        rect: el.boundingRect ?? undefined,
        actionability: uiaActionability(el.controlType),
        confidence: 1.0,
        observedAtMs: Date.now(),
        provisional: false,
      }));

    const warnings = candidates.length === 0 ? ["uia_no_elements"] : [];
    return { candidates, warnings };
  } catch (err) {
    console.error(`[uia-provider] Error for target "${targetId}":`, err);
    return { candidates: [], warnings: ["uia_provider_failed"] };
  }
}
