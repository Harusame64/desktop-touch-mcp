/**
 * adr-036-set-value-observation.test.ts — one observation per call, on every path.
 *
 * `buildHintsForTitle` does two things: it builds the response hints AND it
 * observes the window, which is what keeps drift detection current. Round 3
 * moved the call out of the top of the handler and into the branch of the
 * channel that succeeded — correct for the hints, and it silently took the
 * observation away from the paths that report no hints (channel 3, and every
 * failure). This file pins both halves: never twice (a second call would record
 * one window under two handles and invent a drift), and never zero.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TITLE = "pictkura — Chrome";
const LIVE = 0x2222n;

const { mockBuildHints, mockSetValue, mockInsertText, mockKeyboardType } = vi.hoisted(() => ({
  mockBuildHints: vi.fn(() => null),
  mockSetValue: vi.fn(async () => ({ ok: true })),
  mockInsertText: vi.fn(async () => ({ ok: false, code: "TextPattern2NotSupported" })),
  mockKeyboardType: vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] })),
}));

vi.mock("../../src/engine/identity-tracker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/identity-tracker.js")>();
  return { ...actual, buildHintsForTitle: mockBuildHints };
});

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return {
    ...actual,
    setElementValue: (...a: unknown[]) => mockSetValue(...(a as [])),
    insertTextViaTextPattern2: (...a: unknown[]) => mockInsertText(...(a as [])),
  };
});

vi.mock("../../src/tools/keyboard.js", () => ({
  keyboardTypeHandler: (...a: unknown[]) => mockKeyboardType(...(a as [])),
}));

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string }) =>
      p.hwnd !== undefined ? { hwnd: BigInt(p.hwnd), title: TITLE, warnings: [], className: "Chrome_WidgetWin_1" } : null),
  };
});

const { setElementValueHandler } = await import("../../src/tools/ui-elements.js");

const call = () => setElementValueHandler({
  windowTitle: TITLE, hwnd: String(LIVE), value: "x", name: "Field",
} as never);

beforeEach(() => {
  mockBuildHints.mockClear();
  mockSetValue.mockResolvedValue({ ok: true } as never);
  mockInsertText.mockResolvedValue({ ok: false, code: "TextPattern2NotSupported" } as never);
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";   // the channels, not the guard, are the subject
  delete process.env.DTM_SET_VALUE_CHAIN;
});

describe("ADR-036 — set_element_value observes its window exactly once, whichever channel runs", () => {
  it("channel 1 success", async () => {
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // Pinned: the write went through the handle.
    expect(mockBuildHints.mock.calls[0]![1]).toBe(LIVE);
  });

  it("channel 2 success", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockInsertText.mockResolvedValue({ ok: true } as never);
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // NOT pinned: channel 2 found its window by title.
    expect(mockBuildHints.mock.calls[0]![1]).toBeUndefined();
  });

  it("channel 3 success — reports no hints, still owes the observation", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    await call();
    expect(mockKeyboardType).toHaveBeenCalled();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("all channels failed", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockKeyboardType.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "KeyboardFailed" }) }],
    } as never);
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("chain disabled and channel 1 failed", async () => {
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    const r = await call();
    expect(JSON.parse(r.content![0]!.text).ok).toBe(false);
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });
});
