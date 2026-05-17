/**
 * desktop-register-tool-description.test.ts — ADR-020 SR-1 PR-SR1-3.
 *
 * Pins the `toolDescriptionAdvisory()` output to guarantee:
 *   1. bit-equal wire shape before and after the static-string → registry
 *      call switch-over (北極星 4, tool description text unchange);
 *   2. immutable / pure lookup invariant — two consecutive calls return the
 *      same string (北極星 1, registry SSOT);
 *   3. structural prefix/suffix pin — text begins with "Issue #296:" and ends
 *      with "round-trip on ListItem / TabItem / custom-drawn controls)."
 *
 * The snapshot value must be bit-equal to the hand-written constant formerly
 * at `src/tools/desktop-register.ts:800` (and still present as `ADVISORY_TEXT`
 * in `src/capabilities/registry.ts` for carry-over clarity).
 */

import { describe, it, expect } from "vitest";
import { createDefaultCapabilityRegistry } from "../../src/capabilities/registry.js";

const EXPECTED_ADVISORY =
  "Issue #296: entities[].capabilities (when present) advises executor selection. " +
  "preferredExecutors[0] is the executor most likely to succeed; " +
  "if unsupportedExecutors contains 'uia', go straight to mouse_click instead of click_element " +
  "(saves a InvokePatternNotSupported round-trip on ListItem / TabItem / custom-drawn controls).";

describe("CapabilityRegistry.toolDescriptionAdvisory — PR-SR1-3 snapshot pin", () => {
  const registry = createDefaultCapabilityRegistry();

  it("returns the bit-equal advisory text (snapshot pin)", () => {
    expect(JSON.stringify(registry.toolDescriptionAdvisory())).toMatchSnapshot();
  });

  it("is bit-equal to the former hand-written static string", () => {
    expect(registry.toolDescriptionAdvisory()).toBe(EXPECTED_ADVISORY);
  });

  it("is immutable / pure: two consecutive calls return the same string", () => {
    const first = registry.toolDescriptionAdvisory();
    const second = registry.toolDescriptionAdvisory();
    expect(first).toBe(second);
  });

  it("text begins with 'Issue #296:'", () => {
    expect(registry.toolDescriptionAdvisory().startsWith("Issue #296:")).toBe(true);
  });

  it("text ends with 'round-trip on ListItem / TabItem / custom-drawn controls).'", () => {
    expect(
      registry.toolDescriptionAdvisory().endsWith(
        "round-trip on ListItem / TabItem / custom-drawn controls).",
      ),
    ).toBe(true);
  });
});
