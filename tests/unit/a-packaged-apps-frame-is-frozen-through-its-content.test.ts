// Internal #250 — a packaged app's frame window is asked about through its content.
//
// The desktop is win2's (2026-10-27, read-only): Settings and Xbox hidden, their content top-level;
// Calculator shown, its content a child of the frame; an explorer.exe frame with no AUMID. The frame
// host's own process answers "frozen" here on purpose: it never is, so a frame read through its own
// pid would turn Xbox (hidden but running) into frozen and the cell would say so.

import { describe, it, expect, beforeEach, vi } from "vitest";

const AFH_PID = 900;
const SETTINGS = "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";
const XBOX = "Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.AppL";
const CALC = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
const TWICE = "Contoso.TwoWindows_abc!App";

const { desk } = vi.hoisted(() => {
  type W = { cls: string; pid: number; aumid?: string; children?: bigint[] };
  const windows = new Map<bigint, W>();
  const processes = new Map<number, { aumid?: string; frozen: boolean | null }>();
  const topLevel: bigint[] = [];
  const parentOf = new Map<bigint, bigint>();
  return { desk: { windows, processes, topLevel, parentOf } };
});

function reset(): void {
  desk.windows.clear(); desk.processes.clear(); desk.parentOf.clear(); desk.topLevel.length = 0;
  const top = (h: bigint, w: { cls: string; pid: number; aumid?: string; children?: bigint[] }) => {
    desk.windows.set(h, w); desk.topLevel.push(h);
    for (const c of w.children ?? []) desk.parentOf.set(c, h);
  };
  const child = (h: bigint, w: { cls: string; pid: number }) => desk.windows.set(h, w);
  desk.processes.set(AFH_PID, { frozen: true });
  // Settings: hidden and frozen, content top-level.
  top(264580n, { cls: "ApplicationFrameWindow", pid: AFH_PID, aumid: SETTINGS, children: [1n, 2n] });
  child(1n, { cls: "ApplicationFrameTitleBarWindow", pid: AFH_PID });
  child(2n, { cls: "Windows.UI.Input.InputSite.WindowClass", pid: AFH_PID });
  top(68014n, { cls: "Windows.UI.Core.CoreWindow", pid: 1001 });
  desk.processes.set(1001, { aumid: SETTINGS, frozen: true });
  // Xbox: hidden but running.
  top(262824n, { cls: "ApplicationFrameWindow", pid: AFH_PID, aumid: XBOX.toLowerCase() });
  top(133078n, { cls: "Windows.UI.Core.CoreWindow", pid: 1002 });
  desk.processes.set(1002, { aumid: XBOX, frozen: false });
  // Calculator: shown, content a child of the frame. A frozen top-level CoreWindow of the same app
  // is beside it, so a lookup that skipped the child would answer true.
  top(4786720n, { cls: "ApplicationFrameWindow", pid: AFH_PID, aumid: CALC, children: [3n, 4000630n] });
  child(3n, { cls: "ApplicationFrameTitleBarWindow", pid: AFH_PID });
  child(4000630n, { cls: "Windows.UI.Core.CoreWindow", pid: 1003 });
  desk.processes.set(1003, { aumid: CALC, frozen: false });
  top(5000000n, { cls: "Windows.UI.Core.CoreWindow", pid: 1006 });
  desk.processes.set(1006, { aumid: CALC, frozen: true });
  // explorer.exe frame with no AUMID.
  top(328618n, { cls: "ApplicationFrameWindow", pid: AFH_PID });
  // Two processes of one app, one frozen and one running.
  top(6000000n, { cls: "ApplicationFrameWindow", pid: AFH_PID, aumid: TWICE });
  top(6000001n, { cls: "Windows.UI.Core.CoreWindow", pid: 1004 });
  top(6000002n, { cls: "Windows.UI.Core.CoreWindow", pid: 1005 });
  desk.processes.set(1004, { aumid: TWICE, frozen: true });
  desk.processes.set(1005, { aumid: TWICE, frozen: false });
  // A frame whose app has no content window.
  top(7000000n, { cls: "ApplicationFrameWindow", pid: AFH_PID, aumid: "Gone.App_xyz!App" });
  // A plain window: its own process.
  top(8000000n, { cls: "Notepad", pid: 1111 });
  desk.processes.set(1111, { frozen: true });
}

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: {
    win32GetClassName: (h: bigint) => desk.windows.get(h)?.cls ?? "",
    win32GetWindowThreadProcessId: (h: bigint) => ({ threadId: 1, processId: desk.windows.get(h)?.pid ?? 0 }),
    win32ProcessIsFrozen: (pid: number) => desk.processes.get(pid)?.frozen ?? null,
    win32GetWindowAppUserModelId: (h: bigint) => desk.windows.get(h)?.aumid ?? null,
    win32GetProcessAppUserModelId: (pid: number) => desk.processes.get(pid)?.aumid ?? null,
    win32EnumTopLevelWindows: () => [...desk.topLevel],
    // GW_CHILD = 5, GW_HWNDNEXT = 2
    win32GetWindow: (h: bigint, cmd: number) => {
      if (cmd === 5) return desk.windows.get(h)?.children?.[0] ?? null;
      if (cmd === 2) {
        const parent = desk.parentOf.get(h);
        const sibs = parent === undefined ? [] : desk.windows.get(parent)?.children ?? [];
        const i = sibs.indexOf(h);
        return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
      }
      return null;
    },
  },
  nativeL1: null,
}));

import { isWindowProcessFrozen } from "../../src/engine/win32.js";

describe("a packaged app's frame is frozen through its content (internal #250)", () => {
  beforeEach(reset);

  it("a hidden frame whose content process is frozen is frozen (Settings)", () => {
    expect(isWindowProcessFrozen(264580n)).toBe(true);
  });

  it("a hidden frame whose content runs is not frozen, though the frame host answers frozen (Xbox, AUMID case differs)", () => {
    expect(isWindowProcessFrozen(262824n)).toBe(false);
  });

  it("a shown frame reads its child content, not a top-level window of the same app (Calculator)", () => {
    expect(isWindowProcessFrozen(4786720n)).toBe(false);
  });

  it("cannot tell for a frame with no AUMID, no content, or contents that disagree", () => {
    expect(isWindowProcessFrozen(328618n)).toBeNull();
    expect(isWindowProcessFrozen(7000000n)).toBeNull();
    expect(isWindowProcessFrozen(6000000n)).toBeNull();
  });

  it("the content window and a plain window are asked of their own process", () => {
    expect(isWindowProcessFrozen(68014n)).toBe(true);
    expect(isWindowProcessFrozen(133078n)).toBe(false);
    expect(isWindowProcessFrozen(8000000n)).toBe(true);
  });

  it("all the content processes frozen is frozen", () => {
    desk.processes.set(1005, { aumid: TWICE, frozen: true });
    expect(isWindowProcessFrozen(6000000n)).toBe(true);
  });
});
