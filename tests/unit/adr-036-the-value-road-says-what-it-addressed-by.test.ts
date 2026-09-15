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
  it("records that it was addressed by an automationId — the narrowest there is", async () => {
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
      addressedNarrowest: "automation_id",
      addressedBy: { automationId: true, name: true, windowTitle: true, hwnd: true },
    });
  });

  it("records `name` when that is all the locator had — not unique within a window", async () => {
    const entity: UiEntity = { ...base, label: "DELTA", locator: { uia: { name: "DELTA" } } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedNarrowest: "name",
      addressedBy: { automationId: false, name: true },
    });
  });

  it("records `title_only` when neither a locator name nor a label was there to go on", async () => {
    // `name` is `locator.uia.name ?? entity.label`, so BOTH have to be absent — which is why the
    // entity here carries no label. An entity with a label is addressed by that label's text.
    const entity: UiEntity = { ...base, sources: ["uia"], locator: { uia: {} } };
    expect(await typeInto(entity, aimed)).toEqual("uia");
    expect(valueRoadRows()[0]).toMatchObject({
      addressedNarrowest: "title_only",
      addressedBy: { automationId: false, name: false },
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
    });
  });

});
