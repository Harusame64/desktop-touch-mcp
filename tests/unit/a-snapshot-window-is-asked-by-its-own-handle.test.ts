/**
 * internal #211 items 2 and 9 — a `Window` of the `desktop_discover` snapshot is asked about by its
 * own handle before it refuses an act.
 *
 * MEASURED win2 (internal #212): Calculator's own title bar (`ApplicationFrameTitleBarWindow`, a
 * `WS_CHILD` of its frame) was named as the modal blocking its own "±" button on every act (item 2);
 * and a dialog that had closed since the read was still named as the blocker, sending the caller to
 * a window that was not there (item 9).
 *
 * What still refuses, and must: an owned dialog (a top-level window of its own), a MessageBox, and a
 * window the OS could not be asked about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SnapshotWindowAnswer } from "../../src/engine/world-graph/guarded-touch.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";
import { _resetFacadeForTest, getDesktopFacade, productionJudgeSnapshotWindow } from "../../src/tools/desktop-register.js";

function uiaEntity(opts: Partial<UiEntity> & { hwnd?: string } = {}): UiEntity {
  const { hwnd, ...rest } = opts;
  return {
    entityId: "e",
    role: "button",
    label: "±",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [],
    generation: "g",
    evidenceDigest: "d",
    ...(hwnd !== undefined && { locator: { uia: { name: "x", nativeWindowHandle: hwnd } } }),
    ...rest,
  };
}

const windowAt = (hwnd: string | undefined) => uiaEntity({ entityId: "w", role: "unknown", label: "W", controlType: "Window", hwnd });

/**
 * A little desktop: each handle's root. A handle it does not list is not a window.
 */
function deps(desktop: Record<string, bigint>, over: Record<string, unknown> = {}) {
  return {
    isAlive: (h: bigint) => desktop[h.toString()] !== undefined,
    root: (h: bigint) => desktop[h.toString()] ?? null,
    identityNow: () => undefined,
    ...over,
  };
}

// Calculator: the frame 500 and its title bar 501, a WS_CHILD of it. The "±" button is handle-less,
// read from the frame. A dialog 777 owned by the frame is a top-level window: its own root. 790 is
// a child window inside that dialog (a XAML island, an HwndHost).
const calculator: Record<string, bigint> = { "500": 500n, "501": 500n, "777": 777n, "790": 777n };
const plusMinus = uiaEntity({ entityId: "pm", origin: { kind: "window", id: "Calculator", hwnd: "500" } });
const aimAt = (hwnd: bigint) => ({ kind: "aim", hwnd }) as unknown as Parameters<typeof productionJudgeSnapshotWindow>[2];

describe("productionJudgeSnapshotWindow", () => {
  it("answers not_a_dialog for a child window of the element's own frame — Calculator's title bar", () => {
    expect(productionJudgeSnapshotWindow(windowAt("501"), plusMinus, undefined, deps(calculator))).toBe("not_a_dialog");
  });

  it("answers not_a_dialog for the element's own top-level window", () => {
    expect(productionJudgeSnapshotWindow(windowAt("500"), plusMinus, undefined, deps(calculator))).toBe("not_a_dialog");
  });

  it("answers may_block for an owned dialog: a top-level window of its own, not the element's", () => {
    expect(productionJudgeSnapshotWindow(windowAt("777"), plusMinus, undefined, deps(calculator))).toBe("may_block");
  });

  it("answers may_block for a child window inside ANOTHER top-level window — the dialog's content (gate 2)", () => {
    expect(productionJudgeSnapshotWindow(windowAt("790"), plusMinus, undefined, deps(calculator))).toBe("may_block");
  });

  it("does not waive a child window when there is no window of the element's to compare", () => {
    const bare = uiaEntity({ entityId: "bare" });
    expect(productionJudgeSnapshotWindow(windowAt("501"), bare, undefined, deps(calculator))).toBe("may_block");
  });

  it("reaches the element's top-level window from its OWN handle", () => {
    const desktop = { ...calculator, "888": 777n };
    // The dialog's own "OK" (handle 888, inside 777), read from the frame: not blocked by the dialog it sits in.
    const ok = uiaEntity({ entityId: "ok", hwnd: "888", origin: { kind: "window", id: "Calculator", hwnd: "500" } });
    expect(productionJudgeSnapshotWindow(windowAt("777"), ok, undefined, deps(desktop))).toBe("not_a_dialog");
  });

  it("reaches it from the aim when the element recorded no handle", () => {
    const bare = uiaEntity({ entityId: "bare" });
    expect(productionJudgeSnapshotWindow(windowAt("501"), bare, aimAt(500n), deps(calculator))).toBe("not_a_dialog");
    expect(productionJudgeSnapshotWindow(windowAt("777"), bare, aimAt(500n), deps(calculator))).toBe("may_block");
  });

  it("does not use the aim once its handle names another process's window", async () => {
    const { compareAimIdentity } = await import("../../src/engine/aim.js");
    const bare = uiaEntity({ entityId: "bare" });
    const aim = { kind: "aim", hwnd: 500n, identity: { pid: 1, processName: "calc", processStartTimeMs: 1 } } as unknown as Parameters<typeof productionJudgeSnapshotWindow>[2];
    const other = { pid: 2, processName: "other", processStartTimeMs: 2 };
    // The cell rests on the comparison calling this identity changed; say so, or it proves nothing.
    expect(compareAimIdentity(aim!, other)).toBe("changed");
    expect(productionJudgeSnapshotWindow(windowAt("501"), bare, aim, deps(calculator, { identityNow: () => other }))).toBe("may_block");
  });

  it("drops the recorded handle with the aim when it is the aim's recycled handle (gate 2, round 2)", () => {
    const aim = { kind: "aim", hwnd: 500n, identity: { pid: 1, processName: "calc", processStartTimeMs: 1 } } as unknown as Parameters<typeof productionJudgeSnapshotWindow>[2];
    const other = { pid: 2, processName: "other", processStartTimeMs: 2 };
    expect(productionJudgeSnapshotWindow(windowAt("501"), plusMinus, aim, deps(calculator, { identityNow: () => other }))).toBe("may_block");
    // …and kept while the aim still names its owner.
    const same = { pid: 1, processName: "calc", processStartTimeMs: 1 };
    expect(productionJudgeSnapshotWindow(windowAt("501"), plusMinus, aim, deps(calculator, { identityNow: () => same }))).toBe("not_a_dialog");
  });

  it("answers closed when the handle is not a window any more, and the element's window still is", () => {
    expect(productionJudgeSnapshotWindow(windowAt("999"), plusMinus, undefined, deps(calculator))).toBe("closed");
  });

  it("answers not_a_dialog, not closed, when the element's own window has closed too — aim_window_gone is the executor's", () => {
    const desktop = { "777": 777n };
    expect(productionJudgeSnapshotWindow(windowAt("501"), plusMinus, undefined, deps(desktop))).toBe("not_a_dialog");
  });

  it("answers closed for a button of the closed dialog, read from a frame that is still there (win2 arm 9b)", () => {
    // The button's own handle 888 went with the dialog 777; the frame 500 it was read from did not.
    const cancel = uiaEntity({ entityId: "cancel", hwnd: "888", origin: { kind: "window", id: "Notepad", hwnd: "500" } });
    expect(productionJudgeSnapshotWindow(windowAt("777"), cancel, undefined, deps({ "500": 500n }))).toBe("closed");
  });

  it("answers closed when the element recorded no window to ask", () => {
    const bare = uiaEntity({ entityId: "bare" });
    expect(productionJudgeSnapshotWindow(windowAt("999"), bare, undefined, deps(calculator))).toBe("closed");
  });

  it("answers may_block, not closed, when the OS could not be asked", () => {
    expect(productionJudgeSnapshotWindow(windowAt("999"), plusMinus, undefined, deps(calculator, { isAlive: () => undefined }))).toBe("may_block");
  });

  it("answers may_block for a window with no handle, or a zero handle however it is written", () => {
    expect(productionJudgeSnapshotWindow(windowAt(undefined), plusMinus, undefined, deps(calculator))).toBe("may_block");
    expect(productionJudgeSnapshotWindow(windowAt("00"), plusMinus, undefined, deps(calculator))).toBe("may_block");
  });

  it("answers may_block, not a pass, when a read throws", () => {
    const d = deps(calculator, { root: () => { throw new Error("gone"); } });
    expect(productionJudgeSnapshotWindow(windowAt("501"), plusMinus, undefined, d)).toBe("may_block");
  });
});

// ── Through the facade and the registry's defaults ────────────────────────────

function candidate(opts: Partial<UiEntityCandidate>): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "Calculator" },
    label: "±",
    role: "button",
    rect: { x: 10, y: 10, width: 60, height: 20 },
    actionability: ["click", "invoke"],
    confidence: 0.9,
    observedAtMs: 0,
    provisional: false,
    ...opts,
  } as unknown as UiEntityCandidate;
}

const button = candidate({ locator: { uia: { name: "±", automationId: "negateButton" } } });
const window = (label: string, hwnd: string) =>
  candidate({ label, role: "unknown", actionability: [], controlType: "Window", rect: { x: 0, y: 0, width: 300, height: 30 }, locator: { uia: { name: label, nativeWindowHandle: hwnd } } } as Partial<UiEntityCandidate>);

async function act(snapshot: UiEntityCandidate[], judge?: (w: UiEntity) => SnapshotWindowAnswer, over: Record<string, unknown> = {}) {
  const execute = vi.fn(async () => "uia" as const);
  const judgeSnapshotWindow = judge ? vi.fn((w: UiEntity) => judge(w)) : undefined;
  const facade = new DesktopFacade(async () => snapshot, { executorFn: execute, ...(judgeSnapshotWindow && { judgeSnapshotWindow }), ...over });
  const view = await facade.see({ target: { windowTitle: "Calculator" } });
  const target = view.entities.find((e) => e.label === "±")!;
  const result = await facade.touch({ lease: target.lease });
  return { result, execute, judgeSnapshotWindow };
}

const byLabel = (answers: Record<string, SnapshotWindowAnswer>) => (w: UiEntity) => answers[w.label ?? ""] ?? "may_block";

describe("the registry counts only the windows the OS says may block", () => {
  it("presses when the only Window is not a dialog (Calculator's title bar)", async () => {
    const { result, execute } = await act([button, window("Calculator", "501")], byLabel({ Calculator: "not_a_dialog" }));
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("still refuses modal_blocking on a Window that may block, naming it", async () => {
    const { result, execute } = await act([button, window("Save changes?", "777")], byLabel({}));
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Save changes?", hwnd: "777" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("names the dialog that may block, not the title bar beside it", async () => {
    const { result } = await act(
      [button, window("Calculator", "501"), window("Save changes?", "777")],
      byLabel({ Calculator: "not_a_dialog" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Save changes?" } });
  });

  it("refuses lease_generation_mismatch, naming the window, when a listed window has closed", async () => {
    const { result, execute } = await act([button, window("Delete item?", "777")], byLabel({ "Delete item?": "closed" }));
    expect(result).toEqual({
      ok: false,
      reason: "lease_generation_mismatch",
      diff: [],
      detail: 'the window "Delete item?" (hwnd 777) that desktop_discover listed has closed since that read',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses modal_blocking, not the stale snapshot, when one window closed and another may block", async () => {
    const { result } = await act(
      [button, window("Delete item?", "778"), window("Save changes?", "777")],
      byLabel({ "Delete item?": "closed" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Save changes?" } });
  });

  it("counts every Window, as before, when the OS is not asked", async () => {
    const { result, execute } = await act([button, window("Calculator", "501")]);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Calculator" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("names the FIRST window that may block, as the snapshot finder did", async () => {
    const { result } = await act([button, window("Save changes?", "777"), window("Replace", "778")], byLabel({}));
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Save changes?" } });
  });

  it("does not present a role as the title of an untitled closed window", async () => {
    const untitled = candidate({ label: "", role: "unknown", actionability: [], controlType: "Window", rect: { x: 0, y: 0, width: 300, height: 30 }, locator: { uia: { name: "", nativeWindowHandle: "777" } } } as Partial<UiEntityCandidate>);
    const { result } = await act([button, untitled], () => "closed");
    expect(result).toMatchObject({ ok: false, reason: "lease_generation_mismatch", detail: "a window (hwnd 777) that desktop_discover listed has closed since that read" });
  });

  it("names the FIRST window that has closed", async () => {
    const { result } = await act(
      [button, window("Delete item?", "777"), window("Confirm", "778")],
      byLabel({ "Delete item?": "closed", Confirm: "closed" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "lease_generation_mismatch", detail: expect.stringContaining("hwnd 777") });
  });

  it("names the window it counted: each window is asked once per check (gate 2)", async () => {
    // A dialog that closes between two questions. Asked twice, the refusal said modal_blocking and
    // then found no blocker to name.
    const seen = new Map<string, number>();
    const judge = (w: UiEntity): SnapshotWindowAnswer => {
      const n = (seen.get(w.entityId) ?? 0) + 1;
      seen.set(w.entityId, n);
      return n === 1 ? "may_block" : "closed";
    };
    const { result } = await act([button, window("Save changes?", "777")], judge);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Save changes?", hwnd: "777" } });
  });

  it("does not ask the OS about a Window when a custom modal predicate is the whole answer", async () => {
    const { result, judgeSnapshotWindow } = await act(
      [button, window("Delete item?", "777")],
      byLabel({ "Delete item?": "closed" }),
      { isModalBlocking: () => false },
    );
    expect(result.ok).toBe(true);
    expect(judgeSnapshotWindow).not.toHaveBeenCalled();
  });
});

describe("the set-aside row names what the check counts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-window-"));
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = join(dir, "aim-probe.jsonl");
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes no set-aside row for a title bar the OS says is not a dialog (gate 2, round 2)", async () => {
    const { DesktopFacade: Facade } = await import("../../src/tools/desktop.js");
    const facade = new Facade(async () => [button, window("Calculator", "501"), window("Save changes?", "777")], {
      executorFn: async () => "uia",
      findBlockingWindow: () => ({ kind: "takes_input" as const }),
      judgeSnapshotWindow: (w: UiEntity) => (w.label === "Calculator" ? "not_a_dialog" : "may_block"),
    });
    const view = await facade.see({ target: { windowTitle: "Calculator" } });
    const result = await facade.touch({ lease: view.entities.find((e) => e.label === "±")!.lease });
    expect(result.ok).toBe(true);
    const path = join(dir, "aim-probe.jsonl");
    const rows = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    const setAside = rows.filter((r) => r.answer === "snapshot_set_aside");
    // The row is there, and it names the dialog the check would count — not the title bar before it.
    expect(setAside.length).toBeGreaterThan(0);
    expect(setAside.every((r) => r.snapshotBlocker === "Save changes?")).toBe(true);
  });
});

describe("the production wiring reaches the registry", () => {
  it("registers productionJudgeSnapshotWindow on the production facade", () => {
    const facade = getDesktopFacade();
    try {
      expect((facade as unknown as { opts: { judgeSnapshotWindow?: unknown } }).opts.judgeSnapshotWindow).toBe(productionJudgeSnapshotWindow);
    } finally {
      _resetFacadeForTest();
    }
  });
});
