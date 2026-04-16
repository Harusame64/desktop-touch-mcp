/**
 * Shared types for the Reactive Perception Graph (RPG).
 *
 * This file contains ONLY TypeScript types and value-level constants
 * that are safe to import from any module, including pure unit tests.
 * No runtime logic, no OS bindings, no imports beyond this file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entity references
// ─────────────────────────────────────────────────────────────────────────────

/** Entity that a perception lens tracks. */
export type EntityRef =
  | { kind: "window"; id: string }
  | { kind: "browserTab"; id: string };  // id = CDP tab ID

/** Identity fingerprint for a tracked window. */
export interface WindowIdentity {
  hwnd: string;          // bigint as decimal string
  pid: number;
  processName: string;
  processStartTimeMs: number;
  titleResolved: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensor sources and cost tiers
// ─────────────────────────────────────────────────────────────────────────────

export type SensorSource = "win32" | "uia" | "cdp" | "image" | "ocr" | "inferred";
export type EvidenceCost = "cheap" | "medium" | "expensive";

// ─────────────────────────────────────────────────────────────────────────────
// Evidence
// ─────────────────────────────────────────────────────────────────────────────

/** Why the server believes a fluent value. */
export interface Evidence {
  source: SensorSource;
  observedAtSeq: number;
  observedAtMs: number;
  cost: EvidenceCost;
  ttlMs?: number;
  notes?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation (raw sensor report → feeds FluentStore)
// ─────────────────────────────────────────────────────────────────────────────

export interface Observation {
  seq: number;
  tsMs: number;
  source: SensorSource;
  entity: EntityRef;
  property: string;
  value: unknown;
  confidence: number;
  evidence: Evidence;
  /**
   * Monotonic timestamp (performance.now()) recorded at the START of the sensor read
   * that produced this observation. Used to compare against lastDirtyAtMonoMs in FluentStore
   * to determine whether the evidence is newer than the last invalidation hint.
   * Optional: sensors that do not support monotonic timestamps omit this field.
   */
  monoMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fluent
// ─────────────────────────────────────────────────────────────────────────────

export type FluentStatus =
  | "observed"
  | "inferred"
  | "dirty"
  | "settling"
  | "stale"
  | "contradicted"
  | "invalidated";

export interface Fluent {
  entity: EntityRef;
  property: string;
  value: unknown;
  validFromSeq: number;
  /** Monotonic timestamp (performance.now()) when this fluent was last written by apply(). */
  validFromMonoMs: number;
  confidence: number;
  support: Evidence[];
  contradictions: Evidence[];
  status: FluentStatus;
  /** Sequence number of the last dirty-mark applied to this fluent. */
  lastDirtySeq?: number;
  /** Monotonic timestamp of the last dirty-mark applied to this fluent. */
  lastDirtyAtMonoMs?: number;
  /** Human-readable cause string for the last dirty-mark. */
  lastDirtyCause?: string;
  /**
   * Generation token — changes when target identity changes.
   * Coordinates derived under generation G1 must not be used after the target becomes G2.
   */
  generation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fluent and guard kind enums (used in schemas)
// ─────────────────────────────────────────────────────────────────────────────

export const FLUENT_KINDS = [
  "target.exists",
  "target.identity",
  "target.title",
  "target.rect",
  "target.foreground",
  "target.zOrder",
  "modal.above",
  "target.focusedElement",
  "browser.url",
  "browser.title",
  "browser.readyState",
] as const;
export type FluentKind = (typeof FLUENT_KINDS)[number];

export const GUARD_KINDS = [
  "target.identityStable",
  "safe.keyboardTarget",
  "safe.clickCoordinates",
  "stable.rect",
  "browser.ready",
] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

export type GuardPolicy = "warn" | "block";

// ─────────────────────────────────────────────────────────────────────────────
// Lens specification and resolved form
// ─────────────────────────────────────────────────────────────────────────────

export interface LensSpec {
  name: string;
  target:
    | { kind: "window"; match: { titleIncludes: string } }
    | { kind: "browserTab"; match: { urlIncludes?: string; titleIncludes?: string } };
  maintain: FluentKind[];
  guards: GuardKind[];
  guardPolicy: GuardPolicy;
  maxEnvelopeTokens: number;
  salience: "critical" | "normal" | "background";
}

/** Identity fingerprint for a tracked browser tab. */
export interface BrowserTabIdentity {
  tabId: string;
  title: string;
  url: string;
  port: number;
}

export interface ResolvedBinding {
  hwnd: string;        // bigint as decimal
  windowTitle: string; // resolved title at registration time
}

export interface PerceptionLens {
  lensId: string;
  spec: LensSpec;
  binding: ResolvedBinding;
  boundIdentity: WindowIdentity | BrowserTabIdentity;
  fluentKeys: string[];  // concrete dependency keys in the store
  registeredAtSeq: number;
  registeredAtMs: number;
}

export interface LensSummary {
  lensId: string;
  name: string;
  target: string;
  guardPolicy: GuardPolicy;
  salience: string;
  fluentCount: number;
  registeredAtMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard results
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardResult {
  kind: GuardKind;
  ok: boolean;
  confidence: number;
  reason?: string;
  suggestedAction?: string;
}

export interface GuardEvalResult {
  ok: boolean;
  policy: GuardPolicy;
  attention: AttentionState;
  results: GuardResult[];
  failedGuard?: GuardResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attention state
// ─────────────────────────────────────────────────────────────────────────────

export type AttentionState =
  | "ok"
  | "changed"
  | "dirty"
  | "settling"
  | "stale"
  | "guard_failed"
  | "identity_changed"
  | "needs_escalation";

// ─────────────────────────────────────────────────────────────────────────────
// Perception envelope (attached to tool responses)
// ─────────────────────────────────────────────────────────────────────────────

export interface PerceptionEnvelope {
  seq: number;
  lens: string;       // lensId
  attention: AttentionState;
  changed: string[];  // coalesced human-readable change summaries
  guards: Record<string, boolean>;
  latest: {
    /** Present for window-kind lenses. */
    target?: {
      title?: string;
      rect?: { x: number; y: number; width: number; height: number };
      foreground?: boolean;
      zOrder?: number;
      exists?: boolean;
      modalAbove?: boolean;
      /** Focused UI element — only present for salience:"critical" lenses with UIA enabled. */
      focusedElement?: { name: string; controlType: string; automationId?: string; value?: string } | null;
      confidence: number;
    };
    /** Present for browserTab-kind lenses. */
    browser?: {
      url?: string;
      title?: string;
      readyState?: string;
      confidence: number;
    };
  };
  warnings?: string[];
  /** Derived action capability (keyboard/mouse) based on guard result. */
  canAct?: { keyboard: boolean; mouse: boolean };
  /** Present when attention is identity_changed — tells LLM to forget and re-register. */
  rebindSuggestion?: {
    action: "forget_and_register_again";
    reason: "identity_changed" | "target_missing";
    lensId: string;
  };
}
