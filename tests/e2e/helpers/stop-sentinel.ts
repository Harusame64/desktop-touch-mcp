/**
 * stop-sentinel.ts — emergency-stop sentinel for the e2e suite.
 *
 * The e2e suite drives real OS input (mouse / keyboard) on the live desktop. If a
 * run misbehaves (cursor hijacked, foreground churn) you need a reliable way to
 * halt it WITHOUT racing the test for the cursor. The mechanism is a plain file
 * on disk: any process can drop it, and the per-test `beforeEach` (abort-check.ts)
 * checks for it and skips every remaining test at the next boundary — so the run
 * stops promptly while afterAll/afterEach hooks still clean up (Chrome, windows).
 *
 * Drop the sentinel with `npm run e2e:stop` from any terminal — reliable even
 * while a test owns the cursor (it does not touch the desktop), and it adds no
 * on-screen window that could perturb screenshot / window-enumeration tests.
 *
 * A file (not an env var / in-process flag) is deliberate: env vars cannot change
 * after the worker starts, and the test worker is a separate process from the
 * terminal you'd type the stop into. The filesystem is the one channel both share.
 */
import { existsSync, writeFileSync, rmSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root: tests/e2e/helpers → ../../../
export const STOP_SENTINEL_PATH = join(__dirname, "..", "..", "..", ".e2e-stop");

// The `path` arg defaults to STOP_SENTINEL_PATH for all callers; it exists so the
// unit test can exercise the round-trip against a temp file WITHOUT touching the
// real repo-root sentinel (which would abort a concurrent e2e run).

/** True when an emergency stop has been requested (sentinel file present). */
export function isStopRequested(path: string = STOP_SENTINEL_PATH): boolean {
  return existsSync(path);
}

/** Request an emergency stop by dropping the sentinel — the importable equivalent of `npm run e2e:stop` (which writes the same file directly). Exercised by the unit test. */
export function requestStop(path: string = STOP_SENTINEL_PATH): void {
  writeFileSync(path, `stop ${new Date().toISOString()}\n`, "utf8");
}

/** Remove the sentinel (teardown cleanup). Never throws. */
export function clearStop(path: string = STOP_SENTINEL_PATH): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore — best effort */
  }
}

/**
 * Clear the sentinel at run start ONLY if it is STALE — left over from a previous,
 * crashed run (its mtime predates `launchedAtMs`, this run's process launch). A
 * sentinel written at/after launch — a `npm run e2e:stop` fired during this run's
 * boot window, before any worker's beforeEach runs — is PRESERVED so the run still
 * halts (Codex PR #408 P1: an unconditional startup clear would erase a stop
 * issued in the exact "abort immediately after launch" case). Never throws.
 */
export function clearStaleStop(launchedAtMs: number, path: string = STOP_SENTINEL_PATH): void {
  try {
    if (statSync(path).mtimeMs < launchedAtMs) {
      rmSync(path, { force: true });
    }
  } catch {
    /* absent / stat failed → nothing to clear */
  }
}
