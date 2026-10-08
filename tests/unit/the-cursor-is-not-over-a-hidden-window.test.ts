/**
 * llm22 drive F19 (win2, 2026-10-04): desktop_state's `cursorOverWindow` named windows that were not
 * on screen — a Notepad on another virtual desktop and minimised Settings' content — because its hit
 * test walked the z-order by rect alone. A hidden (cloaked) or minimised window is not under the
 * cursor.
 */
import { describe, expect, it, vi } from "vitest";

const { wins } = vi.hoisted(() => ({ wins: { value: [] as unknown[] } }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => wins.value),
    enumMonitors: vi.fn(() => [{ index: 0, isPrimary: true, region: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96 }]),
    getVirtualScreen: vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 })),
    getWindowProcessId: vi.fn(() => 1234),
    getProcessIdentityByPid: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
    getWindowIdentity: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
  };
});
vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return { ...actual, nativeViewFocus: { viewGetFocused: () => null }, nativeWin32: undefined };
});
vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return { ...actual, getFocusedAndPointInfo: vi.fn(async () => ({ focused: null, atPoint: null })) };
});
vi.mock("../../src/engine/cdp-bridge.js", () => ({ evaluateInTab: vi.fn(async () => null), DEFAULT_CDP_PORT: 9222 }));
vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: async () => ({ x: 100, y: 100 }) } }));

const { desktopStateHandler } = await import("../../src/tools/desktop-state.js");

const at = (hwnd: bigint, title: string, zOrder: number, over: Record<string, unknown> = {}) => ({
  hwnd, title, zOrder, isActive: zOrder === 2, isMinimized: false, isMaximized: false,
  className: "Notepad", ownerHwnd: null, region: { x: 0, y: 0, width: 800, height: 600 }, processName: "notepad.exe",
  ...over,
});

describe("desktop_state cursorOverWindow", () => {
  it("names the shown window under the cursor, not a hidden or minimised one above it", async () => {
    wins.value = [
      at(1n, "メモ帳 (other desktop)", 0, { isCloaked: true }),
      at(2n, "設定 (minimised content)", 1, { isMinimized: true }),
      at(3n, "Visible", 2),
    ];
    const out = JSON.parse(((await desktopStateHandler({})) as { content: Array<{ text: string }> }).content[0]!.text);
    expect(out.cursorOverWindow).toEqual({ title: "Visible", hwnd: "3" });
  });

  it("names nothing when only hidden windows cover the cursor", async () => {
    wins.value = [at(1n, "hidden", 0, { isCloaked: true })];
    const out = JSON.parse(((await desktopStateHandler({})) as { content: Array<{ text: string }> }).content[0]!.text);
    expect(out.cursorOverWindow ?? null).toBeNull();
  });
});

describe("desktop_state hasModal and visibleWindows (internal #253)", () => {
  const read = async () => JSON.parse(((await desktopStateHandler({})) as { content: Array<{ text: string }> }).content[0]!.text);

  it("a modal-sounding title on a hidden or minimised window is not a modal, nor a visible window", async () => {
    wins.value = [
      at(1n, "名前を付けて保存", 0, { isCloaked: true }),
      at(2n, "Error", 1, { isMinimized: true }),
      at(3n, "Visible", 2),
    ];
    const out = await read();
    expect(out.hasModal).toBe(false);
    expect(out.pageState).not.toBe("dialog");
    expect(out.visibleWindows).toBe(1);
  });

  it("a hidden or minimised dialog that holds a shown owner disabled still is (gate 2)", async () => {
    for (const hidden of [{ isMinimized: true }, { isCloaked: true }]) {
      wins.value = [
        at(1n, "確認", 0, { ownerHwnd: 3n, ...hidden }),
        at(3n, "Owner", 2, { isEnabled: false }),
      ];
      expect((await read()).hasModal).toBe(true);
    }
  });

  it("…but not when the owner it disabled is itself hidden, or not disabled", async () => {
    wins.value = [at(1n, "確認", 0, { ownerHwnd: 3n, isMinimized: true }), at(3n, "Owner", 2, { isEnabled: false, isCloaked: true })];
    expect((await read()).hasModal).toBe(false);
    wins.value = [at(1n, "確認", 0, { ownerHwnd: 3n, isMinimized: true }), at(3n, "Owner", 2, { isEnabled: true })];
    expect((await read()).hasModal).toBe(false);
  });

  it("the same title on a shown window still is (control)", async () => {
    wins.value = [at(1n, "名前を付けて保存", 0), at(3n, "Visible", 2)];
    const out = await read();
    expect(out.hasModal).toBe(true);
    expect(out.visibleWindows).toBe(2);
  });
});
