/**
 * resolve-log-desktop-act.test.ts — ADR-035 Phase 1, `desktop_act`'s background
 * writes.
 *
 * `desktop_act` is the other public dispatcher, and its two background
 * executors resolve a window by unfiltered title substring and post WM_CHAR to
 * the first match — the same silently-first-match shape the v1 resolvers have.
 * Instrumented in Round 2 after a review found both halves invisible while the
 * user-facing docs claimed otherwise; pinned here so reverting either half
 * fails something (Opus Round 3 P2).
 *
 * `terminalBgExecute`'s deps are injectable, so the terminal half is driven
 * through the real production closures rather than the pure core.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TARGET = 0x100n;
const OTHER = 0x200n;

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [
      { hwnd: TARGET, title: "bash — pane 1", region: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 0, isMinimized: false, isMaximized: false, isActive: true, className: "ConsoleWindowClass", ownerHwnd: null },
      { hwnd: OTHER, title: "bash — pane 2", region: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 1, isMinimized: false, isMaximized: false, isActive: false, className: "ConsoleWindowClass", ownerHwnd: null },
    ]),
    getForegroundHwnd: vi.fn(() => TARGET),
    getWindowTitleW: vi.fn(() => "bash — pane 1"),
    getWindowIdentity: vi.fn(() => ({ pid: 11, processName: "bash.exe", processStartTimeMs: 0 })),
  };
});

const mockPostChars = vi.fn((_h: unknown, t: string) => ({ sent: t.length, full: true }));
vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    canInjectViaPostMessage: vi.fn(() => ({ supported: true })),
    canInjectAtTarget: vi.fn(() => ({ supported: true })),
    postCharsToHwnd: (...a: unknown[]) => mockPostChars(...(a as [never, string])),
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

const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
type UiEntity = import("../../src/engine/world-graph/types.js").UiEntity;

/**
 * Built WITHOUT injected deps on purpose: that is what makes the executor use
 * the production closures, which is where the instrumentation lives. A mocked
 * dep bundle would pass with the instrumentation deleted.
 */
function realExecutor(windowTitle: string) {
  return createDesktopExecutor({ windowTitle });
}

function entity(sources: UiEntity["sources"]): UiEntity {
  return {
    entityId: "e1",
    role: "textbox",
    label: "prompt",
    confidence: 0.9,
    sources,
    affordances: [
      { verb: "setValue", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] },
    ],
    generation: "gen-1",
    evidenceDigest: "d-e1",
    // No rect: the mouse fallback must not be reachable from this file, or a
    // route miss would click the real screen.
  } as UiEntity;
}

function events(kind: string): Array<Record<string, any>> {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, any>)
    .filter((e) => e.kind === kind);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ADR-035 Phase 1 — desktop_act background writes", () => {
  it("terminalSend logs one resolution naming the runners-up, and one dispatch", async () => {
    await realExecutor("bash")(entity(["terminal"]), "invoke", "echo hi");

    const resolves = events("resolve").filter((e) => e.resolver === "desktopActTerminalSend");
    expect(resolves).toHaveLength(1);
    // Two panes carry "bash" — the silent multi-match shape this phase measures.
    expect(resolves[0]).toMatchObject({
      matchCount: 2,
      chosen: { hwnd: String(TARGET), pid: 11, processName: "bash.exe" },
    });
    expect(resolves[0]!.others.map((o: any) => o.hwnd)).toEqual([String(OTHER)]);

    const sinks = events("dispatch_sink");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({
      sink: "wm_char",
      tool: "desktop_act:terminal_send",
      targetHwnd: String(TARGET),
    });
  });

  it("keyboardTypeBg logs its own resolver and dispatch", async () => {
    // The UIA setValue route throws (no native UIA in a unit run), and the
    // executor's documented fallback for that is the background keyboard type.
    await realExecutor("bash")(entity(["uia"]), "setValue", "hello");

    const resolves = events("resolve").filter((e) => e.resolver === "desktopActKeyboardType");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({ matchCount: 2, chosen: { hwnd: String(TARGET) } });

    const sinks = events("dispatch_sink");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({ tool: "desktop_act:keyboard_type", targetHwnd: String(TARGET) });
  });

  it("resolves to the same window the pre-instrumentation `.find` would have", async () => {
    await realExecutor("bash")(entity(["terminal"]), "invoke", "x");
    expect(mockPostChars).toHaveBeenCalledWith(TARGET, "x");
  });

  it("a miss logs the zero-match resolution and no dispatch", async () => {
    // The executor surfaces the miss as a thrown route failure; what matters
    // here is that the resolution was recorded and no write followed it.
    await expect(realExecutor("no-such-window")(entity(["terminal"]), "invoke", "x"))
      .rejects.toThrow(/Terminal window not found/);
    const resolves = events("resolve").filter((e) => e.resolver === "desktopActTerminalSend");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({ matchCount: 0, chosen: null });
    expect(events("dispatch_sink")).toHaveLength(0);
  });
});
