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
    // Kept deterministic so the identity hints below describe the fixture and
    // not whatever process happens to own pid 7 on the machine running this.
    getProcessIdentityByPid: vi.fn(() => ({ pid: 7, processName: "chrome.exe", processStartTimeMs: 0 })),
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

const { mockClickElement, mockSetElementValue, mockGetUiElements } = vi.hoisted(() => ({
  mockClickElement: vi.fn(async () => ({ ok: true })),
  mockSetElementValue: vi.fn(async () => ({ ok: true })),
  mockGetUiElements: vi.fn(async () => ({ ok: true, elements: [] })),
}));

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return {
    ...actual,
    clickElement: (...a: unknown[]) => mockClickElement(...(a as [])),
    setElementValue: (...a: unknown[]) => mockSetElementValue(...(a as [])),
    getUiElements: (...a: unknown[]) => mockGetUiElements(...(a as [])),
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

const { clickElementHandler, setElementValueHandler, getUiElementsHandler } =
  await import("../../src/tools/ui-elements.js");
import { _resetForTest as resetHotCache } from "../../src/engine/perception/hot-target-cache.js";
import { buildHintsForTitle } from "../../src/engine/identity-tracker.js";

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
  mockGetUiElements.mockClear();
  delete process.env.DTM_SET_VALUE_CHAIN;
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

  it("keeps set_element_value refused while the fallback chain can leave the handle", async () => {
    // With DTM_SET_VALUE_CHAIN=1 a failed ValuePattern attempt continues to the
    // TextPattern2 insert and then to a foreground select-all-and-replace, and
    // BOTH still resolve by title. Lifting the refusal there would trade a stop
    // for a write into the sibling's field, so the pin waits for those channels.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(mockSetElementValue).not.toHaveBeenCalled();
  });
});

// ─── The response hints describe the window that was acted on ────────────────

describe("ADR-036 — hints report the named window, not the first title match", () => {
  it("buildHintsForTitle answers on the handle when one is given", () => {
    expect(buildHintsForTitle(SHARED_TITLE)?.hwnd).toBe(SIBLING);   // the defect
    expect(buildHintsForTitle(SHARED_TITLE, LIVE)?.hwnd).toBe(LIVE);
  });

  it("yields no hints for a handle that is not open, rather than a title match", () => {
    // Answering with the sibling would hand the caller a handle to reuse for a
    // window they never named — the failure mode this whole ADR is about.
    expect(buildHintsForTitle(SHARED_TITLE, 0x9999n)).toBeNull();
  });

  it("does NOT pin get_ui_elements' hints, because its read is still by title", async () => {
    // The first cut of this pinned them and asserted the handle reached
    // `getUiElements`. It did — as a CACHE KEY. The read itself passes only the
    // title to both backends, so pinned hints would have labelled the response
    // with the named window while the elements came from its sibling, and then
    // filed those elements under the named window's handle. A wrong answer
    // stored under the right key is worse than a uniformly wrong one, and the
    // mock in that first version is what made it look right.
    const r = parse(await getUiElementsHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), maxDepth: 2, maxElements: 30,
    } as never));
    expect(mockGetUiElements).toHaveBeenCalled();
    // The read got a title and no handle-scoped path.
    expect(mockGetUiElements.mock.calls[0]![0]).toBe(SHARED_TITLE);
    // And the response says so: the hints name the window the read actually
    // went to. Asserted on the RESPONSE, not on the helper, so re-pinning the
    // hints without pinning the read breaks this test — which is the whole
    // point, since that combination is what shipped and had to be undone.
    expect(r.hints?.target?.hwnd).toBe(String(SIBLING));
  });

  it("click_element reports the handle it clicked", async () => {
    const r = parse(await clickElementHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), name: "OK",
    } as never));
    // Asserted positively, not as "!== sibling": an absent hints block would
    // satisfy the negative form while telling the caller nothing.
    expect(r.hints?.target?.hwnd).toBe(String(LIVE));
  });
});
