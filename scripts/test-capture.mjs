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
  appendFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
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
process.on("SIGINT",  () => { releaseLock(); killVitestZombies(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); killVitestZombies(); process.exit(143); });

// ── Zombie cleanup (vitest worker pool が teardown 失敗で残留する node プロセスを kill) ──
//
// 対象は command line に "vitest" を含む node プロセスのみ。MCP server / Claude Code /
// AWS Toolkit / Gemini CLI 等の正規 node プロセスには触らない。
//
// pre-run: 過去の test 実行で残った zombie を kill
// post-run: 自分の child の descendant が消えていなければ kill (defence-in-depth)
import { execSync } from "node:child_process";

function killVitestZombies() {
  if (process.platform !== "win32") return; // Unix では vitest 自身が teardown 確実
  try {
    // PowerShell で vitest を含む node プロセスを列挙、自分以外を kill
    const myPid = process.pid;
    const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object {
        $_.ProcessId -ne ${myPid} -and
        ($_.CommandLine -match 'vitest' -or $_.CommandLine -match 'test-capture')
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\n\s*/g, ' ')}"`, {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch { /* cleanup is best-effort */ }
}

// pre-run cleanup
killVitestZombies();

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
    // post-run: vitest worker pool が teardown で残した zombie を kill (defence-in-depth)
    killVitestZombies();

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

    // ── Fail suggestions ───────────────────────────────────────────────────
    try {
      const jsonOut = JSON.parse(readFileSync(jsonPath, "utf-8"));
      const failed = (jsonOut.testResults ?? []).filter((r) => r.status === "failed");
      if (failed.length > 0) {
        const cwdFwd = root.replace(/\\/g, "/");
        const lines = [
          "",
          "── 失敗テストの個別実行コマンド ──────────────────────────────────",
          ...failed.map((f) => {
            const abs = (f.name ?? "").replace(/\\/g, "/");
            const rel = abs.startsWith(cwdFwd + "/") ? abs.slice(cwdFwd.length + 1) : abs;
            const project = rel.startsWith("tests/e2e/") ? "--project=e2e "
                          : rel.startsWith("tests/unit/") ? "--project=unit "
                          : "";
            return `  npx vitest run ${project}"${rel}"`;
          }),
          "  ※ test:capture で実行: npm run test:capture -- <上記パス>",
          "──────────────────────────────────────────────────────────────────",
          "",
        ].join("\n");
        process.stdout.write(lines);
        appendFileSync(txtPath, lines, "utf-8");
      }
    } catch { /* JSON parse failure is non-fatal */ }

    process.exit(code ?? 1);
  });
});

child.on("error", (err) => {
  releaseLock();
  console.error(`ERROR: Failed to start vitest: ${err.message}`);
  process.exit(1);
});
