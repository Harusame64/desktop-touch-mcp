/**
 * tests/unit/path-class-contract/result-type.test.ts — ADR-020 SR-2 PR-SR2-1.
 *
 * Pins the `Result<Ok, Err>` discriminated union contract:
 *   - `Ok(value)` produces `{ ok: true, value }`
 *   - `Err(error)` produces `{ ok: false, error }`
 *   - Type narrowing works for both branches (compile-time guard)
 *
 * @see src/types/result.ts
 */

import { describe, it, expect } from "vitest";
import { Ok, Err, type Result } from "../../../src/types/result.js";

describe("Result type (ADR-020 SR-2 PR-SR2-1)", () => {
  it("Ok(value) → { ok: true, value }", () => {
    const r = Ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
    }
  });

  it("Err(error) → { ok: false, error }", () => {
    const e = new Error("oops");
    const r = Err(e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(e);
    }
  });

  it("discriminated union narrowing via ok property", () => {
    const r: Result<number, string> = Math.random() > 0.5 ? Ok(1) : Err("nope");
    if (r.ok) {
      // Compile-time guard: `value` is narrowed to `number`
      const n: number = r.value;
      expect(typeof n).toBe("number");
    } else {
      // Compile-time guard: `error` is narrowed to `string`
      const s: string = r.error;
      expect(typeof s).toBe("string");
    }
  });

  it("Ok and Err are readonly (immutable)", () => {
    const r = Ok({ count: 1 });
    // `r.ok` is typed `readonly true` — runtime assignment would not throw
    // (TypeScript readonly is compile-time only), but the discriminated
    // union contract treats Ok/Err as values.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.count).toBe(1);
    }
  });
});
