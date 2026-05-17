import type { Rect } from "../vision-gpu/types.js";

export type { Rect };

export type UiEntityRole = "button" | "textbox" | "link" | "menuitem" | "label" | "unknown";

/**
 * Source-specific locators for an entity.
 * Each field is populated only when that source has evidence for this entity.
 * Desktop-executor routes to the right backend using the highest-priority
 * non-null locator rather than the ambiguous single `sourceId` field.
 */
export interface EntityLocator {
  /** UIA: element identified by AutomationId and/or accessible name. */
  uia?: { automationId?: string; name?: string };
  /** CDP: element identified by CSS selector, optionally scoped to a tab. */
  cdp?: { selector?: string; tabId?: string };
  /** Terminal: identified by containing window title. */
  terminal?: { windowTitle?: string };
  /** Visual GPU lane: identified by ROI rect and track UUID. */
  visual?: { rect?: Rect; trackId?: string };
}
export type AffordanceVerb = "invoke" | "click" | "type" | "select" | "scrollTo" | "read";
export type EntitySourceKind = "uia" | "cdp" | "win32" | "ocr" | "som" | "visual_gpu" | "terminal" | "inferred";
/**
 * `"keyboard"` is a sub-executor used as a fallback from the UIA `setValue` route
 * when `uiaSetValue` throws (e.g. Notepad's RichEditD2DPT exposes `ValuePattern` but
 * `makeSetElementValueScript`'s `name -like '*…*'` locator filter cannot reach the
 * entity — issue #327 item E). The fallback posts WM_CHAR to the focused child via
 * `bg-input.ts::postCharsToHwnd` (same primitive `terminalSend` uses). It is NOT
 * a primary executor advertised in `UiAffordance.executors` or `unsupportedExecutors`
 * — those remain the 4-executor union (`uia | cdp | terminal | mouse`). The
 * path-class refactor epic may promote it to a first-class executor once the
 * capability registry consolidates the ladder.
 */
export type ExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard";

/**
 * Issue #327 item C: rich return shape for `ExecutorFn` / `TouchEnvironment.execute`
 * that lets the executor signal a silent fallback (e.g. UIA InvokePattern threw, mouse
 * rect-center succeeded) without losing observability. The dogfood symptom was
 * `capabilities.preferredExecutors: ["uia"]` ↔ `executor: "mouse"` with no marker
 * explaining the gap.
 *
 * Convention: an executor that succeeded without downgrading returns a bare
 * `ExecutorKind` (back-compat); only the downgrade path returns the rich
 * `ExecutorOutcome`. `GuardedTouchLoop` normalises both and surfaces
 * `TouchResult.downgrade` on the success variant.
 */
export interface ExecutorOutcome {
  kind: ExecutorKind;
  downgrade?: {
    /** The originally selected executor that threw / was infeasible. */
    from: ExecutorKind;
    /** Short human-readable reason — the underlying error message is the canonical source. */
    reason: string;
  };
}

export interface UiAffordance {
  verb: AffordanceVerb;
  executors: ExecutorKind[];
  confidence: number;
  preconditions: string[];
  postconditions: string[];
}

export interface UiEntity {
  entityId: string;
  role: UiEntityRole;
  label?: string;
  /**
   * Current value of the entity (UIA ValuePattern, CDP el.value, terminal prompt text).
   * Used by computeDiff to detect value_changed after a type/select action.
   * Absent for sources that don't expose values (visual_gpu, unknown roles).
   */
  value?: string;
  rect?: Rect;
  confidence: number;
  sources: EntitySourceKind[];
  affordances: UiAffordance[];
  /**
   * Source-specific locators used by desktop-executor for routing.
   * Prefer these over `sourceId` — each field is unambiguous for its backend.
   */
  locator?: EntityLocator;
  /**
   * @deprecated Legacy single-field ID retained for backward-compatible executor fallback.
   * Prefer locator.* for new code.
   */
  sourceId?: string;
  /**
   * Opaque string that identifies the world-state snapshot this entity was resolved from.
   * Production source: `"${viewId}:${monotonicSeq}"` incremented on each WinEvent /
   * DOM-mutation / frame-digest change. Wall-clock alone is insufficient (no change signal).
   */
  generation: string;
  /**
   * Primary evidence digest (from CandidateProducer or resolver fallback key).
   * Required — always set by resolveCandidates(). Used as EntityLease.evidenceDigest.
   */
  evidenceDigest: string;
  /**
   * UIA control type carried through from the candidate (Issue #296). Absent
   * when no UIA candidate contributed to this entity (CDP-only / visual-only).
   * Advisory: capability derivation reads this to map e.g. `ListItem` →
   * `unsupportedExecutors:['uia']`. Not exposed in the entity view directly —
   * the LLM sees the derived `capabilities` block instead.
   */
  controlType?: string;
  /**
   * UIA pattern names supported by the underlying element (Issue #296).
   * Same advisory semantics as `controlType`. When multiple UIA candidates
   * merged into one entity, the resolver unions their pattern arrays so
   * `deriveEntityCapabilities` sees the full set.
   */
  patterns?: string[];
  /**
   * Issue #296 Phase 2 — executor kinds observed/predicted to fail for this
   * entity, surfaced so `desktop-executor.ts` can short-circuit before
   * paying e.g. `InvokePatternNotSupported`'s round-trip. Populated by
   * `DesktopFacade.see()` from `deriveEntityCapabilities(...)` so the
   * value is always in sync with the LLM-facing `EntityView.capabilities`
   * block (same derivation, single source of truth). Absent when no
   * executor is blocked — fall back to default dispatch order.
   *
   * Inline string-union shape (rather than importing `EntityCapabilities`
   * from `src/tools/desktop-constraints.ts`) keeps the engine layer free
   * of cross-boundary deps; structural compatibility lets `see()` assign
   * the field from a full `EntityCapabilities` value without a cast.
   */
  unsupportedExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse">;
}

export interface EntityLease {
  entityId: string;
  viewId: string;
  targetGeneration: string;
  expiresAtMs: number;
  evidenceDigest: string;
}

export type LeaseValidationResult =
  | { ok: true; entity: UiEntity }
  | { ok: false; reason: "expired" | "generation_mismatch" | "entity_not_found" | "digest_mismatch" };
