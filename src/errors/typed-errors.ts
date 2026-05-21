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
 * `ToolFailure` shape — the `failWith` family (171 migratable callsites under
 * `src/tools/**`; 176 grep hits minus the 5 self-references in `_errors.ts`,
 * machine-counted by scripts/extract-failwith-shape-fixtures.mjs). PR-P2-2 made
 * `failWith` a thin wrapper over this model; PR-P2-3 migrates the callsites and
 * PR-P2-4 removes the wrapper (OQ-1(a) full removal).
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
