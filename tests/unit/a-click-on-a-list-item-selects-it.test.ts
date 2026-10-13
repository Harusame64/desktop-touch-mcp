/**
 * internal #233 — a `desktop_act` click on a collection item selects it; it does not invoke it.
 *
 * MEASURED win2 (2026-10-13, internal #233 comments): UI Automation's Invoke on a ListItem acts as a
 * double-click — Explorer opened the file, a SysListView32 sent NM_DBLCLK, a Win32 LISTBOX LBN_DBLCLK, a
 * WinForms ListBox fired DoubleClick — and a WinForms ListView's Invoke did nothing and reported ok.
 * SelectionItem.Select selected on every provider, with zero DBLCLK. The user's decision: a click on a
 * ListItem, DataItem or TreeItem selects it through SelectionItemPattern; `action:"invoke"` keeps Invoke.
 *
 * These cells pin the dispatch on both roads, the three refusals (no press after any of them — neither
 * Invoke nor the mouse), the route's `why`, the production dep's mapping of the engine's codes, and the
 * bridge's refusal to run without the native engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";

const FORM = 4919n;

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "list-item-select-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  vi.doUnmock("../../src/engine/uia-bridge.js");
  vi.doUnmock("../../src/engine/native-engine.js");
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

function entity(controlType: string): UiEntity {
  return {
    entityId: `e-${controlType}`, role: "listitem", label: "report.txt", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "report.txt", automationId: "7", via: "native" } },
    affordances: [{ verb: "read", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 300, y: 300, width: 200, height: 20 }, controlType,
    // What the registry gives an element with InvokePattern (`registry.ts`): UIA first, the mouse second.
    preferredExecutors: ["uia", "mouse"],
    origin: { kind: "window", id: "FX233", hwnd: FORM.toString() },
  };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSelect: vi.fn(async () => ({ focusedBy: "win32_list" })),
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const titleRoad = { windowTitle: "FX233" };
const handleRoad: Aim = { kind: "aim", title: "FX233", hwnd: FORM };
const roads = [["title road", titleRoad], ["handle road", handleRoad]] as const;

async function act(target: typeof titleRoad | Aim, d: ExecutorDeps, e: UiEntity, action: "click" | "invoke") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(e, action).then(
    (v) => ({ v, e: null as null | { name?: string; callerDetail?: string; noRouteTried?: true } }),
    (err: unknown) => ({ v: null, e: err as { name?: string; callerDetail?: string; noRouteTried?: true } }),
  );
}

function routeRows(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.seam === "act.route");
}

/** What the production dep throws for an engine answer with this code (`desktop-executor.ts::uiaSelect`). */
const engineSays = (error: string, uiaCode?: string) =>
  vi.fn(async () => { throw Object.assign(new Error(error), { uiaVia: "native", uiaCode }); });

describe("a click on a collection item", () => {
  for (const [roadName, road] of roads) {
    for (const controlType of ["ListItem", "DataItem", "TreeItem"]) {
      it(`selects a ${controlType} and never invokes it — ${roadName}`, async () => {
        const d = deps();
        const { v, e: err } = await act(road, d, entity(controlType), "click");
        expect(err).toBeNull();
        expect(v).toBe("uia");
        expect(d.uiaSelect).toHaveBeenCalledTimes(1);
        expect(d.uiaSelect).toHaveBeenCalledWith(
          "FX233", "report.txt", "7", controlType, roadName === "handle road" ? FORM : undefined,
        );
        expect(d.uiaClick).not.toHaveBeenCalled();
        expect(d.mouseClick).not.toHaveBeenCalled();
      });
    }

    it(`says on its route row that it was a select — ${roadName}`, async () => {
      await act(road, deps(), entity("ListItem"), "click");
      const rows = routeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ route: "uia", why: "uia_select", focusedBy: "win32_list" });
      expect(rows[0]!.addressedWindowBy).toBe(roadName === "handle road" ? "handle" : "title");
    });

    it(`keeps Invoke for action:"invoke" — ${roadName}`, async () => {
      const d = deps();
      const { v } = await act(road, d, entity("ListItem"), "invoke");
      expect(v).toBe("uia");
      expect(d.uiaClick).toHaveBeenCalledTimes(1);
      expect(d.uiaSelect).not.toHaveBeenCalled();
      expect(routeRows()[0]).toMatchObject({ why: "uia_invoke" });
    });

    it(`leaves a Button's click on Invoke — ${roadName}`, async () => {
      const d = deps();
      const { v } = await act(road, d, { ...entity("Button"), role: "button" }, "click");
      expect(v).toBe("uia");
      expect(d.uiaClick).toHaveBeenCalledTimes(1);
      expect(d.uiaSelect).not.toHaveBeenCalled();
    });

    it(`refuses an item that has only Invoke, pressing nothing — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("SelectionItemPattern not supported by this element", "PatternNotSupported") });
      const { v, e: err } = await act(road, d, entity("ListItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.noRouteTried).toBe(true);
      expect(err?.callerDetail).toMatch(/^Nothing was pressed: "report\.txt" cannot be selected through UI Automation, and a click on it would open or run it\./);
      expect(err?.callerDetail).toContain("desktop_act(action:'invoke')");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
      expect(routeRows().at(-1)).toMatchObject({ route: "refusal", rung: "uia_select", refused: "executor_failed", selectRefused: "only_invoke" });
    });

    it(`refuses a select that did not take, saying nothing changed — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("The item was not selected", "SelectNotApplied") });
      const { v, e: err } = await act(road, d, entity("DataItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.noRouteTried).toBeUndefined();
      expect(err?.callerDetail).toMatch(/^Nothing was pressed, and nothing changed: /);
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });

    it(`refuses a select that failed any other way, pressing nothing — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("Select failed: 0x80040201") });
      const { v, e: err } = await act(road, d, entity("TreeItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.callerDetail).toMatch(/^Nothing was pressed: selecting "report\.txt" through UI Automation failed, and the act was not finished as a press\./);
      // The backend's own text is not the caller's (ADR-036 item 13).
      expect(err?.callerDetail).not.toContain("0x80040201");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });

    it(`refuses a select whose window stopped answering, in the engine's words — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("Window stopped answering during the act") });
      const { e: err } = await act(road, d, entity("ListItem"), "click");
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.callerDetail).toMatch(/^Nothing was pressed: selecting "report\.txt" through UI Automation failed because /);
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });
  }
});

describe("the production select dep and its bridge", () => {
  it("carries the engine's code on the error, and never falls back to the click", async () => {
    const clickElement = vi.fn(async () => ({ ok: true }));
    const answers = [
      { ok: false, error: "SelectionItemPattern not supported by this element", code: "PatternNotSupported", via: "native" as const },
      { ok: false, error: "The item was not selected", code: "SelectNotApplied", via: "native" as const },
    ];
    const selectElement = vi.fn(async () => answers.shift()!);
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({ ...(await orig<object>()), selectElement, clickElement }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    const d = _realExecutorDepsForTest();
    const first = await d.uiaSelect("FX233", "report.txt", "7", "ListItem", FORM).then(() => null, (e: unknown) => e as { uiaCode?: string });
    const second = await d.uiaSelect("FX233", "report.txt", "7", "ListItem").then(() => null, (e: unknown) => e as { uiaCode?: string });
    expect(first?.uiaCode).toBe("PatternNotSupported");
    expect(second?.uiaCode).toBe("SelectNotApplied");
    expect(selectElement).toHaveBeenNthCalledWith(1, "FX233", "report.txt", "7", "ListItem", { hwnd: FORM });
    expect(clickElement).not.toHaveBeenCalled();
  });

  it("refuses to select without the native engine, rather than invoking through PowerShell", async () => {
    vi.doMock("../../src/engine/native-engine.js", async (orig) => ({ ...(await orig<object>()), nativeUia: null }));
    const { selectElement, SELECT_NEEDS_NATIVE } = await import("../../src/engine/uia-bridge.js");
    await expect(selectElement("FX233", "report.txt", "7", "ListItem")).rejects.toThrow(SELECT_NEEDS_NATIVE);
  });
});
