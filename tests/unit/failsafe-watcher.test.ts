/**
 * tests/unit/failsafe-watcher.test.ts
 *
 * ADR-030 Phase 1 (AC6 / plan §4.3) — the failsafe watcher tick, all
 * dependencies mock-injected. The exit gate is the ACTIVE tool-call count
 * (handlers past the failsafe pre-check): idle (0) never exits; active (>0)
 * notifies, writes TWO log lines (the new coordinate-carrying
 * `kind:"failsafe"` + the existing `kind:"exit"` with its unchanged
 * transport-semantics fields), then exits — the runaway brake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `failsafe-watcher.ts` imports FailsafeError from failsafe.ts, which loads
// the nut-js mouse at module scope — mock the native module away.
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { getPosition: vi.fn() },
}));
vi.mock("../../src/utils/balloon.js", () => ({
  showBalloonTip: vi.fn(async () => {}),
}));
vi.mock("../../src/engine/diagnostic-log.js", () => ({
  logDiagnostic: vi.fn(),
}));

import { createFailsafeWatcherTick, type FailsafeWatcherDeps } from "../../src/utils/failsafe-watcher.js";
import { FailsafeError } from "../../src/utils/failsafe.js";

function failsafeErr(x = 3, y = 4, holdMs = 500): FailsafeError {
  return new FailsafeError(x, y, holdMs);
}

interface Harness {
  tick: () => Promise<void>;
  deps: {
    checkFailsafe: ReturnType<typeof vi.fn>;
    getActiveToolCallCount: ReturnType<typeof vi.fn>;
    getTransportInflight: ReturnType<typeof vi.fn>;
    getShutdownPending: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    logDiagnostic: ReturnType<typeof vi.fn>;
    stopTray: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
  };
  order: string[];
}

function makeHarness(o: Partial<FailsafeWatcherDeps> = {}): Harness {
  const order: string[] = [];
  const deps = {
    checkFailsafe: vi.fn(async () => {}),
    getActiveToolCallCount: vi.fn(() => 0),
    getTransportInflight: vi.fn(() => 0),
    getShutdownPending: vi.fn(() => false),
    notify: vi.fn(async () => {
      order.push("notify");
    }),
    logDiagnostic: vi.fn((e: { kind: string }) => {
      order.push(`log:${e.kind}`);
    }),
    stopTray: vi.fn(() => {
      order.push("stopTray");
    }),
    exit: vi.fn(() => {
      order.push("exit");
    }),
    ...o,
  };
  return { tick: createFailsafeWatcherTick(deps as FailsafeWatcherDeps), deps, order };
}

describe("createFailsafeWatcherTick", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  it("resolving probe → no logs, no exit", async () => {
    const h = makeHarness();
    await h.tick();
    expect(h.deps.logDiagnostic).not.toHaveBeenCalled();
    expect(h.deps.exit).not.toHaveBeenCalled();
  });

  it("armed + idle (active 0) → NO exit; armed_idle logged ONCE per dwell episode", async () => {
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr();
      }),
    });
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.deps.exit).not.toHaveBeenCalled();
    expect(h.deps.stopTray).not.toHaveBeenCalled();
    expect(h.deps.notify).not.toHaveBeenCalled(); // idle path shows no balloon (per-tool refusals do)
    const idleLogs = h.deps.logDiagnostic.mock.calls.filter(
      (c) => c[0].kind === "failsafe" && c[0].event === "armed_idle",
    );
    expect(idleLogs).toHaveLength(1);
    expect(idleLogs[0][0]).toMatchObject({ x: 3, y: 4, holdMs: 500 });
  });

  it("episode dedup resets when the probe resolves: a SECOND episode logs armed_idle again", async () => {
    let armed = true;
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        if (armed) throw failsafeErr();
      }),
    });
    await h.tick(); // episode 1 → log
    armed = false;
    await h.tick(); // cursor left — flag resets
    armed = true;
    await h.tick(); // episode 2 → log again
    const idleLogs = h.deps.logDiagnostic.mock.calls.filter((c) => c[0].event === "armed_idle");
    expect(idleLogs).toHaveLength(2);
  });

  it("armed + active 2 → notify awaited, then TWO log lines with distinct field semantics, then stopTray → exit(1)", async () => {
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr(2, 6, 500);
      }),
      getActiveToolCallCount: vi.fn(() => 2),
      getTransportInflight: vi.fn(() => 7), // transport view (refusals included) — deliberately ≠ active
      getShutdownPending: vi.fn(() => true),
    });
    await h.tick();

    // Order: notify resolves BEFORE the logs, tray stops before exit.
    expect(h.order).toEqual(["notify", "log:failsafe", "log:exit", "stopTray", "exit"]);
    expect(h.deps.exit).toHaveBeenCalledWith(1);

    // New line: coordinates + the ACTIVE gate input under its own name.
    expect(h.deps.logDiagnostic.mock.calls[0][0]).toEqual({
      kind: "failsafe",
      event: "triggered",
      origin: "watcher",
      x: 2,
      y: 6,
      holdMs: 500,
      activeToolCalls: 2,
    });
    // Existing line: unchanged schema — `inflight` stays the TRANSPORT count
    // (7, not 2) and `shutdownPending` is preserved (plan Round 5: the two
    // fields are different names AND different sources by design).
    expect(h.deps.logDiagnostic.mock.calls[1][0]).toEqual({
      kind: "exit",
      trigger: "failsafe",
      exitCode: 1,
      inflight: 7,
      shutdownPending: true,
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("FAILSAFE triggered"));
    expect(h.deps.notify).toHaveBeenCalledWith(
      expect.stringContaining("emergency stop"),
      expect.stringContaining("500ms"),
    );
  });

  it("a rejecting notifier still exits (best-effort notification)", async () => {
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr();
      }),
      getActiveToolCallCount: vi.fn(() => 1),
      notify: vi.fn(async () => {
        throw new Error("notification pipeline down");
      }),
    });
    await h.tick();
    expect(h.deps.exit).toHaveBeenCalledWith(1);
  });

  it("a hanging notifier is bounded by the 1s race — exit still happens", async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr();
      }),
      getActiveToolCallCount: vi.fn(() => 1),
      notify: vi.fn(() => new Promise<void>(() => {})), // never settles
    });
    const p = h.tick();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(h.deps.exit).toHaveBeenCalledWith(1);
  });

  it("last active call finishes DURING the notify await → exit averted (idle session survives)", async () => {
    // The gate is read twice: 1 opens the exit branch, 0 on the recheck after
    // the (up to 1 s) notify await — by then the handler has returned and the
    // session is idle, so killing it would cost the user the whole stdio
    // connection for nothing.
    let calls = 0;
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr(1, 1, 700);
      }),
      getActiveToolCallCount: vi.fn(() => (++calls === 1 ? 1 : 0)),
    });
    await h.tick();

    expect(h.deps.exit).not.toHaveBeenCalled();
    expect(h.deps.stopTray).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    // Two balloons: the exit balloon already went out before the recheck, so a
    // second one corrects it (content pinned in the dedicated test below).
    expect(h.deps.notify).toHaveBeenCalledTimes(2);
    expect(h.order).toEqual(["notify", "log:failsafe", "notify"]);
    expect(h.deps.logDiagnostic.mock.calls.filter((c) => c[0].kind === "exit")).toHaveLength(0);

    const averted = h.deps.logDiagnostic.mock.calls.filter((c) => c[0].event === "exit_averted");
    expect(averted).toHaveLength(1);
    expect(averted[0][0]).toEqual({
      kind: "failsafe",
      event: "exit_averted",
      x: 1,
      y: 1,
      holdMs: 700,
    });

    // Same dwell episode: the next tick (now idle) must not ALSO log
    // armed_idle — averting counts as the episode's one log line.
    await h.tick();
    expect(h.deps.logDiagnostic.mock.calls.filter((c) => c[0].event === "armed_idle")).toHaveLength(0);
    expect(h.deps.logDiagnostic).toHaveBeenCalledTimes(1);
    expect(h.deps.exit).not.toHaveBeenCalled();
  });

  it("still active on the recheck → exits, and activeToolCalls logs the RECHECK value", async () => {
    let calls = 0;
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr(2, 6, 500);
      }),
      getActiveToolCallCount: vi.fn(() => (++calls === 1 ? 2 : 1)), // one of the two finished
      getTransportInflight: vi.fn(() => 7),
      getShutdownPending: vi.fn(() => false),
    });
    await h.tick();

    expect(h.deps.exit).toHaveBeenCalledWith(1);
    expect(h.order).toEqual(["notify", "log:failsafe", "log:exit", "stopTray", "exit"]);
    // The gate that actually authorised the exit is the post-await read (1),
    // not the stale pre-await snapshot (2).
    expect(h.deps.logDiagnostic.mock.calls[0][0]).toMatchObject({
      event: "triggered",
      activeToolCalls: 1,
    });
  });

  it("averted → a CORRECTING balloon follows the exit balloon (Opus Round 1 P2-2)", async () => {
    // The exit balloon has already told the user the server "has exited"; when
    // the recheck stands the exit down, that claim must not be left standing.
    let calls = 0;
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr(1, 1, 500);
      }),
      getActiveToolCallCount: vi.fn(() => (++calls === 1 ? 1 : 0)),
    });
    await h.tick();

    expect(h.deps.exit).not.toHaveBeenCalled();
    expect(h.deps.notify).toHaveBeenCalledTimes(2);
    const [firstTitle, firstBody] = h.deps.notify.mock.calls[0];
    const [secondTitle, secondBody] = h.deps.notify.mock.calls[1];
    expect(firstBody).toContain("has exited"); // the claim being corrected
    expect(secondTitle).toBe(firstTitle); // same balloon identity, so it reads as a correction
    expect(secondBody).toContain("still running");
    expect(secondBody).not.toContain("has exited");
    expect(secondBody).toMatch(/blocked/); // ...but new calls are still refused
    // The correction is fire-and-forget AFTER the log line (the process lives on,
    // so there is no exit to race).
    expect(h.order).toEqual(["notify", "log:failsafe", "notify"]);
  });

  it("re-entrancy: a tick landing DURING the notify await returns immediately (no double balloon / double log)", async () => {
    // The server drives this tick from a 500 ms setInterval that does not await
    // the previous invocation, while the trigger path awaits the notifier for up
    // to 1 s — without the `stopping` guard the overlapping tick fires a second
    // balloon and a second `triggered` line (Opus Round 1 P2-3).
    let releaseNotify!: () => void;
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr();
      }),
      getActiveToolCallCount: vi.fn(() => 1),
      notify: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseNotify = resolve;
            notifyEntered();
          }),
      ),
    });
    const first = h.tick();
    await entered; // the first tick is now parked on the notify await

    await h.tick(); // the overlapping 500 ms tick — must no-op
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
    expect(h.deps.checkFailsafe).toHaveBeenCalledTimes(1); // it returned before even probing
    expect(h.deps.logDiagnostic).not.toHaveBeenCalled();

    releaseNotify();
    await first;
    expect(h.deps.logDiagnostic.mock.calls.filter((c) => c[0].event === "triggered")).toHaveLength(1);
    expect(h.deps.logDiagnostic.mock.calls.filter((c) => c[0].kind === "exit")).toHaveLength(1);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
    expect(h.deps.exit).toHaveBeenCalledTimes(1);
  });

  it("averted RELEASES the re-entrancy guard: a later tick can still exit when a new call is active", async () => {
    // tick 1: 1 → 0 (averted, guard must be cleared); tick 2: a fresh call is
    // running, so the runaway brake has to work again.
    const counts = [1, 0, 2, 2];
    let i = 0;
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw failsafeErr();
      }),
      getActiveToolCallCount: vi.fn(() => counts[i++] ?? 0),
    });
    await h.tick();
    expect(h.deps.exit).not.toHaveBeenCalled();

    await h.tick();
    expect(h.deps.exit).toHaveBeenCalledWith(1);
    expect(h.deps.logDiagnostic.mock.calls.filter((c) => c[0].event === "triggered")).toHaveLength(1);
    // Still the same dwell episode — averting already spent its log line.
    expect(h.deps.logDiagnostic.mock.calls.filter((c) => c[0].event === "armed_idle")).toHaveLength(0);
  });

  it("a non-FailsafeError throw is ignored (matches the previous inline watcher)", async () => {
    const h = makeHarness({
      checkFailsafe: vi.fn(async () => {
        throw new Error("some transient failure");
      }),
      getActiveToolCallCount: vi.fn(() => 5),
    });
    await h.tick();
    expect(h.deps.exit).not.toHaveBeenCalled();
    expect(h.deps.logDiagnostic).not.toHaveBeenCalled();
  });
});
