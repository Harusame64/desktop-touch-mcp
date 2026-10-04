/**
 * desktop-constraints.ts — Derives ViewConstraints from provider warnings.
 *
 * Single source of truth: ProviderResult.warnings[] (set by providers / compose-providers).
 * ViewConstraints is an additive structured overlay — warnings[] is preserved as-is.
 * Returns undefined when no constraint-relevant warnings are present (field stays absent from JSON).
 */

import type { AdvertisedExecutorKind } from "../capabilities/registry.js";

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
  visual?: "not_attempted" | "attempted_empty" | "provider_unavailable" | "provider_warming"
    /**
     * The attached backend does not look at windows — it replays what was handed to it, which is
     * the default build. Distinct from `attempted_empty`, which is a pipeline that LOOKED and found
     * no stable track: the two had been arriving as the same silence, and the remedy is different
     * (enable a recognising backend, rather than wait or act on structure).
     */
    | "backend_cannot_recognise";
  /** Terminal provider status (terminal targets only). */
  terminal?: "buffer_empty" | "provider_failed";
  /**
   * Foreground window resolution failure.
   * Only "no_provider_matched", "target_window_gone" and "window_excluded" are true failures
   * (constraints).
   * H3 success notifications (dialog_resolved_via_owner_chain, parent_disabled_prefer_popup)
   * are informational and remain in warnings[] only — not surfaced here.
   */
  window?: "no_provider_matched"
    /**
     * internal #211 item 9(3) — the `target.hwnd` the caller sent names no window any more: the OS
     * answered that it is not a window. A dialog that closed is the usual one.
     */
    | "target_window_gone"
    /**
     * internal #222 — the target is excluded from every tool surface of this server (the key
     * locker's own windows): nothing was read, and nothing will be while it stays excluded.
     */
    | "window_excluded"
    /**
     * internal #247 — the window's app is suspended by Windows (minimised or not shown): UIA reads
     * nothing and a capture shows its last frame, so the OCR lane read nothing from it.
     */
    | "window_frozen";
  /**
   * The ingress could not give a whole answer: its fetch threw (a stale cache is returned when
   * present), or its result had no usable candidate list, or entries that were not objects
   * (internal #161 — then the entities that remain were read, not remembered).
   */
  ingress?: "fetch_error";
  /**
   * internal #211 — the caller's `query` matched none of the entities read. Only on-screen
   * controls UIA exposes can match: text scrolled out of view, values UIA does not expose (a
   * spreadsheet cell's number), and — with `uia_tree_truncated` — elements past the read's cap are
   * not in the list at all.
   */
  query?: "no_match";
  /**
   * One-line summary explaining why entities.length === 0.
   * Set only when entities === 0 AND a constraint was signalled — by a provider, or by a `query`
   * that matched nothing read.
   * Absent when entities > 0 or entities === 0 but no constraint detected (genuine empty screen).
   *
   * Fallback guidance by value:
   *   foreground_unresolved    → add target.windowTitle or wait for focus
   *   query_no_match           → the query matched nothing read: scroll the text into view and
   *                              discover again, or read visible text with screenshot(detail:'ocr')
   *   window_excluded          → the target is excluded from every tool surface (the key
   *                              locker's own windows); retrying returns the same — target another
   *                              window
   *   target_window_gone       → the window target.hwnd named has closed: discover the window it
   *                              belonged to, or call without target.hwnd
   *   window_frozen            → the window's app is suspended by Windows (minimised or not shown):
   *                              UIA reads nothing and a capture is its last frame, so nothing was
   *                              read from it — restore or show the window, then discover again
   *   ingress_fetch_error      → retry desktop_discover
   *   uia_blind_visual_incapable → the attached visual backend recognises nothing (the default
   *                              build). Waiting never changes it: enable a recognising backend, or
   *                              use screenshot(ocrFallback=always) / V1 tools
   *   uia_blind_visual_unready → retry when visual backend is ready, or use screenshot(ocrFallback=always)
   *   uia_blind_visual_empty   → use screenshot(ocrFallback=always) or V1 tools
   *   cdp_failed_visual_empty  → check --remote-debugging-port on the port the tab was opened on (browser_open's port, 9222 by default; after a server restart, call browser_open with that port again) and retry
   *   all_providers_failed     → use V1 tools (click_element / terminal(action='read') / screenshot);
   *                              also covers terminal-only failure (terminal(action='send'/'read') as recovery)
   */
  entityZeroReason?:
    | "uia_blind_visual_incapable"
    | "uia_blind_visual_unready"
    | "uia_blind_visual_empty"
    | "cdp_failed_visual_empty"
    | "all_providers_failed"
    | "foreground_unresolved"
    | "query_no_match"
    | "target_window_gone"
    | "window_excluded"
    | "window_frozen"
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
  /** Executor kinds expected to succeed (derived from entity sources + provider constraints).
   *  ADR-020 SR-1: type narrowed to `AdvertisedExecutorKind[]` (single SSOT in
   *  `src/capabilities/registry.ts`). The previous inline string-union
   *  (`Array<"uia"|"cdp"|"terminal"|"mouse">`) was structurally identical;
   *  the alias makes the compile-time guard explicit. */
  preferredExecutors?: AdvertisedExecutorKind[];
  /** Executor kinds observed/predicted to fail for this target class.
   *  ADR-020 SR-1: narrowed to `AdvertisedExecutorKind[]` for the same
   *  reason as `preferredExecutors`. */
  unsupportedExecutors?: AdvertisedExecutorKind[];
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
        // Guarded like every other visual case, and it was the only one that was not. The warnings
        // for a blind backend arrive as [visual_backend_cannot_recognise, visual_not_attempted], so
        // an unconditional write here overwrote the specific reason with the general one on the very
        // next iteration — the caller was told `not_attempted`, and `entityZeroReason` then said
        // `uia_blind_visual_unready`, which means "wait and retry" about a state that never becomes
        // ready by waiting (PR 側 codex, 2026-09-10).
        if (!c.visual) { c.visual = "not_attempted"; hasConstraint = true; }
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
      case "visual_backend_cannot_recognise":
        if (!c.visual) { c.visual = "backend_cannot_recognise"; hasConstraint = true; }
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
      // `window_excluded` is never overwritten: its remedy (another window) is the one that holds.
      case "no_provider_matched":
        if (c.window !== "window_excluded") c.window = "no_provider_matched";
        hasConstraint = true;
        break;
      case "target_window_gone":
        if (c.window !== "window_excluded") c.window = "target_window_gone";
        hasConstraint = true;
        break;
      case "window_excluded":
        c.window = "window_excluded";
        hasConstraint = true;
        break;
      // Internal #247: the window's app is frozen; what a capture shows is its last frame.
      case "target_window_frozen":
        if (c.window !== "window_excluded" && c.window !== "target_window_gone") c.window = "window_frozen";
        hasConstraint = true;
        break;
      case "query_no_match":
        c.query = "no_match";
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
  if (c.window === "window_excluded") return "window_excluded";
  if (c.window === "target_window_gone") return "target_window_gone";
  if (c.window === "window_frozen") return "window_frozen";
  if (c.window === "no_provider_matched") return "foreground_unresolved";
  if (c.ingress === "fetch_error") return "ingress_fetch_error";

  const uiaBlind = c.uia === "blind_single_pane" || c.uia === "blind_too_few_elements";
  // `backend_cannot_recognise` is deliberately NOT here. Every value in this list means "not ready
  // yet", and the advice attached to `uia_blind_visual_unready` is to retry or wait; a backend that
  // recognises nothing is ready and will answer the same way forever. It gets its own reason below.
  const visualUnready = c.visual === "not_attempted" || c.visual === "provider_unavailable" || c.visual === "provider_warming";
  const visualBlind   = c.visual === "backend_cannot_recognise";
  const visualEmpty = c.visual === "attempted_empty";

  if (uiaBlind && visualBlind)   return "uia_blind_visual_incapable";
  if (uiaBlind && visualUnready) return "uia_blind_visual_unready";
  if (uiaBlind && visualEmpty)   return "uia_blind_visual_empty";
  if (c.cdp === "provider_failed" && visualEmpty) return "cdp_failed_visual_empty";
  if (c.uia === "provider_failed" || c.cdp === "provider_failed" || c.terminal === "provider_failed") {
    return "all_providers_failed";
  }
  // Last: a lane that failed or read blind is the better explanation of an empty list, and its
  // remedy (wait, another tool) is not "scroll" (gate 2). What is left is a read that worked and a
  // query that matched none of it.
  if (c.query === "no_match") return "query_no_match";

  return undefined;
}
