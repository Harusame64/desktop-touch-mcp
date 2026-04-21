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
export type EntitySourceKind = "uia" | "cdp" | "win32" | "ocr" | "som" | "visual_gpu" | "inferred";
export type ExecutorKind = "uia" | "cdp" | "terminal" | "mouse";

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
