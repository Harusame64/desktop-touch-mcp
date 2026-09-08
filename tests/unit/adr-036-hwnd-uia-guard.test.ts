/**
 * adr-036-hwnd-uia-guard.test.ts — ADR-036 I-1 for the UIA writes.
 *
 * `click_element` / `set_element_value` already routed the ACTION through the
 * resolved handle (`FromHandle`, the H3 path), and only the guard in front of
 * them still resolved by title. So a caller who passed `hwnd` was refused with
 * `ambiguous_target` by a check standing in front of a call that would have
 * gone to exactly the right window.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SHARED_TITLE = "pictkura — Chrome";
const SIBLING = 0x1111n;
const LIVE = 0x2222n;

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [
      { hwnd: SIBLING, title: SHARED_TITLE, zOrder: 0, isActive: true, region: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false, isMaximized: false, className: "Chrome_WidgetWin_1", ownerHwnd: null },
      { hwnd: LIVE, title: SHARED_TITLE, zOrder: 1, isActive: false, region: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false, isMaximized: false, className: "Chrome_WidgetWin_1", ownerHwnd: null },
    ]),
    getWindowProcessId: vi.fn(() => 7),
    getWindowIdentity: vi.fn(() => ({ pid: 7, processName: "chrome.exe", processStartTimeMs: 0 })),
  };
});

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: vi.fn(() => []),
  buildWindowIdentity: vi.fn((hwnd: string) => ({
    hwnd, pid: 7, processName: "chrome.exe", processStartTimeMs: 1700000000000, titleResolved: SHARED_TITLE,
  })),
}));

vi.mock("../../src/engine/perception/guards.js", () => ({
  evaluateGuards: vi.fn(() => ({
    ok: true, policy: "block", attention: "ok", results: [], failedGuard: undefined,
  })),
}));

const { mockClickElement, mockSetElementValue } = vi.hoisted(() => ({
  mockClickElement: vi.fn(async () => ({ ok: true })),
  mockSetElementValue: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return {
    ...actual,
    clickElement: (...a: unknown[]) => mockClickElement(...(a as [])),
    setElementValue: (...a: unknown[]) => mockSetElementValue(...(a as [])),
  };
});

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) =>
      p.hwnd !== undefined
        ? { hwnd: BigInt(p.hwnd), title: SHARED_TITLE, warnings: [], className: "Chrome_WidgetWin_1" }
        : null
    ),
  };
});

const { mockRunActionGuard } = vi.hoisted(() => ({ mockRunActionGuard: vi.fn() }));
vi.mock("../../src/tools/_action-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
  mockRunActionGuard.mockImplementation(actual.runActionGuard);
  return { ...actual, runActionGuard: mockRunActionGuard };
});

const { clickElementHandler, setElementValueHandler } = await import("../../src/tools/ui-elements.js");
import { _resetForTest as resetHotCache } from "../../src/engine/perception/hot-target-cache.js";

function parse(result: { content?: Array<{ type: string; text: string }> }): Record<string, any> {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : {};
}

function guardDescriptor(): Record<string, unknown> | null {
  expect(mockRunActionGuard).toHaveBeenCalled();
  const last = mockRunActionGuard.mock.calls.at(-1)![0] as { descriptor: Record<string, unknown> | null };
  return last.descriptor;
}

beforeEach(() => {
  resetHotCache();
  mockRunActionGuard.mockClear();
  mockClickElement.mockClear();
  mockSetElementValue.mockClear();
});

describe("ADR-036 I-1 — UIA writes carry the caller's handle into the guard", () => {
  it("click_element by title alone is refused with ambiguous_target", async () => {
    const r = parse(await clickElementHandler({ windowTitle: SHARED_TITLE, name: "OK" } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("ambiguous_target");
    expect(mockClickElement).not.toHaveBeenCalled();
  });

  it("click_element with a handle passes and clicks through that handle", async () => {
    const r = parse(await clickElementHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), name: "OK",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
    // The action was already handle-addressed before this ADR — pinned as a
    // regression so the guard and the click cannot drift apart again.
    expect(mockClickElement.mock.calls[0]![4]).toEqual({ hwnd: LIVE });
  });

  it("set_element_value by title alone is refused", async () => {
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, value: "x", name: "Field",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(mockSetElementValue).not.toHaveBeenCalled();
  });

  it("set_element_value with a handle passes and sets through that handle", async () => {
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
    expect(mockSetElementValue.mock.calls[0]![4]).toEqual({ hwnd: LIVE });
  });
});
