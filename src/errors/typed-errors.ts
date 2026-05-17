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
 * `name === "ExecutorFailed"` matches `SUGGESTS.ExecutorFailed` key
 * (`_errors.ts:284`). `toFailureEnvelope` resolves the SUGGESTS entry at
 * runtime to produce a `most_likely_cause` + `try_next` envelope identical
 * to the one PR #329 emitted via the hand-wired
 * `buildExecutorFailedIfUnexpected()` helper in `desktop-register.ts:560-566`.
 */
export class ExecutorFailedError extends HandlerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutorFailed";
  }
}

// Future expansion (sub-plan §9 OQ-SR2-2): ModalBlockingError, LeaseExpiredError,
// etc., each with a `name` matching a SUGGESTS key. Hierarchy stays shallow —
// SUGGESTS lookup is the SSOT, not a type-system inheritance tree.
