import type { Rect } from "../vision-gpu/types.js";

export type { Rect };

export type UiEntityRole = "button" | "textbox" | "link" | "menuitem" | "label" | "unknown";

/**
 * Source-specific locators for an entity.
 * Each field is populated only when that source has evidence for this entity.
 * Desktop-executor routes to the right backend using the highest-priority
 * non-null locator field.
 */
export interface EntityLocator {
  /** UIA: element identified by AutomationId and/or accessible name. */
  uia?: {
    automationId?: string;
    name?: string;
    /**
     * Which client read the element (ADR-036 item 16). The native engine and the PowerShell script
     * can see different trees and name one element differently, so a click's "not found" is
     * believed only when the native engine both read the element and answered the click. Absent
     * when the read could not say.
     */
    via?: "native" | "powershell";
    /**
     * ADR-036 family 2 — the element's own window handle, when it is one (UIA `NativeWindowHandle`).
     * The keyboard rung posts to whatever holds the focus of the window's thread, and this is what
     * lets it tell whether that is the element named. A handle does not move with the window, so it
     * answers on the title road too, where no window position is recorded. Absent for a windowless
     * element, and on a read that could not say.
     *
     * Written as the unsigned low 32 bits, in decimal. A handle can be RECREATED while the control
     * lives (WinForms `RecreateHandle`, a dialog opened again), so the value describes the control as
     * it was when the read ran, and can go stale.
     */
    nativeWindowHandle?: string;
  };
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
   * Each field is unambiguous for its backend.
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
  unsupportedExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse" | "keyboard">;
  /**
   * ADR-020 SR-1 PR-SR1-1 (北極星 8, case β entity bake): executor route
   * order baked from the registry-derived `EntityCapabilities` during
   * `DesktopFacade.see()` via `bakeEntityCapabilities`. The executor
   * (`createDesktopExecutor`) consumes this array directly instead of
   * re-invoking the registry, keeping `createDesktopExecutor`'s signature
   * unchanged and avoiding the `_sessionOpts()` executorFactory lifetime
   * mismatch that a `viewConstraints` runtime parameter would otherwise
   * impose.
   *
   * Inline string-union shape mirrors `unsupportedExecutors` above (same
   * advisory-free engine-layer convention). Absent when no registry lookup
   * was performed (test direct invoke / legacy path) — `createDesktopExecutor`
   * falls back to the hardcoded `["uia","cdp","terminal","mouse"]` ladder.
   *
   * ADR-020 SR-5 PR-SR5-1: `"keyboard"` added to the inline shape because
   * `AdvertisedExecutorKind` (in `src/capabilities/registry.ts`) was
   * promoted to include `"keyboard"`, and `bakeEntityCapabilities` now
   * writes arrays such as `["uia","keyboard"]` for ValuePattern text
   * inputs. The inline shape does not automatically follow
   * `AdvertisedExecutorKind` because the engine layer intentionally avoids
   * importing types from the advisory layer (`src/tools/desktop-constraints.ts`).
   */
  preferredExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse" | "keyboard">;
  /**
   * ADR-020 SR-1 PR-SR1-1 (case β entity bake): human-readable recovery
   * hint baked from the registry-derived `EntityCapabilities.fallbackHint`
   * during `DesktopFacade.see()`. Currently unused by the engine layer
   * (the LLM consumes it via `EntityView.capabilities.fallbackHint`); held
   * here so the bake remains a single batch and so the field is available
   * to executor-side diagnostics in future PRs.
   */
  fallbackHint?: string;
  /**
   * ADR-029 Phase 1 — discovery-time provenance: the window / browser tab that
   * produced this entity's primary candidate (`UiEntityCandidate.target`).
   *
   * The viewport gate compares the entity rect against the *current* rect of
   * this origin window rather than against the foreground window: on a
   * multi-monitor desktop the target window is frequently NOT the foreground
   * one, and comparing against the foreground rect blocked every legitimate
   * touch on another monitor. Comparing against the containing window would be
   * tautological (the entity was observed inside it), so the identity has to be
   * carried from discovery time.
   *
   * `id` is provider-defined: a decimal HWND string for win32/ocr/uia lanes,
   * otherwise a window title or `"@active"`. Absent for entities resolved
   * before this field existed (tests / legacy fixtures) — the gate falls back
   * to a virtual-screen bounds check in that case.
   *
   * `hwnd` is the handle of the window the candidate was actually observed in,
   * when the producer knows it. Preferred over `id`, which is often the caller's
   * query rather than an identity: re-resolving a title at act time can select a
   * different window if the Z-order changed since discovery, and the click would
   * then be judged against — and land in — the wrong one.
   *
   * Absent `hwnd` means no lane that records one looked — **with one state left in the code that
   * would also produce it, deliberately.** If a group's handles ever DID disagree, `resolver.ts`
   * takes none of them rather than an arbitrary one, and that arrives here as the same absence.
   * The derivation there says the state cannot occur; the test is kept because it costs one
   * comparison and the failure it prevents is a press into another window. That is not the trade
   * the `hwndConflict` machinery offered: a refusal path with published advice, reachable only from
   * a fixture, which every reader had to model as a case that happens (Opus sandbox review,
   * 2026-09-10, for catching that this sentence and that line were arguing with each other). A round of
   * ADR-036 item 12 also carried `hwndConflict` here, for a merged group whose lanes named
   * different windows — deleted, because the two lanes that record a handle (`ocr` and
   * `visual_gpu`) cannot share a group: the producer's digest keys one of them and the
   * source-omitting fallback keys the other, so every handle in a group comes from a single OCR
   * read (the derivation is in `resolver.ts`, corrected once by a gate). The shape it was defending
   * against is real and worth remembering — a silence and an answer must not share a representation
   * — but this was not an instance of it.
   */
  origin?: { kind: "window" | "browserTab"; id: string; hwnd?: string };
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
