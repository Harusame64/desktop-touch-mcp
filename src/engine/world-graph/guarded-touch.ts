import type { UiEntity, EntityLease, ExecutorKind, UiAffordance } from "./types.js";
import type { LeaseStore } from "./lease-store.js";

export type TouchAction = "auto" | "invoke" | "click" | "type" | "setValue" | "select";

export interface TouchInput {
  lease: EntityLease;
  action?: TouchAction;
  text?: string;
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

export type TouchResult =
  | { ok: true; executor: ExecutorKind; diff: SemanticDiff; next: "refresh_view" | "none" }
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
  /** Perform the action and return which executor was used. Throw on failure. */
  execute(entity: UiEntity, action: TouchAction, text?: string): Promise<ExecutorKind>;
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
 * Modal heuristic: UIA-sourced entity with role "unknown" is likely an overlay/dialog.
 * Conservative — plain toolbar buttons have specific roles and are excluded.
 * A richer heuristic (ControlType=Dialog, IsModal=true) requires UIA property access
 * not yet wired.
 */
function isModalLike(e: UiEntity): boolean {
  return e.sources.includes("uia") && e.role === "unknown";
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
}

function computeDiff(ctx: DiffContext): SemanticDiff {
  const { touched, preEntities, postEntities, preFocusId, postFocusId } = ctx;
  const diff: SemanticDiff = [];

  const preIds  = new Set(preEntities.map((e) => e.entityId));
  const postIds = new Set(postEntities.map((e) => e.entityId));

  // ── Touched entity fate ───────────────────────────────────────────────────

  // entityId stability is the identity contract.
  // id-preserving move → entity_moved; id-changing replace → entity_disappeared.
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

  // ── Appeared / disappeared entities ───────────────────────────────────────

  const appeared = postEntities.filter((e) => !preIds.has(e.entityId));
  const removed  = preEntities.filter((e) => !postIds.has(e.entityId));

  // modal_appeared / modal_dismissed take priority for modal entities.
  const modalAppeared   = appeared.filter(isModalLike);
  const modalDismissed  = removed.filter(isModalLike);
  if (modalAppeared.length   > 0) diff.push("modal_appeared");
  if (modalDismissed.length  > 0) diff.push("modal_dismissed");

  // entity_appeared: non-modal entities that are new in the post snapshot.
  // Suppressed for entities already covered by modal_appeared.
  const nonModalAppeared = appeared.filter((e) => !isModalLike(e));
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
    let executor: ExecutorKind;
    try {
      executor = await this.env.execute(entity, concreteAction, text);
    } catch {
      return { ok: false, reason: "executor_failed", diff: [] };
    }

    // 6. Compute semantic diff against the pre-touch snapshot.
    const post        = await this.env.resolvePostTouchEntities();
    const postFocusId = this.env.getFocusedEntityId?.();

    const diff = computeDiff({ touched: entity, preEntities: live, postEntities: post, preFocusId, postFocusId });

    return { ok: true, executor, diff, next: diff.length > 0 ? "refresh_view" : "none" };
  }
}
