export type Rect = { x: number; y: number; width: number; height: number };

export type WarmTarget = { kind: "game" | "browser" | "terminal"; id: string };
export type WarmState = "cold" | "warming" | "warm" | "evicted";

export interface VisualGpuRuntime {
  ensureWarm(target: WarmTarget): Promise<WarmState>;
  getState(): WarmState;
  dispose(): Promise<void>;
}

export type VisualTrackState = "new" | "tracking" | "stable" | "lost";

/**
 * bestFrameRef holds a reference to the highest-scoring captured frame for this track.
 * In PoC it is a string key into an in-memory frame map; in production it would be
 * a device-local GPU buffer handle to avoid CPU round-trips (per §4.3 of the plan).
 */
export interface VisualTrack {
  trackId: string;
  roi: Rect;
  age: number;
  lastSeenTsMs: number;
  bestFrameScore: number;
  bestFrameRef?: string;
  lastText?: string;
  state: VisualTrackState;
  /** Stable digest of {roi-bucket, lastText} used as evidenceDigest for lease issuance. Set by Batch 5. */
  digest?: string;
}

export interface RecognizedText {
  text: string;
  confidence: number;
  tsMs: number;
}

/**
 * target.kind "terminal" maps to kind:"window" with sourceId carrying the session id.
 * The resolver narrows this into a terminal-typed entity at the World Graph layer.
 */
export interface UiEntityCandidate {
  source: "uia" | "cdp" | "win32" | "ocr" | "som" | "visual_gpu" | "terminal";
  target: { kind: "window" | "browserTab"; id: string };
  /**
   * @deprecated Use `locator` for source-aware routing.
   * Legacy single-field ID: carries UIA automationId OR CDP selector OR visual trackId
   * depending on source — ambiguous by design. Preserved for backward compatibility.
   */
  sourceId?: string;
  /**
   * Source-specific locators. Populated by source-specific providers.
   * The resolver merges these into UiEntity.locator.
   */
  locator?: import("../world-graph/types.js").EntityLocator;
  /** Observed role; resolver normalises to "button"|"textbox"|"link"|"menuitem"|"label"|"unknown". */
  role?: string;
  label?: string;
  value?: string;
  rect?: Rect;
  /** Verbs the resolver can expand into full UiAffordance (e.g. "scrollTo"|"select" added at resolver). */
  actionability: Array<"click" | "invoke" | "type" | "read">;
  confidence: number;
  /** Unix ms when this observation was captured. Required for resolver freshness ranking. */
  observedAtMs: number;
  /** Stable digest of key fields ({rect-bucket, label, source}). Used as evidenceDigest for leases. */
  digest?: string;
  /** True while temporal fusion is accumulating votes; resolver must not issue a lease for provisional candidates. */
  provisional?: boolean;
  raw?: unknown;
}
