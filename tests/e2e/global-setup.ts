/**
 * global-setup.ts — vitest `globalSetup` for the e2e project (runs ONCE in the
 * main process, before any worker, and once on teardown).
 *
 * Clears a STALE `.e2e-stop` emergency-stop sentinel at the start of a run (so a
 * leftover file from a crashed/aborted run never silently skips a fresh one), and
 * clears the sentinel on teardown. The startup clear is staleness-gated on the
 * process launch time: a stop fired during THIS run's boot window (before any
 * worker's beforeEach runs) is preserved so the run still halts (Codex PR #408 P1).
 *
 * The stop itself is requested with `npm run e2e:stop` from any terminal — that
 * drops the sentinel, and abort-check.ts then skips every remaining test at the
 * next boundary. A terminal command (not a clickable window) is deliberate: it
 * works even while a test is driving the cursor via SendInput (when a STOP button
 * would be unclickable), and it adds no on-screen window that could perturb
 * screenshot / window-enumeration / focus tests.
 */
import { clearStaleStop, clearStop } from "./helpers/stop-sentinel.js";

export default function setup(): () => void {
  // process launch time = now - uptime. A sentinel older than this is from a prior
  // run (stale → clear); a newer one was issued during our boot (keep → honour it).
  clearStaleStop(Date.now() - Math.floor(process.uptime() * 1000));
  return () => clearStop();
}
