/**
 * The keyboard rung refuses a write when the grounds are clear — ADR-036 family 2, the change.
 *
 * The keyboard rung posts WM_CHAR to whatever holds the focus of the window's thread. win2 measured
 * that a type aimed at a read-only field went into the field beside it, and one aimed at a window went
 * into its dialog, both answering `ok:true` (internal #74, #85). The user's contract (2026-09-11):
 * refuse, but only when the grounds are clear; when the facts cannot say, post and mark the success.
 *
 * The rule is `engine/keyboard-target.ts` (internal dev/fam2-refusal/DESIGN.md §3, read twice by gate
 * 2). These cells pin it step by step, then the rung that runs it before posting, then the path a
 * refusal takes to the caller. The error the contract most wants to avoid is refusing a write that
 * lands in the named field, so every "confirmed" and "cannot say" case below is a write that must go
 * through.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  judgeKeyboardTarget,
  readKeyboardRungSwitch,
  parseHandle,
  KeyboardTargetUnsafeError,
  type KeyboardFacts,
} from "../../src/engine/keyboard-target.js";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../src/engine/win32.js");
  vi.doUnmock("../../src/engine/bg-input.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

const HWND = 4919n; // the window
const CTRL = 5001n; // the named control's own window
const OTHER = 5002n; // another control in the same window
const INNER = 5003n; // a child window of the named control
const DIALOG = 7777n; // another top-level window
const SIBLING = 8888n; // a same-titled sibling window

/** A write that lands in the named control, which holds the focus itself. Each cell changes one fact. */
function facts(over: Partial<KeyboardFacts> = {}): KeyboardFacts {
  return {
    entityHwnd: CTRL,
    entityRoot: HWND,
    originRoot: null,
    aimRoot: null,
    lookupRoot: HWND,
    receiver: CTRL,
    receiverRoot: HWND,
    receiverAncestors: [],
    ancestorsComplete: true,
    receiverReadOnly: false,
    ownerChain: [],
    ...over,
  };
}

describe("the rule, step by step (first match decides)", () => {
  it("1. cannot say when the receiver, or its top-level window, cannot be read", () => {
    expect(judgeKeyboardTarget(facts({ receiver: null }))).toMatchObject({ kind: "post", confirmed: false, why: "receiver_unknown" });
    expect(judgeKeyboardTarget(facts({ receiverRoot: null }))).toMatchObject({ kind: "post", confirmed: false, why: "receiver_unknown" });
  });

  it("2. posts, confirmed, when the receiver is the named control", () => {
    expect(judgeKeyboardTarget(facts())).toEqual({ kind: "post", confirmed: true, referenceFrom: "entity" });
  });

  it("2. posts, confirmed, when the receiver is inside it — a composite's inner edit", () => {
    expect(judgeKeyboardTarget(facts({ receiver: INNER, receiverAncestors: [CTRL] }))).toMatchObject({ kind: "post", confirmed: true });
  });

  it("2. counts a partial walk that already met the named control", () => {
    expect(judgeKeyboardTarget(facts({ receiver: INNER, receiverAncestors: [CTRL], ancestorsComplete: false })))
      .toMatchObject({ kind: "post", confirmed: true });
  });

  it("2. confirms a field in an owned dialog found through its owner, before any window comparison (F1)", () => {
    // The named field lives in the dialog, which UIA listed under its owner; the rung looked up the
    // owner. Comparing with the looked-up window would refuse a write that lands.
    expect(judgeKeyboardTarget(facts({ entityRoot: DIALOG, receiverRoot: DIALOG, lookupRoot: HWND, aimRoot: HWND })))
      .toMatchObject({ kind: "post", confirmed: true, referenceFrom: "entity" });
  });

  it("2. confirms when the named element is the receiver's own top-level window", () => {
    expect(judgeKeyboardTarget(facts({ entityHwnd: DIALOG, entityRoot: DIALOG, receiver: INNER, receiverRoot: DIALOG })))
      .toMatchObject({ kind: "post", confirmed: true });
  });

  it("2. refuses read_only when the named field holds the focus and does not take typing (a1i)", () => {
    expect(judgeKeyboardTarget(facts({ receiverReadOnly: true })))
      .toEqual({ kind: "refuse", ground: "read_only", subject: "named", referenceFrom: "entity" });
    expect(judgeKeyboardTarget(facts({ receiver: INNER, receiverAncestors: [CTRL], receiverReadOnly: true })))
      .toMatchObject({ kind: "refuse", ground: "read_only", subject: "focused_inside_named" });
  });

  it("3. refuses other_window when the receiver's window is not the named control's (dlg)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, receiverRoot: DIALOG })))
      .toMatchObject({ kind: "refuse", ground: "other_window" });
  });

  it("3. refuses a same-titled sibling the title lookup picked, with or without a focused child (F1, G2-3)", () => {
    const sibling = { lookupRoot: SIBLING, receiverRoot: SIBLING };
    expect(judgeKeyboardTarget(facts({ ...sibling, receiver: OTHER })))
      .toMatchObject({ kind: "refuse", ground: "other_window", referenceFrom: "entity" });
    // The sibling's thread has no focus, so the receiver is that window itself. Still another window.
    expect(judgeKeyboardTarget(facts({ ...sibling, receiver: SIBLING })))
      .toMatchObject({ kind: "refuse", ground: "other_window" });
  });

  it("3. cannot say for a windowless element when the receiver is in another window — owned by R or not (G2-2)", () => {
    const windowless = { entityHwnd: null, entityRoot: null, aimRoot: HWND, receiver: OTHER, receiverRoot: DIALOG };
    expect(judgeKeyboardTarget(facts({ ...windowless, ownerChain: [HWND] })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_in_owned_window", referenceFrom: "aim" });
    // The owner walk ended in a null, which is "no owner" and "could not ask" alike. Never a refusal.
    expect(judgeKeyboardTarget(facts({ ...windowless, ownerChain: [] })))
      .toMatchObject({ kind: "post", confirmed: false, why: "receiver_in_other_window" });
  });

  it("R is the first candidate that is alive, never a closed one (G2-1)", () => {
    // A stale handle and a closed capture window leave the aimed window as the reference.
    const stale = { entityRoot: null, originRoot: null, aimRoot: HWND, receiver: OTHER };
    expect(judgeKeyboardTarget(facts(stale))).toMatchObject({ referenceFrom: "aim", why: "entity_handle_stale" });
    expect(judgeKeyboardTarget(facts({ ...stale, aimRoot: null }))).toMatchObject({ referenceFrom: "lookup" });
    expect(judgeKeyboardTarget(facts({ ...stale, originRoot: HWND }))).toMatchObject({ referenceFrom: "origin" });
    expect(judgeKeyboardTarget(facts({ ...stale, aimRoot: null, lookupRoot: null })))
      .toMatchObject({ kind: "post", confirmed: false, why: "reference_unknown" });
  });

  it("4. cannot say when the receiver is the window itself (WPF, or a thread with no focus)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: HWND }))).toMatchObject({ kind: "post", confirmed: false, why: "receiver_is_window" });
    expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, aimRoot: HWND, receiver: HWND })))
      .toMatchObject({ why: "receiver_is_window" });
  });

  it("5. refuses other_control for another control in the same window, once the walk reached the window (a1ii)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: OTHER }))).toMatchObject({ kind: "refuse", ground: "other_control" });
  });

  it("5. names a read-only neighbour as another control, not as read-only (F4)", () => {
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, receiverReadOnly: true }))).toMatchObject({ ground: "other_control" });
  });

  it("5. cannot say 'another control' when the walk stopped short without meeting the named control", () => {
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, receiverAncestors: [9001n], ancestorsComplete: false })))
      .toMatchObject({ kind: "post", confirmed: false, why: "parents_unread" });
  });

  it("6. refuses read_only for a read-only focus when the named element has no window of its own", () => {
    expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, aimRoot: HWND, receiver: OTHER, receiverReadOnly: true })))
      .toMatchObject({ kind: "refuse", ground: "read_only", subject: "focused" });
  });

  it("7. cannot say otherwise: a windowless element, or a stale handle", () => {
    expect(judgeKeyboardTarget(facts({ entityHwnd: null, entityRoot: null, aimRoot: HWND, receiver: OTHER })))
      .toMatchObject({ kind: "post", confirmed: false, why: "entity_windowless" });
    expect(judgeKeyboardTarget(facts({ entityRoot: null, aimRoot: HWND, receiver: OTHER })))
      .toMatchObject({ kind: "post", confirmed: false, why: "entity_handle_stale" });
  });

  it("compares every handle in its low 32 bits", () => {
    // UIA writes the named control's handle as unsigned 32-bit; GetFocus widens the receiver to 64.
    const wide = 0xFFFF_FFFF_8000_1389n;
    const narrow = 0x8000_1389n;
    const root64 = 0xFFFF_FFFF_8000_1337n;
    const root32 = 0x8000_1337n;
    expect(judgeKeyboardTarget(facts({ entityHwnd: narrow, entityRoot: root32, receiver: wide, receiverRoot: root64, lookupRoot: root64 })))
      .toMatchObject({ kind: "post", confirmed: true });
    // …and a sibling in the same window, written in the other width, is still another control, not another window.
    expect(judgeKeyboardTarget(facts({ entityHwnd: narrow, entityRoot: root32, receiver: 0xFFFF_FFFF_8000_1390n, receiverRoot: root64 })))
      .toMatchObject({ kind: "refuse", ground: "other_control" });
  });

  it("a disabled ground's step still decides: a marked success, with no fall-through to a later step", () => {
    const off = new Set(["other_control"] as const);
    expect(judgeKeyboardTarget(facts({ receiver: OTHER }), off))
      .toMatchObject({ kind: "post", confirmed: false, why: "ground_disabled:other_control" });
    // With other_control off, a read-only neighbour is not refused as read_only instead.
    expect(judgeKeyboardTarget(facts({ receiver: OTHER, receiverReadOnly: true }), off))
      .toMatchObject({ kind: "post", confirmed: false, why: "ground_disabled:other_control" });
    // The other grounds still refuse.
    expect(judgeKeyboardTarget(facts({ receiverReadOnly: true }), off)).toMatchObject({ kind: "refuse", ground: "read_only" });
  });
});

describe("the switch, and the handle as UIA writes it", () => {
  it("reads the whole form, a list of grounds, and anything else as 'the rule runs'", () => {
    for (const v of ["1", "all", "TRUE", " all "]) {
      expect(readKeyboardRungSwitch({ DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED: v })).toEqual({ unchecked: true, disabled: new Set() });
    }
    expect(readKeyboardRungSwitch({ DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED: "other_control, read_only" }))
      .toEqual({ unchecked: false, disabled: new Set(["other_control", "read_only"]) });
    // A misspelt value keeps the check on.
    expect(readKeyboardRungSwitch({ DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED: "yes" })).toEqual({ unchecked: false, disabled: new Set() });
    expect(readKeyboardRungSwitch({})).toEqual({ unchecked: false, disabled: new Set() });
  });

  it("parses a decimal handle, and reads zero or garbage as no handle", () => {
    expect(parseHandle("5001")).toBe(5001n);
    expect(parseHandle("2147488649")).toBe(0x8000_1389n);
    expect(parseHandle("0")).toBeNull();
    expect(parseHandle("abc")).toBeNull();
    expect(parseHandle(undefined)).toBeNull();
  });
});

// ── The rung in the executor ────────────────────────────────────────────────────────────────────

const RECT = { x: 100, y: 200, width: 120, height: 24 };
const EDIT = "WindowsForms10.EDIT.app.0.1";
const WRITABLE = 0x50010080;
const READ_ONLY_PS = new Error('Exception calling "SetValue" with "1" argument(s): "Value is read-only."');

/** `handle` null means the element has no window of its own (WPF, most of a browser). */
function field(handle: string | null = "5001", over: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "u4", role: "textbox", label: "DELTA", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "DELTA", automationId: "DELTA", ...(handle !== null && { nativeWindowHandle: handle }) } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
    ...over,
  };
}

/** What `keyboardResolve` read: by default, the named control holds the focus. */
function receiptOf(over: Partial<KeyboardReceipt> = {}): KeyboardReceipt {
  return {
    windowHwnd: HWND, receiverHwnd: CTRL, receiverClass: EDIT, receiverRect: RECT, receiverRootHwnd: HWND,
    receiverStyle: WRITABLE, receiverAncestors: [], ancestorsComplete: true,
    entityRootHwnd: HWND, originRootHwnd: null, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
    ...over,
  };
}

function depsFor(receipt: KeyboardReceipt, over: Partial<ExecutorDeps> = {}) {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => { throw READ_ONLY_PS; }),
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

const titleRoad = { windowTitle: "RFS-CELL" };
const handleRoad: Aim = { kind: "aim", title: "RFS-CELL", hwnd: HWND };

async function type(target: typeof titleRoad | Aim, entity: UiEntity, d: ExecutorDeps) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(entity, "type", "PROBE-R");
}

describe("the rung judges before it posts", () => {
  it("posts to the handle it judged, and answers the bare 'keyboard' when confirmed", async () => {
    const receipt = receiptOf();
    const d = depsFor(receipt);
    expect(await type(titleRoad, field(), d)).toBe("keyboard");
    expect(d.keyboardPost).toHaveBeenCalledWith(receipt, "PROBE-R");
    expect(d.keyboardTypeBg).not.toHaveBeenCalled();
  });

  it("asks with the named control's own window and the window it was captured in", async () => {
    const d = depsFor(receiptOf());
    await type(titleRoad, field("5001", { origin: { kind: "window", id: "4919", hwnd: "4919" } }), d);
    expect(d.keyboardResolve).toHaveBeenCalledWith("RFS-CELL", undefined, { entityHwnd: CTRL, originHwnd: HWND });
  });

  it("posts and marks the success when it cannot say", async () => {
    const d = depsFor(receiptOf({ receiverHwnd: HWND }));
    expect(await type(titleRoad, field(), d))
      .toEqual({ kind: "keyboard", landing: { confirmed: false, why: "receiver_is_window", referenceFrom: "entity" } });
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  for (const [road, target] of [["title road", titleRoad], ["handle road", handleRoad]] as const) {
    it(`refuses before anything is posted, and the ladder does not rename it — ${road} (F2)`, async () => {
      const d = depsFor(receiptOf({ receiverHwnd: OTHER }));
      await expect(type(target, field(), d)).rejects.toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "other_control" });
      expect(d.keyboardPost).not.toHaveBeenCalled();
      expect(d.keyboardTypeBg).not.toHaveBeenCalled();
    });
  }

  it("keeps the refusal when the value road said the window was gone (G2-5)", async () => {
    const { AimedWindowGoneError } = await import("../../src/engine/aim.js");
    const d = depsFor(receiptOf({ receiverHwnd: OTHER }), {
      uiaSetValue: vi.fn(async () => { throw new AimedWindowGoneError(HWND); }),
    });
    await expect(type(handleRoad, field(), d)).rejects.toMatchObject({ name: "KeyboardTargetUnsafeError" });
  });

  it("refuses on the keyboard-only road too", async () => {
    const d = depsFor(receiptOf({ receiverHwnd: OTHER, receiverRootHwnd: DIALOG }));
    const keyboardOnly = field("5001", { unsupportedExecutors: ["uia"], preferredExecutors: ["keyboard"] });
    await expect(type(titleRoad, keyboardOnly, d)).rejects.toMatchObject({ ground: "other_window" });
    expect(d.uiaSetValue).not.toHaveBeenCalled();
    expect(d.keyboardPost).not.toHaveBeenCalled();
  });

  it("with the switch whole, takes today's path exactly: keyboardTypeBg, no check, a bare 'keyboard'", async () => {
    vi.stubEnv("DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED", "1");
    const d = depsFor(receiptOf({ receiverHwnd: OTHER }));
    expect(await type(titleRoad, field(), d)).toBe("keyboard");
    expect(d.keyboardTypeBg).toHaveBeenCalledWith("RFS-CELL", "PROBE-R", undefined);
    expect(d.keyboardResolve).not.toHaveBeenCalled();
    expect(d.keyboardPost).not.toHaveBeenCalled();
  });

  it("with one ground off, posts and marks what that ground would have refused", async () => {
    vi.stubEnv("DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED", "other_control");
    const d = depsFor(receiptOf({ receiverHwnd: OTHER }));
    expect(await type(titleRoad, field(), d)).toMatchObject({ kind: "keyboard", landing: { why: "ground_disabled:other_control" } });
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("marks, never plainly confirms, when the backend cannot resolve the receiver before posting", async () => {
    const d = depsFor(receiptOf(), { keyboardResolve: undefined, keyboardPost: undefined });
    expect(await type(titleRoad, field(), d))
      .toEqual({ kind: "keyboard", landing: { confirmed: false, why: "receiver_unknown", referenceFrom: "none" } });
    expect(d.keyboardTypeBg).toHaveBeenCalledOnce();
  });
});

describe("the refusal reaches the caller under its own name", () => {
  async function loopWith(execute: () => Promise<unknown>) {
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const e = field();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "view-1");
    const loop = new GuardedTouchLoop(store, {
      resolveLiveEntities: () => [e],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: execute as never,
      resolvePostTouchEntities: async () => [],
    });
    return loop.touch({ lease, action: "type", text: "PROBE-R" });
  }

  it("is keyboard_target_unsafe in the loop, with the ground in the published detail", async () => {
    const result = await loopWith(async () => { throw new KeyboardTargetUnsafeError("other_control", "named", "internal: receiver 5002"); });
    expect(result).toMatchObject({ ok: false, reason: "keyboard_target_unsafe" });
    const detail = (result as { detail?: string }).detail ?? "";
    expect(detail).toMatch(/^Nothing was typed \(other_control\)/);
    // The published sentence is the class's own, not the internal message.
    expect(detail).not.toContain("5002");
  });

  it("carries the landing marker on a marked success", async () => {
    const landing = { confirmed: false as const, why: "receiver_is_window", referenceFrom: "entity" };
    const result = await loopWith(async () => ({ kind: "keyboard", landing }));
    expect(result).toMatchObject({ ok: true, executor: "keyboard", landing });
  });

  it("leaves a confirmed write with no marker", async () => {
    const result = await loopWith(async () => "keyboard");
    expect(result).toMatchObject({ ok: true, executor: "keyboard" });
    expect(result).not.toHaveProperty("landing");
  });

  it("publishes keyboard_target_unsafe on the raw shape too, which the class name alone decides", async () => {
    const { toFailureEnvelope } = await import("../../src/tools/_envelope.js");
    const { Err } = await import("../../src/types/result.js");
    const { KeyboardTargetUnsafeRefusalError } = await import("../../src/errors/typed-errors.js");
    const raw = toFailureEnvelope(Err(new KeyboardTargetUnsafeRefusalError("x")), { optIn: false }) as { reason?: string };
    expect(raw.reason).toBe("keyboard_target_unsafe");
  });
});

describe("the real backend resolves once, looks the window up in the low 32 bits, and walks the owners", () => {
  /**
   * A window named by a sign-extended handle, enumerated in its 32-bit form; a receiver `receiver`
   * whose top-level window is `receiverRoot`; and an owner chain the test draws.
   */
  async function typeThroughTheRealBackend(opts: {
    aimHwnd: bigint; enumerated: bigint; receiver: bigint; receiverRoot: bigint; owners: Map<bigint, bigint>; entity: UiEntity;
  }) {
    const postCharsToResolvedTarget = vi.fn((_t: unknown, text: string) => ({ sent: text.length, full: true, target: opts.receiver }));
    vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
      enumWindowsInZOrder: () => [{ hwnd: opts.enumerated, title: "RFS-CELL" }],
      getWindowClassName: () => "Edit",
      getWindowRectByHwnd: () => RECT,
      getWindowStyle: () => WRITABLE,
      getWindowRoot: (h: unknown) => (h === opts.receiver ? opts.receiverRoot : opts.enumerated),
      getWindowParent: () => opts.receiverRoot,
      getWindowOwner: (h: unknown) => opts.owners.get(h as bigint) ?? null,
    }));
    vi.doMock("../../src/engine/bg-input.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/bg-input.js")>()),
      canInjectViaPostMessage: () => ({ supported: true }),
      resolveKeyTarget: () => opts.receiver,
      postCharsToResolvedTarget,
    }));
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const result = await createDesktopExecutor({ kind: "aim", title: "RFS-CELL", hwnd: opts.aimHwnd })(opts.entity, "type", "PROBE-R");
    return { result, postCharsToResolvedTarget };
  }

  const keyboardOnly = (h: string | null): UiEntity => field(h, { unsupportedExecutors: ["uia"], preferredExecutors: ["keyboard"] });

  it("finds a window named by a sign-extended handle, and posts to exactly the handle it resolved", async () => {
    const window32 = 0x8000_1337n;
    const { result, postCharsToResolvedTarget } = await typeThroughTheRealBackend({
      aimHwnd: 0xFFFF_FFFF_8000_1337n, enumerated: window32, receiver: window32, receiverRoot: window32,
      owners: new Map(), entity: keyboardOnly("5001"),
    });
    expect(result).toMatchObject({ kind: "keyboard", landing: { why: "receiver_is_window" } });
    expect(postCharsToResolvedTarget).toHaveBeenCalledWith(window32, "PROBE-R");
  });

  it("cannot say, and does not refuse, when a windowless element's receiver sits in a dialog the window owns (G2-2)", async () => {
    const { result, postCharsToResolvedTarget } = await typeThroughTheRealBackend({
      aimHwnd: HWND, enumerated: HWND, receiver: OTHER, receiverRoot: DIALOG,
      owners: new Map([[DIALOG, HWND]]), entity: keyboardOnly(null),
    });
    expect(result).toMatchObject({ kind: "keyboard", landing: { why: "receiver_in_owned_window", referenceFrom: "aim" } });
    expect(postCharsToResolvedTarget).toHaveBeenCalledOnce();
  });

  it("refuses when the named control's receiver is in another top-level window (dlg)", async () => {
    const { result } = await typeThroughTheRealBackend({
      aimHwnd: HWND, enumerated: HWND, receiver: OTHER, receiverRoot: DIALOG,
      owners: new Map(), entity: keyboardOnly("5001"),
    }).then((r) => r, (err: unknown) => ({ result: err }));
    expect(result).toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "other_window" });
  });
});
