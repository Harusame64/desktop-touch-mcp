/**
 * internal #292 — a field with no window of its own is not typed into when the focus is elsewhere.
 *
 * When the value road fails, the keyboard rung posts WM_CHAR to whatever holds the focus. For a WPF
 * field the rung cannot compare handles (the receiver is the window itself, `receiver_is_window`), so
 * it posted and answered a marked `ok:true`. MEASURED win2 (2026-10-15, main `4d50cb47`, internal
 * `dev/k292/r292.md` @ `53b4bda9`), a WPF field whose SetValue throws:
 *   - V1–V3: the value road's focus step moved the focus into it, and "abc" landed in it 9/9 — even
 *     with the focus on another control before the act (so the focus BEFORE the act is not the fact);
 *   - V4: the field could not take the focus (Focusable=False), the focus stayed on a button, nothing
 *     landed, `ok:true` 3/3;
 *   - V5: the same with the focus on another text box: "abc" landed THERE, `ok:true` 3/3.
 * The final focus separated them 15/15. So the native writer reads, right after its failed write,
 * whether UI Automation's focus is on the element or inside it (`focus_first::focus_inside`, compared
 * as elements), and the rule refuses `other_control` when it is not. Every V1–V3 shape below must
 * still go through: refusing a write that lands is the error the user's contract most wants to avoid.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { judgeKeyboardTarget, type KeyboardFacts } from "../../src/engine/keyboard-target.js";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../src/engine/uia-bridge.js");
  vi.doUnmock("../../src/engine/native-engine.js");
});

const HWND = 4919n; // the WPF window (HwndWrapper): every element in it is windowless
const DIALOG = 7777n; // another top-level window
const CTRL = 5001n; // a control with a window of its own

/** The measured shape: a windowless field, and the receiver is the window itself. */
function facts(over: Partial<KeyboardFacts> = {}): KeyboardFacts {
  return {
    entityHwnd: null,
    entityRoot: null,
    originRoot: HWND,
    aimRoot: null,
    lookupRoot: HWND,
    receiver: HWND,
    receiverRoot: HWND,
    receiverAncestors: [],
    ancestorsComplete: true,
    receiverReadOnly: null,
    ownerChain: [],
    entityTakesInput: null,
    originTakesInput: null,
    valueRoadSaidDisabled: false,
    ...over,
  };
}

describe("the rule", () => {
  it("refuses other_control when the value road left the focus outside the named element (V4, V5)", () => {
    expect(judgeKeyboardTarget(facts({ valueRoadFocusInside: false })))
      .toEqual({ kind: "refuse", ground: "other_control", subject: "focus_outside_named", referenceFrom: "origin" });
  });

  it("CONTROL: posts, marked as before, when the focus is on it or inside it (V1–V3)", () => {
    expect(judgeKeyboardTarget(facts({ valueRoadFocusInside: true })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_is_window" });
  });

  it("CONTROL: not said — another client, a window behind, a step unread — decides nothing", () => {
    expect(judgeKeyboardTarget(facts({ valueRoadFocusInside: null })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_is_window" });
    expect(judgeKeyboardTarget(facts()))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_is_window" });
  });

  it("is decided before the other windowless 'cannot say' steps too (a receiver inside the same window)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: CTRL, valueRoadFocusInside: false })))
      .toMatchObject({ kind: "refuse", ground: "other_control" });
  });

  it("is decided before the receiver is read: in another window, or not read at all (gate 2)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: DIALOG, receiverRoot: DIALOG, valueRoadFocusInside: false })))
      .toMatchObject({ kind: "refuse", ground: "other_control" });
    expect(judgeKeyboardTarget(facts({ receiver: null, receiverRoot: null, valueRoadFocusInside: false })))
      .toMatchObject({ kind: "refuse", ground: "other_control" });
    // CONTROL: without the fact, those are the designed "cannot say".
    expect(judgeKeyboardTarget(facts({ receiver: DIALOG, receiverRoot: DIALOG })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_in_other_window" });
    expect(judgeKeyboardTarget(facts({ receiver: null, receiverRoot: null })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_unknown" });
  });

  it("is not read for a field with a window of its own: that window decides", () => {
    const own = facts({ entityHwnd: CTRL, entityRoot: HWND, receiver: CTRL, valueRoadFocusInside: false });
    expect(judgeKeyboardTarget(own)).toEqual({ kind: "post", confirmed: true, referenceFrom: "entity" });
    // …and where that window cannot say either, it stays the designed "cannot say": the windowless
    // ground was measured on windowless fields only.
    expect(judgeKeyboardTarget(facts({ entityHwnd: CTRL, entityRoot: HWND, valueRoadFocusInside: false })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_is_window" });
    // …nor for one whose recorded handle went stale: a field that had a window is not the measured shape.
    expect(judgeKeyboardTarget(facts({ entityHwnd: CTRL, entityRoot: null, valueRoadFocusInside: false })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_is_window" });
  });

  it("marks the post when the other_control ground is switched off", () => {
    expect(judgeKeyboardTarget(facts({ valueRoadFocusInside: false }), new Set(["other_control"])))
      .toMatchObject({ kind: "post", confirmed: false, why: "ground_disabled:other_control" });
  });
});

// ── Through the executor ────────────────────────────────────────────────────────────────────────

const RECT = { x: 100, y: 200, width: 120, height: 24 };

function vex(): UiEntity {
  return {
    entityId: "u9", role: "textbox", label: "Vex", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "Vex", nativeWindowHandleRead: "zero", via: "native" } },
    affordances: [{ verb: "type", executors: ["uia", "keyboard"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
    origin: { kind: "window", id: "4919", hwnd: "4919" },
  } as UiEntity;
}

/** WPF: the thread's focus is the window itself, whichever element UI Automation calls focused. */
function receipt(): KeyboardReceipt {
  return {
    windowHwnd: HWND, receiverHwnd: HWND, receiverClass: "HwndWrapper[fx292;;1]", receiverRect: RECT, receiverRootHwnd: HWND,
    receiverStyle: 0x16CF0000, receiverAncestors: [], ancestorsComplete: true,
    entityRootHwnd: null, originRootHwnd: HWND, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
  };
}

/** The native writer's failure as the production dep throws it (the SetValue error is the provider's). */
function setValueThrew(focusInside?: boolean) {
  return Object.assign(new Error("Operation is not valid due to the current state of the object."), {
    uiaVia: "native",
    ...(focusInside !== undefined && { uiaFocusInside: focusInside }),
  });
}

function deps(err: Error): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => { throw err; }),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => receipt()),
    keyboardResolve: vi.fn(async () => receipt()),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
  } as unknown as ExecutorDeps;
}

async function type(d: ExecutorDeps) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor({ windowTitle: "FX292 wpf" }, d)(vex(), "type", "abc");
}

describe("the rung", () => {
  it("refuses before anything is posted when the focus is outside the field (V4, V5)", async () => {
    const d = deps(setValueThrew(false));
    const err = await type(d).then(() => null, (e: unknown) => e as { name?: string; ground?: string; callerDetail?: string });
    expect(err).toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "other_control" });
    // A field that cannot take the focus (V4) would refuse again after a click: the way back says when to stop.
    expect(err?.callerDetail).toMatch(/Click the field this act named/);
    expect(err?.callerDetail).toMatch(/If this refusal repeats, the field does not take the keyboard focus/);
    expect(d.keyboardPost).not.toHaveBeenCalled();
    expect(d.keyboardTypeBg).not.toHaveBeenCalled();
  });

  it("CONTROL: posts, marked, when the focus is inside it (V1–V3)", async () => {
    const d = deps(setValueThrew(true));
    expect(await type(d)).toMatchObject({ kind: "keyboard", landing: { confirmed: false, why: "receiver_is_window" } });
    expect(d.keyboardPost).toHaveBeenCalledWith(receipt(), "abc");
  });

  it("CONTROL: a failure that does not say where the focus is posts, marked, as before", async () => {
    const d = deps(setValueThrew());
    expect(await type(d)).toMatchObject({ kind: "keyboard", landing: { confirmed: false, why: "receiver_is_window" } });
    expect(d.keyboardPost).toHaveBeenCalledTimes(1);
  });
});

// ── What carries the fact from the engine ───────────────────────────────────────────────────────

describe("the production dep and the bridge", () => {
  async function depThrows(answer: { ok: boolean; error?: string; via?: "native"; focusInside?: boolean }) {
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue: vi.fn(async () => answer),
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    return _realExecutorDepsForTest().uiaSetValue("FX292 wpf", "abc", "Vex")
      .then(() => null, (e: unknown) => e as { uiaFocusInside?: unknown; uiaVia?: unknown });
  }

  it("the dep carries the engine's answer on the error, both ways", async () => {
    expect((await depThrows({ ok: false, error: "x", via: "native", focusInside: false }))?.uiaFocusInside).toBe(false);
    expect((await depThrows({ ok: false, error: "x", via: "native", focusInside: true }))?.uiaFocusInside).toBe(true);
  });

  it("CONTROL: no answer, no field", async () => {
    const err = await depThrows({ ok: false, error: "x", via: "native" });
    expect(err).not.toHaveProperty("uiaFocusInside");
    expect(err?.uiaVia).toBe("native");
  });

  async function bridgeSays(result: Record<string, unknown>) {
    vi.doMock("../../src/engine/native-engine.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/native-engine.js")>()),
      nativeUia: { uiaSetValue: vi.fn(async () => result) },
    }));
    const { setElementValue } = await import("../../src/engine/uia-bridge.js");
    return setElementValue("FX292 wpf", "abc", "Vex");
  }

  it("the bridge passes the engine's focusInside on a failure", async () => {
    expect(await bridgeSays({ ok: false, error: "x", focusInside: false })).toMatchObject({ ok: false, via: "native", focusInside: false });
  });

  // One bridge per cell: it reads the engine when it loads, so a second call in the same cell would
  // still see the first cell's engine.
  it("CONTROL: the engine's null is not an answer", async () => {
    expect(await bridgeSays({ ok: false, error: "x", focusInside: null })).not.toHaveProperty("focusInside");
  });

  it("CONTROL: a success carries none", async () => {
    expect(await bridgeSays({ ok: true, focusInside: true })).not.toHaveProperty("focusInside");
  });
});
