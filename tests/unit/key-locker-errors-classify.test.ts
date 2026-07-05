/**
 * key-locker-errors-classify.test.ts — ADR-014 R3 L4.
 *
 * Pins the manager-produced KeyLocker typed-error wiring in `_errors.ts`: `KeyLockerConsentRequired`
 * and `KeyLockerDisabled` route through `classify()` (bare + prose-suffixed message) to their own code
 * with a non-empty SUGGESTS payload. Their producers are the `KeyLocker*Error` constructors in
 * key-locker-manager.ts. The host/inject codes are wired when their producers land (the tool + the L3
 * inject loop) — the classify producer-pin invariant (issue-211) forbids a branch without a producer.
 * Mirrors the foreground-flash-keypress-classify precedent.
 */
import { describe, it, expect } from "vitest";
import { failWith, getSuggestsForCode } from "../../src/tools/_errors.js";

const MANAGER_CODES = ["KeyLockerConsentRequired", "KeyLockerDisabled"] as const;

describe("KeyLocker manager typed-error wiring (classify + SUGGESTS)", () => {
  for (const code of MANAGER_CODES) {
    it(`routes a "${code}" message to its code with a non-empty suggest`, () => {
      // The manager's typed errors prefix their message with the code: `new Error("<code>: …")`.
      const bare = JSON.parse(failWith(new Error(code), "key_locker").content[0]!.text);
      expect(bare.ok).toBe(false);
      expect(bare.code).toBe(code);
      expect(Array.isArray(bare.suggest)).toBe(true);
      expect(bare.suggest.length).toBeGreaterThan(0);

      // Prose-suffixed variant still routes (substring match), as the real messages carry a colon + prose.
      const prose = JSON.parse(failWith(new Error(`${code}: something to explain`), "key_locker").content[0]!.text);
      expect(prose.code).toBe(code);

      // getSuggestsForCode exposes the same dictionary payload.
      expect(getSuggestsForCode(code).length).toBeGreaterThan(0);
    });
  }

  it("KeyLockerDisabled is not swallowed by a generic branch (checked before them)", () => {
    // Its message would otherwise fall through to the generic ToolError tail with an empty suggest.
    const body = JSON.parse(failWith(new Error("KeyLockerDisabled: off via env"), "key_locker").content[0]!.text);
    expect(body.code).toBe("KeyLockerDisabled");
    expect(body.suggest.length).toBeGreaterThan(0);
  });
});
