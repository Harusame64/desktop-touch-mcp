import type { UiEntity, EntityLease, ExecutorKind, ExecutorOutcome, UiAffordance } from "./types.js";
import type { LeaseStore } from "./lease-store.js";
import type { VisualMotionObservation } from "../../tools/_input-pipeline.js";
import type { Rect, UiEntityCandidate } from "../vision-gpu/types.js";
import { classifyModal } from "./session-registry.js";
import { resolveCandidates } from "./resolver.js";

export type TouchAction = "auto" | "invoke" | "click" | "type" | "setValue" | "select";

export interface TouchInput {
  lease: EntityLease;
  action?: TouchAction;
  text?: string;
  /**
   * ADR-024 Seed-2 S5b — optional per-call post-action snapshot closure. When
   * present, `touch()` invokes it (AFTER execute) IN PLACE OF
   * `env.resolvePostTouchEntities()` to obtain the post-touch candidates for the
   * semantic diff, and surfaces its `roiMaterial` on the result. Built by the
   * registration wrapper (`desktop-register.ts`) for visual-only acts so the ONE
   * ROI-OCR it runs feeds both the diff baseline and the folded `roiCapture`
   * (order-trap elimination). The loop stays capture-agnostic: this is an opaque
   * callback — it does not know the closure does a frame-diff / OCR. Absent on
   * every non-visual / flag-off path → `env.resolvePostTouchEntities()` is used
   * exactly as before (byte-equal). Returns lease-LESS `UiEntityCandidate[]`;
   * `touch()` runs `resolveCandidates(generation)` to mint `UiEntity[]` (same
   * conversion as `resolvePostTouchEntities`), so the closure must NOT pre-resolve.
   */
  postSnapshot?: () => Promise<{
    candidates: UiEntityCandidate[];
    roiMaterial?: RoiCaptureMaterial;
  }>;
}

export type SemanticDiff = Array<
  | "entity_disappeared"
  | "entity_moved"
  | "modal_appeared"
  | "modal_dismissed"
  | "value_changed"
  | "entity_appeared"
  | "focus_shifted"
>;

export type TouchFailReason =
  | "lease_expired"
  | "lease_generation_mismatch"
  | "entity_not_found"
  | "lease_digest_mismatch"
  | "modal_blocking"
  | "entity_outside_viewport"
  | "executor_failed";

/**
 * Identity of the modal entity blocking a touch attempt — included in the response
 * when reason='modal_blocking' so the LLM can dismiss the right modal without an
 * additional screenshot. Issue #63 (Haiku 4.5 dogfood feedback).
 *   name: best-effort identifier — entity.locator.uia.name → entity.label → entity.role → "modal".
 *         Always non-empty so LLM-side string handling does not need to defend against "".
 *   role: entity.role (often "unknown" for UIA dialogs; still useful as a tie-breaker).
 *   automationId: present only when the source provides one (UIA AutomationId).
 */
export interface BlockingElementInfo {
  name: string;
  role: string;
  automationId?: string;
}

/**
 * ADR-024 Seed-2 (S1 contract lock) — a lease-less entity preview carried inside
 * a post-action `roiCapture`. Distinct from a discovered `UiEntity`: it has NO
 * lease and therefore cannot be passed to `desktop_act` (MVP = ADR-024 OQ-8
 * option (b)); re-run `desktop_discover` to obtain an actionable lease.
 */
export interface RoiPreviewEntity {
  /** Best-effort label from OCR / visual recognition (may be "" for icon-only). */
  label: string;
  /** Coarse role hint (e.g. "label", "button"); "unknown" when unclassified. */
  role: string;
  /** Screen-absolute bounding rect of the entity. */
  rect: Rect;
  /** Affordances the entity is believed to support (e.g. ["click"]). */
  actionability: string[];
}

/**
 * ADR-024 Seed-2 (S1 contract lock) — post-action ROI capture attached to a
 * successful `desktop_act` in the *visual-only regime* (UIA-blind / RDP / canvas
 * targets where structured observation is unavailable). Folds "confirm the act
 * result" and "rediscover the next target" into a single round-trip: instead of
 * `act → desktop_state → screenshot`, the act response itself carries a
 * diff-region crop plus a lease-less entity preview.
 *
 * Populated by the registration wrapper (`desktop-register.ts`), NOT the bare
 * `GuardedTouchLoop` — same layering as `observation?` (the loop stays
 * capture-agnostic). Absent on every non-visual-only / no-change path, so
 * existing `{ok, executor, diff, next}` destructures are unaffected (additive,
 * CLAUDE.md §3.2 carry-over). Live since S5: a successful act on a visual-only
 * target with a visible change (and the gate's `returnCapture` mode) carries
 * this; the registration wrapper builds it from the post-action dirty-rect ROI
 * (S3a/S3b) + ROI-aware OCR (S4).
 */
export interface RoiCapture {
  /** Window-relative crop rect the `somImage` covers (the diff region, not the full window). */
  roi: Rect;
  /** Base64 PNG of the cropped diff region. */
  somImage: string;
  /** Lease-less observation preview (re-run `desktop_discover` for actionable leases). */
  entities: RoiPreviewEntity[];
  /** ROI source: DXGI dirty-rect (local UIA-blind) or software frame-diff (RDP). */
  source: "dxgi" | "frame_diff";
}

/**
 * ADR-024 Seed-2 S5b — internal channel carried from a `postSnapshot` closure
 * through `touch()` back to the registration wrapper. NEVER serialized: the
 * wrapper strips it off the result (same split pattern as the Stage 5
 * `observation` / `roiBbox` plumbing) and attaches its parts to the public
 * fields. Lets the single ROI-OCR the closure runs feed the diff (via the
 * returned `candidates`) AND the folded outputs here, without a second OCR.
 */
export interface RoiCaptureMaterial {
  /**
   * Screen-absolute region the post snapshot actually re-observed (the
   * frame-diff change bbox ∪ touched rect). Threaded into the diff as
   * `DiffContext.observedRect` so entities OUTSIDE it are treated as
   * non-observed (not removed). Absent → the diff is unscoped (full-window).
   */
  observedRect?: Rect;
  /** The assembled fold capture; the wrapper sets `result.roiCapture` to it. */
  roiCapture?: RoiCapture;
  /** The frame-diff motion observation; the wrapper sets `result.observation`. */
  observation?: VisualMotionObservation;
}

export type TouchResult =
  | {
      ok: true;
      executor: ExecutorKind;
      diff: SemanticDiff;
      next: "refresh_view" | "none";
      /**
       * ADR-019 Stage 5 — `any_change` primitive observation attached after a
       * successful `desktop_act`. Populated by the registration wrapper
       * (`desktop-register.ts`) when DXGI dirty-rect polling produced an
       * observation; absent on the bare `GuardedTouchLoop` return (the loop
       * itself is Stage 5-agnostic; the verify wiring happens outside the
       * touch lifecycle so envelope-axis changes stay confined to the tool
       * layer). Existing destructures of `{ok, executor, diff, next}` are
       * unaffected (additive — sub-plan §2.5 + CLAUDE.md §3.2 carry-over).
       */
      observation?: VisualMotionObservation;
      /**
       * Issue #327 item C: surfaced when the executor silently fell back from a
       * higher-priority executor (e.g. UIA InvokePattern threw and the mouse
       * rect-center fallback succeeded). Without this marker the LLM sees
       * `capabilities.preferredExecutors: ["uia"]` ↔ `executor: "mouse"` and
       * cannot distinguish "UIA was tried and failed" from "UIA was not the
       * chosen route". The `from` field names the executor that was originally
       * selected; `reason` is the underlying error message. Absent (= field
       * undefined) when no fallback happened.
       */
      downgrade?: ExecutorOutcome["downgrade"];
      /**
       * ADR-024 Seed-2 — post-action ROI capture (diff-region crop + lease-less
       * entity preview) attached by the registration wrapper when the target is
       * visual-only and the act produced a visible change. Absent otherwise
       * (additive — existing destructures unaffected). See {@link RoiCapture}.
       * Live since S5 (the fold).
       */
      roiCapture?: RoiCapture;
      /**
       * ADR-024 Seed-2 S5b — INTERNAL channel from a `postSnapshot` closure;
       * the registration wrapper strips this before serialization and copies
       * its `roiCapture` / `observation` onto the public fields. Never present
       * on the bare loop return when no `postSnapshot` was supplied (additive —
       * existing destructures unaffected). See {@link RoiCaptureMaterial}.
       */
      roiMaterial?: RoiCaptureMaterial;
    }
  | {
      ok: false;
      reason: TouchFailReason;
      diff: SemanticDiff;
      /** Set only when reason='modal_blocking' AND env.findBlockingModal returned a blocker. */
      blockingElement?: BlockingElementInfo;
    };

/**
 * Injectable environment for GuardedTouchLoop.
 * `execute` and `resolvePostTouchEntities` are async to accommodate UI settle time
 * between click and observation (Win32 SendInput returns before WM_PAINT).
 */
export interface TouchEnvironment {
  /** Return freshly resolved live entities (pre-touch snapshot). */
  resolveLiveEntities(): UiEntity[];
  /** Return the current world-state generation string. */
  currentGeneration(): string;
  /** True if a modal or system dialog is blocking the target entity. */
  isModalBlocking(entity: UiEntity): boolean;
  /**
   * Return the modal entity blocking `entity`, or null if none. When provided,
   * GuardedTouchLoop attaches its identity to the response as `blockingElement`.
   * When `isModalBlocking` is overridden, this should be overridden in lockstep —
   * a true/null mismatch will silently drop the blockingElement field instead of
   * crashing. The session-registry default keeps both methods in sync via a shared predicate.
   * Issue #63.
   */
  findBlockingModal?(entity: UiEntity): UiEntity | null;
  /** True if the entity rect is fully or partially within the active viewport. */
  isInViewport(entity: UiEntity): boolean;
  /**
   * Perform the action and return which executor was used. Throw on failure.
   *
   * Issue #327 item C: returning the rich `ExecutorOutcome` shape lets the
   * executor signal a silent fallback (e.g. UIA InvokePattern threw, mouse
   * rect-center succeeded). Returning a bare `ExecutorKind` means "no
   * downgrade happened" and stays back-compat with pre-#327 callers.
   * `GuardedTouchLoop` normalises both shapes and surfaces `TouchResult.downgrade`
   * on the success variant.
   */
  execute(entity: UiEntity, action: TouchAction, text?: string): Promise<ExecutorKind | ExecutorOutcome>;
  /** Return entities after the touch for diff computation. May wait for UI to settle. */
  resolvePostTouchEntities(): Promise<UiEntity[]>;
  /**
   * Return the entityId of the currently focused UI element, or undefined if unknown.
   * Used for focus_shifted detection. Conservative: if not provided, focus_shifted is not emitted.
   * Call at both pre-touch and post-touch time to compare.
   */
  getFocusedEntityId?(): string | undefined;
}

// ── Action resolution ─────────────────────────────────────────────────────────

// Phase 4: 'setValue' is intentionally absent from AUTO_PRIORITY. Entities
// advertise affordances via AffordanceVerb (invoke / click / type / select /
// scrollTo / read), and the equivalent of 'setValue' (UIA ValuePattern,
// CDP fill) is reachable through the 'type' affordance. setValue is only
// meaningful as an *explicit* action requested by the caller, so auto-resolve
// stays on the original verb set.
const AUTO_PRIORITY: ReadonlyArray<Exclude<TouchAction, "auto" | "setValue">> = ["invoke", "click", "type", "select"];

function resolveAction(entity: UiEntity, requested: TouchAction): TouchAction {
  if (requested !== "auto") return requested;
  const verbs = new Set(entity.affordances.map((a: UiAffordance) => a.verb));
  return AUTO_PRIORITY.find((v) => verbs.has(v)) ?? "click";
}

// ── Lease → fail reason mapping ───────────────────────────────────────────────

const LEASE_TO_TOUCH_REASON: Record<string, TouchFailReason> = {
  expired:              "lease_expired",
  generation_mismatch:  "lease_generation_mismatch",
  entity_not_found:     "entity_not_found",
  digest_mismatch:      "lease_digest_mismatch",
};

// ── Blocking-modal info ───────────────────────────────────────────────────────

/**
 * Best-effort name resolution: locator.uia.name (most stable identifier when present)
 *   → entity.label → entity.role → "modal".
 * UIA "unknown"-role dialogs frequently lack a label, so falling all the way through
 * keeps the field non-empty for downstream click_element lookups.
 */
function toBlockingElementInfo(e: UiEntity): BlockingElementInfo {
  const name = e.locator?.uia?.name || e.label || e.role || "modal";
  const automationId = e.locator?.uia?.automationId;
  return automationId ? { name, role: e.role, automationId } : { name, role: e.role };
}

// ── Diff helpers ──────────────────────────────────────────────────────────────

const MOVE_THRESHOLD_PX = 16;

function hasEntityMoved(pre: UiEntity, post: UiEntity): boolean {
  if (!pre.rect || !post.rect) return false;
  return (
    Math.abs(pre.rect.x - post.rect.x) > MOVE_THRESHOLD_PX ||
    Math.abs(pre.rect.y - post.rect.y) > MOVE_THRESHOLD_PX
  );
}

/**
 * Axis-aligned rect overlap test (ADR-024 S5b observed-scope diff). Touching
 * edges count as non-overlapping (strict `<`). Both rects screen-absolute.
 */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}


/**
 * Value fingerprint for an entity — what counts as "the value" varies by source:
 *   UIA textbox / input: entity.value (from ValuePattern)
 *   terminal prompt:     entity.label (the current prompt line)
 *   CDP input:           entity.value (from el.value)
 *   Other:               undefined (no value comparison)
 *
 * Returns undefined when the entity does not expose a value — absence means
 * "value unknown, not comparable", not "value is empty".
 */
function extractValueFingerprint(e: UiEntity): string | undefined {
  if (e.value !== undefined) return e.value;
  // For terminal entities (label = current prompt), the label IS the value.
  if (e.sources.includes("terminal") && e.role === "textbox") return e.label;
  return undefined;
}

// ── Core diff computation ─────────────────────────────────────────────────────

interface DiffContext {
  touched: UiEntity;
  preEntities: UiEntity[];
  postEntities: UiEntity[];
  preFocusId: string | undefined;
  postFocusId: string | undefined;
  /**
   * ADR-024 Seed-2 S5b (D2) — screen-absolute region the POST snapshot actually
   * re-observed. When set (visual-only fold path), the diff is scoped to it:
   * pre-entities OUTSIDE it were not re-observed, so they must NOT be counted as
   * removed/dismissed, and the touched-entity fate is only asserted when the
   * touched entity lies inside it. Absent (the default / non-fold path) → the
   * diff is unscoped, identical to pre-S5b behaviour (byte-equal).
   */
  observedRect?: Rect;
}

function computeDiff(ctx: DiffContext): SemanticDiff {
  const { touched, preEntities, postEntities, preFocusId, postFocusId, observedRect } = ctx;
  const diff: SemanticDiff = [];

  const preIds  = new Set(preEntities.map((e) => e.entityId));
  const postIds = new Set(postEntities.map((e) => e.entityId));

  // ADR-024 Seed-2 S5b (D2) — observed-scope predicate. When `observedRect` is
  // set, the post snapshot only re-observed that region; an entity outside it
  // was NOT looked at, so it must not be judged removed/dismissed and the
  // touched fate is only asserted for an in-region touched entity. When unset
  // (default / non-fold), every entity is in scope → identical to pre-S5b
  // behaviour (byte-equal). An entity with no rect is in scope only when
  // unscoped (we cannot prove overlap), so the unscoped path stays unchanged.
  const inScope = (e: UiEntity): boolean =>
    observedRect === undefined ||
    (e.rect !== undefined && rectsIntersect(e.rect, observedRect));

  // ── Touched entity fate ───────────────────────────────────────────────────

  // entityId stability is the identity contract.
  // id-preserving move → entity_moved; id-changing replace → entity_disappeared.
  // Scoped: only assert fate when the touched entity was in the re-observed
  // region (always true on the unscoped path).
  if (inScope(touched)) {
    const postTouched = postEntities.find((e) => e.entityId === touched.entityId);
    if (!postTouched) {
      diff.push("entity_disappeared");
    } else {
      if (hasEntityMoved(touched, postTouched)) diff.push("entity_moved");

      // value_changed: compare entity.value (or label for terminal) pre vs post.
      // Only emitted when both sides expose a value — absence of value means not comparable.
      const preVal  = extractValueFingerprint(touched);
      const postVal = extractValueFingerprint(postTouched);
      if (preVal !== undefined && postVal !== undefined && preVal !== postVal) {
        diff.push("value_changed");
      }
    }
  }

  // ── Appeared / disappeared entities ───────────────────────────────────────

  // `appeared` is drawn from the post snapshot (already region-bound on the
  // fold path); `removed` is scoped so out-of-region pre-entities (never
  // re-observed) are not falsely counted as gone.
  const appeared = postEntities.filter((e) => !preIds.has(e.entityId));
  const removed  = preEntities.filter((e) => !postIds.has(e.entityId) && inScope(e));

  // modal_appeared / modal_dismissed take priority for modal entities.
  // ADR-020 PR-P2-1: unified classifier (post-touch-diff context, no self-exclusion;
  // the `touched` entity is handled separately above).
  const modalAppeared   = appeared.filter((e) => classifyModal(e, "post-touch-diff"));
  const modalDismissed  = removed.filter((e) => classifyModal(e, "post-touch-diff"));
  if (modalAppeared.length   > 0) diff.push("modal_appeared");
  if (modalDismissed.length  > 0) diff.push("modal_dismissed");

  // entity_appeared: non-modal entities that are new in the post snapshot.
  // Suppressed for entities already covered by modal_appeared.
  const nonModalAppeared = appeared.filter((e) => !classifyModal(e, "post-touch-diff"));
  if (nonModalAppeared.length > 0) diff.push("entity_appeared");

  // ── Focus shift ───────────────────────────────────────────────────────────

  // Conservative: only emit when env provides focus info and it unambiguously changed.
  // "not provided" (undefined) ≠ "not focused" — if either side is unknown, skip.
  if (
    preFocusId !== undefined &&
    postFocusId !== undefined &&
    preFocusId !== postFocusId
  ) {
    diff.push("focus_shifted");
  }

  return diff;
}

// ── GuardedTouchLoop ──────────────────────────────────────────────────────────

/**
 * GuardedTouchLoop — safe execution pipeline for visual-only and mixed-source entities.
 *
 * Flow: validate lease → resolve auto-action → pre-touch checks → execute → semantic diff
 *
 * TOCTOU guarantee: the same `live` snapshot is used for both lease validation and
 * the diff baseline. No await occurs between validate() and execute().
 *
 * Semantic diff codes:
 *   entity_disappeared  — touched entity no longer in post snapshot
 *   entity_moved        — touched entity moved > 16px
 *   modal_appeared      — new UIA unknown-role overlay appeared
 *   modal_dismissed     — UIA unknown-role overlay disappeared
 *   value_changed       — entity's value or terminal label changed (source-specific)
 *   entity_appeared     — non-modal entity appeared in post snapshot
 *   focus_shifted       — focus moved to a different entity (requires getFocusedEntityId)
 */
export class GuardedTouchLoop {
  constructor(
    private readonly leaseStore: LeaseStore,
    private readonly env: TouchEnvironment
  ) {}

  async touch(input: TouchInput): Promise<TouchResult> {
    const { lease, action = "auto", text } = input;

    // 1. Re-resolve current state and validate lease atomically.
    const gen  = this.env.currentGeneration();
    const live = this.env.resolveLiveEntities();
    const validation = this.leaseStore.validate(lease, gen, live);

    if (!validation.ok) {
      const reason = LEASE_TO_TOUCH_REASON[validation.reason] ?? "entity_not_found";
      return { ok: false, reason, diff: [] };
    }

    const entity = validation.entity;

    // 2. Resolve "auto" to a concrete verb.
    const concreteAction = resolveAction(entity, action);

    // 3. Pre-touch environment checks.
    if (this.env.isModalBlocking(entity)) {
      const blocker = this.env.findBlockingModal?.(entity) ?? null;
      return {
        ok: false,
        reason: "modal_blocking",
        diff: [],
        ...(blocker ? { blockingElement: toBlockingElementInfo(blocker) } : {}),
      };
    }
    if (!this.env.isInViewport(entity)) {
      return { ok: false, reason: "entity_outside_viewport", diff: [] };
    }

    // 4. Capture pre-touch focus (before execute).
    const preFocusId = this.env.getFocusedEntityId?.();

    // 5. Execute — no await between validate and execute (TOCTOU prevention).
    // ADR-020 PR-P2-2: record act attempt timestamp before execute. Captures
    // LLM thinking time (act attempt = end-of-thinking), independent of
    // execute success/failure. Read on the next see() call via either
    // peekObservedRoundTripMs() + commitObservedRoundTripMs(token) (the
    // production path, CAS-guarded so concurrent acts are not stomped) or
    // consumeObservedRoundTripMs() (BC composite for one-shot callers /
    // tests). validation early-returns above bypass this hook by construction,
    // so failure paths never pollute the round-trip wallclock.
    this.leaseStore.recordAct(lease.viewId);
    let outcome: ExecutorKind | ExecutorOutcome;
    try {
      outcome = await this.env.execute(entity, concreteAction, text);
    } catch {
      return { ok: false, reason: "executor_failed", diff: [] };
    }
    // Issue #327 item C: normalise bare-kind / rich-outcome return shapes so
    // downstream stays single-shape.
    const executor: ExecutorKind = typeof outcome === "string" ? outcome : outcome.kind;
    const downgrade: ExecutorOutcome["downgrade"] | undefined =
      typeof outcome === "string" ? undefined : outcome.downgrade;

    // 6. Compute semantic diff against the pre-touch snapshot.
    //
    // ADR-024 Seed-2 S5b — when the caller supplied a `postSnapshot` closure
    // (visual-only fold path), use it for the post-touch candidates INSTEAD of
    // `env.resolvePostTouchEntities()`, and carry its `roiMaterial` back out.
    // The closure returns lease-less candidates; convert with the SAME
    // `resolveCandidates(gen)` (gen captured at step 1) the env path uses, so
    // entityIds match the pre snapshot. Absent (every non-fold path) → the
    // existing env path runs and `roiMaterial` stays undefined (byte-equal).
    let post: UiEntity[];
    let roiMaterial: RoiCaptureMaterial | undefined;
    if (input.postSnapshot) {
      const snapshot = await input.postSnapshot();
      post = resolveCandidates(snapshot.candidates, gen);
      roiMaterial = snapshot.roiMaterial;
    } else {
      post = await this.env.resolvePostTouchEntities();
    }
    const postFocusId = this.env.getFocusedEntityId?.();

    const diff = computeDiff({
      touched: entity,
      preEntities: live,
      postEntities: post,
      preFocusId,
      postFocusId,
      observedRect: roiMaterial?.observedRect,
    });

    return {
      ok: true,
      executor,
      diff,
      next: diff.length > 0 ? "refresh_view" : "none",
      ...(downgrade ? { downgrade } : {}),
      ...(roiMaterial ? { roiMaterial } : {}),
    };
  }
}
