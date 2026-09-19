/**
 * The value road says what it addressed by — ADR-036 family 2, observation only.
 *
 * Measured on 2026-09-15 (win2, the elevated-window round for internal#106): a title-only act down
 * the UIA value road answers `ok:true` with `route:"uia"` / `why:"uia_set_value"`, a 52-character
 * response, no `landing` and no `hints`. The road's whole record was "it worked" — and the engine
 * never reports which element it wrote to, so the row could not say whether the write was addressed
 * at the ELEMENT or at the WINDOW. That is the first thing the family-2 contract needs: the contract
 * refuses "when the grounds are clear", and how narrowly the call was addressed is what decides
 * whether a wrong element could have answered at all.
 *
 * Behaviour is unchanged. This pins the row, and it pins the one flag that had to be rewritten
 * before it could mean anything: `winTitle` is `aim.title ?? "@active"`, so a flag written from it
 * is true on every row.
 *
 * TWO AXES. The first version ranked automationId > name > title in one `addressedNarrowest`, and a
 * handle-pinned call with no name read as `title_only` beside an `addressedBy.hwnd` that said the
 * opposite (PR 側 codex, P2 on `8a7d86fb`). The element and the window are separate questions —
 * which element inside the window could have answered, and which window could have answered — so
 * the row carries `addressedElementBy` and `addressedWindowBy`, and neither ranks against the
 * other. The cell that used to assert `title_only` is the one below asserting BOTH axes on a
 * handle-pinned nameless entity.
 *
 * What it still cannot say — which element ANSWERED — is engine work on the write side, the mirror
 * of what item 15 closed for `getUiElements` on the read side. It has its own PR and is designed in
 * the map, not here — and there is no cell for it, because the DEP SIGNATURE is the check:
 * `uiaSetValue(...): Promise<void>` cannot return a resolved element, and `tsc` enforces that. A
 * cell asserting the absence of a key nobody writes would be one more thing that cannot fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const HWND = 4919n;
let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "value-road-addressed-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

const base: UiEntity = {
  entityId: "u4",
  role: "textbox",
  confidence: 0.9,
  sources: ["uia"],
  affordances: [
    { verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] },
  ],
  generation: "gen-1",
  evidenceDigest: "d",
  controlType: "Edit",
};

function deps(): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    // The road this file is about: it SUCCEEDS, and says nothing about what it found.
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
  };
}

function valueRoadRows(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.seam === "act.route" && r.why === "uia_set_value");
}

async function typeInto(entity: UiEntity, aim: Aim) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(aim, deps())(entity, "type", "PROBE-VR");
}

const aimed: Aim = { kind: "aim", title: "VR-CELL", hwnd: HWND };

describe("the UIA value road, on success", () => {
  it("records that it was addressed by an automationId — the narrowest the element axis has", async () => {
    const entity: UiEntity = {
      ...base,
      label: "DELTA",
      locator: { uia: { name: "DELTA", automationId: "DELTA-ID" } },
    };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()).toHaveLength(1);
    expect(valueRoadRows()[0]).toMatchObject({
      route: "uia",
      why: "uia_set_value",
      addressedElementBy: "automation_id",
    });
    // `toEqual`, not `toMatchObject`, on THIS object and deliberately (gate 2, 2026-09-16): a
    // partial match permits extra keys, and the key this row keeps growing back is a `windowTitle`
    // flag — added from `winTitle`, removed, added from `aim.title`, removed again when six real
    // arms found it true on every one of them. A third occurrence should fail a cell rather than
    // ship. The window is the axis field's business; this object is element locators only.
    expect(valueRoadRows()[0].addressedBy).toEqual({ automationId: true, name: true });
  });

  it("records `name_substring` when that is all the locator had — the first name that CONTAINS it", async () => {
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedElementBy: "name_substring",
      addressedBy: { automationId: false, name: true },
    });
  });

  it("counts the LABEL as a name too, because that is the string the road is handed", async () => {
    // THE TWO WAYS `name_substring` ARISES, and until this cell only one of them was pinned (gate 2,
    // 2026-09-16): both name cells above set `label` and `locator.uia.name` to the same string, so
    // deleting `?? entity.label` at the executor left the whole file green. The label-only shape is
    // the one the row's comment calls production-reachable — a merged entity whose UIA locator lost
    // its name keeps the label the discover gave it — so it is the half that most needs a cell.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: {} } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedElementBy: "name_substring",
      addressedBy: { automationId: false, name: true },
    });
  });

  it("says the handle addressed the window even when a title rode along — the road never reads it", async () => {
    // THE CELL THE P2 WAS ABOUT. This entity has no name at all, and the aim carries BOTH a handle
    // and a title. The old row called that `title_only` — while `addressedBy.hwnd` said a handle
    // was there, and while both roads resolve the window through the HANDLE and never search a
    // title (`resolve_root`, `src/uia/tree.rs:178`; `makeSetValueScriptByHwnd`,
    // `uia-bridge.ts::makeSetValueScriptByHwnd`). Two axes, and the window axis is the handle's.
    //
    // CONSTRUCTED, AND SAID SO: today's discover cannot produce a nameless UIA entity — the lane
    // filters on `el.name` (`uia-provider.ts:117`), the merge keeps `locator.uia.name`
    // (`resolver.ts:91`), and the executor falls back to `entity.label`. The cell pins the last
    // branch of a total function, so that a producer which one day CAN emit one does not arrive
    // silently mislabelled.
    const entity: UiEntity = { ...base, sources: ["uia"], locator: { uia: {} } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedElementBy: "nothing",
      addressedWindowBy: "handle",
      addressedBy: { automationId: false, name: false },
    });
  });

  it("says the window was addressed by its title when there is no handle", async () => {
    // MEASURED on the machine, both sides of this split: a `{windowTitle}` act answers `"title"`,
    // and `{hwnd}` / `{windowTitle,hwnd}` / a bare act / `"@active"` all answer `"handle"` (win2,
    // 2026-09-16, six arms on `a5cae285`).
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, { kind: "aim", title: "VR-CELL" })).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedWindowBy: "title",
      hasAim: false,
    });
  });

  it("answers `handle` for an aim that has one and no title at all", async () => {
    // THIS CELL USED TO PIN A FLAG THAT IS GONE. Two versions of an `addressedBy.windowTitle` were
    // written and both were true on every row: the first from `winTitle` (`aim.title ?? "@active"`,
    // so always set), the second from `aim.title` — which six real arms found set on a bare act and
    // on an `"@active"` act too, because `session.lastTarget` is replaced by the RESOLVED target as
    // soon as a provider answers (`desktop.ts:410`; win2, 2026-09-16). The question "did the caller
    // name a window" has no witness at this layer, so the row stopped claiming it. What is left is
    // the window axis, which reports the road's own choice.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, { kind: "aim", hwnd: HWND })).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      hasAim: true,
      addressedWindowBy: "handle",
    });
  });

  it("counts an aim with NO title as naming no window — the branch the bare call takes", async () => {
    // THE CELL THAT WAS MISSING (gate 2, 2026-09-16): every other cell hands the aim a title or a
    // handle, so deleting `title !== undefined` from the predicate still type-checked
    // (`undefined !== ""` is true) and the whole file stayed green — while a bare aim would have
    // started reporting `"title"` for a call the backends are handed the literal `"@active"` for.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, { kind: "aim" })).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      hasAim: false,
      addressedWindowBy: "nothing",
    });
  });

  it("counts `@active` and an empty title as naming NO window, because this road expands neither", async () => {
    // Not `!== undefined`: this road has no foreground shorthand, so `"@active"` goes to the same
    // substring search as any other title (`find_window`, `src/uia/tree.rs:226`) and `""` matches
    // whichever top-level window is enumerated first. `_post.ts:439` answers
    // `call_named_no_window` for exactly these two; this row agrees with it.
    //
    // WHICH ROAD BRINGS ONE HERE — corrected three times, and the citation matters because the
    // wrong one makes this row look dead. `desktop.ts:371` stores the RAW caller target first;
    // `:410` replaces it only when a resolved one comes back. A `{windowTitle:"@active"}` with no
    // handle takes `compose-providers.ts:265`, and when there is no foreground to resolve the
    // throw from `_resolve-window.ts:449` is caught at `:274` and `:280` returns the caller's spec
    // unchanged. (It is NOT `:283` — that branch needs a handle, and reading it as the path is how
    // an auditor concludes this row is unreachable.) A bare call in the same state gets
    // `{target: undefined}` (`:289`, `:298`).
    //
    // AND THE SECOND QUESTION, which the row's own comment now carries: an unresolved string in the
    // aim does not give you an ACT behind it. The discover that leaves the caller's string is the
    // one that returned no candidates (`compose-providers.ts:319`) and minted a new view, so on the
    // ingress nothing can follow it here. This cell is therefore about the PREDICATE, not about a
    // row anyone will see in a production log — and it keeps both strings because the predicate is
    // what it pins.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    for (const title of ["@active", ""]) {
      rmSync(logPath, { force: true });
      expect(await typeInto(entity, { kind: "aim", title })).toEqual("uia");
      expect(valueRoadRows()[0]).toMatchObject({
        hasAim: false,
        addressedWindowBy: "nothing",
      });
    }
  });

  it("answers `nothing` for an empty locator, which is not the same as the roads agreeing about one", async () => {
    // THE ROADS DID NOT AGREE, and the first version of this comment said they did (gate 2,
    // 2026-09-16). On the NAME they always have — PowerShell writes `$true`
    // (`uia-bridge.ts::makeSetValueScript`'s `nameFilter`) and the native walk matched `contains("")`.
    // On the AUTOMATION ID they did not: PowerShell drops the filter (the same script's `idFilter`)
    // while the native road compared exactly, so an empty id EXCLUDED every element that has one.
    // internal #133 made an empty criterion mean "not given" on the native side too (`given`,
    // `src/uia/actions.rs`), and a locator with nothing left is answered "not found" there — so THIS
    // ENTITY NO LONGER REACHES AN ELEMENT on a real machine: `uiaSetValue` would throw, and the row
    // is written after it returns (`desktop-executor.ts`), so there would be no row at all. What
    // keeps this cell standing is the MOCK, and what it pins is how the row's VALUES are computed —
    // `uiaAddressAxes` runs before the call. What the road does with the locator is #133's.
    //
    // THE CELL STILL ASSERTS `"nothing"`, and on purpose: an empty id is not something the call was
    // addressed BY, and answering `automation_id` would launder a road defect into a claim about
    // the caller. What this pins is the ROW's predicate, not a model of the roads — the road's own
    // disagreement is filed separately.
    //
    // CONSTRUCTED: `uia-provider.ts:126` already normalises an empty automationId to `undefined`
    // and `:117` drops nameless elements, so no shipped call arrives here.
    const entity: UiEntity = { ...base, locator: { uia: { name: "", automationId: "" } } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedElementBy: "nothing",
      addressedBy: { automationId: false, name: false },
    });
  });

});

/**
 * THE CLICK ROAD WRITES THE SAME THREE FIELDS. It wrote none of them, so a route-check cell on a
 * click could say what it ASKED for — a handle or a title, an AutomationId or a name — but not what
 * the product TOOK (win2, internal `dc635ce`, §4.1: the largest blocker on the grid, a whole action
 * column). One helper (`uiaAddressAxes`) now writes them on every row of the UIA road, so the value
 * road's cells above pin the meaning and these pin that the click road carries it.
 */
describe("the UIA click road, and its refusals and downgrade", () => {
  const button: UiEntity = {
    ...base,
    entityId: "b1",
    role: "button",
    label: "GO",
    affordances: [{ verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    controlType: "Button",
    rect: { x: 100, y: 200, width: 80, height: 30 },
  };
  const failing = (text: string) => vi.fn(async () => { throw Object.assign(new Error(text), { uiaVia: "native" }); });
  const allRows = (): Array<Record<string, unknown>> =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.seam === "act.route")
      : [];
  async function click(entity: UiEntity, aim: Aim, over: Partial<ExecutorDeps> = {}) {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    return createDesktopExecutor(aim, { ...deps(), ...over })(entity, "click").then((v) => v, (e: unknown) => e);
  }

  it("writes the axes on a UIA invoke by handle and AutomationId", async () => {
    await click({ ...button, locator: { uia: { name: "GO", automationId: "GO-ID" } } }, aimed);
    const row = allRows().find((r) => r.why === "uia_invoke");
    expect(row).toMatchObject({ route: "uia", addressedWindowBy: "handle", addressedElementBy: "automation_id" });
    expect(row?.addressedBy).toEqual({ automationId: true, name: true });
  });

  it("writes the axes on a UIA invoke by title and name", async () => {
    await click({ ...button, locator: { uia: { name: "GO" } } }, { kind: "aim", title: "VR-CELL" });
    expect(allRows().find((r) => r.why === "uia_invoke")).toMatchObject({ addressedWindowBy: "title", addressedElementBy: "name_substring" });
  });

  it("writes them on the aimed refusal — the click that was not finished as a coordinate press", async () => {
    const out = await click({ ...button, locator: { uia: { name: "GO", automationId: "GO-ID" } } }, aimed, { uiaClick: failing("Element not found") });
    expect((out as Error).name).toBe("AimedRouteFailedError");
    expect(allRows().find((r) => r.route === "refusal" && r.rung === "uia_click"))
      .toMatchObject({ refused: "aim_route_failed", addressedWindowBy: "handle", addressedElementBy: "automation_id" });
  });

  it("writes them on the title road's not-found refusal", async () => {
    const e = { ...button, locator: { uia: { name: "GO", via: "native" as const } } };
    const out = await click(e, { kind: "aim", title: "VR-CELL" }, { uiaClick: failing("Element not found") });
    expect((out as Error).name).toBe("TargetGoneError");
    expect(allRows().find((r) => r.route === "refusal" && r.rung === "uia_downgrade"))
      .toMatchObject({ refused: "entity_not_found", addressedWindowBy: "title", addressedElementBy: "name_substring" });
  });

  it("writes them on the coordinate downgrade NESTED, as what the UIA attempt it replaces carried — never as the press's own", async () => {
    // Gate 2: under the same three names at the top level, a reader selecting rows by
    // `addressedWindowBy` counted this coordinate press as a successful UIA click by title.
    const d = { uiaClick: failing("InvokePattern not supported by this element"), mouseClick: vi.fn(async () => {}) };
    await click({ ...button, locator: { uia: { name: "GO" } } }, { kind: "aim", title: "VR-CELL" }, d);
    expect(d.mouseClick).toHaveBeenCalled();
    const row = allRows().find((r) => r.route === "mouse" && r.why === "uia_downgrade");
    expect(row?.uiaAttempt).toEqual({ addressedBy: { automationId: false, name: true }, addressedElementBy: "name_substring", addressedWindowBy: "title" });
    expect(row).not.toHaveProperty("addressedWindowBy");
    expect(row).not.toHaveProperty("addressedElementBy");
    expect(row).not.toHaveProperty("addressedBy");
  });

  it("counts the label as the name on the click road too — the string the road is handed", async () => {
    // Gate 2: every click cell set a locator name, so dropping `?? entity.label` survived here.
    await click({ ...button, label: "GO", locator: { uia: {} } }, { kind: "aim", title: "VR-CELL" });
    expect(allRows().find((r) => r.why === "uia_invoke")).toMatchObject({
      addressedElementBy: "name_substring",
      addressedBy: { automationId: false, name: true },
    });
  });

  it("every row the UIA road's rungs write carries the three, with the values its call carried", async () => {
    // A parity pin, by VALUE (gate 2: presence alone let six wrong-value mutations through). Each
    // shape runs on a fresh log, and every UIA-road row it writes must carry exactly `expected`.
    const { WindowExcludedError } = await import("../../src/engine/tool-exclusion.js");
    const { AimedWindowGoneError } = await import("../../src/engine/aim.js");
    const excluded = () => vi.fn(async () => { throw new WindowExcludedError("excluded"); });
    const gone = () => vi.fn(async () => { throw new AimedWindowGoneError(HWND); });
    const field: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    const titled: Aim = { kind: "aim", title: "VR-CELL" };
    const byName = { automationId: false, name: true };
    const axes = (addressedBy: object, addressedElementBy: string, addressedWindowBy: string) => ({ addressedBy, addressedElementBy, addressedWindowBy });
    const shapes: Array<[string, UiEntity, Aim, Partial<ExecutorDeps>, ReturnType<typeof axes>]> = [
      ["uia/uia_invoke", { ...button, locator: { uia: { name: "GO", automationId: "GO-ID" } } }, aimed, {},
        axes({ automationId: true, name: true }, "automation_id", "handle")],
      ["uia_click/window_excluded", { ...button, locator: { uia: { name: "GO" } } }, aimed, { uiaClick: excluded() }, axes(byName, "name_substring", "handle")],
      ["uia_click/aim_window_gone", { ...button, locator: { uia: { name: "GO" } } }, aimed, { uiaClick: gone() }, axes(byName, "name_substring", "handle")],
      ["uia_click/aim_route_failed", { ...button, locator: { uia: { name: "GO" } } }, aimed, { uiaClick: failing("Element not found") }, axes(byName, "name_substring", "handle")],
      ["uia_downgrade/entity_not_found", { ...button, locator: { uia: { name: "GO", via: "native" } } }, titled, { uiaClick: failing("Element not found") },
        axes(byName, "name_substring", "title")],
      ["uia_downgrade/aim_route_failed", { ...button, locator: { uia: { name: "GO", via: "native", nativeWindowHandle: "900" } } }, titled,
        { uiaClick: failing("Element is disabled"), windowTakesInput: (h: bigint) => h !== 900n }, axes(byName, "name_substring", "title")],
      ["uia/uia_set_value", field, aimed, {}, axes(byName, "name_substring", "handle")],
      ["uia_set_value/window_excluded", field, aimed, { uiaSetValue: excluded() }, axes(byName, "name_substring", "handle")],
      ["uia_set_value_then_keyboard/aim_window_gone", field, aimed, { uiaSetValue: gone(), keyboardTypeBg: gone() }, axes(byName, "name_substring", "handle")],
      ["uia_set_value_then_keyboard/aim_route_failed", field, aimed,
        { uiaSetValue: failing("ValuePattern not supported by this element"), keyboardTypeBg: vi.fn(async () => { throw new Error("post failed"); }) },
        axes(byName, "name_substring", "handle")],
    ];
    const seen: string[] = [];
    for (const [label, e, aim, over, expected] of shapes) {
      rmSync(logPath, { force: true });
      const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
      const action = e.role === "textbox" ? "type" : "click";
      await createDesktopExecutor(aim, { ...deps(), ...over })(e, action, action === "type" ? "PROBE-VR" : undefined).catch(() => {});
      const rows = allRows().filter((r) =>
        r.route === "uia" || (r.route === "refusal" && typeof r.rung === "string" && (r.rung as string).startsWith("uia_")));
      expect(rows.length, `${label}: no UIA-road row`).toBeGreaterThan(0);
      for (const r of rows) {
        const key = r.route === "refusal" ? `${r.rung}/${r.refused}` : `uia/${r.why}`;
        seen.push(key);
        expect({ addressedBy: r.addressedBy, addressedElementBy: r.addressedElementBy, addressedWindowBy: r.addressedWindowBy }, `${label} → ${key}`)
          .toEqual(expected);
      }
    }
    // Every shape reached its own row — a shape that stopped reaching it fails here, not silently.
    expect([...new Set(seen)].sort()).toEqual(shapes.map(([label]) => label).sort());
  });
});

