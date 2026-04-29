/**
 * force-focus.test.ts — abstract documentation of the try/finally contract
 * that `forceSetForegroundWindow` exposes.
 *
 * Originally this file mocked `koffi` to drive a fake AttachThreadInput
 * pair, but ADR-007 P3 moved the actual implementation into Rust
 * (`src/win32/input.rs::win32_force_set_foreground_window`) where the
 * RAII `AttachGuard` provides the same guarantee. The contract test for
 * the real native binding lives in
 * `tests/unit/native-win32-panic-fuzz.test.ts` ("ADR-007 P3: process /
 * input panic safety"); these three cases are kept as a readable
 * specification of the try/finally invariant for future maintainers.
 */

import { describe, it, expect } from "vitest";

describe("forceSetForegroundWindow finally guarantee", () => {
  it("always detaches AttachThreadInput even when SetForegroundWindow throws", () => {
    // This test documents the try/finally contract from the implementation.
    // The real guard is: if (attached) try { SetForegroundWindow } finally { Detach }
    let detached = false;
    const attached = true;

    const setFg = () => { throw new Error("SetForegroundWindow threw"); };
    const detach = () => { detached = true; };

    let threw = false;
    try {
      try {
        setFg();
      } finally {
        if (attached) detach();
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(detached).toBe(true);
  });

  it("detaches when SetForegroundWindow succeeds normally", () => {
    let detached = false;
    const attached = true;

    const setFg = () => { /* success */ };
    const detach = () => { detached = true; };

    try {
      try {
        setFg();
      } finally {
        if (attached) detach();
      }
    } catch { /* noop */ }

    expect(detached).toBe(true);
  });

  it("does not call detach when attach was false", () => {
    let detached = false;
    const attached = false;

    const detach = () => { detached = true; };

    try {
      // even in finally, guard by `attached`
    } finally {
      if (attached) detach();
    }

    expect(detached).toBe(false);
  });
});
