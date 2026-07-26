/**
 * tests/unit/failsafe-hold.test.ts
 *
 * Issue #365 follow-up — dwell-based failsafe trigger. The original
 * `pos.x <= 10 && pos.y <= 10 → throw` design fired on any drive-by cursor
 * movement through the top-left corner (E2E tests at (1,1), window drags
 * ending at (0,0), accidental flicks) and routinely killed live MCP servers
 * during dogfood. The new design requires the cursor to dwell in the zone
 * for `DESKTOP_TOUCH_FAILSAFE_HOLD_MS` (default 500 ms) continuously.
 *
 * `mouse.getPosition` is mocked because we want to control the cursor state
 * at sub-ms granularity to verify the dwell timer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    getPosition: vi.fn(),
  },
}));

// ADR-030 Phase 1 (plan §4.2): `checkFailsafe` now emits diagnostics + balloon
// notifications on the throw path. Mock both — without these, every throw
// case below would spawn a real PowerShell NotifyIcon (visible balloon) and
// append to the real diagnostic.log.
vi.mock("../../src/utils/balloon.js", () => ({
  showBalloonTip: vi.fn(async () => {}),
}));
vi.mock("../../src/engine/diagnostic-log.js", () => ({
  logDiagnostic: vi.fn(),
}));

import { mouse } from "../../src/engine/nutjs.js";
import { showBalloonTip } from "../../src/utils/balloon.js";
import { logDiagnostic } from "../../src/engine/diagnostic-log.js";
import {
  checkFailsafe,
  FailsafeError,
  _resetFailsafeForTest,
} from "../../src/utils/failsafe.js";

const getPositionMock = mouse.getPosition as unknown as ReturnType<typeof vi.fn>;
const balloonMock = showBalloonTip as unknown as ReturnType<typeof vi.fn>;
const logMock = logDiagnostic as unknown as ReturnType<typeof vi.fn>;

function setCursor(x: number, y: number): void {
  getPositionMock.mockResolvedValue({ x, y });
}

describe("checkFailsafe — dwell-based trigger", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    getPositionMock.mockReset();
    balloonMock.mockClear();
    balloonMock.mockResolvedValue(undefined);
    logMock.mockClear();
    _resetFailsafeForTest();
    delete process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS;
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
    _resetFailsafeForTest();
  });

  it("does not throw on a single check inside the zone (no dwell yet)", async () => {
    setCursor(5, 5);
    await expect(checkFailsafe()).resolves.toBeUndefined();
  });

  it("does not throw when cursor is far from the corner", async () => {
    setCursor(500, 500);
    await expect(checkFailsafe()).resolves.toBeUndefined();
  });

  it("throws after dwell threshold elapses with cursor still in zone", async () => {
    setCursor(2, 2);
    // First check arms the timer.
    await checkFailsafe();
    // Advance just under the default 500 ms threshold.
    vi.setSystemTime(new Date(Date.now() + 499));
    await expect(checkFailsafe()).resolves.toBeUndefined();
    // Cross the threshold.
    vi.setSystemTime(new Date(Date.now() + 2));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("resets the dwell timer when cursor leaves the zone", async () => {
    setCursor(1, 1);
    await checkFailsafe(); // arm
    vi.setSystemTime(new Date(Date.now() + 300));
    setCursor(500, 500);
    await checkFailsafe(); // reset
    vi.setSystemTime(new Date(Date.now() + 300));
    setCursor(1, 1);
    await checkFailsafe(); // re-arm (NOT throw — total wall time 600ms but dwell was reset)
    // Even though wallclock has crossed 500ms total, the continuous-dwell
    // requirement is not yet met because we left the zone in the middle.
    vi.setSystemTime(new Date(Date.now() + 200));
    await expect(checkFailsafe()).resolves.toBeUndefined();
  });

  it("DESKTOP_TOUCH_FAILSAFE_HOLD_MS=0 restores immediate-trigger behaviour", async () => {
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "0";
    setCursor(0, 0);
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("custom hold threshold via env var", async () => {
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "2000";
    setCursor(3, 3);
    await checkFailsafe(); // arm
    vi.setSystemTime(new Date(Date.now() + 1000));
    await expect(checkFailsafe()).resolves.toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 1001));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("invalid env value falls back to default 500 ms", async () => {
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "not-a-number";
    setCursor(5, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("negative env value falls back to default 500 ms", async () => {
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "-100";
    setCursor(5, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("(1, 1) — the historic E2E click coordinate — does not trigger on a single check", async () => {
    // Regression test for the issue #365 root cause. The old immediate-trigger
    // semantics would throw here; the new dwell-based design must not.
    setCursor(1, 1);
    await expect(checkFailsafe()).resolves.toBeUndefined();
  });

  it("blank env value falls back to default 500 ms (Codex R1 P2-1)", async () => {
    // `DESKTOP_TOUCH_FAILSAFE_HOLD_MS=` (empty) used to coerce to 0 via
    // Number(""), silently restoring the immediate-trigger behaviour.
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "";
    setCursor(5, 5);
    await expect(checkFailsafe()).resolves.toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("whitespace-only env value falls back to default 500 ms (Codex R1 P2-1)", async () => {
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "   ";
    setCursor(5, 5);
    await expect(checkFailsafe()).resolves.toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("env value with surrounding whitespace is trimmed (e.g., ' 100 ' → 100)", async () => {
    process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS = "  100  ";
    setCursor(5, 5);
    await checkFailsafe(); // arm
    vi.setSystemTime(new Date(Date.now() + 80));
    await expect(checkFailsafe()).resolves.toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 30));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("dwell timer restarts when consecutive in-zone samples are >1500 ms apart (Codex R1 P2-2)", async () => {
    // Sampling caveat: if two in-zone samples are separated by a long
    // unsampled gap, the cursor may have left and returned within that
    // window. We restart the dwell to avoid a drive-by trigger.
    setCursor(5, 5);
    await checkFailsafe(); // arm at t=0
    vi.setSystemTime(new Date(Date.now() + 2000)); // large gap (cursor may have left)
    await checkFailsafe(); // dwell restarts (now t=2000 as the new entered_at)
    // Even though wallclock elapsed = 2000 ms total, we restarted the
    // dwell at t=2000, so we need another 500 ms to trigger.
    vi.setSystemTime(new Date(Date.now() + 100));
    await expect(checkFailsafe()).resolves.toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 500));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("normal-cadence in-zone samples (well under 1500 ms gap) accumulate dwell", async () => {
    // Watcher-tick scenario: 500 ms gap < 1500 ms threshold, dwell continues.
    setCursor(5, 5);
    await checkFailsafe(); // t=0
    vi.setSystemTime(new Date(Date.now() + 500));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  it("transient mouse.getPosition error does not throw or reset state", async () => {
    setCursor(1, 1);
    await checkFailsafe(); // arm
    getPositionMock.mockRejectedValueOnce(new Error("transient"));
    await expect(checkFailsafe()).resolves.toBeUndefined();
    // After transient error, dwell counter should NOT have been cleared —
    // we resume from where we were when the next real reading comes in.
    setCursor(1, 1);
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
  });

  // ── ADR-030 Phase 1 — primary-monitor zone limit (AC1 dwell integration) ──
  //
  // Each negative-coordinate case runs TWO calls with the dwell window
  // elapsed in between: a single call would resolve under the PRE-fix code
  // too (the first in-zone sample only arms), so it would be a vacuous
  // regression test (plan §4.2 / Round 2 P2-4).

  it.each([
    [-1000, 5, "monitor left of the primary"],
    [5, -500, "monitor above the primary"],
    [-1000, -500, "monitor upper-left of the primary"],
  ])("negative coordinates (%i, %i) — %s — never fire even after a full dwell", async (x, y) => {
    setCursor(x, y);
    await checkFailsafe(); // pre-fix code would ARM here
    vi.setSystemTime(new Date(Date.now() + 600));
    // Pre-fix code would THROW here (dwell elapsed in the boundless zone).
    await expect(checkFailsafe()).resolves.toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).resolves.toBeUndefined();
  });

  it("moving from the real zone into the negative band resets the dwell timer", async () => {
    setCursor(5, 5);
    await checkFailsafe(); // arm
    vi.setSystemTime(new Date(Date.now() + 300));
    setCursor(-1000, 5); // ghost band = OUT of the fixed zone → reset
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 300));
    setCursor(5, 5);
    await checkFailsafe(); // re-arm — total wall time 600ms but dwell restarted
    vi.setSystemTime(new Date(Date.now() + 300));
    await expect(checkFailsafe()).resolves.toBeUndefined(); // only 300ms since re-entry
    vi.setSystemTime(new Date(Date.now() + 200));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError); // 500ms since re-entry
  });

  it("FailsafeError carries the trigger coordinates and the effective holdMs", async () => {
    setCursor(3, 7);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    let caught: unknown;
    await checkFailsafe().catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(FailsafeError);
    const err = caught as FailsafeError;
    expect(err.x).toBe(3);
    expect(err.y).toBe(7);
    expect(err.holdMs).toBe(500);
    expect(err.message).toContain("primary monitor");
  });
});

describe("checkFailsafe — origin split (ADR-030 plan §3.2)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    getPositionMock.mockReset();
    balloonMock.mockClear();
    balloonMock.mockResolvedValue(undefined);
    logMock.mockClear();
    _resetFailsafeForTest();
    delete process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS;
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
    _resetFailsafeForTest();
  });

  const triggeredLogs = () =>
    logMock.mock.calls.filter((c) => c[0]?.kind === "failsafe" && c[0]?.event === "triggered");

  async function armAndTrigger(origin?: "per-tool" | "watcher" | "background"): Promise<void> {
    setCursor(5, 5);
    await checkFailsafe(origin);
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe(origin)).rejects.toBeInstanceOf(FailsafeError);
  }

  it("per-tool: one diagnostic log line PER refusal, one balloon PER dwell episode", async () => {
    await armAndTrigger(); // default origin = per-tool
    expect(triggeredLogs()).toHaveLength(1);
    expect(triggeredLogs()[0][0]).toMatchObject({ origin: "per-tool", x: 5, y: 5, holdMs: 500 });
    expect(balloonMock).toHaveBeenCalledTimes(1);

    // An LLM retry burst against the SAME episode: logs again, balloon does not.
    vi.setSystemTime(new Date(Date.now() + 100));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
    expect(triggeredLogs()).toHaveLength(2);
    expect(balloonMock).toHaveBeenCalledTimes(1);

    // A NEW episode (leave → re-enter → dwell) notifies once more.
    setCursor(500, 500);
    await checkFailsafe(); // reset
    await armAndTrigger();
    expect(balloonMock).toHaveBeenCalledTimes(2);
  });

  it("background: diagnostic log per refusal, NO balloon", async () => {
    await armAndTrigger("background");
    expect(triggeredLogs()).toHaveLength(1);
    expect(triggeredLogs()[0][0]).toMatchObject({ origin: "background" });
    expect(balloonMock).not.toHaveBeenCalled();
  });

  it("watcher: neither log nor balloon from inside checkFailsafe (the watcher tick owns both)", async () => {
    await armAndTrigger("watcher");
    expect(triggeredLogs()).toHaveLength(0);
    expect(balloonMock).not.toHaveBeenCalled();
  });

  it("a rejected balloon promise does not break the per-tool throw path", async () => {
    balloonMock.mockRejectedValue(new Error("notification pipeline down"));
    await armAndTrigger();
    // Still the typed FailsafeError, not the balloon error — best-effort only.
  });
});

describe("checkFailsafe — ghost-zone miss notice (ADR-030 Proposal B)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    getPositionMock.mockReset();
    balloonMock.mockClear();
    balloonMock.mockResolvedValue(undefined);
    logMock.mockClear();
    _resetFailsafeForTest();
    delete process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS;
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
    _resetFailsafeForTest();
  });

  const ghostLogs = () =>
    logMock.mock.calls.filter((c) => c[0]?.kind === "failsafe" && c[0]?.event === "ghost_zone_notice");

  it("a 500ms ghost-zone dwell shows one balloon + one coordinate-carrying log, and never throws", async () => {
    setCursor(-1000, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).resolves.toBeUndefined();
    expect(ghostLogs()).toHaveLength(1);
    expect(ghostLogs()[0][0]).toMatchObject({ x: -1000, y: 5, holdMs: 500 });
    expect(balloonMock).toHaveBeenCalledTimes(1);
    expect(String(balloonMock.mock.calls[0][0])).toContain("PRIMARY monitor");
  });

  it("a second ghost episode in the same process shows NO further notice (once per process)", async () => {
    setCursor(-1000, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await checkFailsafe(); // notice #1
    setCursor(500, 500);
    await checkFailsafe(); // leave
    setCursor(-1000, 5);
    await checkFailsafe(); // re-enter
    vi.setSystemTime(new Date(Date.now() + 600));
    await checkFailsafe(); // full second dwell — silent
    expect(ghostLogs()).toHaveLength(1);
    expect(balloonMock).toHaveBeenCalledTimes(1);
  });

  it("a real-zone dwell produces no ghost notice", async () => {
    setCursor(5, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).rejects.toBeInstanceOf(FailsafeError);
    expect(ghostLogs()).toHaveLength(0);
  });

  it("ghost samples flow in from the background origin too (the notice is origin-independent)", async () => {
    setCursor(-1000, 5);
    await checkFailsafe("background");
    vi.setSystemTime(new Date(Date.now() + 600));
    await checkFailsafe("background");
    expect(ghostLogs()).toHaveLength(1);
    expect(balloonMock).toHaveBeenCalledTimes(1); // ghost balloon is NOT suppressed for background
  });

  it("_resetFailsafeForTest clears the once-per-process flag (test isolation)", async () => {
    setCursor(-1000, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await checkFailsafe();
    expect(ghostLogs()).toHaveLength(1);
    _resetFailsafeForTest();
    setCursor(-1000, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await checkFailsafe();
    expect(ghostLogs()).toHaveLength(2);
  });

  it("a rejected ghost balloon promise never surfaces (fire-and-forget)", async () => {
    balloonMock.mockRejectedValue(new Error("down"));
    setCursor(-1000, 5);
    await checkFailsafe();
    vi.setSystemTime(new Date(Date.now() + 600));
    await expect(checkFailsafe()).resolves.toBeUndefined();
  });
});
