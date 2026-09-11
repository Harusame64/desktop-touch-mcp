/**
 * The keyboard rung says where its characters went — ADR-036 family 2, the observation before the change.
 *
 * `desktop_act` type falls back from the UIA value road to posting WM_CHAR to whatever holds the focus
 * of the window's thread. It answers `ok:true` without asking whether that is the field it was given.
 * win2 measured the result on `66219a1` (internal #74): a type aimed at a read-only field wrote into the
 * field beside it, and a type at a gone field wrote into the focused one.
 *
 * The user chose to observe before changing anything (2026-09-11), and to keep room to change course
 * when the measurements call for it. So the row carries raw facts that any later rule can be tried
 * against, and the act answers exactly as it did.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

/** Every module a cell below replaces, unmocked after each cell so none leaks into the next. */
const MOCKED = ["../../src/engine/win32.js", "../../src/engine/bg-input.js", "../../src/engine/native-engine.js"];

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyboard-landing-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  for (const m of MOCKED) vi.doUnmock(m);
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

const HWND = 4919n; // the window
const DELTA = 5000n; // the field the caller named
const BESIDE = 5001n; // the field beside it
const DIALOG = 7777n; // another top-level window on the same thread
const aim: Aim = { kind: "aim", title: "RFS-CELL", hwnd: HWND };

const DELTA_RECT = { x: 100, y: 200, width: 120, height: 24 };
const BESIDE_RECT = { x: 100, y: 240, width: 120, height: 24 };
const WINDOW_RECT = { x: 0, y: 0, width: 800, height: 600 };
const EDIT_CLASS = "WindowsForms10.EDIT.app.0.1";
/** WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL — an ordinary text box. */
const WRITABLE = 0x50010080;
/** The same with ES_READONLY (0x0800). */
const READ_ONLY_STYLE = WRITABLE | 0x0800;

const delta: UiEntity = {
  entityId: "u4", role: "textbox", label: "DELTA", confidence: 0.9, sources: ["uia"],
  locator: { uia: { name: "DELTA", automationId: "DELTA" } },
  affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
  generation: "gen-1", evidenceDigest: "d", rect: DELTA_RECT, controlType: "Edit",
};
const keyboardOnly: UiEntity = { ...delta, unsupportedExecutors: ["uia"], preferredExecutors: ["keyboard"] };

/** The PowerShell road's own words for a read-only field, as win2 collected them (`RESULTS-622.md`). */
const READ_ONLY_PS = new Error('Exception calling "SetValue" with "1" argument(s): "Value is read-only."');

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => { throw READ_ONLY_PS; }),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

function receipt(
  receiverHwnd: bigint | null,
  receiverRect: KeyboardReceipt["receiverRect"],
  { cls = EDIT_CLASS, root = HWND as bigint | null, style = WRITABLE as number | null } = {},
): KeyboardReceipt {
  return { windowHwnd: HWND, receiverHwnd, receiverClass: cls, receiverRect, receiverRootHwnd: root, receiverStyle: style };
}

const writesTo = (r: KeyboardReceipt | undefined) => vi.fn(async () => r);

function keyboardRows(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.seam === "act.route" && r.route === "keyboard");
}

async function typeInto(entity: UiEntity, d: ExecutorDeps) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(aim, d)(entity, "type", "PROBE-F2");
}

describe("the rung that falls back from the value road", () => {
  it("names the failure the value road met, and the handle its characters went to (a1ii)", async () => {
    const d = deps({ keyboardTypeBg: writesTo(receipt(BESIDE, BESIDE_RECT)) });
    expect(await typeInto(delta, d)).toBe("keyboard");
    expect(keyboardRows()).toHaveLength(1);
    expect(keyboardRows()[0]).toMatchObject({
      why: "uia_set_value_failed",
      valueRoadFailure: "element_read_only",
      receiver: {
        hwnd: BESIDE.toString(), windowHwnd: HWND.toString(), isWindowItself: false,
        rootHwnd: HWND.toString(), inWindow: true,
        className: EDIT_CLASS, rect: BESIDE_RECT, style: WRITABLE, editReadOnly: false,
      },
      entityRect: DELTA_RECT,
      entityControlType: "Edit",
      entityCenterInReceiver: false,
    });
  });

  it("says the named field would not take the characters when it held the focus itself (a1i, PowerShell road)", async () => {
    // The characters went to the field the caller named, and nothing was written. The rects agree,
    // so the rect alone cannot say it failed; the style can.
    const d = deps({ keyboardTypeBg: writesTo(receipt(DELTA, DELTA_RECT, { style: READ_ONLY_STYLE })) });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({
      valueRoadFailure: "element_read_only",
      receiver: { editReadOnly: true },
      entityCenterInReceiver: true,
    });
  });

  it("says so on the title road too, where the native road's words are ones the classifier does not know (a1i)", async () => {
    // The native road answers a read-only field in words the classifier does not name. Without the
    // style this row read like a rescue that landed (2ゲート目の指摘).
    const d = deps({
      uiaSetValue: vi.fn(async () => { throw new Error("a native-road answer the classifier does not know (a stand-in, not a measured string)"); }),
      keyboardTypeBg: writesTo(receipt(DELTA, DELTA_RECT, { style: READ_ONLY_STYLE })),
    });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({
      valueRoadFailure: "unclassified",
      receiver: { editReadOnly: true },
      entityCenterInReceiver: true,
    });
  });

  it("writes a failure the classifier does not know as unclassified, not as nothing", async () => {
    const d = deps({
      uiaSetValue: vi.fn(async () => { throw new Error("UIA setValue failed"); }),
      keyboardTypeBg: writesTo(receipt(BESIDE, BESIDE_RECT)),
    });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toHaveProperty("valueRoadFailure", "unclassified");
  });

  it("says when the receiver is in another top-level window, and does not read it as inside the field though it sits over it", async () => {
    // A dialog on the same thread, over the field on screen: the rects would agree, and it is still
    // not the field.
    const d = deps({ keyboardTypeBg: writesTo(receipt(BESIDE, DELTA_RECT, { root: DIALOG })) });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({
      receiver: { hwnd: BESIDE.toString(), isWindowItself: false, rootHwnd: DIALOG.toString(), inWindow: false },
      entityCenterInReceiver: null,
    });
  });

  it("says when the receiver is the window itself, and does not read its rect as containing the field", async () => {
    // A thread with no focused window, as a WPF window's is. Its rect holds every field in the window,
    // so a "centre inside" reading would be true whatever happened.
    const d = deps({ keyboardTypeBg: writesTo(receipt(HWND, WINDOW_RECT, { cls: "HwndWrapper[App;;x]" })) });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({
      receiver: { hwnd: HWND.toString(), isWindowItself: true, inWindow: true, className: "HwndWrapper[App;;x]", editReadOnly: null },
      entityCenterInReceiver: null,
    });
  });

  it("writes what it cannot answer as null, not as false: a receipt with no receiver", async () => {
    const d = deps({ keyboardTypeBg: writesTo(receipt(null, null, { cls: undefined as unknown as string, root: null, style: null })) });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({
      receiver: { hwnd: null, isWindowItself: null, rootHwnd: null, inWindow: null, editReadOnly: null },
      entityCenterInReceiver: null,
    });
  });

  it("records the receiver as null when the backend did not say, rather than leaving it out", async () => {
    const d = deps(); // resolves to nothing, as every backend did before this
    expect(await typeInto(delta, d)).toBe("keyboard");
    const row = keyboardRows()[0]!;
    expect(row).toHaveProperty("receiver", null);
    expect(row).toHaveProperty("entityCenterInReceiver", null);
    expect(row).toHaveProperty("entityRect", DELTA_RECT);
  });

  it("does not turn a write that happened into a failure when the record cannot be read, and keeps what it did read", async () => {
    // The characters are already posted. A throw while writing the row would reach the rung's catch
    // and answer "background write failed too".
    const malformed = { receiverHwnd: BESIDE } as unknown as KeyboardReceipt;
    const d = deps({ keyboardTypeBg: writesTo(malformed) });
    expect(await typeInto(delta, d)).toBe("keyboard");
    expect(keyboardRows()[0]).toMatchObject({
      why: "uia_set_value_failed",
      landingError: true,
      valueRoadFailure: "element_read_only",
      entityRect: DELTA_RECT,
      entityControlType: "Edit",
    });
  });

  it("writes neither the typed text nor the backend's message", async () => {
    const d = deps({ keyboardTypeBg: writesTo(receipt(BESIDE, BESIDE_RECT)) });
    await typeInto(delta, d);
    const raw = readFileSync(logPath, "utf8");
    expect(raw).not.toContain("PROBE-F2");
    expect(raw).not.toContain("read-only.");
  });
});

describe("the receiver's read-only bit is read only on an edit control", () => {
  it.each([
    "Edit",
    "RichEdit20W",
    "RICHEDIT50W",
    "RichEditD2DPT",
    "WindowsForms10.EDIT.app.0.1",
    "WindowsForms10.RichEdit20W.app.0.1",
  ])("reads ES_READONLY on %s", async (cls) => {
    await typeInto(delta, deps({ keyboardTypeBg: writesTo(receipt(DELTA, DELTA_RECT, { cls, style: READ_ONLY_STYLE })) }));
    await typeInto(delta, deps({ keyboardTypeBg: writesTo(receipt(DELTA, DELTA_RECT, { cls, style: WRITABLE })) }));
    expect(keyboardRows().map((r) => (r.receiver as { editReadOnly: unknown }).editReadOnly)).toEqual([true, false]);
  });

  it.each([
    "HwndWrapper[NotEditor.exe;;5d2c]", // a WPF window whose program's name says "edit"
    "TSynEdit", // a custom editor that keeps ReadOnly as a property
    "VsTextEditPane",
    "Button", // 0x0800 is BS_BOTTOM here
  ])("writes null for %s, whose bit 0x0800 does not mean read-only", async (cls) => {
    await typeInto(delta, deps({ keyboardTypeBg: writesTo(receipt(BESIDE, BESIDE_RECT, { cls, style: READ_ONLY_STYLE })) }));
    expect(keyboardRows()[0]).toMatchObject({ receiver: { className: cls, style: READ_ONLY_STYLE, editReadOnly: null } });
  });
});

describe("the keyboard-only road", () => {
  it("carries the same facts, with no value road to name", async () => {
    const d = deps({ keyboardTypeBg: writesTo(receipt(BESIDE, BESIDE_RECT)) });
    expect(await typeInto(keyboardOnly, d)).toBe("keyboard");
    expect(d.uiaSetValue).not.toHaveBeenCalled();
    expect(keyboardRows()[0]).toMatchObject({
      why: "keyboard_only_entity",
      valueRoadFailure: null,
      receiver: { hwnd: BESIDE.toString(), isWindowItself: false, inWindow: true },
      entityCenterInReceiver: false,
    });
  });

  it("answers the same when the record cannot be read", async () => {
    const d = deps({ keyboardTypeBg: writesTo({ receiverHwnd: BESIDE } as unknown as KeyboardReceipt) });
    expect(await typeInto(keyboardOnly, d)).toBe("keyboard");
    expect(keyboardRows()[0]).toMatchObject({ why: "keyboard_only_entity", landingError: true, entityRect: DELTA_RECT });
  });
});

describe("the real backend", () => {
  /** The window, a post that resolved the focus, and the reads the record costs. */
  async function typeThroughTheRealBackend() {
    const getWindowClassName = vi.fn(() => EDIT_CLASS);
    const getWindowRectByHwnd = vi.fn(() => BESIDE_RECT);
    const getWindowRoot = vi.fn(() => HWND);
    const getWindowStyle = vi.fn(() => READ_ONLY_STYLE);
    const postCharsToHwnd = vi.fn((_hwnd: unknown, text: string) => ({ sent: text.length, full: true, target: BESIDE }));
    vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
      enumWindowsInZOrder: () => [{ hwnd: HWND, title: "RFS-CELL" }],
      getWindowClassName,
      getWindowRectByHwnd,
      getWindowRoot,
      getWindowStyle,
    }));
    vi.doMock("../../src/engine/bg-input.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/bg-input.js")>()),
      canInjectAtTarget: () => ({ supported: true }),
      postCharsToHwnd,
    }));
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const result = await createDesktopExecutor(aim)(keyboardOnly, "type", "PROBE-F2");
    return { result, reads: [getWindowClassName, getWindowRectByHwnd, getWindowRoot, getWindowStyle], postCharsToHwnd };
  }

  it("names the handle the post resolved, not a second reading of the focus", async () => {
    const { result, reads } = await typeThroughTheRealBackend();
    expect(result).toBe("keyboard");
    for (const read of reads) expect(read).toHaveBeenCalledWith(BESIDE);
    expect(keyboardRows()[0]).toMatchObject({
      receiver: {
        hwnd: BESIDE.toString(), windowHwnd: HWND.toString(), isWindowItself: false,
        rootHwnd: HWND.toString(), inWindow: true,
        className: EDIT_CLASS, rect: BESIDE_RECT, style: READ_ONLY_STYLE, editReadOnly: true,
      },
    });
  });

  it("with the probe off, reads nothing more and answers the same", async () => {
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
    const { result, reads, postCharsToHwnd } = await typeThroughTheRealBackend();
    expect(result).toBe("keyboard");
    expect(postCharsToHwnd).toHaveBeenCalledWith(HWND, "PROBE-F2");
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(keyboardRows()).toEqual([]);
  });
});

describe("getWindowStyle", () => {
  async function styleWhenNativeAnswers(answer: () => number) {
    vi.doMock("../../src/engine/native-engine.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/native-engine.js")>()),
      nativeWin32: { win32GetWindowLongPtrW: vi.fn(answer) },
    }));
    const { getWindowStyle } = await import("../../src/engine/win32.js");
    return getWindowStyle(HWND);
  }

  it("reads the native i32 as unsigned, so a popup's WS_POPUP is not a negative number", async () => {
    expect(await styleWhenNativeAnswers(() => -2147483648)).toBe(0x80000000);
  });

  it("reads 0 as 'could not say': the native call answers 0 for a handle that has gone", async () => {
    expect(await styleWhenNativeAnswers(() => 0)).toBeNull();
  });

  it("reads a throw as 'could not say'", async () => {
    expect(await styleWhenNativeAnswers(() => { throw new Error("gone"); })).toBeNull();
  });
});
