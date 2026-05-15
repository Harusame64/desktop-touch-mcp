/**
 * desktop-capabilities.ts — Issue #296.
 *
 * Pure derivation of `EntityCapabilities` from a `UiEntity`. Reads UIA
 * `controlType` + `patterns` (carried through the candidate → resolver →
 * entity chain) and emits executor preferences so the LLM does not waste a
 * round-trip on `click_element` against a target that does not expose
 * `InvokePattern` (ListItem / TabItem / TreeItem / custom-drawn checkbox /
 * custom-drawn button — Issue #296 user report).
 *
 * No I/O, no extra UIA round-trips — the pattern set was already collected
 * at discover time by `getUiElements`'s underlying `GetSupportedPatterns()`
 * call (Rust native path: `src/uia/tree.rs`; PowerShell fallback:
 * `makeGetElementsScript` in `uia-bridge.ts`).
 *
 * **Pattern-name canonicalisation lives upstream** in
 * `uia-provider.ts::normalizeUiaPatternNames` (Issue #296 / Opus R1 P1) —
 * the Rust path emits the short form (`"Invoke"`) while the PowerShell path
 * emits the suffixed form (`"InvokePattern"`). The provider normalises both
 * to the `*Pattern`-suffixed form before they reach this module, so the rule
 * table below can match by exact string equality without case-folding or
 * suffix probing.
 */

import type { UiEntity } from "../engine/world-graph/types.js";
import type { EntityCapabilities, ViewConstraints } from "./desktop-constraints.js";

// NB: `UiEntityCandidate.actionability` (set by `uia-provider.ts::uiaActionability`)
// is a legacy controlType-based hint about what verbs the resolver may expand
// into affordances. It is NOT the same signal as `EntityCapabilities` — when
// the two disagree, `EntityCapabilities` is authoritative for executor
// selection (it is derived from actual `GetSupportedPatterns()` data, not
// just controlType heuristics). Future PR may collapse the two surfaces.

/**
 * UIA pattern names this rule table recognises. Strings are the wire-form
 * values emitted by both the Rust native path and the PowerShell fallback.
 */
const INVOKE_PATTERN = "InvokePattern";
const VALUE_PATTERN = "ValuePattern";
const TOGGLE_PATTERN = "TogglePattern";

/**
 * UIA control types that historically refuse `Invoke` even though the LLM
 * tends to treat them as clickable — TabItem / TreeItem / ListItem (Issue
 * #296 user report). Selection happens via `SelectionItemPattern`, not
 * `Invoke`, and the UIA executor in this codebase only routes the `click`
 * verb through `InvokePattern` today. Keep this list conservative — expanding
 * it should require a fresh dogfood report rather than speculation.
 */
const SELECTION_ONLY_CONTROLS = new Set(["ListItem", "TabItem", "TreeItem"]);

/**
 * Derive entity capabilities. Returns `undefined` when no signal is available
 * (e.g. CDP-only entity, visual-only entity with no rect, UIA entity with
 * neither Invoke nor a known fallback) — the existing default-dispatch path
 * is then the correct response.
 *
 * Optional `viewConstraints` argument lets the caller propagate view-level
 * UIA failure state (`constraints.uia === "provider_failed"`) so UIA-sourced
 * entities in a UIA-blind view bias toward mouse even when their pattern set
 * looks fine.
 */
export function deriveEntityCapabilities(
  entity: UiEntity,
  viewConstraints?: ViewConstraints,
): EntityCapabilities | undefined {
  const isUiaSource = entity.sources.includes("uia");
  const hasRect = entity.rect !== undefined;
  const patterns = entity.patterns ?? [];
  const controlType = entity.controlType;

  const uiaProviderFailed = viewConstraints?.uia === "provider_failed";

  // Visual-only entity (SOM / GPU lane found a rect but no UIA element).
  // Mouse is the only viable executor.
  if (!isUiaSource) {
    if (!hasRect) return undefined;
    return {
      preferredExecutors: ["mouse"],
      unsupportedExecutors: ["uia"],
    };
  }

  // From here the entity is UIA-sourced.
  const hasInvoke = patterns.includes(INVOKE_PATTERN);
  const hasToggle = patterns.includes(TOGGLE_PATTERN);
  const hasValue = patterns.includes(VALUE_PATTERN);
  const isSelectionOnly =
    controlType !== undefined && SELECTION_ONLY_CONTROLS.has(controlType);

  // Provider-level UIA failure (warnings emitted `uia_provider_failed` etc.).
  // Bias every UIA-sourced entity in this view toward mouse — the UIA
  // executor will likely hit the same failure the provider already saw.
  if (uiaProviderFailed) {
    if (!hasRect) return undefined;
    return {
      preferredExecutors: ["mouse"],
      unsupportedExecutors: ["uia"],
      fallbackHint: "use mouse_click — UIA provider failed for this view",
    };
  }

  // Case 1: InvokePattern available → standard happy path. UIA `click` verb
  // succeeds (Invoke); mouse is the natural fallback if the visible region
  // shifts after focus.
  if (hasInvoke) {
    return {
      preferredExecutors: ["uia", "mouse"],
    };
  }

  // Case 2: SelectionItem-style controls (ListItem / TabItem / TreeItem)
  // without Invoke. The UIA executor's `click` verb maps to Invoke, which
  // fails with `InvokePatternNotSupported`. Steer to mouse_click directly so
  // the LLM does not pay a round-trip discovering this.
  if (isSelectionOnly && hasRect) {
    return {
      preferredExecutors: ["mouse"],
      unsupportedExecutors: ["uia"],
      fallbackHint: `use mouse_click — UIA InvokePattern not exposed on ${controlType ?? "this control"}`,
    };
  }

  // Case 3: TogglePattern-only entity (custom checkboxes without Invoke).
  // The current UIA executor does not yet implement Toggle, so until that
  // lands (ADR-018 Phase 5 carry-over) the truthful recommendation is mouse.
  // We deliberately do NOT advertise `preferredExecutors:['uia']` here —
  // that would lie to the LLM about today's executor surface.
  if (hasToggle && hasRect) {
    return {
      preferredExecutors: ["mouse"],
      unsupportedExecutors: ["uia"],
      fallbackHint: "use mouse_click — UIA executor does not yet implement TogglePattern",
    };
  }

  // Case 4: ValuePattern-bearing entity (Edit / ComboBox / Document) with
  // no Invoke. UIA `setValue` is the right path for value updates; we steer
  // typing toward UIA. The mouse stays available as a `click`/focus fallback
  // via default dispatch (no `unsupportedExecutors`).
  if (hasValue) {
    return {
      preferredExecutors: ["uia"],
    };
  }

  // Case 5: UIA-sourced but no actionable pattern (Text / Image labels,
  // ScreenReader-only entities). Mouse may still hit the rect if it
  // represents a visible widget.
  if (hasRect) {
    return {
      preferredExecutors: ["mouse"],
      unsupportedExecutors: ["uia"],
    };
  }

  // No rect, no patterns → nothing actionable.
  return undefined;
}
