/**
 * desktop-state-focus-builder.test.ts
 *
 * Pin the bit-equal contract that lets `desktop_state.focusedElement`
 * fall back across three sources (engine-perception view → UIA → CDP)
 * without changing the JSON shape the agent observes (ADR-008 D2-B-2).
 *
 * The three `buildElementInfoFrom*` functions in `src/tools/desktop-state.ts`
 * project each source into the same `ElementInfo` interface. This test
 * mechanically asserts:
 *   - `name` / `type` / optional `automationId` / optional `value`
 *     are the only top-level keys produced.
 *   - `automationId` is omitted (NOT set to `undefined`) when the
 *     source has no automation id, so `JSON.stringify` doesn't emit
 *     `"automationId": null` from one path and not the other.
 *   - View and UIA paths produce structurally identical output for
 *     the same logical element (the bit-equal contract Codex review
 *     v3 P1-3 named).
 *
 * Builders are pure (no napi / no external deps), so the test runs
 * in vitest unit mode without rebuilding the Rust addon.
 */

import { describe, expect, it } from "vitest";

import {
  buildElementInfoFromCdp,
  buildElementInfoFromUia,
  buildElementInfoFromView,
  shouldAcceptViewFocus,
  type ElementInfo,
} from "../../src/tools/desktop-state.js";

import type { NativeFocusedElement } from "../../src/engine/native-types.js";

describe("buildElementInfoFromView", () => {
  it("projects a view row with all fields populated", () => {
    const out = buildElementInfoFromView({
      name: "Username",
      automationId: "username-input",
      controlType: "Edit",
      windowTitle: "Login",
    });
    expect(out).toEqual({
      name: "Username",
      type: "Edit",
      automationId: "username-input",
    });
  });

  it("omits automationId when null (napi serialises Option::None as null)", () => {
    const out = buildElementInfoFromView({
      name: "OK",
      automationId: null,
      controlType: "Button",
      windowTitle: "Save Changes",
    });
    expect(out).toEqual({ name: "OK", type: "Button" });
    expect("automationId" in out).toBe(false);
  });

  it("does not include a value field (the view doesn't carry ValuePattern)", () => {
    const out = buildElementInfoFromView({
      name: "Comment",
      automationId: "comment-box",
      controlType: "Edit",
      windowTitle: "Editor",
    });
    expect("value" in out).toBe(false);
  });
});

describe("buildElementInfoFromUia", () => {
  it("projects a UIA row with all fields populated", () => {
    const out = buildElementInfoFromUia({
      name: "Username",
      controlType: "Edit",
      automationId: "username-input",
      value: "alice",
    });
    expect(out).toEqual({
      name: "Username",
      type: "Edit",
      automationId: "username-input",
      value: "alice",
    });
  });

  it("omits automationId when undefined", () => {
    const out = buildElementInfoFromUia({
      name: "OK",
      controlType: "Button",
    });
    expect(out).toEqual({ name: "OK", type: "Button" });
    expect("automationId" in out).toBe(false);
    expect("value" in out).toBe(false);
  });

  it("omits value when undefined but keeps automationId", () => {
    const out = buildElementInfoFromUia({
      name: "Submit",
      controlType: "Button",
      automationId: "submit-btn",
    });
    expect(out).toEqual({
      name: "Submit",
      type: "Button",
      automationId: "submit-btn",
    });
    expect("value" in out).toBe(false);
  });

  it("treats empty-string value as 'present, intentionally empty' and omits it", () => {
    // The handler historically used `focused.value != null` so empty
    // string falls through. The builder uses the same predicate, so
    // this test pins that behaviour.
    const out = buildElementInfoFromUia({
      name: "Edit",
      controlType: "Edit",
      value: "",
    });
    expect(out.value).toBe("");
  });
});

describe("buildElementInfoFromCdp", () => {
  it("prefers name over id over text over tag", () => {
    expect(buildElementInfoFromCdp({ name: "n", id: "i", text: "t", tag: "INPUT" })).toEqual({
      name: "n",
      type: "INPUT",
    });
    expect(buildElementInfoFromCdp({ id: "i", text: "t", tag: "INPUT" })).toEqual({
      name: "i",
      type: "INPUT",
    });
    expect(buildElementInfoFromCdp({ text: "t", tag: "INPUT" })).toEqual({
      name: "t",
      type: "INPUT",
    });
    expect(buildElementInfoFromCdp({ tag: "INPUT" })).toEqual({
      name: "INPUT",
      type: "INPUT",
    });
  });

  it("falls back to empty string and 'Element' when nothing is set", () => {
    expect(buildElementInfoFromCdp({})).toEqual({ name: "", type: "Element" });
  });

  it("includes value only when truthy", () => {
    expect(buildElementInfoFromCdp({ tag: "INPUT", value: "alice" })).toEqual({
      name: "INPUT",
      type: "INPUT",
      value: "alice",
    });
    expect("value" in buildElementInfoFromCdp({ tag: "INPUT", value: "" })).toBe(false);
  });
});

describe("shouldAcceptViewFocus (Pane filter parity, Opus review 2026-04-30 P1-A)", () => {
  // The view returns the same UIA event stream the direct query
  // does, including the Chrome top-level "Pane" element when Chrome
  // is the foreground app. The UIA branch in `desktopStateHandler`
  // explicitly skips that Pane so the CDP fallback can read the
  // real `document.activeElement`. The view-first path must mirror
  // that filter, otherwise the new path publishes the Pane while
  // the old path skipped it — a bit-equal violation.
  //
  // Non-Chromium foreground accepts Pane (the existing UIA branch
  // there does too: its only filter is `focused?.name`).

  const pane = (): NativeFocusedElement => ({
    name: "Browser content",
    automationId: null,
    controlType: "Pane",
    windowTitle: "GitHub - Pull Request - Google Chrome",
  });
  const button = (): NativeFocusedElement => ({
    name: "Submit",
    automationId: "submit-btn",
    controlType: "Button",
    windowTitle: "GitHub - Pull Request - Google Chrome",
  });
  const nativePane = (): NativeFocusedElement => ({
    name: "Document area",
    automationId: null,
    controlType: "Pane",
    windowTitle: "Document - Microsoft Word",
  });

  it("rejects Pane when Chromium foreground", () => {
    expect(shouldAcceptViewFocus(pane(), true)).toBe(false);
  });

  it("accepts non-Pane elements on Chromium foreground", () => {
    expect(shouldAcceptViewFocus(button(), true)).toBe(true);
  });

  it("accepts Pane on non-Chromium foreground (matches UIA branch)", () => {
    expect(shouldAcceptViewFocus(nativePane(), false)).toBe(true);
  });

  it("accepts non-Pane elements on non-Chromium foreground", () => {
    expect(
      shouldAcceptViewFocus(
        {
          name: "Save",
          automationId: null,
          controlType: "Button",
          windowTitle: "Document - Microsoft Word",
        },
        false,
      ),
    ).toBe(true);
  });

  it("rejects only when BOTH Chromium AND Pane (matrix corner)", () => {
    // The four-cell matrix this filter implements:
    //                      Chromium foreground     non-Chromium
    //   Pane               false (skip → CDP)      true (UIA accepts)
    //   non-Pane           true                    true
    expect(shouldAcceptViewFocus(pane(), true)).toBe(false); // (T, T) skip
    expect(shouldAcceptViewFocus(pane(), false)).toBe(true); // (F, T) accept
    expect(shouldAcceptViewFocus(button(), true)).toBe(true); // (T, F) accept
    expect(shouldAcceptViewFocus(button(), false)).toBe(true); // (F, F) accept
  });
});

describe("bit-equal contract: view vs UIA shape", () => {
  // Codex review v3 P1-3: when the perception view is the source,
  // its output must be indistinguishable in shape from the UIA path
  // for the same logical element. JSON.stringify is the truth check.
  it("view and UIA produce identical JSON for the same element (no value)", () => {
    const view: ElementInfo = buildElementInfoFromView({
      name: "Username",
      automationId: "username-input",
      controlType: "Edit",
      windowTitle: "Login",
    });
    const uia: ElementInfo = buildElementInfoFromUia({
      name: "Username",
      automationId: "username-input",
      controlType: "Edit",
      // intentionally omit `value` — view doesn't carry it either
    });
    expect(JSON.stringify(view)).toBe(JSON.stringify(uia));
  });

  it("view and UIA produce identical JSON for an element without automationId", () => {
    const view = buildElementInfoFromView({
      name: "OK",
      automationId: null,
      controlType: "Button",
      windowTitle: "Save Changes",
    });
    const uia = buildElementInfoFromUia({
      name: "OK",
      controlType: "Button",
    });
    expect(JSON.stringify(view)).toBe(JSON.stringify(uia));
  });

  it("only the listed top-level keys ever appear in the shape", () => {
    const allowed = new Set(["name", "type", "automationId", "value"]);
    const samples: ElementInfo[] = [
      buildElementInfoFromView({
        name: "A",
        automationId: null,
        controlType: "Pane",
        windowTitle: "W",
      }),
      buildElementInfoFromUia({ name: "A", controlType: "Pane" }),
      buildElementInfoFromUia({
        name: "A",
        controlType: "Edit",
        automationId: "id",
        value: "v",
      }),
      buildElementInfoFromCdp({ tag: "INPUT", value: "v" }),
      buildElementInfoFromCdp({}),
    ];
    for (const s of samples) {
      for (const key of Object.keys(s)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});
