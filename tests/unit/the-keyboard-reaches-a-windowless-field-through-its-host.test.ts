/**
 * internal #224 — Word's body is typed into through the window it is drawn in.
 *
 * MEASURED win2 (2026-09-30): the body is an `Edit` with no UI Automation value and no window of its
 * own (NativeWindowHandle 0), drawn in the `_WwG` child window (658714) of the `OpusApp` frame. A
 * WM_CHAR posted to `_WwG` is typed at the body's caret — Word in the foreground or background, the
 * IME open or closed, and whatever holds Word's focus. The thread's focus is null in the background
 * (the rung fell back to the frame, and nothing was typed) and is the ribbon's font-size box when
 * that box is focused (the characters went into it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultCapabilityRegistry } from "../../src/capabilities/registry.js";

const lookupDefault = (e: UiEntity) => createDefaultCapabilityRegistry().lookup(e);
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const FRAME = 1000n;
const WWG = 658714n;
const RIBBON_BOX = 777n;
const ELSEWHERE = 5000n;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../src/engine/win32.js");
  vi.doUnmock("../../src/engine/bg-input.js");
  vi.doUnmock("../../src/engine/receiver-facts.js");
});

async function resolveWith(opts: { threadFocus: bigint; hostAlive?: boolean; hostRoot?: bigint; hostInjectable?: boolean }, refs: { entityHwnd?: bigint; hostHwnd?: bigint }) {
  vi.resetModules();
  vi.doMock("../../src/engine/win32.js", async (orig) => ({
    ...(await orig<typeof import("../../src/engine/win32.js")>()),
    enumWindowsInZOrder: () => [{ hwnd: FRAME, title: "文書 1 - Word", region: { x: 0, y: 0, width: 800, height: 600 }, zOrder: 0, isMinimized: false, isMaximized: false, isActive: false }],
    getWindowRoot: (h: bigint) => (h === WWG ? (opts.hostRoot ?? FRAME) : h === RIBBON_BOX ? FRAME : h),
    windowIsAlive: (h: bigint) => (h === WWG ? (opts.hostAlive ?? true) : true),
  }));
  vi.doMock("../../src/engine/bg-input.js", async (orig) => ({
    ...(await orig<typeof import("../../src/engine/bg-input.js")>()),
    resolveKeyTarget: () => opts.threadFocus,
    canInjectViaPostMessage: (h: bigint) => ({ supported: h === WWG ? (opts.hostInjectable ?? true) : true }),
  }));
  vi.doMock("../../src/engine/receiver-facts.js", async (orig) => ({
    ...(await orig<typeof import("../../src/engine/receiver-facts.js")>()),
    readReceiverFacts: async () => ({}),
    readOwnerChain: () => [],
  }));
  const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
  return _realExecutorDepsForTest().keyboardResolve!("文書 1 - Word", FRAME, refs);
}

describe("the keyboard rung's receiver for a field with no window of its own", () => {
  it("is the child window it is drawn in, with Word in the background (thread focus falls back to the frame)", async () => {
    expect((await resolveWith({ threadFocus: FRAME }, { hostHwnd: WWG })).receiverHwnd).toBe(WWG);
  });

  it("is the child window it is drawn in, not the ribbon box that holds Word's focus (H3)", async () => {
    expect((await resolveWith({ threadFocus: RIBBON_BOX }, { hostHwnd: WWG })).receiverHwnd).toBe(WWG);
  });

  it("stays the thread's focus when the host is the window itself (a WPF window: every control's host)", async () => {
    expect((await resolveWith({ threadFocus: RIBBON_BOX }, { hostHwnd: FRAME })).receiverHwnd).toBe(RIBBON_BOX);
  });

  it("stays the thread's focus when the host is gone", async () => {
    expect((await resolveWith({ threadFocus: RIBBON_BOX, hostAlive: false }, { hostHwnd: WWG })).receiverHwnd).toBe(RIBBON_BOX);
  });

  it("stays the thread's focus when the host is under another top-level window", async () => {
    expect((await resolveWith({ threadFocus: RIBBON_BOX, hostRoot: ELSEWHERE }, { hostHwnd: WWG })).receiverHwnd).toBe(RIBBON_BOX);
  });

  it("stays the thread's focus when the host fails the inject check (gate 2)", async () => {
    expect((await resolveWith({ threadFocus: RIBBON_BOX, hostInjectable: false }, { hostHwnd: WWG })).receiverHwnd).toBe(RIBBON_BOX);
  });

  it("is the thread's focus when no host was recorded (the control)", async () => {
    expect((await resolveWith({ threadFocus: RIBBON_BOX }, {})).receiverHwnd).toBe(RIBBON_BOX);
  });
});

const bodyOf = (uia: Record<string, unknown>, extra: Partial<UiEntity> = {}): UiEntity => ({
  entityId: "body", role: "textbox", label: "ページ 1 のコンテンツ", controlType: "Edit", confidence: 0.9,
  sources: ["uia"], affordances: [], generation: "gen-1", evidenceDigest: "d",
  rect: { x: 141, y: 369, width: 793, height: 361 }, patterns: ["TextPattern", "ScrollItemPattern"],
  preferredExecutors: ["mouse", "keyboard"], unsupportedExecutors: ["uia"],
  locator: { uia: { name: "ページ 1 のコンテンツ", nativeWindowHandleRead: "zero", ...uia } },
  ...extra,
});

async function typeInto(entity: UiEntity, action: "type" | "setValue" = "type") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  const receipt = { windowHwnd: FRAME, receiverHwnd: WWG, receiverRootHwnd: FRAME, receiverAncestors: [FRAME], ancestorsComplete: true, originRootHwnd: FRAME, aimRootHwnd: FRAME, lookupRootHwnd: FRAME, ownerChain: [] };
  const keyboardResolve = vi.fn(async () => receipt);
  const keyboardPost = vi.fn(async () => {});
  const exec = createDesktopExecutor({ hwnd: String(FRAME) }, {
    uiaClick: vi.fn(), uiaSetValue: vi.fn(), cdpClick: vi.fn(), cdpFill: vi.fn(), terminalSend: vi.fn(),
    keyboardTypeBg: vi.fn(), mouseClick: vi.fn(), keyboardResolve, keyboardPost,
  });
  const out = await exec(entity, action, "abc").then((v) => v, (e: unknown) => e);
  return { out, keyboardResolve, keyboardPost, receipt };
}

describe("the executor hands the rung the host", () => {
  it("of a windowless field drawn in Word's document window, and posts to the receiver the resolve chose, unconfirmed", async () => {
    const { out, keyboardResolve, keyboardPost, receipt } = await typeInto(bodyOf({ hostWindowHandle: String(WWG), hostWindowClass: "_WwG" }));
    expect(keyboardResolve).toHaveBeenCalledWith(expect.any(String), FRAME, expect.objectContaining({ hostHwnd: WWG }));
    expect(keyboardPost).toHaveBeenCalledWith(receipt, "abc");
    expect(out).toMatchObject({ kind: "keyboard", landing: { confirmed: false } });
  });

  it("not of a host of a class nobody measured (gate 2)", async () => {
    const { keyboardResolve } = await typeInto(bodyOf({ hostWindowHandle: String(WWG), hostWindowClass: "Chrome_RenderWidgetHostHWND" }));
    expect(keyboardResolve).toHaveBeenCalledWith(expect.any(String), FRAME, expect.not.objectContaining({ hostHwnd: expect.anything() }));
  });

  it("not when the field has a window of its own: that window is the rule's to judge", async () => {
    const { keyboardResolve } = await typeInto(bodyOf({ nativeWindowHandle: "4242", nativeWindowHandleRead: "value", hostWindowHandle: "4242", hostWindowClass: "_WwG" }));
    expect(keyboardResolve).toHaveBeenCalledWith(expect.any(String), FRAME, expect.not.objectContaining({ hostHwnd: expect.anything() }));
  });

  it("refuses a setValue: keystrokes insert at the caret, they do not replace (gate 2)", async () => {
    const { out, keyboardPost } = await typeInto(bodyOf({ hostWindowHandle: String(WWG), hostWindowClass: "_WwG" }), "setValue");
    expect((out as { name?: string }).name).toBe("KeyboardCannotReplaceError");
    expect((out as { callerDetail?: string }).callerDetail).toBe(
      `Nothing was typed: "ページ 1 のコンテンツ" can only be typed into at its caret, which inserts rather than replaces. ` +
      `To replace its contents, click it, select them with keyboard ctrl+a, then desktop_act(action:'type') with the new text.`,
    );
    expect(keyboardPost).not.toHaveBeenCalled();
  });
});

describe("the capability a text field with no value gets", () => {
  const edit = (patterns: string[], uia: Record<string, unknown> = { hostWindowHandle: String(WWG), hostWindowClass: "_WwG" }): UiEntity => ({
    entityId: "e", role: "textbox", label: "L", controlType: "Edit", confidence: 0.9, sources: ["uia"], affordances: [],
    generation: "g", evidenceDigest: "d", rect: { x: 0, y: 0, width: 10, height: 10 }, patterns,
    locator: { uia: { name: "L", ...uia } },
  });
  const MOUSE_ONLY = { preferredExecutors: ["mouse"], unsupportedExecutors: ["uia"] };

  it("offers the keyboard beside the mouse, for an Edit with no Value drawn in Word's document window", () => {
    expect(lookupDefault(edit(["TextPattern"]))).toEqual({ preferredExecutors: ["mouse", "keyboard"], unsupportedExecutors: ["uia"] });
  });

  it("does not, drawn in a window of a class nobody measured (gate 2)", () => {
    expect(lookupDefault(edit(["TextPattern"], { hostWindowHandle: "9", hostWindowClass: "HwndWrapper[App]" }))).toEqual(MOUSE_ONLY);
  });

  it("does not, with no host recorded (the PowerShell road, an older addon)", () => {
    expect(lookupDefault(edit(["TextPattern"], {}))).toEqual(MOUSE_ONLY);
  });

  it("does not, for a field with a window of its own", () => {
    expect(lookupDefault(edit(["TextPattern"], { nativeWindowHandle: "4242", hostWindowHandle: "4242", hostWindowClass: "_WwG" }))).toEqual(MOUSE_ONLY);
  });

  it("keeps an Edit with a Value on the UIA road (the control)", () => {
    expect(lookupDefault(edit(["ValuePattern"]))).toEqual({ preferredExecutors: ["uia", "keyboard"] });
  });

  it("does not offer the keyboard for a Document (a browser page)", () => {
    expect(lookupDefault({ ...edit([]), controlType: "Document" })).toEqual(MOUSE_ONLY);
  });
});
