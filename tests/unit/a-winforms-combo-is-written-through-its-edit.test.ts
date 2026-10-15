/**
 * internal #238 step 2 — a type or setValue into a WinForms editable combo box is written through the
 * box's inner Edit, the way the application sees it, and read back.
 *
 * MEASURED win2 (2026-10-15, internal `dev/k238s2-measure`, `r238s2.md` and `r238s2-S.md`): the Edit
 * focused as `focus_first.rs` focuses a WinForms field, its text selected with EM_SETSEL(0,-1), then one
 * posted WM_CHAR per UTF-16 unit. The bound model took the asked text once the focus left, in front 3/3
 * and behind 3/3, with the window in front keeping the foreground; "a b 日本 😀" exact. An AutoComplete
 * that appends turned "ap" into "apple" 3/3. The user's decision (2026-10-15): a text that reads back
 * different is a failure that says what the box now holds.
 *
 * Step 1's refusal (`a-winforms-combo-write-is-not-reported-committed.test.ts`) is what a backend without
 * the combo write still answers; those cells give no `comboWrite`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComboWriteOutcome, ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";
import type { ComboWindowFacts } from "../../src/engine/winforms-combo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../src/engine/native-engine.js");
  vi.doUnmock("../../src/engine/uia-bridge.js");
});

const FORM = 4919n;
const COMBO = 70001n;
const INNER_EDIT = 70002n;
const WF_COMBO_CLASS = "WindowsForms10.COMBOBOX.app.0.27a7bfc_r13_ad1";
const WS_CHILD_VISIBLE = 0x50000000;
const CBS_DROPDOWN = 0x2;
const CBS_DROPDOWNLIST = 0x3;

function entity(controlType: string, hwnd: bigint): UiEntity {
  return {
    entityId: `e${hwnd}`, role: "textbox", label: "A17 Combo", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "A17 Combo", automationId: "", via: "native", nativeWindowHandle: hwnd.toString(), nativeWindowHandleRead: "value" } },
    affordances: [{ verb: "type", executors: ["uia", "keyboard"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 300, y: 300, width: 200, height: 20 }, controlType,
    preferredExecutors: ["uia", "keyboard"],
    origin: { kind: "window", id: "FX238", hwnd: FORM.toString() },
  };
}

const comboAs = (kind: number): Record<string, ComboWindowFacts> => ({
  [COMBO.toString()]: { className: WF_COMBO_CLASS, style: WS_CHILD_VISIBLE | kind, parent: FORM },
  [INNER_EDIT.toString()]: { className: "Edit", style: WS_CHILD_VISIBLE, parent: COMBO },
});

/** By default the write lands exactly: the text reads back as asked. */
function deps(over: Partial<ExecutorDeps> = {}, answer?: (value: string) => ComboWriteOutcome): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => { throw new Error("the keyboard rung must not be reached"); }),
    mouseClick: vi.fn(async () => {}),
    comboWindowFacts: vi.fn((h: bigint) => comboAs(CBS_DROPDOWN)[h.toString()]),
    comboWrite: vi.fn(async (_combo: bigint, value: string) =>
      answer ? answer(value) : { ok: true, focusedBy: "win32", posted: value.length, total: value.length, text: value }),
    ...over,
  };
}

const titleRoad = { windowTitle: "FX238" };
const handleRoad: Aim = { kind: "aim", title: "FX238", hwnd: FORM };

type Caught = { name?: string; callerDetail?: string; ground?: string; message?: string };

async function write(d: ExecutorDeps, e: UiEntity, text: string, action: "type" | "setValue" = "setValue", road: typeof titleRoad | Aim = titleRoad) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(road, d)(e, action, text).then(
    (v) => ({ v, e: null as null | Caught }),
    (err: unknown) => ({ v: null, e: err as Caught }),
  );
}

describe("the write", () => {
  for (const [roadName, road] of [["title road", titleRoad], ["handle road", handleRoad]] as const) {
    for (const action of ["type", "setValue"] as const) {
      for (const [which, e] of [["the combo", entity("ComboBox", COMBO)], ["the Edit inside it", entity("Edit", INNER_EDIT)]] as const) {
        it(`goes to the combo's own window, not through UI Automation — ${which}, ${action}, ${roadName}`, async () => {
          const d = deps();
          const { v, e: err } = await write(d, e, "new", action, road);
          expect(err).toBeNull();
          expect(v).toBe("keyboard");
          // With the window it was read in, which the combo must still belong to (gate 1 on #824).
          expect(d.comboWrite).toHaveBeenCalledWith(COMBO, "new", FORM);
          expect(d.uiaSetValue).not.toHaveBeenCalled();
          expect(d.keyboardTypeBg).not.toHaveBeenCalled();
        });
      }
    }
  }

  it("CONTROL: a DropDownList (same class) stays on the UI Automation write, measured to reach its model", async () => {
    const d = deps({ comboWindowFacts: vi.fn((h: bigint) => comboAs(CBS_DROPDOWNLIST)[h.toString()]) });
    await write(d, entity("ComboBox", COMBO), "List C");
    expect(d.uiaSetValue).toHaveBeenCalled();
    expect(d.comboWrite).not.toHaveBeenCalled();
  });

  it("with no window known (no handle, nothing recorded), asks no root rather than a guessed one", async () => {
    const d = deps();
    const { origin: _origin, ...noOrigin } = entity("ComboBox", COMBO);
    await write(d, noOrigin as UiEntity, "new");
    expect(d.comboWrite).toHaveBeenCalledWith(COMBO, "new", undefined);
  });

  it("CONTROL: without the backend, step 1's refusal stands", async () => {
    const d = deps({ comboWrite: undefined });
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("WinFormsComboWriteRefusedError");
    expect(d.uiaSetValue).not.toHaveBeenCalled();
  });
});

describe("the read-back", () => {
  it("a text that reads back different is a failure naming what the box now holds (AutoComplete, C4)", async () => {
    const d = deps({}, () => ({ ok: true, focusedBy: "win32", posted: 2, total: 2, text: "apple" }));
    const { v, e: err } = await write(d, entity("ComboBox", COMBO), "ap");
    expect(v).toBeNull();
    expect(err?.name).toBe("ValueNotAppliedError");
    expect(err?.callerDetail).toMatch(/now reads "apple", not the text asked for/);
    expect(err?.callerDetail).toMatch(/AutoComplete/);
  });

  it("a text read before the characters were seen processed does not say what the box holds now (win2 K5 on 6f24ef8a)", async () => {
    const d = deps({}, () => ({ ok: true, focusedBy: "win32", posted: 2, total: 2, text: "apple", processed: false }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "ap");
    expect(err?.name).toBe("ValueNotAppliedError");
    expect(err?.callerDetail).toMatch(/it read "apple" when checked/);
    expect(err?.callerDetail).toMatch(/Look at the box \(screenshot\) before setting it again/);
    expect(err?.callerDetail).not.toMatch(/now reads/);
  });

  it("never cuts a surrogate pair when it caps the value (gate 2)", async () => {
    const d = deps({}, () => ({ ok: true, posted: 1, total: 1, text: "a".repeat(119) + "😀😀" }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "y");
    expect(err?.callerDetail).toContain(`"${"a".repeat(119)}😀…"`);
    expect(err?.callerDetail).not.toMatch(/\\ud83d/i);
  });

  it("caps the value it repeats", async () => {
    const long = "x".repeat(500);
    const d = deps({}, () => ({ ok: true, posted: 1, total: 1, text: long }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "y");
    expect(err?.callerDetail).toContain(`"${"x".repeat(120)}…"`);
    expect((err?.callerDetail ?? "").length).toBeLessThan(1000);
  });

  it("a text that cannot be read back is a marked success, not a confirmed one", async () => {
    const d = deps({}, (value) => ({ ok: true, posted: value.length, total: value.length }));
    const { v } = await write(d, entity("ComboBox", COMBO), "new");
    expect(v).toEqual({ kind: "keyboard", landing: { confirmed: false, why: "text_unread", referenceFrom: "entity" } });
  });

  it("an empty write that reads back empty succeeds", async () => {
    const d = deps();
    expect((await write(d, entity("ComboBox", COMBO), "")).v).toBe("keyboard");
    expect(d.comboWrite).toHaveBeenCalledWith(COMBO, "", FORM);
  });
});

describe("refused before anything is typed", () => {
  for (const text of ["a\nb", "a\rb", "a\tb", "\u0007", "a\u0085b", "a\u2028b", "a\u2029b", "\u009f"]) {
    it(`a control character — ${JSON.stringify(text)}`, async () => {
      const d = deps();
      const { e: err } = await write(d, entity("ComboBox", COMBO), text);
      expect(err?.name).toBe("ComboTextNotTypableError");
      expect(err?.callerDetail).toMatch(/one-line combo box/);
      expect(d.comboWrite).not.toHaveBeenCalled();
    });
  }

  it("CONTROL: printable text beyond ASCII is typed (C3: \"a b 日本 😀\")", async () => {
    const d = deps();
    expect((await write(d, entity("ComboBox", COMBO), "a b 日本 😀")).v).toBe("keyboard");
  });

  it("an entity whose capabilities rule the keyboard out keeps step 1's refusal (ADR-020, gate 2)", async () => {
    for (const over of [{ preferredExecutors: ["uia"] }, { unsupportedExecutors: ["keyboard"] }] as Partial<UiEntity>[]) {
      const d = deps();
      const { e: err } = await write(d, { ...entity("ComboBox", COMBO), ...over }, "new");
      expect(err?.name).toBe("WinFormsComboWriteRefusedError");
      expect(d.comboWrite).not.toHaveBeenCalled();
    }
  });

  it("the disabled check is the engine's, which walks every container (gate 2): the executor asks no window of its own", async () => {
    const d = deps({ windowTakesInput: vi.fn(() => false) });
    await write(d, entity("ComboBox", COMBO), "new");
    expect(d.windowTakesInput).not.toHaveBeenCalled();
    expect(d.comboWrite).toHaveBeenCalled();
  });
});

describe("a write the backend could not make", () => {
  it("nothing posted: step 1's way to do it by hand", async () => {
    const d = deps({}, () => ({ ok: false, focusedBy: "failed", posted: 0, total: 3, code: "FocusFailed", error: "x" }));
    expect((await write(d, entity("ComboBox", COMBO), "new")).e?.name).toBe("WinFormsComboWriteRefusedError");
  });

  it("a window that stopped answering is refused as the value road refuses it, not sent to type by hand (gate 2)", async () => {
    const d = deps({}, () => ({ ok: false, posted: 0, total: 3, code: "NotAnswering", error: "Window is not answering" }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("AimedRouteFailedError");
    expect(err?.callerDetail).toMatch(/its window did not answer \(it may be busy\)/);
    expect(err?.callerDetail).not.toMatch(/UI Automation/);
  });

  it("the engine's own deadline stopped it before anything was posted: says nothing was typed (gate 2)", async () => {
    const d = deps({}, () => ({ ok: false, posted: 0, total: 3, code: "StoppedAnswering", error: "x" }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("AimedRouteFailedError");
    expect(err?.callerDetail).toMatch(/^Nothing was typed/);
    expect(err?.callerDetail).not.toMatch(/may still arrive/);
  });

  it("the act thread's limit passed during the write: the text may still arrive, so look first (gate 1 on #824)", async () => {
    const d = deps({}, () => ({ ok: false, posted: 0, total: 3, timedOut: true }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("AimedRouteFailedError");
    expect(err?.callerDetail).toMatch(/may still arrive/);
    expect(err?.callerDetail).toMatch(/so it is not typed twice/);
  });

  it("a box that is gone is not found, not 'do it by hand' (gate 2)", async () => {
    const d = deps({}, () => ({ ok: false, posted: 0, total: 0, code: "Gone", error: "x" }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("TargetGoneError");
    expect(err?.callerDetail).toMatch(/Re-run desktop_discover/);
  });

  it("a handle that now belongs to another window says so, not that the box is gone (gate 2)", async () => {
    const d = deps({}, () => ({ ok: false, posted: 0, total: 0, code: "Moved", error: "x" }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("TargetGoneError");
    expect(err?.callerDetail).toMatch(/now belongs to a control in another window/);
  });

  it("a box in a disabled container is refused as disabled (gate 2)", async () => {
    const d = deps({}, () => ({ ok: false, posted: 0, total: 0, code: "Disabled", error: "x" }));
    expect((await write(d, entity("ComboBox", COMBO), "new")).e).toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "disabled" });
  });

  it("a failure after the focus moved does not claim no route was tried (gate 2)", async () => {
    const after = deps({}, () => ({ ok: false, focusedBy: "win32", posted: 0, total: 3, code: "SelectFailed", error: "x" }));
    expect(((await write(after, entity("ComboBox", COMBO), "new")).e as { noRouteTried?: boolean }).noRouteTried).toBe(false);
    const before = deps({}, () => ({ ok: false, focusedBy: "failed", posted: 0, total: 3, code: "FocusFailed", error: "x" }));
    expect(((await write(before, entity("ComboBox", COMBO), "new")).e as { noRouteTried?: boolean }).noRouteTried).toBe(true);
  });

  it("part of the text posted: not reported written, and told to look before typing again", async () => {
    const d = deps({}, () => ({ ok: false, posted: 1, total: 3, code: "PostFailed", text: "n" }));
    const { e: err } = await write(d, entity("ComboBox", COMBO), "new");
    expect(err?.name).toBe("ValueNotAppliedError");
    expect(err?.callerDetail).toMatch(/so it is not typed twice/);
  });
});

describe("the production dep", () => {
  async function prodWrite(engine: unknown) {
    vi.doMock("../../src/engine/native-engine.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/native-engine.js")>()),
      nativeUia: engine,
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    return _realExecutorDepsForTest().comboWrite!(COMBO, "new", FORM);
  }

  it("hands the combo's handle and the text to the engine, and drops its nulls", async () => {
    const win32WriteCombo = vi.fn(async () => ({ ok: true, focusedBy: "win32", posted: 3, total: 3, text: "new", processed: true, error: null, code: null }));
    expect(await prodWrite({ win32WriteCombo })).toEqual({ ok: true, focusedBy: "win32", posted: 3, total: 3, text: "new", processed: true });
    expect(win32WriteCombo).toHaveBeenCalledWith(COMBO, "new", FORM);
  });

  it("an unread text stays unread (null is not an empty string)", async () => {
    const r = await prodWrite({ win32WriteCombo: vi.fn(async () => ({ ok: true, posted: 3, total: 3, text: null })) });
    expect(r).not.toHaveProperty("text");
  });

  it("refuses the key locker's windows before the engine is asked (gate 2)", async () => {
    const win32WriteCombo = vi.fn(async () => ({ ok: true, posted: 3, total: 3, text: "new" }));
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      refuseUiaHwndIfExcluded: vi.fn(() => { throw Object.assign(new Error("excluded"), { name: "WindowExcludedError" }); }),
    }));
    await expect(prodWrite({ win32WriteCombo })).rejects.toMatchObject({ name: "WindowExcludedError" });
    expect(win32WriteCombo).not.toHaveBeenCalled();
  });

  it("the act thread's limit is 'stopped answering', not a call that never ran (gate 1 on #824)", async () => {
    const win32WriteCombo = vi.fn(async () => { throw new Error("UIA operation timed out after 8000ms"); });
    expect(await prodWrite({ win32WriteCombo })).toMatchObject({ ok: false, timedOut: true });
  });

  it("CONTROL: another throw never reached the window", async () => {
    const win32WriteCombo = vi.fn(async () => { throw new Error("UIA COM thread unavailable"); });
    const r = await prodWrite({ win32WriteCombo });
    expect(r).toMatchObject({ ok: false, posted: 0 });
    expect(r).not.toHaveProperty("timedOut");
  });

  it("without the engine, nothing is posted", async () => {
    expect(await prodWrite(null)).toMatchObject({ ok: false, posted: 0 });
  });
});
