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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * The fixture's clock for a pid nobody seeded: the mock's fallback.
 *
 * **It is the OFFSET that feeds it, not the pid** (gate 2 on #709). With pids written against
 * `FIXTURE_PID_BASE`, a `1000 + pid` fallback lands at ~4.29e9 ms — AFTER every time the tests seed
 * by hand, which are in the thousands. A parent left on the fallback would then start after its own
 * child: the recycled-pid signature the walk truncates on, arrived at by arithmetic rather than by
 * anything a test meant. Taking the offset keeps the fixture's clock exactly where it was before
 * the pids moved, so this change moves identities and no times at all.
 *
 * Declared as a `function` so the `vi.mock` factory below, which is hoisted, can reach it.
 */
function fallbackStartMs(pid: number): number {
  return 1000 + (pid >= FIXTURE_PID_BASE ? pid - FIXTURE_PID_BASE : pid);
}

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
      processStartTimeMs: processStartTimes.get(pid) ?? fallbackStartMs(pid),
    }),
    getWindowIdentity: (hwnd: bigint) => {
      const pid = windowOwners.get(hwnd) ?? 0;
      return {
        pid,
        processName: processNames.get(pid) ?? "",
        processStartTimeMs: processStartTimes.get(pid) ?? fallbackStartMs(pid),
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

// The MOCKED provider, imported so the fixture-invariant cells read start times through the same
// door the walk does rather than through a second copy of the mock's rule (internal #153, gate 2).
const { getProcessIdentityByPid, getWindowIdentity, buildProcessParentMap } =
  await import("../../src/engine/win32.js");

// ─── Topology fixtures ───────────────────────────────────────────────────────

const SELF = process.pid;

/**
 * The base every pid this fixture makes up is written against.
 *
 * `SELF` is the real `process.pid` — the walk in `_resolve-log.ts` starts there, so the fixture
 * does not get to choose it. Every OTHER pid it does choose, and the property that matters is that
 * none of them can ever BE `SELF`. When one collides, the parent map, the name map and the
 * window-owner map describe a single pid as two different processes, and the cells below fail with
 * a diff about pids that reads like a product defect (internal #155).
 *
 * Measured on this file by stubbing `process.pid`: **9001 → 15 of 50 red, 4000 → 7, 5000 → 5,
 * 7777 → 2, 100 → 1** — and on 2026-09-21 this machine handed the test runner pid **4513**, so the
 * range was live rather than theoretical.
 *
 * `2 ** 32` is not "large enough to be unlikely". It is above every pid any of the three platforms
 * can hand out: a Windows pid is a DWORD (`0xFFFFFFFC` at the very most), Linux caps `pid_max` at
 * `2 ** 22`, macOS at 99999. **So a collision is impossible rather than rare** — which is the whole
 * difference, because "rare" is what left this file flaky for months (internal #153).
 */
const FIXTURE_PID_BASE = 2 ** 32;

const CLI_PID = FIXTURE_PID_BASE + 5000;
const WT_PID = FIXTURE_PID_BASE + 4000;
/** An unrelated Windows Terminal, and the parent it was launched from — itself not modelled. */
const OTHER_WT_PID = FIXTURE_PID_BASE + 9001;
const OTHER_WT_PARENT_PID = FIXTURE_PID_BASE + 1;
/** A notepad that owns a window but is in nobody's chain. */
const NOTEPAD_PID = FIXTURE_PID_BASE + 7777;

/**
 * When THIS process started, in the fixture's clock.
 *
 * **IT IS SEEDED, and leaving it to the `1000 + pid` fallback is what made this file flaky for
 * months** (internal #153, measured 2026-09-21). `SELF` is the real `process.pid`, so the fallback
 * makes this process's start time depend on a number the OS hands out. The walk in `_resolve-log.ts`
 * refuses a parent that started AFTER its child — the recycled-pid guard — and the CLI's fallback
 * start is 6000 (the fixture's pids sat inside the OS's range until internal #155 moved them above
 * it, and its clock reads the offset since). So the chain survived only when the machine gave the
 * runner **a pid above 5000**:
 *
 *   morning run, pid 4513 → the chain truncates to one entry, 11 of 47 cells red
 *   evening run, pid 84757 → 47 of 47 green
 *
 * Same command, same commit, two answers. It read as "adding a test file breaks it" and as an
 * order dependence, because spawning more processes first nudges the pid up. Neither was the cause.
 */
const SELF_STARTED_MS = fallbackStartMs(CLI_PID) + 1;

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
    [OTHER_WT_PID, OTHER_WT_PARENT_PID], // an unrelated terminal's owner
  ]);
  processNames = new Map([
    [SELF, "node.exe"],
    [CLI_PID, "node.exe"],
    [WT_PID, "WindowsTerminal.exe"],
    [OTHER_WT_PID, "WindowsTerminal.exe"],
    [NOTEPAD_PID, "notepad.exe"],
  ]);
  windowOwners = new Map([
    [SESSION_WT_HWND, WT_PID],
    [OTHER_TERM_HWND, OTHER_WT_PID],
    [NOTEPAD_HWND, NOTEPAD_PID],
  ]);
  // The chain models a real launch, so the times have to run in that order: the terminal first,
  // then the CLI it hosts, then this process. Only SELF needs seeding — every other pid's
  // `fallbackStartMs` already satisfies it — and `everyChainRunsParentFirst` below is what
  // notices if that stops being true.
  processStartTimes = new Map([[SELF, SELF_STARTED_MS]]);
  consoleWindow = null;
  consoleWindowReadable = true;
}

/**
 * Every pid the fixture has put into its maps that the OS could also hand out — empty when the
 * fixture is well formed (internal #155).
 *
 * `0` is the idle process, the documented top of the tree, and `SELF` is this process, which the
 * fixture does not choose. Everything else it invented, and an invented pid inside the OS's range
 * is one this run could have been given.
 */
function fixturePidsInsideTheOsRange(): string[] {
  const offenders: string[] = [];
  const check = (where: string, pid: number): void => {
    if (pid === 0 || pid === SELF) return;
    if (pid < FIXTURE_PID_BASE) offenders.push(`${where}: ${pid}`);
  };
  for (const [child, parent] of parentMap) {
    check("parentMap key", child);
    check("parentMap value", parent);
  }
  for (const pid of processNames.keys()) check("processNames key", pid);
  for (const pid of processStartTimes.keys()) check("processStartTimes key", pid);
  for (const pid of windowOwners.values()) check("windowOwners value", pid);
  return offenders;
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

  // **After every test, because most of the fixture's pids are added inside one** (internal #155).
  // A cell that read only `seedSessionTopology`'s maps would miss the two dozen pids the tests
  // below invent, and those are collidable in exactly the same way.
  expect(
    fixturePidsInsideTheOsRange(),
    "a pid this fixture invented is inside the range the OS hands out. If a run's `process.pid` " +
      "is that number, the parent map, the name map and the window-owner map describe one pid as " +
      "two processes, and cells about something else fail with a diff about pids (internal " +
      "#155). Write it as `FIXTURE_PID_BASE + n`.",
  ).toEqual([]);
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

// ─── Fixture invariants ──────────────────────────────────────────────────────

describe("the fixture itself", () => {
  it("does not let this process's pid decide what the fixture says", () => {
    // **internal #153, and this cell is the part that has to outlive the fix.**
    //
    // The walk in `_resolve-log.ts` refuses a parent that started AFTER its child — the recycled-pid
    // guard — and **truncates the chain** rather than failing. So a topology whose times run the
    // wrong way returns a SHORTER chain, and the cells below fail with a diff about pids that reads
    // like a product defect.
    //
    // That is what happened for months: `SELF` is the real `process.pid`, its start time fell
    // through the mock's `1000 + pid` fallback, and the CLI's fallback start is 6000 — so the chain
    // survived only when the machine handed the runner a pid at or above 5000. Measured the same
    // day, same commit: **pid 4513 → 11 of 47 red; pid 84757 → 47 of 47 green.**
    //
    // **THE FIRST VERSION OF THIS CELL DID NOT CHECK THAT** (gate 2). It asserted
    // `processStartTimes.has(SELF)` — that a seed EXISTS — while its own comment claimed it checked
    // that the value is not pid-derived. Those are different properties, and the difference is the
    // whole defect: `SELF_STARTED_MS = 1000 + SELF` is a seed, and it passes 48/48 on a machine with
    // a high pid. A comment is a claim, not a check — written in the cell about exactly that.
    //
    // So the property is pinned where it can be decided without running: **the definition of
    // `SELF_STARTED_MS` must not mention the pid at all.**
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const definition = /^const SELF_STARTED_MS = (.*);$/m.exec(source);
    expect(definition, "SELF_STARTED_MS is no longer declared where this cell reads it").not.toBeNull();
    for (const forbidden of ["SELF", "process.pid"]) {
      expect(
        definition![1],
        `SELF_STARTED_MS is derived from ${forbidden} — the fixture's clock then depends on a number ` +
          "the OS hands out, and the chain truncates below ~5000 (internal #153)",
      ).not.toContain(forbidden);
    }
    // CONTROL: the read found the real declaration, not an empty match that would pass anything.
    expect(definition![1]).toMatch(/\d/);
  });

  it("seeds every chain so a parent starts at or before its child, read through the provider", () => {
    // **READ THROUGH THE MOCKED PROVIDER, not a copy of its rule** (gate 2). The first version
    // carried its own `?? 1000 + pid`, a second copy of the mock's fallback — and moving the mock's
    // constant alone left this cell green while eleven product cells went red with the #153 diff.
    // The walk reads `getProcessIdentityByPid`; so does this.
    const startOf = (pid: number) => getProcessIdentityByPid(pid).processStartTimeMs;

    const walkFrom = (from: number): number[] => {
      let pid = from;
      const seen = new Set<number>();
      const walked: number[] = [];
      while (!seen.has(pid)) {
        seen.add(pid);
        walked.push(pid);
        const parent = parentMap.get(pid);
        if (parent === undefined || parent === 0) break;
        // `toBeLessThanOrEqual`, because the producer's guard is `>` — equal times are accepted
        // there, and a cell stricter than the thing it models reports a failure the product would
        // not have.
        expect(
          startOf(parent),
          `the fixture has pid ${parent} (the parent) starting at or after pid ${pid} (its child) — ` +
            "the walk truncates there, and every chain assertion below reads the truncation as a " +
            "product defect",
        ).toBeLessThanOrEqual(startOf(pid));
        pid = parent;
      }
      return walked;
    };

    // **EVERY chain in the seed, which is what this cell has always been named after** (gate 2 on
    // #709): it walked one, this process's.
    //
    // **And that is not what protects the side chains the tests build.** Measured: seeding the side
    // chains' parent while the fallback still read the pid left this cell GREEN (50/50), because
    // the seeded topology is consistent under both rules — the inversion only appeared once a test
    // seeded a child in the thousands under a parent on the fallback. The rule cannot be moved into
    // `afterEach` either: several tests invert a pair ON PURPOSE (a parent younger than its child
    // is the recycled-pid case they exist to cover). What removes the class is `fallbackStartMs`
    // reading the offset, above — one clock for the whole fixture.
    for (const start of [...parentMap.keys()]) walkFrom(start);

    // CONTROL 1: the walk really walked the three-deep launch this file describes.
    expect(walkFrom(SELF), "the seeded chain is not the launch this file models").toEqual([
      SELF, CLI_PID, WT_PID,
    ]);
    // CONTROL 2: **the ordering assertion can fail.** The line that stood here —
    // `expect(startOf(CLI_PID)).toBeGreaterThan(startOf(WT_PID) - 1001)` — could not: reaching it
    // meant the loop had already proven `startOf(WT_PID) < startOf(CLI_PID)`, so it was true by
    // construction. A dead assertion in the control position is worse than none: it reads as
    // evidence. This one inverts a pair and checks the comparison rejects it.
    processStartTimes.set(WT_PID, startOf(CLI_PID) + 1);
    expect(() =>
      expect(startOf(WT_PID)).toBeLessThanOrEqual(startOf(CLI_PID)),
    ).toThrow();
    processStartTimes.delete(WT_PID);
  });

  it("invents no pid the OS could hand out, so this run's pid cannot be one of them", () => {
    // **internal #155 — the identity axis of #153, and the cell that stood here could not fail.**
    //
    // That cell built a Set of the fixture's pids, deleted `SELF` from it, and asserted the Set did
    // not contain `SELF` — true after the delete, whatever the maps held. It was written to make a
    // collision diagnosable and it announced nothing: measured 2026-09-22 with `process.pid`
    // stubbed to 9001, a pid the fixture then hardcoded, **15 of 50 cells went red and this one
    // stayed green**. A Set cannot tell a legitimate `SELF` entry from a collision, because a
    // collision is the two being the same number.
    //
    // So the property is no longer "say so when it happens". It is **the fixture cannot invent a
    // pid the OS is able to hand out**, which makes the collision impossible instead of rare.
    expect(
      fixturePidsInsideTheOsRange(),
      "the seeded topology invented a pid inside the OS's range (internal #155)",
    ).toEqual([]);

    // Above every pid the three platforms can produce — Windows `0xFFFFFFFC`, Linux `pid_max` at
    // `2 ** 22`, macOS 99999 — so no `process.pid` can reach the fixture's numbering.
    expect(
      FIXTURE_PID_BASE,
      "FIXTURE_PID_BASE is inside the range some platform can hand out as a pid",
    ).toBeGreaterThanOrEqual(2 ** 32);

    // Pinned where it is decided without running, the way `SELF_STARTED_MS` is above: a base
    // derived from this run's own pid would put the fixture back on a number the OS chooses.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const definition = /^const FIXTURE_PID_BASE = (.*);$/m.exec(source);
    expect(definition, "FIXTURE_PID_BASE is no longer declared where this cell reads it").not.toBeNull();
    for (const forbidden of ["SELF", "process.pid"]) {
      expect(definition![1]).not.toContain(forbidden);
    }

    // The mocked providers hand the pid back as they got it. The REAL ones narrow to a DWORD —
    // `getProcessIdentityByPid` (`win32.ts:556`), `getWindowIdentity` (`:408`) and
    // `buildProcessParentMap` (`:605`) — which would fold `FIXTURE_PID_BASE + 5000` back to 5000,
    // inside the OS's range again and silently. **All three, because the fixture reaches the
    // product through all three** (gate 2 on #709): the sweep above reads what the fixture STORES,
    // never what the product RECEIVES, so a mock aligned with the real one on any of these roads
    // would put the collision back with every cell still green.
    expect(getProcessIdentityByPid(CLI_PID).pid).toBe(CLI_PID);
    expect(getWindowIdentity(SESSION_WT_HWND).pid).toBe(WT_PID);
    expect(buildProcessParentMap().get(CLI_PID)).toBe(WT_PID);

    // CONTROL: the sweep can fail. Injected and withdrawn before the assertion, so `afterEach`'s
    // sweep does not report it a second time.
    //
    // `SELF + 1` rather than a literal, and that is not fussiness: **the first version of this
    // control used 9001 and went red when the run's pid WAS 9001** (measured 2026-09-22, the same
    // stub that found the dead cell) — the sweep skips `SELF`, correctly, so the injected pid
    // stopped being an offender. A control written against a number the OS can hand out has the
    // defect this cell is about. `SELF + 1` is inside the OS's range on every platform (a pid is
    // at most `0xFFFFFFFC`) and is never this run's pid.
    const collidable = SELF + 1;
    parentMap.set(collidable, OTHER_WT_PARENT_PID);
    const withACollidablePid = fixturePidsInsideTheOsRange();
    parentMap.delete(collidable);
    expect(
      withACollidablePid,
      "the sweep passed a pid the OS hands out — it is not checking what this cell claims",
    ).toContain(`parentMap key: ${collidable}`);
  });
});

describe("ADR-035 Phase C-0 — startup topology snapshot", () => {
  it("records the launch chain, the console window, and the own console host", () => {
    consoleWindow = 0xabc0n;
    const CONHOST_CHILD_PID = FIXTURE_PID_BASE + 6100; // a conhost child of THIS process
    parentMap.set(CONHOST_CHILD_PID, SELF);
    processNames.set(CONHOST_CHILD_PID, "conhost.exe");

    logTopologySnapshot();

    const snap = events("topology_snapshot");
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      consoleWindow: String(0xabc0n),
      ownConsoleHostChildPid: CONHOST_CHILD_PID,
      ownConsoleHostChildName: "conhost.exe",
      processSnapshotUnavailable: false,
    });
    // Self first, then up the chain, image names included.
    expect(snap[0].ancestry).toEqual([
      { pid: SELF, processName: "node.exe", startTimeMs: SELF_STARTED_MS },
      { pid: CLI_PID, processName: "node.exe", startTimeMs: fallbackStartMs(CLI_PID) },
      { pid: WT_PID, processName: "WindowsTerminal.exe", startTimeMs: fallbackStartMs(WT_PID) },
    ]);
    expect(snap[0].launchPath).toBe("node.exe < node.exe < WindowsTerminal.exe");
  });

  it("does not report a clean absence of a console host child when a child was unreadable", () => {
    // The child that could not be read may have BEEN the console host, and this
    // is the decisive datum the slice exists to collect.
    const UNREADABLE_CHILD_PID = FIXTURE_PID_BASE + 6200;
    parentMap.set(UNREADABLE_CHILD_PID, SELF);     // a child of this process…
    processNames.set(UNREADABLE_CHILD_PID, "");    // …whose image name won't read
    logTopologySnapshot();

    expect(events("topology_snapshot")[0]).toMatchObject({
      ownConsoleHostChildPid: null,
      ownConsoleHostChildScanIncomplete: 1,
    });
  });

  it("releases the process table once the startup scan has read it", () => {
    // A full process table held for the life of the server, for a value read
    // once. The startup scan is its only reader.
    const CONHOST_CHILD_PID = FIXTURE_PID_BASE + 6400;
    parentMap.set(CONHOST_CHILD_PID, SELF);
    processNames.set(CONHOST_CHILD_PID, "conhost.exe");
    _resetTopologyCachesForTest();
    logTopologySnapshot();
    expect(events("topology_snapshot")[0].ownConsoleHostChildPid).toBe(CONHOST_CHILD_PID);

    // The record is a startup one-shot, so a second call finding the map gone
    // is not a regression — it is what pins that nothing holds onto the table.
    mockLogDiagnostic.mockClear();
    logTopologySnapshot();
    expect(events("topology_snapshot")[0].ownConsoleHostChildPid).toBeNull();
  });

  it("does not re-retain the process table when the chain is rebuilt later", () => {
    // The scan runs once. A rebuild after it would otherwise hang a fresh full
    // process table on the cache that nothing ever reads or frees.
    parentMap = new Map();
    _resetTopologyCachesForTest();
    logTopologySnapshot();                       // scan has now run
    seedSessionTopology();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 31_000);       // past the ancestry retry window
    mockLogDiagnostic.mockClear();
    resolveOnto(OTHER_TERM_HWND);                // forces a rebuild

    // The rebuild took effect…
    expect(events("topology_relation")[0].ancestryUnavailable).toBe(false);
    // …and the new snapshot is not being held: a second startup record finds
    // nothing to scan.
    mockLogDiagnostic.mockClear();
    logTopologySnapshot();
    expect(events("topology_snapshot")[0].ownConsoleHostChildPid).toBeNull();
  });

  it("leaves the scan marker off when every child read fine", () => {
    const NOTEPAD_CHILD_PID = FIXTURE_PID_BASE + 6300;
    parentMap.set(NOTEPAD_CHILD_PID, SELF);
    processNames.set(NOTEPAD_CHILD_PID, "notepad.exe");
    logTopologySnapshot();
    expect(events("topology_snapshot")[0]).not.toHaveProperty(
      "ownConsoleHostChildScanIncomplete",
    );
  });

  it("says so when the process snapshot was unavailable, instead of reporting no ancestors", () => {
    // `buildProcessParentMap` swallows failures and returns an empty map, so
    // "no parents" and "could not read parents" look identical to a caller.
    parentMap = new Map();
    logTopologySnapshot();

    const snap = events("topology_snapshot")[0];
    expect(snap.processSnapshotUnavailable).toBe(true);
    expect(snap.ancestry).toEqual([
      { pid: SELF, processName: "node.exe", startTimeMs: SELF_STARTED_MS },
    ]);
  });

  it("reports a null console window when the process has none", () => {
    consoleWindow = null;
    logTopologySnapshot();
    expect(events("topology_snapshot")[0].consoleWindow).toBeNull();
  });

  it("stops at the ancestry cap instead of walking a cyclic snapshot forever", () => {
    const CYCLE_PID = FIXTURE_PID_BASE + 100;
    parentMap = new Map([[SELF, CYCLE_PID], [CYCLE_PID, SELF]]);
    processNames.set(CYCLE_PID, "weird.exe");
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
      ownerPid: OTHER_WT_PID,
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

  it("gives up rebuilding a chain whose unreadable link is permanent", () => {
    // An elevated ancestor `OpenProcess` will never open. Rebuilding the chain
    // every retry window forever, for a read that cannot succeed, is not
    // measurement — each rebuild costs a snapshot plus a walk. Observable as:
    // past the attempt cap, even a link that becomes readable is not picked up.
    processStartTimes.set(WT_PID, 0);
    _resetTopologyCachesForTest();
    resolveOnto(SESSION_WT_HWND);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(Date.now() + 31_000);
      resolveOnto(SESSION_WT_HWND);
    }
    processStartTimes.set(WT_PID, fallbackStartMs(WT_PID));   // readable again, too late
    vi.setSystemTime(Date.now() + 31_000);
    mockLogDiagnostic.mockClear();
    resolveOnto(SESSION_WT_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      ancestryPidHit: "unverified",
    });
  });

  it("stops counting a link unreadable once the process has left the table", () => {
    // A creation time that cannot be read because the ancestor EXITED is not a
    // transient failure — there is nothing to come back for, so no rebuild.
    processStartTimes.set(WT_PID, 0);
    parentMap.delete(WT_PID);
    _resetTopologyCachesForTest();
    resolveOnto(SESSION_WT_HWND);

    // Even if it somehow becomes readable, the chain is not rebuilt for it.
    processStartTimes.set(WT_PID, fallbackStartMs(WT_PID));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 31_000);
    mockLogDiagnostic.mockClear();
    resolveOnto(SESSION_WT_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      ownerInAncestry: false,
      ancestryPidHit: "unverified",
    });
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

    processStartTimes.set(WT_PID, fallbackStartMs(WT_PID));
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
    const CONHOST_PID = FIXTURE_PID_BASE + 8700;
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
    const CONHOST_PID = FIXTURE_PID_BASE + 8400;
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
    const CONHOST_PID = FIXTURE_PID_BASE + 8300;
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
    processStartTimes.set(WT_PID, fallbackStartMs(WT_PID));
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
    const CONHOST_PID = FIXTURE_PID_BASE + 8100;
    const SHELL_PID = FIXTURE_PID_BASE + 8000;
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
    const CONHOST_PID = FIXTURE_PID_BASE + 8200;
    const DEAD_CMD_PID = FIXTURE_PID_BASE + 8199;
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
    const CONHOST_PID = FIXTURE_PID_BASE + 8500;
    const REUSED_PID = FIXTURE_PID_BASE + 8499;
    const CONSOLE_HWND = 0xbbb0n;
    parentMap.set(CONHOST_PID, REUSED_PID);
    parentMap.set(REUSED_PID, OTHER_WT_PARENT_PID); // present in the table…
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

  it("stops the walk at a parent younger than its own child, rather than adopting it", () => {
    // The real ancestor exited and Windows handed its pid on before the first
    // snapshot. Toolhelp still reports the historical parent pid, so walking
    // into the replacement would cache an unrelated process AS an ancestor —
    // and every later identity check would then agree with itself, logging that
    // process's terminals as ours, advisory and all.
    processStartTimes.set(SELF, 1_000);
    processStartTimes.set(CLI_PID, 500);
    processStartTimes.set(WT_PID, 9_000);        // "grandparent" younger than parent
    _resetTopologyCachesForTest();

    runWithCallId(() => resolveOnto(SESSION_WT_HWND));

    const rel = events("topology_relation")[0];
    expect(rel).toMatchObject({
      ownerInAncestry: false,
      ancestryTruncatedAtRecycledPid: true,
    });
    // …and no advisory, because the window is not a verified ancestor's.
    expect(rel.advisoryQueued).toBe(false);

    mockLogDiagnostic.mockClear();
    logTopologySnapshot();
    const snap = events("topology_snapshot")[0];
    expect(snap.ancestryTruncatedAtRecycledPid).toBe(true);
    expect((snap.ancestry as unknown[]).length).toBe(2);   // self + parent only
  });

  it("stops the walk at an unreadable link, rather than verifying the links above it", () => {
    // Without a readable creation time on the child, the parent-vs-child
    // comparison has nothing to compare against — so a replacement process and
    // ITS readable ancestors would be cached as verified ancestors of ours.
    processStartTimes.set(CLI_PID, 0);
    _resetTopologyCachesForTest();

    runWithCallId(() => resolveOnto(SESSION_WT_HWND));

    const rel = events("topology_relation")[0];
    // WT is above the unreadable link, so it is no longer in the chain at all.
    expect(rel).toMatchObject({
      ownerInAncestry: false,
      ancestryTruncatedAtUnreadableLink: true,
    });
    expect(rel).not.toHaveProperty("ancestryPidHit");
    expect(rel.advisoryQueued).toBe(false);

    mockLogDiagnostic.mockClear();
    logTopologySnapshot();
    expect((events("topology_snapshot")[0].ancestry as unknown[]).length).toBe(2);
  });

  it("leaves the truncation marker off for an ordinary chain", () => {
    _resetTopologyCachesForTest();
    resolveOnto(OTHER_TERM_HWND);
    expect(events("topology_relation")[0]).not.toHaveProperty(
      "ancestryTruncatedAtRecycledPid",
    );
  });

  it("backs off after concluding an unreadable link is gone, instead of re-checking per record", () => {
    // Concluding "nothing to come back for" must also stop the clock, or the
    // check that reached that conclusion — which costs a process snapshot every
    // cache interval — runs again on every single record forever. The launching
    // shell exiting and orphaning the server is the ordinary case.
    processStartTimes.set(WT_PID, 0);
    parentMap.delete(WT_PID);
    _resetTopologyCachesForTest();
    resolveOnto(SESSION_WT_HWND);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 6_000);   // past the snapshot cache, not the retry window
    mockBuildProcessParentMap.mockClear();
    for (let i = 0; i < 5; i++) resolveOnto(SESSION_WT_HWND);
    expect(mockBuildProcessParentMap).not.toHaveBeenCalled();
  });

  it("says why a console host's parent is not an ancestor, when the answer is not a plain no", () => {
    // The owner side carries `ancestryPidHit` so a read failure is never read as
    // an established negative. The parent side needs the same, and this is the
    // conhost configuration with the least data.
    const CONHOST_PID = FIXTURE_PID_BASE + 8800;
    const CONSOLE_HWND = 0xeee0n;
    parentMap.set(CONHOST_PID, WT_PID);            // parent IS in the chain…
    processNames.set(CONHOST_PID, "conhost.exe");
    processStartTimes.set(CONHOST_PID, 5_000);
    processStartTimes.set(WT_PID, 0);              // …but unverifiable
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    _resetTopologyCachesForTest();

    resolveOnto(CONSOLE_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      consoleHostParentInAncestry: false,
      consoleHostParentPidHit: "unverified",
    });
  });

  it("leaves the parent marker off when the parent simply is not in the chain", () => {
    const CONHOST_PID = FIXTURE_PID_BASE + 8900;
    const OUTSIDER = FIXTURE_PID_BASE + 9500;
    const CONSOLE_HWND = 0xfff0n;
    parentMap.set(CONHOST_PID, OUTSIDER);
    parentMap.set(OUTSIDER, OTHER_WT_PARENT_PID);
    processNames.set(CONHOST_PID, "conhost.exe");
    processStartTimes.set(CONHOST_PID, 9_000);
    processStartTimes.set(OUTSIDER, 5_000);
    windowOwners.set(CONSOLE_HWND, CONHOST_PID);
    _resetTopologyCachesForTest();

    resolveOnto(CONSOLE_HWND);

    const rel = events("topology_relation")[0];
    expect(rel.consoleHostParentInAncestry).toBe(false);
    expect(rel).not.toHaveProperty("consoleHostParentPidHit");
  });

  it("reports an unverifiable parent lifetime as such", () => {
    const CONHOST_PID = FIXTURE_PID_BASE + 8600;
    const PARENT_PID = FIXTURE_PID_BASE + 8599;
    const CONSOLE_HWND = 0xccc0n;
    parentMap.set(CONHOST_PID, PARENT_PID);
    parentMap.set(PARENT_PID, OTHER_WT_PARENT_PID);
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
    // What C-0 widens by, and Phase 2 folds in: the modern console host (plan
    // Round 25 W-1) and ConEmu, which this project documents as accepting the
    // WM_CHAR typing route and which both terminal write resolvers can select.
    for (const host of ["OpenConsole.exe", "ConEmu64.exe", "ConEmu", "ConEmuC64.exe"]) {
      expect(TERMINAL_PROCESS_RE.test(host)).toBe(false);
      expect(isTerminalClassProcessName(host)).toBe(true);
    }
    expect(isTerminalClassProcessName("notepad.exe")).toBe(false);
  });

  it("records a write that lands in ConEmu", () => {
    const CONEMU_PID = FIXTURE_PID_BASE + 9300;
    const CONEMU_HWND = 0x12340n;
    processNames.set(CONEMU_PID, "ConEmu64.exe");
    windowOwners.set(CONEMU_HWND, CONEMU_PID);
    parentMap.set(CONEMU_PID, OTHER_WT_PARENT_PID);
    _resetTopologyCachesForTest();

    resolveOnto(CONEMU_HWND);

    expect(events("topology_relation")[0]).toMatchObject({
      ownerProcessName: "ConEmu64.exe",
      ownerIsConsoleHost: false,
    });
  });

  it("counts only the two console hosts as console hosts", () => {
    expect(isConsoleHostProcessName("conhost.exe")).toBe(true);
    expect(isConsoleHostProcessName("OpenConsole")).toBe(true);
    expect(isConsoleHostProcessName("pwsh.exe")).toBe(false);
    expect(isConsoleHostProcessName("WindowsTerminal.exe")).toBe(false);
  });
});
