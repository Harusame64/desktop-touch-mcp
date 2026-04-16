/**
 * test-capture.mjs — Run vitest and capture output to .vitest-out.txt
 *
 * Structural guards against duplicate runs:
 *   A. Lock file (.vitest-running): prevents concurrent executions.
 *   B. Fresh-output check: if .vitest-out.txt was written within the last
 *      120 seconds, refuse to re-run and tell the caller to read it first.
 *
 * Both guards can be bypassed with --force.
 *
 * Usage:
 *   node scripts/test-capture.mjs [--force] [extra vitest args...]
 *
 * Outputs:
 *   .vitest-out.json  — JSON reporter (machine-readable, use Grep)
 *   .vitest-out.txt   — default reporter (human-readable, use Read)
 *
 * Exit codes:
 *   0  — tests passed AND output files are non-empty
 *   1  — guard blocked / tests failed / output files empty or missing
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";

const root    = resolve(import.meta.dirname, "..");
const txtPath  = resolve(root, ".vitest-out.txt");
const jsonPath = resolve(root, ".vitest-out.json");
const lockPath = resolve(root, ".vitest-running");

const FRESH_WINDOW_MS = 120_000; // 2 minutes

// ── Parse args ────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const forceIdx  = args.indexOf("--force");
const force     = forceIdx !== -1;
if (force) args.splice(forceIdx, 1);   // remove --force before passing to vitest

// ── Guard A: lock file ────────────────────────────────────────────────────────

if (!force && existsSync(lockPath)) {
  const lockAge = Date.now() - statSync(lockPath).mtimeMs;
  // Stale lock (> 10 min) is silently removed to handle crash recovery
  if (lockAge < 600_000) {
    console.error("\n========================================");
    console.error("  test:capture BLOCKED — already running");
    console.error("========================================");
    console.error(`Lock file: ${lockPath}`);
    console.error("Another test run is in progress. Wait for it to complete.");
    console.error("Use --force to bypass this check if the lock is stale.");
    process.exit(1);
  }
  unlinkSync(lockPath);
}

// ── Guard B: fresh output ─────────────────────────────────────────────────────

if (!force && existsSync(txtPath)) {
  const ageMs = Date.now() - statSync(txtPath).mtimeMs;
  if (ageMs < FRESH_WINDOW_MS) {
    const ageSec = Math.round(ageMs / 1000);
    console.error("\n========================================");
    console.error("  test:capture BLOCKED — fresh output exists");
    console.error("========================================");
    console.error(`Output written ${ageSec}s ago: ${txtPath}`);
    console.error("Read the existing output before running tests again:");
    console.error("  Read tool  →  .vitest-out.txt");
    console.error("  Grep tool  →  .vitest-out.json  (search for failures)");
    console.error("Use --force to re-run anyway.");
    process.exit(1);
  }
}

// ── Acquire lock ──────────────────────────────────────────────────────────────

writeFileSync(lockPath, String(process.pid), "utf-8");

function releaseLock() {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}
process.on("exit",    releaseLock);
process.on("SIGINT",  () => { releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); process.exit(143); });

// ── Spawn vitest ──────────────────────────────────────────────────────────────

const vitestArgs = [
  "run",
  "--reporter=json",
  `--outputFile=${jsonPath}`,
  "--reporter=default",
  ...args,
];

const isWin    = process.platform === "win32";
const vitestBin = resolve(root, "node_modules", ".bin", isWin ? "vitest.cmd" : "vitest");
const cmdStr   = [JSON.stringify(vitestBin), ...vitestArgs.map((a) => JSON.stringify(a))].join(" ");

const txtStream = createWriteStream(txtPath, { encoding: "utf-8" });

const child = spawn(cmdStr, [], {
  cwd:   root,
  stdio: ["ignore", "pipe", "pipe"],
  env:   { ...process.env, FORCE_COLOR: "0" },
  shell: true,
});

child.stdout.pipe(txtStream, { end: false });
child.stderr.pipe(txtStream, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("close", (code) => {
  txtStream.end(() => {
    releaseLock();

    // ── Validate output files ──────────────────────────────────────────────
    const errors = [];
    for (const [label, p] of [[".vitest-out.txt", txtPath], [".vitest-out.json", jsonPath]]) {
      if (!existsSync(p))              errors.push(`ERROR: ${label} was not created.`);
      else if (statSync(p).size === 0) errors.push(`ERROR: ${label} is empty (0 bytes).`);
    }

    if (errors.length > 0) {
      console.error("\n========================================");
      console.error("  test:capture output validation FAILED");
      console.error("========================================");
      errors.forEach((e) => console.error(e));
      console.error("Hint: vitest may have crashed before producing output.");
      process.exit(1);
    }

    process.exit(code ?? 1);
  });
});

child.on("error", (err) => {
  releaseLock();
  console.error(`ERROR: Failed to start vitest: ${err.message}`);
  process.exit(1);
});
