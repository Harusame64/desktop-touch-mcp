// ADR-014 v2 R3 Key Locker — L0 tool-exclusion unit tests.
//
// Two deterministic layers, no exe / GUI:
//   1. the exclusion registry itself (register / unregister / gate / reset);
//   2. the REAL enumWindowsInZOrder() dropping an excluded PID's window — the primary
//      enforcement surface (feeds screenshot / perception / discover / dialog resolution).
//      We mock only the native win32 surface (a fixed 2-window desktop: one normal app, one
//      "locker") and exercise the production filter in src/engine/win32.ts.
//
// resolveWindowTarget()'s Cases 1/2 refusal (the enumerator-bypass paths) is covered in
// tests/unit/resolve-window.test.ts, which already mocks win32.js (mutually exclusive with the
// REAL-win32 mock needed here).

import { describe, it, expect, beforeEach, vi } from "vitest";

const NORMAL_HWND = 100n;
const NORMAL_PID = 1111;
const LOCKER_HWND = 200n;
const LOCKER_PID = 2222;

// A minimal fake of the native win32 surface enumWindowsInZOrder() touches — a fixed desktop of
// two visible top-level windows owned by distinct PIDs. win32GetWindowThreadProcessId is the one
// the R3 filter consults (via getWindowProcessId). Built in vi.hoisted() so the (hoisted) vi.mock
// factory below can reference it without a TDZ error.
const { fakeWin32 } = vi.hoisted(() => ({
  fakeWin32: {
    win32EnumTopLevelWindows: () => [100n, 200n],
    win32GetForegroundWindow: () => 100n,
    win32IsWindowVisible: () => true,
    win32GetWindowText: (h: bigint) => (h === 200n ? "desktop-touch key locker" : "Untitled - Notepad"),
    win32GetWindowRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    win32IsIconic: () => false,
    win32IsZoomed: () => false,
    win32GetWindowLongPtrW: () => 0,
    win32GetWindow: () => null,
    win32GetClassName: (h: bigint) => (h === 200n ? "HwndWrapper[key-locker]" : "Notepad"),
    win32IsWindowCloaked: () => false,
    win32IsWindowEnabled: () => true,
    win32GetWindowThreadProcessId: (h: bigint) => ({ threadId: 1, processId: h === 200n ? 2222 : 1111 }),
  },
}));

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: fakeWin32,
  nativeL1: null,
}));

import { enumWindowsInZOrder, isExcludedTitle } from "../../src/engine/win32.js";
import {
  registerExcludedPid, unregisterExcludedPid, hasExcludedPids,
  isExcludedPid, _resetExcludedPidsForTest,
} from "../../src/engine/tool-exclusion.js";

describe("tool-exclusion registry", () => {
  beforeEach(() => _resetExcludedPidsForTest());

  it("registers a PID and reports it excluded", () => {
    expect(hasExcludedPids()).toBe(false);
    registerExcludedPid(LOCKER_PID);
    expect(hasExcludedPids()).toBe(true);
    expect(isExcludedPid(LOCKER_PID)).toBe(true);
    expect(isExcludedPid(NORMAL_PID)).toBe(false);
  });

  it("unregisters a PID", () => {
    registerExcludedPid(LOCKER_PID);
    unregisterExcludedPid(LOCKER_PID);
    expect(isExcludedPid(LOCKER_PID)).toBe(false);
    expect(hasExcludedPids()).toBe(false);
  });

  it("ignores non-positive / non-integer PIDs (no accidental blanket exclusion)", () => {
    registerExcludedPid(0);
    registerExcludedPid(-5);
    registerExcludedPid(3.5);
    registerExcludedPid(Number.NaN);
    expect(hasExcludedPids()).toBe(false);
  });

  it("reset clears all excluded PIDs", () => {
    registerExcludedPid(LOCKER_PID);
    registerExcludedPid(3333);
    _resetExcludedPidsForTest();
    expect(hasExcludedPids()).toBe(false);
  });
});

describe("enumWindowsInZOrder — R3 tool-exclusion filter", () => {
  beforeEach(() => _resetExcludedPidsForTest());

  it("includes every window when no PID is excluded", () => {
    const wins = enumWindowsInZOrder();
    expect(wins.map((w) => w.hwnd)).toEqual([NORMAL_HWND, LOCKER_HWND]);
  });

  it("drops the locker's window when its PID is excluded", () => {
    registerExcludedPid(LOCKER_PID);
    const wins = enumWindowsInZOrder();
    const hwnds = wins.map((w) => w.hwnd);
    expect(hwnds).toContain(NORMAL_HWND);
    expect(hwnds).not.toContain(LOCKER_HWND);
    expect(wins.length).toBe(1);
  });

  it("restores the window after the PID is unregistered", () => {
    registerExcludedPid(LOCKER_PID);
    unregisterExcludedPid(LOCKER_PID);
    const wins = enumWindowsInZOrder();
    expect(wins.map((w) => w.hwnd)).toEqual([NORMAL_HWND, LOCKER_HWND]);
  });

  it("excluding an unrelated PID does not drop either real window", () => {
    registerExcludedPid(999_999);
    const wins = enumWindowsInZOrder();
    expect(wins.length).toBe(2);
  });

  it("fails CLOSED while armed: a window whose PID cannot be read (0) is dropped (P3-1)", () => {
    const orig = fakeWin32.win32GetWindowThreadProcessId;
    // Make the locker window's PID unreadable (0) while an UNRELATED pid arms the filter.
    fakeWin32.win32GetWindowThreadProcessId = (h: bigint) => ({ threadId: 1, processId: h === 200n ? 0 : 1111 });
    try {
      registerExcludedPid(4242); // arm with a pid that matches nothing on this desktop
      const wins = enumWindowsInZOrder();
      expect(wins.map((w) => w.hwnd)).toEqual([100n]); // 200n dropped: unreadable PID, filter armed
    } finally {
      fakeWin32.win32GetWindowThreadProcessId = orig;
    }
  });

  it("does NOT drop an unreadable-PID window when the filter is NOT armed", () => {
    const orig = fakeWin32.win32GetWindowThreadProcessId;
    fakeWin32.win32GetWindowThreadProcessId = (h: bigint) => ({ threadId: 1, processId: h === 200n ? 0 : 1111 });
    try {
      const wins = enumWindowsInZOrder(); // no PID excluded → PID never read → both kept
      expect(wins.map((w) => w.hwnd)).toEqual([100n, 200n]);
    } finally {
      fakeWin32.win32GetWindowThreadProcessId = orig;
    }
  });
});

describe("isExcludedTitle — by-title predicate (unfiltered enumeration)", () => {
  beforeEach(() => _resetExcludedPidsForTest());

  it("returns false (zero-overhead) when no PID is excluded", () => {
    expect(isExcludedTitle("desktop-touch key locker")).toBe(false);
  });

  it("returns true when the title (substring) names an excluded window", () => {
    registerExcludedPid(2222); // the fake locker window (200n) is owned by 2222
    expect(isExcludedTitle("desktop-touch key locker")).toBe(true);
    expect(isExcludedTitle("KEY LOCKER")).toBe(true); // case-insensitive substring
  });

  it("returns false when the title matches only a NON-excluded window", () => {
    registerExcludedPid(2222);
    expect(isExcludedTitle("Notepad")).toBe(false); // 100n owned by 1111 (not excluded)
  });

  it("returns false for an empty title", () => {
    registerExcludedPid(2222);
    expect(isExcludedTitle("")).toBe(false);
  });
});
