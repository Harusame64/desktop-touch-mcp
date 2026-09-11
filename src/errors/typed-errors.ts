/**
 * Typed error hierarchy for handler failure paths (ADR-020 SR-2 PR-SR2-1).
 *
 * Each typed error class's `name` field matches a `SUGGESTS` dict key in
 * `src/tools/_errors.ts`. `toFailureEnvelope` (in `_envelope.ts`) uses the
 * class's `name` to look up `most_likely_cause` + `try_next` in SUGGESTS,
 * keeping handler-side typed errors and LLM-facing recovery hints bit-equal
 * sync (sub-plan §2 北極星 7).
 *
 * `name` field is set in the constructor body (not as class field) to avoid
 * TypeScript class field initialisation order issues with base/derived class
 * overrides under ES2022 class field semantics (sub-plan §4.3 + Round 2 P2-3).
 */

export class HandlerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HandlerError";
  }
}

/**
 * Typed error for the `executor_failed` envelope path (PR #329 carry-over,
 * ADR-020 §11 L6 closure target).
 *
 * `name === "ExecutorFailed"` matches the `SUGGESTS.ExecutorFailed` key, so
 * `toFailureEnvelope` resolves the entry at runtime to produce the
 * `most_likely_cause` + `try_next` envelope. Used by `desktopActRawHandler`
 * via `toFailureEnvelope(Err(new ExecutorFailedError(...)))` (ADR-021 P1-3),
 * replacing the hand-wired helper PR #329 originally emitted.
 */
export class ExecutorFailedError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutorFailed";
  }
}

/**
 * ADR-029 — a mouse coordinate the current input backend cannot reach.
 *
 * Since Phase 2a the native path reaches every monitor, so this now means the
 * point is not on any connected monitor at all — normally coordinates that went
 * stale because the window moved or closed after they were read. It keeps its
 * Phase 1 meaning ("outside the primary monitor") only on an installation whose
 * native input module is missing, where movement falls back to nut.js and that
 * library clamps anything else into the primary monitor.
 *
 * A point that IS on a monitor but could not be reached — something is holding
 * the cursor, the session is not interactive — raises
 * {@link CursorPlacementBlockedError} instead: same failure to click, entirely
 * different recovery.
 *
 * `name === "CoordinateOutsideReachableBounds"` matches the `SUGGESTS` key, and
 * `GuardedTouchLoop` recognises this name to report
 * `reason:"coordinate_outside_reachable_bounds"` instead of the generic
 * `executor_failed` — whose recovery advice ("fall back to mouse_click") would
 * send the caller straight back into the same guard.
 *
 * The name is deliberately boundary-agnostic: the reachable region widens to the
 * whole virtual screen once the native path lands, and renaming a published
 * error code would be a breaking change.
 */
export class CoordinateOutsideReachableBoundsError extends HandlerError {
  /**
   * ADR-036 item 13 — this sentence is fit to publish, and says so (`CallerFacingRefusal` in
   * `aim.ts`; duck-typed here for the same reason `WindowExcludedError` does it).
   *
   * The published advice for this reason points the caller at `if_unexpected.detail`, and without
   * this field the opt-in extraction found nothing to publish, every time — an envelope naming a
   * field that never appears, which is the exact defect item 13 exists to close, reintroduced by
   * the line that describes the fix (PR 側 codex on #618, P2).
   *
   * Safe to publish because every producer writes it: `describeUnreachable` states the point, the
   * reachable region and which of the three cases applies. Nothing here is borrowed from a shell,
   * a caller's text, or another process.
   */
  readonly callerDetail: string;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoordinateOutsideReachableBounds";
    this.callerDetail = message;
  }
}

/**
 * ADR-029 Phase 2a — the coordinate was fine, but the pointer could not be put
 * there.
 *
 * The native path reads the cursor position back after moving it, which makes a
 * class of failure visible that used to end as a click in the wrong place:
 * another application confining the cursor to its own window (`ClipCursor`, the
 * usual full-screen game), a session that is not interactive right now (a
 * disconnected or locked remote-desktop session), another program repeatedly
 * repositioning the pointer, or a monitor added or removed mid-move.
 *
 * Kept separate from {@link CoordinateOutsideReachableBoundsError} because
 * saying "outside the reachable bounds" about a point that is plainly on a
 * monitor would be untrue, and because none of that error's recovery advice
 * (re-discover, move the window to the primary monitor) does anything here.
 *
 * Note what this is NOT: when an elevated window is in the foreground, UIPI
 * discards the click but not `SetCursorPos`, so the move succeeds and verifies
 * — that failure stays silent and is out of scope for this phase.
 */
export class CursorPlacementBlockedError extends HandlerError {
  /**
   * ADR-036 item 13 — see {@link CoordinateOutsideReachableBoundsError}. The distinction this
   * carries is the one the advice promises and could not deliver: the cursor read back at a
   * DIFFERENT point (something is holding it) against the monitor layout being unreadable (the
   * point was never checked at all). Same reason code, opposite recoveries.
   *
   * Written by `cursor.ts` from coordinates and a layout read; nothing foreign travels in it.
   */
  readonly callerDetail: string;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CursorPlacementBlocked";
    this.callerDetail = message;
  }
}

/**
 * ADR-036 — the window the action was aimed at is gone.
 *
 * Its own envelope because its recovery is the opposite of `executor_failed`'s. That one says
 * "fall back to mouse_click", and the only coordinates a caller holds are the entity's rect —
 * which is where the window used to be, so the click lands on whatever moved in behind it. The
 * recovery here is to look again: the session's target no longer exists, and nothing addressed
 * to it can succeed until `desktop_discover` says what is there now.
 *
 * Distinct from an excluded window too. Both refuse, but "you may not touch that" and "there is
 * nothing there" send the caller to different places, and they were arriving identical.
 */
export class AimWindowGoneError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimWindowGone";
  }
}

/**
 * ADR-036 — the aimed handle now belongs to a different process.
 *
 * Its own envelope because its recovery is unlike every neighbour's. `AimWindowGone` says there is
 * nothing there; this says there is something there and it is a stranger, which is worse: the
 * action would have landed. Windows recycles handles, so a window that closed between the read and
 * the write can leave its number to anything — including to the next window of the SAME program,
 * which is why process identity alone was not enough to notice it.
 *
 * The specification calls this **identity invalidation, not an ordinary update** — every belief
 * keyed to that handle is void, not stale, and the lease cannot be repaired by waiting.
 */
export class AimIdentityChangedError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimIdentityChanged";
  }
}

/**
 * ADR-036 — another window is drawn over the point the press would land on.
 *
 * Separate from {@link AimPointOutsideWindowError} because the recoveries are opposite. There the
 * remembered coordinates are stale and re-discovering produces working ones; here they are correct,
 * and re-discovering returns the same point with the same window on top of it. What has to change
 * is the screen, not the lease.
 */
export class AimOccludedError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimOccluded";
  }
}

/**
 * ADR-036 — the coordinates this act would have pressed can no longer be followed to the window
 * the call named.
 *
 * Not only "the point is outside it", though the name says that and the name is kept because the
 * recovery is one recovery: the window may be MINIMISED (parked off the desktop), RESIZED (the
 * contents may have reflowed, so it is refused even where the point still falls inside), or it may
 * have MOVED WHILE IT WAS BEING READ (that snapshot's coordinates were measured against more than
 * one position). A window that moved WITHOUT resizing is followed automatically and never arrives
 * here — when the coordinates were measured in the same read that measured the window. A move
 * large enough to put the point off the window is answered earlier still, by the viewport gate as
 * `entity_outside_viewport`.
 *
 * The window is alive; its coordinates are stale. That is why it is not {@link AimWindowGoneError}:
 * there, nothing addressed to the old handle can succeed and the caller has to start from a new
 * window; here, one `desktop_discover` returns a rect that works on the same window.
 *
 * Its own envelope because `executor_failed`'s first suggestion is "fall back to mouse_click using
 * the entity rect center" — the exact press this refusal rejected, named verbatim (PR 側 codex,
 * 2026-09-09). Thrown as `AimedPointOutsideWindowError` in `engine/aim.ts`; the loop turns that
 * into `reason:"aim_point_outside_window"` and this class renders it.
 */
export class AimPointOutsideWindowError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimPointOutsideWindow";
  }
}

/**
 * ADR-036 — every route to the window the call named has failed, and the blind fallback is refused.
 *
 * An unpinned call finishes a failed UIA click on the entity's rect, and that is correct for it: a
 * title never promised which window. A call that named its window by handle gets a refusal
 * instead, because a coordinate is aimed at nothing and whatever occupies the point takes the
 * press. Covers the click path and the type / setValue ladder, which end the same way and were
 * giving opposite advice about the same aim.
 *
 * Separate from {@link AimPointOutsideWindowError}: there the aim went stale, here the aim is
 * current and the attempt on it failed (element not found, no InvokePattern, a stale tree, the
 * background write rung refused). The recoveries differ — re-discover in both cases, but this one
 * also has element-level routes that a stale rect does not.
 */
export class AimRouteFailedError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimRouteFailed";
  }
}

/**
 * ADR-036 item 16 — the element this act was for is not there: missing from the live view, or
 * answered "not found" by UIA on the title-only road, where the press at its remembered point is
 * refused. Before this it went out as the raw result, with no advice.
 *
 * `name` is `"EntityNotFound"` so the raw shape's `reason`, derived by `pascalToSnake`, is the
 * `entity_not_found` that `desktop_act`'s catalogue documents, and so the SUGGESTS key matches.
 */
export class EntityNotFoundRefusalError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EntityNotFound";
  }
}

/**
 * ADR-036 item 6 — the point a coordinate press would land on is covered by a window this server
 * may not act through (R3 tool exclusion, met at a coordinate rather than at a target).
 *
 * Separate from {@link WindowExcludedRefusalError} because the two say opposite things about the
 * window the caller named: that one means "the window you addressed is out of bounds", this one
 * means "yours is fine, something else is over the point". Sharing a code shared the advice, and
 * two of its four lines were then false — the caller was told their own window was excluded, and
 * the only actionable line sent them to act on a different window (gate 2, 2026-09-10).
 *
 * `name` is `"AimBlockedByExcludedWindow"`, matching the SUGGESTS key — and carrying the whole
 * reason, because the raw (non-opt-in) shape derives its public `reason` from this name by
 * `pascalToSnake` while `desktop_act`'s documented catalogue spells it out. A name one word
 * short published two different reasons for one refusal (PR 側 codex on #618, P2).
 */
export class AimBlockedByExcludedRefusalError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimBlockedByExcludedWindow";
  }
}

/**
 * R3 tool exclusion — the window may not be touched by this server at all.
 *
 * The engine-side throw is `WindowExcludedError` (`engine/tool-exclusion.ts`), whose module header
 * has claimed since it was written that "L4 wires it into `_errors.ts`". It never was: the refusal
 * reached `GuardedTouchLoop` untyped and left as `executor_failed`, whose first suggestion is a
 * coordinate press at the entity's rect — the rect the excluded window occupies. A comment is a
 * claim, not a check (PR 側 codex, 2026-09-09).
 *
 * Named `…RefusalError` only to keep one class per module identity: the engine class already owns
 * the name `WindowExcludedError`, and these two are deliberately different objects — one is thrown
 * by the engine, one renders the envelope. `name` is `"WindowExcluded"`, matching the SUGGESTS key.
 */
export class WindowExcludedRefusalError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WindowExcluded";
  }
}

/**
 * ADR-031 — a screen rectangle the current capture backend cannot read.
 *
 * Which rectangle counts as capturable is decided by the backend the process
 * chose at startup, so the three cases this error covers have opposite
 * recoveries and the message says which one applies. On the native path the
 * whole virtual desktop is capturable, so a rectangle touching no monitor at
 * all means the coordinates went stale — the window moved or closed after they
 * were read. A rectangle that DOES overlap a monitor but runs past the
 * capturable area is the opposite: those coordinates are current, and
 * re-discovering returns the same rectangle, so the region itself has to shrink
 * (or the window be captured directly). On the nut.js path capture is limited
 * to the primary monitor, and the message names what put the process there: a
 * build without the native capture module, or the
 * `DESKTOP_TOUCH_CAPTURE_BACKEND` override. Those two do NOT share a recovery.
 * The override leaves the native module installed, so per-window capture still
 * reads through PrintWindow on any monitor; a missing module takes that route
 * down as well, so the message offers moving the window or reinstalling
 * instead of sending the caller to a second guaranteed failure.
 *
 * Distinct from {@link CaptureBackendFailedError}: nothing was attempted here.
 * The rectangle was refused before any pixels were read, so retrying it
 * unchanged fails identically.
 */
export class RegionOutsideCapturableBoundsError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegionOutsideCapturableBounds";
  }
}

/**
 * ADR-031 — the capture backend was called and did not produce pixels.
 *
 * Covers the native GDI path failing on a rectangle that passed the bounds
 * check (a secure desktop, a disconnected remote session, a GDI resource
 * failure), the same failure through nut.js / libnut, and the full-screen case
 * where the primary monitor's rectangle could not be resolved at all — the one
 * place ADR-031 refuses instead of failing open, because there is no rectangle
 * to pass through.
 *
 * A per-call fall back to the other backend is deliberately NOT attempted:
 * both read the desktop through the same GDI surface, so the conditions that
 * break one break the other, and switching mid-session would change capture
 * dimensions under a non-100% DPI layout (ADR-031 §2(b)).
 */
export class CaptureBackendFailedError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaptureBackendFailed";
  }
}

/**
 * Generic typed error whose `name` is set from a code passed at construction
 * time. Used by wrapper-internal callsites (`makeQueryWrapper`'s N upper
 * bound checks, `makeCommitWrapper`'s lease validation / handler-throw
 * fallback) so the existing `buildFailureEnvelope(code, ...)` direct calls
 * can be migrated to `toFailureEnvelope(Err(new CodedHandlerError(code)), ...)`
 * without inventing a dedicated subclass per code (ADR-020 SR-2 PR-SR2-3).
 *
 * `SUGGESTS` dict lookup (`getSuggestsForCode(code)`) inside `toFailureEnvelope`
 * resolves `try_next` for the named code identically to the pre-migration
 * direct call shape — envelope JSON.stringify-level bit-equal.
 *
 * When `message` is omitted (the common 4 memory-upper-bound callsite shape),
 * `Error.message` falls back to `code` for stack-trace / cause-chain
 * observation. The envelope output is unaffected because `Error.message` is
 * not emitted in `EnvelopeMinimalShape<null>`. Round 4 P3-2 doc.
 */
export class CodedHandlerError extends HandlerError {
  constructor(code: string, message?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = code;
  }
}

/**
 * Optional payload carried by {@link ToolFailureError} — the fields the flat
 * `ToolFailure` presenter (`toToolFailure` in `src/tools/_errors.ts`) renders.
 *
 * ADR-021 Phase 2 PR-P2-0 (B′: error-model-as-SSOT + presenter family). The
 * typed error is the single source of truth for a handler failure (≒ RFC 9457
 * problem-detail object / Effect `Data.TaggedError` / a Rust error enum);
 * rendering it into the flat `{ok:false, code, error, ...}` wire shape is a
 * separate concern done by a narrow presenter, NOT by hand-built object
 * literals (Phase 4 ESLint `no-tool-failure-shape-direct-construct` enforces
 * this). This is why the envelope family converter (`toFailureEnvelope`) stays
 * untouched: the two shapes are different render targets of one error model.
 *
 * Field → rendered output (`toToolFailure`, bit-equal with today's `failWith`):
 *   - `toolName` + `displayMessage` → `error: "${toolName} failed: ${displayMessage}"`
 *   - `suggest`    → `suggest` (omitted when empty — matches `failWith`)
 *   - `context`    → nested `context` (the non-hoisted half of `failWith`'s context arg)
 *   - `rootExtras` → spread onto the failure root (the ROOT_HOISTED_KEYS half:
 *     `_perceptionForPost` / `_richForPost` / `hints`, read by `_post.ts`)
 *
 * The plan §3.3.2 listed the suggest field as `suggestOverride`; under B′ the
 * model carries an already-resolved `suggest` array — the `errorFromMessage`
 * factory fills it from `classify(message)`, and an explicit caller may override
 * by constructing with a different `suggest`. Either way the presenter only
 * renders; it never re-classifies.
 */
export interface ToolFailurePayload {
  toolName?: string;
  displayMessage?: string;
  suggest?: string[];
  context?: Record<string, unknown>;
  rootExtras?: Record<string, unknown>;
}

/**
 * Canonical typed model for a handler failure that renders to the flat
 * `ToolFailure` shape. PR-P2-2 made `failWith` a thin wrapper over this model
 * (`failWith = fail(toToolFailure(errorFromMessage(...)))`), so `failWith` is the
 * canonical single window for flat failures and this class is its SSOT error
 * value. ADR-021 OQ-1 RE-DECISION (Round 6): `failWith` is KEPT (not deleted) —
 * once the wrapper unified the path, removing it would only churn the ~171
 * already-sanctioned callsites. PR-P2-3 instead routes the remaining hand-built
 * `{ ok:false, ... }` literals through `failWith`, and Phase 4 ESLint bans new
 * ones (`no-tool-failure-shape-direct-construct`).
 *
 * `name === code` (same convention as {@link CodedHandlerError}) so the SUGGESTS
 * dict / envelope family can resolve it too if ever rendered that way — both
 * failure families consume `HandlerError` descendants, keeping a single typed
 * boundary. Constructed via the `errorFromMessage(message, toolName, context)`
 * factory (`src/tools/_errors.ts`, OQ-7(c)), which centralises `classify`
 * so this class stays thin (no message dispatch in the constructor).
 *
 * Extra payload fields are assigned in the constructor BODY (after `super`),
 * the same defensive ordering the module header documents for `name` under
 * ES2022 class-field semantics.
 */
export class ToolFailureError extends HandlerError {
  readonly toolName?: string;
  readonly displayMessage?: string;
  readonly suggest?: string[];
  readonly context?: Record<string, unknown>;
  readonly rootExtras?: Record<string, unknown>;

  constructor(code: string, payload?: ToolFailurePayload, options?: ErrorOptions) {
    // `??` (not `||`) is load-bearing: an empty `displayMessage` ("") must be
    // preserved, not coalesced to `code`, so a thrown empty message stays
    // bit-equal with `failWith`. The presenter's `err.displayMessage ?? code`
    // relies on the same `??` semantics.
    super(payload?.displayMessage ?? code, options);
    this.name = code;
    this.toolName = payload?.toolName;
    this.displayMessage = payload?.displayMessage;
    // Clone `suggest`: `errorFromMessage` forwards the array straight from the
    // shared `SUGGESTS` dictionary (`classify`'s return). The model is a
    // long-lived value (carried through `Result.err`), so holding the shared
    // reference would let any downstream mutation (sort/push while enriching or
    // logging) corrupt global suggestion state across requests. `failWith` was
    // safe only because it spread the reference into a throwaway object and
    // `JSON.stringify`d it without ever retaining a live reference; the typed
    // model retains one, so it owns an independent copy (Round 1 Codex P2).
    // `context` /
    // `rootExtras` are caller-owned fresh containers (same as failWith) — no
    // shared global state, so no clone needed.
    this.suggest = payload?.suggest ? [...payload.suggest] : undefined;
    this.context = payload?.context;
    this.rootExtras = payload?.rootExtras;
  }
}

// Future expansion (sub-plan §9 OQ-SR2-2): ModalBlockingError, LeaseExpiredError,
// etc., each with a `name` matching a SUGGESTS key. Hierarchy stays shallow —
// SUGGESTS lookup is the SSOT, not a type-system inheritance tree.
