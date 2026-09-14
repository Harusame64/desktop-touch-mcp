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
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchableStepNames, runMacroSchema } from "../../src/tools/macro.js";

const MACRO_SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/tools/macro.ts", import.meta.url)),
  "utf8",
);

/** The description the SDK publishes for `steps[].tool` — what an LLM caller actually reads. */
function publishedStepToolDescription(schema: typeof runMacroSchema = runMacroSchema): string {
  const steps = schema.steps as unknown as Record<string, unknown>;
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

/** The step names inside that description, as a caller would read them off it. */
function namesIn(description: string): string[] {
  return description
    .replace(/^.*One of:\s*/s, "")
    .replace(/,?\s*or the special pseudo-command.*$/s, "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
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

  /**
   * THE SIX NAMES THE SHIPPED SENTENCE PROMISES ARE NEVER STEPS. `details` says so in text, which
   * is the copy the stub catalogue publishes for directory hosts — the generator drops the nested
   * `tool` description, so that sentence is all a reader there gets (gate 1). Naming a
   * corner-INDEPENDENT set is safe to freeze into a generated file; naming a corner's list would
   * not be, which is why the sentence defers for the rest.
   */
  it("never offers the six the shipped sentence says are never steps, at either corner", () => {
    for (const env of [V2_ON, KILL_SWITCH]) {
      const names = dispatchableStepNames(env);
      for (const never of [
        "excel", "key_locker", "server_status", "screenshot_query", "screenshot_gc", "run_macro",
      ]) {
        expect(names, `${never} is promised to be no step`).not.toContain(never);
      }
    }
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
    const advertised = namesIn(description);

    expect(advertised).toEqual(dispatchableStepNames());
    // …and the pseudo-step, which is in no registry and must still be offered.
    expect(description).toContain('"sleep"');
    // The v1.0.0 surface is the string this cell exists to keep out: `run_macro` cannot dispatch
    // itself, and a catalogue built from the raw registry would name it.
    expect(advertised).not.toContain("run_macro");
  });

  /**
   * NOTHING DECIDES AVAILABILITY IN A HANDLER BODY ANY MORE. The previous form of this file
   * scanned the registry for a literal `v2KillSwitchActive()` and required each gated entry to
   * appear in one of two tables. Gate 1 broke that in one line: a handler that DELEGATES its
   * refusal to a helper carries no literal to find, so the scan misses it — and the missing entry
   * is also missing from the configuration difference the scan compared against, so the cell stays
   * green while the catalogue advertises a step that refuses.
   *
   * A lexical pin cannot close a lexical hole. The gate is `entry.availability` now, read by the
   * catalogue and by the dispatcher, so this cell guards the one thing that would bring the class
   * back: a configuration test inside the registry.
   */
  it("keeps configuration out of the handler bodies, where only one of the two readers can see it", () => {
    const registry = MACRO_SOURCE.slice(
      MACRO_SOURCE.indexOf("const TOOL_REGISTRY"),
      MACRO_SOURCE.indexOf("// run_macro is intentionally excluded"),
    );
    expect(registry.length).toBeGreaterThan(0);
    // Comments may name the switches — the registry's own prose explains which corner the V1
    // fallbacks belong to. The claim is about CODE, so the comments come out first.
    const code = registry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("resolveV2Activation");
    expect(code).not.toContain("KillSwitch");
    expect(code).not.toContain("DESKTOP_TOUCH_DISABLE");
    // AND THE TWO REFUSALS THEMSELVES, which is what gate 2 showed the list above does not catch:
    // a handler that asks a helper `gateSaysNo()` and returns `v2DisabledError()` carries none of
    // the three spellings, declares no availability, and ships green — the ADR-036 defect,
    // reintroduced. Denying the two refusal HELPERS is narrower than denying the spelling of one
    // gate — but only by a step: a handler that builds `failCode("FukuwaraiV2Disabled", …)` by
    // hand, in another module, reaches the caller and passes every rule here (gate 2, measured).
    // The compiler is what ends the omission; this ends the careless inline version of the lie.
    expect(code).not.toContain("v2DisabledError");
    expect(code).not.toContain("v1FallbackOnlyError");

    // AND EVERY ENTRY STATES ITS CORNER. Gate 1 walked through the denylist above by putting the
    // refusal in a helper defined OUTSIDE the registry, where no lexical rule inside it can see
    // — so `availability` is a required field now, `"always"` included. The compiler is the real
    // guard; this counts, so that the claim "every entry declares" is a row someone can read
    // rather than a property they have to infer from a type. It counts LITERAL declarations
    // against LITERAL entry headers, so an entry built by a factory — `x: killSwitchOnlyEntry(…)`
    // — is invisible to both halves and the row is vacuous for it (gate 2). Every shape it does
    // notice fails red; this one it does not notice at all, and the type is what still holds.
    const entries = (code.match(/^ {2}[a-z_]+:\s*\{/gm) ?? []).length;
    expect(entries).toBeGreaterThan(25);
    expect((code.match(/availability:/g) ?? []).length).toBe(entries);
  });

  /**
   * THE DISPATCHER AND THE CATALOGUE READ THE SAME MOMENT. The catalogue is frozen at module
   * initialisation — it is a string in a schema — and `server-windows.ts` freezes the registered
   * surface the same way, so a dispatcher that re-read `process.env` per step would be the only
   * thing in the server that could change its mind mid-process. Same-process code flipping the
   * flag would then get a step refused although the catalogue offers it, or a v1 fallback run for
   * a surface the server never registered: this file's own defect moved from the configuration
   * axis to the time axis (gate 1 on `8818db0`).
   */
  it("does not change its mind when the environment moves after startup", async () => {
    vi.resetModules();
    // EXPLICIT, NOT AMBIENT. `unstubAllEnvs` restores what the shell exported, and the four-corner
    // sweeps run this suite with the kill switch set — which would make this cell fail for a
    // reason that has nothing to do with the code (gate 2).
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2", undefined as unknown as string);
    const fresh = await import("../../src/tools/macro.js");
    const advertisedAtStartup = fresh.dispatchableStepNames();
    expect(advertisedAtStartup).toContain("desktop_act");
    try {
      vi.stubEnv("DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2", "1");
      // The catalogue this build published cannot move, so neither may the answer it gives about
      // itself — and asking about ANOTHER server still works, because that is a different question.
      expect(fresh.dispatchableStepNames()).toEqual(advertisedAtStartup);
      expect(fresh.dispatchableStepNames(process.env)).not.toContain("desktop_act");

      // AND THE DISPATCHER'S HALF, which is the half that matters and the one a mutation slipped
      // through: re-reading `process.env` per step passed every cell above, because they all ask
      // the catalogue. The refusal is what a caller meets, so the refusal is what this asks.
      const ran = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      const entry = {
        schema: {},
        handler: async () => ran,
        availability: { corner: "v2Only" },
      } as unknown as Parameters<typeof fresh.runInnerToolAsResult>[0];
      const outcome = await fresh.runInnerToolAsResult(entry, {}, "desktop_act");
      expect(outcome.ok, "a v2-only step must still run for a server that started with v2 on").toBe(true);
    } finally {
      vi.resetModules();
      vi.unstubAllEnvs();
    }
  });

  /**
   * AND THE ADVERTISEMENT IS BUILT AT MODULE LOAD, so testing it once tests one corner. Gate 1:
   * hard-coding the description to `dispatchableStepNames({})` would leave every cell above green
   * while a server started under the kill switch advertised the wrong steps. Re-import the module
   * with the environment set each way, and read what each build publishes.
   */
  it("publishes the right list in BOTH corners, not only the one the tests run in", async () => {
    try {
      for (const killSwitch of [undefined, "1"] as const) {
        vi.resetModules();
        // Unconditional, for the reason the freeze cell above gives: an ambient kill switch would
        // otherwise decide the first iteration.
        vi.stubEnv("DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2", killSwitch as unknown as string);
        // `vi.resetModules()` above drops the cached instance, so this static specifier gives a
        // build that read the environment as it stands now.
        const fresh = await import("../../src/tools/macro.js");
        const advertised = namesIn(publishedStepToolDescription(fresh.runMacroSchema));
        expect(advertised).toEqual(fresh.dispatchableStepNames(process.env));
        // The pairing that makes the row mean something: the corners differ, and differ by the
        // declared steps rather than by nothing.
        expect(advertised).toContain(killSwitch ? "get_windows" : "desktop_act");
        expect(advertised).not.toContain(killSwitch ? "desktop_act" : "get_windows");
      }
    } finally {
      vi.resetModules();
      vi.unstubAllEnvs();
    }
  });
});
