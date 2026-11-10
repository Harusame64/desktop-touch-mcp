/**
 * internal #284: `post.focusedWindow` was read once, right after the handler returned. An act that closes a
 * dialog returned before the dialog let go of the foreground, so the post named the dialog: on win2
 * (2026-11-10, main bff4db3b) click_element on Notepad's 名前を付けて保存 → キャンセル answered
 * "名前を付けて保存" 9 times in 10, and a MessageBox's OK "確認" 20 in 20. When the same modal dialog was in
 * front before and after a successful act, the read now waits, by the clock, for the foreground to move.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { reads: [] as unknown[][], readCount: 0, fg: [] as (bigint | null)[], fgCount: 0, readFn: undefined as undefined | (() => unknown[]) },
}));
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => {
      if (state.readFn) return state.readFn();
      const i = Math.min(state.readCount, state.reads.length - 1);
      state.readCount++;
      return state.reads[i] ?? [];
    }),
    getWindowProcessId: vi.fn(() => 42),
    getProcessIdentityByPid: vi.fn(() => ({ pid: 42, processName: "x", processStartTimeMs: 1 })),
    getForegroundHwnd: vi.fn(() => {
      const i = Math.min(state.fgCount, state.fg.length - 1);
      state.fgCount++;
      return state.fg[i] ?? null;
    }),
  };
});
vi.mock("../../src/engine/uia-bridge.js", () => ({ getFocusedAndPointInfo: vi.fn().mockResolvedValue({ focused: null }) }));

const { withPostState, __setSettleClockForTest, DIALOG_SETTLE_MS } = await import("../../src/tools/_post.js");
const { ok, fail } = await import("../../src/tools/_types.js");

// A fake clock: each sleep advances it by what was asked, plus Windows' timer overshoot.
const clock = { ms: 0, slept: 0 };
__setSettleClockForTest(async (ms) => { clock.ms += ms + 6; clock.slept += ms + 6; }, () => clock.ms);

const win = (hwnd: bigint, title: string, over: Record<string, unknown> = {}) =>
  ({ hwnd, title, isActive: true, isEnabled: true, className: "Notepad", ownerHwnd: null, ...over });
const notepad = win(1n, "無題 - メモ帳");
const notepadBlocked = win(1n, "無題 - メモ帳", { isActive: false, isEnabled: false });
const saveAs = win(2n, "名前を付けて保存", { className: "#32770", ownerHwnd: 1n });
const box = win(3n, "確認", { className: "#32770" });

async function post(handlerOk = true): Promise<Record<string, unknown> | undefined> {
  state.readCount = 0;
  state.fgCount = 0;
  clock.slept = 0;
  const wrapped = withPostState("click_element", async () =>
    handlerOk ? ok({ ok: true }) : fail({ ok: false, code: "ToolError", error: "x", _perceptionForPost: { kind: "auto" } } as never));
  const r = await wrapped({});
  return (JSON.parse(r.content[0]!.text) as { post?: Record<string, unknown> }).post;
}

beforeEach(() => { state.reads = []; state.fg = []; state.readFn = undefined; });

describe("the act closed the dialog that was in front", () => {
  it("Save As → キャンセル: names Notepad, once the foreground has moved", async () => {
    // before, after: the dialog; the re-read: Notepad
    state.reads = [[saveAs, notepadBlocked], [saveAs, notepadBlocked], [notepad]];
    state.fg = [2n, 2n, 1n]; // still the dialog for two checks, then Notepad
    const p = await post();
    expect(p!.focusedWindow).toBe("無題 - メモ帳");
    expect(p!.windowChanged).toBe(true);
    expect(p).not.toHaveProperty("focusedWindowUnread");
  });
  it("an ownerless MessageBox: names whatever is in front now", async () => {
    const chrome = win(4n, "Claude Code - Google Chrome", { className: "Chrome_WidgetWin_1" });
    state.reads = [[box], [box], [chrome]];
    state.fg = [4n];
    expect((await post())!.focusedWindow).toBe("Claude Code - Google Chrome");
  });
  it("a moment of no foreground is not the answer: it keeps waiting", async () => {
    // What the window list shows follows the foreground: the box until it has moved, Notepad after.
    state.readFn = () => (state.fgCount >= 3 ? [notepad] : [box]);
    state.fg = [null, null, 1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
  it("a dialog hidden rather than destroyed: the foreground moving is what counts", async () => {
    state.reads = [[saveAs, notepadBlocked], [saveAs, notepadBlocked], [notepad]];
    state.fg = [1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
  it("a dialog that stays is answered as read, after the wait measured by the clock", async () => {
    state.reads = [[box]];
    state.fg = [3n];
    const p = await post();
    expect(p!.focusedWindow).toBe("確認");
    expect(clock.slept).toBeGreaterThanOrEqual(DIALOG_SETTLE_MS);
    // The last sleep is cut to what is left, so the clock passes the deadline by one overshoot (6) at most.
    expect(clock.slept).toBeLessThanOrEqual(DIALOG_SETTLE_MS + 6);
  });
  it("the re-read finds the front window not listed: null, and says so", async () => {
    state.reads = [[box], [box], []];
    state.fg = [9n];
    const p = await post();
    expect(p!.focusedWindow).toBeNull();
    expect(p!.focusedWindowUnread).toBe("foreground_not_listed");
    // An unlisted window in front may be passing through: it waits for a listed one until the deadline.
    expect(clock.slept).toBeGreaterThanOrEqual(DIALOG_SETTLE_MS);
  });
});

describe("gate 2 on #933: the dialog read while it blocked, or brought forward by the act", () => {
  it("the first read after the act finds no listed window (the dialog hidden): still waits, names Notepad", async () => {
    state.reads = [[saveAs, notepadBlocked], [], [notepad]];
    state.fg = [2n, 1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
  it("the owner is enabled again by the first read: the dialog was modal before, so it waits", async () => {
    const wpf = win(6n, "確認", { className: "HwndWrapper[App;;1]", ownerHwnd: 1n });
    state.reads = [[wpf, notepadBlocked], [wpf, win(1n, "無題 - メモ帳", { isActive: false })], [notepad]];
    state.fg = [6n, 1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
  it("the act brought the dialog forward and closed it (another window in front before)", async () => {
    const terminal = win(7n, "pwsh", { className: "CASCADIA_HOSTING_WINDOW_CLASS" });
    state.reads = [[terminal], [saveAs, notepadBlocked], [notepad]];
    state.fg = [2n, 1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
  it("a dialog the act opened is waited for, and answered as read when it stays", async () => {
    state.reads = [[notepad], [saveAs, notepadBlocked]];
    state.fg = [2n];
    expect((await post())!.focusedWindow).toBe("名前を付けて保存");
    expect(clock.slept).toBeGreaterThanOrEqual(DIALOG_SETTLE_MS);
  });
});

describe("gate 2 on #933, round 3", () => {
  it("a MessageBox owned by a hidden window (not listed) is modal: it waits", async () => {
    const owned = win(9n, "確認", { className: "#32770", ownerHwnd: 99n });
    state.reads = [[owned], [owned], [notepad]];
    state.fg = [9n, 1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
  it("no foreground until the deadline: the dialog that went is not named", async () => {
    state.readFn = () => (state.fgCount >= 1 ? [] : [box]);
    state.fg = [null];
    const p = await post();
    expect(p!.focusedWindow).toBeNull();
    expect(p!.focusedWindowUnread).toBe("foreground_not_listed");
  });
  it("activation passing back to the dialog is not the answer", async () => {
    // fg says Notepad for a moment, but the list still shows the dialog; then Notepad for real
    state.readFn = () => (state.fgCount >= 3 ? [notepad] : [saveAs, notepadBlocked]);
    state.fg = [1n, 2n, 1n];
    expect((await post())!.focusedWindow).toBe("無題 - メモ帳");
  });
});

describe("no wait where the act cannot have closed it", () => {
  it.each([
    ["a modeless dialog (#32770 whose owner stays enabled: Notepad's 検索)", [[win(8n, "検索", { className: "#32770", ownerHwnd: 1n }), win(1n, "Doc", { isActive: false })]]],
    ["an owned palette (its owner enabled)", [[win(5n, "Tools", { ownerHwnd: 1n }), win(1n, "Doc", { isActive: false })]]],
    ["an ordinary window", [[notepad]]],
  ])("%s", async (_n, reads) => {
    state.reads = reads as unknown[][];
    state.fg = [2n];
    await post();
    expect(clock.slept).toBe(0);
    expect(state.fgCount).toBe(0);
  });
  it("a failed act", async () => {
    state.reads = [[box]];
    state.fg = [3n];
    await post(false);
    expect(clock.slept).toBe(0);
  });
});
