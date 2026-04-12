/**
 * dock-window.test.ts — E2E tests for dock_window tool.
 *
 * Launches Notepad as a test victim, invokes dockWindowHandler directly,
 * and verifies that the window actually moved and resized via GetWindowRect.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { dockWindowHandler } from "../../src/tools/dock.js";
import {
  enumWindowsInZOrder,
  enumMonitors,
  getWindowRectByHwnd,
  clearWindowTopmost,
} from "../../src/engine/win32.js";

const NOTEPAD_TITLE_FRAGMENT = "メモ帳"; // Works on ja-JP Windows; fallback below
const NOTEPAD_TITLE_FRAGMENT_EN = "Notepad";

let notepad: ChildProcess | null = null;
let hwnd: unknown = null;
let resolvedTitle = "";

function findNotepad(): { hwnd: unknown; title: string } | null {
  for (const w of enumWindowsInZOrder()) {
    if (
      w.title.includes(NOTEPAD_TITLE_FRAGMENT) ||
      w.title.includes(NOTEPAD_TITLE_FRAGMENT_EN)
    ) {
      return { hwnd: w.hwnd, title: w.title };
    }
  }
  return null;
}

beforeAll(async () => {
  notepad = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
  // Poll for the window to appear (Notepad can take ~500ms on cold start)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = findNotepad();
    if (found) {
      hwnd = found.hwnd;
      resolvedTitle = found.title;
      return;
    }
    await sleep(100);
  }
  throw new Error("Notepad window did not appear within 5s");
}, 10_000);

afterAll(() => {
  // Release always-on-top before killing
  if (hwnd) {
    try { clearWindowTopmost(hwnd); } catch { /* ignore */ }
  }
  if (notepad && !notepad.killed) {
    try { notepad.kill(); } catch { /* ignore */ }
  }
});

// Tolerance for actual-vs-requested window rect comparison.
// Windows may snap to AeroSnap grids or enforce min-size constraints on some apps.
const POS_TOLERANCE_PX = 20;

function expectRectNear(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  label: string
): void {
  expect(Math.abs(actual.x - expected.x), `${label}: x`).toBeLessThanOrEqual(POS_TOLERANCE_PX);
  expect(Math.abs(actual.y - expected.y), `${label}: y`).toBeLessThanOrEqual(POS_TOLERANCE_PX);
  expect(Math.abs(actual.width - expected.width), `${label}: width`).toBeLessThanOrEqual(POS_TOLERANCE_PX);
  expect(Math.abs(actual.height - expected.height), `${label}: height`).toBeLessThanOrEqual(POS_TOLERANCE_PX);
}

describe("dock_window", () => {
  it("returns a structured error for unknown titles", async () => {
    const res = await dockWindowHandler({
      title: "__definitely_not_a_window_title_xyz__",
      corner: "bottom-right",
      width: 480,
      height: 360,
      pin: true,
      margin: 8,
    });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/No window found/);
  });

  it("docks to bottom-right with correct size and position", async () => {
    const mon = enumMonitors().find((m) => m.primary) ?? enumMonitors()[0];
    const wa = mon.workArea;
    const width = 480;
    const height = 360;
    const margin = 8;

    const res = await dockWindowHandler({
      title: resolvedTitle,
      corner: "bottom-right",
      width,
      height,
      pin: false, // avoid leaving an always-on-top Notepad after the test
      margin,
    });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok, JSON.stringify(payload)).toBe(true);

    await sleep(80); // let Windows settle
    const rect = getWindowRectByHwnd(hwnd!)!;
    expect(rect).not.toBeNull();

    const expected = {
      x: wa.x + wa.width - width - margin,
      y: wa.y + wa.height - height - margin,
      width,
      height,
    };
    expectRectNear(rect, expected, "bottom-right");
  });

  it("docks to top-left with correct anchoring", async () => {
    const mon = enumMonitors().find((m) => m.primary) ?? enumMonitors()[0];
    const wa = mon.workArea;
    const width = 400;
    const height = 300;
    const margin = 8;

    const res = await dockWindowHandler({
      title: resolvedTitle,
      corner: "top-left",
      width,
      height,
      pin: false,
      margin,
    });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);

    await sleep(80);
    const rect = getWindowRectByHwnd(hwnd!)!;
    expectRectNear(
      rect,
      { x: wa.x + margin, y: wa.y + margin, width, height },
      "top-left"
    );
  });

  it("docks to top-right and bottom-left", async () => {
    const mon = enumMonitors().find((m) => m.primary) ?? enumMonitors()[0];
    const wa = mon.workArea;
    // Use 500x400 to stay above Notepad's min-width constraint (~332px on Win11)
    const width = 500;
    const height = 400;
    const margin = 16;

    // top-right
    {
      const res = await dockWindowHandler({
        title: resolvedTitle,
        corner: "top-right",
        width,
        height,
        pin: false,
        margin,
      });
      expect(JSON.parse((res.content[0] as { text: string }).text).ok).toBe(true);
      await sleep(80);
      const rect = getWindowRectByHwnd(hwnd!)!;
      expectRectNear(
        rect,
        { x: wa.x + wa.width - width - margin, y: wa.y + margin, width, height },
        "top-right"
      );
    }

    // bottom-left
    {
      const res = await dockWindowHandler({
        title: resolvedTitle,
        corner: "bottom-left",
        width,
        height,
        pin: false,
        margin,
      });
      expect(JSON.parse((res.content[0] as { text: string }).text).ok).toBe(true);
      await sleep(80);
      const rect = getWindowRectByHwnd(hwnd!)!;
      expectRectNear(
        rect,
        { x: wa.x + margin, y: wa.y + wa.height - height - margin, width, height },
        "bottom-left"
      );
    }
  });

  it("clamps oversized requests to the work area", async () => {
    const mon = enumMonitors().find((m) => m.primary) ?? enumMonitors()[0];
    const wa = mon.workArea;
    const margin = 8;

    const res = await dockWindowHandler({
      title: resolvedTitle,
      corner: "top-left",
      width: wa.width + 10000, // absurdly large
      height: wa.height + 10000,
      pin: false,
      margin,
    });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // requested.width/height should be clamped to workArea - 2*margin
    expect(payload.requested.width).toBeLessThanOrEqual(wa.width - margin * 2);
    expect(payload.requested.height).toBeLessThanOrEqual(wa.height - margin * 2);
  });

  it("pins and unpins via pin=true/false", async () => {
    // Pin
    {
      const res = await dockWindowHandler({
        title: resolvedTitle,
        corner: "bottom-right",
        width: 400,
        height: 300,
        pin: true,
        margin: 8,
      });
      const payload = JSON.parse((res.content[0] as { text: string }).text);
      expect(payload.ok).toBe(true);
      expect(payload.pinned).toBe(true);
    }
    // Unpin (explicit pin=false)
    {
      const res = await dockWindowHandler({
        title: resolvedTitle,
        corner: "bottom-right",
        width: 400,
        height: 300,
        pin: false,
        margin: 8,
      });
      const payload = JSON.parse((res.content[0] as { text: string }).text);
      expect(payload.ok).toBe(true);
      expect(payload.pinned).toBe(false);
    }
  });
});
