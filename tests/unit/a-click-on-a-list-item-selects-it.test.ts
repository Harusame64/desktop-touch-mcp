/**
 * internal #233 — a `desktop_act` click on a collection item selects it; it does not invoke it.
 *
 * MEASURED win2 (2026-10-13, internal #233 comments): UI Automation's Invoke on a ListItem acts as a
 * double-click — Explorer opened the file, a SysListView32 sent NM_DBLCLK, a Win32 LISTBOX LBN_DBLCLK, a
 * WinForms ListBox fired DoubleClick — and a WinForms ListView's Invoke did nothing and reported ok.
 * SelectionItem.Select selected on every provider, with zero DBLCLK. The user's decision: a click on a
 * ListItem, DataItem or TreeItem selects it; `action:"invoke"` keeps Invoke.
 *
 * Round 2 (win2, issuecomment-6145660788 and after): Select on a tree with nothing selected changes the
 * selection twice, and a DataGridView cell (a DataItem with no SelectionItem) starts editing on Invoke;
 * a real single click selects either once, 3/3. So a tree item, and an item the engine cannot select,
 * are clicked with the checked single mouse click a mouse-first item gets, on both roads (round 3: win2
 * G1–G8 found the handle road clicked mouse-first items and refused these).
 * Chromium's content keeps Invoke, which selects there (`<select size=5>`: `change`, no dblclick).
 *
 * These cells pin the dispatch on both roads, the single click and its refusal, the refusals with
 * nothing pressed, the route's `why`, the production dep's mapping, the bridge without the engine, the
 * advice by the refusal's class, and the loop through to the envelope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { EntityLease, UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";

// The real nut.js binding needs libXtst on Linux runners; the executor's graph imports it (PR #819 codex P1).
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { click: vi.fn(), doubleClick: vi.fn(), setPosition: vi.fn(), pressButton: vi.fn(), releaseButton: vi.fn(), drag: vi.fn(), config: { mouseSpeed: 1000 } },
  keyboard: { pressKey: vi.fn(), releaseKey: vi.fn(), type: vi.fn() },
  Button: { LEFT: "left", RIGHT: "right", MIDDLE: "middle" },
  Point: vi.fn((x: number, y: number) => ({ x, y })),
  straightTo: vi.fn((p: unknown) => p),
  DEFAULT_MOUSE_SPEED: 1000,
}));

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

/** `origin` without a handle unless asked: the title road's single click is then not checked against a window. */
function entity(controlType: string, originHwnd?: bigint): UiEntity {
  return {
    entityId: `e-${controlType}`, role: "listitem", label: "report.txt", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "report.txt", automationId: "7", via: "native" } },
    affordances: [{ verb: "read", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 300, y: 300, width: 200, height: 20 }, controlType,
    // What discover reads on an item the UIA road takes (`registry.ts`: Invoke puts UIA first).
    patterns: ["InvokePattern", "SelectionItemPattern"],
    // What the registry gives an element with InvokePattern (`registry.ts`): UIA first, the mouse second.
    preferredExecutors: ["uia", "mouse"],
    origin: { kind: "window", id: "FX233", ...(originHwnd !== undefined && { hwnd: originHwnd.toString() }) },
  };
}

/** A DataGridView cell as discover reads it (win2, 2026-10-13): Invoke and Value, no SelectionItem. */
function cell(originHwnd?: bigint): UiEntity {
  return { ...entity("DataItem", originHwnd), patterns: ["InvokePattern", "ValuePattern"] };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSelect: vi.fn(async () => ({ focusedBy: "win32_list", selected: true, notified: true })),
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

type Refusal = { name?: string; callerDetail?: string; noRouteTried?: true; adviceClass?: string };

async function act(target: typeof titleRoad | Aim, d: ExecutorDeps, e: UiEntity, action: "click" | "invoke") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(e, action).then(
    (v) => ({ v, e: null as null | Refusal }),
    (err: unknown) => ({ v: null, e: err as Refusal }),
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

const NO_SELECTION_ITEM = () => engineSays("SelectionItemPattern not supported by this element", "PatternNotSupported");
const TREE = () => engineSays("This item is selected with a single mouse click", "MouseClickNeeded");

describe("a click on a collection item", () => {
  for (const [roadName, road] of roads) {
    for (const controlType of ["ListItem", "DataItem", "TreeItem"]) {
      it(`asks the engine to select a ${controlType} and never invokes it — ${roadName}`, async () => {
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

    it(`says on its route row that it was a select, and whether the list box was told — ${roadName}`, async () => {
      await act(road, deps(), entity("ListItem"), "click");
      const rows = routeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ route: "uia", why: "uia_select", focusedBy: "win32_list", notified: true });
      expect(rows[0]!.addressedWindowBy).toBe(roadName === "handle road" ? "handle" : "title");
    });

    it(`reports a Chromium item the engine invoked as main did: uia_invoke, nothing else pressed — ${roadName}`, async () => {
      // The engine answers ok without `selected` when it invoked (Chromium's content, `actions.rs`).
      const d = deps({ uiaSelect: vi.fn(async () => ({ focusedBy: "kept_behind" })) });
      const { v, e: err } = await act(road, d, entity("ListItem"), "click");
      expect(err).toBeNull();
      expect(v).toBe("uia");
      expect(routeRows()[0]).toMatchObject({ route: "uia", why: "uia_invoke", notified: null });
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
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

    it(`refuses a select that did not take, saying nothing changed — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("The item was not selected", "SelectNotApplied") });
      const { v, e: err } = await act(road, d, entity("DataItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.adviceClass).toBe("collection_item_select");
      expect(err?.noRouteTried).toBeUndefined();
      expect(err?.callerDetail).toMatch(/^Nothing was pressed, and the item was not selected: /);
      // The focus step ran before the select (PR #819 codex P2): the detail must not claim nothing changed.
      expect(err?.callerDetail).not.toContain("nothing changed");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
      expect(routeRows().at(-1)).toMatchObject({ route: "refusal", rung: "uia_select", refused: "executor_failed", selectRefused: "not_selected" });
    });

    it(`a select whose read-back FAILED is not "nothing changed": it may be selected — ${roadName}`, async () => {
      // PR #819 codex P2: a failed IsSelected read after a successful Select was reported as a read of false.
      const d = deps({ uiaSelect: engineSays("The select was sent, and whether the item is selected could not be read: 0x80040201", "SelectOutcomeUnknown") });
      const { v, e: err } = await act(road, d, entity("ListItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.callerDetail).not.toMatch(/^Nothing was pressed/);
      expect(err?.callerDetail).toContain("it may be selected");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
      expect(routeRows().at(-1)).toMatchObject({ route: "refusal", rung: "uia_select", refused: "executor_failed", selectRefused: "outcome_unknown" });
    });

    it(`refuses a select that failed any other way, pressing nothing — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("Select failed: 0x80040201") });
      const { v, e: err } = await act(road, d, entity("ListItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.callerDetail).toMatch(/^Nothing was pressed: selecting "report\.txt" through UI Automation failed, and the act was not finished as a press\./);
      // The backend's own text is not the caller's (ADR-036 item 13).
      expect(err?.callerDetail).not.toContain("0x80040201");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });

    it(`refuses a select whose window stopped answering without saying nothing was pressed — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("Window stopped answering during the act") });
      const { e: err } = await act(road, d, entity("ListItem"), "click");
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      // The select may land when the window answers: "Nothing was pressed" would read as nothing done.
      expect(err?.callerDetail).not.toMatch(/^Nothing was/);
      // Neutral: on Chromium's content the engine invoked, so "select" would be wrong (opus on PR #819, P2-1).
      expect(err?.callerDetail).toMatch(/^The click on "report\.txt" was sent, .* it may have taken effect, or take effect when the window answers\./);
      expect(err?.callerDetail).not.toMatch(/select/i);
      expect(err?.callerDetail).toContain("do not press it again (click_element included)");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });

    it(`refuses a Chromium Invoke that failed after the call, saying it may have pressed — ${roadName}`, async () => {
      // What the production dep throws when the engine invoked (FrameworkId Chrome, no `selected` in the
      // answer) and the press failed after it was made (`mod.rs::PRESS_OUTCOME_UNKNOWN`, code None).
      const d = deps({ uiaSelect: engineSays("The press call failed after it was made; it may have taken effect") });
      const { v, e: err } = await act(road, d, entity("ListItem"), "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.callerDetail).not.toMatch(/^Nothing was/);
      expect(err?.callerDetail).toMatch(/^The click on "report\.txt" was sent as a UI Automation press, which failed after the call was made: it may have taken effect\./);
      expect(err?.callerDetail).toContain("do not press it again (click_element included)");
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
      expect(routeRows().at(-1)).toMatchObject({ route: "refusal", rung: "uia_select", selectRefused: "press_unknown", routeFailure: "press_outcome_unknown" });
    });

    it(`refuses a single-click item with no rectangle in its own words and advice — ${roadName}`, async () => {
      const d = deps({ uiaSelect: NO_SELECTION_ITEM() });
      const { rect: _rect, ...noRect } = cell();
      const { v, e: err } = await act(road, d, noRect as UiEntity, "click");
      expect(v).toBeNull();
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.adviceClass).toBe("collection_item_select");
      expect(err?.callerDetail).toMatch(/^Nothing was pressed: "report\.txt" is selected with a single mouse click, and discover recorded no rectangle to click\./);
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });

    it(`says the engine is missing when it is — ${roadName}`, async () => {
      const d = deps({ uiaSelect: engineSays("Selecting an item needs the native UI Automation engine, which is unavailable", "NativeEngineUnavailable") });
      const { e: err } = await act(road, d, entity("ListItem"), "click");
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.callerDetail).toMatch(/^Nothing was pressed: selecting "report\.txt" needs the native UI Automation engine, which is unavailable/);
      expect(d.uiaClick).not.toHaveBeenCalled();
      expect(d.mouseClick).not.toHaveBeenCalled();
    });

    it(`keeps the window's own refusals, with a select row — ${roadName}`, async () => {
      const { WindowExcludedError } = await import("../../src/engine/tool-exclusion.js");
      const { AimedWindowGoneError } = await import("../../src/engine/aim.js");
      for (const [refused, make] of [
        ["window_excluded", () => new WindowExcludedError("FX233", "secure")],
        ["aim_window_gone", () => new AimedWindowGoneError(FORM, "gone")],
      ] as const) {
        const d = deps({ uiaSelect: vi.fn(async () => { throw make(); }) });
        const { e: err } = await act(road, d, entity("ListItem"), "click");
        expect(err?.name, refused).toBe(refused === "window_excluded" ? "WindowExcludedError" : "AimedWindowGoneError");
        expect(routeRows().at(-1), refused).toMatchObject({ route: "refusal", rung: "uia_select", refused });
        expect(d.uiaClick).not.toHaveBeenCalled();
        expect(d.mouseClick).not.toHaveBeenCalled();
      }
    });
  }
});

describe("an item clicked as a single mouse click (a tree item, or one the engine cannot select)", () => {
  // The window the press is checked against: the call's handle, or the one the entity was read in.
  const RECT_OK = { x: 0, y: 0, width: 1000, height: 1000 };
  for (const [why, uiaSelect, controlType] of [["a .NET 10 parent node with Invoke", TREE, "TreeItem"], ["no SelectionItem (a DataGridView cell)", NO_SELECTION_ITEM, "DataItem"]] as const) {
    for (const [roadName, road] of roads) {
      it(`is clicked once at its centre through the checked mouse road, never invoked — ${why}, ${roadName}`, async () => {
        const d = deps({ uiaSelect: uiaSelect(), aimRect: vi.fn(async () => RECT_OK), pointOwner: vi.fn(() => ({ kind: "aim" as const, via: "os_hit_test" as const })) });
        const { v, e: err } = await act(road, d, controlType === "DataItem" ? cell(FORM) : entity(controlType, FORM), "click");
        expect(err).toBeNull();
        // The mouse-first road's answer: no downgrade, because nothing failed.
        expect(v).toBe("mouse");
        expect(d.mouseClick).toHaveBeenCalledTimes(1);
        expect(d.mouseClick).toHaveBeenCalledWith(400, 310);
        expect(d.uiaClick).not.toHaveBeenCalled();
        // The same checks a mouse-first item gets, against the aimed (or read-in) window.
        expect(d.aimRect).toHaveBeenCalledWith(FORM);
        expect(d.pointOwner).toHaveBeenCalled();
        expect(routeRows().find((r) => r.route === "mouse")).toMatchObject({
          why: "collection_item_single_click",
          singleClick: controlType === "TreeItem" ? "tree_item" : "no_selection_item",
          coordHwnd: FORM.toString(),
        });
      });

      it(`is refused, pressing nothing, when another window takes the point — ${why}, ${roadName}`, async () => {
        const d = deps({
          uiaSelect: uiaSelect(),
          aimRect: vi.fn(async () => RECT_OK),
          pointOwner: vi.fn(() => ({ kind: "other" as const, hwnd: 777n, title: "Over it", via: "os_hit_test" as const })),
        });
        const { v, e: err } = await act(road, d, controlType === "DataItem" ? cell(FORM) : entity(controlType, FORM), "click");
        expect(v).toBeNull();
        expect(err?.name).toBe("AimOccludedError");
        expect(d.mouseClick).not.toHaveBeenCalled();
        expect(d.uiaClick).not.toHaveBeenCalled();
      });

      it(`is refused, pressing nothing, when the point is outside the window — ${why}, ${roadName}`, async () => {
        const d = deps({ uiaSelect: uiaSelect(), aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 100, height: 100 })) });
        const { v, e: err } = await act(road, d, controlType === "DataItem" ? cell(FORM) : entity(controlType, FORM), "click");
        expect(v).toBeNull();
        expect(err?.name).toBe("AimedPointOutsideWindowError");
        expect(d.mouseClick).not.toHaveBeenCalled();
        expect(d.uiaClick).not.toHaveBeenCalled();
      });
    }
  }

  it("is clicked even when the registry did not list the mouse (a ValuePattern cell is uia + keyboard)", async () => {
    // A ReadOnly-like cell: no Invoke, no SelectionItem; before this PR its click was the UIA downgrade.
    const d = deps({ uiaSelect: NO_SELECTION_ITEM() });
    const e: UiEntity = { ...entity("DataItem"), preferredExecutors: ["uia", "keyboard"], patterns: ["ValuePattern"] };
    const { v, e: err } = await act(titleRoad, d, e, "click");
    expect(err).toBeNull();
    expect(v).toBe("mouse");
    expect(d.mouseClick).toHaveBeenCalledTimes(1);
  });

  it("an item discover read WITH SelectionItem that now answers 'not supported' is refused, not clicked at its old point (PR #819 codex P1)", async () => {
    const d = deps({ uiaSelect: NO_SELECTION_ITEM() });
    const { v, e: err } = await act(titleRoad, d, entity("ListItem"), "click");
    expect(v).toBeNull();
    expect(err?.name).toBe("CollectionItemSelectRefusedError");
    expect(err?.callerDetail).toMatch(/^Nothing was pressed/);
    expect(d.mouseClick).not.toHaveBeenCalled();
    expect(d.uiaClick).not.toHaveBeenCalled();
  });

  it("without the native engine, a tree item still takes the checked single click (PR #819 codex P2)", async () => {
    const d = deps({ uiaSelect: engineSays("Selecting needs the native engine", "NativeEngineUnavailable") });
    const { v, e: err } = await act(titleRoad, d, entity("TreeItem"), "click");
    expect(err).toBeNull();
    expect(v).toBe("mouse");
    expect(d.mouseClick).toHaveBeenCalledTimes(1);
    expect(d.uiaClick).not.toHaveBeenCalled();
  });

  it("CONTROL: without the native engine, a list item is still refused (its select cannot be made)", async () => {
    const d = deps({ uiaSelect: engineSays("Selecting needs the native engine", "NativeEngineUnavailable") });
    const { v, e: err } = await act(titleRoad, d, entity("ListItem"), "click");
    expect(v).toBeNull();
    expect(err?.name).toBe("CollectionItemSelectRefusedError");
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("an item found gone at the act is entity_not_found's TargetGoneError, nothing pressed (win2 J2)", async () => {
    const d = deps({ uiaSelect: engineSays("Element not found") });
    const { v, e: err } = await act(titleRoad, d, entity("ListItem"), "click");
    expect(v).toBeNull();
    expect(err?.name).toBe("TargetGoneError");
    expect(err?.callerDetail).toContain("nothing was pressed");
    expect(d.mouseClick).not.toHaveBeenCalled();
    expect(d.uiaClick).not.toHaveBeenCalled();
  });

  it("is not clicked when the mouse is ruled out for the item", async () => {
    const d = deps({ uiaSelect: NO_SELECTION_ITEM() });
    const e: UiEntity = { ...cell(), unsupportedExecutors: ["mouse"] };
    const { v } = await act(titleRoad, d, e, "click");
    expect(v).toBeNull();
    expect(d.mouseClick).not.toHaveBeenCalled();
    expect(d.uiaClick).not.toHaveBeenCalled();
  });

  it("a ListItem the registry routes to the mouse (WPF, no UIA road) still takes the mouse road", async () => {
    const d = deps();
    const e: UiEntity = { ...entity("ListItem"), preferredExecutors: ["mouse"], unsupportedExecutors: ["uia"] };
    const { v } = await act(titleRoad, d, e, "click");
    expect(v).toBe("mouse");
    expect(d.mouseClick).toHaveBeenCalledTimes(1);
    expect(d.uiaSelect).not.toHaveBeenCalled();
    expect(d.uiaClick).not.toHaveBeenCalled();
  });
});

describe("Chromium's content keeps Invoke in the engine", () => {
  const rust = () => readFileSync(fileURLToPath(new URL("../../src/uia/actions.rs", import.meta.url)), "utf8");

  it("reads the framework before selecting, and leaves Chrome to the Invoke below (src/uia/actions.rs)", () => {
    // No Windows here to run the engine: the branch is pinned in its source, where the cell can see it.
    const src = rust();
    const impl = src.slice(src.indexOf("fn click_element_impl("), src.indexOf("// Try InvokePattern"));
    expect(impl).toMatch(/if opts\.select == Some\(true\) \{\s+let framework = unsafe \{ elem\.CurrentFrameworkId\(\) \}[^;]*;\s+if framework != "Chrome" \{\s+return Ok\(select_item\(ctx, &elem\)\);/);
  });

  it("and a tree item is not selected there (MouseClickNeeded), before any pattern is asked for", () => {
    const src = rust();
    const body = src.slice(src.indexOf("fn select_item("), src.indexOf("fn select_item(") + 2000);
    expect(body.indexOf("UIA_TreeItemControlTypeId")).toBeGreaterThan(0);
    expect(body.indexOf("UIA_TreeItemControlTypeId")).toBeLessThan(body.indexOf("UIA_SelectionItemPatternId"));
    // The guard itself, returned before Select: a weakened condition keeps the names and loses the branch.
    expect(body).toMatch(/let is_tree_item = elem\.CurrentControlType\(\)\.map\(\|t\| t\.0 == UIA_TreeItemControlTypeId\.0\)\.unwrap_or\(false\);\s+if is_tree_item \{\s+return ActionResult \{[^}]*code: Some\(MOUSE_CLICK_NEEDED\.into\(\)\)/);
  });
});

describe("the production select dep and its bridge", () => {
  it("carries the engine's code on the error, maps a gone window, and never falls back to the click", async () => {
    const clickElement = vi.fn(async () => ({ ok: true }));
    const answers = [
      { ok: false, error: "SelectionItemPattern not supported by this element", code: "PatternNotSupported", via: "native" as const },
      { ok: false, error: "The item was not selected", code: "SelectNotApplied", via: "native" as const },
      { ok: false, error: "the window is gone", code: "aim_window_gone", via: "native" as const },
      { ok: true, via: "native" as const, focusedBy: "win32_list", selected: true, notified: false },
    ];
    const selectElement = vi.fn(async () => answers.shift()!);
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({ ...(await orig<object>()), selectElement, clickElement }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    const { AimedWindowGoneError } = await import("../../src/engine/aim.js");
    const d = _realExecutorDepsForTest();
    const first = await d.uiaSelect("FX233", "report.txt", "7", "ListItem", FORM).then(() => null, (e: unknown) => e as { uiaCode?: string });
    const second = await d.uiaSelect("FX233", "report.txt", "7", "ListItem").then(() => null, (e: unknown) => e as { uiaCode?: string });
    const third = await d.uiaSelect("FX233", "report.txt", "7", "ListItem", FORM).then(() => null, (e: unknown) => e);
    const fourth = await d.uiaSelect("FX233", "report.txt", "7", "ListItem");
    expect(first?.uiaCode).toBe("PatternNotSupported");
    expect(second?.uiaCode).toBe("SelectNotApplied");
    expect(third).toBeInstanceOf(AimedWindowGoneError);
    expect(fourth).toEqual({ focusedBy: "win32_list", selected: true, notified: false });
    expect(selectElement).toHaveBeenNthCalledWith(1, "FX233", "report.txt", "7", "ListItem", { hwnd: FORM });
    expect(clickElement).not.toHaveBeenCalled();
  });

  it("refuses to select without the native engine, rather than invoking through PowerShell, and says why", async () => {
    vi.doMock("../../src/engine/native-engine.js", async (orig) => ({ ...(await orig<object>()), nativeUia: null }));
    const { selectElement, SELECT_NEEDS_NATIVE } = await import("../../src/engine/uia-bridge.js");
    const err = await selectElement("FX233", "report.txt", "7", "ListItem").then(() => null, (e: unknown) => e as Error & { uiaCode?: string });
    expect(err?.message).toBe(SELECT_NEEDS_NATIVE);
    expect(err?.uiaCode).toBe("NativeEngineUnavailable");
  });
});

describe("through the loop to the envelope", () => {
  const ADVICE = [
    "Follow detail: it says what was and was not done to this item, and what to do instead",
    "To open or run the item rather than select it, use desktop_act(action:'invoke')",
    "Re-run desktop_discover and act on a fresh lease — the item may have moved, changed or gone since it was read",
  ];

  async function touch(d: ExecutorDeps, action?: "click") {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const e = entity("ListItem");
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const exec = createDesktopExecutor(titleRoad, d);
    return new GuardedTouchLoop(store, {
      resolveLiveEntities: () => [e],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: (en, a, text) => exec(en, a, text),
      resolvePostTouchEntities: async () => [e],
    }).touch({ lease, ...(action !== undefined && { action }) });
  }

  it("resolves an omitted action to the select (a ListItem advertises no verb, so auto is click)", async () => {
    const d = deps();
    const result = await touch(d);
    expect(result).toMatchObject({ ok: true, executor: "uia" });
    expect(d.uiaSelect).toHaveBeenCalledTimes(1);
    expect(d.uiaClick).not.toHaveBeenCalled();
  });

  for (const action of [undefined, "click"] as const) {
    it(`gives a refused select its own advice, never click_element or mouse_click — action ${String(action)}`, async () => {
      const d = deps({ uiaSelect: engineSays("The item was not selected", "SelectNotApplied") });
      const result = await touch(d, action);
      expect(result).toMatchObject({ ok: false, reason: "executor_failed", adviceClass: "collection_item_select" });
      const detail = (result as { detail?: string }).detail;
      expect(detail).toMatch(/^Nothing was pressed, and the item was not selected: /);

      const { getDesktopFacade, desktopActRawHandler } = await import("../../src/tools/desktop-register.js");
      vi.spyOn(getDesktopFacade(), "touch").mockResolvedValue(result);
      const lease: EntityLease = { entityId: "e-ListItem", viewId: "v1", targetGeneration: "gen-1", expiresAtMs: Number.MAX_SAFE_INTEGER, evidenceDigest: "d" };
      const reply = await desktopActRawHandler({ lease, ...(action !== undefined && { action }) });
      const parsed = JSON.parse((reply.content[0] as { text: string }).text) as Record<string, unknown>;
      expect(parsed["reason"]).toBe("executor_failed");
      const ifUnexpected = parsed["if_unexpected"] as { detail?: string; try_next?: Array<{ action: string }> };
      expect(ifUnexpected.detail).toBe(detail);
      const tryNext = (ifUnexpected.try_next ?? []).map((r) => r.action);
      expect(tryNext).toEqual(ADVICE);
      for (const line of tryNext) expect(line).not.toMatch(/click_element|mouse_click|Nothing was typed/);
    });
  }
});

describe("an item with no Invoke is not sent to one", () => {
  for (const [kind, uiaSelect] of [
    ["not_selected", () => engineSays("The item was not selected", "SelectNotApplied")],
    ["no_engine", () => engineSays("Selecting an item needs the native UI Automation engine, which is unavailable", "NativeEngineUnavailable")],
    ["failed", () => engineSays("Select failed: 0x80040201")],
  ] as const) {
    it(`says it has none, in detail and advice — ${kind}`, async () => {
      // A ReadOnly-like item: discover read a SelectionItem and a Value, no Invoke.
      const e: UiEntity = { ...entity("DataItem"), patterns: ["SelectionItemPattern", "ValuePattern"] };
      const { e: err } = await act(titleRoad, deps({ uiaSelect: uiaSelect() }), e, "click");
      expect(err?.name).toBe("CollectionItemSelectRefusedError");
      expect(err?.adviceClass).toBe("collection_item_select_no_invoke");
      expect(err?.callerDetail).not.toMatch(/its Invoke|action:'invoke'/);
      expect(err?.callerDetail).toContain("It has no UI Automation Invoke to open it with.");
      const { executorFailedAdviceFor } = await import("../../src/tools/_errors.js");
      const lines = executorFailedAdviceFor("click", false, "collection_item_select_no_invoke");
      expect(lines[0]).toMatch(/^Follow detail/);
      for (const line of lines) expect(line).not.toMatch(/invoke|click_element|mouse_click/i);
    });
  }
});

describe("the advice chooses by the refusal's class, not the action", () => {
  it("answers collection_item_select with its own list whatever the action", async () => {
    const { executorFailedAdviceFor } = await import("../../src/tools/_errors.js");
    for (const action of [undefined, "auto", "click", "invoke", "type"]) {
      for (const noRouteTried of [false, true]) {
        const lines = executorFailedAdviceFor(action, noRouteTried, "collection_item_select");
        expect(lines[0], String(action)).toMatch(/^Follow detail/);
        for (const line of lines) expect(line).not.toMatch(/click_element|mouse_click|Nothing was typed/);
      }
    }
  });
});
