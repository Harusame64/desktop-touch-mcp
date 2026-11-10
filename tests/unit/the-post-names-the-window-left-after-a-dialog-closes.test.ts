/**
 * internal #284: `post.focusedWindow` was read once, right after the handler returned. An act that closes a
 * dialog returned before the dialog was destroyed, so the post named the dialog: on win2 (2026-11-10, main
 * bff4db3b) click_element on Notepad's 名前を付けて保存 → キャンセル answered "名前を付けて保存" 9 times in
 * 10, and a MessageBox's OK "確認" 20 in 20. When the foreground is dialog-shaped, the read now waits a
 * little for it to go away and reads again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { reads: [] as unknown[][], gone: new Set<bigint>(), readCount: 0, goneAfterChecks: 0, checks: 0 },
}));
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => {
    const i = Math.min(state.readCount, state.reads.length - 1);
    state.readCount++;
    return state.reads[i] ?? [];
  }),
  getWindowProcessId: vi.fn(() => 42),
  getProcessIdentityByPid: vi.fn(() => ({ pid: 42, processName: "x", processStartTimeMs: 1 })),
  isWindowGone: vi.fn((h: bigint) => {
    state.checks++;
    return state.gone.has(h) && state.checks > state.goneAfterChecks;
  }),
}));
vi.mock("../../src/engine/uia-bridge.js", () => ({ getFocusedAndPointInfo: vi.fn().mockResolvedValue({ focused: null }) }));

const { withPostState, __setSettleSleepForTest, DIALOG_SETTLE_MS } = await import("../../src/tools/_post.js");
const { ok } = await import("../../src/tools/_types.js");

const win = (hwnd: bigint, title: string, over: Record<string, unknown> = {}) => ({ hwnd, title, isActive: true, className: "Notepad", ownerHwnd: null, ...over });
const sleeps: number[] = [];
__setSettleSleepForTest(async (ms) => { sleeps.push(ms); });

async function post(): Promise<Record<string, unknown>> {
  state.readCount = 0;
  state.checks = 0;
  sleeps.length = 0;
  const wrapped = withPostState("click_element", async () => ok({ ok: true }));
  const r = await wrapped({});
  return (JSON.parse(r.content[0]!.text) as { post: Record<string, unknown> }).post;
}

afterEach(() => {
  state.reads = [];
  state.gone = new Set();
  state.goneAfterChecks = 0;
});

describe("post.focusedWindow after an act that closes a dialog", () => {
  it("a Save As that the act cancelled: names the window left, not the dialog", async () => {
    const dialog = win(2n, "名前を付けて保存", { className: "#32770", ownerHwnd: 1n });
    const notepad = win(1n, "無題 - メモ帳");
    // before, after (still the dialog), then the re-read once it is gone
    state.reads = [[dialog], [dialog], [notepad]];
    state.gone = new Set([2n]);
    state.goneAfterChecks = 2; // destroyed a little after the handler returned
    const p = await post();
    expect(p.focusedWindow).toBe("無題 - メモ帳");
    expect(p).not.toHaveProperty("focusedWindowUnread");
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("an ownerless MessageBox (#32770) that closed: names whatever has the foreground now", async () => {
    const box = win(3n, "確認", { className: "#32770" });
    const chrome = win(4n, "Claude Code - Google Chrome", { className: "Chrome_WidgetWin_1" });
    state.reads = [[box], [box], [chrome]];
    state.gone = new Set([3n]);
    expect((await post()).focusedWindow).toBe("Claude Code - Google Chrome");
  });

  it("a dialog that stays (the act did not close it) is answered as read, after the wait", async () => {
    const dialog = win(2n, "名前を付けて保存", { className: "#32770", ownerHwnd: 1n });
    state.reads = [[dialog]];
    const p = await post();
    expect(p.focusedWindow).toBe("名前を付けて保存");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(DIALOG_SETTLE_MS);
  });

  it("an ordinary window is not waited for", async () => {
    state.reads = [[win(1n, "無題 - メモ帳")]];
    const p = await post();
    expect(p.focusedWindow).toBe("無題 - メモ帳");
    expect(sleeps).toEqual([]);
  });

  it("when the re-read finds no foreground: null, and says why", async () => {
    const box = win(3n, "確認", { className: "#32770" });
    state.reads = [[box], [box], []];
    state.gone = new Set([3n]);
    const p = await post();
    expect(p.focusedWindow).toBeNull();
    expect(p.focusedWindowUnread).toBe("foreground_unreadable");
  });
});
