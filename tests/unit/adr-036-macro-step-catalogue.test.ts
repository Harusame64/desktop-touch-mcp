/**
 * adr-036-macro-step-catalogue.test.ts — `run_macro` offers what THIS server can dispatch.
 *
 * The catalogue in `steps[].tool` was the v1.0.0 registry, which is not a surface any running
 * server has, and it lied in both directions at once: with v2 on it offered the three V1 fallbacks
 * the handlers refuse, and with the kill switch on it offered the two v2 tools they also refuse
 * (measured at the four corners, win2 2026-09-13).
 *
 * The refusals were never wrong; the advertisement was. A caller who reads a catalogue writes the
 * whole macro before running any of it, and `stop_on_error` defaults to true — so the first
 * refused step ends the run with everything before it already done.
 */
import { describe, it, expect } from "vitest";
import { dispatchableStepNames } from "../../src/tools/macro.js";

const V2_ON = {} as Record<string, string | undefined>;
const KILL_SWITCH = { DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1" };

describe("ADR-036: the macro step catalogue names only what this configuration dispatches", () => {
  it("drops the V1 fallbacks while v2 is on, and keeps the v2 tools", () => {
    const names = dispatchableStepNames(V2_ON);
    expect(names).not.toContain("get_windows");
    expect(names).not.toContain("get_ui_elements");
    expect(names).not.toContain("set_element_value");
    expect(names).toContain("desktop_discover");
    expect(names).toContain("desktop_act");
  });

  it("drops the v2 tools under the kill switch, and keeps the V1 fallbacks", () => {
    const names = dispatchableStepNames(KILL_SWITCH);
    expect(names).toContain("get_windows");
    expect(names).toContain("get_ui_elements");
    expect(names).toContain("set_element_value");
    expect(names).not.toContain("desktop_discover");
    expect(names).not.toContain("desktop_act");
  });

  it("keeps every tool that neither switch touches, in both configurations", () => {
    // The pairing that stops the filter from being a blunt instrument: five tools that exist at
    // every corner, and the two lists differing ONLY by the five names above.
    for (const env of [V2_ON, KILL_SWITCH]) {
      const names = dispatchableStepNames(env);
      for (const always of ["desktop_state", "screenshot", "mouse_click", "keyboard", "clipboard"]) {
        expect(names, `${always} is not configuration-bound`).toContain(always);
      }
    }
    const onlyInV2 = dispatchableStepNames(V2_ON).filter((n) => !dispatchableStepNames(KILL_SWITCH).includes(n));
    const onlyInKill = dispatchableStepNames(KILL_SWITCH).filter((n) => !dispatchableStepNames(V2_ON).includes(n));
    expect(onlyInV2.sort()).toEqual(["desktop_act", "desktop_discover"]);
    expect(onlyInKill.sort()).toEqual(["get_ui_elements", "get_windows", "set_element_value"]);
  });

  it("never offers `run_macro` itself, which is how recursion stays impossible", () => {
    expect(dispatchableStepNames(V2_ON)).not.toContain("run_macro");
    expect(dispatchableStepNames(KILL_SWITCH)).not.toContain("run_macro");
  });
});
