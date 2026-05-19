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

import { mouse } from "../../src/engine/nutjs.js";
import {
  checkFailsafe,
  FailsafeError,
  _resetFailsafeForTest,
} from "../../src/utils/failsafe.js";

const getPositionMock = mouse.getPosition as unknown as ReturnType<typeof vi.fn>;

function setCursor(x: number, y: number): void {
  getPositionMock.mockResolvedValue({ x, y });
}

describe("checkFailsafe — dwell-based trigger", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    getPositionMock.mockReset();
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
});
