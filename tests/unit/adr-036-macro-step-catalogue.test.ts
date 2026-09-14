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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchableStepNames, runMacroSchema } from "../../src/tools/macro.js";

const MACRO_SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/tools/macro.ts", import.meta.url)),
  "utf8",
);

/** The description the SDK publishes for `steps[].tool` — what an LLM caller actually reads. */
function publishedStepToolDescription(): string {
  const steps = runMacroSchema.steps as unknown as Record<string, unknown>;
  const element = (steps.element ??
    (steps._def as Record<string, unknown> | undefined)?.type ??
    (steps._def as Record<string, unknown> | undefined)?.element) as
    | { shape?: { tool?: { description?: string } } }
    | undefined;
  const description = element?.shape?.tool?.description;
  if (typeof description !== "string") {
    throw new Error("could not read the published description of steps[].tool");
  }
  return description;
}

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

  it("offers no tool it cannot dispatch, which is not the same as offering every tool", () => {
    // Five tools are registered on the server and absent from the macro registry, so they are
    // absent from the catalogue at every corner. That asymmetry is deliberate — the catalogue
    // answers "what can be a step", and a step naming one of these is told `Unknown tool`. Pinned
    // so the next reader does not have to re-derive it, and so adding one to the registry without
    // meaning to shows up here.
    for (const env of [V2_ON, KILL_SWITCH]) {
      for (const notAStep of ["excel", "key_locker", "server_status", "screenshot_query", "screenshot_gc"]) {
        expect(dispatchableStepNames(env), `${notAStep} is not macro-dispatchable`).not.toContain(notAStep);
      }
    }
  });

  it("never offers `run_macro` itself, which is how recursion stays impossible", () => {
    expect(dispatchableStepNames(V2_ON)).not.toContain("run_macro");
    expect(dispatchableStepNames(KILL_SWITCH)).not.toContain("run_macro");
  });

  /**
   * THE HELPER IS NOT THE ADVERTISEMENT. Every cell above calls `dispatchableStepNames`, and gate
   * 2 showed what that leaves open: put `Object.keys(TOOL_REGISTRY)` back into the description
   * string, leave the helper alone, and the whole suite stays green while the catalogue lies
   * exactly as it did before. The defect lived in the published string, so a cell has to read the
   * published string.
   */
  it("publishes that list in the description an LLM caller actually reads", () => {
    const description = publishedStepToolDescription();
    const advertised = description
      .replace(/^.*One of:\s*/s, "")
      .replace(/,?\s*or the special pseudo-command.*$/s, "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    expect(advertised).toEqual(dispatchableStepNames());
    // …and the pseudo-step, which is in no registry and must still be offered.
    expect(description).toContain('"sleep"');
    // The v1.0.0 surface is the string this cell exists to keep out: `run_macro` cannot dispatch
    // itself, and a catalogue built from the raw registry would name it.
    expect(advertised).not.toContain("run_macro");
  });

  /**
   * EVERY V2-GATED ENTRY IS IN EXACTLY ONE TABLE, read off the source rather than trusted.
   * `V1_FALLBACK_ONLY` is shared with the refusals, but `V2_ONLY` is a second list: the v2 refusal
   * is a `v2KillSwitchActive()` gate inside each handler body, so nothing makes the table and the
   * gates agree. Gate 2 added a v2-gated registry entry, did not add it to the table, and got a
   * clean `tsc`, a green suite, and a catalogue advertising a step that refuses — the original
   * defect, reintroduced invisibly.
   *
   * So this reads the handler bodies. A new gate that no table names fails here, whichever
   * direction it gates in.
   */
  it("names every v2-gated registry entry in one of the two tables", () => {
    const registry = MACRO_SOURCE.slice(
      MACRO_SOURCE.indexOf("const TOOL_REGISTRY"),
      MACRO_SOURCE.indexOf("// run_macro is intentionally excluded"),
    );
    expect(registry.length).toBeGreaterThan(0);

    // Each entry is `name: {` at two-space indent; the body runs to the next such header.
    const headers = [...registry.matchAll(/^ {2}([a-z_]+):\s*\{/gm)];
    expect(headers.length).toBeGreaterThan(10);
    const gated = new Set<string>();
    headers.forEach((header, i) => {
      const body = registry.slice(
        header.index,
        i + 1 < headers.length ? headers[i + 1].index : registry.length,
      );
      if (body.includes("v2KillSwitchActive()")) gated.add(header[1]);
    });

    // What the two tables claim, derived from the function the catalogue is built from: a name
    // absent from one configuration and present in the other is table-listed, whichever table.
    const withV2 = dispatchableStepNames(V2_ON);
    const withKillSwitch = dispatchableStepNames(KILL_SWITCH);
    const tabled = new Set([
      ...withV2.filter((name) => !withKillSwitch.includes(name)),
      ...withKillSwitch.filter((name) => !withV2.includes(name)),
    ]);

    expect([...gated].sort()).toEqual([...tabled].sort());
  });
});
