/**
 * ADR-036 段階2 B1 — the capability resolver, before any advice line is converted.
 *
 * WHAT EACH CELL EXISTS FOR, since none of them is obvious:
 *
 *  1. A line with no placeholder passes through BYTE-IDENTICAL. That is what lets
 *     the mechanism ship with zero lines converted.
 *
 *     **The evidence for the 297 dictionary lines is a grep, not this cell.** This
 *     cell feeds three hand-written literals, and the module has no importer
 *     outside this file, so a green suite here cannot say anything about the
 *     corpus. What supports the claim is that the narrow pattern matches **0**
 *     times anywhere in `src` and `tests` outside the module and this file
 *     (measured 2026-09-12), so no existing advice line can be altered by it. Two
 *     different claims, two different instruments — the suite's green is the
 *     weaker one (gate 2, finding 11).
 *
 *     297 is the count of advice strings in the `SUGGESTS` dictionary alone, and it
 *     excludes the four named builders — including `paneIdMissSuggest`, which is
 *     the motivating case in the module header. An earlier count said 300; that was
 *     a quote-pairing counter meeting quotes inside comments, and the dictionary was
 *     re-counted per code on the Windows machine (94 of 94 agreeing).
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
 * ALL FOUR CORNERS ARE BUILT FROM THE `env` ARGUMENT, and that is a fix, not a
 * convenience. `keyLockerDisabled()` used to read the ambient process, so
 * `credential_store` was the one capability that ignored the configuration it was
 * handed — it answered `key_locker` for an env that disables the locker, and
 * dropped the line for an env that enables it (PR-side codex P2 on `64e69a2`). The
 * shared predicate now takes an optional `env`, defaulted, so production still
 * reads the live switch.
 *
 * ONE cell still mutates `process.env`: the one that pins that default. It restores
 * in a `finally`, including on the failing path, because a cell that leaves the
 * switch flipped corrupts every test that runs after it — and that cell exists
 * precisely because "the tests pass with an env argument" would not have caught the
 * production callers reading something else.
 */

import { describe, it, expect } from "vitest";
import {
  providerFor,
  renderAdvice,
  PLACEHOLDER,
  CAPABILITIES,
  type AdviceLine,
} from "../../src/tools/_advice-capability.js";

/** The four corners of the two kill switches, as `env` maps. */
const V2: Record<string, string | undefined> = {};
const KILL: Record<string, string | undefined> = { DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1" };
const V2_NO_LOCKER: Record<string, string | undefined> = { DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1" };
const KILL_NO_LOCKER: Record<string, string | undefined> = {
  DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1",
  DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1",
};

/**
 * Flip the locker switch for one cell and put it back, including on failure.
 *
 * `body` is deliberately synchronous: a `void`-returning callback that was later
 * made `async` would have its promise ignored, the `finally` would restore the
 * switch before the assertions ran, and the cell would pass while measuring the
 * wrong configuration (gate 2, finding 12).
 */
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

  it("drops a credential_store line at both locker-off corners, and keeps it at both locker-on corners", () => {
    // The locker axis crosses the surface axis: the capability is gone in the two
    // corners where the switch is set, whichever surface is published. Asserted on
    // all four rather than on one, because this is the capability whose resolution
    // was reading the wrong configuration entirely.
    const line: AdviceLine = "Re-call {tool:credential_store} to reuse the pane";
    const kept = ["Re-call key_locker to reuse the pane"];

    expect(providerFor("credential_store", V2)).toBe("key_locker");
    expect(providerFor("credential_store", KILL)).toBe("key_locker");
    expect(providerFor("credential_store", V2_NO_LOCKER)).toBeNull();
    expect(providerFor("credential_store", KILL_NO_LOCKER)).toBeNull();

    expect(renderAdvice([line], V2)).toEqual(kept);
    expect(renderAdvice([line], KILL)).toEqual(kept);
    expect(renderAdvice([line], V2_NO_LOCKER)).toEqual([]);
    expect(renderAdvice([line], KILL_NO_LOCKER)).toEqual([]);
  });

  it("still reads the LIVE switch when no env is supplied, which is what production does", () => {
    // The cell that makes the default argument load-bearing. Without it, every
    // assertion above could pass while production read something else entirely —
    // which is the defect this shape replaced, one level up.
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

  it("leaves the product's own {tool: syntax alone, and leaves an unknown capability verbatim", () => {
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

  it("pins the pattern TEXT, because behaviour can no longer catch a widened one", () => {
    // GATE 2, FINDING 2 — and it was a critical one. The cell above used to be
    // described as "the cell that goes red if someone widens the capture". It does
    // not, and the verbatim fallback in this very commit is why: widen the capture
    // to `[^}]+` and `{tool:"screenshot", args:{…}` is captured, is not a
    // capability, and is returned VERBATIM — byte-identical output, green cell.
    //
    // Generalised, and worth more than the specific case: after the verbatim
    // fallback, **every mutation that makes this pattern match MORE is invisible
    // behaviourally**; only mutations that make it match LESS can be observed. So
    // the pattern's text is asserted directly. A safety net that the change it
    // shipped with had quietly removed.
    expect(PLACEHOLDER.source).toBe("\\{tool:([a-z_]+)\\}");
    expect(PLACEHOLDER.flags).toBe("g");
  });

  it("keeps every capability name expressible by that pattern", () => {
    // GATE 2, FINDING 8. The union and the pattern's character class are unlinked:
    // `read_uia2` or `readTree` would compile, be KNOWN, and have a switch arm,
    // while `{tool:read_uia2}` could never match `[a-z_]+` — so it would be left
    // verbatim and be indistinguishable from a typo, with no gate firing.
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const cap of CAPABILITIES) {
      expect(cap, `capability ${cap} cannot appear in a placeholder`).toMatch(/^[a-z_]+$/);
      // And each one resolves to something at one corner or the other; a capability
      // with no provider at any corner is a promise that cannot be declared.
      const anywhere = providerFor(cap, V2) ?? providerFor(cap, KILL);
      expect(anywhere, `capability ${cap} has no provider at either corner`).not.toBeNull();
    }
  });

  it("drops a line that mixes an unknown capability with one that has no provider", () => {
    // GATE 2, FINDING 9 — precedence was reachable but unpinned: drop beats
    // verbatim, verbatim beats resolve. The consequence worth pinning is the second
    // line: a typo alone SHIPS, placeholder and all, which is the intended visible
    // breakage rather than an accident.
    const mixed: AdviceLine = "{tool:nope} then {tool:disambiguate_window_by_handle}";
    expect(renderAdvice([mixed], KILL)).toEqual([]);
    expect(renderAdvice([mixed], V2)).toEqual(["{tool:nope} then desktop_discover"]);
    expect(renderAdvice(["only {tool:nope}"], V2)).toEqual(["only {tool:nope}"]);
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
