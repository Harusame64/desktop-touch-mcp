/**
 * resolve-log-topology.test.ts — ADR-035 Phase C-0 measurement contract.
 *
 * C-0 ships no predicate; it ships the data Phase C needs to pick one. So what
 * is pinned here is the shape and the COVERAGE of that data, and in particular
 * the two properties the plan says the measurement dies without:
 *
 *   1. The relation record is written for every terminal-class write
 *      destination, NOT only for the ones the stage-1 predicate flags. Gating
 *      it on the predicate collects nothing at all under a classic console,
 *      where `conhost.exe` is a sibling of the shell rather than an ancestor —
 *      the one configuration Phase C has no data for (plan §3b, Round 14).
 *   2. The stage-1 predicate itself is an instrument, not a guard: when it
 *      fires, an advisory is queued and NOTHING is refused, and the record says
 *      whether the advisory actually reached a caller.
 *
 * Plus the usual pair: zero cost on a disabled log, and zero behaviour change —
 * `TERMINAL_PROCESS_RE` still means exactly what it meant before the pattern
 * moved out of `terminal.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

/** pid → parentPid. Rebuilt per test to model a specific topology. */
let parentMap = new Map<number, number>();
/** pid → image name. */
let processNames = new Map<number, string>();
/** hwnd → owning pid. */
let windowOwners = new Map<bigint, number>();
let consoleWindow: bigint | null = null;

const mockBuildProcessParentMap = vi.fn(() => new Map(parentMap));
const mockGetOwnConsoleWindow = vi.fn(() => consoleWindow);

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getForegroundHwnd: () => 0x900n,
    getWindowTitleW: () => "Foreground Window",
    getProcessIdentityByPid: (pid: number) => ({
      pid,
      processName: processNames.get(pid) ?? "",
      processStartTimeMs: 0,
    }),
    getWindowIdentity: (hwnd: bigint) => {
      const pid = windowOwners.get(hwnd) ?? 0;
      return { pid, processName: processNames.get(pid) ?? "", processStartTimeMs: 0 };
    },
    buildProcessParentMap: () => mockBuildProcessParentMap(),
    getOwnConsoleWindow: () => mockGetOwnConsoleWindow(),
  };
});

const {
  logResolve,
  logTopologySnapshot,
  drainTopologyWarnings,
  runWithCallId,
  _resetTopologyCachesForTest,
} = await import("../../src/tools/_resolve-log.js");

const { TERMINAL_PROCESS_RE, isTerminalClassProcessName, isConsoleHostProcessName } =
  await import("../../src/utils/terminal-process.js");

// ─── Topology fixtures ───────────────────────────────────────────────────────

const SELF = process.pid;
const CLI_PID = 5000;
const WT_PID = 4000;

/**
 * The reported launch chain: this server under the Claude CLI under a Windows
 * Terminal. `wtHwnd` is the session's own WT window; `otherHwnd` is an
 * unrelated terminal owned by a process that is not in the chain.
 */
const SESSION_WT_HWND = 0x2049an;
const OTHER_TERM_HWND = 0x3a0100n;
const NOTEPAD_HWND = 0x50n;

function seedSessionTopology(): void {
  parentMap = new Map([
    [SELF, CLI_PID],
    [CLI_PID, WT_PID],
    [WT_PID, 0],
    [9001, 1], // an unrelated terminal's owner
  ]);
  processNames = new Map([
    [SELF, "node.exe"],
    [CLI_PID, "node.exe"],
    [WT_PID, "WindowsTerminal.exe"],
    [9001, "WindowsTerminal.exe"],
    [7777, "notepad.exe"],
  ]);
  windowOwners = new Map([
    [SESSION_WT_HWND, WT_PID],
    [OTHER_TERM_HWND, 9001],
    [NOTEPAD_HWND, 7777],
  ]);
  consoleWindow = null;
}

function events(kind: string): Record<string, unknown>[] {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.kind === kind);
}

/** Drive one write-side resolve onto `hwnd`, as `findTerminalWindow` would. */
function resolveOnto(hwnd: bigint, resolver = "findTerminalWindow" as const): void {
  logResolve({
    resolver,
    query: "PowerShell",
    matches: [{ hwnd, title: "PowerShell" }],
    identity: "lookup",
  });
}

beforeEach(() => {
  mockLogDiagnostic.mockClear();
  mockBuildProcessParentMap.mockClear();
  mockGetOwnConsoleWindow.mockClear();
  logEnabled = true;
  _resetTopologyCachesForTest();
  seedSessionTopology();
});

// ─── Startup snapshot ────────────────────────────────────────────────────────

describe("ADR-035 Phase C-0 — startup topology snapshot", () => {
  it("records the launch chain, the console window, and the own console host", () => {
    consoleWindow = 0xabc0n;
    parentMap.set(6100, SELF); // a conhost child of THIS process
    processNames.set(6100, "conhost.exe");

    logTopologySnapshot();

    const snap = events("topology_snapshot");
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      consoleWindow: String(0xabc0n),
      ownConsoleHostChildPid: 6100,
      ownConsoleHostChildName: "conhost.exe",
      processSnapshotUnavailable: false,
    });
    // Self first, then up the chain, image names included.
    expect(snap[0].ancestry).toEqual([
      { pid: SELF, processName: "node.exe" },
      { pid: CLI_PID, processName: "node.exe" },
      { pid: WT_PID, processName: "WindowsTerminal.exe" },
    ]);
    expect(snap[0].launchPath).toBe("node.exe < node.exe < WindowsTerminal.exe");
  });

  it("says so when the process snapshot was unavailable, instead of reporting no ancestors", () => {
    // `buildProcessParentMap` swallows failures and returns an empty map, so
    // "no parents" and "could not read parents" look identical to a caller.
    parentMap = new Map();
    logTopologySnapshot();

    const snap = events("topology_snapshot")[0];
    expect(snap.processSnapshotUnavailable).toBe(true);
    expect(snap.ancestry).toEqual([{ pid: SELF, processName: "node.exe" }]);
  });

  it("reports a null console window when the process has none", () => {
    consoleWindow = null;
    logTopologySnapshot();
    expect(events("topology_snapshot")[0].consoleWindow).toBeNull();
  });

  it("stops at the ancestry cap instead of walking a cyclic snapshot forever", () => {
    parentMap = new Map([[SELF, 100], [100, SELF]]);
    processNames.set(100, "weird.exe");
    logTopologySnapshot();
    expect((events("topology_snapshot")[0].ancestry as unknown[]).length).toBe(2);
  });

  it("costs nothing when the diagnostic log is off", () => {
    logEnabled = false;
    logTopologySnapshot();
    expect(mockLogDiagnostic).not.toHaveBeenCalled();
    expect(mockBuildProcessParentMap).not.toHaveBeenCalled();
    expect(mockGetOwnConsoleWindow).not.toHaveBeenCalled();
  });
});

// ─── Relation coverage ───────────────────────────────────────────────────────

describe("ADR-035 Phase C-0 — topology relation coverage", () => {
  it("writes a relation record for a terminal destination the predicate does NOT flag", () => {
    // The whole point of Round 14: an unrelated terminal still produces data.
    resolveOnto(OTHER_TERM_HWND);

    const rel = events("topology_relation");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({
      resolver: "findTerminalWindow",
      targetHwnd: String(OTHER_TERM_HWND),
      ownerPid: 9001,
      ownerProcessName: "WindowsTerminal.exe",
      ownerInAncestry: false,
      ownerIsConsoleHost: false,
      isOwnConsoleWindow: false,
      warned: false,
    });
  });

  it("does not write one for a non-terminal destination", () => {
    resolveOnto(NOTEPAD_HWND);
    expect(events("resolve")).toHaveLength(1);
    expect(events("topology_relation")).toHaveLength(0);
  });

  it("does not write one for the shared read/write SSOT resolver", () => {
    // `pickPlainTopLevelWindowByTitle` is reached by read paths too and never
    // asks for identity, so the identity gate silently excludes it — which is
    // also what keeps its Case 3 pass-through from double-counting against the
    // caller that logs the same resolution (plan §2 residual F1).
    logResolve({
      resolver: "pickPlainTopLevelWindowByTitle",
      query: "PowerShell",
      matches: [{ hwnd: SESSION_WT_HWND, title: "PowerShell" }],
    });
    expect(events("resolve")).toHaveLength(1);
    expect(events("topology_relation")).toHaveLength(0);
  });

  it("adds no syscall of its own: a resolve that did not pay for identity gets no record", () => {
    // Phase 1 made identity a per-site opt-in because it costs an OpenProcess
    // per window. C-0 reuses that opt-in as its gate rather than re-adding the
    // cost — so `inputPipelineCase3` (scroll) and `actionTarget` (click), the
    // two write resolvers Phase 1 left at "skip", stay uninstrumented. Neither
    // is in Phase C's refusal scope.
    logResolve({
      resolver: "inputPipelineCase3",
      query: "PowerShell",
      matches: [{ hwnd: SESSION_WT_HWND, title: "PowerShell" }],
    });
    expect(events("resolve")).toHaveLength(1);
    expect(events("topology_relation")).toHaveLength(0);
  });

  it("covers the process-name rescue, which passes identity without asking for a lookup", () => {
    // `findTerminalWindow`'s zero-title-match fallback — the H2 sub-path — hands
    // the identity in on `chosen`. The gate has to accept that shape too.
    logResolve({
      resolver: "findTerminalWindow",
      query: "pwsh",
      matches: [],
      chosen: {
        hwnd: SESSION_WT_HWND,
        title: "PowerShell",
        pid: WT_PID,
        processName: "WindowsTerminal.exe",
      },
      fallback: "process-name",
    });
    expect(events("topology_relation")[0]).toMatchObject({
      resolver: "findTerminalWindow",
      ownerPid: WT_PID,
      ownerInAncestry: true,
    });
  });

  it("marks the destination that IS this process's own console window", () => {
    consoleWindow = SESSION_WT_HWND;
    resolveOnto(SESSION_WT_HWND);
    expect(events("topology_relation")[0].isOwnConsoleWindow).toBe(true);
  });
});

// ─── Stage-1 instrument ──────────────────────────────────────────────────────

describe("ADR-035 Phase C-0 — stage-1 instrument", () => {
  it("flags an ancestor-owned terminal and queues an advisory, blocking nothing", () => {
    runWithCallId(() => {
      resolveOnto(SESSION_WT_HWND);

      const rel = events("topology_relation")[0];
      expect(rel).toMatchObject({ ownerInAncestry: true, warned: true });

      const advisories = drainTopologyWarnings();
      expect(advisories).toHaveLength(1);
      expect(advisories[0]).toContain("WindowsTerminal.exe");
      expect(advisories[0]).toContain("nothing was blocked");
      // Drained once, gone — a second handler must not re-report it.
      expect(drainTopologyWarnings()).toEqual([]);
    });
  });

  it("records warned:false when there is no call to attach the advisory to", () => {
    // Outside a wrapped handler the predicate still fires, but nobody will ever
    // see the string — the log must not claim otherwise.
    resolveOnto(SESSION_WT_HWND);
    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: true,
      warned: false,
    });
    expect(drainTopologyWarnings()).toEqual([]);
  });

  it("cannot fire under a classic console, which is why the relation record is unconditional", () => {
    // conhost is a SIBLING of the shell, not an ancestor (ADR-035 §6.2). The
    // predicate is therefore structurally silent here — and the record is what
    // Phase C actually gets to work with.
    const CONHOST_PID = 8100;
    const SHELL_PID = 8000;
    const CONSOLE_HWND = 0x77770n;
    parentMap.set(SHELL_PID, CLI_PID);
    parentMap.set(CONHOST_PID, SHELL_PID);
    processNames.set(SHELL_PID, "pwsh.exe");
    processNames.set(CONHOST_PID, "conhost.exe");
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);

    resolveOnto(CONSOLE_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      warned: false,
      ownerIsConsoleHost: true,
      consoleHostParentPid: SHELL_PID,
      consoleHostParentAlive: true,
      consoleHostParentInAncestry: false,
    });
  });

  it("reports a console host whose parent has already exited", () => {
    // `launch_console classic` reparents through a `cmd.exe` that dies at once
    // (plan §3b Round 6 P1-A) — a predicate keyed on the parent would have to
    // choose between refusing a console we opened ourselves and matching a
    // recycled pid. The record says which case this is.
    const CONHOST_PID = 8200;
    const DEAD_CMD_PID = 8199;
    const CONSOLE_HWND = 0x88880n;
    parentMap.set(CONHOST_PID, DEAD_CMD_PID); // DEAD_CMD_PID itself is NOT in the map
    processNames.set(CONHOST_PID, "OpenConsole.exe");
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);

    resolveOnto(CONSOLE_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      ownerIsConsoleHost: true,
      consoleHostParentPid: DEAD_CMD_PID,
      consoleHostParentAlive: false,
    });
  });

  it("writes nothing at all when the diagnostic log is off", () => {
    logEnabled = false;
    runWithCallId(() => {
      resolveOnto(SESSION_WT_HWND);
      expect(mockLogDiagnostic).not.toHaveBeenCalled();
      expect(mockBuildProcessParentMap).not.toHaveBeenCalled();
      expect(drainTopologyWarnings()).toEqual([]);
    });
  });
});

// ─── Zero behaviour change ───────────────────────────────────────────────────

describe("ADR-035 Phase C-0 — the terminal-class predicate", () => {
  it("keeps TERMINAL_PROCESS_RE exactly as it was before the move out of terminal.ts", () => {
    for (const name of [
      "WindowsTerminal", "WindowsTerminal.exe", "conhost.exe", "pwsh", "powershell.exe",
      "cmd.exe", "bash", "wsl.exe", "alacritty", "wezterm.exe", "mintty",
    ]) {
      expect(TERMINAL_PROCESS_RE.test(name)).toBe(true);
    }
    for (const name of ["notepad.exe", "chrome.exe", "", "cmd.com", "mycmd.exe"]) {
      expect(TERMINAL_PROCESS_RE.test(name)).toBe(false);
    }
    // The one C-0 widens by: the modern console host is NOT in the base pattern
    // (plan Round 25 W-1), and Phase 2 is what folds it in.
    expect(TERMINAL_PROCESS_RE.test("OpenConsole.exe")).toBe(false);
    expect(isTerminalClassProcessName("OpenConsole.exe")).toBe(true);
  });

  it("counts only the two console hosts as console hosts", () => {
    expect(isConsoleHostProcessName("conhost.exe")).toBe(true);
    expect(isConsoleHostProcessName("OpenConsole")).toBe(true);
    expect(isConsoleHostProcessName("pwsh.exe")).toBe(false);
    expect(isConsoleHostProcessName("WindowsTerminal.exe")).toBe(false);
  });
});
