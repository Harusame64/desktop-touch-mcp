/**
 * internal #287 — a value write that fails after the value moved is not typed a second time.
 *
 * MEASURED win2 (2026-10-22, main `25078031`, WPF fixture K287-FX, 3/3 each, internal #287): a TextBox
 * whose ValuePattern.SetValue writes the text and then throws took `desktop_act type "abc"` as
 * `abcabc` under `ok:true` (`executor:"keyboard"`, landing not confirmed). The native failure text was
 * the same as for a SetValue that throws without writing ("Pattern not found (0x80131509)"), so only
 * reading the value again tells them apart.
 *
 * The read lives in the native writer (`src/uia/actions.rs`, `set_value_impl`): the value asked for
 * answers `ok:true`, another value that moved answers `code: "ValueChangedThenFailed"`, an unmoved one
 * answers as before. These cells pin everything above the addon.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const HWND = 4919n;

function box(): UiEntity {
  return {
    entityId: "box", role: "textbox", label: "Throws after write", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "Throws after write", automationId: "AfterWrite", via: "native" } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 10, y: 10, width: 200, height: 20 }, controlType: "Edit",
    origin: { kind: "window", id: "K287-FX", hwnd: HWND.toString() },
  };
}

const receipt: KeyboardReceipt = {
  windowHwnd: HWND, receiverHwnd: HWND, receiverClass: "HwndWrapper", receiverRect: null,
  receiverRootHwnd: HWND, receiverStyle: 0x16cf0000, receiverAncestors: [HWND], ancestorsComplete: true,
  entityRootHwnd: HWND, entityWindowAlive: true, originRootHwnd: HWND, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
};

async function deps(uiaSetValue: ExecutorDeps["uiaSetValue"]): Promise<ExecutorDeps> {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue,
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => receipt),
    keyboardResolve: vi.fn(async () => receipt),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
  };
}

async function changedThenFailed() {
  const { ValueNotAppliedError, VALUE_CHANGED_THEN_FAILED } = await import("../../src/engine/aim.js");
  return vi.fn(async () => {
    throw Object.assign(new ValueNotAppliedError("SetValue failed (x), and the element's value changed"), { uiaCode: VALUE_CHANGED_THEN_FAILED });
  });
}

const roads = [["title road", { windowTitle: "K287-FX" }], ["handle road", { kind: "aim", title: "K287-FX", hwnd: HWND } as Aim]] as const;

async function write(target: { windowTitle: string } | Aim, d: ExecutorDeps, action: "type" | "setValue") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(box(), action, "abc");
}

const outcome = (p: Promise<unknown>) => p.then((v) => ({ v, e: null }), (e: unknown) => ({ v: null, e: e as { name?: string; callerDetail?: string } }));

describe("#287 — the value write failed after the value moved to another value", () => {
  for (const [road, target] of roads) {
    for (const action of ["type", "setValue"] as const) {
      it(`is refused as value_not_applied, and the keyboard rung is not reached — ${action}, ${road}`, async () => {
        const d = await deps(await changedThenFailed());
        const { e } = await outcome(write(target, d, action));
        expect(e).toMatchObject({ name: "ValueNotAppliedError" });
        expect(e?.callerDetail).toMatch(/its value had changed, to something other than the value asked for/);
        expect(e?.callerDetail).toMatch(/Look at the field/);
        expect(d.keyboardTypeBg).not.toHaveBeenCalled();
        expect(d.keyboardResolve).not.toHaveBeenCalled();
        expect(d.keyboardPost).not.toHaveBeenCalled();
      });
    }
  }

  it("CONTROL: a failure the engine did not mark still goes on to the keyboard rung, as before", async () => {
    const d = await deps(vi.fn(async () => { throw Object.assign(new Error("Pattern not found (0x80131509)"), { uiaVia: "native" }); }));
    // The shape win2 measured on main for both throwing boxes: the keyboard rung, landing not confirmed.
    const { v } = await outcome(write(roads[0][1], d, "type"));
    expect(v).toMatchObject({ kind: "keyboard", landing: { confirmed: false } });
    expect(d.keyboardPost).toHaveBeenCalled();
  });
});

describe("the production dep reads the engine's code", () => {
  async function depSays(answer: Record<string, unknown>) {
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue: vi.fn(async () => answer),
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    return _realExecutorDepsForTest().uiaSetValue("K287-FX", "abc", "Throws after write")
      .then(() => null, (e: unknown) => e as { name?: string; uiaCode?: unknown });
  }

  it("types ValueChangedThenFailed as the refusal, marked with its code", async () => {
    const err = await depSays({ ok: false, error: "SetValue failed (x)", code: "ValueChangedThenFailed", via: "native" });
    expect(err).toMatchObject({ name: "ValueNotAppliedError", uiaCode: "ValueChangedThenFailed" });
  });

  it("CONTROL: an unmarked failure is a plain error, which the ladder sends on to the keyboard rung", async () => {
    const err = await depSays({ ok: false, error: "Pattern not found (0x80131509)", via: "native" });
    expect(err?.name).toBe("Error");
    expect(err).not.toHaveProperty("uiaCode");
  });
});
