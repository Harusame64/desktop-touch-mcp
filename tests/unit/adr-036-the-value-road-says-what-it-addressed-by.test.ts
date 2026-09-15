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
      addressedBy: { automationId: true, name: true, hwnd: true },
    });
  });

  it("records `name_substring` when that is all the locator had — the first name that CONTAINS it", async () => {
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
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
    // `uia-bridge.ts:1464`). Two axes, and the window axis is the handle's.
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
      addressedBy: { automationId: false, name: false, hwnd: true },
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
      addressedBy: { hwnd: false },
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
      addressedBy: { hwnd: true },
      addressedWindowBy: "handle",
    });
  });

  it("counts `@active` and an empty title as naming NO window, because this road expands neither", async () => {
    // Not `!== undefined`: this road has no foreground shorthand, so `"@active"` goes to the same
    // substring search as any other title (`find_window`, `src/uia/tree.rs:226`) and `""` matches
    // whichever top-level window is enumerated first. `_post.ts:439` answers
    // `call_named_no_window` for exactly these two; this row agrees with it.
    //
    // WHICH ROAD BRINGS ONE HERE, twice corrected. The ingress USUALLY resolves the title first —
    // six real arms came back resolved, including a bare act and an `"@active"` act (win2,
    // 2026-09-16). But `desktop.ts:410` is conditional, and when no provider target comes back the
    // caller's spec stays: the foreground fallback throws with no foreground window
    // (`_resolve-window.ts:449`) and the composer catches it (`compose-providers.ts:289,298`), and
    // a `{windowTitle:"@active"}` with no handle is passed straight through (`:283`). So this row
    // is not a test-road curiosity — on the shipped road it means window resolution DID NOT
    // HAPPEN, and the write went wherever a literal substring search landed.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    for (const title of ["@active", ""]) {
      rmSync(logPath, { force: true });
      expect(await typeInto(entity, { kind: "aim", title })).toEqual("uia");
      expect(valueRoadRows()[0]).toMatchObject({
        addressedBy: { hwnd: false },
        addressedWindowBy: "nothing",
      });
    }
  });

  it("answers `nothing` for an empty locator, which is not the same as the roads agreeing about one", async () => {
    // THE ROADS DO NOT AGREE, and the first version of this comment said they did (gate 2,
    // 2026-09-16). On the NAME they do — PowerShell writes `$true` (`uia-bridge.ts:762`) and the
    // native walk matches `contains("")` (`src/uia/scroll.rs:858`). On the AUTOMATION ID they do
    // not: PowerShell drops the filter (`uia-bridge.ts:763`) while the native road compares
    // exactly (`id == target`, `src/uia/scroll.rs:867`), so an empty id EXCLUDES every element that
    // has one.
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
