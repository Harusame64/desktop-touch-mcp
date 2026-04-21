/**
 * uia-provider.ts — UIA candidate provider for native Windows windows.
 *
 * Uses getUiElements() with hwnd when available (precise, no title ambiguity).
 * Falls back to windowTitle when only a title is given.
 * Populates locator.uia for every candidate.
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";

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
): Promise<UiEntityCandidate[]> {
  if (!target || (!target.hwnd && !target.windowTitle)) return [];

  const windowTitle = target.windowTitle ?? target.hwnd ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";

  try {
    const { getUiElements } = await import("../../engine/uia-bridge.js");

    // Use hwnd option when available — avoids title-substring ambiguity and is
    // more robust for windows whose titles change (e.g. document editors).
    const options = target.hwnd
      ? { hwnd: BigInt(target.hwnd) }
      : undefined;

    const result = await getUiElements(windowTitle, 4, 80, 8000, options);

    return result.elements
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
  } catch (err) {
    console.error(`[uia-provider] Error for target "${targetId}":`, err);
    return [];
  }
}
