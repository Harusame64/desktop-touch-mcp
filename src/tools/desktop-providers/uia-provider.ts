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
import { parseTargetHwnd, type TargetSpec } from "../../engine/world-graph/session-registry.js";
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

  // ADR-036 — the handle is not a title. It used to stand in for one here, so a session known
  // only by handle asked UIA for a window whose *name* contains the handle's digits; and when
  // both were present the title won, which is how the read half could enumerate one window
  // while the write half addressed another.
  const windowTitle = target.windowTitle ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";
  // ADR-036 — the same parse the write half uses, so one malformed handle cannot make the two
  // halves aim at different windows. `BigInt(target.hwnd)` here used to throw straight out of
  // the provider.
  const pinned = parseTargetHwnd(target);
  // …and the OCR lane says so when a handle cannot be read, while this lane went quiet about the
  // same value in the same discover. With the handle unread there is no scoping, so this reads
  // `windowTitle` — the caller's title if it passed one, the FOREGROUND window if it did not —
  // while every candidate still carries the caller's raw handle string as its target id
  // (2ゲート目の指摘).
  const hwndWarnings = pinned === undefined && target.hwnd ? ["target_hwnd_unparseable"] : [];

  try {
    const { getUiElements, detectUiaBlind } = await import("../../engine/uia-bridge.js");

    // `pinnedHwnd` asks the bridge to SCOPE the read to this window, through `FromHandle`
    // (ADR-036). It keys the cache too, but only because a scoped read is the one thing that can
    // vouch for which window it describes — the bridge will not file a title-derived tree under
    // a handle nobody scoped to. Passing `hwnd` as well was a way to prime the cache back when
    // the read could still go by title; now it would say nothing the scoped read does not.
    const options = pinned !== undefined ? { pinnedHwnd: pinned } : undefined;
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

    const warnings: string[] = [
      ...hwndWarnings,
      // ADR-036 — a pinned read is the PowerShell walk, and that walk stops when the caller's
      // deadline runs out. Publishing the prefix is right (a partial view is still a view), but
      // publishing it as though it were the window is not: whatever was still on the stack is
      // missing, and the caller cannot tell that from a window that simply has fewer elements
      // (2ゲート目の指摘). `_narration` refuses a truncated tree outright because it DIFFS two of
      // them; discover only has to say so.
      ...(result.truncated ? ["uia_tree_truncated"] : []),
      ...(candidates.length === 0 ? ["uia_no_elements"] : []),
    ];

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
    return { candidates: [], warnings: [...hwndWarnings, "uia_provider_failed"] };
  }
}
