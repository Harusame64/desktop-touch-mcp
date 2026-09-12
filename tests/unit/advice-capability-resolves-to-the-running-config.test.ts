/**
 * ADR-036 段階2 B1 — the capability resolver, before any advice line is converted.
 *
 * WHAT EACH CELL EXISTS FOR, since none of them is obvious:
 *
 *  1. A line with no placeholder passes through BYTE-IDENTICAL. This is what lets
 *     the mechanism ship with zero lines converted: all 297 existing lines keep
 *     their exact bytes, so a green suite means the mechanism broke nothing — NOT
 *     that the advice is correct, which needs the four-corner measurement.
 *
 *  2. Every capability is asserted at BOTH corners, naming the tool rather than
 *     "not the other one". One corner green is not evidence: a wrong table can
 *     resolve correctly in one corner by accident — the configuration-axis version
 *     of being satisfied by a one-sided control. This table was cut at the
 *     implementation first and measurement broke two rows in OPPOSITE directions,
 *     which is exactly what a one-corner check would have passed.
 *
 *  3. Dropping happens on BOTH switches now. `disambiguate_window_by_handle` has
 *     no kill-switch provider (that surface returns titles and no handles at all),
 *     and `credential_store` none with the locker off. An earlier version of this
 *     file pinned "no line drops on the surface-swap switch", which measurement
 *     refuted — so the opposite is pinned here, and the two reasons are kept
 *     distinct in the comments even though the behaviour is one.
 *
 *  4. A line mixing a dependent name with names available everywhere keeps the
 *     shared names LITERAL. Nine lines look like that, and an anonymous `{tool}`
 *     could not say which name to resolve.
 *
 *  5. Two placeholders in one line both resolve — one real line names two
 *     dependent tools.
 *
 * THE LOCKER AXIS CANNOT BE BUILT FROM THE `env` ARGUMENT. `resolveV2Activation`
 * takes `env`, so three corners need no Windows machine; `keyLockerDisabled()`
 * reads `process.env` directly because it owns the live switch. So the locker
 * cells mutate `process.env` and restore it in a `finally` — shared machine state,
 * restored on the failing path too, because a cell that leaves the switch flipped
 * corrupts every test that runs after it.
 */

import { describe, it, expect } from "vitest";
import {
  providerFor,
  renderAdvice,
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
  it("passes a line with no placeholder through byte-identical, tool name and all", () => {
    const lines: AdviceLine[] = [
      "Run desktop_discover to see available titles",
      "Do NOT fall back to addressing this window by title. …the keyboard fallback types into whichever window is in front.",
      "",
    ];
    expect(renderAdvice(lines, V2)).toEqual(lines);
    expect(renderAdvice(lines, KILL)).toEqual(lines);
  });

  it("resolves each capability at BOTH corners, named positively on each side", () => {
    // `reidentify_element` is the row measurement re-cut: v2 identifies via
    // entities, the kill switch via the raw tree. Cut at the implementation it
    // looked kill-switch-only, because v2 returns no raw tree.
    expect(providerFor("reidentify_element", V2)).toBe("desktop_discover");
    expect(providerFor("reidentify_element", KILL)).toBe("get_ui_elements");
    expect(providerFor("list_window_titles", V2)).toBe("desktop_discover");
    expect(providerFor("list_window_titles", KILL)).toBe("get_windows");
    expect(providerFor("set_value", V2)).toBe("desktop_act");
    expect(providerFor("set_value", KILL)).toBe("set_element_value");
  });

  it("has no kill-switch provider for naming one window by handle", () => {
    // Measured: that surface returns titles and NO handles (0 of 10, no
    // `hwnd`/`handle` string anywhere), and takes no arguments, so there is not
    // even a flag to ask for one.
    expect(providerFor("disambiguate_window_by_handle", V2)).toBe("desktop_discover");
    expect(providerFor("disambiguate_window_by_handle", KILL)).toBeNull();
  });

  it("drops a line on the SURFACE-SWAP switch when that surface lacks the capability", () => {
    // The claim this replaces said no line drops on this switch. Measurement
    // refuted it, so the refutation is pinned rather than the comfortable version.
    const line: AdviceLine = "Pass the handle {tool:disambiguate_window_by_handle} returns to name one window exactly";
    expect(renderAdvice([line], V2)).toEqual([
      "Pass the handle desktop_discover returns to name one window exactly",
    ]);
    expect(renderAdvice([line], KILL)).toEqual([]);
  });

  it("drops a credential_store line only when the locker is off", () => {
    const line: AdviceLine = "Re-call {tool:credential_store} to reuse the pane";
    withLocker(false, () => {
      expect(providerFor("credential_store")).toBe("key_locker");
      expect(renderAdvice([line])).toEqual(["Re-call key_locker to reuse the pane"]);
    });
    withLocker(true, () => {
      expect(providerFor("credential_store")).toBeNull();
      expect(renderAdvice([line])).toEqual([]);
    });
  });

  it("keeps names available everywhere LITERAL while resolving the dependent one", () => {
    // Nine real lines have this shape. An anonymous `{tool}` could not say which
    // of the two names is the one to resolve.
    const line: AdviceLine =
      "Fall back to mouse_click({clickAt}) using the entity rect centre from {tool:reidentify_element}";
    expect(renderAdvice([line], V2)).toEqual([
      "Fall back to mouse_click({clickAt}) using the entity rect centre from desktop_discover",
    ]);
    expect(renderAdvice([line], KILL)).toEqual([
      "Fall back to mouse_click({clickAt}) using the entity rect centre from get_ui_elements",
    ]);
  });

  it("resolves two placeholders in one line — one real line names two dependent tools", () => {
    const line: AdviceLine =
      "Focus the field, then re-take it with {tool:reidentify_element} and write with {tool:set_value}";
    expect(renderAdvice([line], KILL)).toEqual([
      "Focus the field, then re-take it with get_ui_elements and write with set_element_value",
    ]);
  });

  it("drops the whole line when ANY placeholder in it has no provider", () => {
    const line: AdviceLine =
      "Re-take it with {tool:reidentify_element}, then name one window with {tool:disambiguate_window_by_handle}";
    expect(renderAdvice([line], V2)).toHaveLength(1);
    expect(renderAdvice([line], KILL)).toEqual([]);
  });

  it("leaves the product's own {tool: syntax alone, and renders an unknown capability as the word undefined", () => {
    // BOTH halves of the "DO NOT LOOSEN THAT PATTERN" comment, pinned — the comment
    // previously asserted the second half from reasoning and it was half wrong.
    //
    // `{tool:` is real syntax in this product: `run_macro({tool:"screenshot", …})`
    // appears in tool descriptions, examples and tests. It survives only because
    // the capture is `[a-z_]+` and every real use has a quote or a comma right
    // after the colon. If someone widens it, THIS is the cell that goes red.
    const macro: AdviceLine =
      'Batch it: run_macro({tool:"screenshot", args:{detail:"meta"}})';
    expect(renderAdvice([macro], V2)).toEqual([macro]);
    expect(renderAdvice([macro], KILL)).toEqual([macro]);

    // And an unknown capability is left VERBATIM, neither resolved nor dropped.
    // Measured first, then chosen: without the `KNOWN` check the line rendered
    // `"x undefined y"` — which still reads as a sentence, so a caller would try
    // to "use undefined". `{tool:nope}` reads as broken, which is the point. Not
    // an exception either: this renders on the failure road, so throwing would
    // cost the whole envelope.
    expect(renderAdvice(["x {tool:nope} y"], V2)).toEqual(["x {tool:nope} y"]);
    expect(renderAdvice(["x {tool:nope} y"], KILL)).toEqual(["x {tool:nope} y"]);
  });

  it("keeps surviving lines in their original order", () => {
    const lines: AdviceLine[] = [
      "first, plain",
      "then {tool:list_window_titles}",
      "last, plain",
    ];
    expect(renderAdvice(lines, KILL)).toEqual(["first, plain", "then get_windows", "last, plain"]);
  });
});
