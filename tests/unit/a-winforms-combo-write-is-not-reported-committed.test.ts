/**
 * internal #238 — a type or setValue into a WinForms editable combo box is refused, not reported written.
 *
 * MEASURED win2 (2026-10-13, main `ae122bbc`, fixture FX238, 3/3): `desktop_act setValue` on a WinForms
 * editable ComboBox answered `ok:true` from `uia_set_value`, the text changed on screen, TextChanged never
 * fired, and the bound model stayed old at Save. The same for the Edit inside the combo, which discover
 * lists as a second textbox. A WinForms DropDownList (same window class, style CBS_DROPDOWNLIST) and a
 * TextBox reached their model through the same write, and stay on it.
 *
 * These cells pin the recognition (`winforms-combo.ts`, from the window's class, style bits and parent)
 * and the refusal before any write, on both roads, for both actions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";
import type { ComboWindowFacts } from "../../src/engine/winforms-combo.js";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

const FORM = 4919n;
const COMBO = 70001n;
const INNER_EDIT = 70002n;
const OTHER = 70003n;

const WF_COMBO_CLASS = "WindowsForms10.COMBOBOX.app.0.27a7bfc_r13_ad1";
const WS_CHILD_VISIBLE = 0x50000000;
const CBS_DROPDOWN = 0x2;
const CBS_DROPDOWNLIST = 0x3;
const CBS_SIMPLE = 0x1;

function entity(controlType: string, hwnd: bigint): UiEntity {
  return {
    entityId: `e${hwnd}`, role: "textbox", label: "A17 Combo", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "A17 Combo", automationId: "", via: "native", nativeWindowHandle: hwnd.toString(), nativeWindowHandleRead: "value" } },
    affordances: [{ verb: "type", executors: ["uia", "keyboard"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 300, y: 300, width: 200, height: 20 }, controlType,
    // What the registry gives a ValuePattern element (`registry.ts`): UIA first, the keyboard second.
    preferredExecutors: ["uia", "keyboard"],
    origin: { kind: "window", id: "FX238", hwnd: FORM.toString() },
  };
}

/** A window table the reader answers from; a handle not in it cannot be read. */
function facts(table: Record<string, ComboWindowFacts>) {
  return vi.fn((h: bigint) => table[h.toString()]);
}

const comboAs = (kind: number, className = WF_COMBO_CLASS): Record<string, ComboWindowFacts> => ({
  [COMBO.toString()]: { className, style: WS_CHILD_VISIBLE | kind, parent: FORM },
  [INNER_EDIT.toString()]: { className: "Edit", style: WS_CHILD_VISIBLE, parent: COMBO },
});

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => { throw new Error("the keyboard rung must not be reached"); }),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const titleRoad = { windowTitle: "FX238" };
const handleRoad: Aim = { kind: "aim", title: "FX238", hwnd: FORM };

async function write(target: typeof titleRoad | Aim, d: ExecutorDeps, e: UiEntity, action: "type" | "setValue") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(e, action, "M1 typed").then(
    (v) => ({ v, e: null as null | { name?: string; callerDetail?: string } }),
    (err: unknown) => ({ v: null, e: err as { name?: string; callerDetail?: string } }),
  );
}

describe("a WinForms editable combo box", () => {
  for (const [roadName, road] of [["title road", titleRoad], ["handle road", handleRoad]] as const) {
    for (const action of ["type", "setValue"] as const) {
      for (const [which, e] of [["the combo", entity("ComboBox", COMBO)], ["the Edit inside it", entity("Edit", INNER_EDIT)]] as const) {
        it(`is refused before any write — ${which}, ${action}, ${roadName}`, async () => {
          const d = deps({ comboWindowFacts: facts(comboAs(CBS_DROPDOWN)) });
          const { v, e: err } = await write(road, d, e, action);
          expect(v).toBeNull();
          expect(err?.name).toBe("WinFormsComboWriteRefusedError");
          expect(d.uiaSetValue).not.toHaveBeenCalled();
          expect(d.keyboardTypeBg).not.toHaveBeenCalled();
          expect(err?.callerDetail).toMatch(/^Nothing was written: "A17 Combo" is a WinForms combo box/);
          expect(err?.callerDetail).toContain("keyboard({action:'type', text})");
          if (roadName === "title road") {
            expect(err?.callerDetail).toContain("Click it — desktop_act(action:'click').");
            expect(err?.callerDetail).not.toContain("mouse_click");
          } else {
            // The point a caller can pass: discover shows `rect` only to debug calls (PR #815 codex P2).
            expect(err?.callerDetail).toContain("Click it with mouse_click({hwnd:'4919', x:400, y:310}), the centre of its rectangle");
          }
          expect(err?.callerDetail).toContain(action === "setValue" ? "Home then Shift+End" : "press keyboard End first");
          expect(err?.callerDetail).not.toMatch(/select[^.]*with keyboard ctrl\+a/);
        });
      }
    }
  }

  it("handle road, an entity without a rectangle: the advice says where to read the point, not a made-up one", async () => {
    const d = deps({ comboWindowFacts: facts(comboAs(CBS_DROPDOWN)) });
    const { rect: _rect, ...noRect } = entity("ComboBox", COMBO);
    const { e: err } = await write(handleRoad, d, noRect as UiEntity, "setValue");
    expect(err?.name).toBe("WinFormsComboWriteRefusedError");
    expect(err?.callerDetail).toContain("mouse_click({hwnd:'4919', x, y}) at its clickAt from screenshot({detail:'text', hwnd:'4919'})");
    expect(err?.callerDetail).not.toMatch(/x:\d/);
  });

  it("CBS_SIMPLE has an Edit too and is refused alike", async () => {
    const d = deps({ comboWindowFacts: facts(comboAs(CBS_SIMPLE)) });
    expect((await write(titleRoad, d, entity("ComboBox", COMBO), "setValue")).e?.name).toBe("WinFormsComboWriteRefusedError");
  });

  it("reaches the loop as executor_failed with the sentence as its detail", async () => {
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const e = entity("ComboBox", COMBO);
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const exec = createDesktopExecutor(titleRoad, deps({ comboWindowFacts: facts(comboAs(CBS_DROPDOWN)) }));
    const result = await new GuardedTouchLoop(store, {
      resolveLiveEntities: () => [e],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: (ent, a, t) => exec(ent, a, t),
      resolvePostTouchEntities: async () => [e],
    }).touch({ lease, action: "setValue", text: "M1 typed" });
    expect(result).toMatchObject({ ok: false, reason: "executor_failed", noRouteTried: true });
    expect((result as { detail?: string }).detail).toMatch(/UI Automation can change its text without the application seeing the change/);
  });
});

describe("CONTROL: what keeps the write it had", () => {
  const written = async (d: ExecutorDeps, e: UiEntity) => {
    const r = await write(titleRoad, d, e, "setValue");
    expect(r.e).toBeNull();
    expect(d.uiaSetValue).toHaveBeenCalledTimes(1);
  };

  it("a WinForms DropDownList (CBS_DROPDOWNLIST): its write was measured to reach the model", async () => {
    await written(deps({ comboWindowFacts: facts(comboAs(CBS_DROPDOWNLIST)) }), entity("ComboBox", COMBO));
  });

  it("a Win32 ComboBox (the Run dialog's class), not WinForms", async () => {
    await written(deps({ comboWindowFacts: facts(comboAs(CBS_DROPDOWN, "ComboBox")) }), entity("ComboBox", COMBO));
  });

  it("an Edit whose parent is not a combo box (a WinForms TextBox's own window, or a plain Edit)", async () => {
    const d = deps({ comboWindowFacts: facts({ [OTHER.toString()]: { className: "Edit", style: WS_CHILD_VISIBLE, parent: FORM }, [FORM.toString()]: { className: "WindowsForms10.Window.8.app.0.1", style: 0x16cf0000, parent: null } }) });
    await written(d, entity("Edit", OTHER));
  });

  it("a NumericUpDown that UI Automation reads as a ComboBox (#182's GOLF): its class is not COMBOBOX", async () => {
    const d = deps({ comboWindowFacts: facts({ [COMBO.toString()]: { className: "WindowsForms10.Window.8.app.0.1", style: WS_CHILD_VISIBLE, parent: FORM } }) });
    await written(d, entity("ComboBox", COMBO));
  });

  it("a window whose facts cannot be read (recreated since discover): fails open to the write it had", async () => {
    await written(deps({ comboWindowFacts: facts({}) }), entity("ComboBox", COMBO));
  });

  it("style bits that cannot be read: not this control", async () => {
    const d = deps({ comboWindowFacts: facts({ [COMBO.toString()]: { className: WF_COMBO_CLASS, style: null, parent: FORM } }) });
    await written(d, entity("ComboBox", COMBO));
  });

  it("an Edit whose parent cannot be read: not this control", async () => {
    const d = deps({ comboWindowFacts: facts({ [INNER_EDIT.toString()]: { className: "Edit", style: WS_CHILD_VISIBLE, parent: COMBO } }) });
    await written(d, entity("Edit", INNER_EDIT));
  });

  it("a class that only CONTAINS the WinForms name is not it — the match is anchored", async () => {
    const d = deps({ comboWindowFacts: facts(comboAs(CBS_DROPDOWN, "MyApp.WindowsForms10.COMBOBOX.app.0.1")) });
    await written(d, entity("ComboBox", COMBO));
  });

  it("no reader (a backend without it): the write it had", async () => {
    await written(deps(), entity("ComboBox", COMBO));
  });
});
