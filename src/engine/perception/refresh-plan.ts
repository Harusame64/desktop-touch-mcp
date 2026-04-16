/**
 * RefreshPlan — batches dirty marks into the cheapest required sensor calls.
 *
 * Instead of calling refreshWin32Fluents() for every lens on every event,
 * buildRefreshPlan() analyses the DirtyJournal and produces a minimal plan
 * describing exactly which data needs to be fetched.
 *
 * Pure module — no OS imports.
 */

import type { DirtyJournal } from "./dirty-journal.js";
import type { LensEventIndex } from "./lens-event-index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RefreshPlan {
  /**
   * If true, a full EnumWindows is required.
   * Needed for z-order changes, modal recomputation, or global-dirty events.
   */
  needsEnumWindows: boolean;

  /** HWNDs whose target.rect needs a cheap GetWindowRect() refresh. */
  rectHwnds: Set<string>;

  /** HWNDs whose target.identity needs re-verification. */
  identityHwnds: Set<string>;

  /** HWNDs whose target.title needs a cheap GetWindowText() refresh. */
  titleHwnds: Set<string>;

  /**
   * If true, a GetForegroundWindow() + identity comparison is needed.
   * Cheaper than a full EnumWindows for the foreground-only case.
   */
  foreground: boolean;

  /** LensIds that need modal.above recomputed (requires z-order snapshot). */
  modalForLensIds: Set<string>;

  /** Human-readable reasons that contributed to this plan (for diagnostics). */
  reason: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal refresh plan from the current DirtyJournal state.
 *
 * @param journal  - Current dirty state.
 * @param index    - Lens-event routing index (used to scope modal recompute).
 * @param allHwnds - All HWNDs currently tracked (used for global-dirty expansion).
 */
export function buildRefreshPlan(
  journal: DirtyJournal,
  index: LensEventIndex,
  allHwnds: Set<string> = new Set()
): RefreshPlan {
  const plan: RefreshPlan = {
    needsEnumWindows: false,
    rectHwnds: new Set(),
    identityHwnds: new Set(),
    titleHwnds: new Set(),
    foreground: false,
    modalForLensIds: new Set(),
    reason: [],
  };

  if (!journal.hasDirty()) return plan;

  // Global dirty: full scan required
  if (journal.isGlobalDirty()) {
    plan.needsEnumWindows = true;
    plan.foreground = true;
    for (const hwnd of allHwnds) {
      plan.rectHwnds.add(hwnd);
      plan.identityHwnds.add(hwnd);
      plan.titleHwnds.add(hwnd);
    }
    for (const lensId of index.modalSensitive) plan.modalForLensIds.add(lensId);
    plan.reason.push("global_dirty");
    return plan;
  }

  // Per-entity entries
  for (const [entityKey, entry] of journal.entries()) {
    // Extract hwnd from entityKey format "window:12345" or "browserTab:tab-1"
    const colonIdx = entityKey.indexOf(":");
    const hwnd = colonIdx >= 0 ? entityKey.slice(colonIdx + 1) : entityKey;

    for (const prop of entry.props) {
      switch (prop) {
        case "target.rect":
          plan.rectHwnds.add(hwnd);
          plan.reason.push(`rect_dirty:${hwnd}`);
          break;

        case "target.identity":
          plan.identityHwnds.add(hwnd);
          plan.reason.push(`identity_dirty:${hwnd}`);
          break;

        case "target.title":
          plan.titleHwnds.add(hwnd);
          plan.reason.push(`title_dirty:${hwnd}`);
          break;

        case "target.foreground":
          plan.foreground = true;
          plan.reason.push("foreground_dirty");
          break;

        case "target.zOrder":
          plan.needsEnumWindows = true;
          plan.reason.push(`zorder_dirty:${hwnd}`);
          break;

        case "modal.above":
          // Modal recompute for all lenses that track modal.above
          for (const lensId of (index.byHwnd.get(hwnd) ?? [])) {
            if (index.modalSensitive.has(lensId)) plan.modalForLensIds.add(lensId);
          }
          // Also all modal-sensitive lenses (modal can come from any z-order change)
          for (const lensId of index.modalSensitive) plan.modalForLensIds.add(lensId);
          plan.reason.push(`modal_dirty:${hwnd}`);
          break;

        case "stable.rect":
          // stable.rect dirty just means a quiet-window check is needed; no extra sensor call
          plan.reason.push(`stable_rect_dirty:${hwnd}`);
          break;

        case "target.exists":
          plan.identityHwnds.add(hwnd);
          plan.reason.push(`exists_dirty:${hwnd}`);
          break;
      }
    }

    // Structural/identityRisk entries escalate to EnumWindows
    if (entry.severity === "structural" || entry.severity === "identityRisk") {
      plan.needsEnumWindows = true;
    }
  }

  // If modal recompute is needed, we need z-order (requires EnumWindows)
  if (plan.modalForLensIds.size > 0) {
    plan.needsEnumWindows = true;
  }

  return plan;
}
