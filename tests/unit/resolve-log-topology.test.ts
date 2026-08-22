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

/** pid → parentPid. Rebuilt per test to model a specific topology. */
let parentMap = new Map<number, number>();
/** pid → image name. */
let processNames = new Map<number, string>();
/** pid → process creation time. A pid alone is not an identity. */
let processStartTimes = new Map<number, number>();
/** hwnd → owning pid. */
let windowOwners = new Map<bigint, number>();
let consoleWindow: bigint | null = null;

const mockBuildProcessParentMap = vi.fn(() => new Map(parentMap));
/** `false` models an older `.node` with no binding / a failed call. */
let consoleWindowReadable = true;
const mockReadOwnConsoleWindow = vi.fn(() => ({
  available: consoleWindowReadable,
  hwnd: consoleWindowReadable ? consoleWindow : null,
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getForegroundHwnd: () => 0x900n,
    getWindowTitleW: () => "Foreground Window",
    getProcessIdentityByPid: (pid: number) => ({
      pid,
      processName: processNames.get(pid) ?? "",
      processStartTimeMs: processStartTimes.get(pid) ?? 1000 + pid,
    }),
    getWindowIdentity: (hwnd: bigint) => {
      const pid = windowOwners.get(hwnd) ?? 0;
      return {
        pid,
        processName: processNames.get(pid) ?? "",
        processStartTimeMs: processStartTimes.get(pid) ?? 1000 + pid,
      };
    },
    buildProcessParentMap: () => mockBuildProcessParentMap(),
    readOwnConsoleWindow: () => mockReadOwnConsoleWindow(),
  };
});

const {
  logResolve,
  logTopologySnapshot,
  appendTopologyWarnings,
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
  processStartTimes = new Map();
  consoleWindow = null;
  consoleWindowReadable = true;
}

function events(kind: string): Record<string, unknown>[] {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.kind === kind);
}

/** Drive one write-tagged resolve onto `hwnd`, as the send path would. */
function resolveOnto(hwnd: bigint, resolver = "findTerminalWindow" as const): void {
  logResolve({
    resolver,
    query: "PowerShell",
    matches: [{ hwnd, title: "PowerShell" }],
    identity: "lookup",
    intent: "write",
  });
}

afterEach(() => {
  // Restored here, not inline: a throw mid-test would otherwise leak a mocked
  // clock into every test that follows.
  vi.useRealTimers();
});

beforeEach(() => {
  mockLogDiagnostic.mockClear();
  mockBuildProcessParentMap.mockClear();
  mockReadOwnConsoleWindow.mockClear();
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
      { pid: SELF, processName: "node.exe", startTimeMs: 1000 + SELF },
      { pid: CLI_PID, processName: "node.exe", startTimeMs: 1000 + CLI_PID },
      { pid: WT_PID, processName: "WindowsTerminal.exe", startTimeMs: 1000 + WT_PID },
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
    expect(snap.ancestry).toEqual([
      { pid: SELF, processName: "node.exe", startTimeMs: 1000 + SELF },
    ]);
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
    expect(mockReadOwnConsoleWindow).not.toHaveBeenCalled();
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
      advisoryQueued: false,
      ancestryUnavailable: false,
    });
  });

  it("does not write one for a non-terminal destination", () => {
    resolveOnto(NOTEPAD_HWND);
    expect(events("resolve")).toHaveLength(1);
    expect(events("topology_relation")).toHaveLength(0);
  });

  it("does not write one for the shared read/write SSOT resolver", () => {
    // `pickPlainTopLevelWindowByTitle` is reached by read paths too and never
    // asks for identity, so both gates exclude it — which is also what keeps
    // its Case 3 pass-through from double-counting against the caller that logs
    // the same resolution (plan §2 residual F1).
    logResolve({
      resolver: "pickPlainTopLevelWindowByTitle",
      query: "PowerShell",
      matches: [{ hwnd: SESSION_WT_HWND, title: "PowerShell" }],
    });
    expect(events("resolve")).toHaveLength(1);
    expect(events("topology_relation")).toHaveLength(0);
  });

  it("stays silent on a read, even one that pays for identity", () => {
    // `findTerminalWindow` is shared by `terminal(action:'read')` and by `run`'s
    // polling loop, which calls it once per poll. Recording those would bury the
    // write records the analysis is actually after.
    logResolve({
      resolver: "findTerminalWindow",
      query: "PowerShell",
      matches: [{ hwnd: SESSION_WT_HWND, title: "PowerShell" }],
      identity: "lookup",
    });
    expect(events("resolve")).toHaveLength(1);
    expect(events("topology_relation")).toHaveLength(0);
    // and no advisory was queued for a read either
    const collected: string[] = [];
    appendTopologyWarnings(collected);
    expect(collected).toEqual([]);
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
      intent: "write",
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
      intent: "write",
    });
    expect(events("topology_relation")[0]).toMatchObject({
      resolver: "findTerminalWindow",
      ownerPid: WT_PID,
      ownerInAncestry: true,
    });
  });

  it("records one relation per destination, however many times a call resolves it", () => {
    // `terminal(action:'run')` resolves the window and then calls the send
    // handler, which resolves it again — one relation, not two. Filtering by
    // resolver name cannot separate them: both are `findTerminalWindow` under
    // one callId, so every run would otherwise count double against every send.
    runWithCallId(() => {
      resolveOnto(OTHER_TERM_HWND);
      resolveOnto(OTHER_TERM_HWND);
      expect(events("resolve")).toHaveLength(2);
      expect(events("topology_relation")).toHaveLength(1);

      // A DIFFERENT destination in the same call is still its own record.
      resolveOnto(SESSION_WT_HWND);
      expect(events("topology_relation")).toHaveLength(2);
    });
  });

  it("flags a console handle it could not read, rather than reporting a bare false", () => {
    // An older `.node` without the binding returns the same "not our console"
    // as a genuine read — and this is the decisive reading for the design
    // question the whole slice exists to answer.
    consoleWindowReadable = false;
    _resetTopologyCachesForTest();
    resolveOnto(OTHER_TERM_HWND);
    expect(events("topology_relation")[0]).toMatchObject({
      isOwnConsoleWindow: false,
      consoleWindowUnavailable: true,
    });

    mockLogDiagnostic.mockClear();
    logTopologySnapshot();
    expect(events("topology_snapshot")[0]).toMatchObject({
      consoleWindow: null,
      consoleWindowUnavailable: true,
    });
  });

  it("leaves the console flag off when the handle was read and is simply not ours", () => {
    resolveOnto(OTHER_TERM_HWND);
    expect(events("topology_relation")[0]).not.toHaveProperty("consoleWindowUnavailable");
  });

  it("re-attempts an ancestry read that failed, instead of caching the failure for the process lifetime", () => {
    parentMap = new Map();
    _resetTopologyCachesForTest();
    resolveOnto(OTHER_TERM_HWND);
    expect(events("topology_relation")[0].ancestryUnavailable).toBe(true);

    // The retry is time-gated, so a server that runs for days is not stuck with
    // one unlucky snapshot — but it does not re-snapshot on every record either.
    seedSessionTopology();
    mockLogDiagnostic.mockClear();
    mockBuildProcessParentMap.mockClear();
    resolveOnto(OTHER_TERM_HWND);
    expect(mockBuildProcessParentMap).not.toHaveBeenCalled();
    expect(events("topology_relation")[0].ancestryUnavailable).toBe(true);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 31_000);
    mockLogDiagnostic.mockClear();
    resolveOnto(OTHER_TERM_HWND);
    expect(events("topology_relation")[0].ancestryUnavailable).toBe(false);
  });

  it("re-attempts a chain with an unreadable link, not just an unreadable self", () => {
    // The snapshot succeeded, so the chain looks fine — but one ancestor's
    // creation time could not be read, and that link can never be verified.
    // Caching it for the server lifetime would classify every destination that
    // ancestor owns as `unverified` forever.
    processStartTimes.set(WT_PID, 0);
    _resetTopologyCachesForTest();
    runWithCallId(() => resolveOnto(SESSION_WT_HWND));
    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      ancestryPidHit: "unverified",
    });

    processStartTimes.set(WT_PID, 1000 + WT_PID);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 31_000);
    mockLogDiagnostic.mockClear();
    runWithCallId(() => resolveOnto(SESSION_WT_HWND));
    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: true,
      advisoryQueued: true,
    });
  });

  it("does not report an age for a snapshot it could not read", () => {
    // `_parentMapAtMs` is deliberately not advanced on a failed read, so an
    // unconditional age would describe a snapshot no longer in use — or, before
    // any read succeeded, report the process data as decades old.
    const CONHOST_PID = 8700;
    const CONSOLE_HWND = 0xddd0n;
    processNames.set(CONHOST_PID, "conhost.exe");
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    parentMap = new Map();
    _resetTopologyCachesForTest();

    resolveOnto(CONSOLE_HWND);

    const rel = events("topology_relation")[0];
    expect(rel.parentMapUnavailable).toBe(true);
    expect(rel).not.toHaveProperty("parentMapAgeMs");
  });

  it("takes one process snapshot for the startup record, so its two claims agree", () => {
    // The conhost-child scan and `processSnapshotUnavailable` used to come from
    // two independent snapshots, which let the record assert "this process owns
    // no console host child" out of a failed read while reporting the other one
    // as successful.
    parentMap = new Map();
    _resetTopologyCachesForTest();
    mockBuildProcessParentMap.mockClear();

    logTopologySnapshot();

    expect(mockBuildProcessParentMap).toHaveBeenCalledTimes(1);
    expect(events("topology_snapshot")[0]).toMatchObject({
      processSnapshotUnavailable: true,
      ownConsoleHostChildPid: null,
    });
  });

  it("retries a failed process snapshot on the cache interval, not on every record", () => {
    // Two halves of the same property. A failure must not be stamped as a fresh
    // read (that would mark a whole cache window unavailable on one transient
    // failure), and it must not be retried per record either (that would
    // hammer a process API that is currently failing).
    const CONHOST_PID = 8400;
    const CONSOLE_HWND = 0xaaa0n;
    const seedConsoleHost = (): void => {
      processNames.set(CONHOST_PID, "conhost.exe");
      windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    };
    seedConsoleHost();
    parentMap = new Map();
    _resetTopologyCachesForTest();
    resolveOnto(CONSOLE_HWND);
    expect(events("topology_relation")[0].parentMapUnavailable).toBe(true);

    // Snapshot readable again — but within the interval, nothing is re-read.
    seedSessionTopology();
    seedConsoleHost();
    parentMap.set(CONHOST_PID, CLI_PID);
    mockLogDiagnostic.mockClear();
    mockBuildProcessParentMap.mockClear();
    resolveOnto(CONSOLE_HWND);
    expect(mockBuildProcessParentMap).not.toHaveBeenCalled();
    expect(events("topology_relation")[0].parentMapUnavailable).toBe(true);

    // Past the interval, it is.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 6_000);
    mockLogDiagnostic.mockClear();
    resolveOnto(CONSOLE_HWND);
    const rel = events("topology_relation")[0];
    expect(rel).not.toHaveProperty("parentMapUnavailable");
    expect(rel.consoleHostParentPid).toBe(CLI_PID);
  });

  it("flags a relation computed from a process table it could not read", () => {
    // With an empty snapshot the chain is just this process, so EVERY
    // `ownerInAncestry:false` is a read failure rather than a negative result.
    // Without the flag the whole run looks like clean negative data.
    parentMap = new Map();
    _resetTopologyCachesForTest();
    resolveOnto(SESSION_WT_HWND);
    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      ancestryUnavailable: true,
    });
  });

  it("omits the console-host parent fields rather than reporting a null parent it never read", () => {
    const CONHOST_PID = 8300;
    const CONSOLE_HWND = 0x99990n;
    processNames.set(CONHOST_PID, "conhost.exe");
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    parentMap = new Map();          // snapshot unreadable
    _resetTopologyCachesForTest();

    resolveOnto(CONSOLE_HWND);

    const rel = events("topology_relation")[0];
    expect(rel).toMatchObject({ ownerIsConsoleHost: true, parentMapUnavailable: true });
    expect(rel).not.toHaveProperty("consoleHostParentPid");
    expect(rel).not.toHaveProperty("consoleHostParentState");
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
      expect(rel).toMatchObject({
        ownerInAncestry: true,
        advisoryQueued: true,
        // WindowsTerminal sits two links above this process in the fixture —
        // a very different reading from a hit on the process itself.
        ancestryDepth: 2,
      });

      const advisories: string[] = [];
      appendTopologyWarnings(advisories);
      expect(advisories).toHaveLength(1);
      expect(advisories[0]).toContain("WindowsTerminal.exe");
      expect(advisories[0]).toContain("nothing was blocked");

      // Asking again does NOT consume it: a handler with several successful
      // return branches, and `run` calling `send` internally, both need to be
      // able to ask (Codex Round 1 P2). Asking twice into the SAME array must
      // not double the string.
      const second: string[] = [];
      appendTopologyWarnings(second);
      expect(second).toEqual(advisories);
      appendTopologyWarnings(advisories);
      expect(advisories).toHaveLength(1);
    });
  });

  it("records advisoryQueued:false when there is no call to attach the advisory to", () => {
    // Outside a wrapped handler the predicate still fires, but nobody will ever
    // see the string — the log must not claim otherwise.
    resolveOnto(SESSION_WT_HWND);
    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: true,
      advisoryQueued: false,
    });
    const collected: string[] = [];
    appendTopologyWarnings(collected);
    expect(collected).toEqual([]);
  });

  it("does not call a recycled pid an ancestor", () => {
    // An ancestor exited, Windows handed its pid to an unrelated terminal. A
    // pid-only rule would call that terminal "ours" for the rest of the server
    // lifetime and put false records into the data OQ-P4 is decided on.
    // Two separate tool calls — one record per (call, destination), so the same
    // window resolved twice inside ONE call would collapse to one record.
    processStartTimes.set(WT_PID, 1000 + WT_PID);
    _resetTopologyCachesForTest();                // cache the chain at this time
    runWithCallId(() => resolveOnto(SESSION_WT_HWND));
    expect(events("topology_relation")[0].ownerInAncestry).toBe(true);

    mockLogDiagnostic.mockClear();
    processStartTimes.set(WT_PID, 9_999_999);     // same pid, different process
    runWithCallId(() => resolveOnto(SESSION_WT_HWND));

    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      ancestryPidHit: "recycled",
    });
  });

  it("counts a pid hit it could not verify separately from a miss", () => {
    // `getProcessIdentityByPid` reports 0 when the read fails. Folding that into
    // a plain false would hide how often the check is blind.
    processStartTimes.set(WT_PID, 0);
    _resetTopologyCachesForTest();
    resolveOnto(SESSION_WT_HWND);
    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      ancestryPidHit: "unverified",
      advisoryQueued: false,
    });
  });

  it("leaves the marker off entirely when the pid never hit the chain", () => {
    resolveOnto(OTHER_TERM_HWND);
    expect(events("topology_relation")[0]).not.toHaveProperty("ancestryPidHit");
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
      advisoryQueued: false,
      ownerIsConsoleHost: true,
      consoleHostParentPid: SHELL_PID,
      consoleHostParentState: "alive",
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
      consoleHostParentState: "gone",
    });
  });

  it("does not call a recycled parent pid alive", () => {
    // The `cmd.exe` a classic console is reparented through exits at once, and
    // a pid freed that early is a prime candidate for reuse. A "parent" that
    // started AFTER its own child is the signature.
    const CONHOST_PID = 8500;
    const REUSED_PID = 8499;
    const CONSOLE_HWND = 0xbbb0n;
    parentMap.set(CONHOST_PID, REUSED_PID);
    parentMap.set(REUSED_PID, 1);                  // present in the table…
    processNames.set(CONHOST_PID, "conhost.exe");
    processStartTimes.set(CONHOST_PID, 5_000);
    processStartTimes.set(REUSED_PID, 9_000);      // …but younger than its child
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    _resetTopologyCachesForTest();

    resolveOnto(CONSOLE_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      consoleHostParentPid: REUSED_PID,
      consoleHostParentState: "recycled",
    });
  });

  it("reports an unverifiable parent lifetime as such", () => {
    const CONHOST_PID = 8600;
    const PARENT_PID = 8599;
    const CONSOLE_HWND = 0xccc0n;
    parentMap.set(CONHOST_PID, PARENT_PID);
    parentMap.set(PARENT_PID, 1);
    processNames.set(CONHOST_PID, "conhost.exe");
    processStartTimes.set(PARENT_PID, 0);          // creation time unreadable
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    _resetTopologyCachesForTest();

    resolveOnto(CONSOLE_HWND);

    expect(events("topology_relation")[0].consoleHostParentState).toBe("unverified");
  });

  it("writes nothing at all when the diagnostic log is off", () => {
    logEnabled = false;
    runWithCallId(() => {
      resolveOnto(SESSION_WT_HWND);
      expect(mockLogDiagnostic).not.toHaveBeenCalled();
      expect(mockBuildProcessParentMap).not.toHaveBeenCalled();
      const collected: string[] = [];
      appendTopologyWarnings(collected);
      expect(collected).toEqual([]);
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
