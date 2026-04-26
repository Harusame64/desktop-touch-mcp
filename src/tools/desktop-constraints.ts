/**
 * desktop-constraints.ts — Derives ViewConstraints from provider warnings.
 *
 * Single source of truth: ProviderResult.warnings[] (set by providers / compose-providers).
 * ViewConstraints is an additive structured overlay — warnings[] is preserved as-is.
 * Returns undefined when no constraint-relevant warnings are present (field stays absent from JSON).
 */

/**
 * View-level negative capability hints.
 * Derived deterministically from warnings[]. Absent field = no constraint known for that provider.
 *
 * Extension policy: new values are always ADDITIVE (new enum literal or new field).
 * Existing values are never renamed — deprecation requires a minor-version notice
 * and a 1-release alias period before removal.
 */
export interface ViewConstraints {
  /**
   * UIA lane unable to surface meaningful entities for this target.
   * Priority: blind_single_pane > blind_too_few_elements > provider_failed
   * (blind_single_pane is always set when present, regardless of order in warnings[]).
   */
  uia?: "blind_single_pane" | "blind_too_few_elements" | "provider_failed";
  /** CDP lane unavailable or failed (browser targets only). */
  cdp?: "provider_failed";
  /**
   * Visual lane status when structured lane was blind/failed.
   * not_attempted → GPU backend unready (retry later or use V1 screenshot).
   * attempted_empty → visual lane ran but produced no candidates.
   * provider_unavailable / provider_warming → transient; compose retried once already.
   */
  visual?: "not_attempted" | "attempted_empty" | "provider_unavailable" | "provider_warming";
  /** Terminal provider status (terminal targets only). */
  terminal?: "buffer_empty" | "provider_failed";
  /**
   * Foreground window resolution failure.
   * Only "no_provider_matched" is a true failure (constraint).
   * H3 success notifications (dialog_resolved_via_owner_chain, parent_disabled_prefer_popup)
   * are informational and remain in warnings[] only — not surfaced here.
   */
  window?: "no_provider_matched";
  /** Ingress snapshot fetch error — stale cache returned when present. */
  ingress?: "fetch_error";
  /**
   * One-line summary explaining why entities.length === 0.
   * Set only when entities === 0 AND at least one provider signalled a constraint.
   * Absent when entities > 0 or entities === 0 but no constraint detected (genuine empty screen).
   *
   * Fallback guidance by value:
   *   foreground_unresolved    → add target.windowTitle or wait for focus
   *   ingress_fetch_error      → retry desktop_discover
   *   uia_blind_visual_unready → retry when visual backend is ready, or use screenshot(ocrFallback=always)
   *   uia_blind_visual_empty   → use screenshot(ocrFallback=always) or V1 tools
   *   cdp_failed_visual_empty  → check --remote-debugging-port=9222 and retry
   *   all_providers_failed     → use V1 tools (click_element / terminal(action='read') / screenshot);
   *                              also covers terminal-only failure (terminal(action='send'/'read') as recovery)
   */
  entityZeroReason?:
    | "uia_blind_visual_unready"
    | "uia_blind_visual_empty"
    | "cdp_failed_visual_empty"
    | "all_providers_failed"
    | "foreground_unresolved"
    | "ingress_fetch_error";
}

/**
 * Optional entity-level capability hints.
 * Advisory — touch may still succeed or fail irrespective of these hints.
 * Phase 1: type definition only; values set in future batches.
 */
export interface EntityCapabilities {
  /**
   * False when a provider-level constraint makes this verb unreliable via desktop_act.
   * Missing = no information (default: attempt normal dispatch).
   * Recovery: use terminal({action:'send'}) V1 if this entity is a terminal textbox.
   */
  canType?: false;
  canClick?: false;
  /** Executor kinds expected to succeed (derived from entity sources + provider constraints). */
  preferredExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse">;
  /** Executor kinds observed/predicted to fail for this target class. */
  unsupportedExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse">;
  /** Human-readable recovery hint, e.g. "use terminal(action='send') V1 tool". */
  fallbackHint?: string;
}

/**
 * Derive ViewConstraints from a flat warnings array.
 *
 * Returns undefined when no constraint-relevant warnings are present.
 * entityCount: number of resolved entities AFTER query filtering and maxEntities cap.
 * entityZeroReason is only set when entityCount === 0.
 */
export function deriveViewConstraints(
  warnings: ReadonlyArray<string>,
  entityCount: number,
): ViewConstraints | undefined {
  if (warnings.length === 0) return undefined;

  const c: ViewConstraints = {};
  let hasConstraint = false;

  for (const w of warnings) {
    switch (w) {
      // UIA
      case "uia_blind_single_pane":
        c.uia = "blind_single_pane";
        hasConstraint = true;
        break;
      case "uia_blind_too_few_elements":
        if (!c.uia) { c.uia = "blind_too_few_elements"; hasConstraint = true; }
        break;
      case "uia_provider_failed":
        if (!c.uia) { c.uia = "provider_failed"; hasConstraint = true; }
        break;
      // CDP
      case "cdp_provider_failed":
        c.cdp = "provider_failed";
        hasConstraint = true;
        break;
      // Visual
      case "visual_not_attempted":
        c.visual = "not_attempted";
        hasConstraint = true;
        break;
      case "visual_attempted_empty":
        if (!c.visual) { c.visual = "attempted_empty"; hasConstraint = true; }
        break;
      case "visual_attempted_empty_cdp_fallback":
        if (!c.visual) { c.visual = "attempted_empty"; hasConstraint = true; }
        if (!c.cdp)    { c.cdp   = "provider_failed";  hasConstraint = true; }
        break;
      case "visual_provider_unavailable":
        if (!c.visual) { c.visual = "provider_unavailable"; hasConstraint = true; }
        break;
      case "visual_provider_warming":
        if (!c.visual) { c.visual = "provider_warming"; hasConstraint = true; }
        break;
      // Terminal
      case "terminal_provider_failed":
        c.terminal = "provider_failed";
        hasConstraint = true;
        break;
      case "terminal_buffer_empty":
        if (!c.terminal) { c.terminal = "buffer_empty"; hasConstraint = true; }
        break;
      // Window / hierarchy (failure path only)
      // H3 success notifications (dialog_resolved_via_owner_chain, parent_disabled_prefer_popup)
      // are NOT constraints — they remain in warnings[] as informational.
      case "no_provider_matched":
        c.window = "no_provider_matched";
        hasConstraint = true;
        break;
      // Ingress
      case "ingress_fetch_error":
        c.ingress = "fetch_error";
        hasConstraint = true;
        break;
      // partial_results_only: warning only, no structured constraint derived
    }
  }

  if (!hasConstraint) return undefined;

  if (entityCount === 0) {
    const reason = deriveEntityZeroReason(c);
    if (reason) c.entityZeroReason = reason;
  }

  return c;
}

function deriveEntityZeroReason(c: ViewConstraints): ViewConstraints["entityZeroReason"] {
  // Priority: highest severity / most actionable first.
  if (c.window === "no_provider_matched") return "foreground_unresolved";
  if (c.ingress === "fetch_error") return "ingress_fetch_error";

  const uiaBlind = c.uia === "blind_single_pane" || c.uia === "blind_too_few_elements";
  const visualUnready = c.visual === "not_attempted" || c.visual === "provider_unavailable" || c.visual === "provider_warming";
  const visualEmpty = c.visual === "attempted_empty";

  if (uiaBlind && visualUnready) return "uia_blind_visual_unready";
  if (uiaBlind && visualEmpty)   return "uia_blind_visual_empty";
  if (c.cdp === "provider_failed" && visualEmpty) return "cdp_failed_visual_empty";
  if (c.uia === "provider_failed" || c.cdp === "provider_failed" || c.terminal === "provider_failed") {
    return "all_providers_failed";
  }

  return undefined;
}
