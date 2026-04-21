import type { Rect } from "../vision-gpu/types.js";

export type { Rect };

export type UiEntityRole = "button" | "textbox" | "link" | "menuitem" | "label" | "unknown";
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
