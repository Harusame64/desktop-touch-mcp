/**
 * desktop-register-tool-description.test.ts — ADR-020 SR-1 PR-SR1-3 (extended by SR-5 PR-SR5-1).
 *
 * Pins the `toolDescriptionAdvisory()` output to guarantee:
 *   1. bit-equal wire shape before and after the static-string → registry
 *      call switch-over (北極星 4, tool description text unchange);
 *   2. immutable / pure lookup invariant — two consecutive calls return the
 *      same string (北極星 1, registry SSOT);
 *   3. structural prefix/suffix pin — text begins with "Issue #296:" and ends
 *      with the SR-5-extended sentence about UIA setValue / RichEdit / Document.
 *
 * SR-5 PR-SR5-1 extension: `ADVISORY_TEXT` now appends a sentence describing
 * the newly-advertised `"keyboard"` executor (`["uia", "keyboard"]` on text
 * inputs). The EXPECTED_ADVISORY constant and the `endsWith` assertion are
 * updated to follow; the `startsWith` and `immutable` assertions remain
 * unchanged.
 */

import { describe, it, expect } from "vitest";
import { createDefaultCapabilityRegistry } from "../../src/capabilities/registry.js";

const EXPECTED_ADVISORY =
  "Issue #296: entities[].capabilities (when present) advises executor selection. " +
  "preferredExecutors[0] is the executor most likely to succeed; " +
  "if unsupportedExecutors contains 'uia', go straight to mouse_click instead of click_element " +
  "(saves a InvokePatternNotSupported round-trip on ListItem / TabItem / custom-drawn controls). " +
  "When preferredExecutors contains 'keyboard' (e.g. ['uia','keyboard'] on text inputs), " +
  "the 'keyboard' executor injects WM_CHAR directly to the focused control without focus-steal, " +
  "useful when UIA setValue fails on RichEdit/Document controls with unstable locators.";

describe("CapabilityRegistry.toolDescriptionAdvisory — PR-SR1-3 + SR-5 PR-SR5-1 snapshot pin", () => {
  const registry = createDefaultCapabilityRegistry();

  it("returns the bit-equal advisory text (snapshot pin)", () => {
    expect(JSON.stringify(registry.toolDescriptionAdvisory())).toMatchSnapshot();
  });

  it("is bit-equal to the EXPECTED_ADVISORY constant", () => {
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

  it("text ends with the SR-5 keyboard-executor sentence", () => {
    expect(
      registry.toolDescriptionAdvisory().endsWith(
        "useful when UIA setValue fails on RichEdit/Document controls with unstable locators.",
      ),
    ).toBe(true);
  });
});
