/**
 * The keyboard rung says where its characters went — ADR-036 family 2, the observation before the change.
 *
 * `desktop_act` type falls back from the UIA value road to posting WM_CHAR to whichever child of the
 * window holds focus. It answers `ok:true` without asking whether that child is the field it was given.
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
const MOCKED = ["../../src/engine/win32.js", "../../src/engine/bg-input.js"];

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
const BESIDE = 5001n; // the field that held focus
const aim: Aim = { kind: "aim", title: "RFS-CELL", hwnd: HWND };

const DELTA_RECT = { x: 100, y: 200, width: 120, height: 24 }; // the field the caller named
const BESIDE_RECT = { x: 100, y: 240, width: 120, height: 24 };
const WINDOW_RECT = { x: 0, y: 0, width: 800, height: 600 };
const EDIT_CLASS = "WindowsForms10.EDIT.app.0.1";

const delta: UiEntity = {
  entityId: "u4", role: "textbox", label: "DELTA", confidence: 0.9, sources: ["uia"],
  locator: { uia: { name: "DELTA", automationId: "DELTA" } },
  affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
  generation: "gen-1", evidenceDigest: "d", rect: DELTA_RECT, controlType: "Edit",
};
const keyboardOnly: UiEntity = { ...delta, unsupportedExecutors: ["uia"], preferredExecutors: ["keyboard"] };

/** The backend's own words for a read-only field, as win2 collected them (`RESULTS-622.md`). */
const READ_ONLY = new Error('Exception calling "SetValue" with "1" argument(s): "Value is read-only."');

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => { throw READ_ONLY; }),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

function receipt(receiverHwnd: bigint | null, receiverRect: KeyboardReceipt["receiverRect"], receiverClass = EDIT_CLASS): KeyboardReceipt {
  return { windowHwnd: HWND, receiverHwnd, receiverClass, receiverRect };
}

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
  it("names the failure the value road met, and the handle its characters went to", async () => {
    const d = deps({ keyboardTypeBg: vi.fn(async () => receipt(BESIDE, BESIDE_RECT)) });
    expect(await typeInto(delta, d)).toBe("keyboard");
    expect(keyboardRows()).toHaveLength(1);
    expect(keyboardRows()[0]).toMatchObject({
      why: "uia_set_value_failed",
      valueRoadFailure: "element_read_only",
      receiver: {
        hwnd: BESIDE.toString(), windowHwnd: HWND.toString(), isWindowItself: false,
        className: EDIT_CLASS, rect: BESIDE_RECT,
      },
      entityRect: DELTA_RECT,
      entityControlType: "Edit",
      entityCenterInReceiver: false,
    });
  });

  it("reads the named field as the receiver when the rects say so — the value road's failure is what tells a1i from a write that landed", async () => {
    // a1i in #74: focus on the read-only field itself. The characters went to the field the caller
    // named, and nothing was written. The rects agree, so the rect alone cannot say it failed.
    const d = deps({ keyboardTypeBg: vi.fn(async () => receipt(BESIDE, DELTA_RECT)) });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({ valueRoadFailure: "element_read_only", entityCenterInReceiver: true });
  });

  it("writes a failure the classifier does not know as unclassified, not as nothing", async () => {
    const d = deps({
      uiaSetValue: vi.fn(async () => { throw new Error("UIA setValue failed"); }),
      keyboardTypeBg: vi.fn(async () => receipt(BESIDE, BESIDE_RECT)),
    });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toHaveProperty("valueRoadFailure", "unclassified");
  });

  it("says when the receiver is the window itself — a window with no focused child, as a WPF window is", async () => {
    const d = deps({ keyboardTypeBg: vi.fn(async () => receipt(HWND, WINDOW_RECT, "HwndWrapper[App;;x]")) });
    await typeInto(delta, d);
    expect(keyboardRows()[0]).toMatchObject({
      receiver: { hwnd: HWND.toString(), isWindowItself: true, className: "HwndWrapper[App;;x]" },
      entityCenterInReceiver: true,
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

  it("writes neither the typed text nor the backend's message", async () => {
    const d = deps({ keyboardTypeBg: vi.fn(async () => receipt(BESIDE, BESIDE_RECT)) });
    await typeInto(delta, d);
    const raw = readFileSync(logPath, "utf8");
    expect(raw).not.toContain("PROBE-F2");
    expect(raw).not.toContain("read-only.");
  });
});

describe("the keyboard-only road", () => {
  it("carries the same facts, with no value road to name", async () => {
    const d = deps({ keyboardTypeBg: vi.fn(async () => receipt(BESIDE, BESIDE_RECT)) });
    expect(await typeInto(keyboardOnly, d)).toBe("keyboard");
    expect(d.uiaSetValue).not.toHaveBeenCalled();
    expect(keyboardRows()[0]).toMatchObject({
      why: "keyboard_only_entity",
      valueRoadFailure: null,
      receiver: { hwnd: BESIDE.toString(), isWindowItself: false },
      entityCenterInReceiver: false,
    });
  });
});

describe("the real backend", () => {
  /** The window, a post that resolved the focused child, and the two reads the record costs. */
  async function typeThroughTheRealBackend() {
    const getWindowClassName = vi.fn(() => EDIT_CLASS);
    const getWindowRectByHwnd = vi.fn(() => BESIDE_RECT);
    const postCharsToHwnd = vi.fn((_hwnd: unknown, text: string) => ({ sent: text.length, full: true, target: BESIDE }));
    vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
      enumWindowsInZOrder: () => [{ hwnd: HWND, title: "RFS-CELL" }],
      getWindowClassName,
      getWindowRectByHwnd,
    }));
    vi.doMock("../../src/engine/bg-input.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/bg-input.js")>()),
      canInjectAtTarget: () => ({ supported: true }),
      postCharsToHwnd,
    }));
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const result = await createDesktopExecutor(aim)(keyboardOnly, "type", "PROBE-F2");
    return { result, getWindowClassName, getWindowRectByHwnd, postCharsToHwnd };
  }

  it("names the handle the post resolved, not a second reading of the focus", async () => {
    const { result, getWindowClassName, getWindowRectByHwnd } = await typeThroughTheRealBackend();
    expect(result).toBe("keyboard");
    expect(getWindowClassName).toHaveBeenCalledWith(BESIDE);
    expect(getWindowRectByHwnd).toHaveBeenCalledWith(BESIDE);
    expect(keyboardRows()[0]).toMatchObject({
      receiver: { hwnd: BESIDE.toString(), windowHwnd: HWND.toString(), isWindowItself: false, className: EDIT_CLASS, rect: BESIDE_RECT },
    });
  });

  it("with the probe off, reads nothing more and answers the same", async () => {
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
    const { result, getWindowClassName, getWindowRectByHwnd, postCharsToHwnd } = await typeThroughTheRealBackend();
    expect(result).toBe("keyboard");
    expect(postCharsToHwnd).toHaveBeenCalledWith(HWND, "PROBE-F2");
    expect(getWindowClassName).not.toHaveBeenCalled();
    expect(getWindowRectByHwnd).not.toHaveBeenCalled();
    expect(keyboardRows()).toEqual([]);
  });
});
