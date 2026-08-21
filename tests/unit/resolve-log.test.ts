/**
 * resolve-log.test.ts — ADR-035 Phase 1 observation contract.
 *
 * What is being pinned here is not "does it log" but the four properties the
 * ADR's analysis depends on:
 *
 *   1. PII — a window title never reaches the log in clear unless
 *      `DESKTOP_TOUCH_RESOLVE_LOG_RAW=1` says so, and when it does the hash is
 *      still there so a mixed log still joins.
 *   2. One resolution = one event. A helper that delegates to another
 *      instrumented helper must not double-count, or `matchCount>=2` frequency
 *      (the H1 measurement) is inflated by the plumbing.
 *   3. Correlation. A resolve and the dispatch it produced carry the same
 *      `callId`, because concurrent tool calls interleave in the log.
 *   4. Idle cost. With the diagnostic log disabled, nothing is hashed and no
 *      Win32 call is made — pinned with a title getter that records access, so
 *      "we skipped the hash" is observed rather than assumed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLogDiagnostic = vi.fn();
let logEnabled = true;
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return {
    ...actual,
    logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])),
    isDiagnosticLogEnabled: () => logEnabled,
  };
});

const mockGetForegroundHwnd = vi.fn<() => bigint | null>(() => 0x900n);
const mockGetWindowTitleW = vi.fn<() => string>(() => "Foreground Window");
const mockGetWindowIdentity = vi.fn(() => ({ pid: 4242, processName: "pwsh.exe", processStartTimeMs: 0 }));
const mockEnumWindowsInZOrder = vi.fn<() => unknown[]>(() => []);
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getForegroundHwnd: () => mockGetForegroundHwnd(),
    getWindowTitleW: () => mockGetWindowTitleW(),
    getWindowIdentity: () => mockGetWindowIdentity(),
    enumWindowsInZOrder: () => mockEnumWindowsInZOrder(),
  };
});

const {
  hashTitle,
  logResolve,
  logDispatchSink,
  runWithCallId,
  wrapHandlerArgWithCallId,
  currentCallId,
  _resetCallIdSeqForTest,
} = await import("../../src/tools/_resolve-log.js");

const {
  pickPlainTopLevelWindowByTitle,
  findPlainTopLevelWindowByTitle,
  findPlainTopLevelWindowsByTitle,
} = await import("../../src/tools/_resolve-window.js");

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Win = {
  hwnd: bigint; title: string; zOrder: number;
  isMinimized: boolean; isMaximized: boolean; isActive: boolean;
  className?: string; ownerHwnd?: bigint | null;
  region: { x: number; y: number; width: number; height: number };
};

function win(hwnd: bigint, title: string, zOrder: number, over: Partial<Win> = {}): Win {
  return {
    hwnd, title, zOrder,
    isMinimized: false, isMaximized: false, isActive: false,
    className: "Notepad", ownerHwnd: null,
    region: { x: 0, y: 0, width: 200, height: 200 },
    ...over,
  };
}

/** The events written so far, as the typed records they are on disk. */
function events(): Array<Record<string, any>> {
  return mockLogDiagnostic.mock.calls.map((c) => c[0] as Record<string, any>);
}

const ENV_KEYS = ["DESKTOP_TOUCH_RESOLVE_LOG_RAW", "DESKTOP_TOUCH_AUTO_GUARD"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  logEnabled = true;
  mockLogDiagnostic.mockClear();
  mockGetForegroundHwnd.mockClear();
  mockGetWindowTitleW.mockClear();
  mockGetWindowIdentity.mockClear();
  mockEnumWindowsInZOrder.mockClear();
  mockEnumWindowsInZOrder.mockReturnValue([]);
  _resetCallIdSeqForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. PII
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — title hashing (PII, plan §2 Round 10 Codex)", () => {
  it("hashTitle is sha256 truncated to 8 hex chars plus the UTF-16 length", () => {
    const h = hashTitle("Untitled - Notepad");
    expect(h.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(h.len).toBe("Untitled - Notepad".length);
    // Deterministic and collision-distinguishing for the two titles the ADR
    // actually needs to tell apart.
    expect(hashTitle("Untitled - Notepad").hash).toBe(h.hash);
    expect(hashTitle("Untitled - Notepad ").hash).not.toBe(h.hash);
  });

  it("counts UTF-16 code units, matching what GetWindowTextW returns", () => {
    expect(hashTitle("メモ帳").len).toBe(3);
    expect(hashTitle("🙂").len).toBe(2); // surrogate pair
  });

  it("by default records NO raw title or query anywhere in the event", () => {
    logResolve({
      resolver: "findTerminalWindow",
      query: "secret-project-plan",
      matches: [win(0x1n, "secret-project-plan.docx - Word", 0)],
    });
    const e = events()[0]!;
    expect(e.queryHash).toMatch(/^[0-9a-f]{8}$/);
    expect(e.queryLen).toBe("secret-project-plan".length);
    expect(JSON.stringify(e)).not.toContain("secret-project-plan");
    expect(e.queryRaw).toBeUndefined();
    expect(e.chosen.titleRaw).toBeUndefined();
  });

  it("DESKTOP_TOUCH_RESOLVE_LOG_RAW=1 ADDS the raw strings — it does not replace the hashes", () => {
    process.env.DESKTOP_TOUCH_RESOLVE_LOG_RAW = "1";
    logResolve({
      resolver: "findTerminalWindow",
      query: "plan",
      matches: [win(0x1n, "plan.docx - Word", 0), win(0x2n, "planner", 1)],
    });
    const e = events()[0]!;
    expect(e.queryRaw).toBe("plan");
    expect(e.queryHash).toBe(hashTitle("plan").hash);
    expect(e.chosen.titleRaw).toBe("plan.docx - Word");
    expect(e.chosen.titleHash).toBe(hashTitle("plan.docx - Word").hash);
    expect(e.others[0].titleRaw).toBe("planner");
  });

  it("applies the same rule to the foreground title on a dispatch event", () => {
    logDispatchSink({ sink: "sendinput", tool: "keyboard:press", targetHwnd: null });
    expect(events()[0]!.fgTitleRaw).toBeUndefined();
    expect(events()[0]!.fgTitleHash).toBe(hashTitle("Foreground Window").hash);

    process.env.DESKTOP_TOUCH_RESOLVE_LOG_RAW = "1";
    logDispatchSink({ sink: "sendinput", tool: "keyboard:press", targetHwnd: null });
    expect(events()[1]!.fgTitleRaw).toBe("Foreground Window");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Event shape
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — resolve event shape", () => {
  it("caps `others` at 5 while `matchCount` keeps the true total", () => {
    const matches = Array.from({ length: 9 }, (_, i) => win(BigInt(i + 1), `Window ${i}`, i));
    logResolve({ resolver: "pickPlainTopLevelWindowByTitle", query: "Window", matches });
    const e = events()[0]!;
    expect(e.matchCount).toBe(9);          // the H1 signal is NOT truncated
    expect(e.others).toHaveLength(5);      // the payload is
    expect(e.chosen.hwnd).toBe("1");
  });

  it("`others` excludes the chosen window even when the tie-break skipped ahead", () => {
    const a = win(0x1n, "Shell", 0);
    const b = win(0x2n, "Shell", 1, { isActive: true });
    logResolve({ resolver: "focusWindowForKeyboard", query: "Shell", matches: [a, b], chosen: b });
    const e = events()[0]!;
    expect(e.chosen.hwnd).toBe("2");
    expect(e.others.map((o: any) => o.hwnd)).toEqual(["1"]);
  });

  it("records a zero-match resolution as matchCount 0 + chosen null", () => {
    logResolve({ resolver: "findTerminalWindow", query: "nothing", matches: [] });
    const e = events()[0]!;
    expect(e.matchCount).toBe(0);
    expect(e.chosen).toBeNull();
    expect(e.others).toEqual([]);
  });

  it("emits `fallback` ONLY when the caller says the process-name path fired", () => {
    logResolve({ resolver: "findTerminalWindow", query: "pwsh", matches: [win(0x1n, "PowerShell", 0)] });
    expect(events()[0]!.fallback).toBeUndefined();

    logResolve({
      resolver: "findTerminalWindow", query: "pwsh", matches: [],
      chosen: { hwnd: 0x5n, title: "PowerShell 7", pid: 99, processName: "pwsh.exe" },
      fallback: "process-name",
    });
    const e = events()[1]!;
    expect(e.fallback).toBe("process-name");
    expect(e.matchCount).toBe(0);           // zero TITLE matches — that is the H2 shape
    expect(e.chosen.processName).toBe("pwsh.exe");
  });

  it("looks up process identity only when the call site asks for it", () => {
    logResolve({ resolver: "actionTarget", query: "x", matches: [win(0x1n, "A", 0)] });
    expect(mockGetWindowIdentity).not.toHaveBeenCalled();
    expect(events()[0]!.chosen.pid).toBeUndefined();

    logResolve({ resolver: "findTerminalWindow", query: "x", matches: [win(0x1n, "A", 0)], identity: "lookup" });
    expect(mockGetWindowIdentity).toHaveBeenCalledTimes(1);
    expect(events()[1]!.chosen).toMatchObject({ pid: 4242, processName: "pwsh.exe" });
  });

  it("carries the auto-guard state, so a failed run can be attributed to it", () => {
    logResolve({ resolver: "actionTarget", query: "x", matches: [] });
    expect(events()[0]!.autoGuard).toBe(true);      // default: enabled

    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    logResolve({ resolver: "actionTarget", query: "x", matches: [] });
    logDispatchSink({ sink: "wm_char", tool: "terminal:send", targetHwnd: 0x7n });
    expect(events()[1]!.autoGuard).toBe(false);
    expect(events()[2]!.autoGuard).toBe(false);
  });
});

describe("ADR-035 Phase 1 — dispatch_sink event shape", () => {
  it("records the target handle and the foreground window it was aimed past", () => {
    logDispatchSink({ sink: "wm_char", tool: "terminal:send", targetHwnd: 0x123n });
    expect(events()[0]).toMatchObject({
      kind: "dispatch_sink",
      sink: "wm_char",
      tool: "terminal:send",
      targetHwnd: "291",
      fgHwnd: "2304",
    });
  });

  it("keeps targetHwnd null for the foreground-routed sinks that have no handle", () => {
    logDispatchSink({ sink: "sendinput", tool: "scroll", targetHwnd: null, tier: "4" });
    expect(events()[0]).toMatchObject({ targetHwnd: null, tier: "4" });
  });

  it("survives a foreground window that dies between the two syscalls", () => {
    mockGetWindowTitleW.mockImplementationOnce(() => { throw new Error("window gone"); });
    expect(() => logDispatchSink({ sink: "sendinput", tool: "keyboard:press", targetHwnd: null })).not.toThrow();
    expect(events()[0]!.fgTitleLen).toBe(0);
  });

  it("never enumerates windows — two syscalls per dispatch, no more", () => {
    logDispatchSink({ sink: "clipboard_paste", tool: "keyboard:type", targetHwnd: null });
    expect(mockEnumWindowsInZOrder).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Correlation
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — per-call correlation id (plan §2 Round 17 K-3)", () => {
  it("is null outside a wrapped handler", () => {
    expect(currentCallId()).toBeNull();
    logResolve({ resolver: "actionTarget", query: "x", matches: [] });
    expect(events()[0]!.callId).toBeNull();
  });

  it("joins the resolve and the dispatch of the SAME handler call", async () => {
    const args = ["keyboard_type", {}, async () => {
      logResolve({ resolver: "keyboardBackgroundType", query: "Notepad", matches: [] });
      logDispatchSink({ sink: "wm_char", tool: "keyboard:type", targetHwnd: 0x1n });
      return "done";
    }];
    const handler = wrapHandlerArgWithCallId(args)[2] as () => Promise<string>;
    await handler();
    const [resolve, dispatch] = events();
    expect(resolve!.callId).toBeTruthy();
    expect(dispatch!.callId).toBe(resolve!.callId);
  });

  it("gives two concurrent calls different ids, so interleaved events stay separable", async () => {
    const make = (title: string) => wrapHandlerArgWithCallId(["t", {}, async () => {
      await new Promise((r) => setTimeout(r, 1));
      logResolve({ resolver: "actionTarget", query: title, matches: [] });
    }])[2] as () => Promise<void>;
    await Promise.all([make("A")(), make("B")()]);
    const ids = events().map((e) => e.callId);
    expect(new Set(ids).size).toBe(2);
  });

  it("a nested handler INHERITS the outer id (run_macro calls inner handlers directly)", async () => {
    const inner = wrapHandlerArgWithCallId(["inner", {}, async () => {
      logDispatchSink({ sink: "sendinput", tool: "keyboard:press", targetHwnd: null });
    }])[2] as () => Promise<void>;
    const outer = wrapHandlerArgWithCallId(["run_macro", {}, async () => {
      logResolve({ resolver: "actionTarget", query: "x", matches: [] });
      await inner();
    }])[2] as () => Promise<void>;
    await outer();
    const [a, b] = events();
    expect(b!.callId).toBe(a!.callId);
  });

  it("leaves an unrecognised registration shape untouched", () => {
    const notAHandler = ["name", {}, "oops"];
    expect(wrapHandlerArgWithCallId([...notAHandler])[2]).toBe("oops");
    expect(wrapHandlerArgWithCallId([])).toEqual([]);
  });

  it("runWithCallId exposes the id to everything inside it", () => {
    runWithCallId(() => {
      const id = currentCallId();
      expect(id).toBeTruthy();
      runWithCallId(() => expect(currentCallId()).toBe(id));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Idle cost
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — zero cost when the diagnostic log is off", () => {
  /** A window whose `title` records every read — the probe for "did we hash?". */
  function probeWin(reads: string[]): any {
    return {
      hwnd: 0x1n, zOrder: 0, isMinimized: false, isActive: false,
      get title() { reads.push("read"); return "Notepad"; },
    };
  }

  it("logResolve hashes nothing and reads no process identity", () => {
    logEnabled = false;
    const reads: string[] = [];
    logResolve({ resolver: "findTerminalWindow", query: "x", matches: [probeWin(reads)], identity: "lookup" });
    expect(reads).toEqual([]);
    expect(mockGetWindowIdentity).not.toHaveBeenCalled();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("logDispatchSink makes no Win32 call at all", () => {
    logEnabled = false;
    logDispatchSink({ sink: "wm_char", tool: "terminal:send", targetHwnd: 0x1n });
    expect(mockGetForegroundHwnd).not.toHaveBeenCalled();
    expect(mockGetWindowTitleW).not.toHaveBeenCalled();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("resolution still returns the same window with the log off", () => {
    const windows = [win(0x1n, "Untitled - Notepad", 0), win(0x2n, "Notepad++", 1)];
    logEnabled = true;
    const withLog = pickPlainTopLevelWindowByTitle(windows as any, "notepad");
    logEnabled = false;
    const withoutLog = pickPlainTopLevelWindowByTitle(windows as any, "notepad");
    expect(withoutLog).toBe(withLog);
    expect(withoutLog!.hwnd).toBe(0x1n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The instrumented SSOT — one resolution, one event
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 §2 #1 — pickPlainTopLevelWindowByTitle instrumentation", () => {
  it("logs the full match list and returns the frontmost, unchanged", () => {
    const windows = [win(0x1n, "Untitled - Notepad", 0), win(0x2n, "notes - Notepad", 1)];
    const chosen = pickPlainTopLevelWindowByTitle(windows as any, "notepad");
    expect(chosen!.hwnd).toBe(0x1n);
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
    const e = events()[0]!;
    expect(e.resolver).toBe("pickPlainTopLevelWindowByTitle");
    expect(e.matchCount).toBe(2);
    expect(e.chosen.hwnd).toBe("1");
    expect(e.others.map((o: any) => o.hwnd)).toEqual(["2"]);
  });

  it("logs a miss (matchCount 0, chosen null) — the zero-match H2 case", () => {
    const chosen = pickPlainTopLevelWindowByTitle([win(0x1n, "Calculator", 0)] as any, "notepad");
    expect(chosen).toBeNull();
    expect(events()[0]).toMatchObject({ matchCount: 0, chosen: null });
  });

  it("counts only windows that survive the caller's filters", () => {
    const windows = [
      win(0x1n, "Save As", 0, { className: "#32770" }),
      win(0x2n, "Save As - Notepad", 1, { isMinimized: true }),
      win(0x3n, "Save As backup", 2),
    ];
    pickPlainTopLevelWindowByTitle(windows as any, "save as", {
      excludeMinimized: true, excludeDialogsAndOwned: true,
    });
    expect(events()[0]!.matchCount).toBe(1);
  });

  it("writes nothing for an empty title (the free early-out is preserved)", () => {
    expect(pickPlainTopLevelWindowByTitle([win(0x1n, "A", 0)] as any, "")).toBeNull();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("`logAs: \"off\"` suppresses the event for a caller that logs the resolution itself", () => {
    pickPlainTopLevelWindowByTitle([win(0x1n, "Notepad", 0)] as any, "notepad", { logAs: "off" });
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("`logAs` re-attributes the event to the wrapping resolver", () => {
    pickPlainTopLevelWindowByTitle([win(0x1n, "Notepad", 0)] as any, "notepad", {
      logAs: "inputPipelineCase3",
    });
    expect(events()[0]!.resolver).toBe("inputPipelineCase3");
  });

  it("one resolution = one event: the enumerating wrapper does not double-count", () => {
    mockEnumWindowsInZOrder.mockReturnValue([win(0x1n, "Notepad", 0), win(0x2n, "Notepad 2", 1)]);
    const one = findPlainTopLevelWindowByTitle("notepad");
    expect(one!.hwnd).toBe(0x1n);
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("the plural entry point returns every match and still logs once", () => {
    mockEnumWindowsInZOrder.mockReturnValue([win(0x1n, "Notepad", 0), win(0x2n, "Notepad 2", 1)]);
    const all = findPlainTopLevelWindowsByTitle("notepad", { logAs: "inputPipelineCase3" });
    expect(all.map((w) => w.hwnd)).toEqual([0x1n, 0x2n]);
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
    expect(events()[0]!.matchCount).toBe(2);
  });

  it("a failed enumeration writes nothing and still degrades to no match", () => {
    mockEnumWindowsInZOrder.mockImplementation(() => { throw new Error("no native addon"); });
    expect(findPlainTopLevelWindowByTitle("notepad")).toBeNull();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });
});
