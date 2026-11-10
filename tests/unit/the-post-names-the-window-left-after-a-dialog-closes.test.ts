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
    expect(clock.slept).toBeLessThan(DIALOG_SETTLE_MS + 20);
  });
  it("the re-read finds the front window not listed: null, and says so", async () => {
    state.reads = [[box], [box], []];
    state.fg = [9n];
    const p = await post();
    expect(p!.focusedWindow).toBeNull();
    expect(p!.focusedWindowUnread).toBe("foreground_not_listed");
  });
});

describe("no wait where the act cannot have closed it", () => {
  it.each([
    ["a dialog the act opened (not in front before)", [[notepad], [saveAs, notepadBlocked]]],
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
