import type { UiEntity, EntityLease, ExecutorKind, ExecutorOutcome, UiAffordance } from "./types.js";
import type { LeaseStore } from "./lease-store.js";
import type { VisualMotionObservation } from "../../tools/_input-pipeline.js";
import type { Rect, UiEntityCandidate } from "../vision-gpu/types.js";
import { classifyModal } from "./session-registry.js";
import { probeAim } from "../aim-probe.js";
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
  | "origin_window_not_visible"
  | "coordinate_outside_reachable_bounds"
  | "cursor_placement_blocked"
  | "aim_window_gone"
  | "aim_identity_changed"
  | "aim_point_outside_window"
  | "aim_occluded"
  | "aim_blocked_by_excluded_window"
  | "aim_route_failed"
  | "keyboard_target_unsafe"
  | "window_excluded"
  | "action_not_offered"
  | "executor_failed";

/**
 * ADR-029 Phase 1 — result of the pre-touch viewport check.
 *
 * `null` means "cleared, proceed"; a non-null value is the `TouchFailReason`
 * to report. Modelled as a reason rather than a boolean because the two block
 * cases need different recovery advice: `entity_outside_viewport` is recovered
 * by scrolling or re-discovering, while `origin_window_not_visible` (the
 * origin window is minimised / DWM-cloaked, so nothing is rendered at those
 * coordinates) is only recovered by restoring the window with `focus_window`
 * and re-running `desktop_discover`.
 */
export type ViewportVerdict = null | "entity_outside_viewport" | "origin_window_not_visible";

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
  /**
   * internal #126 — the blocking window's handle. Set when the OS named the dialog (`role:
   * "dialog"`), and when the discover snapshot's blocker — always a UIA `Window` since #686 —
   * recorded a window handle of its own. A title can be empty or shared ("Error"), and
   * `focus_window` matches titles by substring; the handle reaches that window exactly, via
   * `desktop_discover`'s `target.hwnd`.
   */
  hwnd?: string;
}

/**
 * internal #126 — what the OS said about the entity's own window at the moment of the act.
 *
 * - `blocked`: the window is disabled and a live window of its owner family (or its thread) is the
 *   dialog doing it. A clear ground: the act is refused.
 * - `takes_input`: the window the element ITSELF is in — its own handle's root — is enabled. **A
 *   clear answer the other way**, and it outranks the snapshot's guess: a `Window` in the discover
 *   snapshot rang on a modeless owned form, an MDI child, a form embedded in the window (internal
 *   `62b4590`) and on the very dialog whose own button was being pressed (gate 2 on #686), while the
 *   OS told all of them apart from the real modal, whose owner it disables.
 * - `cannot_say`: no handle, no root, the aim's window changed owner, disabled with nothing live to
 *   name, unreadable — or enabled, but asked about by a handle that is not the element's own (the
 *   window the read was made from can be the owner of the window the element is in). The snapshot
 *   check runs as before.
 */
export type WindowBlockAnswer =
  | { kind: "blocked"; blocker: BlockingElementInfo }
  | { kind: "takes_input" }
  | { kind: "cannot_say" };

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
  /** Window-relative crop rect the crop covers (the diff region, not the full window). */
  roi: Rect;
  /**
   * ADR-026 §3.6: the cropped diff region's PNG is delivered **by-ref** via
   * `somImageRef` (a `screenshot://by-ref/{id}` resource the act response also
   * attaches as a `resource_link` content block). This inline base64 is `null` by
   * default — the pixels are deferred so the act envelope stays cheap. Open the
   * ref only when you actually need to look at the crop.
   *
   * (Widened `string → string | null` in ADR-026: nullability only — the meaning
   * "base64 PNG of the crop" is unchanged, additive-safe for existing readers.)
   */
  somImage: string | null;
  /**
   * ADR-026 §3.6: `screenshot://by-ref/{id}` URI for the cropped diff region's
   * PNG. Present whenever a crop was rendered AND persisted; absent only on a
   * disk-cache write failure (see `somImageWarning`).
   */
  somImageRef?: string;
  /**
   * ADR-026 §3.6 R6: set only when persisting the crop failed (disk full /
   * EACCES). The crop pixels are unavailable this turn (no `somImageRef`), but the
   * act still succeeded and the structural `roi` / `entities` / `source` are
   * intact. Never falls back to inline base64 (that would resurrect the token cost
   * with no ref).
   */
  somImageWarning?: string;
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
       * ADR-036 family 2 — the keyboard rung posted, but could not confirm the characters reached the
       * element named; see {@link ExecutorOutcome.landing}. Absent on a confirmed write.
       */
      landing?: ExecutorOutcome["landing"];
      /**
       * ADR-024 Seed-2 — post-action ROI capture (diff-region crop + lease-less
       * entity preview) attached by the registration wrapper when the target is
       * visual-only and the act produced a visible change. Absent otherwise
       * (additive — existing destructures unaffected). See {@link RoiCapture}.
       * Live since S5 (the fold).
       */
      roiCapture?: RoiCapture;
      /**
       * ADR-036 (internal #166) — the kinds of change this act's `diff` could not report, because the
       * post-action read did not look for them. Set by the registration wrapper on the S5b fold, whose
       * post snapshot carries discover's entities forward instead of reading them again, so it does
       * not detect an entity that vanished, moved, appeared or changed value. A listed kind that does
       * appear in `diff` there came from an entity the fold could not carry (one with no rect, or no
       * OCR target id to rebuild it under), not from a look. Absent on every other road; its absence
       * does NOT mean every kind was looked for — on S5, an OCR entity has no value to compare, and a
       * move under the id's 8 px rounding is below the 16 px move threshold (gate 2 on #720).
       */
      diffUnchecked?: SemanticDiff;
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
      /**
       * ADR-036 item 13 — WHAT THE ENGINE KNEW, carried instead of rebuilt.
       *
       * The refusal that reaches this loop is a typed error whose message names the specifics: the
       * window drawn over the point and its handle, which of the three identity fields changed, the
       * rectangle the point left. The loop used to keep only the reason code, and
       * `desktop-register.ts` then wrote fresh text from that code alone — so a caller was told
       * "another window is drawn over the point" and never which window (measured 2026-09-10, win2,
       * `dev/item13-envelope/`: the blocker's title and handle appear NOWHERE in the response, and
       * the envelope has no message field at all).
       *
       * `undefined` when the throw carried no message, and absent rather than empty, so a row that
       * has nothing to say does not claim to.
       */
      detail?: string;
    };

/**
 * Injectable environment for GuardedTouchLoop.
 * `execute` and `resolvePostTouchEntities` are async to accommodate UI settle time
 * between click and observation (Win32 SendInput returns before WM_PAINT).
 */
export interface TouchEnvironment {
  /**
   * Return the entities a diff's PRE side is taken from. NOT a fresh resolve: the only
   * implementation hands back the session's stored `desktop_discover` snapshot
   * (`session-registry.ts:362`). The shipped `landing` sentence says exactly that about
   * `diff.value_changed`, and this line used to say the opposite — an auditor starting here
   * would have "fixed" the shipped string back (gate 2, 2026-09-14).
   */
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
  /**
   * internal #126 — the OS's answer, read at the moment of the act: is the entity's own window
   * disabled by a dialog it owns? See {@link WindowBlockAnswer}.
   *
   * `isModalBlocking` looks at the `desktop_discover` snapshot, which is scoped to the target
   * window — a `ShowDialog` / `MessageBox` in ANOTHER top-level window is not in it, whenever
   * discover runs, and the act that runs into it degraded to a press the OS swallowed and answered
   * `ok:true` (win2, 2026-09-18). This asks the window instead of the snapshot. Optional: absent
   * means "not asked", which the loop treats as `cannot_say`.
   */
  findBlockingWindow?(entity: UiEntity): WindowBlockAnswer;
  /**
   * ADR-029 Phase 1: check whether the entity is currently reachable on screen.
   * Returns `null` when the touch may proceed, otherwise the block reason.
   * (Replaces the pre-ADR-029 boolean `isInViewport`; the rename is deliberate
   * so `!check(...)` cannot silently invert the new null-means-ok convention.)
   */
  checkViewport(entity: UiEntity): ViewportVerdict;
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

/**
 * **An action this product cannot perform must not become a different action** (internal #154).
 *
 * MEASURED, win2, 2026-09-21, on `main` `c8f87c4f`, one act per arm with a WinForms fixture's own
 * click log read before and after: `desktop_act(action:"select")` on a Button answered
 * `{"ok":true,"executor":"uia","diff":[],"next":"none"}` — **and pressed it**. The reply is
 * BYTE-IDENTICAL to `click`'s and `invoke`'s, so a caller cannot tell "I pressed it because you
 * asked" from "I pressed it because there was nothing else to do with `select`". Whatever the button
 * does — submit, delete, send — happened. That is one step past the road the user closed on
 * 2026-09-11: not a success reported for an act that did not happen, but **an act the caller did not
 * ask for, performed on the world.**
 *
 * ── WHY THIS REFUSES `select` OUTRIGHT, rather than "when the entity does not offer it" ─────────
 *
 * **The first version did the forward-compatible thing and it was a trap** (gate 2). It asked the
 * ENTITY — refuse unless the affordances list the verb — which expresses one of the two independent
 * reasons `select` cannot work here and silently leans on the other:
 *
 *   1. **No producer can advertise it.** The field is typed at one place,
 *      `vision-gpu/types.ts` → `actionability: Array<"click" | "invoke" | "type" | "read">`, and
 *      `"select"` is not in that union. Six writers fill it; none can.
 *   2. **No executor road takes it.** `desktop-executor.ts` branches on
 *      `(action === "type" || action === "setValue") && text !== undefined` on the UIA road and the
 *      same shape on the CDP road; **everything else falls to `uiaClick` / `cdpClick`.** There is no
 *      `select` arm anywhere.
 *
 * So an entity-shaped guard approves the verb the day (1) changes, and (2) presses the target. Gate
 * 2 measured exactly that: teach a provider to advertise `select`, and `tsc`, `eslint`, all four
 * vocabulary gates, every cell in this file and the whole unit suite stay green **while the press
 * comes back with this guard's blessing.**
 *
 * **TO SUPPORT `select`, BOTH HALVES HAVE TO EXIST**, and this refusal is where you come to remove
 * it. The two cells in `adr-036-an-action-the-target-does-not-offer.test.ts` name what must be true
 * first — one on the producing TYPE, one on the executor's dispatch — so neither half can be built
 * quietly. Until then a caller asking to select is told nothing happened, which is the truth.
 */
function offersAction(entity: UiEntity, action: TouchAction): boolean {
  switch (action) {
    // **NOT SUPPORTED BY THIS PRODUCT** — see above. Refused before anything touches the world.
    case "select":
      return false;
    // **Text into a control UI Automation says only presses** (internal #154, W3). Measured, win2,
    // 2026-09-21: `setValue` with text on a Button answered `ok:true` with executor `keyboard` — no
    // value was set, and the text went out as keystrokes to whatever held the focus.
    //
    // THE GROUND IS THE UIA CONTROL TYPE, NOT THE AFFORDANCES, and not "lacks `type`":
    //   - an OCR entity advertises `click` only, and typing into a blind window is a designed road
    //     (the keyboard rung's marked success, release cut W-g) — "no `type`" would refuse all of it;
    //   - a UIA text area outside Edit/ComboBox (a `Document`, a custom control) advertises `read`,
    //     and #327 item E's keyboard fallback exists for exactly such fields;
    //   - `invoke` in the affordances is a union across sources, and the visual lane adds it for any
    //     region its detector calls a button — a guess, not a clear ground.
    // The control type is what UIA itself reported for the element (`entity.controlType`). Measured
    // before this line (win2 `2b8f8c4` / `03ef392` / `82b635f`): Notepad's body is not in the set on
    // either road, and a dialog's edit box is `Edit`, so nothing written today is refused.
    case "type":
    case "setValue":
      return !(entity.controlType !== undefined && (UIA_PRESS_ONLY_CONTROL_TYPES as readonly string[]).includes(entity.controlType));
    case "auto":
    case "invoke":
    case "click":
      return true;
    default: {
      // **A NEW VERB HAS TO BE DECIDED HERE, at compile time** (gate 2). The previous version was a
      // single `if (action !== "select")`, and adding a verb to `TouchAction` sailed past it into
      // the same fall-through — measured: `tsc`, `eslint`, the four gates and the whole unit suite
      // green, with the new verb pressing whatever it was aimed at.
      const _exhaustive: never = action;
      void _exhaustive;
      return true;
    }
  }
}

/**
 * The UIA control types that only press: `invoke` and `click` are what they offer, and none of them
 * takes text. One place, read by the UIA provider (their affordances) and by {@link offersAction}
 * (the refusal of text into them), so the two cannot drift apart.
 */
export const UIA_PRESS_ONLY_CONTROL_TYPES = ["Button", "CheckBox", "RadioButton", "Hyperlink", "MenuItem"] as const;

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
  // The window's own handle, so the advice can send the caller to it by handle (internal #126): the
  // snapshot's blocker is a window, and "click_element(name=its title)" does not dismiss a window.
  const own = e.locator?.uia?.nativeWindowHandle;
  const hwnd = own !== undefined && /^\d+$/.test(own) && BigInt(own) !== 0n ? own : undefined;
  return {
    name,
    role: e.role,
    ...(automationId ? { automationId } : {}),
    ...(hwnd !== undefined ? { hwnd } : {}),
  };
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
  //
  // Internal #163 — and a `stale` entity is not evidence that anything appeared: no lane looked at it
  // in the post read. Gate 2 on the supersede: discover drops a replayed copy when OCR saw the same
  // label, so the copy is not in `preEntities`; after a click that REMOVES that label, OCR no longer
  // sees it and the post read keeps the replay — the pre-click screen — which then read as a new
  // entity (`entity_disappeared` + a ghost `entity_appeared`).
  const appeared = postEntities.filter((e) => !preIds.has(e.entityId) && e.status !== "stale");
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
 *   modal_appeared      — a new UIA `Window` appeared (an owned dialog, internal #126)
 *   modal_dismissed     — a UIA `Window` disappeared
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

    // 1. Read the current generation and the session's stored entities, and validate the lease
    //    against them atomically. `resolveLiveEntities` is NOT a fresh resolve — see its
    //    declaration: the only implementation hands back the `desktop_discover` snapshot, which
    //    is why the shipped `landing` sentence says `diff.value_changed` has its baseline there
    //    and not at the write. This comment said "re-resolve" for as long as the interface did.
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

    // 2b. **An action the target does not offer is refused here, before anything touches the world**
    // (internal #154 — see `offersAction`). It comes BEFORE the environment checks on purpose: no
    // change to the environment can make this one succeed, and a caller told `modal_blocking` would
    // dismiss the modal, retry, and get the press this refusal exists to stop.
    if (!offersAction(entity, concreteAction)) {
      // **THE LOOP ALREADY HOLDS THE ANSWER THE CALLER NEEDS** — which verbs this target does take
      // — so it is carried rather than left to be re-derived (ADR-036 item 13). Without it the
      // advice's "read the affordances in the desktop_discover response" asks the caller to go back
      // to a reply they may no longer have, to learn something this refusal knew when it fired.
      const offered = [...new Set(entity.affordances.map((a: UiAffordance) => a.verb))].sort();
      return {
        ok: false,
        reason: "action_not_offered",
        diff: [],
        detail: offered.length > 0
          ? `this target offers: ${offered.join(", ")}`
          : "this target offers no actions",
      };
    }

    // 3. Pre-touch environment checks.
    // The OS first: a window disabled by a dialog it owns is a clear ground to refuse — the user's
    // rule (2026-09-11) is "refuse, but only when the grounds are clear" — and it is the one modal
    // the snapshot cannot contain.
    const windowAnswer = this.env.findBlockingWindow?.(entity) ?? { kind: "cannot_say" };
    if (windowAnswer.kind === "blocked") {
      return { ok: false, reason: "modal_blocking", diff: [], blockingElement: windowAnswer.blocker };
    }
    // …and when the OS says the window takes input, the snapshot's `Window` is not a clear ground:
    // it cannot tell a modal from a modeless owned form, an MDI child or an embedded form, and the
    // OS can (internal `62b4590`). What this gives up is a modal that does not disable its owner —
    // Tk's `grab_set` is one (internal `af5ed7d`); the act is not refused, and with the aim probe on
    // the row says what the snapshot saw, so a press that then lands nowhere can be traced to it.
    if (windowAnswer.kind === "takes_input") {
      const setAside = this.env.findBlockingModal?.(entity) ?? null;
      if (setAside !== null) {
        const seen = toBlockingElementInfo(setAside);
        probeAim("act.modal", { entityId: entity.entityId, answer: "snapshot_set_aside", because: "window_enabled", snapshotBlocker: seen.name });
      }
    } else if (this.env.isModalBlocking(entity)) {
      const blocker = this.env.findBlockingModal?.(entity) ?? null;
      return {
        ok: false,
        reason: "modal_blocking",
        diff: [],
        ...(blocker ? { blockingElement: toBlockingElementInfo(blocker) } : {}),
      };
    }
    const viewportVerdict = this.env.checkViewport(entity);
    if (viewportVerdict !== null) {
      return { ok: false, reason: viewportVerdict, diff: [] };
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
    } catch (err) {
      /**
       * ADR-036 item 13 — the sentence the thrower declared fit to publish, or nothing.
       *
       * **Not `err.message`, and the first version of this line was.** Reading any throw's message
       * publishes whatever a backend happened to say: the UIA road runs a ~2.5 KB PowerShell script
       * through `execFileAsync`, whose rejection message is `Command failed:` plus the whole
       * command line and stderr — and on the `type` road the script carries the text being typed
       * (gate 2, Opus sandbox review, 2026-09-10). A caller-facing field is not a place to forward
       * an exception to.
       *
       * So the contract is opt-in: `CallerFacingRefusal.callerDetail` (`aim.ts`) is a class saying
       * "this sentence is written for a caller". Anything else — every backend exception, every
       * `throw "string"` — produces no detail, and that reason arrives exactly as it did before
       * this item. Duck-typed rather than `instanceof`, for the same module-identity reason the
       * catch below matches on `name`.
       *
       * Capped as defence in depth: the longest sentence any of these classes writes was 654
       * characters when they were last counted (2026-09-12, the keyboard rung's by-handle recovery),
       * so a value past the cap means something unexpected is being published, and a truncated field
       * is easier to notice than a page of text. The number is a measurement, not a budget — it
       * moves when a sentence is reworded; the cap is what holds.
       */
      const declared = (err as { callerDetail?: unknown } | null)?.callerDetail;
      const detail = typeof declared === "string" && declared.trim() !== ""
        ? declared.slice(0, 1000)
        : undefined;
      // ADR-029 Phase 1: an unreachable-coordinate refusal keeps its own reason.
      // Collapsing it into executor_failed would hand the caller that reason's
      // recovery advice — "fall back to mouse_click" — which walks straight back
      // into the same guard. Matched on `name` (not instanceof) because the
      // error crosses module boundaries where a duplicated class identity would
      // silently fail the check.
      if (err instanceof Error && err.name === "CoordinateOutsideReachableBounds") {
        return { ok: false, reason: "coordinate_outside_reachable_bounds", diff: [], ...(detail !== undefined && { detail }) };
      }
      // ADR-029 Phase 2a: same reasoning for a cursor that could not be placed
      // at all. Its recovery (free the cursor, reconnect the session) shares
      // nothing with either executor_failed or the unreachable-coordinate
      // advice, so it must not be folded into them.
      if (err instanceof Error && err.name === "CursorPlacementBlocked") {
        return { ok: false, reason: "cursor_placement_blocked", diff: [], ...(detail !== undefined && { detail }) };
      }
      // ADR-036 — the window the action was aimed at is gone, and this is the third refusal that
      // must not become `executor_failed` for exactly the reason written above: that reason's
      // advice is "fall back to mouse_click", and the only coordinates the caller has are the
      // entity's rect — which is where the window USED to be. Whatever occupies it now takes the
      // click. `aim.ts` says so in its own words; the type was built, thrown and then flattened
      // here, so the advice arrived unchanged (measured on Windows 2026-09-09: an excluded window
      // and a closed one produced identical envelopes down to all four `try_next` items).
      if (err instanceof Error && err.name === "AimedWindowGoneError") {
        return { ok: false, reason: "aim_window_gone", diff: [], ...(detail !== undefined && { detail }) };
      }
      // ADR-036 item 2 — the handle now belongs to a different process. The specification calls
      // this invalidation rather than an ordinary update, and the distinction is the whole point:
      // an action addressed to this aim would not fail, it would succeed against a stranger.
      if (err instanceof Error && err.name === "AimIdentityChangedError") {
        // The engine's message names the field that decided (`describeIdentityChange` in `aim.ts`).
        // It used to stop here — the reason was all `TouchResult` carried, and `desktop-register.ts`
        // rendered its own text from the reason alone, so the published advice had to be stripped of
        // any promise that the message said WHICH of the three happened (PR 側 codex on #608, P2).
        // **ADR-036 item 13 carries it now**: `detail` above is that sentence, and the envelope puts
        // it in `if_unexpected.detail`. The open question recorded here is closed.
        return { ok: false, reason: "aim_identity_changed", diff: [], ...(detail !== undefined && { detail }) };
      }
      // PR 側 codex 2026-09-09 — the three refusals below reached this catch as plain errors, so
      // all three arrived as `executor_failed`, whose first suggestion names the coordinate click
      // they refused. The executor closed the door; the envelope handed back the key. Same
      // `name`-not-`instanceof` matching as above, for the same module-identity reason.
      //
      // ADR-036 item 6 — the aim's rectangle covers the point and another window is drawn over it.
      // Its own reason because re-discovering does not help: the coordinates are correct and the
      // press would still land in the window on top.
      if (err instanceof Error && err.name === "AimOccludedError") {
        return { ok: false, reason: "aim_occluded", diff: [], ...(detail !== undefined && { detail }) };
      }
      // R3 tool exclusion, met at a COORDINATE rather than at a target. `window_excluded` is the
      // other half of the same registry and says the opposite thing about the caller's own window
      // — "the one you addressed is out of bounds" against "yours is fine, something else is over
      // the point" — so they do not share a reason. The advice for the first is false for this one
      // in two of its four lines (gate 2, Opus sandbox review, 2026-09-10).
      if (err instanceof Error && err.name === "AimBlockedByExcludedWindowError") {
        return { ok: false, reason: "aim_blocked_by_excluded_window", diff: [], ...(detail !== undefined && { detail }) };
      }
      // The point the press would land on is no longer inside the window this call named. Unlike
      // `aim_window_gone` the window is alive, so re-discovering returns a rect that works.
      if (err instanceof Error && err.name === "AimedPointOutsideWindowError") {
        return { ok: false, reason: "aim_point_outside_window", diff: [], ...(detail !== undefined && { detail }) };
      }
      // Every route to the named window failed and the blind coordinate press is refused —
      // ADR-036's whole subject arriving as the recovery is what this stops. Click and type end
      // here alike; they were giving opposite advice about the same aim.
      if (err instanceof Error && err.name === "AimedRouteFailedError") {
        return { ok: false, reason: "aim_route_failed", diff: [], ...(detail !== undefined && { detail }) };
      }
      // ADR-036 family 2 — the keyboard rung refused to post, on a ground its rule could state
      // (`engine/keyboard-target.ts`). Flattened, it would arrive as `executor_failed`, whose advice
      // is a foreground type: the characters would go to the control this refused.
      if (err instanceof Error && err.name === "KeyboardTargetUnsafeError") {
        return { ok: false, reason: "keyboard_target_unsafe", diff: [], ...(detail !== undefined && { detail }) };
      }
      // ADR-036 item 16 — UIA says the element is gone, and the press where it was is refused. The
      // fact the lease check reports when the entity is missing from the live view, found one step
      // later: the same reason, and the same recovery — re-discover.
      if (err instanceof Error && err.name === "TargetGoneError") {
        return { ok: false, reason: "entity_not_found", diff: [], ...(detail !== undefined && { detail }) };
      }
      // "You may not touch that window" — a security refusal, not a route that failed. Flattened,
      // it told the caller to press the rect the excluded window occupies, which is the one
      // outcome the exclusion exists to prevent (`tool-exclusion.ts` R3).
      if (err instanceof Error && err.name === "WindowExcludedError") {
        return { ok: false, reason: "window_excluded", diff: [], ...(detail !== undefined && { detail }) };
      }
      return { ok: false, reason: "executor_failed", diff: [], ...(detail !== undefined && { detail }) };
    }
    // Issue #327 item C: normalise bare-kind / rich-outcome return shapes so
    // downstream stays single-shape.
    const executor: ExecutorKind = typeof outcome === "string" ? outcome : outcome.kind;
    const downgrade: ExecutorOutcome["downgrade"] | undefined =
      typeof outcome === "string" ? undefined : outcome.downgrade;
    const landing: ExecutorOutcome["landing"] | undefined =
      typeof outcome === "string" ? undefined : outcome.landing;

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
      ...(landing ? { landing } : {}),
      ...(roiMaterial ? { roiMaterial } : {}),
    };
  }
}
