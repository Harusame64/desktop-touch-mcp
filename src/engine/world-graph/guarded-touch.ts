import type { UiEntity, EntityLease, ExecutorKind, UiAffordance } from "./types.js";
import type { LeaseStore } from "./lease-store.js";

export type TouchAction = "auto" | "invoke" | "click" | "type" | "select";

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
>;
// NOTE: "value_changed" is omitted — field-diffing is not implemented in PoC.

export type TouchFailReason =
  | "lease_expired"
  | "lease_generation_mismatch"
  | "entity_not_found"
  | "lease_digest_mismatch"
  | "modal_blocking"
  | "entity_outside_viewport"
  | "executor_failed";

export type TouchResult =
  | { ok: true; executor: ExecutorKind; diff: SemanticDiff; next: "refresh_view" | "none" }
  | { ok: false; reason: TouchFailReason; diff: SemanticDiff };

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
  /** True if the entity rect is fully or partially within the active viewport. */
  isInViewport(entity: UiEntity): boolean;
  /** Perform the action and return which executor was used. Throw on failure. */
  execute(entity: UiEntity, action: TouchAction, text?: string): Promise<ExecutorKind>;
  /** Return entities after the touch for diff computation. May wait for UI to settle. */
  resolvePostTouchEntities(): Promise<UiEntity[]>;
}

// Action resolution priority for "auto" mode.
const AUTO_PRIORITY: ReadonlyArray<TouchAction> = ["invoke", "click", "type", "select"];

/** Resolve "auto" to the highest-priority concrete verb the entity supports. */
function resolveAction(entity: UiEntity, requested: TouchAction): TouchAction {
  if (requested !== "auto") return requested;
  const verbs = new Set(entity.affordances.map((a: UiAffordance) => a.verb));
  return AUTO_PRIORITY.find((v) => verbs.has(v)) ?? "click";
}

const LEASE_TO_TOUCH_REASON: Record<string, TouchFailReason> = {
  expired:              "lease_expired",
  generation_mismatch:  "lease_generation_mismatch",
  entity_not_found:     "entity_not_found",
  digest_mismatch:      "lease_digest_mismatch",
};

const MOVE_THRESHOLD_PX = 16;

function hasEntityMoved(pre: UiEntity, post: UiEntity): boolean {
  if (!pre.rect || !post.rect) return false;
  return (
    Math.abs(pre.rect.x - post.rect.x) > MOVE_THRESHOLD_PX ||
    Math.abs(pre.rect.y - post.rect.y) > MOVE_THRESHOLD_PX
  );
}

/**
 * Modal heuristic: a UIA-sourced entity with role "unknown" is likely an overlay
 * or dialog that appeared as a side effect of the touch.
 *
 * This is intentionally conservative — plain toolbar buttons from UIA have specific
 * roles ("button", "menuitem") and are excluded. A richer heuristic (ControlType=Dialog,
 * IsModal=true) requires UIA property access not yet wired in Batch 8.
 */
function isModalLike(e: UiEntity): boolean {
  return e.sources.includes("uia") && e.role === "unknown";
}

function computeDiff(
  touched: UiEntity,
  preEntities: UiEntity[],
  postEntities: UiEntity[]
): SemanticDiff {
  const diff: SemanticDiff = [];
  const preIds  = new Set(preEntities.map((e) => e.entityId));
  const postIds = new Set(postEntities.map((e) => e.entityId));

  // Invariant: entityId stability is the identity contract.
  // id-preserving move → entity_moved; id-changing replace → entity_disappeared.
  const postTouched = postEntities.find((e) => e.entityId === touched.entityId);
  if (!postTouched) {
    diff.push("entity_disappeared");
  } else if (hasEntityMoved(touched, postTouched)) {
    diff.push("entity_moved");
  }

  const appeared = postEntities.filter((e) => !preIds.has(e.entityId));
  const removed  = preEntities.filter((e) => !postIds.has(e.entityId));
  if (appeared.some(isModalLike)) diff.push("modal_appeared");
  if (removed.some(isModalLike))  diff.push("modal_dismissed");

  return diff;
}

/**
 * GuardedTouchLoop — safe execution pipeline for visual-only and mixed-source entities.
 *
 * Flow: validate lease → resolve auto-action → pre-touch checks → execute → semantic diff
 *
 * TOCTOU guarantee: the same `live` snapshot is used for both lease validation and
 * the diff baseline. No await occurs between validate() and execute().
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

    // 2. Resolve "auto" to a concrete verb based on the entity's affordances.
    const concreteAction = resolveAction(entity, action);

    // 3. Pre-touch environment checks.
    if (this.env.isModalBlocking(entity)) {
      return { ok: false, reason: "modal_blocking", diff: [] };
    }
    if (!this.env.isInViewport(entity)) {
      return { ok: false, reason: "entity_outside_viewport", diff: [] };
    }

    // 4. Execute — no await between validate and execute (TOCTOU prevention).
    let executor: ExecutorKind;
    try {
      executor = await this.env.execute(entity, concreteAction, text);
    } catch {
      return { ok: false, reason: "executor_failed", diff: [] };
    }

    // 5. Compute semantic diff against the pre-touch snapshot.
    const post = await this.env.resolvePostTouchEntities();
    const diff = computeDiff(entity, live, post);

    return { ok: true, executor, diff, next: diff.length > 0 ? "refresh_view" : "none" };
  }
}
