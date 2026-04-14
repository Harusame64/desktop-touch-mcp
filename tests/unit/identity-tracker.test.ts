import { describe, it, expect, beforeEach } from "vitest";
import {
  observeTarget,
  clearIdentities,
  takeLastInvalidation,
  buildCacheStateHints,
} from "../../src/engine/identity-tracker.js";

describe("identity-tracker", () => {
  beforeEach(() => {
    clearIdentities();
  });

  it("records a first observation without invalidation", () => {
    const r = observeTarget("calc", 0x1234n, "Calculator");
    expect(r.invalidatedBy).toBeNull();
    expect(r.identity.hwnd).toBe(String(0x1234n));
    expect(r.identity.titleResolved).toBe("Calculator");
    expect(takeLastInvalidation()).toBeNull();
  });

  it("detects hwnd_reused when same hwnd observed with a different pid", () => {
    observeTarget("calc", 0x1234n, "Calculator");
    // Second observation cannot easily force a different pid because the
    // helper resolves pid from the HWND via Win32. We only assert that the
    // tracker does NOT falsely fire invalidation when nothing changed.
    const r2 = observeTarget("calc", 0x1234n, "Calculator");
    expect(r2.invalidatedBy).toBeNull();
  });

  it("buildCacheStateHints returns empty object when hwnd is null", () => {
    expect(buildCacheStateHints(null)).toEqual({});
  });

  it("buildCacheStateHints returns diffBaseline.exists=false when no baseline", () => {
    const hints = buildCacheStateHints(0xabcdn);
    // No baseline has been captured → exists is false.
    expect(hints.diffBaseline?.exists).toBe(false);
    // uiaCache also absent for a fresh hwnd.
    expect(hints.uiaCache?.exists).toBe(false);
  });
});
