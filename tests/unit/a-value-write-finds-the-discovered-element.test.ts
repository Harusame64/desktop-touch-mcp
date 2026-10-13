/**
 * internal #289 — a value write goes to the element discover read, not to the first whose name
 * contains its name.
 *
 * MEASURED win2 (2026-10-14, main `935c27c9`, fixture FX289, 3/3 each): with no AutomationId, a
 * `desktop_act setValue` on "Name" wrote into an earlier "Display Name" and answered `ok:true`, on
 * WinForms (.NET 10) and WPF, and on the handle road too; a second field also named "Name" took the
 * first one's write. discover's `locator.uia.name` matched the native Name byte for byte, every
 * WinForms control carried its own handle, and no WPF control did.
 *
 * The choice of element is made in the native writer (`src/uia/actions.rs::find_value_target`): the
 * element's own handle first, then the exact name with the type, then the rect among several. These
 * cells pin what reaches it: the executor builds the address from the entity, the production dep hands
 * it to the bridge, and the bridge gives the engine the fields — `exactName` only for a name the
 * native client read itself.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../src/engine/uia-bridge.js");
  vi.doUnmock("../../src/engine/native-engine.js");
});

const RECT = { x: 330, y: 235, width: 200, height: 23 };

function field(uia: NonNullable<UiEntity["locator"]>["uia"], over: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "name", role: "textbox", label: "Name", confidence: 0.9, sources: ["uia"],
    locator: { uia },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
    ...over,
  };
}

function deps(): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
  };
}

async function addressFor(entity: UiEntity) {
  const d = deps();
  await createDesktopExecutor({ windowTitle: "FX289" }, d)(entity, "setValue", "N1");
  const calls = (d.uiaSetValue as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![5];
}

describe("#289 — the executor carries what discover read", () => {
  it("a WinForms box: its own handle, its type, its rect, and a name the native client read", async () => {
    const address = await addressFor(field({ name: "Name", via: "native", nativeWindowHandle: "1312", nativeWindowHandleRead: "value" }));
    expect(address).toEqual({ elementHwnd: "1312", controlType: "Edit", rect: RECT, nameReadBy: "native" });
  });

  it("a WPF box has no handle of its own, and the rest still goes", async () => {
    const address = await addressFor(field({ name: "Name", via: "native", nativeWindowHandleRead: "zero" }));
    expect(address).toEqual({ controlType: "Edit", rect: RECT, nameReadBy: "native" });
  });

  it("a name the read did not give (the label stands in) is not marked as the read's own", async () => {
    const address = await addressFor(field({ via: "native" }));
    expect(address).toEqual({ controlType: "Edit", rect: RECT });
  });

  it("the client that read the name is named, so the bridge can tell whether it is the writer", async () => {
    const address = await addressFor(field({ name: "Name", via: "powershell" }));
    expect(address).toEqual({ controlType: "Edit", rect: RECT, nameReadBy: "powershell" });
  });
});

describe("#289 — the production dep hands the address to the bridge", () => {
  it("beside the handle, unchanged", async () => {
    const setElementValue = vi.fn(async () => ({ ok: true }));
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue,
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    const address = { elementHwnd: "1312", controlType: "Edit", rect: RECT, nameReadBy: "native" as const };
    await _realExecutorDepsForTest().uiaSetValue("FX289", "N1", "Name", undefined, 4919n, address);
    expect(setElementValue).toHaveBeenCalledWith("FX289", "N1", "Name", undefined, { hwnd: 4919n, address });
  });
});

describe("#289 — the bridge gives the engine its fields", () => {
  async function engineSees(address: Parameters<typeof import("../../src/engine/uia-bridge.js").setElementValue>[4]) {
    const uiaSetValue = vi.fn(async () => ({ ok: true }));
    vi.doMock("../../src/engine/native-engine.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/native-engine.js")>()),
      nativeUia: { uiaSetValue },
    }));
    const { setElementValue } = await import("../../src/engine/uia-bridge.js");
    await setElementValue("FX289", "N1", "Name", undefined, address);
    expect(uiaSetValue).toHaveBeenCalledTimes(1);
    return (uiaSetValue.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  }

  it("a name the native client read is compared whole, with the type", async () => {
    const opts = await engineSees({ address: { elementHwnd: "1312", controlType: "Edit", rect: RECT, nameReadBy: "native" } });
    expect(opts).toMatchObject({ name: "Name", elementHwnd: "1312", controlType: "Edit", exactName: true, rect: RECT });
  });

  it("CONTROL: a name the managed client read is not — its words and types can differ from the engine's", async () => {
    const opts = await engineSees({ address: { elementHwnd: "1312", controlType: "Edit", rect: RECT, nameReadBy: "powershell" } });
    expect(opts).not.toHaveProperty("exactName");
    // The handle is the same window whichever client read it.
    expect(opts).toMatchObject({ elementHwnd: "1312", controlType: "Edit" });
  });

  it("without a type there is no exact match to make", async () => {
    const opts = await engineSees({ address: { nameReadBy: "native" } });
    expect(opts).not.toHaveProperty("exactName");
  });

  it("a fractional rect reaches the engine in whole pixels, and an unusable one not at all", async () => {
    const whole = await engineSees({ address: { rect: { x: 10.4, y: 20.6, width: 99.5, height: 23 } } });
    expect(whole.rect).toEqual({ x: 10, y: 21, width: 100, height: 23 });
    vi.resetModules();
    const none = await engineSees({ address: { rect: { x: Number.NaN, y: 0, width: 1, height: 1 } } });
    expect(none).not.toHaveProperty("rect");
  });

  it("CONTROL: a call with no address (V1 set_element_value) sends none of the fields", async () => {
    const opts = await engineSees(undefined);
    for (const k of ["elementHwnd", "controlType", "exactName", "rect"]) expect(opts).not.toHaveProperty(k);
  });
});

describe("#289 — an ambiguity is refused, not typed and not guessed", () => {
  // Gate 2 on `fe26cec7` and PR codex on `44476ac2` named the two wrong answers: as "not found", the
  // keyboard rung typed into a windowless field's focus holder on the handle road; as the first match,
  // the pattern wrote a sibling under `ok:true`. The engine answers `ElementAmbiguous` instead.
  async function ambiguous() {
    const { ELEMENT_AMBIGUOUS } = await import("../../src/engine/aim.js");
    return vi.fn(async () => {
      throw Object.assign(new Error("Two or more elements have this element's exact name and type, and its rect does not tell them apart"), { uiaCode: ELEMENT_AMBIGUOUS, uiaVia: "native" });
    });
  }

  it("on the handle road, a windowless field: refused before the keyboard rung, nothing typed", async () => {
    const d = deps();
    d.uiaSetValue = await ambiguous();
    const exec = createDesktopExecutor({ windowTitle: "FX289", hwnd: "4919" }, d);
    const err = await exec(field({ name: "Name", via: "native", nativeWindowHandleRead: "zero" }), "setValue", "N1").then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("TargetGoneError");
    expect((err as { callerDetail?: string }).callerDetail).toMatch(/Re-run desktop_discover/);
    expect(d.keyboardTypeBg).not.toHaveBeenCalled();
  });

  it("the production dep types the engine's code", async () => {
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue: vi.fn(async () => ({ ok: false, error: "Two or more elements…", code: "ElementAmbiguous", via: "native" as const })),
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    const err = await _realExecutorDepsForTest().uiaSetValue("FX289", "N1", "Name").then(() => null, (e: unknown) => e as { uiaCode?: unknown });
    expect(err?.uiaCode).toBe("ElementAmbiguous");
  });

  it("CONTROL: a plain not-found still goes to the keyboard rung, as before", async () => {
    const d = deps();
    d.uiaSetValue = vi.fn(async () => { throw Object.assign(new Error("Element not found"), { uiaVia: "native" }); });
    const exec = createDesktopExecutor({ windowTitle: "FX289", hwnd: "4919" }, d);
    await exec(field({ name: "Name", via: "native", nativeWindowHandleRead: "zero" }), "setValue", "N1").catch(() => undefined);
    expect(d.keyboardTypeBg).toHaveBeenCalled();
  });
});
