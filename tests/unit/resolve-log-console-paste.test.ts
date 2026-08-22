/**
 * resolve-log-console-paste.test.ts — ADR-035 Phase 1.
 *
 * Why the `console_paste` event lives inside `pasteIntoConsoleNoFocus` rather
 * than at its two call sites.
 *
 * The helper checks for its native binding first and returns
 * `native_engine_unavailable` on a mixed-version addon without touching the OS.
 * `terminal(action='send')` then falls through to WM_CHAR. An event at the call
 * site therefore produced TWO dispatch records for one write, the first of them
 * naming a channel that was never used (Codex Round 2).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Flipped per test to simulate an addon with and without the binding. */
let hasBinding = true;
const mockConsolePaste = vi.fn(() => ({ ok: true }));

vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return {
    ...actual,
    get nativeWin32() {
      return {
        ...(actual.nativeWin32 ?? {}),
        ...(hasBinding
          ? { win32ConsolePasteNoFocus: (...a: unknown[]) => mockConsolePaste(...(a as [])) }
          : { win32ConsolePasteNoFocus: undefined }),
      };
    },
  };
});

const mockLogDiagnostic = vi.fn();
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return {
    ...actual,
    logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])),
    isDiagnosticLogEnabled: () => true,
  };
});

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, getForegroundHwnd: () => 0x1n, getWindowTitleW: () => "conhost" };
});

const { pasteIntoConsoleNoFocus } = await import("../../src/engine/bg-input.js");

function sinks(): Array<Record<string, any>> {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, any>)
    .filter((e) => e.kind === "dispatch_sink");
}

beforeEach(() => {
  vi.clearAllMocks();
  hasBinding = true;
  mockConsolePaste.mockReturnValue({ ok: true });
});

describe("ADR-035 Phase 1 — console paste dispatch event", () => {
  it("records one event when the native call is actually made", async () => {
    const r = await pasteIntoConsoleNoFocus(0x100n, "echo hi", "terminal:send");
    expect(r.ok).toBe(true);
    expect(mockConsolePaste).toHaveBeenCalledTimes(1);
    expect(sinks()).toHaveLength(1);
    expect(sinks()[0]).toMatchObject({
      sink: "console_paste",
      tool: "terminal:send",
      targetHwnd: "256",
    });
  });

  it("records NOTHING when the addon lacks the binding", async () => {
    hasBinding = false;
    const r = await pasteIntoConsoleNoFocus(0x100n, "echo hi", "terminal:send");
    expect(r).toMatchObject({ ok: false, reason: "native_engine_unavailable" });
    expect(sinks()).toHaveLength(0);
  });

  it("records a native call that ran and failed — the paste was attempted", async () => {
    mockConsolePaste.mockReturnValue({ ok: false, reason: "post_paste_failed" } as never);
    await pasteIntoConsoleNoFocus(0x100n, "echo hi", "terminal:run");
    expect(sinks()).toHaveLength(1);
    expect(sinks()[0]).toMatchObject({ tool: "terminal:run" });
  });

  it("stays silent for a caller that does not name a tool", async () => {
    await pasteIntoConsoleNoFocus(0x100n, "echo hi");
    expect(sinks()).toHaveLength(0);
  });
});
