/**
 * test-capture.mjs — Run vitest and capture output to .vitest-out.txt
 *
 * Unlike shell redirection (`> .vitest-out.txt`), this script uses
 * Node's fs.createWriteStream so the output file is written reliably
 * even when the npm script is launched via `run_in_background`.
 *
 * Usage:  node scripts/test-capture.mjs [extra vitest args...]
 *
 * Outputs:
 *   .vitest-out.json  — JSON reporter (machine-readable)
 *   .vitest-out.txt   — default reporter (human-readable)
 *
 * Exit codes:
 *   0  — tests passed AND output files are non-empty
 *   1  — tests failed OR output files are empty/missing
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const txtPath = resolve(root, ".vitest-out.txt");
const jsonPath = resolve(root, ".vitest-out.json");

// Extra args passed after `node scripts/test-capture.mjs`
const extraArgs = process.argv.slice(2);

const vitestArgs = [
  "run",
  "--reporter=json",
  `--outputFile=${jsonPath}`,
  "--reporter=default",
  ...extraArgs,
];

// Resolve vitest binary from node_modules.
// On Windows the .cmd shim must be used; spawn with shell:true
// but pass the full command as a single string to avoid DEP0190.
const isWin = process.platform === "win32";
const vitestBin = resolve(
  root,
  "node_modules",
  ".bin",
  isWin ? "vitest.cmd" : "vitest",
);

const txtStream = createWriteStream(txtPath, { encoding: "utf-8" });

// Build a single command string for shell mode (avoids DEP0190 warning)
const cmdStr = [JSON.stringify(vitestBin), ...vitestArgs.map((a) => JSON.stringify(a))].join(" ");

const child = spawn(cmdStr, [], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "0" },
  shell: true,
});

child.stdout.pipe(txtStream, { end: false });
child.stderr.pipe(txtStream, { end: false });

// Also mirror to this process's stdout/stderr so the caller can see progress
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("close", (code) => {
  txtStream.end(() => {
    // Validate output files exist and are non-empty
    const errors = [];
    for (const [label, p] of [
      [".vitest-out.txt", txtPath],
      [".vitest-out.json", jsonPath],
    ]) {
      if (!existsSync(p)) {
        errors.push(`ERROR: ${label} was not created.`);
      } else if (statSync(p).size === 0) {
        errors.push(`ERROR: ${label} is empty (0 bytes).`);
      }
    }

    if (errors.length > 0) {
      console.error("\n========================================");
      console.error("  test:capture output validation FAILED");
      console.error("========================================");
      errors.forEach((e) => console.error(e));
      console.error(
        "Hint: vitest may have crashed before producing output.",
      );
      process.exit(1);
    }

    // Propagate vitest's exit code
    process.exit(code ?? 1);
  });
});

child.on("error", (err) => {
  console.error(`ERROR: Failed to start vitest: ${err.message}`);
  process.exit(1);
});
