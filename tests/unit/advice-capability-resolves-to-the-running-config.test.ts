/**
 * ADR-036 段階2 B1 — the capability resolver, before any advice line is converted.
 *
 * WHAT THIS PINS, and why each cell exists rather than being obvious:
 *
 *  1. A plain string passes through BYTE-IDENTICAL. This is the cell that lets B1
 *     ship with zero lines converted: the machinery goes in, every one of the 300
 *     existing advice lines keeps its exact bytes, and the suite stays green. A
 *     green suite then means "the mechanism broke nothing" — NOT "the advice is
 *     correct", which is B2's claim and needs the four-corner measurement.
 *
 *  2. The surface-swap switch resolves in BOTH directions. One direction green is
 *     not evidence: a wrong table can resolve correctly in one corner by accident
 *     (win2's point, which is the configuration-axis version of being satisfied by
 *     a one-sided control). So every capability is asserted at both v2 and
 *     kill-switch, and the assertions name the tool rather than "not the other one".
 *
 *  3. `credential_store` DROPS its line when the locker is off, and only then. The
 *     earlier draft (`requires: [toolName]`) dropped lines on the surface-swap
 *     switch too, which removes advice while the capability is still there — the
 *     reason it was rejected.
 *
 *  4. `{tool}` is replaced at EVERY occurrence. A single-replacement bug would be
 *     invisible in today's dictionary (no line names a tool twice) and would
 *     surface later as a half-resolved sentence.
 *
 * THE LOCKER AXIS CANNOT BE MADE FROM THE `env` ARGUMENT. `resolveV2Activation`
 * takes `env`, so three corners are reproducible in a unit test with no Windows
 * machine; `keyLockerDisabled()` reads `process.env` directly because it owns the
 * live kill switch. So the locker cells mutate `process.env` and restore it in a
 * `finally` — shared machine state, restored on the failing path too, because a
 * cell that leaves the switch flipped corrupts every test that runs after it.
 */

import { describe, it, expect } from "vitest";
import {
  providerFor,
  renderAdvice,
  TOOL_PLACEHOLDER,
  type AdviceLine,
} from "../../src/tools/_advice-capability.js";

const V2: Record<string, string | undefined> = {};
const KILL: Record<string, string | undefined> = { DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1" };

/** Flip the locker switch for one cell and put it back, including on failure. */
function withLocker(disabled: boolean, body: () => void): void {
  const key = "DESKTOP_TOUCH_DISABLE_KEY_LOCKER";
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  try {
    if (disabled) process.env[key] = "1";
    else delete process.env[key];
    body();
  } finally {
    if (had) process.env[key] = before;
    else delete process.env[key];
  }
}

describe("ADR-036 B1 — advice names a capability, the presenter resolves it", () => {
  it("passes a plain string through byte-identical, tool name and all", () => {
    // The 300 lines that exist today are plain strings, including the ones that
    // name a tool the caller may not have. B1 must not touch them: converting
    // them is B2, and doing both at once would make a green suite unreadable.
    const lines: AdviceLine[] = [
      "Run desktop_discover to see available titles",
      "Do NOT fall back to addressing this window by title. …the keyboard fallback types into whichever window is in front.",
      "",
    ];
    expect(renderAdvice(lines, V2)).toEqual(lines);
    expect(renderAdvice(lines, KILL)).toEqual(lines);
  });

  it("resolves the surface-swap capabilities in BOTH directions", () => {
    // Named positively on both sides: "not desktop_discover" would pass for a
    // resolver that returned null, which is the drop path and a different bug.
    expect(providerFor("enumerate_windows", V2)).toBe("desktop_discover");
    expect(providerFor("enumerate_windows", KILL)).toBe("get_windows");
    expect(providerFor("read_ui_tree", V2)).toBe("desktop_discover");
    expect(providerFor("read_ui_tree", KILL)).toBe("get_ui_elements");
    expect(providerFor("set_value", V2)).toBe("desktop_act");
    expect(providerFor("set_value", KILL)).toBe("set_element_value");
  });

  it("renders the same line differently per configuration, and drops nothing", () => {
    const line: AdviceLine = { cap: "enumerate_windows", text: `Use ${TOOL_PLACEHOLDER} to see available titles` };
    expect(renderAdvice([line], V2)).toEqual(["Use desktop_discover to see available titles"]);
    expect(renderAdvice([line], KILL)).toEqual(["Use get_windows to see available titles"]);
  });

  it("drops a credential_store line only when the locker is off", () => {
    const line: AdviceLine = { cap: "credential_store", text: `Re-call ${TOOL_PLACEHOLDER} to reuse the pane` };
    withLocker(false, () => {
      expect(providerFor("credential_store")).toBe("key_locker");
      expect(renderAdvice([line])).toEqual(["Re-call key_locker to reuse the pane"]);
    });
    withLocker(true, () => {
      expect(providerFor("credential_store")).toBeNull();
      expect(renderAdvice([line])).toEqual([]);
    });
  });

  it("does not drop a surface-swap line on either switch", () => {
    // The rejected draft's defect, pinned so it cannot come back: flipping the
    // fukuwarai switch must never make advice disappear, because the capability
    // is still provided — by a different name.
    const line: AdviceLine = { cap: "set_value", text: `Use ${TOOL_PLACEHOLDER}` };
    expect(renderAdvice([line], V2)).toHaveLength(1);
    expect(renderAdvice([line], KILL)).toHaveLength(1);
  });

  it("replaces every occurrence of the placeholder, not just the first", () => {
    const line: AdviceLine = {
      cap: "read_ui_tree",
      text: `${TOOL_PLACEHOLDER} reads the tree; call ${TOOL_PLACEHOLDER} again after it moves`,
    };
    expect(renderAdvice([line], KILL)).toEqual([
      "get_ui_elements reads the tree; call get_ui_elements again after it moves",
    ]);
  });

  it("keeps plain and capability lines in their original order", () => {
    // Dropping is by line, so the surviving lines must not be reordered — advice
    // is read top-down and the first line is the one a caller acts on.
    const lines: AdviceLine[] = [
      "first, plain",
      { cap: "enumerate_windows", text: `then ${TOOL_PLACEHOLDER}` },
      "last, plain",
    ];
    expect(renderAdvice(lines, KILL)).toEqual(["first, plain", "then get_windows", "last, plain"]);
  });
});
