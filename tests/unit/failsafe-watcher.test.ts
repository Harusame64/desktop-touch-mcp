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
