/**
 * The keyboard rung refuses to type into a field that does not take input — ADR-036 family 2, the
 * fourth ground (`disabled`). The user's decision, 2026-09-19: add it, refusing only when the grounds
 * are clear, and confirm it on the real machine.
 *
 * MEASURED before the change (win2, internal `07a597a`, WinForms, the field disabled after
 * discover): the value road answered `element_disabled`, the rung posted, and
 *   - K2/K3 (no other control to hold the focus; title and handle road), K4 (the whole window
 *     disabled) and K5 (only the parent panel disabled) answered `ok:true` with `landing:
 *     {confirmed:false, why:"receiver_is_window"}` — and not one character reached any field;
 *   - K1 (a neighbour held the focus) was refused, but as `other_control`, whose way back is "click
 *     the field" — a disabled field takes no click.
 * The named field's own window was disabled on all four (`IsWindowEnabled` false; WinForms carries a
 * disabled parent down to the child's handle); the receiver's was disabled on K4 only. So the ground
 * reads the named field's window, not the receiver's.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { judgeKeyboardTarget, type KeyboardFacts } from "../../src/engine/keyboard-target.js";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const HWND = 4919n; // the window
const FIELD = 5001n; // the named field's own window
const OTHER = 5002n; // a neighbour in the same window

/** The field holds the focus and nothing about input has been asked. Each cell changes one fact. */
function facts(over: Partial<KeyboardFacts> = {}): KeyboardFacts {
  return {
    entityHwnd: FIELD, entityRoot: HWND, originRoot: null, aimRoot: null, lookupRoot: HWND,
    receiver: FIELD, receiverRoot: HWND, receiverAncestors: [], ancestorsComplete: true,
    receiverReadOnly: false, ownerChain: [], entityTakesInput: null, originTakesInput: null, valueRoadSaidDisabled: false,
    ...over,
  };
}

describe("the rule's step 0", () => {
  it("refuses disabled when the named field's window does not take input — K2/K3/K5: the focus fell to the window itself", () => {
    expect(judgeKeyboardTarget(facts({ receiver: HWND, entityTakesInput: false })))
      .toEqual({ kind: "refuse", ground: "disabled", subject: "named", referenceFrom: "entity" });
  });

  it("names it disabled, not other_control, when a neighbour holds the focus — K1", () => {
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, entityTakesInput: false })))
      .toMatchObject({ kind: "refuse", ground: "disabled" });
    // …and the same facts with the field taking input are still other_control.
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, entityTakesInput: true })))
      .toMatchObject({ kind: "refuse", ground: "other_control" });
  });

  it("refuses even when the named field itself holds the focus — its window is what does not take input", () => {
    // Gate 2: skipping step 0 when the receiver is the named control survived every cell.
    expect(judgeKeyboardTarget(facts({ receiver: FIELD, entityTakesInput: false })))
      .toMatchObject({ kind: "refuse", ground: "disabled", subject: "named" });
  });

  it("refuses before the receiver is read at all — a disabled field is a clear ground on its own", () => {
    expect(judgeKeyboardTarget(facts({ receiver: null, receiverRoot: null, entityTakesInput: false })))
      .toMatchObject({ kind: "refuse", ground: "disabled" });
  });

  it("does not refuse when the OS was not asked — not asked is not evidence", () => {
    expect(judgeKeyboardTarget(facts({ receiver: HWND, entityTakesInput: null })))
      .toEqual({ kind: "post", confirmed: false, why: "receiver_is_window", referenceFrom: "entity" });
  });

  it("reads the named field's own window when it has one, not the captured window", () => {
    expect(judgeKeyboardTarget(facts({ entityTakesInput: true, originTakesInput: false })))
      .toEqual({ kind: "post", confirmed: true, referenceFrom: "entity" });
  });

  it("refuses, about the window, when the field has no window of its own, UIA said disabled, and the captured window does not take input", () => {
    expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, originRoot: HWND, receiver: HWND, originTakesInput: false, valueRoadSaidDisabled: true })))
      .toEqual({ kind: "refuse", ground: "disabled", subject: "window", referenceFrom: "origin" });
  });

  // Internal #190 — measured (win2 `aa71d50f`): a disabled WPF field, the window enabled, the focus on
  // DELTA. Before this, the rung posted and DELTA took the text under `ok:true`.
  it("refuses, about the named field, when it has no window of its own and UIA said disabled, whatever the captured window says (#190)", () => {
    for (const originTakesInput of [true, null] as const) {
      expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, originRoot: HWND, receiver: HWND, originTakesInput, valueRoadSaidDisabled: true })), String(originTakesInput))
        .toEqual({ kind: "refuse", ground: "disabled", subject: "named", referenceFrom: "origin" });
    }
  });

  it("CONTROL: the same windowless field, the window enabled, and the value road NOT saying disabled, is the marked success it was (#190)", () => {
    expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, originRoot: HWND, receiver: HWND, originTakesInput: true, valueRoadSaidDisabled: false })))
      .toEqual({ kind: "post", confirmed: false, why: "receiver_is_window", referenceFrom: "origin" });
  });

  it("end to end: a windowless field UIA calls disabled, in an enabled window with the focus on a neighbour, is not typed into (#190)", async () => {
    const d = depsFor(receiptOf({ entityRootHwnd: null, originRootHwnd: HWND, receiverHwnd: 5002n }), { windowTakesInput: () => true });
    await expect(type(titleRoad, field(null, inWindow), d))
      .rejects.toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "disabled" });
    expect(d.keyboardPost).not.toHaveBeenCalled();
  });

  it("with the ground switched off, #190's refusal becomes the marked success, not a later step's post", () => {
    expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, originRoot: HWND, receiver: HWND, originTakesInput: true, valueRoadSaidDisabled: true }), new Set(["disabled"] as const)))
      .toEqual({ kind: "post", confirmed: false, why: "ground_disabled:disabled", referenceFrom: "origin" });
  });

  it("does not refuse on the captured window alone — an owned dialog's field is read through the owner the dialog disables (gate 2)", () => {
    // A field with no window of its own, in a modal dialog found through its owner: the captured
    // window is the owner, disabled by that very dialog, and the characters go into the dialog.
    const DIALOG = 7777n;
    expect(judgeKeyboardTarget(facts({
      entityHwnd: null, entityRoot: null, originRoot: HWND, receiver: 7778n, receiverRoot: DIALOG, ownerChain: [HWND], originTakesInput: false,
    }))).toEqual({ kind: "post", confirmed: false, why: "receiver_in_owned_window", referenceFrom: "origin" });
  });

  it("reads nothing past the field's own window when it has one — an unread answer there does not fall back to the captured window", () => {
    // Gate 2: falling back to the captured window when E's answer was null survived.
    expect(judgeKeyboardTarget(facts({ receiver: HWND, entityTakesInput: null, originTakesInput: false, valueRoadSaidDisabled: true })))
      .toMatchObject({ kind: "post", why: "receiver_is_window" });
  });

  it("with the ground switched off, the receiver grounds still refuse — K1 stays other_control (gate 2)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, entityTakesInput: false }), new Set(["disabled"] as const)))
      .toMatchObject({ kind: "refuse", ground: "other_control" });
  });

  it("with the ground switched off, a post it would have refused is marked ground_disabled:disabled — K2", () => {
    expect(judgeKeyboardTarget(facts({ receiver: HWND, entityTakesInput: false }), new Set(["disabled"] as const)))
      .toEqual({ kind: "post", confirmed: false, why: "ground_disabled:disabled", referenceFrom: "entity" });
  });
});

const RECT = { x: 100, y: 200, width: 120, height: 24 };
const DISABLED_NATIVE = Object.assign(new Error("Element is disabled"), { uiaVia: "native" });

function field(handle: string | null = "5001", over: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "f1", role: "textbox", label: "FIELD", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "FIELD", via: "native", ...(handle !== null && { nativeWindowHandle: handle }) } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
    ...over,
  };
}

/** K2's receipt: the OS focus is the window itself. */
function receiptOf(over: Partial<KeyboardReceipt> = {}): KeyboardReceipt {
  return {
    windowHwnd: HWND, receiverHwnd: HWND, receiverClass: "WindowsForms10.Window.8.app.0.1", receiverRect: null,
    receiverRootHwnd: HWND, receiverStyle: 0x16cf0000, receiverAncestors: [], ancestorsComplete: true,
    entityRootHwnd: HWND, originRootHwnd: HWND, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
    ...over,
  };
}

function depsFor(receipt: KeyboardReceipt, over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => { throw DISABLED_NATIVE; }),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => receipt),
    keyboardResolve: vi.fn(async () => receipt),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const titleRoad = { windowTitle: "K-FIXTURE" };
const handleRoad: Aim = { kind: "aim", title: "K-FIXTURE", hwnd: HWND };
const inWindow = { origin: { kind: "window" as const, id: "K-FIXTURE", hwnd: "4919" } };

async function type(target: typeof titleRoad | Aim, entity: UiEntity, d: ExecutorDeps) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(entity, "type", "kq7");
}

describe("the rung asks the OS, and refuses before anything is posted", () => {
  for (const [road, target] of [["title road (K2)", titleRoad], ["handle road (K3)", handleRoad]] as const) {
    it(`refuses disabled when the field's window does not take input — ${road}`, async () => {
      const windowTakesInput = vi.fn((h: bigint) => h !== FIELD);
      const d = depsFor(receiptOf(), { windowTakesInput });
      const err = await type(target, field("5001", inWindow), d).then(() => null, (e: unknown) => e as { name?: string; ground?: string; callerDetail?: string });
      expect(err).toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "disabled" });
      expect(err?.callerDetail).toMatch(/^Nothing was typed \(disabled\): the field this act named does not take input now/);
      expect(err?.callerDetail).toMatch(/re-run desktop_discover and type again/);
      // discover drops a disabled element (`uia-provider.ts`), so the sentence says what its absence means.
      expect(err?.callerDetail).toMatch(/missing then means still disabled, not gone/);
      expect(err?.callerDetail).not.toMatch(/dropped/);
      expect(d.keyboardPost).not.toHaveBeenCalled();
      expect(windowTakesInput).toHaveBeenCalledWith(FIELD);
    });
  }

  it("refuses disabled for a field with no window of its own when the window it was read from does not take input", async () => {
    const d = depsFor(receiptOf({ entityRootHwnd: null }), { windowTakesInput: (h: bigint) => h !== HWND });
    const err = await type(titleRoad, field(null, inWindow), d).then(() => null, (e: unknown) => e as { ground?: string; callerDetail?: string });
    expect(err).toMatchObject({ ground: "disabled" });
    expect(err?.callerDetail).toMatch(/UI Automation reported the field disabled, and the window it was read from does not take input now/);
    expect(d.keyboardPost).not.toHaveBeenCalled();
  });

  it("posts for a field with no window of its own when UIA did not say disabled, though the captured window does not take input", async () => {
    const noPattern = Object.assign(new Error("ValuePattern not supported"), { uiaVia: "native" });
    const d = depsFor(receiptOf({ entityRootHwnd: null }), { uiaSetValue: vi.fn(async () => { throw noPattern; }), windowTakesInput: (h: bigint) => h !== HWND });
    await type(titleRoad, field(null, inWindow), d);
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("asks the captured window, never the aim's — the handle road with a disabled aim and an enabled capture names the field, not a window", async () => {
    // Gate 2: reading the aim's window instead of the captured one survived every cell. Since #190 the
    // value road's "disabled" refuses a windowless field on its own, so the two windows now differ in
    // the refusal's subject: the captured window (enabled) leaves it about the named field; the aim's
    // (disabled) would have made it about the window. This cell posted before #190.
    const SIBLING = 8888n;
    const d = depsFor(receiptOf({ entityRootHwnd: null, originRootHwnd: SIBLING }), { windowTakesInput: (h: bigint) => h !== HWND });
    await expect(type(handleRoad, field(null, { origin: { kind: "window", id: "K-FIXTURE", hwnd: "8888" } }), d))
      .rejects.toMatchObject({
        name: "KeyboardTargetUnsafeError", ground: "disabled",
        // The subject shows in the caller's sentence: about the named field, not "the window it was read from".
        callerDetail: expect.stringMatching(/the field this act named does not take input now/),
      });
    expect(d.keyboardPost).not.toHaveBeenCalled();
  });

  it("posts, marked, when the OS could not be asked — the answer before this ground existed", async () => {
    const d = depsFor(receiptOf(), { windowTakesInput: () => undefined });
    expect(await type(titleRoad, field("5001", inWindow), d))
      .toEqual({ kind: "keyboard", landing: { confirmed: false, why: "receiver_is_window", referenceFrom: "entity" } });
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("posts, marked, on a backend with no way to ask", async () => {
    const d = depsFor(receiptOf());
    expect(await type(titleRoad, field("5001", inWindow), d)).toMatchObject({ kind: "keyboard", landing: { why: "receiver_is_window" } });
  });

  it("with DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED=disabled, posts and marks what it would have refused", async () => {
    vi.stubEnv("DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED", "disabled");
    const d = depsFor(receiptOf(), { windowTakesInput: (h: bigint) => h !== FIELD });
    expect(await type(titleRoad, field("5001", inWindow), d))
      .toEqual({ kind: "keyboard", landing: { confirmed: false, why: "ground_disabled:disabled", referenceFrom: "entity" } });
  });
});

describe("the production backend asks the OS", () => {
  it("refuses when win32 says the field's window is disabled — the real windowTakesInput, not a double", async () => {
    // Gate 2: making the production `windowTakesInput` always answer true survived all 589 cells,
    // because the unmocked `isWindowEnabled` answers true without the native binding.
    vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
      enumWindowsInZOrder: () => [{ hwnd: HWND, title: "K-FIXTURE" }],
      getWindowClassName: () => "Edit",
      getWindowRectByHwnd: () => RECT,
      getWindowStyle: () => 0x50010080,
      getWindowRoot: (h: unknown) => (h === FIELD ? HWND : (h as bigint)),
      getWindowParent: () => HWND,
      getWindowOwner: () => null,
      isWindowEnabled: (h: unknown) => h !== FIELD,
    }));
    const postCharsToResolvedTarget = vi.fn((_t: unknown, text: string) => ({ sent: text.length, full: true, target: HWND }));
    vi.doMock("../../src/engine/bg-input.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/bg-input.js")>()),
      canInjectViaPostMessage: () => ({ supported: true }),
      resolveKeyTarget: () => HWND,
      postCharsToResolvedTarget,
    }));
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const keyboardOnly = field("5001", { unsupportedExecutors: ["uia"], preferredExecutors: ["keyboard"] });
    await expect(createDesktopExecutor(titleRoad)(keyboardOnly, "type", "kq7")).rejects.toMatchObject({ ground: "disabled" });
    expect(postCharsToResolvedTarget).not.toHaveBeenCalled();
    vi.doUnmock("../../src/engine/win32.js");
    vi.doUnmock("../../src/engine/bg-input.js");
  });
});
