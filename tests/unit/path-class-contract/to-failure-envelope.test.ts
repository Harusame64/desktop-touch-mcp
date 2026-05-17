/**
 * tests/unit/path-class-contract/to-failure-envelope.test.ts — ADR-020 SR-2 PR-SR2-1.
 *
 * Pins the `toFailureEnvelope` + `toResultErr` helpers (sub-plan §4.4):
 *   - happy path: `Result.ok(value)` → return `value` (Ok branch)
 *   - SUGGESTS hit: `Err.name in SUGGESTS` → envelope with matching `most_likely_cause` + `try_next`
 *   - SUGGESTS miss: unknown `Err.name` → envelope with fallback `try_next`
 *   - `optIn: true` → `EnvelopeMinimalShape<null>` (full shape)
 *   - `optIn: false` → `CompatRawFailureShape` (raw-compat projection)
 *   - `envelopeOptions.asOfWallclockMs` pass-through to `buildFailureEnvelope`
 *   - `toResultErr(unknown)`:
 *     - `HandlerError` → unwrap (no double-wrap)
 *     - `Error` → wrap in `HandlerError` with `cause`
 *     - other → wrap String() result in `HandlerError`
 *
 * @see src/tools/_envelope.ts toFailureEnvelope + toResultErr
 * @see src/errors/typed-errors.ts HandlerError + ExecutorFailedError
 */

import { describe, it, expect } from "vitest";
import {
  toFailureEnvelope,
  toResultErr,
} from "../../../src/tools/_envelope.js";
import { Ok, Err } from "../../../src/types/result.js";
import {
  HandlerError,
  ExecutorFailedError,
} from "../../../src/errors/typed-errors.js";

describe("toFailureEnvelope (ADR-020 SR-2 PR-SR2-1)", () => {
  describe("happy path", () => {
    it("Ok(value) → return value (no envelope wrapping)", () => {
      const result = toFailureEnvelope(Ok({ data: 42 }), { optIn: true });
      expect(result).toEqual({ data: 42 });
    });
  });

  describe("SUGGESTS hit (ExecutorFailedError)", () => {
    it("optIn=true → EnvelopeMinimalShape<null> with most_likely_cause='ExecutorFailed'", () => {
      const result = toFailureEnvelope(Err(new ExecutorFailedError("UIA setValue failed")), {
        optIn: true,
      });
      expect(result).toMatchObject({
        _version: "1.0",
        data: null,
        confidence: "stale",
        if_unexpected: {
          most_likely_cause: "ExecutorFailed",
          try_next: expect.arrayContaining([
            expect.objectContaining({ action: expect.any(String) }),
          ]),
        },
      });
    });

    it("optIn=false → CompatRawFailureShape with reason='executor_failed'", () => {
      const result = toFailureEnvelope(Err(new ExecutorFailedError("UIA setValue failed")), {
        optIn: false,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "executor_failed", // pascalToSnake("ExecutorFailed")
        diff: [],
        if_unexpected: {
          most_likely_cause: "ExecutorFailed",
        },
      });
    });
  });

  describe("SUGGESTS miss (custom HandlerError name)", () => {
    class UnknownError extends HandlerError {
      constructor(message: string) {
        super(message);
        this.name = "UnknownErrorThatIsNotInSuggests";
      }
    }

    it("falls back to generic 'Inspect the underlying error' try_next", () => {
      const result = toFailureEnvelope(Err(new UnknownError("oops")), { optIn: true });
      expect(result).toMatchObject({
        _version: "1.0",
        data: null,
        if_unexpected: {
          most_likely_cause: "UnknownErrorThatIsNotInSuggests",
        },
      });
      // Fallback try_next has at least 1 entry
      const envelope = result as { if_unexpected: { try_next: Array<{ action: string }> } };
      expect(envelope.if_unexpected.try_next.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("envelopeOptions pass-through", () => {
    it("asOfWallclockMs is honoured by buildFailureEnvelope", () => {
      const fixedTime = 1700000000000;
      const result = toFailureEnvelope(Err(new ExecutorFailedError("x")), {
        optIn: true,
        envelopeOptions: { asOfWallclockMs: fixedTime },
      });
      const envelope = result as { as_of: { wallclock_ms: number } };
      expect(envelope.as_of.wallclock_ms).toBe(fixedTime);
    });
  });
});

describe("toResultErr (ADR-020 SR-2 PR-SR2-1)", () => {
  it("HandlerError → unwrap (no double-wrap)", () => {
    const original = new ExecutorFailedError("UIA failed");
    const r = toResultErr(original);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(original); // same instance, no rewrap
    }
  });

  it("plain Error → wrap in HandlerError with cause", () => {
    const e = new Error("plain failure");
    const r = toResultErr(e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(HandlerError);
      expect(r.error.message).toBe("plain failure");
      expect(r.error.cause).toBe(e);
    }
  });

  it("non-Error value → wrap String() result in HandlerError", () => {
    const r = toResultErr("string-thrown-as-error");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(HandlerError);
      expect(r.error.message).toBe("string-thrown-as-error");
    }
  });
});
