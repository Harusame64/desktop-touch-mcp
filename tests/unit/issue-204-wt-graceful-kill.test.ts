/**
 * issue-204-wt-graceful-kill.test.ts
 *
 * Pure-helper unit tests for the kill() polling loop in
 * tests/e2e/helpers/powershell-launcher.ts.
 *
 * Background (issue #204): `taskkill /F /PID <pid>` ends PowerShell with
 * exit code 1 (TerminateProcess). Windows Terminal's default
 * `closeOnExit: graceful` keeps the tab open on non-zero exits, and the
 * launcher's per-launch `-w dtm_e2e_<tag>` unique window means each
 * residue is a leaked top-level WT window — not just a tab. The fix
 * sends a graceful taskkill first, polls process liveness, and falls
 * through to /F only when the budget elapses.
 *
 * `evaluateGracefulKillState` is the pure decision helper that drives
 * the polling loop. Testing it directly avoids the in-module-call /
 * real-process fixture problem that blocked similar coverage on
 * PR #203 (issue #196).
 */

import { describe, it, expect } from "vitest";
import { evaluateGracefulKillState } from "../e2e/helpers/powershell-launcher.js";

describe("issue #204: evaluateGracefulKillState — graceful-kill polling state machine", () => {
  it("returns 'exited' immediately when the process is gone (ESRCH)", () => {
    // First poll iteration: graceful taskkill landed, ESRCH already.
    // No further /F escalation needed.
    const state = evaluateGracefulKillState({
      isAlive: false,
      now: 1_000,
      deadline: 2_500,
    });
    expect(state).toBe("exited");
  });

  it("returns 'wait' while the process is alive and the budget has time left", () => {
    const state = evaluateGracefulKillState({
      isAlive: true,
      now: 1_500,
      deadline: 2_500,
    });
    // Inside the 1500ms budget: poll again before forcing.
    expect(state).toBe("wait");
  });

  it("returns 'force' when the budget has elapsed and the process is still alive", () => {
    const state = evaluateGracefulKillState({
      isAlive: true,
      now: 2_500,
      deadline: 2_500,
    });
    // Boundary is `>=` — exact deadline triggers escalation, matching
    // the loop's "check before sleep" ordering. (If `>` were used, a
    // hung PS at the exact deadline would consume one extra sleep
    // cycle before escalating.)
    expect(state).toBe("force");
  });

  it("returns 'force' when the budget overshoots, irrespective of how far past", () => {
    const state = evaluateGracefulKillState({
      isAlive: true,
      now: 5_000,
      deadline: 2_500,
    });
    expect(state).toBe("force");
  });

  it("returns 'exited' even past the deadline if the process did exit (race-safe)", () => {
    // Edge case: graceful exit landed *just* as the deadline elapsed.
    // The "exited" check must take priority over the deadline check —
    // otherwise we would emit a /F that hits a stale PID and (worse)
    // could collide with whatever Windows reassigned that PID to.
    const state = evaluateGracefulKillState({
      isAlive: false,
      now: 5_000,
      deadline: 2_500,
    });
    expect(state).toBe("exited");
  });

  it("returns 'wait' on the first poll when isAlive=true and now < deadline", () => {
    // Sanity: a fresh poll loop with a healthy budget waits.
    const state = evaluateGracefulKillState({
      isAlive: true,
      now: 0,
      deadline: 1_500,
    });
    expect(state).toBe("wait");
  });
});
