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
      addressedBy: { automationId: true, name: true, windowTitle: true, hwnd: true },
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
    // `uia-bridge.ts:1461`). Two axes, and the window axis is the handle's.
    //
    // CONSTRUCTED, AND SAID SO: today's discover cannot produce a nameless UIA entity — the lane
    // filters on `el.name` (`uia-provider.ts:116`), the merge keeps `locator.uia.name`
    // (`resolver.ts:91`), and the executor falls back to `entity.label`. The cell pins the last
    // branch of a total function, so that a producer which one day CAN emit one does not arrive
    // silently mislabelled.
    const entity: UiEntity = { ...base, sources: ["uia"], locator: { uia: {} } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedElementBy: "nothing",
      addressedWindowBy: "handle",
      addressedBy: { automationId: false, name: false, windowTitle: true, hwnd: true },
    });
  });

  it("says the window was addressed by its title when there is no handle", async () => {
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, { kind: "aim", title: "VR-CELL" })).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedWindowBy: "title",
      addressedBy: { windowTitle: true, hwnd: false },
    });
  });

  it("says the window was NOT named when the aim fell back to the foreground", async () => {
    // THE FLAG THAT HAD TO BE REWRITTEN. `winTitle` is `aim.title ?? "@active"`, so a flag written
    // from it is true on every row and separates nothing. Written from `aim.title`, it separates a
    // named window from a call that took whatever was in front — two different acts.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, { kind: "aim", hwnd: HWND })).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedBy: { windowTitle: false, hwnd: true },
      addressedWindowBy: "handle",
    });
  });

  it("counts `@active` and an empty title as naming NO window, because this road expands neither", async () => {
    // Not `!== undefined`. `aim.title` is the caller's string, copied verbatim by `toAim`
    // (`aim.ts:497`), and this road has no foreground shorthand: `"@active"` goes to the same
    // substring search as any other title (`find_window`, `src/uia/tree.rs:226`), and `""` matches
    // whichever top-level window is enumerated first. `_post.ts:439` answers
    // `call_named_no_window` for exactly these two; this row agrees with it.
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    for (const title of ["@active", ""]) {
      rmSync(logPath, { force: true });
      expect(await typeInto(entity, { kind: "aim", title })).toEqual("uia");
      expect(valueRoadRows()[0]).toMatchObject({
        addressedBy: { windowTitle: false, hwnd: false },
        addressedWindowBy: "nothing",
      });
    }
  });

  it("reads an EMPTY locator as no filter, because that is what both roads do with it", async () => {
    // The roads agree and the row has to: PowerShell writes `$true` for an empty name or id
    // (`uia-bridge.ts:762-763`), and the native walk matches `contains("")` on every element
    // (`src/uia/scroll.rs:858`). A row that called `""` an address would claim a narrowness the
    // call does not have — the same defect as the P2 above, one layer down.
    //
    // CONSTRUCTED: `uia-provider.ts:127` already normalises an empty automationId to `undefined`
    // and drops nameless elements, so no shipped call arrives here. The cell pins the predicate
    // against the road's, which is what can drift silently.
    const entity: UiEntity = { ...base, locator: { uia: { name: "", automationId: "" } } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedElementBy: "nothing",
      addressedBy: { automationId: false, name: false },
    });
  });

});
