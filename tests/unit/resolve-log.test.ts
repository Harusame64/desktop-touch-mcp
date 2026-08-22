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
import { readFile } from "node:fs/promises";

const mockLogDiagnostic = vi.fn();
let logEnabled = true;
/** Swapped out by the "broken log module" test below. */
let logEnabledImpl: () => boolean = () => logEnabled;
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return {
    ...actual,
    logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])),
    isDiagnosticLogEnabled: () => logEnabledImpl(),
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
    // `resolveWindowTarget` reads the class of whatever it resolves.
    getWindowClassName: () => "Notepad",
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
  resolveWindowTarget,
} = await import("../../src/tools/_resolve-window.js");

const { productionCheckViewport } = await import("../../src/tools/desktop-register.js");

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

// ─────────────────────────────────────────────────────────────────────────────
// 6. resolveWindowTarget Case 3 / Case 4 — the outcome, not the probe
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — resolveWindowTarget logs the window it actually chose", () => {
  /**
   * The plain-window lookup inside `resolveWindowTarget` is an intermediate
   * probe: when it misses, the common-dialog fallback below it may still return
   * a window. Logging the probe would put `matchCount: 0, chosen: null` in front
   * of a dispatch that DID have a target — the exact join this phase exists to
   * make trustworthy (Codex Round 1 P2).
   */
  it("Case 3 (a plain window matches) logs one event with the match, then passes through", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([win(0x1n, "Untitled - Notepad", 0)]);
    const r = await resolveWindowTarget({ windowTitle: "notepad" });
    expect(r).toBeNull();                       // pass-through, unchanged
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
    expect(events()[0]).toMatchObject({
      resolver: "pickPlainTopLevelWindowByTitle",
      matchCount: 1,
      chosen: { hwnd: "1" },
    });
    expect(events()[0]!.fallback).toBeUndefined();
  });

  it("Case 4 (only a dialog matches) records the DIALOG, not a zero-match miss", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      win(0x10n, "Save As", 0, { className: "#32770" }),
    ]);
    const r = await resolveWindowTarget({ windowTitle: "save as" });
    expect(r).not.toBeNull();
    expect(r!.hwnd).toBe(0x10n);
    // ONE event, and it names the window that was returned.
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
    expect(events()[0]).toMatchObject({
      resolver: "resolveWindowTargetDialog",
      fallback: "owner-chain",
      matchCount: 1,
      chosen: { hwnd: "16" },
    });
  });

  it("Case 4 records the dialogs it passed over", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      win(0x10n, "Save As", 0, { className: "#32770" }),
      win(0x11n, "Save As copy", 1, { className: "#32770" }),
    ]);
    await resolveWindowTarget({ windowTitle: "save as" });
    expect(events()[0]).toMatchObject({ matchCount: 2, chosen: { hwnd: "16" } });
    expect(events()[0]!.others.map((o: any) => o.hwnd)).toEqual(["17"]);
  });

  it("neither route matches → one zero-match event (the H2 case worth counting)", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([win(0x1n, "Calculator", 0)]);
    const r = await resolveWindowTarget({ windowTitle: "notepad" });
    expect(r).toBeNull();
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
    expect(events()[0]).toMatchObject({
      resolver: "pickPlainTopLevelWindowByTitle",
      matchCount: 0,
      chosen: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Never a new crash source
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — observation never throws into its call site", () => {
  it("logResolve swallows a failure while building the record", () => {
    const exploding: any = { hwnd: 0x1n, get title(): string { throw new Error("boom"); } };
    expect(() => logResolve({ resolver: "actionTarget", query: "x", matches: [exploding] })).not.toThrow();
  });

  it("logDispatchSink swallows a failing foreground read", () => {
    mockGetForegroundHwnd.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() => logDispatchSink({ sink: "sendinput", tool: "scroll", targetHwnd: null })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Round 2 — the event must not claim more than the code knows
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — pinnedByHwnd (Opus Round 2 P2)", () => {
  it("is absent by default, so an ordinary title resolution reads as one", () => {
    logResolve({ resolver: "focusWindowForKeyboard", query: "Notepad", matches: [win(0x1n, "Notepad", 0)] });
    expect(events()[0]!.pinnedByHwnd).toBeUndefined();
  });

  it("marks a resolution that matched on the HANDLE, so it cannot deflate the H1 rate", () => {
    logResolve({
      resolver: "focusWindowForKeyboard",
      query: "Notepad",
      matches: [win(0x1n, "Notepad", 0)],
      pinnedByHwnd: true,
    });
    // Same `matchCount: 1` shape as a clean title hit — the flag is the only
    // thing that tells the two apart.
    expect(events()[0]).toMatchObject({ matchCount: 1, pinnedByHwnd: true });
  });
});

describe("ADR-035 Phase 1 — a lazy match list is not built for a disabled log", () => {
  it("does not invoke the thunk when the log is off", () => {
    logEnabled = false;
    const thunk = vi.fn(() => [win(0x1n, "Notepad", 0)]);
    logResolve({ resolver: "actionTarget", query: "x", matches: thunk });
    expect(thunk).not.toHaveBeenCalled();
  });

  it("invokes it exactly once when the log is on, and records the same shape", () => {
    const thunk = vi.fn(() => [win(0x1n, "Notepad", 0), win(0x2n, "Notepad 2", 1)]);
    logResolve({ resolver: "actionTarget", query: "x", matches: thunk });
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(events()[0]).toMatchObject({ matchCount: 2, chosen: { hwnd: "1" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Round 3 — the sites that must NOT log, and the ones that must
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — a zero-character payload is not a dispatch", () => {
  it("skips the event entirely, before any Win32 read", () => {
    logDispatchSink({ sink: "wm_char", tool: "terminal:send", targetHwnd: 0x1n, payloadChars: 0 });
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
    expect(mockGetForegroundHwnd).not.toHaveBeenCalled();
  });

  it("still records a one-character payload", () => {
    logDispatchSink({ sink: "wm_char", tool: "terminal:send", targetHwnd: 0x1n, payloadChars: 1 });
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("records the sinks that have no character payload at all", () => {
    // `press` / `sequence` / `scroll` / clipboard / flash never pass the field:
    // an empty clipboard paste still sends Ctrl+V, and a flash still steals the
    // foreground, so those are real dispatches.
    logDispatchSink({ sink: "sendinput", tool: "keyboard:press", targetHwnd: null });
    logDispatchSink({ sink: "clipboard_paste", tool: "keyboard:type", targetHwnd: null });
    expect(mockLogDiagnostic).toHaveBeenCalledTimes(2);
  });
});

describe("ADR-035 Phase 1 — observation never throws, even on a broken log module", () => {
  it("survives `isDiagnosticLogEnabled` itself throwing", () => {
    // A test file that replaces `diagnostic-log.js` wholesale can leave the
    // export missing; the guard is inside the try for that reason
    // (Opus Round 3 P2).
    const boom = () => { throw new Error("no such export"); };
    const saved = logEnabledImpl;
    logEnabledImpl = boom;
    try {
      expect(() => logResolve({ resolver: "actionTarget", query: "x", matches: [] })).not.toThrow();
      expect(() => logDispatchSink({ sink: "sendinput", tool: "scroll", targetHwnd: null })).not.toThrow();
    } finally {
      logEnabledImpl = saved;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Round 3 — the read-side sites must stay silent, pinned where they are
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-035 Phase 1 — read-side resolutions do not enter the write-path statistics", () => {
  /**
   * These two consume the same SSOT helper as the destination lookups but are
   * asking a different question, and one of them (`mouse.ts`'s observation
   * ladder) runs on the SAME tool call as the Case 3 destination lookup with the
   * opposite dialog/owner flag. Left logging, a single `callId` would carry two
   * resolutions with different match counts and the read could be mistaken for
   * the write (Opus Round 2 P2). Deleting `logAs: "off"` at either site must
   * fail here (Opus Round 3 P2).
   */
  it("the ADR-029 viewport gate writes no resolve event", () => {
    const windows = [
      win(0x1n, "Untitled - Notepad", 0),
      win(0x2n, "notes - Notepad", 1),
    ];
    productionCheckViewport(
      {
        entityId: "e1", role: "button", label: "OK", confidence: 0.9,
        sources: ["visual_gpu"], affordances: [], generation: "g", evidenceDigest: "d",
        rect: { x: 10, y: 10, width: 20, height: 20 },
        origin: { kind: "window", id: "Notepad" },
      } as never,
      { enumerate: (() => windows) as never },
    );
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
  });

  it("the scroll observation ladder keeps its silencing flag", async () => {
    // Pinned at the SOURCE rather than by driving `scrollHandler`: reaching that
    // ladder means reaching the scroll dispatcher, whose Tier 4 is real
    // SendInput, and a unit test must not put input on the developer's desktop.
    // `mouse.ts` uses this helper exactly once and it is read-side, so the
    // invariant is simply "every use here is silenced".
    const src = await readFile(
      new URL("../../src/tools/mouse.ts", import.meta.url),
      "utf8",
    );
    const calls = src.split("findPlainTopLevelWindowByTitle(").slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.slice(0, call.indexOf("});"))).toContain('logAs: "off"');
    }
  });
});
